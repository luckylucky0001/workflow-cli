import mysql from 'mysql2/promise';
import type { Connection, FieldPacket } from 'mysql2/promise';
import { source, WorkError, type Source } from '../../core/output';
import type { Ctx, Endpoint } from '../../core/runtime';

export const SYSTEM = 'mysql';
export const ADAPTER = 'mysql-driver';
export const AUTH_PROVIDER = 'database-profile';
export const GUIDE = 'docs/guides/mysql.md';

export type Row = Record<string, any>;

export interface MysqlSession {
  readonly ep: Endpoint;
  readonly conn: Connection;
  readonly version: string;
  readonly user: string;
  readonly threadId: number;
  query<T extends Row = Row>(sql: string, params?: unknown[], opts?: { timeoutMs?: number }): Promise<T[]>;
  queryWithFields(sql: string, params?: unknown[], opts?: { timeoutMs?: number; rowsAsArray?: boolean }): Promise<{ rows: any[]; fields: FieldPacket[] }>;
  /** Provenance entry for a call against this instance (never contains credentials). */
  src(method: string, relation?: Source['relation']): Source;
}

/** Driver error shape (mysql2 attaches these fields). */
interface DriverError extends Error {
  code?: string;
  errno?: number;
  sqlState?: string;
  sqlMessage?: string;
  fatal?: boolean;
}

function isDriverError(e: unknown): e is DriverError {
  if (!e || typeof e !== 'object') return false;
  const d = e as DriverError;
  // mysql2's client-side query timeout ("Query inactivity timeout") carries only code, no fatal flag
  return typeof d.sqlState === 'string' || typeof d.sqlMessage === 'string' || (typeof d.fatal === 'boolean' && typeof d.code === 'string') || d.code === 'PROTOCOL_SEQUENCE_TIMEOUT';
}

const PERMISSION_CODES = new Set([
  'ER_TABLEACCESS_DENIED_ERROR',
  'ER_COLUMNACCESS_DENIED_ERROR',
  'ER_SPECIFIC_ACCESS_DENIED_ERROR',
  'ER_DBACCESS_DENIED_ERROR',
  'ER_PROCACCESS_DENIED_ERROR',
  'ER_KILL_DENIED_ERROR',
]);
const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
  'PROTOCOL_CONNECTION_LOST',
  'ER_CON_COUNT_ERROR',
  'ER_USER_LIMIT_REACHED',
  'ER_SERVER_SHUTDOWN',
  'ER_SERVER_OFFLINE_MODE',
]);

/**
 * Map mysql2 driver errors to workctl error codes. MySQL's own semantics are kept in
 * `details` (errno / sqlState / server message) — never normalised away.
 */
