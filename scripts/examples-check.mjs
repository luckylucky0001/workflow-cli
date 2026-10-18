// Run every documented command for real: capability `examples` (docs/command-reference.md,
// `workctl <cmd> --help`) and `workctl ...` snippets in quickstart / walkthrough / README /
// guides. Placeholders are substituted for the demo environment, ids are chained from earlier
// calls, everything runs with --json. Mutating commands (operation execute, *execute*, restarts,
// installs, scenario scripts) are skipped, never run.
// Writes demo/verification/examples-check.md and examples-check.json.
// Usage: npm run build && node scripts/examples-check.mjs [--only <substring>]
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const CLI = join(ROOT, 'dist/workctl.js');
const PROFILES = {
  docker: 'demo/environment/workctl.yaml',
  k8s: 'demo/environment/k8s/workctl.k8s.yaml',
};
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;

// ---- SQL files for `--sql-file ./q.sql` / `--file q.sql` examples (engine-appropriate) ----
const tmp = mkdtempSync(join(tmpdir(), 'workctl-examples-'));
const sqlFiles = {
  mysql: 'SELECT * FROM orders WHERE customer_id = 42',
  pg: 'SELECT * FROM orders WHERE customer_id = 42',
  trino: 'SELECT name FROM nation ORDER BY nationkey LIMIT 5',
};
for (const [k, v] of Object.entries(sqlFiles)) writeFileSync(join(tmp, `${k}.sql`), `${v}\n`);

// ---- what is never run ----
const MUTATING = [
  [/\boperation execute\b/, 'operation execute'],
  [/\bquery cancel\b/, 'cancels a running query'],
  [/\b(backfill|rollback|workload) execute\b/, 'execute'],
  [/\bworkload restart\b(?!-plan)/, 'restart'],
  [/\b(plugin|skills) install\b/, 'installs files'],
  [/\bmcp serve\b/, 'long-running server'],
  [/\bdocs generate\b/, 'writes files'],
];
const ALWAYS_EXPECTED = new Set(['CAPABILITY_PLANNED']);

// ---- placeholder / chained-id substitution ----
const vars = {};
const PLACEHOLDERS = [
  // [regex, var name | fixed value, note]
  [/<最慢请求的 trace_id>|<trace_id>/g, 'trace_id'],
  [/<app_id>/g, 'app_id'],
  [/<q>|\bq-20261017-1a2b3c\b/g, 'sql_query_id'],
  [/<plan>|\bop-20261017-(abc123|xxxxxx)\b/g, 'plan_id'],
  [/<replicaset>/g, 'replicaset'],
];
function substitute(cmd, engineHint) {
  const subs = [];
  let out = cmd;
  for (const [re, name] of PLACEHOLDERS) {
    out = out.replace(re, (m) => {
      const v = name.startsWith('=') ? name.slice(1) : vars[name];
      if (v == null) {
        subs.push(`${m} -> <unresolved>`);
        return m;
      }
      subs.push(`${m} -> ${v}`);
      return v;
    });
  }
  out = out.replace(/(capability get --name )<name>/g, (m, p) => {
    subs.push('<name> -> mysql.table.get');
    return `${p}mysql.table.get`;
  });
  // config keys differ per service/provider (etcd/Nacos/Consul seeds)
  out = out.replace(/<k>/g, (m) => {
    const v = /demo-payment/.test(out) ? 'order.timeout_ms' : 'cache.ttl_seconds';
    subs.push(`${m} -> ${v}`);
    return v;
  });
  out = out.replace(/(--(?:sql-)?file\s+)(\.\/)?q\.sql\b/g, (m, p) => {
    const f = join(tmp, `${engineHint}.sql`);
    subs.push(`q.sql -> ${engineHint} sample (${sqlFiles[engineHint]})`);
    return `${p}${f}`;
  });
  return { cmd: out, subs };
}
const engineOf = (cmd) => (/\bpg\b/.test(cmd) ? 'pg' : /--engine trino/.test(cmd) ? 'trino' : 'mysql');

