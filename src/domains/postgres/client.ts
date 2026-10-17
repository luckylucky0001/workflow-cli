import pg from 'pg';
import { source, WorkError, type Source } from '../../core/output';
import type { Ctx, Endpoint } from '../../core/runtime';

export const SYSTEM = 'postgresql';
export const ADAPTER = 'pg-driver';
export const AUTH_PROVIDER = 'database-profile';
export const GUIDE = 'docs/guides/postgres.md';
export const ENDPOINT_KIND = 'postgres';
const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;

export type Row = Record<string, any>;

export interface PgField {
  name: string;
  tableID: number;
  columnID: number;
  dataTypeID: number;
}

export interface PgSession {
  readonly ep: Endpoint;
  readonly client: pg.Client;
  /** server_version (e.g. "16.15"). */
  readonly version: string;
  readonly versionNum: number;
  readonly user: string;
  readonly database: string;
  readonly pid: number;
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  queryArrays(sql: string, params?: unknown[]): Promise<{ rows: unknown[][]; fields: PgField[] }>;
  /** Provenance entry for a call against this instance (never contains credentials). */
  src(method: string, relation?: Source['relation']): Source;
}

/** Driver error shape (node-postgres DatabaseError). */
interface DriverError extends Error {
  code?: string;
  severity?: string;
  detail?: string;
  hint?: string;
  routine?: string;
}

function isDbError(e: unknown): e is DriverError {
  if (!e || typeof e !== 'object') return false;
  const d = e as DriverError;
  return typeof d.code === 'string' && /^[0-9A-Z]{5}$/.test(d.code) && typeof d.severity === 'string';
}

const NET_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH']);

/**
 * Map node-postgres errors to workctl error codes. PostgreSQL's own semantics (SQLSTATE,
 * severity, server message/detail/hint) are kept in `details` — never normalised away.
 */
export function mapPgError(e: unknown, ep?: Endpoint): WorkError | undefined {
  if (e instanceof WorkError) return e;
  const where = ep ? ` (${ep.id})` : '';
  if (isDbError(e)) {
    const code = e.code!;
    const details: Record<string, unknown> = {
      ...(ep ? { endpoint: ep.id } : {}),
      sql_state: code,
      severity: e.severity,
      reason: e.message,
      ...(e.detail ? { server_detail: e.detail } : {}),
      ...(e.hint ? { server_hint: e.hint } : {}),
    };
    const msg = e.message;
    if (code === '28P01' || code === '28000') {
      return new WorkError('UNAUTHENTICATED', `PostgreSQL 认证失败${where}: ${msg}`, { hint: '检查 profile 中的 user / password_ref，以及角色是否有 LOGIN 与 pg_hba.conf 规则', details, cause: e });
    }
    if (code === '42501') {
      return new WorkError('PERMISSION_DENIED', `PostgreSQL 拒绝该操作${where}: ${msg}`, { hint: '角色已认证，但缺少所需权限；见 docs/guides/postgres.md 的权限前提', details, cause: e });
    }
    if (code === '25006') {
      return new WorkError('PERMISSION_DENIED', `只读事务拒绝该语句${where}: ${msg}`, { hint: 'workctl 的查询在 READ ONLY 事务中执行；写操作不在本工具范围内', details, cause: e });
    }
    if (code === '42P01' || code === '3D000' || code === '3F000' || code === '42704') {
      return new WorkError('NOT_FOUND', `PostgreSQL 对象不存在${where}: ${msg}`, { details, cause: e });
    }
    if (code === '57014') {
      return new WorkError('TIMEOUT', `语句超过执行时间上限或被取消${where}: ${msg}`, { hint: '缩小查询范围；上限由端点 statement_timeout_ms 与 --timeout 共同决定', details, cause: e });
    }
    if (code === '55P03') {
      return new WorkError('TIMEOUT', `等待锁超时${where}: ${msg}`, { hint: '用 workctl pg lock list 查看阻塞方', details, cause: e });
    }
    if (code === '55000' && /pg_stat_statements/.test(msg)) {
      return new WorkError('COLLECTION_DISABLED', `pg_stat_statements 未加载${where}: ${msg}`, {
        hint: "在 postgresql.conf 设置 shared_preload_libraries='pg_stat_statements' 并重启实例；这不代表“没有慢语句”",
        details,
        cause: e,
      });
    }
    if (code === '53300' || code === '57P01' || code === '57P02' || code === '57P03' || code.startsWith('08') || code === '53000' || code === '58000') {
      return new WorkError('UPSTREAM_UNAVAILABLE', `PostgreSQL 不可用或连接被拒绝${where}: ${msg}`, { details, cause: e });
    }
    // classes 21/22/23/42 (and 0A feature_not_supported, 2B/34 cursor issues): the statement is wrong for this schema/data
    if (/^(21|22|23|42|0A|34)/.test(code)) {
      return new WorkError('INVALID_ARGUMENT', `PostgreSQL 拒绝该语句${where}: ${msg}`, { details, cause: e });
    }
    return new WorkError('UPSTREAM_UNAVAILABLE', `PostgreSQL 返回错误${where}: ${msg}`, { details, cause: e });
  }
  if (!e || typeof e !== 'object') return undefined;
  const err = e as Error & { code?: string };
  const message = String(err.message ?? '');
  if (err.code && NET_CODES.has(err.code)) {
    return new WorkError('UPSTREAM_UNAVAILABLE', `PostgreSQL 不可达${where}: ${message}`, { details: { ...(ep ? { endpoint: ep.id } : {}), driver_code: err.code }, cause: e });
  }
  if (/SASL|client password must be a string|password authentication/i.test(message)) {
    return new WorkError('UNAUTHENTICATED', `PostgreSQL 认证失败${where}: ${message}`, { hint: '检查 profile 中的 password_ref 是否配置且可读', details: ep ? { endpoint: ep.id } : undefined, cause: e });
  }
  if (/timeout exceeded when trying to connect|connection timeout|Query read timeout/i.test(message)) {
    return new WorkError('TIMEOUT', `PostgreSQL 连接或查询超时${where}: ${message}`, { details: ep ? { endpoint: ep.id } : undefined, cause: e });
  }
  if (/Connection terminated|terminating connection|Client was closed|not queryable/i.test(message)) {
    return new WorkError('UPSTREAM_UNAVAILABLE', `PostgreSQL 连接中断${where}: ${message}`, { details: ep ? { endpoint: ep.id } : undefined, cause: e });
  }
  return undefined;
}

