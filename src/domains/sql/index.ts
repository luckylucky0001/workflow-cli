import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { readInputFile } from '../../core/engine';
import { source, WorkError, type Source } from '../../core/output';
import { defineCapability, defineDomain } from '../../core/registry';
import { sleep, type Ctx, type Endpoint } from '../../core/runtime';
import { trinoCancel, trinoGet, trinoProbe, trinoStateDir, trinoSubmit, trinoView } from './trino-engine';

const GUIDE = 'docs/guides/compute.md';
const ADAPTER = 'spark-submit-local';
/** Capability-level adapter: chosen per query by --engine (submit) or the state file (get/cancel). */
const CAP_ADAPTER = 'spark-submit-local|trino-http';

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

/** Spark data source short names usable as `<format>.\`<path>\`` (direct file query, spark.sql.runSQLOnFiles). */
const FILE_SOURCES = ['json', 'parquet', 'csv', 'text', 'orc', 'avro', 'binaryfile', 'delta', 'jdbc', 'libsvm', 'image', 'xml', 'hive', 'iceberg', 'hudi'];

/** Extra words rejected for Trino: prepared/dynamic statements, transactions and inline routines (WITH FUNCTION). */
const TRINO_FORBIDDEN = ['EXECUTE', 'IMMEDIATE', 'PREPARE', 'DEALLOCATE', 'COMMIT', 'ROLLBACK', 'FUNCTION'];
/** Trino table functions without side effects; others (e.g. `system.query`) pass SQL through to the connector's database. */
const TRINO_TABLE_FUNCTIONS = ['sequence', 'exclude_columns'];

