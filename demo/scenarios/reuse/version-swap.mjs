#!/usr/bin/env node
// Version swap proof (design §10.4 "更换一个演示平台接口版本 → 适配器变化与消费者契约对照"):
// the same capabilities, called the same way, against Airflow 2.10 (REST v1, workctl.yaml) and
// Airflow 3.x (REST v2, workctl.af3.yaml). Only the adapter (meta.sources) may differ; the `data`
// contract (zod output schema, field names, layered-state semantics) must not.
// Run from the repo root after `npm run build`, with both schedulers up and both scenario sets produced
// (demo/scenarios/offline/run-all.sh on Airflow 2, demo/scenarios/reuse/af3-produce.sh on Airflow 3):
//   node demo/scenarios/reuse/version-swap.mjs [--out demo/verification/version-swap.md]
// Exit code 1 on a contract mismatch (error status, schema violation, different top-level data keys,
// different layered states).
import { writeFileSync } from 'node:fs';
import { createClient } from '../../../dist/index.js';

const SIDES = [
  { label: 'v1', config: 'demo/environment/workctl.yaml', profile: 'demo' },
  { label: 'v2', config: 'demo/environment/workctl.af3.yaml', profile: 'demo-af3' },
];

const pick = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
const CASES = [
  {
    cap: 'offline.workflow.get', inputs: { id: 'demo-daily-orders' },
    facts: (d) => ({ schedule_type: d.schedule.type, timezone: d.timezone, is_paused: d.is_paused, is_active: d.is_active, owners: d.owners, tasks: d.tasks.map((t) => `${t.task_id}:${t.operator}:${t.pool}`), dag_source_sha256: d.code_version.source_sha256 }),
  },
  {
    cap: 'offline.task.get', inputs: { workflow: 'demo-daily-orders', task: 'aggregate_orders' },
    facts: (d) => ({ operator: d.operator, pool: d.pool, retries: d.retries, retry_exponential_backoff: d.retry_exponential_backoff, execution_timeout_seconds: d.execution_timeout_seconds, upstream: d.upstream_task_ids, downstream: d.downstream_task_ids }),
  },
  {
    cap: 'offline.run.list', inputs: { workflow: 'demo-daily-orders', data_date: '2026-10-16', timezone: 'Asia/Shanghai' },
    facts: (d) => ({ runs: d.runs.map((r) => `${r.run_id}:${r.state}:${r.match}:${r.business_date}:${r.run_type}:${r.external_trigger}:${JSON.stringify(r.conf)}`), business_interval: d.mapping.business_interval }),
  },
  {
    cap: 'offline.run.get', label: 'wrong_partition', inputs: { workflow: 'demo-daily-orders', id: 'demo__2026-10-16__wrong_partition' },
    layered: true,
    facts: (d) => ({ findings: d.summary.findings.map((f) => f.kind), target: d.summary.target_partition, tasks: d.tasks.map((t) => `${t.task_id}:${t.state}:${t.try_number}`) }),
  },
  {
    cap: 'offline.run.get', label: 'ok', inputs: { workflow: 'demo-daily-orders', id: 'demo__2026-10-15__ok' },
    layered: true,
    facts: (d) => ({ findings: d.summary.findings.map((f) => f.kind), tasks: d.tasks.map((t) => `${t.task_id}:${t.state}`) }),
  },
  {
    cap: 'offline.dependency.list', inputs: { workflow: 'demo-daily-orders', run_id: 'demo__2026-10-14__missing_upstream', direction: 'upstream' },
    facts: (d) => ({ task_edges: d.task_edges.map((e) => `${e.from}(${e.from_state})->${e.to}(${e.to_state})`), data: d.data_dependencies.map((x) => `${x.table}/${x.partition}:${x.state}`), workflows: d.workflow_dependencies.map((w) => `${w.workflow}:${w.relation}:${w.run?.run_id ?? 'no-run'}`) }),
  },
  {
    cap: 'offline.log.get', inputs: { workflow: 'demo-daily-orders', run_id: 'demo__2026-10-16__wrong_partition', task: 'aggregate_orders', limit_lines: 20 },
    facts: (d) => ({ task_state: d.task_state, try_number: d.try_number, returned_lines: d.returned_lines, spark_app_ids: d.spark_app_ids.length }),
  },
  {
    cap: 'offline.backfill.plan', inputs: { workflow: 'demo-daily-orders', from: '2026-10-14', to: '2026-10-16', timezone: 'Asia/Shanghai' },
    facts: (d) => ({ actions: d.targets.map((t) => `${t.business_date}:${t.action}:${t.run_id}:${t.partition_state}`), preconditions: d.preconditions.map((p) => `${p.check}=${p.ok}`), write_mode: pick(d, 'impact.write_mode') }),
  },
  {
    cap: 'offline.freshness.check', inputs: { dataset: 'analytics.daily_orders', data_date: '2026-10-16' },
    facts: (d) => ({ verdict: d.verdict, partition_state: d.partition_state, producer_runs: (d.producer?.runs ?? []).map((r) => `${r.run_id}:${r.state}`) }),
  },
  {
    cap: 'compute.queue.get', inputs: { id: 'demo-batch-pool' },
    facts: (d) => ({ provider: d.provider, slots: d.slots, occupied_slots: d.occupied_slots, open_slots: d.open_slots }),
  },
];

