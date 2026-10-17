#!/usr/bin/env node
// Log provider swap proof: the same `log query` / `trace get` inputs, called the same way, served by
// Docker container logs (demo/environment/workctl.yaml, default provider) and by Loki fed by Promtail
// (demo/environment/workctl.loki.yaml, defaults.logs: loki). Only the adapter (meta.sources) and the
// provider-specific coverage notes may differ; the `data` contract (zod output schema, top-level keys,
// entry shape) must not.
// Run from the repo root after `npm run build`, with demo-order, loki and promtail up
// (docker compose -f demo/environment/docker-compose.yml up -d loki promtail):
//   node demo/scenarios/reuse/log-provider-swap.mjs [--out demo/verification/log-provider-swap.md] [--no-traffic]
// Exit code 1 on a contract mismatch (error status, schema violation, different top-level data keys).
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createClient } from '../../../dist/index.js';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';
const args = process.argv.slice(2);
const outPath = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
const SERVICE = 'demo-order';

const SIDES = [
  { label: 'docker', config: 'demo/environment/workctl.yaml', profile: 'demo' },
  { label: 'loki', config: 'demo/environment/workctl.loki.yaml', profile: 'demo' },
];
const clients = SIDES.map((s) => ({ ...s, client: createClient({ configPath: s.config, profile: s.profile, timeoutMs: 120_000 }) }));
const [docker, loki] = clients;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. traffic
let traffic = '未生成（--no-traffic）';
if (!args.includes('--no-traffic')) {
  const t0 = new Date().toISOString();
  const r = spawnSync(process.execPath, ['demo/scenarios/latency/loadgen.mjs', '--rps', '10', '--duration', '15', '--customer-ratio', '0.3', '--seed', '7'], { encoding: 'utf8' });
  traffic = `loadgen.mjs --rps 10 --duration 15（${t0} 起，退出码 ${r.status}）`;
}

// 2. ingestion: wait until the newest access log seen by Docker is visible in Loki
const newestAccess = async (c) => {
  const env = await c.client.invoke('observability.log.query', { service: SERVICE, window: '5m', contains: 'request completed', limit: 1 });
  return env.data?.entries?.[0]?.ts ?? null;
};
const waitStart = Date.now();
const target = await newestAccess(docker);
let lokiNewest = null;
let waitedMs = 0;
for (let i = 0; i < 40; i++) {
  lokiNewest = await newestAccess(loki);
  waitedMs = Date.now() - waitStart;
  if (!target || (lokiNewest && lokiNewest >= target)) break;
  await sleep(500);
}
// let the last pushed batch settle so both windows see the same lines
await sleep(1500);

// 3. cases (the trace ids come from Docker, then both providers are asked the same thing)
const seed = await docker.client.invoke('observability.log.query', { service: SERVICE, window: '10m', contains: 'request completed', limit: 50 });
const traceIds = [...new Set((seed.data?.entries ?? []).map((e) => e.trace_id).filter(Boolean))];
const errSeed = await docker.client.invoke('observability.log.query', { service: SERVICE, window: '30m', level: 'error', limit: 20 });
const errTrace = (errSeed.data?.entries ?? []).map((e) => e.trace_id).find(Boolean) ?? null;

const CASES = [
  { cap: 'observability.log.query', label: 'window 10m, oldest, limit 2000', inputs: { service: SERVICE, window: '10m', order: 'oldest', limit: 2000 } },
  { cap: 'observability.log.query', label: 'newest, limit 20（截断）', inputs: { service: SERVICE, window: '10m', limit: 20 } },
  { cap: 'observability.log.query', label: '--contains "request completed"', inputs: { service: SERVICE, window: '10m', contains: 'request completed', limit: 2000 } },
  { cap: 'observability.log.query', label: '--level warn', inputs: { service: SERVICE, window: '30m', level: 'warn', limit: 200 } },
  ...(traceIds[0] ? [{ cap: 'observability.log.query', label: '--trace-id --include-spans', inputs: { service: SERVICE, window: '10m', trace_id: traceIds[0], include_spans: true } }] : []),
  ...(traceIds[0] ? [{ cap: 'observability.trace.get', label: `trace ${traceIds[0].slice(0, 8)}…`, inputs: { id: traceIds[0], window: '30m', service: SERVICE } }] : []),
  ...(traceIds[1] ? [{ cap: 'observability.trace.get', label: `trace ${traceIds[1].slice(0, 8)}…（不指定 --service）`, inputs: { id: traceIds[1], window: '30m' } }] : []),
  ...(errTrace ? [{ cap: 'observability.trace.get', label: `error trace ${errTrace.slice(0, 8)}…`, inputs: { id: errTrace, window: '30m', service: SERVICE } }] : []),
];

