#!/usr/bin/env node
/**
 * Black-box contract fuzzing for every callable capability (CLI + MCP).
 *
 *   WORKCTL_CONFIG=demo/environment/workctl.yaml node scripts/contract-fuzz.mjs [--only <prefix>] [--concurrency 4] [--no-mcp]
 *
 * Invokes `node dist/workctl.js --json <command...>` the way users, scripts and agents do and checks
 * the envelope contract: one JSON document on stdout, status/error code/exit code mapping, `data`
 * validates against the capability's output schema, invalid input → INVALID_ARGUMENT (exit 2), no
 * stack traces / internal paths / secret values, text and yaml modes do not crash, timeouts are
 * honoured, planned capabilities are not callable; then the same over MCP stdio.
 *
 * Never calls `execute` capabilities. Skips domains that are being built elsewhere (SKIP_DOMAINS).
 * Writes demo/verification/contract-fuzz.json and demo/verification/contract-fuzz.md (no secret values).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'dist/workctl.js');
const args = process.argv.slice(2);
const argOf = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
const ONLY = argOf('--only', '');
const CONCURRENCY = Math.min(4, Number(argOf('--concurrency', '4')));
const CALL_TIMEOUT_MS = Number(argOf('--call-timeout', '90000'));
const NO_MCP = args.includes('--no-mcp');
const OUT_JSON = join(ROOT, 'demo/verification/contract-fuzz.json');
const OUT_MD = join(ROOT, 'demo/verification/contract-fuzz.md');
const SKIP_DOMAINS = new Set((argOf('--skip-domains', 'postgres,deploy') || '').split(',').filter(Boolean));

const { createClient, ERROR_CODES } = await import(join(ROOT, 'dist/index.js'));
const registry = createClient().registry;

// ---------- secrets (compared, never printed) ----------
const secretsDir = join(ROOT, 'demo/environment/.runtime/secrets');
const secrets = [];
if (existsSync(secretsDir)) {
  for (const f of readdirSync(secretsDir)) {
    let txt;
    try {
      txt = readFileSync(join(secretsDir, f), 'utf8').trim();
    } catch {
      continue;
    }
    const values = [txt];
    try {
      const j = JSON.parse(txt);
      const walk = (v) => (typeof v === 'string' ? values.push(v) : v && typeof v === 'object' ? Object.values(v).forEach(walk) : undefined);
      walk(j);
    } catch {
      /* plain secret */
    }
    for (const v of values) if (v.length >= 6) secrets.push({ file: f, value: v });
  }
}

// ---------- process runner ----------
function run(argv, { timeoutMs = CALL_TIMEOUT_MS, input } = {}) {
  return new Promise((res) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [CLI, ...argv], { cwd: ROOT, env: { ...process.env, WORKCTL_VALIDATE_OUTPUT: '' } });
    let stdout = '';
    let stderr = '';
    let killed = false;
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      killed = true;
      p.kill('SIGKILL');
    }, timeoutMs);
    if (input !== undefined) p.stdin.end(input);
    else p.stdin.end();
    p.on('close', (code) => {
      clearTimeout(timer);
      res({ code, stdout, stderr, killed, ms: Date.now() - t0 });
    });
  });
}

// ---------- shell-ish tokenizer for capability examples ----------
function tokenize(s) {
  const out = [];
  let cur = '';
  let q = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === q) q = null;
      else if (ch === '\\' && q === '"' && i + 1 < s.length) cur += s[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out.map((t) => t.replace(/\$PWD/g, ROOT));
}

/** Parse an example into { pre: global flags, inputs: {flag: value|true} } for a command. */
function parseExample(ex, cap) {
  const toks = tokenize(ex);
  if (toks[0] === 'workctl') toks.shift();
  const words = cap.command.split(' ');
  const pre = [];
  const inputs = {};
  let i = 0;
  while (i < toks.length && toks.slice(i, i + words.length).join(' ') !== cap.command) {
    const t = toks[i++];
    if (t === '--json') continue;
    if (t === '--timeout' || t === '--profile') pre.push(t, toks[i++]);
  }
  i += words.length;
  while (i < toks.length) {
    const t = toks[i++];
    if (t === '--json') continue;
    const m = /^--([a-z0-9-]+)(?:=(.*))?$/.exec(t);
    if (!m) continue;
    const flag = m[1];
    if (m[2] !== undefined) inputs[flag] = m[2];
    else if (i < toks.length && !toks[i].startsWith('--')) inputs[flag] = toks[i++];
    else inputs[flag] = true;
  }
  return { pre, inputs };
}

