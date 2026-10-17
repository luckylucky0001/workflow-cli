/** `sql query submit|get|cancel --engine trino`: workctl state file + Trino client protocol. */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { safeUrl } from '../../core/http';
import { source, WorkError, type Source } from '../../core/output';
import type { Probe } from '../../core/registry';
import { sleep, type Ctx, type Endpoint } from '../../core/runtime';
import {
  absorbPage,
  absorbQueryInfo,
  preRun,
  resultFileFor,
  terminal,
  TRINO_ADAPTER,
  TrinoClient,
  withQueryLock,
  type StoredError,
} from './trino';

const QID_RE = /^q-\d{8}-[a-f0-9]{6}$/;
const NEXT_METHOD = 'GET nextUri (/v1/statement/{queued|executing}/{queryId}/{slug}/{token})';

export function trinoStateDir(ctx: Ctx, ep: Endpoint): string {
  return ep.path('query_state_dir') ?? join(ctx.stateDir, 'sql', 'trino', ep.name);
}

function statePath(dir: string, id: string): string {
  if (!QID_RE.test(id)) throw new WorkError('INVALID_ARGUMENT', `查询 ID 格式不正确: ${id}`, { hint: '形如 q-20261017-1a2b3c' });
  return join(dir, `${id}.json`);
}

function save(path: string, st: Record<string, any>): void {
  st.updated_at = new Date().toISOString();
  writeFileSync(`${path}.tmp`, JSON.stringify(st, null, 2));
  renameSync(`${path}.tmp`, path);
}

async function version(client: TrinoClient, fallback?: string | null): Promise<string | undefined> {
  try {
    return (await client.info()).version ?? fallback ?? undefined;
  } catch {
    return fallback ?? undefined;
  }
}

function trinoSource(ep: Endpoint, method: string, ver: string | undefined | null): Source {
  return source('trino', TRINO_ADAPTER, { endpoint: ep.id, method, ...(ver ? { version: ver } : {}), relation: 'explicit' });
}

/** Fill start/end times and final stats from the coordinator once the query is terminal (best effort). */
async function finalize(client: TrinoClient, st: Record<string, any>, methods: string[]): Promise<void> {
  if (!terminal(st.state) || st.finalized || !st.engine_query_id || st.state === 'lost') return;
  try {
    const info = await client.queryInfo(st.engine_query_id);
    if (!methods.includes('GET /v1/query/{queryId}')) methods.push('GET /v1/query/{queryId}');
    const qs = info?.queryStats;
    if (qs?.executionStartTime) st.started_at = qs.executionStartTime;
    if (qs?.endTime) st.finished_at = qs.endTime;
    if (qs?.createTime) st.engine_created_at = qs.createTime;
  } catch {
    /* times stay as observed */
  }
  st.finished_at ??= new Date().toISOString();
  st.finished_at_basis ??= st.started_at ? 'trino' : 'observed';
  st.finalized = true;
}

/**
 * Follow nextUri until `stop` says so, the page chain ends, or the deadline passes. Persists after
 * every page because a consumed page token cannot be fetched again once the next one is requested.
 */
async function drive(ctx: Ctx, client: TrinoClient, path: string, st: Record<string, any>, deadline: number, stop: (s: Record<string, any>) => boolean, methods: string[]): Promise<void> {
  const resultFile = st.result_location ? resultFileFor(st.result_location) : null;
  while (st.next_uri && !terminal(st.state) && Date.now() < deadline && !ctx.signal.aborted) {
    const page = await client.next(st.next_uri);
    if (!methods.includes(NEXT_METHOD)) methods.push(NEXT_METHOD);
    if (!page) {
      const info = st.engine_query_id ? await client.queryInfo(st.engine_query_id) : null;
      methods.push('GET /v1/query/{queryId}');
      absorbQueryInfo(st, info, 'nextUri 已失效（HTTP 404/410）');
      save(path, st);
      break;
    }
    const { limitHit } = absorbPage(st, page, resultFile);
    if (limitHit && page.nextUri) {
      await client.del(page.nextUri).catch(() => undefined);
      methods.push('DELETE nextUri');
      st.next_uri = null;
    }
    save(path, st);
    if (stop(st)) break;
  }
  if (!st.next_uri && !terminal(st.state) && !st.engine_query_id) {
    st.state = 'lost';
    st.lost_basis = '状态文件中没有 Trino query id 和 nextUri：提交请求未得到 Trino 响应（workctl 进程在 POST 期间退出）';
  }
  if (!st.next_uri && !terminal(st.state) && st.engine_query_id) {
    // nothing left to follow (e.g. cancel requested): ask the coordinator
    const info = await client.queryInfo(st.engine_query_id);
    methods.push('GET /v1/query/{queryId}');
    absorbQueryInfo(st, info, '没有可跟随的 nextUri');
    save(path, st);
  }
  await finalize(client, st, methods);
  save(path, st);
}