// ---- running ----
function run(cmd, profileFile, timeoutMs = 150_000) {
  // Users run these in a shell; keep shell semantics (quotes, $PWD) by running through bash.
  let c = cmd.trim().replace(/^WORKCTL_CONFIG=\S+\s+/, '');
  if (!/^workctl\b/.test(c)) return Promise.resolve({ skipped: 'not a workctl command' });
  const args = c.replace(/^workctl\b/, '');
  const json = /(^|\s)--json(\s|$)/.test(args) ? '' : ' --json';
  const line = `node ${JSON.stringify(CLI)}${json}${args}`;
  return new Promise((res) => {
    const t0 = Date.now();
    const p = spawn('bash', ['-c', line], {
      cwd: ROOT,
      env: { ...process.env, WORKCTL_CONFIG: join(ROOT, profileFile), NO_COLOR: '1' },
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('close', (code) => {
      clearTimeout(timer);
      let env = null;
      try {
        env = JSON.parse(out);
      } catch {
        /* non-JSON (e.g. --version) */
      }
      res({ code, env, out, err, ms: Date.now() - t0 });
    });
  });
}
function outcome(r) {
  if (r.skipped) return { status: 'skipped', code: null };
  if (r.env) return { status: r.env.status, code: r.env.status === 'error' ? r.env.error?.code : null, message: r.env.error?.message };
  return { status: r.code === 0 ? 'ok(non-json)' : `exit ${r.code}`, code: null, message: (r.err || r.out).trim().split('\n')[0]?.slice(0, 200) };
}
const PASS = new Set(['success', 'partial', 'empty', 'ok(non-json)']);

function deepFind(obj, keyRe, pred = (v) => typeof v === 'string' && v.length > 0) {
  if (obj == null || typeof obj !== 'object') return undefined;
  for (const [k, v] of Object.entries(obj)) {
    if (keyRe.test(k) && pred(v)) return v;
  }
  for (const v of Object.values(obj)) {
    const f = deepFind(v, keyRe, pred);
    if (f !== undefined) return f;
  }
  return undefined;
}

async function pool(items, n, fn) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }));
  return results;
}

// ---- 0. chain producers: ids later examples need ----
async function prime() {
  const steps = [
    ['trace_id', 'workctl log query --service demo-order --window 1h --contains mysql', (e) => deepFind(e?.data, /^trace_id$/)],
    ['trace_id', 'workctl log query --service demo-order --window 6h', (e) => deepFind(e?.data, /^trace_id$/)],
    ['app_id', 'workctl offline run get --workflow demo-daily-orders --id demo__2026-10-16__wrong_partition', (e) => deepFind(e?.data, /^(app_id|application_id|job_id)$/, (v) => typeof v === 'string' && /^(local|app|application)[-_]/.test(v))],
    ['plan_id', 'workctl offline backfill plan --workflow demo-daily-orders --from 2026-10-14 --to 2026-10-16 --timezone Asia/Shanghai', (e) => deepFind(e?.data, /^(id|plan_id)$/, (v) => typeof v === 'string' && /^op-/.test(v))],
    ['sql_query_id', 'workctl sql query submit --engine spark --file demo/offline-workflows/sql/examples/daily_orders_by_date.sql', (e) => deepFind(e?.data, /^(id|query_id)$/, (v) => typeof v === 'string' && /^q-/.test(v))],
    ['replicaset', 'workctl deploy release list --service demo-order --env sandbox', (e) => deepFind(e?.data, /^id$/, (v) => typeof v === 'string' && /^demo-order-/.test(v)), 'k8s'],
  ];
  for (const [name, cmd, pick, profile = 'docker'] of steps) {
    if (vars[name]) continue;
    const r = await run(cmd, PROFILES[profile]);
    const v = pick(r.env);
    if (v) vars[name] = v;
    process.stderr.write(`prime ${name} = ${v ?? '(none)'}  [${cmd}]\n`);
  }
}