const kebab = (s) => s.replace(/_/g, '-');

function argvFor(cap, inputs, pre = [], mode = ['--json']) {
  const out = [...mode, ...pre, ...cap.command.split(' ')];
  for (const [flag, v] of Object.entries(inputs)) {
    if (v === true) out.push(`--${flag}`);
    else if (Array.isArray(v)) for (const x of v) out.push(`--${flag}=${x}`);
    else out.push(`--${flag}=${v}`);
  }
  return out;
}

// ---------- per-capability valid baselines (examples are used when present) ----------
const tmp = mkdtempSync(join(tmpdir(), 'workctl-fuzz-'));
const trinoSql = join(tmp, 'q.sql');
writeFileSync(trinoSql, 'SELECT nationkey, name FROM nation ORDER BY nationkey LIMIT 3\n');
const mysqlSql = join(tmp, 'm.sql');
writeFileSync(mysqlSql, 'SELECT id, status FROM orders WHERE customer_id = 42\n');
const OVERRIDES = {
  'access.check': { capability: 'mysql.instance.get' },
  'auth.status': {},
  'doctor.run': { 'skip-network': true },
  'operation.cancel': { id: 'op-20000101-nonexistent' },
  'operation.get': { id: 'op-20000101-nonexistent' },
  'operation.list': {},
  'resource.get': { id: 'demo-mysql' },
  'redis.stats.sample': { instance: 'demo-redis', duration: '1s' },
  'mysql.statement.summary': { instance: 'demo-mysql', 'sample-window': '1s', top: '5' },
  'sql.query.submit': { engine: 'trino', file: trinoSql, catalog: 'tpch', schema: 'tiny' },
  'observability.log.query': { service: 'demo-order', window: '15m', level: 'error' },
};

function baseline(cap) {
  if (OVERRIDES[cap.name]) return { pre: [], inputs: { ...OVERRIDES[cap.name] }, from: 'override' };
  for (const ex of cap.examples ?? []) {
    if (/<[a-z_]+>/.test(ex)) continue;
    const p = parseExample(ex, cap);
    for (const [k, v] of Object.entries(p.inputs)) if (typeof v === 'string' && v === './q.sql') p.inputs[k] = mysqlSql;
    return { ...p, from: 'example' };
  }
  return { pre: [], inputs: {}, from: 'none' };
}

// ---------- bad values per input type ----------
const LONG = 'x'.repeat(10_000);
function badValues(spec) {
  switch (spec.type) {
    case 'int':
      return ['abc', '-1', '0', '99999999999999999999', 'NaN', '1.5', '1e3', ' '];
    case 'number':
      return ['abc', 'NaN', 'Infinity', '-1'];
    case 'duration':
      return ['abc', '-5s', '0', '99999d', '1.5.3s'];
    case 'enum':
      return ['bogus-value', ''];
    case 'list':
      return [',,,', LONG];
    case 'file':
      return ['../../etc/passwd', '/etc', join(tmp, 'nonexistent.sql'), ''];
    case 'bool':
      return [];
    default:
      return ['', LONG, '订单-🙂-ü', "a'; DROP TABLE x; -- $(id) `id` | && >/tmp/p", '../../etc/passwd', 'nonexistent-fuzz-xyz'];
  }
}