const schemaWarn = (env) => env.meta.warnings.some((w) => w.includes('输出与 schema 不一致'));
const srcLabel = (env) => (env.meta.sources[0] ? `${env.meta.sources[0].adapter} · ${env.meta.sources[0].version ?? '?'}` : '—');
const rows = [];
let mismatch = false;
for (const c of CASES) {
  // both sides at the same moment so the "from now" windows coincide
  const [d, l] = await Promise.all(clients.map((s) => s.client.invoke(c.cap, c.inputs)));
  const def = docker.client.registry.get(c.cap);
  const schemaOk = [d, l].map((env) => env.status !== 'error' && def.output.safeParse(env.data).success && !schemaWarn(env));
  const keys = [d, l].map((env) => Object.keys(env.data ?? {}).sort().join(','));
  const row = { case: `\`${c.cap.replace('observability.', '')}\` ${c.label}`, status: `${d.status}${d.error ? `(${d.error.code})` : ''} / ${l.status}${l.error ? `(${l.error.code})` : ''}`, adapters: `${srcLabel(d)} / ${srcLabel(l)}`, schema: schemaOk.every(Boolean) ? 'yes' : `NO (docker=${schemaOk[0]}, loki=${schemaOk[1]})`, keys: keys[0] === keys[1] ? 'yes' : 'NO' };
  if (c.cap === 'observability.log.query') {
    const ids = [d, l].map((env) => new Set((env.data?.entries ?? []).map((e) => e.trace_id).filter(Boolean)));
    const inter = [...ids[0]].filter((x) => ids[1].has(x)).length;
    const union = new Set([...ids[0], ...ids[1]]).size;
    const tsKeys = [d, l].map((env) => new Set((env.data?.entries ?? []).map((e) => `${e.ts}|${e.msg ?? e.raw}`)));
    const sameEntries = [...tsKeys[0]].filter((x) => tsKeys[1].has(x)).length;
    row.count = `${d.data?.entries?.length ?? '-'} / ${l.data?.entries?.length ?? '-'}`;
    row.stats = `scanned ${d.data?.stats?.lines_scanned ?? '-'}/${l.data?.stats?.lines_scanned ?? '-'}, matched ${d.data?.stats?.matched ?? '-'}/${l.data?.stats?.matched ?? '-'}, spans_skipped ${d.data?.stats?.spans_skipped ?? '-'}/${l.data?.stats?.spans_skipped ?? '-'}`;
    row.overlap = `trace_id ${inter}/${union}；同 ts+msg 条目 ${sameEntries}`;
    row.truncated = `${d.meta.coverage?.truncated ?? '-'} / ${l.meta.coverage?.truncated ?? '-'}`;
  } else {
    row.count = `spans ${d.data?.span_count ?? '-'} / ${l.data?.span_count ?? '-'}`;
    row.stats = `duration_ms ${d.data?.duration_ms ?? '-'}/${l.data?.duration_ms ?? '-'}, lines_scanned ${d.data?.scanned?.[0]?.lines_scanned ?? '-'}/${l.data?.scanned?.[0]?.lines_scanned ?? '-'}`;
    const sameTree = JSON.stringify((d.data?.spans ?? []).map((s) => [s.span_id, s.parent_span_id, s.depth, s.self_ms])) === JSON.stringify((l.data?.spans ?? []).map((s) => [s.span_id, s.parent_span_id, s.depth, s.self_ms]));
    row.overlap = `span 树${sameTree ? '相同' : '不同'}（span_id/parent/depth/self_ms）；roots ${JSON.stringify(d.data?.roots ?? [])} / ${JSON.stringify(l.data?.roots ?? [])}`;
    row.truncated = `complete ${d.meta.coverage?.complete ?? '-'} / ${l.meta.coverage?.complete ?? '-'}`;
  }
  if (d.status === 'error' || l.status === 'error' || !schemaOk.every(Boolean) || keys[0] !== keys[1]) mismatch = true;
  rows.push(row);
}