// ---------------------------------------------------------------------------
// submit
// ---------------------------------------------------------------------------

export async function trinoSubmit(ctx: Ctx, inp: Record<string, any>, sql: string, statement: string) {
  const ep = ctx.endpoint('trino');
  const client = new TrinoClient(ctx, ep);
  const dir = trinoStateDir(ctx, ep);
  mkdirSync(dir, { recursive: true });
  const now = new Date();
  const id = `q-${now.toISOString().slice(0, 10).replaceAll('-', '')}-${randomBytes(3).toString('hex')}`;
  const out = inp.output ? resolve(inp.output) : join(dir, id, 'result');
  if (existsSync(out)) throw new WorkError('CONFLICT', `结果目录已存在: ${out}`, { hint: '换一个 --output 或省略使用默认目录' });
  const sqlCopy = join(dir, `${id}.sql`);
  writeFileSync(sqlCopy, sql);
  const sha = createHash('sha256').update(sql).digest('hex');
  const path = statePath(dir, id);
  const catalog = inp.catalog ?? ep.str('catalog') ?? null;
  const schema = inp.schema ?? ep.str('schema') ?? null;
  const st: Record<string, any> = {
    query_id: id,
    engine: 'trino',
    endpoint: ep.name,
    state: 'submitted',
    submitted_at: now.toISOString(),
    sql_file: resolve(inp.file),
    sql_snapshot: sqlCopy,
    sql_sha256: sha,
    catalog,
    schema,
    result_location: out,
    result_format: 'json-lines',
    preview_limit: Math.min(20, Math.max(0, inp.preview_rows)),
    max_result_rows: ep.num('max_result_rows', 100_000),
    preview: [],
    request_id: ctx.requestId,
  };
  save(path, st);
  const ver = await version(client);
  st.trino_version = ver ?? null;
  const methods = ['POST /v1/statement'];
  let first;
  try {
    // trailing ';' is not accepted by the statement endpoint; send the guarded statement
    first = await client.submit(statement, { catalog: inp.catalog, schema: inp.schema });
  } catch (e) {
    st.state = 'failed';
    st.error = { type: 'SubmitError', message: e instanceof Error ? e.message : String(e) };
    st.finished_at = new Date().toISOString();
    save(path, st);
    throw e;
  }
  absorbPage(st, first, resultFileFor(out));
  save(path, st);
  // short settle window: parse/analysis errors surface while the query is QUEUED/PLANNING
  const settle = Math.min(ep.num('submit_wait_ms', 3000)!, Math.max(0, ctx.remainingMs() - 2000));
  await drive(ctx, client, path, st, Date.now() + settle, (s) => !preRun(s), methods);
  if (st.state === 'failed' || st.state === 'cancelled') {
    const err = st.error as StoredError | undefined;
    const code = (err?.code as any) ?? 'UPSTREAM_UNAVAILABLE';
    throw new WorkError(code, `Trino 拒绝查询: ${err?.type ?? 'FAILED'}: ${err?.message ?? ''}`.slice(0, 1000), {
      hint: code === 'INVALID_ARGUMENT' ? '检查 SQL 语法、列名和类型；状态文件已记录错误，可用 sql query get 查看' : `状态已记录，可用 workctl sql query get --id ${id} 查看`,
      details: { query_id: id, engine_query_id: st.engine_query_id ?? null, error_name: err?.type, error_type: err?.error_type, line: err?.line, column: err?.column },
    });
  }
  return {
    data: {
      query_id: id,
      engine: 'trino' as const,
      state: 'submitted' as const,
      submitted_at: now.toISOString(),
      pid: null,
      sql_sha256: sha,
      result_location: out,
      state_file: path,
      tables: `Trino 表名 <catalog>.<schema>.<table>；默认 catalog=${catalog ?? '(未设置)'}，schema=${schema ?? '(未设置)'}`,
      next: `workctl sql query get --id ${id}`,
      engine_query_id: st.engine_query_id ?? null,
      engine_state: st.engine_state ?? null,
    },
    sources: [trinoSource(ep, methods.join(' → '), ver)],
    coverage: { complete: true, scope: id, notes: [`提交返回时 Trino 状态 ${st.engine_state ?? '(未知)'}；结果页由 sql query get 继续拉取`] },
  };
}