// ---------- checks ----------
const STACK_RE = /\n\s+at [^\n]*(\(|:\d+:\d+)|node:internal|\/home\/[^\s"']*\/src\/|dist\/workctl\.js:\d+/;
const RAW_RE = /Cannot read propert|is not a function|is not defined|undefined is not|Unexpected token|ReferenceError|TypeError:|SyntaxError:|RangeError:/;

let docsSchemaCache = new Map();
function docsSchema(cap) {
  if (docsSchemaCache.has(cap.name)) return docsSchemaCache.get(cap.name);
  let s = null;
  try {
    let js = registry.outputJsonSchema(cap);
    const p = cap.output_schema_path ?? join(ROOT, `docs/schemas/${cap.name}.v${cap.capability_version.split('.')[0]}.json`);
    if (!cap.output && existsSync(p)) js = JSON.parse(readFileSync(p, 'utf8'));
    else if (!cap.output && cap.output_schema_path && existsSync(join(ROOT, p))) js = JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
    if (!cap.output && js) s = z.fromJSONSchema(js);
  } catch {
    s = null;
  }
  docsSchemaCache.set(cap.name, s);
  return s;
}

function checkEnvelope(c, r, { expectInvalid = false, mode = 'json', budgetMs } = {}) {
  const v = [];
  const add = (kind, detail) => v.push({ kind, detail });
  const all = r.stdout + '\n' + r.stderr;
  for (const s of secrets) if (all.includes(s.value)) add('secret-leak', `value from secrets/${s.file} appears in output`);
  if (STACK_RE.test(all)) add('stack-or-internal-path', (all.match(STACK_RE) ?? [''])[0].slice(0, 160));
  if (r.killed) {
    add('hang', `killed after ${r.ms}ms (no exit)`);
    return v;
  }
  if (budgetMs !== undefined && r.ms > budgetMs) add('timeout-not-honoured', `took ${r.ms}ms, budget ${budgetMs}ms`);
  if (mode !== 'json') {
    if (r.code === 1 && !r.stdout.trim()) add('text-mode-crash', r.stderr.slice(0, 300));
    if (!r.stdout.trim() && r.code === 0) add('text-mode-empty', 'exit 0 but empty stdout');
    if (RAW_RE.test(all)) add('raw-js-error', (all.match(new RegExp(`.{0,80}(${RAW_RE.source}).{0,80}`)) ?? [''])[0]);
    return v;
  }
  let env;
  try {
    env = JSON.parse(r.stdout);
  } catch {
    add('stdout-not-single-json', `exit ${r.code}; stdout[0..200]=${JSON.stringify(r.stdout.slice(0, 200))}; stderr[0..200]=${JSON.stringify(r.stderr.slice(0, 200))}`);
    return v;
  }
  if (r.stdout.trim() !== JSON.stringify(env, null, 2) && r.stdout.trim().split('\n').length > 1 && !r.stdout.trim().startsWith('{')) add('stdout-extra-content', 'extra lines around envelope');
  for (const k of ['schema_version', 'status', 'capability', 'data', 'error', 'meta', 'context']) if (!(k in env)) add('envelope-missing-field', k);
  if (env.meta) for (const k of ['sources', 'coverage', 'warnings']) if (!(k in env.meta)) add('envelope-missing-field', `meta.${k}`);
  if (!env.context?.request_id) add('envelope-missing-field', 'context.request_id');
  if (!['success', 'partial', 'error'].includes(env.status)) add('bad-status', String(env.status));
  if (env.status === 'error') {
    const code = env.error?.code;
    if (!code || !ERROR_CODES[code]) add('unknown-error-code', String(code));
    else if (ERROR_CODES[code].exit !== r.code) add('exit-code-mismatch', `${code} → exit ${r.code}, documented ${ERROR_CODES[code].exit}`);
    if (env.data !== null && env.data !== undefined) add('error-with-data', 'status=error but data is not null');
    if (code === 'INTERNAL') add('internal-error', String(env.error?.message).slice(0, 300));
    if (expectInvalid && code !== 'INVALID_ARGUMENT') add('invalid-input-not-INVALID_ARGUMENT', `${code}: ${String(env.error?.message).slice(0, 200)}`);
    if (RAW_RE.test(env.error?.message ?? '')) add('raw-js-error', String(env.error?.message).slice(0, 200));
  } else {
    if (env.status === 'success' && r.code !== 0) add('exit-code-mismatch', `success → exit ${r.code}`);
    if (env.status === 'partial' && r.code !== 0 && r.code !== 10) add('exit-code-mismatch', `partial → exit ${r.code}`);
    if (env.error !== null) add('success-with-error', 'error field not null');
    if (expectInvalid) add('invalid-input-accepted', `status=${env.status}`);
    if (c) {
      if (c.output) {
        const chk = c.output.safeParse(env.data);
        if (!chk.success) add('data-schema-violation', chk.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      } else {
        const s = docsSchema(c);
        if (s) {
          const chk = s.safeParse(env.data);
          if (!chk.success) add('data-schema-violation', chk.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
        } else add('no-schema-validator', 'output schema could not be loaded');
      }
      if (!Array.isArray(env.meta?.sources) || env.meta.sources.length === 0) add('missing-sources', 'meta.sources empty on success');
      if (!env.meta?.coverage) add('missing-coverage', 'meta.coverage null on success');
    }
  }
  return v;
}

// ---------- case generation ----------
const caps = registry
  .list()
  .filter((c) => c.status !== 'planned' && c.handler)
  .filter((c) => c.operation !== 'execute')
  .filter((c) => !SKIP_DOMAINS.has(c.domain))
  .filter((c) => !ONLY || c.name.startsWith(ONLY));

const cases = [];
for (const c of caps) {
  const b = baseline(c);
  const valid = { ...b.inputs };
  // never cancel a real plan
  if (c.name === 'operation.cancel') valid.id = 'op-20000101-nonexistent';
  cases.push({ cap: c, name: 'valid-baseline', argv: argvFor(c, valid, b.pre), expectInvalid: false, kind: 'valid' });
  for (const ex of (c.examples ?? []).slice(1, 2)) {
    if (/<[a-z_]+>/.test(ex) || /\.\/q\.sql/.test(ex) || c.name === 'sql.query.submit') continue;
    const p = parseExample(ex, c);
    cases.push({ cap: c, name: 'valid-example-2', argv: argvFor(c, p.inputs, p.pre), expectInvalid: false, kind: 'valid' });
  }
  cases.push({ cap: c, name: 'no-args', argv: argvFor(c, {}), expectInvalid: Object.values(c.inputs).some((s) => s.required), kind: 'noargs' });
  cases.push({ cap: c, name: 'unknown-flag', argv: [...argvFor(c, valid, b.pre), '--bogus-flag=1'], expectInvalid: true, kind: 'invalid' });
  cases.push({ cap: c, name: 'text-mode', argv: argvFor(c, valid, b.pre, ['-o', 'text']), mode: 'text', kind: 'mode' });
  cases.push({ cap: c, name: 'yaml-mode', argv: argvFor(c, valid, b.pre, ['-o', 'yaml']), mode: 'yaml', kind: 'mode' });
  cases.push({ cap: c, name: 'text-mode-error', argv: argvFor(c, { ...valid, 'bogus-flag': '1' }, b.pre, ['-o', 'text']), mode: 'text', kind: 'mode' });
  for (const [name, spec] of Object.entries(c.inputs)) {
    const flag = kebab(name);
    if (spec.required) {
      const m = { ...valid };
      delete m[flag];
      // another input can satisfy the requirement (e.g. --sql vs --sql-file); then this is still invalid
      cases.push({ cap: c, name: `missing-required:${flag}`, argv: argvFor(c, m, b.pre), expectInvalid: true, kind: 'invalid' });
    }
    for (const bad of badValues(spec)) {
      const m = { ...valid, [flag]: bad };
      // a value is "invalid" for the contract only when the input type rejects it
      const typeInvalid =
        (spec.type === 'int' && !/^\s*[+-]?\d+\s*$/.test(bad)) ||
        (spec.type === 'int' && bad === '99999999999999999999') ||
        (spec.type === 'number' && !/^[+-]?\d/.test(bad)) ||
        (spec.type === 'duration' && !['0'].includes(bad)) ||
        (spec.type === 'enum' && bad !== '' ) ||
        (spec.type === 'file' && bad !== '');
      const label = bad.length > 40 ? `${bad.slice(0, 12)}…(${bad.length})` : bad;
      cases.push({ cap: c, name: `bad:${flag}=${label}`, argv: argvFor(c, m, b.pre), expectInvalid: typeInvalid && !(spec.type === 'file' && bad === ''), kind: typeInvalid ? 'invalid' : 'edge' });
    }
  }
  // space-separated negative value (how people type it)
  const intInput = Object.entries(c.inputs).find(([, s]) => s.type === 'int');
  if (intInput) cases.push({ cap: c, name: `space-negative:${kebab(intInput[0])}`, argv: [...argvFor(c, valid, b.pre), `--${kebab(intInput[0])}`, '-5'], kind: 'edge' });
  // timeout budget
  cases.push({ cap: c, name: 'timeout-1s', argv: argvFor(c, valid, ['--timeout', '1s', ...b.pre.filter((x, i, a) => x !== '--timeout' && a[i - 1] !== '--timeout')]), budgetMs: 1000 + 6000, kind: 'timeout' });
}

// global / cross-cutting cases
const globalCases = [
  { name: 'planned-not-callable:mysql deadlock get', argv: ['--json', 'mysql', 'deadlock', 'get'], expectInvalid: true },
  { name: 'planned-not-callable:redis latency get', argv: ['--json', 'redis', 'latency', 'get'], expectInvalid: true },
  { name: 'unknown-command', argv: ['--json', 'nosuch', 'thing'], expectInvalid: true },
  { name: 'bad-global-timeout', argv: ['--json', '--timeout', 'abc', 'resource', 'list'], expectInvalid: true },
  { name: 'negative-global-timeout', argv: ['--json', '--timeout', '-1s', 'resource', 'list'], expectInvalid: true },
  { name: 'zero-global-timeout', argv: ['--json', '--timeout', '0', 'resource', 'list'], expectInvalid: false },
  { name: 'bad-output-format', argv: ['--json', '-o', 'xml', 'resource', 'list'], expectInvalid: true },
  { name: 'nonexistent-profile', argv: ['--json', '--profile', 'nope', 'resource', 'list'], expectInvalid: false },
  { name: 'nonexistent-config', argv: ['--json', '--config', '/nonexistent/workctl.yaml', 'resource', 'list'], expectInvalid: false },
  { name: 'config-is-directory', argv: ['--json', '--config', '/etc', 'resource', 'list'], expectInvalid: false },
  { name: 'json-after-subcommand', argv: ['resource', 'list', '--json'], expectInvalid: false },
  { name: 'missing-option-value', argv: ['--json', 'capability', 'get', '--name'], expectInvalid: true },
  { name: 'excess-positional', argv: ['--json', 'resource', 'list', 'extra'], expectInvalid: true },
  { name: 'fail-on-partial-flag', argv: ['--json', '--fail-on-partial', 'capability', 'list'], expectInvalid: false },
  { name: 'combined-short-ojson', argv: ['-ojson', 'capability', 'get'], expectInvalid: true },
];

// ---------- runner ----------
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}

const started = Date.now();
const results = [];
let done = 0;
await pool(cases, CONCURRENCY, async (cs) => {
  const r = await run(cs.argv);
  const violations = checkEnvelope(cs.cap, r, { expectInvalid: cs.expectInvalid, mode: cs.mode ?? 'json', budgetMs: cs.budgetMs });
  let status = null;
  let code = null;
  try {
    const e = JSON.parse(r.stdout);
    status = e.status;
    code = e.error?.code ?? null;
  } catch {
    /* text mode */
  }
  results.push({ capability: cs.cap.name, case: cs.name, kind: cs.kind, exit: r.code, ms: r.ms, status, code, violations, argv: cs.argv.map((a) => (a.length > 60 ? `${a.slice(0, 40)}…(${a.length})` : a)) });
  if (++done % 50 === 0) process.stderr.write(`  ${done}/${cases.length} cases\n`);
});
for (const g of globalCases) {
  const r = await run(g.argv);
  const json = g.argv.includes('--json') || g.argv.includes('-ojson');
  const violations = checkEnvelope(null, r, { expectInvalid: g.expectInvalid, mode: json ? 'json' : 'text' });
  if (g.name === 'zero-global-timeout' || g.name === 'nonexistent-profile' || g.name === 'nonexistent-config' || g.name === 'config-is-directory') {
    // any documented error code is fine; INTERNAL is not
  }
  let status = null;
  let code = null;
  try {
    const e = JSON.parse(r.stdout);
    status = e.status;
    code = e.error?.code ?? null;
  } catch {
    /* */
  }
  results.push({ capability: '(global)', case: g.name, kind: 'global', exit: r.code, ms: r.ms, status, code, violations, argv: g.argv });
}

// ---------- MCP ----------
const mcp = { ran: false, violations: [] };
async function mcpSession(requests, timeoutMs = 180_000) {
  const input = requests.map((m) => JSON.stringify(m)).join('\n') + '\n';
  const r = await run(['mcp', 'serve', '--timeout', '30s'], { input, timeoutMs });
  const lines = r.stdout.split('\n').filter(Boolean);
  const replies = [];
  for (const l of lines) {
    try {
      replies.push(JSON.parse(l));
    } catch {
      replies.push({ __unparsable: l.slice(0, 200) });
    }
  }
  return { r, replies };
}
if (!NO_MCP) {
  mcp.ran = true;
  const madd = (kind, detail) => mcp.violations.push({ kind, detail });
  const init = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fuzz', version: '0' } } };
  const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  const { replies: lr, r: l0 } = await mcpSession([init, list]);
  const tools = lr.find((x) => x.id === 1)?.result?.tools ?? [];
  const expected = registry
    .list()
    .filter((c) => c.status !== 'planned' && c.handler && c.operation !== 'execute')
    .map((c) => c.name.replace(/[^a-zA-Z0-9_-]/g, '_'))
    .sort();
  const got = tools.map((t) => t.name).sort();
  const missing = expected.filter((n) => !got.includes(n));
  const extra = got.filter((n) => !expected.includes(n));
  if (missing.length) madd('mcp-tools-missing', missing.join(', '));
  if (extra.length) madd('mcp-tools-extra', extra.join(', '));
  if (got.some((n) => registry.list().find((c) => c.name.replace(/[^a-zA-Z0-9_-]/g, '_') === n)?.operation === 'execute')) madd('mcp-exposes-execute', 'execute tool in default tools/list');
  if (l0.stderr.trim()) mcp.stderr = l0.stderr.slice(0, 300);
  mcp.tools = got.length;

  // bad argument types for every tool
  const reqs = [init];
  let id = 100;
  const meta = new Map();
  const wrong = (spec) => {
    switch (spec.type) {
      case 'int':
      case 'number':
        return ['abc', { x: 1 }, true, 1e300, -1];
      case 'bool':
        return ['yes', 1, null];
      case 'list':
        return [42, { a: 1 }, [1, 2]];
      case 'enum':
        return [7, 'bogus'];
      case 'duration':
        return [-5, 'abc', 1.5];
      case 'file':
        return [42, '../../etc/passwd'];
      default:
        return [42, ['a'], { a: 1 }, true];
    }
  };
  for (const c of caps) {
    const tname = c.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const b = baseline(c);
    const validArgs = {};
    for (const [k, v] of Object.entries(b.inputs)) {
      const name = k.replace(/-/g, '_');
      const spec = c.inputs[name];
      if (!spec) continue;
      validArgs[name] = spec.type === 'int' ? Number(v) : spec.type === 'bool' ? v === true : spec.type === 'list' ? [String(v)] : v;
    }
    for (const [name, spec] of Object.entries(c.inputs)) {
      for (const w of wrong(spec)) {
        const rid = id++;
        meta.set(rid, { cap: c.name, arg: name, value: JSON.stringify(w).slice(0, 40) });
        reqs.push({ jsonrpc: '2.0', id: rid, method: 'tools/call', params: { name: tname, arguments: { ...validArgs, [name]: w } } });
      }
    }
    const rid = id++;
    meta.set(rid, { cap: c.name, arg: '(arguments)', value: '"str"' });
    reqs.push({ jsonrpc: '2.0', id: rid, method: 'tools/call', params: { name: tname, arguments: 'str' } });
    const rid2 = id++;
    meta.set(rid2, { cap: c.name, arg: '(unknown arg)', value: 'bogus' });
    reqs.push({ jsonrpc: '2.0', id: rid2, method: 'tools/call', params: { name: tname, arguments: { ...validArgs, bogus_arg: 1 } } });
  }
  reqs.push({ jsonrpc: '2.0', id: 9001, method: 'tools/call', params: { name: 'mysql_deadlock_get', arguments: {} } });
  reqs.push({ jsonrpc: '2.0', id: 9002, method: 'tools/call', params: { name: 'operation_execute', arguments: { id: 'x', confirm: 'x' } } });
  reqs.push({ jsonrpc: '2.0', id: 9003, method: 'tools/call', params: null });
  reqs.push({ jsonrpc: '2.0', id: 9004, method: 'tools/call', params: { name: 42 } });
  reqs.push({ jsonrpc: '2.0', id: 9999, method: 'ping' });
  // the server handles requests concurrently; send in chunks so live backends are not flooded
  const chunks = [];
  for (let i = 1; i < reqs.length; i += 60) chunks.push([init, ...reqs.slice(i, i + 60)]);
  const allReplies = [];
  for (const ch of chunks) {
    const { replies, r } = await mcpSession(ch);
    if (r.killed) madd('mcp-hang', `server did not exit after stdin EOF (${ch.length} requests)`);
    if (STACK_RE.test(r.stdout + r.stderr)) madd('mcp-stack-or-internal-path', (r.stdout + r.stderr).match(STACK_RE)[0].slice(0, 160));
    for (const s of secrets) if ((r.stdout + r.stderr).includes(s.value)) madd('secret-leak', `mcp output contains value from secrets/${s.file}`);
    const ids = new Set(replies.map((x) => x.id));
    for (const q of ch) if (q.id !== undefined && !ids.has(q.id)) madd('mcp-no-reply', `id ${q.id} ${JSON.stringify(meta.get(q.id) ?? q.method)} (server crashed or dropped)`);
    allReplies.push(...replies);
  }
  mcp.calls = reqs.length - 1;
  for (const x of allReplies) {
    if (x.__unparsable) {
      madd('mcp-unparsable-line', x.__unparsable);
      continue;
    }
    const m = meta.get(x.id);
    if (!m) continue;
    if (x.error) {
      if (x.error.code === -32603) madd('mcp-internal-jsonrpc-error', `${m.cap} ${m.arg}=${m.value}: ${x.error.message.slice(0, 160)}`);
      continue;
    }
    const env = x.result?.structuredContent;
    if (!env) {
      madd('mcp-no-envelope', `${m.cap} ${m.arg}=${m.value}`);
      continue;
    }
    if (env.status === 'error' && env.error?.code === 'INTERNAL') madd('mcp-internal-error', `${m.cap} ${m.arg}=${m.value}: ${String(env.error.message).slice(0, 160)}`);
    else if (env.status !== 'error' && m.value !== '-1' && m.value !== '"../../etc/passwd"' && !(m.arg === '(unknown arg)'))
      madd('mcp-bad-arg-accepted', `${m.cap} ${m.arg}=${m.value} → ${env.status}`);
    else if (m.arg === '(unknown arg)' && env.status !== 'error') madd('mcp-unknown-arg-accepted', `${m.cap}`);
    else if (env.status === 'error' && env.error?.code !== 'INVALID_ARGUMENT' && m.value !== '-1' && m.value !== '"../../etc/passwd"')
      madd('mcp-bad-arg-not-INVALID_ARGUMENT', `${m.cap} ${m.arg}=${m.value} → ${env.error?.code}: ${String(env.error?.message).slice(0, 120)}`);
    if (x.result.isError !== (env.status === 'error')) madd('mcp-isError-mismatch', `${m.cap}`);
  }
  const r9001 = allReplies.find((x) => x.id === 9001);
  if (!r9001?.error) madd('mcp-planned-callable', 'mysql_deadlock_get did not return Unknown tool');
  const r9002 = allReplies.find((x) => x.id === 9002);
  if (!r9002?.error && r9002?.result?.structuredContent?.status !== 'error') madd('mcp-execute-callable', 'operation_execute callable by default');
  for (const rid of [9003, 9004]) {
    const rr = allReplies.find((x) => x.id === rid);
    if (!rr) madd('mcp-no-reply', `malformed tools/call id ${rid}`);
    else if (rr.error?.code === -32603) madd('mcp-internal-jsonrpc-error', `malformed params id ${rid}: ${rr.error.message.slice(0, 120)}`);
  }

  // same call via CLI and MCP → same envelope shape
  const shape = (o) => (o === null ? 'null' : Array.isArray(o) ? 'array' : typeof o === 'object' ? `{${Object.keys(o).sort().join(',')}}` : typeof o);
  const parity = [];
  for (const capName of ['resource.list', 'capability.get', 'redis.instance.get', 'mysql.table.get', 'offline.workflow.get', 'mq.topic.list', 'search.cluster.get', 'config.get']) {
    const c = registry.get(capName);
    if (!c || !caps.includes(c)) continue;
    const b = baseline(c);
    const cli = await run(argvFor(c, b.inputs, b.pre));
    const a = {};
    for (const [k, v] of Object.entries(b.inputs)) {
      const name = k.replace(/-/g, '_');
      const spec = c.inputs[name];
      if (spec) a[name] = spec.type === 'int' ? Number(v) : spec.type === 'bool' ? v === true : spec.type === 'list' ? [String(v)] : v;
    }
    const { replies } = await mcpSession([init, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: c.name.replace(/[^a-zA-Z0-9_-]/g, '_'), arguments: a } }]);
    try {
      const e1 = JSON.parse(cli.stdout);
      const e2 = replies.find((x) => x.id === 5)?.result?.structuredContent;
      const same = shape(e1) === shape(e2) && shape(e1.meta) === shape(e2.meta) && shape(e1.data) === shape(e2.data) && e1.status === e2.status;
      parity.push({ capability: capName, cli: e1.status, mcp: e2?.status, same_shape: same });
      if (!same) madd('mcp-cli-shape-mismatch', `${capName}: cli ${e1.status} ${shape(e1.data)} vs mcp ${e2?.status} ${shape(e2?.data)}`);
    } catch (e) {
      madd('mcp-parity-unparsable', `${capName}: ${String(e).slice(0, 100)}`);
    }
  }
  mcp.parity = parity;
}

// ---------- report ----------
const violations = results.flatMap((r) => r.violations.map((v) => ({ capability: r.capability, case: r.case, exit: r.exit, code: r.code, ...v, argv: r.argv.join(' ').slice(0, 300) })));
const byKind = {};
for (const v of [...violations, ...mcp.violations]) byKind[v.kind] = (byKind[v.kind] ?? 0) + 1;
const summary = {
  generated_at: new Date().toISOString(),
  duration_s: Math.round((Date.now() - started) / 1000),
  capabilities: caps.length,
  skipped_domains: [...SKIP_DOMAINS],
  cases: results.length,
  statuses: results.reduce((a, r) => ((a[r.status ?? `text/exit${r.exit}`] = (a[r.status ?? `text/exit${r.exit}`] ?? 0) + 1), a), {}),
  violations_by_kind: byKind,
  mcp: { ran: mcp.ran, tools: mcp.tools, calls: mcp.calls, violations: mcp.violations.length, parity: mcp.parity },
};
writeFileSync(OUT_JSON, JSON.stringify({ summary, violations, mcp_violations: mcp.violations, results: results.map(({ violations: _v, ...r }) => r) }, null, 2) + '\n');
const md = [
  '# Contract fuzz report',
  '',
  `Generated by \`scripts/contract-fuzz.mjs\` at ${summary.generated_at} (${summary.duration_s}s). Secrets are compared, never printed.`,
  '',
  `- capabilities exercised: ${summary.capabilities} (execute operations and domains ${summary.skipped_domains.join(', ') || '(none)'} skipped)`,
  `- CLI cases: ${summary.cases}; statuses: ${Object.entries(summary.statuses).map(([k, v]) => `${k}=${v}`).join(', ')}`,
  `- MCP: ${mcp.ran ? `${mcp.tools} tools listed, ${mcp.calls} calls` : 'not run'}`,
  `- violations: ${violations.length + mcp.violations.length}`,
  '',
  '## Violations by kind',
  '',
  '| kind | count |',
  '| --- | --- |',
  ...Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => `| ${k} | ${n} |`),
  '',
  '## CLI violations',
  '',
  '| capability | case | exit | code | kind | detail |',
  '| --- | --- | --- | --- | --- | --- |',
  ...violations.map((v) => `| ${v.capability} | \`${v.case.replace(/\|/g, '\\|')}\` | ${v.exit} | ${v.code ?? ''} | ${v.kind} | ${String(v.detail).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 200)} |`),
  '',
  '## MCP violations',
  '',
  ...(mcp.violations.length ? mcp.violations.map((v) => `- **${v.kind}**: ${String(v.detail).replace(/\n/g, ' ').slice(0, 240)}`) : ['- none']),
  '',
  '## CLI/MCP envelope parity',
  '',
  ...(mcp.parity ?? []).map((p) => `- ${p.capability}: cli=${p.cli} mcp=${p.mcp} same_shape=${p.same_shape}`),
  '',
].join('\n');
writeFileSync(OUT_MD, md);
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
