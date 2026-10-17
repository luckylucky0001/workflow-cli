/**
 * Trino client protocol (HTTP, no driver): POST /v1/statement, then follow `nextUri` until it
 * disappears. Every page may carry columns, data, stats and error; a query only finishes once
 * the client has consumed all result pages. `DELETE nextUri` (or DELETE /v1/query/{id}) cancels.
 * See https://trino.io/docs/current/develop/client-protocol.html
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { httpJson, basicAuth } from '../../core/http';
import { WorkError, type ErrorCode } from '../../core/output';
import { sleep, type Ctx, type Endpoint } from '../../core/runtime';

export const TRINO_ADAPTER = 'trino-http';

/** Trino states before execution starts (the query is accepted but not yet running). */
const PRE_RUN = new Set(['QUEUED', 'WAITING_FOR_RESOURCES', 'DISPATCHING', 'PLANNING']);
const IDENT_RE = /^[A-Za-z0-9_][A-Za-z0-9_\-]*$/;

export interface TrinoQueryResults {
  id: string;
  infoUri?: string;
  nextUri?: string;
  partialCancelUri?: string;
  columns?: Array<{ name: string; type: string }>;
  data?: unknown[][];
  stats?: Record<string, any>;
  error?: TrinoError;
  updateType?: string;
}

export interface TrinoError {
  message?: string;
  sqlState?: string;
  errorCode?: number;
  errorName?: string;
  errorType?: string;
  errorLocation?: { lineNumber?: number; columnNumber?: number };
  failureInfo?: { type?: string; message?: string };
}

export interface StoredError {
  type: string;
  message: string;
  error_type?: string;
  error_code?: number;
  sql_state?: string;
  line?: number;
  column?: number;
  code?: string;
}

// ---------------------------------------------------------------------------
// error classification
// ---------------------------------------------------------------------------

const NOT_FOUND_NAMES = new Set(['CATALOG_NOT_FOUND', 'SCHEMA_NOT_FOUND', 'TABLE_NOT_FOUND', 'MISSING_CATALOG_NAME', 'MISSING_SCHEMA_NAME']);

/** Map a Trino QueryError (errorName / errorType) to a workctl error code. */
export function classifyTrinoError(e: { errorName?: string; errorType?: string }): ErrorCode {
  const name = e.errorName ?? '';
  const type = e.errorType ?? '';
  if (name === 'PERMISSION_DENIED' || name === 'ACCESS_DENIED' || name.endsWith('ACCESS_DENIED')) return 'PERMISSION_DENIED';
  if (NOT_FOUND_NAMES.has(name)) return 'NOT_FOUND';
  if (name === 'EXCEEDED_TIME_LIMIT' || name === 'ABANDONED_QUERY') return 'TIMEOUT';
  if (type === 'USER_ERROR') return 'INVALID_ARGUMENT';
  if (type === 'INSUFFICIENT_RESOURCES' || type === 'INTERNAL_ERROR' || type === 'EXTERNAL') return 'UPSTREAM_UNAVAILABLE';
  return 'UPSTREAM_UNAVAILABLE';
}

export function storedError(e: TrinoError): StoredError {
  return {
    type: e.errorName ?? e.failureInfo?.type ?? 'UNKNOWN',
    message: (e.message ?? e.failureInfo?.message ?? '(Trino 未返回错误信息)').slice(0, 2000),
    ...(e.errorType ? { error_type: e.errorType } : {}),
    ...(typeof e.errorCode === 'number' ? { error_code: e.errorCode } : {}),
    ...(e.sqlState ? { sql_state: e.sqlState } : {}),
    ...(e.errorLocation?.lineNumber ? { line: e.errorLocation.lineNumber } : {}),
    ...(e.errorLocation?.columnNumber ? { column: e.errorLocation.columnNumber } : {}),
    // a cancelled query is a business state, not an error class
    ...(e.errorName === 'USER_CANCELED' ? {} : { code: classifyTrinoError(e) }),
  };
}

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