/** Date/time types are returned as server text (session TimeZone=UTC), never re-interpreted locally. */
const RAW_TEXT_TYPES = new Set([1082, 1083, 1114, 1184, 1266, 1186]);
const typeParsers = {
  getTypeParser: ((oid: number, format?: any) => {
    if (RAW_TEXT_TYPES.has(oid)) return (v: string) => v;
    return (pg.types.getTypeParser as any)(oid, format);
  }) as any,
};

export function endpointStatementTimeout(ep: Endpoint): number {
  return Math.max(100, Math.floor(ep.num('statement_timeout_ms', DEFAULT_STATEMENT_TIMEOUT_MS) ?? DEFAULT_STATEMENT_TIMEOUT_MS));
}

export function clientConfig(ep: Endpoint, ctx: Ctx, database?: string): pg.ClientConfig {
  const ssl = ep.bool('ssl', false);
  const password = ep.secret('password');
  return {
    host: ep.require('host'),
    port: ep.num('port', 5432),
    user: ep.require('user'),
    ...(password !== undefined ? { password } : {}),
    database: database ?? ep.str('database') ?? 'postgres',
    connectionTimeoutMillis: Math.max(1, Math.min(10_000, ctx.remainingMs())),
    statement_timeout: Math.max(1, Math.min(endpointStatementTimeout(ep), ctx.remainingMs())),
    query_timeout: Math.max(1, ctx.remainingMs()),
    application_name: 'workctl',
    options: '-c TimeZone=UTC',
    types: typeParsers,
    ...(ssl ? { ssl: { rejectUnauthorized: ep.bool('ssl_verify', true) } } : {}),
  };
}