// ---------------------------------------------------------------------------
// view
// ---------------------------------------------------------------------------

export function trinoView(st: Record<string, any>, previewRows: number) {
  const state = st.state as 'submitted' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'lost';
  const es = st.engine_state ?? '(未知)';
  const basis: Record<string, string> = {
    submitted: `Trino 状态 ${es}（已接受，尚未开始执行）；最近一次拉取 ${st.updated_at ?? '(无)'}`,
    running: `Trino 状态 ${es}；结果页尚未取完（已接收 ${st.row_count ?? 0} 行），最近一次拉取 ${st.updated_at ?? '(无)'}`,
    succeeded: 'Trino 报告 FINISHED，且 workctl 已取完全部结果页（nextUri 链结束）',
    failed: `Trino 报告 ${es}: ${st.error?.type ?? ''}${st.error?.error_type ? `（${st.error.error_type}）` : ''}；失败前已接收 ${st.row_count ?? 0} 行`,
    cancelled: `Trino 报告 USER_CANCELED（${st.cancelled_by_request ? '由 workctl sql query cancel 发起' : '由其他客户端或管理员取消'}）`,
    lost: st.lost_basis ?? 'workctl 无法再获取该查询的状态',
  };
  const preview = Array.isArray(st.preview) ? st.preview.slice(0, previewRows) : [];
  const rowCount = typeof st.row_count === 'number' ? st.row_count : null;
  return {
    query_id: st.query_id,
    engine: 'trino' as const,
    state,
    state_basis: basis[state] ?? `状态 ${state}`,
    submitted_at: st.submitted_at ?? null,
    started_at: st.started_at ?? null,
    finished_at: terminal(state) ? st.finished_at ?? null : null,
    duration_ms: terminal(state) ? st.stats?.elapsed_ms ?? null : null,
    app_id: null,
    spark_version: null,
    sql_file: st.sql_file ?? null,
    sql_sha256: st.sql_sha256 ?? null,
    // total only once every page was received (as Spark); partial counts are in state_basis
    row_count: state === 'succeeded' ? rowCount : null,
    columns: st.columns ?? null,
    preview,
    preview_truncated: Boolean(st.preview_truncated) || (rowCount !== null && rowCount > preview.length),
    result_location: state === 'succeeded' ? st.result_location ?? null : null,
    result_format: st.result_format ?? null,
    error: st.error ?? null,
    views: null,
    engine_query_id: st.engine_query_id ?? null,
    engine_state: st.engine_state ?? null,
    engine_version: st.trino_version ?? null,
    column_types: st.column_types ?? null,
    catalog: st.catalog ?? null,
    schema: st.schema ?? null,
    stats: st.stats ?? null,
  };
}

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