export function mapMysqlError(e: unknown, ep?: Endpoint): WorkError | undefined {
  if (e instanceof WorkError) return e;
  if (!isDriverError(e)) return undefined;
  const code = e.code ?? '';
  const details: Record<string, unknown> = {
    ...(ep ? { endpoint: ep.id } : {}),
    driver_code: code || undefined,
    ...(e.errno !== undefined ? { errno: e.errno } : {}),
    ...(e.sqlState ? { sql_state: e.sqlState } : {}),
    reason: e.sqlMessage ?? e.message,
  };
  const where = ep ? ` (${ep.id})` : '';
  if (code === 'ER_ACCESS_DENIED_ERROR' || code === 'ER_ACCOUNT_HAS_BEEN_LOCKED' || code === 'ER_MUST_CHANGE_PASSWORD_LOGIN' || code === 'ER_NOT_SUPPORTED_AUTH_MODE') {
    return new WorkError('UNAUTHENTICATED', `MySQL 认证失败${where}: ${e.sqlMessage ?? e.message}`, {
      hint: '检查 profile 中的 user / password_ref，以及账号是否被锁定',
      details,
      cause: e,
    });
  }
  if (PERMISSION_CODES.has(code)) {
    return new WorkError('PERMISSION_DENIED', `MySQL 拒绝该操作${where}: ${e.sqlMessage ?? e.message}`, {
      hint: '账号已认证，但缺少所需权限；见 docs/guides/mysql.md 的权限前提',
      details,
      cause: e,
    });
  }
  if (code === 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION' || code === 'ER_OPTION_PREVENTS_STATEMENT') {
    return new WorkError('PERMISSION_DENIED', `只读事务/只读实例拒绝该语句${where}: ${e.sqlMessage ?? e.message}`, { details, cause: e });
  }
  if (code === 'ER_NO_SUCH_TABLE' || code === 'ER_BAD_DB_ERROR' || code === 'ER_BAD_TABLE_ERROR') {
    return new WorkError('NOT_FOUND', `MySQL 对象不存在${where}: ${e.sqlMessage ?? e.message}`, { details, cause: e });
  }
  if (code === 'ER_PARSE_ERROR' || code === 'ER_BAD_FIELD_ERROR' || code === 'ER_WRONG_ARGUMENTS' || code === 'ER_NOT_SUPPORTED_YET' || code === 'ER_WRONG_VALUE_COUNT_ON_ROW') {
    return new WorkError('INVALID_ARGUMENT', `MySQL 拒绝该语句${where}: ${e.sqlMessage ?? e.message}`, { details, cause: e });
  }
  if (code === 'ER_QUERY_TIMEOUT' || code === 'ER_QUERY_INTERRUPTED' || code === 'PROTOCOL_SEQUENCE_TIMEOUT') {
    return new WorkError('TIMEOUT', `语句超过执行时间上限${where}: ${e.sqlMessage ?? e.message}`, {
      hint: '缩小查询范围；执行上限由端点 max_execution_time_ms 与 --timeout 共同决定',
      details,
      cause: e,
    });
  }
  if (UNAVAILABLE_CODES.has(code) || e.fatal) {
    return new WorkError('UPSTREAM_UNAVAILABLE', `MySQL 不可达或连接中断${where}: ${e.message}`, { details, cause: e });
  }
  if (code === 'ER_LOCK_WAIT_TIMEOUT') {
    return new WorkError('TIMEOUT', `等待行锁超时${where}: ${e.sqlMessage ?? e.message}`, { hint: '用 workctl mysql lock list 查看阻塞方', details, cause: e });
  }
  // SQLSTATE classes 21/22/23/42: the statement itself is wrong for this schema/data
  if (e.sqlState && /^(21|22|23|42)/.test(e.sqlState)) {
    return new WorkError('INVALID_ARGUMENT', `MySQL 拒绝该语句${where}: ${e.sqlMessage ?? e.message}`, { details, cause: e });
  }
  return new WorkError('UPSTREAM_UNAVAILABLE', `MySQL 返回错误${where}: ${e.sqlMessage ?? e.message}`, { details, cause: e });
}

export function connectionOptions(ep: Endpoint, ctx: Ctx, database?: string): mysql.ConnectionOptions {
  const ssl = ep.bool('ssl', false);
  return {
    host: ep.require('host'),
    port: ep.num('port', 3306),
    user: ep.require('user'),
    password: ep.secret('password'),
    ...(database ? { database } : {}),
    connectTimeout: Math.min(10_000, ctx.remainingMs()),
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    dateStrings: true,
    timezone: 'Z',
    multipleStatements: false,
    connectAttributes: { program_name: 'workctl' },
    ...(ssl ? { ssl: { rejectUnauthorized: ep.bool('ssl_verify', true) } } : {}),
  };
}

/**
 * Open one connection for the duration of `fn`. Session time zone is forced to UTC so
 * TIMESTAMP columns (slow_log.start_time, FIRST_SEEN, ...) are unambiguous.
 */