// ---- skills: generic placeholders (<svc>, <i>, <db.table>, ...) mapped to the demo environment ----
function skillSubstitute(cmd) {
  const dom = /workctl\s+(?:--\S+\s+(?:\d+s\s+)?)*(\S+)/.exec(cmd)?.[1];
  const inst = { mysql: 'demo-mysql', pg: 'demo-postgres', redis: 'demo-redis', search: 'demo-orders-current' }[dom];
  const map = {
    '<svc>': 'demo-order', '<service>': 'demo-order', '<env>': 'sandbox', '<mysql>': 'demo-mysql', '<pg>': 'demo-postgres', '<redis>': 'demo-redis',
    '<db>': dom === 'mysql' ? 'demo' : 'analytics', '<t>': dom === 'mq' ? 'demo.order.events' : dom === 'pg' ? 'orders' : 'orders', '<table>': 'daily_orders',
    '<db.table>': 'analytics.daily_orders', '<dag>': 'demo-daily-orders', '<dag_id>': 'demo-daily-orders', '<run_id>': 'demo__2026-10-16__wrong_partition',
    '<task_id>': 'aggregate_orders', '<c>': dom === 'mq' ? 'demo-mq' : 'demo-search', '<g>': 'demo-consumer', '<host>': 'localhost',
    '<host:port>': '127.0.0.1:13306', '<db_host:port>': '127.0.0.1:13306', '<volume>': 'workctl-demo_mysql-data', '<path>': 'demo/environment/workctl.yaml',
    '<name>': 'cache.ttl_seconds', '<rev>': '2', '<prefix>': 'demo', '<top_key>': 'demo:order:10', '<release id>': '3', '<cap>': 'mysql.table.get',
    '<query_string>': 'status:paid', '<索引或单索引别名>': 'demo-orders-current', '<id>': '<plan>', '<trace_id>': '<trace_id>',
  };
  let out = cmd.replace(/--columns c1\[,c2\]/, '--columns customer_id').replace(/\s+\[[^\]]*\]/g, '').replace(/\\\|/g, '|').replace(/upstream\|downstream/g, 'upstream');
  out = out.replace(/<i>/g, inst ?? '<i>');
  for (const [k, v] of Object.entries(map)) out = out.split(k).join(v);
  out = out.replace(/\bD1\b/g, '2026-10-14').replace(/\bD2\b/g, '2026-10-16').replace(/--data-date D\b/g, '--data-date 2026-10-16').replace(/YYYY-MM-DD/g, '2026-10-16');
  out = out.replace(/--sql-file q\.sql/, '--sql-file ./q.sql');
  return out === cmd ? { cmd } : { cmd: out, note: 'skill placeholders substituted' };
}

// ---- 1. capability examples ----
async function capabilityItems() {
  const prev = process.env.WORKCTL_CONFIG;
  process.env.WORKCTL_CONFIG = join(ROOT, PROFILES.docker);
  const { createClient } = await import(join(ROOT, 'dist/index.js'));
  const client = createClient();
  process.env.WORKCTL_CONFIG = prev;
  const items = [];
  for (const c of client.registry.capabilities.values()) {
    if (c.status === 'planned') continue;
    for (const ex of c.examples ?? []) {
      items.push({
        kind: 'example',
        where: c.name,
        capability: c.name,
        operation: c.operation,
        adapter: typeof c.adapter === 'string' ? c.adapter : JSON.stringify(c.adapter ?? ''),
        docText: JSON.stringify({ notes: c.notes, summary: c.summary, guide: c.guide, errors: c.errors }),
        command: ex,
      });
    }
  }
  return items;
}