export async function trinoGet(ctx: Ctx, ep: Endpoint, path: string, previewRows: number) {
  let st = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
  const sources: Source[] = [];
  const notes: string[] = [];
  if (!terminal(st.state)) {
    const client = new TrinoClient(ctx, ep);
    const methods: string[] = [];
    const budget = Math.min(ep.num('poll_budget_ms', 5000)!, Math.max(0, ctx.remainingMs() - 3000));
    await withQueryLock(
      path,
      ctx,
      async () => {
        st = JSON.parse(readFileSync(path, 'utf8'));
        await drive(ctx, client, path, st, Date.now() + budget, () => false, methods);
      },
      () => {
        notes.push('另一个 sql query get 正在拉取该查询的结果页，本次只读取状态文件');
      },
    );
    if (methods.length) {
      const ver = await version(client, st.trino_version);
      if (ver && !st.trino_version) st.trino_version = ver;
      sources.push(trinoSource(ep, methods.join(' → '), ver));
    }
    if (!terminal(st.state)) notes.push(`本次拉取预算 ${budget}ms 内查询未结束；Trino 需要客户端持续拉取，超过 query.client.timeout（默认 5 分钟）无人拉取会以 ABANDONED_QUERY 失败`);
  }
  const v = trinoView(st, previewRows);
  sources.unshift(source('workctl-state', TRINO_ADAPTER, { endpoint: `${ep.id}:query_state_dir`, method: `${st.query_id}.json`, observed_at: st.updated_at ?? new Date().toISOString(), ...(st.trino_version ? { version: st.trino_version } : {}), relation: 'explicit' }));
  return {
    data: v,
    sources,
    coverage: {
      complete: v.state === 'succeeded' ? !v.preview_truncated : true,
      scope: st.query_id,
      ...(v.preview_truncated ? { truncated: true, limit: v.preview.length } : {}),
      ...(notes.length ? { notes } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

export async function trinoCancel(ctx: Ctx, ep: Endpoint, path: string) {
  const st = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
  if (terminal(st.state)) throw new WorkError('CONFLICT', `查询 ${st.query_id} 已处于 ${st.state}，无需取消`);
  const previous = st.state as string;
  const client = new TrinoClient(ctx, ep);
  const methods: string[] = [];
  let status: number | null = null;
  if (st.next_uri) {
    status = await client.del(st.next_uri);
    methods.push(`DELETE nextUri → HTTP ${status}`);
  }
  if ((status === null || status === 404 || status === 410) && st.engine_query_id) {
    status = await client.del(`/v1/query/${encodeURIComponent(st.engine_query_id)}`);
    methods.push(`DELETE /v1/query/{queryId} → HTTP ${status}`);
  }
  st.next_uri = null;
  st.cancel_requested_at = new Date().toISOString();
  st.cancelled_by_request = ctx.requestId;
  // confirm on the coordinator: USER_CANCELED (or the query finished first)
  let info: Record<string, any> | null = null;
  for (let i = 0; i < 10; i++) {
    info = st.engine_query_id ? await client.queryInfo(st.engine_query_id) : null;
    if (!info || ['FAILED', 'FINISHED'].includes(info.state)) break;
    await sleep(300, ctx.signal);
  }
  methods.push('GET /v1/query/{queryId}');
  if (info) absorbQueryInfo(st, info, '已发送取消请求');
  const confirmed = st.state === 'cancelled';
  if (confirmed) await finalize(client, st, methods);
  save(path, st);
  const ver = await version(client, st.trino_version);
  return {
    data: {
      query_id: st.query_id,
      previous_state: previous,
      state: confirmed ? 'cancelled' : terminal(st.state) ? st.state : 'cancel_requested',
      signal: status === null ? null : `HTTP DELETE (${status})`,
      app_id: null,
      engine_query_id: st.engine_query_id ?? null,
      engine_state: st.engine_state ?? null,
      confirmed,
    },
    sources: [trinoSource(ep, methods.join(' → '), ver)],
    coverage: {
      complete: true,
      scope: st.query_id,
      ...(confirmed ? {} : { notes: [`取消请求已发送，但协调节点尚未确认 USER_CANCELED（当前 ${st.engine_state ?? '未知'}）；用 sql query get 复核`] }),
    },
  };
}

// ---------------------------------------------------------------------------
// probe (auth status --probe)
// ---------------------------------------------------------------------------

export const trinoProbe: Probe = async (ctx, name) => {
  const ep = ctx.endpoint('trino', name);
  const client = new TrinoClient(ctx, ep);
  const info = await client.info();
  const auth = ep.str('password_ref') ? 'basic 认证（password_ref）' : '无密码，X-Trino-User 声明身份';
  return {
    ok: info.starting !== true,
    identity: `${ep.require('user')}（${auth}；/v1/info 不校验身份，授权由查询时的访问控制决定）`,
    version: info.version ?? undefined,
    detail: `${safeUrl(client.base.toString())} GET /v1/info：environment=${info.environment ?? '?'}，coordinator=${info.coordinator}，starting=${info.starting}，uptime=${info.uptime ?? '?'}；默认 catalog=${ep.str('catalog') ?? '(未设置)'}，schema=${ep.str('schema') ?? '(未设置)'}`,
  };
};