export async function withMysql<T>(
  ctx: Ctx,
  instance: string | undefined,
  fn: (s: MysqlSession) => Promise<T>,
  opts: { database?: string } = {},
): Promise<T> {
  const ep = ctx.endpoint('mysql', instance);
  let conn: Connection;
  try {
    conn = await mysql.createConnection(connectionOptions(ep, ctx, opts.database));
  } catch (e) {
    throw mapMysqlError(e, ep) ?? e;
  }
  // a fatal error after connect must not crash the process
  conn.on('error', () => undefined);
  const run = async (sql: string, params: unknown[] | undefined, timeoutMs: number | undefined, rowsAsArray: boolean) => {
    try {
      const [rows, fields] = await conn.query({ sql, values: params, timeout: Math.max(1, Math.min(timeoutMs ?? Infinity, ctx.remainingMs())), rowsAsArray });
      return { rows: rows as any[], fields: (fields ?? []) as FieldPacket[] };
    } catch (e) {
      throw mapMysqlError(e, ep) ?? e;
    }
  };
  try {
    await run("SET time_zone = '+00:00'", undefined, undefined, false);
    const [info] = (await run('SELECT VERSION() AS version, CURRENT_USER() AS user, CONNECTION_ID() AS thread_id', undefined, undefined, false)).rows as Row[];
    const session: MysqlSession = {
      ep,
      conn,
      version: String(info.version),
      user: String(info.user),
      threadId: Number(info.thread_id),
      query: async <R extends Row = Row>(sql: string, params?: unknown[], o?: { timeoutMs?: number }) => (await run(sql, params, o?.timeoutMs, false)).rows as R[],
      queryWithFields: (sql, params, o) => run(sql, params, o?.timeoutMs, o?.rowsAsArray ?? false),
      src: (method, relation = 'explicit') => source(SYSTEM, ADAPTER, { endpoint: ep.id, method, version: String(info.version), relation }),
    };
    return await fn(session);
  } finally {
    try {
      await Promise.race([conn.end(), new Promise((r) => setTimeout(r, 1000).unref?.())]);
    } catch {
      /* already closed (e.g. row cap reached) */
    }
    conn.destroy();
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

/** MySQL TIMESTAMP/DATETIME string (session tz UTC) → ISO 8601. */
export function isoFromMysql(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s)) return `${s.replace(' ', 'T')}Z`;
  return s;
}

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Identifier check for names we interpolate into DDL text (quoted with backticks anyway). */
export function assertIdentifier(kind: string, v: string): string {
  if (!/^[A-Za-z0-9_$]{1,64}$/.test(v)) {
    throw new WorkError('INVALID_ARGUMENT', `${kind} 名称不合法: ${v}`, { hint: '仅支持字母、数字、_ 和 $，长度 1–64' });
  }
  return v;
}

export function quoteId(v: string): string {
  return `\`${v.replace(/`/g, '``')}\``;
}

/** Fetch GLOBAL variables as a name→value map (lower-case names). */
export async function globalVariables(s: MysqlSession, names: string[]): Promise<Record<string, string>> {
  const rows = await s.query(`SHOW GLOBAL VARIABLES WHERE Variable_name IN (${names.map(() => '?').join(',')})`, names);
  return Object.fromEntries(rows.map((r) => [String(r.Variable_name).toLowerCase(), String(r.Value)]));
}

export async function globalStatus(s: MysqlSession, names: string[]): Promise<Record<string, string>> {
  const rows = await s.query(`SHOW GLOBAL STATUS WHERE Variable_name IN (${names.map(() => '?').join(',')})`, names);
  return Object.fromEntries(rows.map((r) => [String(r.Variable_name), String(r.Value)]));
}

/** Sensitive column names configured on the endpoint (lower-cased). */
export function sensitiveColumns(ep: Endpoint): Set<string> {
  const v = ep.obj<unknown>('sensitive_columns');
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  return new Set(list.map((x) => String(x).trim().toLowerCase()).filter(Boolean));
}

/**
 * Distinguish "table does not exist" from "no privilege" — information_schema hides tables
 * the account cannot access, so an empty metadata result alone is ambiguous.
 */
export async function assertTableAccessible(s: MysqlSession, database: string, table: string): Promise<void> {
  try {
    await s.query(`SELECT 1 FROM ${quoteId(database)}.${quoteId(table)} LIMIT 0`);
  } catch (e) {
    if (e instanceof WorkError && e.code === 'NOT_FOUND') {
      throw new WorkError('NOT_FOUND', `表不存在: ${database}.${table}`, { hint: '用 workctl mysql query execute 执行 SHOW TABLES 查看可见表', details: e.details });
    }
    if (e instanceof WorkError && e.code === 'PERMISSION_DENIED') {
      throw new WorkError('PERMISSION_DENIED', `账号 ${s.user} 无权访问 ${database}.${table}（无法确认表是否存在）`, { details: e.details });
    }
    throw e;
  }
}