export interface QueryStats {
  elapsed_ms: number | null;
  queued_ms: number | null;
  cpu_ms: number | null;
  wall_ms: number | null;
  processed_rows: number | null;
  processed_bytes: number | null;
  physical_input_bytes: number | null;
  peak_memory_bytes: number | null;
  spilled_bytes: number | null;
  completed_splits: number | null;
  total_splits: number | null;
  nodes: number | null;
  progress_pct: number | null;
  source: 'statement' | 'query-info';
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Stats object of a QueryResults page (StatementStats). */
export function statementStats(s: Record<string, any> | undefined): QueryStats | null {
  if (!s) return null;
  return {
    elapsed_ms: num(s.elapsedTimeMillis),
    queued_ms: num(s.queuedTimeMillis),
    cpu_ms: num(s.cpuTimeMillis),
    wall_ms: num(s.wallTimeMillis),
    processed_rows: num(s.processedRows),
    processed_bytes: num(s.processedBytes),
    physical_input_bytes: num(s.physicalInputBytes),
    peak_memory_bytes: num(s.peakMemoryBytes),
    spilled_bytes: num(s.spilledBytes),
    completed_splits: num(s.completedSplits),
    total_splits: num(s.totalSplits),
    nodes: num(s.nodes),
    progress_pct: num(s.progressPercentage),
    source: 'statement',
  };
}

const DURATION_UNITS: Record<string, number> = { ns: 1e-6, us: 1e-3, ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const SIZE_UNITS: Record<string, number> = { B: 1, kB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4, PB: 1024 ** 5 };

/** airlift Duration string ("1.23s", "456.00ms") → ms. */
export function parseTrinoDuration(v: unknown): number | null {
  const m = /^([\d.]+)\s*(ns|us|ms|s|m|h|d)$/.exec(String(v ?? '').trim());
  return m ? Math.round(Number(m[1]) * DURATION_UNITS[m[2]] * 1000) / 1000 : null;
}

/** airlift DataSize string ("12.5kB", "3MB", "0B") → bytes. */
export function parseTrinoDataSize(v: unknown): number | null {
  const m = /^([\d.]+)\s*(B|kB|MB|GB|TB|PB)$/.exec(String(v ?? '').trim());
  return m ? Math.round(Number(m[1]) * SIZE_UNITS[m[2]]) : null;
}

/** queryStats of GET /v1/query/{id} (QueryInfo). Durations/sizes are airlift strings. */
export function queryInfoStats(q: Record<string, any> | undefined): QueryStats | null {
  if (!q) return null;
  return {
    elapsed_ms: parseTrinoDuration(q.elapsedTime),
    queued_ms: parseTrinoDuration(q.queuedTime),
    cpu_ms: parseTrinoDuration(q.totalCpuTime),
    wall_ms: null,
    processed_rows: num(q.processedInputPositions),
    processed_bytes: parseTrinoDataSize(q.processedInputDataSize),
    physical_input_bytes: parseTrinoDataSize(q.physicalInputDataSize),
    peak_memory_bytes: parseTrinoDataSize(q.peakUserMemoryReservation),
    spilled_bytes: parseTrinoDataSize(q.spilledDataSize),
    completed_splits: num(q.completedDrivers),
    total_splits: num(q.totalDrivers),
    nodes: null,
    progress_pct: num(q.progressPercentage),
    source: 'query-info',
  };
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

export class TrinoClient {
  readonly base: URL;

  constructor(
    private readonly ctx: Ctx,
    readonly ep: Endpoint,
  ) {
    this.base = new URL(ep.require('url'));
  }

  private headers(extra: { catalog?: string; schema?: string } = {}): Record<string, string> {
    const h: Record<string, string> = {
      'x-trino-user': this.ep.require('user'),
      'x-trino-source': this.ep.str('source', 'workctl'),
      'user-agent': 'workctl',
    };
    const catalog = extra.catalog ?? this.ep.str('catalog');
    const schema = extra.schema ?? this.ep.str('schema');
    for (const [k, v] of [['catalog', catalog], ['schema', schema]] as const) {
      if (v === undefined) continue;
      if (!IDENT_RE.test(v)) throw new WorkError('INVALID_ARGUMENT', `Trino ${k} 名称不合法: ${v}`);
      h[`x-trino-${k}`] = v;
    }
    const password = this.ep.secret('password');
    if (password !== undefined) h.authorization = basicAuth(this.ep.require('user'), password);
    return h;
  }

  /** Follow only the configured coordinator: nextUri/infoUri are re-based on `url` so credentials never leave it. */
  rebase(uri: string): string {
    const u = new URL(uri, this.base);
    return new URL(`${u.pathname}${u.search}`, this.base).toString();
  }

  private timeout(): number {
    return Math.max(1000, Math.min(15_000, this.ctx.remainingMs() - 500));
  }

  async info(): Promise<{ version: string | null; environment: string | null; coordinator: boolean | null; starting: boolean | null; uptime: string | null }> {
    const r = await httpJson<any>(this.ctx, this.rebase('/v1/info'), { headers: this.headers(), timeoutMs: this.timeout() });
    const b = r.body ?? {};
    return { version: b.nodeVersion?.version ?? null, environment: b.environment ?? null, coordinator: b.coordinator ?? null, starting: b.starting ?? null, uptime: b.uptime ?? null };
  }

  async submit(sql: string, opts: { catalog?: string; schema?: string }): Promise<TrinoQueryResults> {
    const r = await httpJson<TrinoQueryResults>(this.ctx, this.rebase('/v1/statement'), {
      method: 'POST',
      headers: { ...this.headers(opts), 'content-type': 'text/plain; charset=utf-8' },
      body: sql,
      timeoutMs: this.timeout(),
    });
    if (!r.body || typeof r.body !== 'object' || !(r.body as TrinoQueryResults).id) {
      throw new WorkError('UPSTREAM_UNAVAILABLE', 'Trino 返回的不是 QueryResults（缺少 id）', { details: { status: r.status, body: r.text.slice(0, 300) } });
    }
    return r.body;
  }

  /** GET nextUri. 404/410 → null (the query or the page token no longer exists). 502/503/504 are retried as the protocol requires. */
  async next(nextUri: string): Promise<TrinoQueryResults | null> {
    for (let attempt = 0; ; attempt++) {
      const r = await httpJson<TrinoQueryResults>(this.ctx, this.rebase(nextUri), { headers: this.headers(), allowStatus: [404, 410, 502, 503, 504], timeoutMs: this.timeout() });
      if (r.status === 404 || r.status === 410) return null;
      if (r.status >= 500) {
        if (attempt >= 4) throw new WorkError('UPSTREAM_UNAVAILABLE', `Trino 结果页返回 HTTP ${r.status}（已重试 ${attempt} 次）`);
        await sleep(100 * 2 ** attempt, this.ctx.signal);
        continue;
      }
      return r.body;
    }
  }

  /** GET /v1/query/{id} (coordinator QueryInfo); null when the coordinator no longer knows the query. */
  async queryInfo(queryId: string): Promise<Record<string, any> | null> {
    const r = await httpJson<Record<string, any>>(this.ctx, this.rebase(`/v1/query/${encodeURIComponent(queryId)}`), { headers: this.headers(), allowStatus: [404, 410], timeoutMs: this.timeout() });
    return r.status === 404 || r.status === 410 ? null : r.body;
  }

  /** DELETE on nextUri or /v1/query/{id}; returns the HTTP status. */
  async del(uri: string): Promise<number> {
    const r = await httpJson(this.ctx, this.rebase(uri), { method: 'DELETE', headers: this.headers(), allowStatus: [404, 410], timeoutMs: this.timeout() });
    return r.status;
  }
}

// ---------------------------------------------------------------------------
// page absorption (state machine)
// ---------------------------------------------------------------------------

export type WorkState = 'submitted' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'lost';

/** Column names usable as record keys (Trino allows duplicates such as `SELECT a.x, b.x`). */
export function recordKeys(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const c = (seen.get(n) ?? 0) + 1;
    seen.set(n, c);
    return c === 1 ? n : `${n}#${c}`;
  });
}

/**
 * Fold one QueryResults page into the stored state. Rows go to the JSON-lines result file
 * (up to max_result_rows) and the first `preview_limit` rows into the preview.
 * Returns true when the result limit was hit and the caller must cancel the query.
 */
export function absorbPage(st: Record<string, any>, page: TrinoQueryResults, resultFile: string | null): { limitHit: boolean } {
  st.engine_query_id = page.id;
  if (page.infoUri) st.info_uri = page.infoUri;
  st.next_uri = page.nextUri ?? null;
  if (page.columns && !st.columns) {
    st.columns = page.columns.map((c) => c.name);
    st.column_types = page.columns.map((c) => c.type);
  }
  const stats = statementStats(page.stats);
  if (stats) st.stats = stats;
  const engineState = page.stats?.state as string | undefined;
  if (engineState) st.engine_state = engineState;
  let limitHit = false;
  if (Array.isArray(page.data) && page.data.length) {
    const keys = recordKeys(st.columns ?? page.data[0].map((_, i) => `_col${i}`));
    const max = Number(st.max_result_rows ?? Infinity);
    const previewLimit = Number(st.preview_limit ?? 20);
    st.preview ??= [];
    st.row_count ??= 0;
    const lines: string[] = [];
    for (const row of page.data) {
      if (st.row_count >= max) {
        limitHit = true;
        break;
      }
      const rec = Object.fromEntries(keys.map((k, i) => [k, row[i]]));
      if (st.preview.length < previewLimit) st.preview.push(rec);
      lines.push(JSON.stringify(rec));
      st.row_count++;
    }
    if (resultFile && lines.length) appendFileSync(resultFile, lines.join('\n') + '\n');
  }
  if (page.columns && st.row_count === undefined) st.row_count = 0;
  if (page.error) {
    st.error = storedError(page.error);
    st.state = page.error.errorName === 'USER_CANCELED' ? 'cancelled' : 'failed';
    st.next_uri = null;
  } else if (!page.nextUri) {
    // no nextUri and no error: Trino has delivered every page
    st.state = engineState === 'FAILED' ? 'failed' : 'succeeded';
    st.row_count ??= 0;
  } else {
    st.state = engineState && PRE_RUN.has(engineState) ? 'submitted' : 'running';
  }
  if (limitHit) {
    st.state = 'failed';
    st.error = { type: 'RESULT_LIMIT_EXCEEDED', message: `结果超过 max_result_rows=${st.max_result_rows} 行，workctl 已取消查询；结果目录只保留前 ${st.row_count} 行`, code: 'PRECONDITION_FAILED' };
  }
  st.preview_truncated = typeof st.row_count === 'number' && Array.isArray(st.preview) && st.row_count > st.preview.length;
  return { limitHit };
}

/** Before execution (QUEUED…PLANNING): the window in which parse/analysis errors surface. */
export function preRun(st: Record<string, any>): boolean {
  return st.state === 'submitted' && (!st.engine_state || PRE_RUN.has(st.engine_state));
}

export function terminal(state: string): boolean {
  return ['succeeded', 'failed', 'cancelled', 'lost'].includes(state);
}

/** Fold GET /v1/query/{id} into the state when no nextUri can be followed any more. */
export function absorbQueryInfo(st: Record<string, any>, info: Record<string, any> | null, why: string): void {
  if (!info) {
    st.state = 'lost';
    st.lost_basis = `${why}，且协调节点 /v1/query/{id} 已不记得该查询（超过 query.min-expire-age 被清理，或协调节点重启）`;
    st.next_uri = null;
    return;
  }
  st.engine_state = info.state ?? st.engine_state;
  const stats = queryInfoStats(info.queryStats);
  if (stats) st.stats = stats;
  if (info.queryStats?.executionStartTime) st.started_at = info.queryStats.executionStartTime;
  if (info.queryStats?.endTime) st.finished_at = info.queryStats.endTime;
  if (info.state === 'FAILED') {
    const ec = info.errorCode ?? {};
    st.error = storedError({ errorName: ec.name, errorType: ec.type, errorCode: ec.code, message: info.failureInfo?.message, failureInfo: info.failureInfo });
    st.state = ec.name === 'USER_CANCELED' ? 'cancelled' : 'failed';
    st.next_uri = null;
  } else if (info.state === 'FINISHED') {
    // finished on the coordinator, but this client could not fetch the remaining pages
    st.state = 'lost';
    st.lost_basis = `${why}；Trino 报告 FINISHED，但 workctl 没有取完结果页，结果不完整`;
    st.next_uri = null;
  } else {
    st.state = PRE_RUN.has(String(info.state)) ? 'submitted' : 'running';
  }
}

// ---------------------------------------------------------------------------
// per-query lock (two concurrent `get` calls must not consume the same page token twice)
// ---------------------------------------------------------------------------

export async function withQueryLock<T>(statePath: string, ctx: Ctx, fn: () => Promise<T>, onBusy: () => T): Promise<T> {
  const lock = `${statePath}.lock`;
  for (let i = 0; ; i++) {
    try {
      closeSync(openSync(lock, 'wx'));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let stale = false;
      try {
        stale = Date.now() - statSync(lock).mtimeMs > 120_000;
      } catch {
        stale = true;
      }
      if (stale) {
        rmSync(lock, { force: true });
        continue;
      }
      if (i >= 10) return onBusy();
      await sleep(200, ctx.signal);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

export function resultFileFor(resultDir: string): string {
  mkdirSync(resultDir, { recursive: true });
  const f = join(resultDir, 'part-00000.json');
  if (!existsSync(f)) closeSync(openSync(f, 'a'));
  return f;
}