/** Key paths of a JSON value (array items collapsed to []), excluding the values of open records. */
function keyPaths(v, prefix = '', out = new Set()) {
  if (Array.isArray(v)) {
    for (const x of v) keyPaths(x, `${prefix}[]`, out);
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      const p = prefix ? `${prefix}.${k}` : k;
      out.add(p);
      // provenance objects nested in data (layers.*.source) are expected to differ only in values
      if (k !== 'source') keyPaths(x, p, out);
    }
  }
  return out;
}

const clients = SIDES.map((s) => ({ ...s, client: createClient({ configPath: s.config, profile: s.profile, timeoutMs: 120_000 }) }));
const rows = [];
let mismatch = false;
for (const c of CASES) {
  const res = [];
  for (const s of clients) res.push(await s.client.invoke(c.cap, c.inputs));
  const def = clients[0].client.registry.get(c.cap);
  const airflowSrc = (env) => env.meta.sources.find((x) => x.system === 'airflow');
  const side = (env) => {
    const src = airflowSrc(env);
    return env.status === 'error' ? `ERROR ${env.error.code}` : `${src?.adapter ?? '-'} · ${src?.version ?? '-'}`;
  };
  const schemaOk = res.map((env) => env.status !== 'error' && def.output.safeParse(env.data).success);
  const topKeys = res.map((env) => (env.data ? Object.keys(env.data).sort().join(',') : ''));
  const kp = res.map((env) => keyPaths(env.data));
  const onlyV1 = [...kp[0]].filter((k) => !kp[1].has(k));
  const onlyV2 = [...kp[1]].filter((k) => !kp[0].has(k));
  let layered = 'n/a';
  if (c.layered && res.every((e) => e.data)) {
    const st = res.map((e) => ['scheduler', 'compute', 'output', 'quality'].map((k) => `${k}=${e.data.summary[`${k}_state`]}`).join(' '));
    layered = st[0] === st[1] ? `yes (${st[0]})` : `NO v1[${st[0]}] v2[${st[1]}]`;
    if (st[0] !== st[1]) mismatch = true;
  }
  const facts = res.map((e) => (e.data ? JSON.stringify(c.facts(e.data)) : 'null'));
  const factDiff = facts[0] === facts[1] ? 'same' : Object.keys(JSON.parse(facts[0]) ?? {}).filter((k) => JSON.stringify(JSON.parse(facts[0])[k]) !== JSON.stringify(JSON.parse(facts[1])?.[k])).join(', ');
  const ok = schemaOk.every(Boolean) && topKeys[0] === topKeys[1];
  if (!ok) mismatch = true;
  const methods = res.map((env) => airflowSrc(env)?.method ?? '-');
  rows.push({
    capability: `${c.cap}${c.label ? ` (${c.label})` : ''}`,
    v1: side(res[0]),
    v2: side(res[1]),
    methods,
    schema: schemaOk.every(Boolean) ? 'yes' : `NO (v1=${schemaOk[0]}, v2=${schemaOk[1]})`,
    keys: topKeys[0] === topKeys[1] ? 'yes' : 'NO',
    nested: onlyV1.length || onlyV2.length ? `v1 only: ${onlyV1.join(', ') || '-'}; v2 only: ${onlyV2.join(', ') || '-'}` : 'none',
    layered,
    facts: factDiff,
    factValues: facts,
    context_adapter: res.map((e) => e.context.adapter),
  });
}