export function checkReadOnlySql(sql: string, engine: 'spark' | 'trino' = 'spark'): { ok: true; statement: string } | { ok: false; reason: string } {
  const bare = stripSqlLiterals(sql);
  const stmts = bare.split(';').map((s) => s.trim()).filter(Boolean);
  if (stmts.length === 0) return { ok: false, reason: 'SQL 文件没有语句' };
  if (stmts.length > 1) return { ok: false, reason: `只允许单条查询语句，文件中有 ${stmts.length} 条` };
  const first = /^\(*\s*([A-Za-z]+)/.exec(stmts[0])?.[1]?.toUpperCase();
  if (first !== 'SELECT' && first !== 'WITH') return { ok: false, reason: `只允许 SELECT / WITH 查询，首个关键字为 ${first ?? '(无)'}` };
  if (engine === 'trino') return checkTrinoQuery(stmts[0]);
  const words = new Set((stmts[0].toUpperCase().match(/[A-Z_]+/g) ?? []));
  const bad = FORBIDDEN.filter((k) => words.has(k));
  if (bad.length) return { ok: false, reason: `查询中包含写入/DDL/会话关键字: ${bad.join(', ')}` };
  // SELECT TRANSFORM/MAP/REDUCE (...) USING 'script' runs an external command on the driver/executors
  if (/\bUSING\s+_lit_/i.test(stmts[0])) return { ok: false, reason: '不允许脚本转换（TRANSFORM/MAP/REDUCE ... USING \'<命令>\'），它会执行外部命令' };
  // reflect / java_method call arbitrary static Java methods (e.g. System.getenv)
  const fn = /\b(reflect|java_method|try_reflect)\s*\(/i.exec(stmts[0]);
  if (fn) return { ok: false, reason: `不允许调用 ${fn[1]}()（可调用任意 Java 静态方法）` };
  // <format>.`/path` (or <format>.name) reads arbitrary files instead of registered views
  const file = new RegExp(`\\b(${FILE_SOURCES.join('|')})\\s*\\.\\s*(_ident_|[A-Za-z_/])`, 'i').exec(stmts[0]);
  if (file) return { ok: false, reason: `不允许直接查询文件（${file[1]}.\`<路径>\`），只能查询已注册的视图` };
  return { ok: true, statement: stmts[0] };
}

/**
 * Trino rules on top of the shared single-SELECT/WITH check. Spark's file-source rule is not
 * applied (hive/iceberg/delta are ordinary Trino catalog names), and a forbidden word directly
 * followed by `(` is a function call (e.g. replace(s, 'a', 'b')), not a statement keyword.
 */
function checkTrinoQuery(stmt: string): { ok: true; statement: string } | { ok: false; reason: string } {
  const upper = stmt.toUpperCase();
  const words = new Set([...upper.matchAll(/\b([A-Z_]+)\b(?!\s*\()/g)].map((m) => m[1]));
  const bad = [...FORBIDDEN, ...TRINO_FORBIDDEN].filter((k) => words.has(k));
  if (bad.length) return { ok: false, reason: `查询中包含写入/DDL/会话/动态语句关键字: ${bad.join(', ')}` };
  if (/\bFUNCTION\b/.test(upper)) return { ok: false, reason: '不允许在查询中定义内联函数（WITH FUNCTION）' };
  for (const m of stmt.matchAll(/\bTABLE\s*\(\s*([A-Za-z_][\w.]*)\s*\(/gi)) {
    const fn = m[1].split('.').pop()!.toLowerCase();
    if (!TRINO_TABLE_FUNCTIONS.includes(fn)) {
      return { ok: false, reason: `不允许调用表函数 ${m[1]}()（连接器透传查询等表函数可能在目标数据库执行任意语句），允许: ${TRINO_TABLE_FUNCTIONS.join(', ')}` };
    }
  }
  return { ok: true, statement: stmt };
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

/**
 * The recorded pid still belongs to this query's submit process. PIDs are reused after a
 * process exits; where /proc is available the command line must mention the query id, so a
 * dead query is not reported as running and `cancel` never signals an unrelated process group.
 */
export function ownsPid(pid: unknown, queryId: string, procRoot = '/proc'): boolean {
  if (!alive(pid)) return false;
  if (!existsSync(procRoot)) return true; // no /proc (e.g. macOS): best effort
  try {
    return readFileSync(join(procRoot, String(pid), 'cmdline'), 'utf8').includes(queryId);
  } catch {
    return false;
  }
}

/** Environment for the child: drop variables that hold credentials referenced by the profile (`*_ref: env:NAME`). */
export function childEnv(ctx: Ctx, extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const secretVars = new Set<string>();
  for (const named of Object.values(ctx.profile?.endpoints ?? {})) {
    for (const ep of Object.values(named)) {
      for (const [k, v] of Object.entries(ep)) {
        if (k.endsWith('_ref') && typeof v === 'string' && v.startsWith('env:')) secretVars.add(v.slice(4));
      }
    }
  }
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!secretVars.has(k)) env[k] = v;
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;
  return env;
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

const QueryStatsOut = z.object({
  elapsed_ms: z.number().nullable(),
  queued_ms: z.number().nullable(),
  cpu_ms: z.number().nullable(),
  wall_ms: z.number().nullable(),
  processed_rows: z.number().nullable(),
  processed_bytes: z.number().nullable(),
  physical_input_bytes: z.number().nullable(),
  peak_memory_bytes: z.number().nullable(),
  spilled_bytes: z.number().nullable(),
  completed_splits: z.number().nullable(),
  total_splits: z.number().nullable(),
  nodes: z.number().nullable(),
  progress_pct: z.number().nullable(),
  source: z.enum(['statement', 'query-info']).describe('statement=结果页 stats；query-info=GET /v1/query/{id}'),
});

const StateOut = z.object({
  query_id: z.string(),
  engine: z.enum(['spark', 'trino']),
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
  error: z
    .object({
      type: z.string(),
      message: z.string(),
      error_type: z.string().optional().describe('Trino errorType: USER_ERROR / INTERNAL_ERROR / INSUFFICIENT_RESOURCES / EXTERNAL'),
      error_code: z.number().optional(),
      sql_state: z.string().optional(),
      line: z.number().optional(),
      column: z.number().optional(),
      code: z.string().optional().describe('对应的 workctl 错误码（仅 Trino）'),
    })
    .nullable(),
  views: z.array(z.string()).nullable(),
  // Trino only (absent for Spark)
  engine_query_id: z.string().nullable().optional().describe('Trino query id'),
  engine_state: z.string().nullable().optional().describe('引擎原始状态（Trino: QUEUED/PLANNING/STARTING/RUNNING/FINISHING/FINISHED/FAILED）'),
  engine_version: z.string().nullable().optional(),
  column_types: z.array(z.string()).nullable().optional(),
  catalog: z.string().nullable().optional(),
  schema: z.string().nullable().optional(),
  stats: QueryStatsOut.nullable().optional(),
});

function view(st: Record<string, any>, previewRows: number): z.infer<typeof StateOut> {
  let state = st.state as z.infer<typeof StateOut>['state'];
  let basis = '状态文件由 Spark 运行器写入';
  if ((state === 'submitted' || state === 'running') && !ownsPid(st.pid, String(st.query_id ?? ''))) {
    state = 'lost';
    basis = `提交进程 ${st.pid ?? '(未记录)'} 已退出（或 pid 已被其他进程复用）但状态文件未写入终态（进程被终止或运行器启动失败），见 ${st.submit_log ?? '提交日志'}`;
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

/**
 * Find the state file of a query id: the Spark endpoint's query_state_dir, then each Trino
 * endpoint's state directory. `get` / `cancel` take only the id, so the engine is read from the file.
 */
function locate(ctx: Ctx, id: string): { engine: 'spark' | 'trino'; ep: Endpoint; path: string } {
  if (!QID_RE.test(id)) throw new WorkError('INVALID_ARGUMENT', `查询 ID 格式不正确: ${id}`, { hint: '形如 q-20261017-1a2b3c' });
  const trinoNames = ctx.endpointNames('trino');
  if (!trinoNames.length || ctx.hasEndpoint('spark')) {
    let sparkEp: Endpoint | undefined;
    try {
      sparkEp = ctx.endpoint('spark');
      const p = statePath(sparkEp, id);
      if (existsSync(p)) return { engine: 'spark', ep: sparkEp, path: p };
    } catch (e) {
      if (!trinoNames.length) throw e;
    }
  }
  for (const name of trinoNames) {
    const ep = ctx.endpoint('trino', name);
    const p = join(trinoStateDir(ctx, ep), `${id}.json`);
    if (existsSync(p)) return { engine: 'trino', ep, path: p };
  }
  throw new WorkError('NOT_FOUND', `没有查询 ${id}`, { hint: '查询 ID 由 workctl sql query submit 返回' });
}

// ---------------------------------------------------------------------------
// capabilities
// ---------------------------------------------------------------------------

const submit = defineCapability({
  name: 'sql.query.submit',
  command: 'sql query submit',
  summary: '异步提交只读 SQL 查询到计算引擎（Spark SQL local 模式 / Trino），返回查询 ID',
  domain: 'sql',
  adapter: CAP_ADAPTER,
  auth_provider: 'none|trino-basic',
  guide: GUIDE,
  operation: 'read',
  async: true,
  cancellable: true,
  side_effects: 'Spark：启动一个 Spark 应用；Trino：在协调节点创建一个查询（消耗集群资源）。结果写入本地结果目录，不写入数仓表',
  backend_modes: ['live'],
  inputs: {
    engine: { type: 'enum', enum: ['spark', 'trino', 'hive'], default: 'spark', description: '查询引擎（hive 待接入）' },
    file: { type: 'file', required: true, description: '只含一条 SELECT / WITH 查询的 SQL 文件' },
    output: { type: 'string', description: '结果目录（须不存在，且不在 warehouse_root 内；默认 <状态目录>/<id>/result）' },
    preview_rows: { type: 'int', default: 20, description: '状态中保留的预览行数（上限 20）' },
    catalog: { type: 'string', description: '仅 trino：默认 catalog（X-Trino-Catalog，缺省取端点配置）' },
    schema: { type: 'string', description: '仅 trino：默认 schema（X-Trino-Schema，缺省取端点配置）' },
  },
  output: z.object({
    query_id: z.string(),
    engine: z.enum(['spark', 'trino']),
    state: z.literal('submitted'),
    submitted_at: z.string(),
    pid: z.number().nullable().describe('Spark 提交进程 pid；Trino 无本地进程，为 null'),
    sql_sha256: z.string(),
    result_location: z.string(),
    state_file: z.string(),
    tables: z.string(),
    next: z.string(),
    engine_query_id: z.string().nullable().optional().describe('Trino query id（仅 Trino）'),
    engine_state: z.string().nullable().optional().describe('提交返回时 Trino 报告的状态（仅 Trino）'),
  }),
  prerequisites: [
    'spark 端点配置 spark_home、python、query_state_dir、warehouse_root、event_log_dir、driver_log_dir',
    'trino 端点配置 url、user（可选 password_ref、catalog、schema、source、query_state_dir）',
  ],
  notes: [
    '只接受单条 SELECT/WITH；含 INSERT/CREATE/DROP/SET 等关键字的文件在提交前被拒绝（INVALID_ARGUMENT）',
    'Spark：演示环境中 warehouse_root 下每个 <db>/<table> 目录注册为临时视图 <db>_<table>（如 analytics_daily_orders），dt 分区目录成为 dt 列',
    'Spark：提交成功只代表进程已启动；用 sql query get 查看状态，running 表示仍在执行',
    'Trino：另外拒绝 EXECUTE/PREPARE/事务语句、WITH FUNCTION 内联函数和透传类表函数（如 system.query）；提交时在短时间窗口内跟随 nextUri，语法/语义错误直接返回 INVALID_ARGUMENT（表/schema/catalog 不存在为 NOT_FOUND，ACCESS_DENIED 为 PERMISSION_DENIED）',
    'Trino：结果页由 sql query get 继续拉取；超过 query.client.timeout（默认 5 分钟）没有客户端拉取，Trino 会以 ABANDONED_QUERY 结束查询',
  ],
  examples: [
    'workctl sql query submit --engine spark --file demo/offline-workflows/sql/examples/daily_orders_by_status.sql',
    'workctl sql query submit --engine trino --file q.sql --catalog tpch --schema tiny',
  ],
  handler: async (ctx, inp) => {
    if (inp.engine === 'hive') {
      throw new WorkError('UNSUPPORTED', `查询引擎 ${inp.engine} 尚未接入`, { hint: '当前支持 --engine spark / trino；Hive 适配器见 docs/guides/compute.md 待接入列表' });
    }
    const sql = readInputFile(inp.file);
    if (inp.engine === 'trino') {
      const tg = checkReadOnlySql(sql, 'trino');
      if (!tg.ok) throw new WorkError('INVALID_ARGUMENT', `拒绝提交: ${tg.reason}`, { hint: 'sql query submit 只执行只读查询；写入/DDL 走对应的计划-执行流程' });
      return trinoSubmit(ctx, inp, sql, sql.trim().replace(/;\s*$/, '').replace(/;(\s*(--[^\n]*)?\s*)*$/, ''));
    }
    if (inp.catalog !== undefined || inp.schema !== undefined) {
      throw new WorkError('INVALID_ARGUMENT', '--catalog / --schema 只适用于 --engine trino');
    }
    const ep = ctx.endpoint('spark');
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
    const env = childEnv(ctx, {
      WORKCTL_SPARK_HOME: ep.path('spark_home'),
      WORKCTL_SPARK_PYTHON: ep.str('python') ? ep.path('python') : undefined,
      WORKCTL_SPARK_EVENT_DIR: ep.path('event_log_dir'),
      WORKCTL_SPARK_DRIVER_LOG_DIR: ep.path('driver_log_dir'),
      WORKCTL_WAREHOUSE_ROOT: warehouse,
    });
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(script, [`workctl-sql.${id}`, '--mode', 'query', '--sql-file', sqlCopy, '--query-id', id, '--state-file', state, '--output', out, '--preview-rows', String(Math.min(20, Math.max(0, inp.preview_rows)))], {
        detached: true,
        stdio: ['ignore', fd, fd],
        env,
      });
    } finally {
      closeSync(fd);
    }
    // spawn failures (ENOENT/EACCES) arrive as an async 'error' event: without a listener they
    // would crash the process (CLI or MCP server)
    const spawnError = await new Promise<Error | null>((res) => {
      child.once('spawn', () => res(null));
      child.once('error', (e) => res(e));
    });
    child.on('error', () => undefined);
    const pid = child.pid;
    if (spawnError || !pid) {
      const msg = spawnError ? spawnError.message : 'no pid';
      writeState(ep, id, { state: 'failed', error: { type: 'SpawnError', message: msg }, finished_at: new Date().toISOString() });
      throw new WorkError('INTERNAL', `spark-submit 进程未能启动: ${msg}`, { hint: `检查提交脚本 ${script} 是否存在且可执行` });
    }
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
  summary: '查看已提交查询的状态、引擎侧 ID（Spark 应用 / Trino 查询）、统计、结果预览（≤ 20 行）与结果位置',
  domain: 'sql',
  adapter: CAP_ADAPTER,
  auth_provider: 'none|trino-basic',
  guide: GUIDE,
  operation: 'read',
  backend_modes: ['live'],
  inputs: {
    id: { type: 'string', required: true, description: '查询 ID（q-YYYYMMDD-xxxxxx）' },
    preview_rows: { type: 'int', default: 20, description: '预览行数（上限 20）' },
  },
  output: StateOut,
  prerequisites: ['spark 端点配置 query_state_dir；trino 查询读取 trino 端点的状态目录'],
  notes: [
    'state=lost 表示提交进程已退出但没有写入终态，与 failed（运行器捕获到错误）区分；Trino 下表示协调节点已不记得该查询或结果页未取完就失效',
    '结果预览只是前 N 行，完整结果在 result_location（JSON lines）',
    'Trino：get 会继续跟随 nextUri 拉取结果页（每次最多 poll_budget_ms，默认 5 秒），succeeded 表示 Trino 报告 FINISHED 且全部结果页已取回；engine_state 为 Trino 原始状态，stats 为 Trino 统计',
  ],
  examples: ['workctl sql query get --id q-20261017-1a2b3c'],
  handler: async (ctx, inp) => {
    const loc = locate(ctx, inp.id);
    if (loc.engine === 'trino') return trinoGet(ctx, loc.ep, loc.path, Math.min(20, Math.max(0, inp.preview_rows)));
    const ep = loc.ep;
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
  summary: '取消正在运行的查询（Spark：终止 spark-submit 进程组；Trino：DELETE nextUri / /v1/query/{id}）',
  domain: 'sql',
  adapter: CAP_ADAPTER,
  auth_provider: 'none|trino-basic',
  guide: GUIDE,
  operation: 'execute',
  cancellable: true,
  idempotent: true,
  side_effects: 'Spark：向查询的 spark-submit 进程组发送 SIGTERM（5 秒后 SIGKILL）；Trino：取消协调节点上的查询',
  backend_modes: ['live'],
  inputs: { id: { type: 'string', required: true, description: '查询 ID' } },
  output: z.object({
    query_id: z.string(),
    previous_state: z.string(),
    state: z.string(),
    signal: z.string().nullable(),
    app_id: z.string().nullable(),
    engine_query_id: z.string().nullable().optional().describe('Trino query id（仅 Trino）'),
    engine_state: z.string().nullable().optional().describe('取消后协调节点报告的状态（仅 Trino）'),
    confirmed: z.boolean().optional().describe('仅 Trino：协调节点已确认 USER_CANCELED；false 时 state=cancel_requested'),
  }),
  prerequisites: ['profile allow_execute=true'],
  notes: [
    '已结束的查询返回 CONFLICT；被终止的 Spark 应用在 history server 中显示为未完成（incomplete）',
    'Trino：发送 DELETE 后查询 GET /v1/query/{id} 确认 USER_CANCELED；未确认时 state=cancel_requested，如查询已先结束则如实报告',
  ],
  examples: ['workctl sql query cancel --id q-20261017-1a2b3c'],
  handler: async (ctx, inp) => {
    const loc = locate(ctx, inp.id);
    if (loc.engine === 'trino') return trinoCancel(ctx, loc.ep, loc.path);
    const ep = loc.ep;
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
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* exited between the check and the signal */
      }
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
  summary: '向计算引擎异步提交只读 SQL 查询并跟踪状态（Spark SQL / Trino）',
  pillar: 'offline',
  guide: GUIDE,
  skill: 'skills/offline-operations/SKILL.md',
  capabilities: [submit, get, cancel, hive],
  probes: { trino: trinoProbe },
});