/** Open one connection (to `database`, default: endpoint `database` or `postgres`) for the duration of `fn`. */
export async function withPg<T>(ctx: Ctx, instance: string | undefined, fn: (s: PgSession) => Promise<T>, opts: { database?: string } = {}): Promise<T> {
  const ep = ctx.endpoint(ENDPOINT_KIND, instance);
  const client = new pg.Client(clientConfig(ep, ctx, opts.database));
  // an error after connect (server restart, admin termination) must not crash the process
  client.on('error', () => undefined);
  try {
    await client.connect();
  } catch (e) {
    try {
      await client.end();
    } catch {
      /* ignore */
    }
    const mapped = mapPgError(e, ep);
    if (mapped?.code === 'NOT_FOUND') {
      throw new WorkError('NOT_FOUND', `数据库不存在: ${opts.database ?? ep.str('database') ?? 'postgres'}${` (${ep.id})`}`, { hint: '用 workctl pg database list 查看可见的库', details: mapped.details });
    }
    throw mapped ?? e;
  }
  const run = async (sql: string, params: unknown[] | undefined, rowMode?: 'array') => {
    try {
      return await client.query({ text: sql, values: params as any[] | undefined, ...(rowMode ? { rowMode } : {}) });
    } catch (e) {
      throw mapPgError(e, ep) ?? e;
    }
  };
  try {
    const info = (
      await run(
        "SELECT current_setting('server_version') AS version, current_setting('server_version_num')::int AS version_num, current_user AS usr, current_database() AS db, pg_backend_pid() AS pid",
        undefined,
      )
    ).rows[0];
    const version = String(info.version);
    const session: PgSession = {
      ep,
      client,
      version,
      versionNum: Number(info.version_num),
      user: String(info.usr),
      database: String(info.db),
      pid: Number(info.pid),
      query: async <R extends Row = Row>(sql: string, params?: unknown[]) => (await run(sql, params)).rows as R[],
      queryArrays: async (sql, params) => {
        const r = await run(sql, params, 'array');
        return { rows: r.rows as unknown[][], fields: (r.fields ?? []) as unknown as PgField[] };
      },
      src: (method, relation = 'explicit') => source(SYSTEM, ADAPTER, { endpoint: ep.id, method, version, relation }),
    };
    return await fn(session);
  } finally {
    try {
      await Promise.race([client.end(), new Promise((r) => setTimeout(r, 1000).unref?.())]);
    } catch {
      /* already closed */
    }
  }
}

/** Binding metadata (platform side), kept separate from what the engine reports. */
export function bindingFor(ctx: Ctx, kind: string, name: string): { binding: Record<string, unknown> | null; source: Source | null } {
  let store;
  try {
    store = ctx.resources();
  } catch (e) {
    ctx.warn(`资源绑定不可读，跳过平台元数据: ${e instanceof Error ? e.message : String(e)}`);
    return { binding: null, source: null };
  }
  const r = store.forEndpoint(kind, name);
  if (!r) return { binding: null, source: null };
  return {
    binding: { id: r.id, type: r.type, env: r.env ?? null, owner: r.owner ?? null, labels: r.labels, attributes: r.attributes },
    source: source('workctl', 'binding-file', { endpoint: store.path ?? undefined, method: `resources.forEndpoint(${kind}, ${name})`, relation: 'explicit' }),
  };
}

/** PostgreSQL timestamptz text (session TimeZone=UTC) → ISO 8601. */
export function isoFromPg(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)\+00(?::00)?$/.exec(s);
  if (m) return `${m[1]}T${m[2]}Z`;
  return s;
}

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Identifier check for names passed as parameters (also guards obvious typos). */
export function assertIdentifier(kind: string, v: string): string {
  if (!/^[^\u0000]{1,63}$/.test(v)) {
    throw new WorkError('INVALID_ARGUMENT', `${kind} 名称不合法: ${v}`, { hint: '长度 1–63，按 PostgreSQL 实际（区分大小写的）对象名给出，不要加双引号' });
  }
  return v;
}

/** Sensitive column names configured on the endpoint (lower-cased). */
export function sensitiveColumns(ep: Endpoint): Set<string> {
  const v = ep.obj<unknown>('sensitive_columns');
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  return new Set(list.map((x) => String(x).trim().toLowerCase()).filter(Boolean));
}

/** Whether the role can see other roles' activity / statement text (pg_read_all_stats or superuser). */
export async function statsVisibility(s: PgSession): Promise<{ all: boolean; superuser: boolean }> {
  const [r] = await s.query(
    "SELECT r.rolsuper AS superuser, pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') AS read_all_stats FROM pg_roles r WHERE r.rolname = current_user",
  );
  const superuser = r?.superuser === true;
  return { all: superuser || r?.read_all_stats === true, superuser };
}

