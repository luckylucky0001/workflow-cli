import Redis from 'ioredis';
import { source, WorkError, type Source } from '../../core/output';
import type { Ctx, Endpoint } from '../../core/runtime';
import { parseInfo } from './info';

export const SYSTEM = 'redis';
export const ADAPTER = 'redis-client';
export const AUTH_PROVIDER = 'redis-profile';
export const GUIDE = 'docs/guides/redis.md';

export interface RedisSession {
  readonly ep: Endpoint;
  readonly client: Redis;
  /** redis_version from INFO server (fetched lazily, cached). */
  version(): Promise<string | undefined>;
  /** Run a raw command; errors are mapped to WorkError. */
  cmd<T = unknown>(name: string, ...args: (string | number | Buffer)[]): Promise<T>;
  /** Map an error from this connection (prefers an earlier connection-level reply error such as WRONGPASS). */
  fail(e: unknown): unknown;
  src(method: string, relation?: Source['relation']): Promise<Source>;
}

interface ReplyLike extends Error {
  code?: string;
  command?: { name: string };
}

function isRedisError(e: unknown): e is ReplyLike {
  if (!e || typeof e !== 'object') return false;
  const x = e as ReplyLike;
  return x.name === 'ReplyError' || x.name === 'MaxRetriesPerRequestError' || /^(NOPERM|NOAUTH|WRONGPASS|WRONGTYPE|ERR |LOADING|BUSY|READONLY|MOVED|ASK|CLUSTERDOWN|OOM)/.test(x.message ?? '') || x.message === 'Connection is closed.';
}

/** Errors that certainly come from ioredis / a Redis reply (safe for the domain-wide mapper). */
export function isRedisOriginError(e: unknown): boolean {
  const name = (e as Error | undefined)?.name;
  return name === 'ReplyError' || name === 'MaxRetriesPerRequestError';
}

/**
 * Map ioredis / Redis reply errors. Redis semantics are kept in details.reason. Used inside
 * withRedis (where every error is Redis-related); the domain-wide mapper only passes errors
 * for which isRedisOriginError() is true.
 */