// actual versions: Docker / Loki from the result sources, Promtail from its binary
const probeEnv = await Promise.all(clients.map((s) => s.client.invoke('observability.log.query', { service: SERVICE, window: '1m', limit: 1 })));
const promtail = spawnSync('docker', ['exec', 'demo-promtail', '/usr/bin/promtail', '-version'], { encoding: 'utf8' });
const promtailVersion = /version\s+(\S+)/.exec(`${promtail.stdout}${promtail.stderr}`)?.[1] ?? '未知';
const versions = [
  `Docker Engine ${probeEnv[0].meta.sources[0]?.version ?? '?'}`,
  `Loki ${probeEnv[1].meta.sources[0]?.version ?? '?'}（/loki/api/v1/status/buildinfo）`,
  `Promtail ${promtailVersion}（promtail -version）`,
];

const lines = [];
lines.push('# 日志 provider 替换对照：Docker 容器日志 ↔ Loki（Promtail 采集）');
lines.push('');
lines.push(`生成时间 ${new Date().toISOString()}，命令 \`node demo/scenarios/reuse/log-provider-swap.mjs\`（真实调用：同一个 demo-order 容器，同一批请求）。`);
lines.push(`docker = \`${SIDES[0].config}\`（profile demo，默认 provider，Docker Engine API 读 json-file 日志）；loki = \`${SIDES[1].config}\`（profile demo，\`defaults.logs: loki\`，Loki @ 127.0.0.1:13100，Promtail docker_sd_configs 推送）。`);
lines.push(`实际版本：${versions.join('；')}。`);
lines.push(`流量：${traffic}。入库等待：Docker 最新 access 日志 ${target ?? '无'}，Loki 在 ${waitedMs}ms 内可见（Loki 最新 ${lokiNewest ?? '无'}）。两边每个用例同时调用，窗口同为“截至当前”。`);
lines.push('');
lines.push('| 用例 | 状态 docker / loki | 适配器 · 实际版本 | schema 均通过 | 顶层 data 键一致 | 条目数 docker / loki | 统计 docker/loki | 重合 | 截断/完整 docker / loki |');
lines.push('|---|---|---|---|---|---|---|---|---|');
for (const r of rows) lines.push(`| ${r.case} | ${r.status} | ${r.adapters} | ${r.schema} | ${r.keys} | ${r.count} | ${r.stats} | ${r.overlap} | ${r.truncated} |`);
lines.push('');
lines.push('## 口径差异（同一契约内）');
lines.push('');
lines.push('- 入库延迟：Loki 只能看到 Promtail 已推送的日志（demo batchwait=1s）；窗口末尾刚写入的行 Docker 能读到、Loki 可能还没有，条目数可能差几行。');
lines.push('- `stats.lines_scanned / unparsed_lines / spans_skipped`：Docker 是逐行扫描计数；Loki 来自 `count_over_time` 统计查询（同一窗口），窗口边界（Loki 区间 (end-w, end]，query_range [start, end)）可能差一两行。');
lines.push('- `containers[]`：Loki 按流（container + container_id 标签）给出，`created_at` 为空、`log_driver` 为 null（Loki 不含容器元数据）；容器被重建后 Loki 仍保留旧容器的日志（Docker 直读看不到），会出现同名不同 id 的行。');
lines.push('- `limit`：两边都返回窗口内最新/最早的 limit 条；Loki 用 `limit+1` 判断截断，截断时 `matched` 与 `by_level` 来自统计查询。');
lines.push('- 保留期：Docker 取决于 json-file 轮转（demo-order max-size=20m × 5）；Loki 取决于 retention_period / max_query_lookback（demo 72h），超出时写入 coverage.notes。');
lines.push('');
lines.push(mismatch ? '**结论：存在契约不一致（见上表 NO 项或 error）。**' : '**结论：所有用例在两个 provider 下输出同一契约（状态、schema、顶层字段一致），差异只在适配器、来源（meta.sources）与 provider 相关的 coverage 说明。**');
const md = lines.join('\n') + '\n';
if (outPath) writeFileSync(outPath, md);
process.stdout.write(md);
process.exit(mismatch ? 1 : 0);