const lines = [];
lines.push('# 版本替换对照：Airflow 2（REST v1）↔ Airflow 3（REST v2）');
lines.push('');
lines.push(`生成时间 ${new Date().toISOString()}，命令 \`node demo/scenarios/reuse/version-swap.mjs\`（真实调用，两个调度实例各自的真实运行）。`);
lines.push('v1 = `demo/environment/workctl.yaml`（profile demo，Airflow 2 @ 127.0.0.1:18080），v2 = `demo/environment/workctl.af3.yaml`（profile demo-af3，Airflow 3 @ 127.0.0.1:18090）。');
lines.push('两边场景相同（同 run_id、同业务日期、同 conf），但是两套独立的真实执行：运行时间、Spark application id、分区写入时间不同。');
lines.push('');
lines.push('| 能力 | v1 适配器 · 实际版本 | v2 适配器 · 实际版本 | 输出 schema 一致（两边 data 均通过 zod output） | 顶层 data 键一致 | 分层状态一致（run get） | 关键事实对照 |');
lines.push('|---|---|---|---|---|---|---|');
for (const r of rows) lines.push(`| \`${r.capability}\` | ${r.v1} | ${r.v2} | ${r.schema} | ${r.keys} | ${r.layered} | ${r.facts === 'same' ? '相同' : `不同: ${r.facts}`} |`);
lines.push('');
lines.push('## 嵌套字段差异（键路径，只在一侧出现）');
lines.push('');
lines.push('| 能力 | 差异 |');
lines.push('|---|---|');
for (const r of rows) lines.push(`| \`${r.capability}\` | ${r.nested} |`);
lines.push('');
lines.push('## 来源方法（meta.sources 中第一个 airflow 来源）与 context.adapter');
lines.push('');
lines.push('| 能力 | v1 method | v2 method | context.adapter（能力级，两边相同） |');
lines.push('|---|---|---|---|');
for (const r of rows) lines.push(`| \`${r.capability}\` | \`${r.methods[0]}\` | \`${r.methods[1]}\` | ${[...new Set(r.context_adapter)].join(' / ')} |`);
lines.push('');
lines.push('## 关键事实（两侧原值）');
lines.push('');
for (const r of rows) {
  lines.push(`- \`${r.capability}\``);
  lines.push(`  - v1: \`${r.factValues[0]}\``);
  lines.push(`  - v2: \`${r.factValues[1]}\``);
}
lines.push('');
lines.push(mismatch ? '**结论：存在契约不一致（见上表 NO 项）。**' : '**结论：所有能力在两个接口版本下输出同一契约（schema、顶层字段、分层状态语义一致），差异只出现在适配器与来源（meta.sources）。**');
const text = lines.join('\n') + '\n';
process.stdout.write(text);
const outIdx = process.argv.indexOf('--out');
if (outIdx > 0 && process.argv[outIdx + 1]) writeFileSync(process.argv[outIdx + 1], text);
process.exitCode = mismatch ? 1 : 0;