// ---- 2. doc snippets ----
function docItems() {
  const files = [
    'docs/quickstart.md', 'demo/walkthrough.md', 'README.md',
    ...readdirSync(join(ROOT, 'docs/guides')).filter((f) => f.endsWith('.md')).map((f) => `docs/guides/${f}`),
    ...readdirSync(join(ROOT, 'skills')).map((d) => `skills/${d}/SKILL.md`),
  ];
  const items = [];
  for (const f of files) {
    const text = readFileSync(join(ROOT, f), 'utf8');
    const lines = text.split('\n');
    let inCode = false;
    lines.forEach((ln, i) => {
      if (/^\s*```/.test(ln)) {
        inCode = !inCode;
        return;
      }
      const cands = [];
      if (inCode) {
        const m = /^\s*(?:\$\s+)?((?:WORKCTL_CONFIG=\S+\s+)?workctl\s.*)$/.exec(ln);
        if (m) cands.push([m[1].replace(/\s+#.*$/, '').trim(), false]);
      } else {
        for (const m of ln.matchAll(/`((?:WORKCTL_CONFIG=\S+\s+)?workctl [^`]+)`/g)) cands.push([m[1].trim(), true]);
        // walkthrough table: `sql query get --id <q>` after an arrow belongs to workctl too
        for (const m of ln.matchAll(/→ `(sql query get [^`]+)`/g)) cands.push([`workctl ${m[1]}`, true]);
      }
      for (const [cmd, inline] of cands) {
        // skip syntax summaries such as `workctl <domain> [resource] <action> [options]`
        if (/<domain>|<command>|<命令>|\[options\]/.test(cmd)) continue;
        items.push({ kind: f.startsWith('skills/') ? 'skill' : 'doc', where: `${f}:${i + 1}`, command: cmd, inline, docText: text });
      }
    });
  }
  // de-duplicate identical commands (keep first location, list the rest)
  const seen = new Map();
  for (const it of items) {
    if (seen.has(it.command)) seen.get(it.command).also.push(it.where);
    else seen.set(it.command, { ...it, also: [] });
  }
  return [...seen.values()];
}

function decide(item) {
  const cmd = item.command;
  if (/WORKCTL_CONFIG=\S*af3/.test(cmd)) return 'Airflow 3 profile (not running in this check)';
  if (item.operation === 'execute') return 'operation=execute';
  for (const [re, why] of MUTATING) if (re.test(cmd)) return why;
  return null;
}

function profileFor(item) {
  const m = /WORKCTL_CONFIG=(\S+)/.exec(item.command);
  if (m) return m[1].includes('k8s') ? 'k8s' : 'docker';
  return 'docker';
}

const isK8s = (item) => /kubernetes/.test(item.adapter ?? '') || /^(container|deploy|capacity)\b/.test(item.command.replace(/^.*?workctl\s+(--\S+\s+(\d+s\s+)?)*/, ''));

async function check(item) {
  const skip = decide(item);
  if (skip) return { ...strip(item), status: 'skipped', reason: skip };
  let base = item.command;
  if (item.kind === 'skill') {
    base = skillSubstitute(base).cmd;
    if (/\.\.\.|…/.test(base)) return { ...strip(item), executed: base, status: 'skipped', reason: 'template with "..." (not runnable as written)' };
  }
  const { cmd, subs } = substitute(base, engineOf(base));
  if (item.kind === 'skill' && base !== item.command) subs.unshift('skill placeholders -> demo values');
  if (/<[^<>\n]+>/.test(cmd)) return { ...strip(item), executed: cmd, subs, status: 'skipped', reason: 'placeholder could not be resolved' };
  if (subs.some((s) => s.includes('<unresolved>'))) return { ...strip(item), executed: cmd, subs, status: 'skipped', reason: 'placeholder could not be resolved' };
  let profile = profileFor(item);
  let r = await run(cmd, PROFILES[profile]);
  let o = outcome(r);
  const tried = [`${profile}:${o.code ?? o.status}`];
  // k8s-only examples (ReplicaSet ids, revisions): retry with the k3s profile
  if (!PASS.has(o.status) && profile === 'docker' && isK8s(item)) {
    const r2 = await run(cmd, PROFILES.k8s);
    const o2 = outcome(r2);
    tried.push(`k8s:${o2.code ?? o2.status}`);
    if (PASS.has(o2.status)) {
      r = r2;
      o = o2;
      profile = 'k8s';
    }
  }
  const pass = PASS.has(o.status);
  // a bare `workctl access check` in prose names the command, it is not meant to be run as is
  if (!pass && item.inline && !/\s--/.test(item.command) && o.code === 'INVALID_ARGUMENT' && /缺少必填参数/.test(o.message ?? '')) {
    return { ...strip(item), profile, status: 'skipped', reason: 'prose mention without required arguments', error_code: o.code };
  }
  const documented = !pass && o.code && (ALWAYS_EXPECTED.has(o.code) || (item.expect ?? []).includes(o.code) || item.docText?.includes(o.code));
  return {
    ...strip(item),
    executed: cmd === item.command ? undefined : cmd,
    subs: subs.length ? subs : undefined,
    profile,
    tried: tried.length > 1 ? tried : undefined,
    status: pass ? 'pass' : documented ? 'expected-error' : 'fail',
    envelope_status: o.status,
    error_code: o.code ?? undefined,
    message: pass ? undefined : o.message,
    warnings: r.env?.meta?.warnings?.length ? r.env.meta.warnings.map((w) => (typeof w === 'string' ? w : w.code ?? w.message)).slice(0, 3) : undefined,
    ms: r.ms,
  };
}
function strip(item) {
  const { docText, adapter, inline, ...rest } = item;
  if (!rest.also?.length) delete rest.also;
  return rest;
}

// ---- main ----
await prime();
let items = [...(await capabilityItems()), ...docItems()];
if (only) items = items.filter((i) => i.command.includes(only) || i.where.includes(only));
const results = await pool(items, 6, async (it) => {
  const res = await check(it);
  process.stderr.write(`${res.status.padEnd(14)} ${res.error_code ?? ''} ${res.where}  ${it.command}\n`);
  return res;
});

const count = (kind, st) => results.filter((r) => r.kind === kind && (!st || r.status === st)).length;
const summary = Object.fromEntries(['example', 'doc', 'skill'].map((k) => [k, { total: count(k), pass: count(k, 'pass'), expected_error: count(k, 'expected-error'), fail: count(k, 'fail'), skipped: count(k, 'skipped') }]));
if (!only) {
  writeFileSync(join(ROOT, 'demo/verification/examples-check.json'), `${JSON.stringify({ generated_at: new Date().toISOString(), vars, summary, results }, null, 2)}\n`);
  const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const table = (kind) => [
    '| 结果 | 位置 | 命令 | profile | 错误码 / 说明 |',
    '|---|---|---|---|---|',
    ...results.filter((r) => r.kind === kind).map((r) => `| ${r.status} | ${esc(r.where)} | \`${esc(r.command)}\`${r.subs ? `<br>替换：${esc(r.subs.join('; '))}` : ''} | ${r.profile ?? ''} | ${esc(r.error_code ?? r.reason ?? '')}${r.message ? ` ${esc(r.message.slice(0, 140))}` : ''} |`),
  ];
  const md = [
    '# 文档命令实跑记录（examples-check）',
    '',
    `> 由 \`node scripts/examples-check.mjs\` 生成于 ${new Date().toISOString()}。逐条执行能力定义中的 \`examples\`（command-reference 与 \`--help\` 展示的内容）以及 quickstart / walkthrough / README / guides 中的 \`workctl\` 命令，全部 \`--json\`。`,
    '> 默认 profile `demo/environment/workctl.yaml`；Kubernetes 专属示例（失败时）再用 `demo/environment/k8s/workctl.k8s.yaml` 重试。`operation=execute`、`operation execute`、重启、安装、Airflow 3 profile 一律跳过不执行。',
    '> 占位符替换：`<trace_id>` 取自 `log query`，`<app_id>` 取自 `offline run get`，`op-…`/`<plan>` 取自 `offline backfill plan`，`q-…`/`<q>` 取自 `sql query submit`，`q.sql` 为按引擎生成的临时只读 SQL。',
    '> `expected-error`：失败的错误码在该能力的说明（notes）或所在文档中有说明（如示例中的虚构 id → `NOT_FOUND`）。',
    '',
    '| | 总数 | pass | expected-error | fail | skipped |',
    '|---|---|---|---|---|---|',
    ...Object.entries(summary).map(([k, s]) => `| ${{ example: '能力 examples', doc: '文档命令', skill: 'Skill 命令' }[k]} | ${s.total} | ${s.pass} | ${s.expected_error} | ${s.fail} | ${s.skipped} |`),
    '',
    `链式取值：${Object.entries(vars).map(([k, v]) => `\`${k}=${v}\``).join('，')}`,
    '',
    '## 能力 examples',
    '',
    ...table('example'),
    '',
    '## 文档命令',
    '',
    ...table('doc'),
    '',
    '## Skill 命令（通用占位符 <svc>/<i>/<db.table>… 替换为演示环境的值）',
    '',
    ...table('skill'),
    '',
  ].join('\n');
  writeFileSync(join(ROOT, 'demo/verification/examples-check.md'), md);
}
process.stderr.write(`\n${JSON.stringify(summary)}\n`);
process.exitCode = results.some((r) => r.status === 'fail') ? 1 : 0;