export function mapRedisError(e: unknown, ep?: Endpoint): WorkError | undefined {
  if (e instanceof WorkError) return e;
  const err = e as ReplyLike & { errno?: number; syscall?: string };
  const msg = err?.message ?? String(e);
  const where = ep ? ` (${ep.id})` : '';
  const details = { ...(ep ? { endpoint: ep.id } : {}), reason: msg, ...(err?.code ? { driver_code: err.code } : {}) };
  const code = err?.code ?? '';
  if (['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE'].includes(code)) {
    return new WorkError('UPSTREAM_UNAVAILABLE', `Redis 不可达${where}: ${msg}`, { details, cause: e });
  }
  if (!isRedisError(e) && !/connect|Connection|timed out|isn't writeable/i.test(msg)) return undefined;
  if (/^NOPERM/.test(msg)) {
    return new WorkError('PERMISSION_DENIED', `Redis ACL 拒绝该命令${where}: ${msg}`, { hint: '账号已认证，但 ACL 未授权该命令或键；见 docs/guides/redis.md 的权限前提', details, cause: e });
  }
  if (/^(NOAUTH|WRONGPASS)/.test(msg) || /invalid (username-password|password)/i.test(msg)) {
    return new WorkError('UNAUTHENTICATED', `Redis 认证失败${where}: ${msg}`, { hint: '检查 profile 中的 username / password_ref', details, cause: e });
  }
  if (/unknown command/i.test(msg)) {
    return new WorkError('UNSUPPORTED', `Redis 不支持或禁用了该命令${where}: ${msg}`, { hint: '托管 Redis 常禁用/重命名 CONFIG、DEBUG 等命令', details, cause: e });
  }
  if (/^(LOADING|BUSY|MASTERDOWN|CLUSTERDOWN|TRYAGAIN)/.test(msg)) {
    return new WorkError('UPSTREAM_UNAVAILABLE', `Redis 暂时不可用${where}: ${msg}`, { details, cause: e });
  }
  if (/Command timed out|timed out/i.test(msg)) {
    return new WorkError('TIMEOUT', `Redis 命令超时${where}: ${msg}`, { hint: '增大 --timeout 或缩小扫描预算', details, cause: e });
  }
  if (msg === 'Connection is closed.' || /connect|isn't writeable/i.test(msg) || err?.name === 'MaxRetriesPerRequestError') {
    return new WorkError('UPSTREAM_UNAVAILABLE', `Redis 连接失败${where}: ${msg}`, { details, cause: e });
  }
  if (/^(WRONGTYPE|ERR syntax|ERR wrong number)/.test(msg)) {
    return new WorkError('INVALID_ARGUMENT', `Redis 拒绝该命令${where}: ${msg}`, { details, cause: e });
  }
  return new WorkError('UPSTREAM_UNAVAILABLE', `Redis 返回错误${where}: ${msg}`, { details, cause: e });
}

export async function withRedis<T>(ctx: Ctx, instance: string | undefined, fn: (s: RedisSession) => Promise<T>): Promise<T> {
  const ep = ctx.endpoint('redis', instance);
  const client = new Redis({
    host: ep.require('host'),
    port: ep.num('port', 6379),
    username: ep.str('username'),
    password: ep.secret('password'),
    db: ep.num('db', 0),
    lazyConnect: true,
    connectTimeout: Math.min(5000, ctx.remainingMs()),
    commandTimeout: Math.max(1, ctx.remainingMs()),
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    enableReadyCheck: false,
    enableOfflineQueue: false,
    ...(ep.bool('tls', false) ? { tls: { rejectUnauthorized: ep.bool('tls_verify', true) } } : {}),
  });
  let lastError: unknown;
  client.on('error', (e) => {
    lastError = e;
  });
  try {
    await client.connect();
  } catch (e) {
    client.disconnect();
    throw mapRedisError(lastError ?? e, ep) ?? e;
  }
  let version: string | undefined;
  let versionFetched = false;
  // AUTH failures arrive asynchronously as an 'error' event; later commands then fail with a
  // generic "stream isn't writeable" error, so the earlier reply error is the real cause.
  const fail = (e: unknown): unknown => {
    const cause = lastError && isRedisOriginError(lastError) && !isRedisOriginError(e) ? lastError : e;
    return mapRedisError(cause, ep) ?? e;
  };
  const cmd = async <R = unknown>(name: string, ...args: (string | number | Buffer)[]): Promise<R> => {
    try {
      return (await client.call(name, ...args)) as R;
    } catch (e) {
      throw fail(e);
    }
  };
  const session: RedisSession = {
    ep,
    client,
    cmd,
    fail,
    version: async () => {
      if (!versionFetched) {
        versionFetched = true;
        try {
          const info = parseInfo(String(await client.call('INFO', 'server')));
          version = info.server?.redis_version !== undefined ? String(info.server.redis_version) : undefined;
        } catch {
          version = undefined;
        }
      }
      return version;
    },
    src: async (method, relation = 'explicit') => source(SYSTEM, ADAPTER, { endpoint: ep.id, method, version: await session.version(), relation }),
  };
  try {
    return await fn(session);
  } finally {
    try {
      await Promise.race([client.quit(), new Promise((r) => setTimeout(r, 500).unref?.())]);
    } catch {
      /* ignore */
    }
    client.disconnect();
  }
}

/** Read maxmemory-policy without needing CONFIG permission (INFO memory exposes it). */
export async function maxmemoryPolicy(s: RedisSession): Promise<string | null> {
  const info = parseInfo(String(await s.cmd('INFO', 'memory')));
  const v = info.memory?.maxmemory_policy;
  return v === undefined ? null : String(v);
}

/** CONFIG GET that degrades to null (with reason) when CONFIG is not permitted. */
export async function tryConfigGet(s: RedisSession, pattern: string): Promise<{ values: Record<string, string> | null; reason?: string }> {
  try {
    const arr = (await s.cmd<string[]>('CONFIG', 'GET', pattern)) ?? [];
    const out: Record<string, string> = {};
    for (let k = 0; k + 1 < arr.length; k += 2) out[String(arr[k])] = String(arr[k + 1]);
    return { values: out };
  } catch (e) {
    return { values: null, reason: e instanceof Error ? e.message : String(e) };
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
