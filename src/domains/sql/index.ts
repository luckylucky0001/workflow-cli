import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { readInputFile } from '../../core/engine';
import { source, WorkError, type Source } from '../../core/output';
import { defineCapability, defineDomain } from '../../core/registry';
import { sleep, type Ctx, type Endpoint } from '../../core/runtime';

const GUIDE = 'docs/guides/compute.md';
const ADAPTER = 'spark-submit-local';

// ---------------------------------------------------------------------------
// Read-only SQL guard (pure, unit-tested)
// ---------------------------------------------------------------------------

/** Remove comments and string/identifier literals so keyword checks see only SQL structure. */
export function stripSqlLiterals(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    if (c === '-' && n === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
      out += ' ';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '\\') j += 2;
        else if (sql[j] === c) {
          if (sql[j + 1] === c) j += 2;
          else break;
        } else j++;
      }
      out += c === '`' ? ' _ident_ ' : ' _lit_ ';
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const FORBIDDEN = ['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'REPLACE', 'LOAD', 'GRANT', 'REVOKE', 'MSCK', 'REFRESH', 'CACHE', 'UNCACHE', 'SET', 'RESET', 'ADD', 'USE', 'ANALYZE', 'CALL', 'EXPORT', 'IMPORT', 'OVERWRITE', 'DIRECTORY'];

export function checkReadOnlySql(sql: string): { ok: true; statement: string } | { ok: false; reason: string } {
  const bare = stripSqlLiterals(sql);
  const stmts = bare.split(';').map((s) => s.trim()).filter(Boolean);
  if (stmts.length === 0) return { ok: false, reason: 'SQL 文件没有语句' };
  if (stmts.length > 1) return { ok: false, reason: `只允许单条查询语句，文件中有 ${stmts.length} 条` };
  const first = /^\(*\s*([A-Za-z]+)/.exec(stmts[0])?.[1]?.toUpperCase();
  if (first !== 'SELECT' && first !== 'WITH') return { ok: false, reason: `只允许 SELECT / WITH 查询，首个关键字为 ${first ?? '(无)'}` };
  const words = new Set((stmts[0].toUpperCase().match(/[A-Z_]+/g) ?? []));
  const bad = FORBIDDEN.filter((k) => words.has(k));
  if (bad.length) return { ok: false, reason: `查询中包含写入/DDL/会话关键字: ${bad.join(', ')}` };
  return { ok: true, statement: stmts[0] };
}

// ---------------------------------------------------------------------------
// Query state
// ---------------------------------------------------------------------------

const QID_RE = /^q-\d{8}-[a-f0-9]{6}$/;

function stateDir(ep: Endpoint): string {
  const d = ep.path('query_state_dir');
  if (!d) throw new WorkError('NOT_CONFIGURED', `spark 端点 ${ep.id} 未配置 query_state_dir`);
  return d;
}

function statePath(ep: Endpoint, id: string): string {
  if (!QID_RE.test(id)) throw new WorkError('INVALID_ARGUMENT', `查询 ID 格式不正确: ${id}`, { hint: '形如 q-20261017-1a2b3c' });
  return join(stateDir(ep), `${id}.json`);
}

function readState(ep: Endpoint, id: string): Record<string, any> {
  const p = statePath(ep, id);
  if (!existsSync(p)) throw new WorkError('NOT_FOUND', `没有查询 ${id}`, { hint: '查询 ID 由 workctl sql query submit 返回' });
  return JSON.parse(readFileSync(p, 'utf8'));
}

function writeState(ep: Endpoint, id: string, patch: Record<string, unknown>): Record<string, any> {
  const p = statePath(ep, id);
  const cur = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  const next = { ...cur, ...patch, updated_at: new Date().toISOString() };
  writeFileSync(`${p}.tmp`, JSON.stringify(next, null, 2));
  renameSync(`${p}.tmp`, p);
  return next;
}

function alive(pid: unknown): boolean {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function submitScript(ctx: Ctx, ep: Endpoint): string {
  const configured = ep.path('submit_script');
  const p = configured ?? resolve(ctx.loaded.baseDir, '..', 'offline-workflows', 'spark', 'spark-submit.sh');
  if (!existsSync(p)) {
    throw new WorkError('NOT_CONFIGURED', `找不到 Spark 提交脚本: ${p}`, { hint: `在 spark 端点 ${ep.id} 中配置 submit_script` });
  }
  return p;
}

function within(child: string, parent: string): boolean {
  const r = relative(parent, child);
  return !r.startsWith('..') && !isAbsolute(r);
}

const StateOut = z.object({
  query_id: z.string(),
  engine: z.literal('spark'),
  state: z.enum(['submitted', 'running', 'succeeded', 'failed', 'cancelled', 'lost']),
  state_basis: z.string(),
  submitted_at: z.string().nullable(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  duration_ms: z.number().nullable(),
  app_id: z.string().nullable(),
  spark_version: z.string().nullable(),
  sql_file: z.string().nullable(),
  sql_sha256: z.string().nullable(),
  row_count: z.number().nullable(),
  columns: z.array(z.string()).nullable(),
  preview: z.array(z.record(z.string(), z.unknown())),
  preview_truncated: z.boolean(),
  result_location: z.string().nullable(),
  result_format: z.string().nullable(),
  error: z.object({ type: z.string(), message: z.string() }).nullable(),
  views: z.array(z.string()).nullable(),
});

function view(st: Record<string, any>, previewRows: number): z.infer<typeof StateOut> {
  let state = st.state as z.infer<typeof StateOut>['state'];
  let basis = '状态文件由 Spark 运行器写入';
  if ((state === 'submitted' || state === 'running') && !alive(st.pid)) {
    state = 'lost';
    basis = `提交进程 ${st.pid} 已退出但状态文件未写入终态（进程被终止或运行器启动失败），见 ${st.submit_log ?? '提交日志'}`;
  } else if (state === 'cancelled') basis = '由 workctl sql query cancel 终止';
  const preview = Array.isArray(st.preview) ? st.preview.slice(0, previewRows) : [];
  return {
    query_id: st.query_id,
    engine: 'spark',
    state,
    state_basis: basis,
    submitted_at: st.submitted_at ?? null,
    started_at: st.started_at ?? null,
    finished_at: st.finished_at ?? st.cancelled_at ?? null,
    duration_ms: st.duration_ms ?? null,
    app_id: st.app_id ?? null,
    spark_version: st.spark_version ?? null,
    sql_file: st.sql_file ?? null,
    sql_sha256: st.sql_sha256 ?? null,
    row_count: st.row_count ?? null,
    columns: st.columns ?? null,
    preview,
    preview_truncated: Boolean(st.preview_truncated) || (Array.isArray(st.preview) && st.preview.length > preview.length),
    result_location: st.state === 'succeeded' ? st.result_location ?? null : null,
    result_format: st.result_format ?? null,
    error: st.error ?? null,
    views: st.views ?? null,
  };
}

// ---------------------------------------------------------------------------
// capabilities
// ---------------------------------------------------------------------------

const submit = defineCapability({
  name: 'sql.query.submit',
  command: 'sql query submit',
  summary: '异步提交只读 SQL 查询到计算引擎（当前支持 Spark SQL，local 模式），返回查询 ID',
  domain: 'sql',
  adapter: ADAPTER,
  auth_provider: 'none',
  guide: GUIDE,
  operation: 'read',
  async: true,
  cancellable: true,
  side_effects: '启动一个 Spark 应用（消耗计算资源）；结果写入 query_state_dir 下的结果目录，不写入数仓表',
  backend_modes: ['live'],
  inputs: {
    engine: { type: 'enum', enum: ['spark', 'trino', 'hive'], default: 'spark', description: '查询引擎（trino / hive 待接入）' },
    file: { type: 'file', required: true, description: '只含一条 SELECT / WITH 查询的 SQL 文件' },
    output: { type: 'string', description: '结果目录（须不存在，且不在 warehouse_root 内；默认 query_state_dir/<id>/result）' },
    preview_rows: { type: 'int', default: 20, description: '状态中保留的预览行数（上限 20）' },
  },
  output: z.object({
    query_id: z.string(),
    engine: z.literal('spark'),
    state: z.literal('submitted'),
    submitted_at: z.string(),
    pid: z.number(),
    sql_sha256: z.string(),
    result_location: z.string(),
    state_file: z.string(),
    tables: z.string(),
    next: z.string(),
  }),
  prerequisites: ['spark 端点配置 spark_home、python、query_state_dir、warehouse_root、event_log_dir、driver_log_dir'],
  notes: [
    '只接受单条 SELECT/WITH；含 INSERT/CREATE/DROP/SET 等关键字的文件在提交前被拒绝（INVALID_ARGUMENT）',
    '演示环境中 warehouse_root 下每个 <db>/<table> 目录注册为临时视图 <db>_<table>（如 analytics_daily_orders），dt 分区目录成为 dt 列',
    '提交成功只代表进程已启动；用 sql query get 查看状态，running 表示仍在执行',
  ],
  examples: ['workctl sql query submit --engine spark --file demo/offline-workflows/sql/examples/daily_orders_by_status.sql'],
  handler: async (ctx, inp) => {
    if (inp.engine !== 'spark') {
      throw new WorkError('UNSUPPORTED', `查询引擎 ${inp.engine} 尚未接入`, { hint: '当前只支持 --engine spark；Trino / Hive 适配器见 docs/guides/compute.md 待接入列表' });
    }
    const ep = ctx.endpoint('spark');
    const sql = readInputFile(inp.file);
    const guard = checkReadOnlySql(sql);
    if (!guard.ok) throw new WorkError('INVALID_ARGUMENT', `拒绝提交: ${guard.reason}`, { hint: 'sql query submit 只执行只读查询；写入/DDL 走对应的计划-执行流程' });
    const dir = stateDir(ep);
    mkdirSync(dir, { recursive: true });
    const now = new Date();
    const id = `q-${now.toISOString().slice(0, 10).replaceAll('-', '')}-${randomBytes(3).toString('hex')}`;
    const warehouse = ep.path('warehouse_root');
    const out = inp.output ? resolve(inp.output) : join(dir, id, 'result');
    if (existsSync(out)) throw new WorkError('CONFLICT', `结果目录已存在: ${out}`, { hint: '换一个 --output 或省略使用默认目录' });
    if (warehouse && within(out, warehouse)) throw new WorkError('INVALID_ARGUMENT', '结果目录不能位于 warehouse_root 内（避免把查询结果当成表数据）');
    mkdirSync(dirname(out), { recursive: true });
    const sqlCopy = join(dir, `${id}.sql`);
    writeFileSync(sqlCopy, sql);
    const sha = createHash('sha256').update(sql).digest('hex');
    const script = submitScript(ctx, ep);
    const submitLog = join(dir, `${id}.submit.log`);
    const state = statePath(ep, id);
    writeState(ep, id, { query_id: id, engine: 'spark', state: 'submitted', submitted_at: now.toISOString(), sql_file: resolve(inp.file), sql_snapshot: sqlCopy, sql_sha256: sha, result_location: out, submit_log: submitLog, request_id: ctx.requestId });
    const fd = openSync(submitLog, 'a');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(ep.path('spark_home') ? { WORKCTL_SPARK_HOME: ep.path('spark_home') } : {}),
      ...(ep.str('python') ? { WORKCTL_SPARK_PYTHON: ep.path('python') } : {}),
      ...(ep.path('event_log_dir') ? { WORKCTL_SPARK_EVENT_DIR: ep.path('event_log_dir') } : {}),
      ...(ep.path('driver_log_dir') ? { WORKCTL_SPARK_DRIVER_LOG_DIR: ep.path('driver_log_dir') } : {}),
      ...(warehouse ? { WORKCTL_WAREHOUSE_ROOT: warehouse } : {}),
    };
    const child = spawn(script, [`workctl-sql.${id}`, '--mode', 'query', '--sql-file', sqlCopy, '--query-id', id, '--state-file', state, '--output', out, '--preview-rows', String(Math.min(20, Math.max(0, inp.preview_rows)))], {
      detached: true,
      stdio: ['ignore', fd, fd],
      env,
    });
    closeSync(fd);
    const pid = child.pid;
    if (!pid) throw new WorkError('INTERNAL', 'spark-submit 进程未能启动');
    child.unref();
    writeState(ep, id, { pid });
    return {
      data: {
        query_id: id,
        engine: 'spark' as const,
        state: 'submitted' as const,
        submitted_at: now.toISOString(),
        pid,
        sql_sha256: sha,
        result_location: out,
        state_file: state,
        tables: '数仓目录注册为 <db>_<table> 临时视图',
        next: `workctl sql query get --id ${id}`,
      },
      sources: [source('spark', ADAPTER, { endpoint: ep.id, method: `spawn ${script} --mode query`, relation: 'explicit' })],
      coverage: { complete: true, scope: id },
    };
  },
});

const get = defineCapability({
  name: 'sql.query.get',
  command: 'sql query get',
  summary: '查看已提交查询的状态、Spark 应用 ID、结果预览（≤ 20 行）与结果位置',
  domain: 'sql',
  adapter: ADAPTER,
  auth_provider: 'none',
  guide: GUIDE,
  operation: 'read',
  backend_modes: ['live'],
  inputs: {
    id: { type: 'string', required: true, description: '查询 ID（q-YYYYMMDD-xxxxxx）' },
    preview_rows: { type: 'int', default: 20, description: '预览行数（上限 20）' },
  },
  output: StateOut,
  prerequisites: ['spark 端点配置 query_state_dir'],
  notes: ['state=lost 表示提交进程已退出但没有写入终态，与 failed（运行器捕获到错误）区分', '结果预览只是前 N 行，完整结果在 result_location（JSON lines）'],
  examples: ['workctl sql query get --id q-20261017-1a2b3c'],
  handler: async (ctx, inp) => {
    const ep = ctx.endpoint('spark');
    const st = readState(ep, inp.id);
    const v = view(st, Math.min(20, Math.max(0, inp.preview_rows)));
    const sources: Source[] = [source('workctl-state', ADAPTER, { endpoint: `${ep.id}:query_state_dir`, method: `${inp.id}.json`, observed_at: st.updated_at ?? new Date().toISOString(), version: st.spark_version, relation: 'explicit' })];
    return {
      data: v,
      sources,
      coverage: { complete: v.state === 'succeeded' ? !v.preview_truncated : true, scope: inp.id, ...(v.preview_truncated ? { truncated: true, limit: v.preview.length } : {}) },
    };
  },
});

const cancel = defineCapability({
  name: 'sql.query.cancel',
  command: 'sql query cancel',
  summary: '取消正在运行的查询（终止 spark-submit 进程组）',
  domain: 'sql',
  adapter: ADAPTER,
  auth_provider: 'none',
  guide: GUIDE,
  operation: 'execute',
  cancellable: true,
  idempotent: true,
  side_effects: '向查询的 spark-submit 进程组发送 SIGTERM（5 秒后 SIGKILL）',
  backend_modes: ['live'],
  inputs: { id: { type: 'string', required: true, description: '查询 ID' } },
  output: z.object({ query_id: z.string(), previous_state: z.string(), state: z.string(), signal: z.string().nullable(), app_id: z.string().nullable() }),
  prerequisites: ['profile allow_execute=true'],
  notes: ['已结束的查询返回 CONFLICT；被终止的 Spark 应用在 history server 中显示为未完成（incomplete）'],
  examples: ['workctl sql query cancel --id q-20261017-1a2b3c'],
  handler: async (ctx, inp) => {
    const ep = ctx.endpoint('spark');
    const st = readState(ep, inp.id);
    const v = view(st, 0);
    if (v.state !== 'submitted' && v.state !== 'running') {
      throw new WorkError('CONFLICT', `查询 ${inp.id} 已处于 ${v.state}，无需取消`);
    }
    const pid = st.pid as number;
    let signal = 'SIGTERM';
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      process.kill(pid, 'SIGTERM');
    }
    for (let i = 0; i < 10 && alive(pid); i++) await sleep(500, ctx.signal);
    if (alive(pid)) {
      signal = 'SIGKILL';
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    const now = new Date().toISOString();
    writeState(ep, inp.id, { state: 'cancelled', cancelled_at: now, cancel_signal: signal, cancelled_by_request: ctx.requestId });
    return {
      data: { query_id: inp.id, previous_state: v.state, state: 'cancelled', signal, app_id: st.app_id ?? null },
      sources: [source('process', ADAPTER, { method: `kill -${signal} -${pid}`, relation: 'explicit' })],
      coverage: { complete: true, scope: inp.id },
    };
  },
});

const trino = defineCapability({
  name: 'sql.query.submit-trino',
  command: 'sql query submit-trino',
  summary: '向 Trino 提交只读查询（待接入）',
  domain: 'sql',
  adapter: 'trino-rest',
  auth_provider: 'trino-basic-or-jwt',
  guide: GUIDE,
  operation: 'read',
  status: 'planned',
  notes: ['接入后并入 sql query submit --engine trino'],
});

const hive = defineCapability({
  name: 'sql.query.submit-hive',
  command: 'sql query submit-hive',
  summary: '向 HiveServer2 提交只读查询（待接入）',
  domain: 'sql',
  adapter: 'hiveserver2-thrift',
  auth_provider: 'kerberos-or-ldap',
  guide: GUIDE,
  operation: 'read',
  status: 'planned',
  notes: ['接入后并入 sql query submit --engine hive'],
});

export default defineDomain({
  name: 'sql',
  title: 'SQL 提交',
  summary: '向计算引擎异步提交只读 SQL 查询并跟踪状态（Spark SQL）',
  pillar: 'offline',
  guide: GUIDE,
  capabilities: [submit, get, cancel, trino, hive],
});
