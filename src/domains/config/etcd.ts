import { rawRequest, safeUrl } from '../../core/http';
import { source, WorkError, type Source } from '../../core/output';
import type { Ctx, Endpoint } from '../../core/runtime';

export const ETCD_ADAPTER = 'etcd-v3-gateway';
export const ETCD_AUTH = 'etcd-profile';

/** Raw key-value as returned by the etcd v3 JSON gateway (int64 fields are decimal strings, defaults omitted). */
export interface EtcdKv {
  key: string;
  value?: string;
  create_revision?: string;
  mod_revision?: string;
  version?: string;
  lease?: string;
}

export interface EtcdHeader {
  cluster_id?: string;
  member_id?: string;
  revision?: string;
  raft_term?: string;
}

export interface RangeResponse {
  header?: EtcdHeader;
  kvs?: EtcdKv[];
  more?: boolean;
  count?: string;
}

export interface RangeRequest {
  key: string;
  range_end?: string;
  limit?: number;
  revision?: number;
  count_only?: boolean;
  keys_only?: boolean;
  sort_order?: 'ASCEND' | 'DESCEND';
  sort_target?: 'KEY' | 'MOD';
}

export const b64 = (s: string | Buffer): string => (Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8')).toString('base64');
export const unb64 = (s: string | undefined): Buffer => Buffer.from(s ?? '', 'base64');
/** proto3 JSON omits zero values; int64 travels as a decimal string. */
export const int = (s: string | number | undefined): number => (s === undefined || s === '' ? 0 : Number(s));

/** etcd prefix range_end: increment the last byte that is < 0xff and truncate after it ("\0" = to the end of the keyspace). */
export function prefixRangeEnd(prefix: Buffer): Buffer {
  const end = Buffer.from(prefix);
  for (let i = end.length - 1; i >= 0; i--) {
    if (end[i] < 0xff) {
      end[i] += 1;
      return end.subarray(0, i + 1);
    }
  }
  return Buffer.from([0]);
}

interface GatewayError {
  error?: string;
  message?: string;
  code?: number;
}

/** Map a gateway error body (gRPC status code + etcd message) to a stable workctl error. */
export function mapEtcdError(status: number, body: GatewayError | string | null, where: string): WorkError {
  const msg = typeof body === 'object' && body ? String(body.message ?? body.error ?? '') : String(body ?? '');
  const code = typeof body === 'object' && body ? body.code : undefined;
  const details = { http_status: status, grpc_code: code ?? null, etcd_message: msg.slice(0, 300) };
  if (/required revision has been compacted/.test(msg)) {
    return new WorkError('DATA_UNAVAILABLE', `请求的修订已被压缩（compaction），etcd 不再保留该修订的历史 (${where})`, { details });
  }
  if (/future revision/.test(msg)) return new WorkError('INVALID_ARGUMENT', `请求的修订大于 etcd 当前修订 (${where})`, { details });
  if (status === 401 || code === 16 || /invalid auth token|auth token is expired/.test(msg)) {
    return new WorkError('UNAUTHENTICATED', `etcd 认证失败: ${msg} (${where})`, { details, hint: '检查端点 username / password_ref；token 过期时重新调用即可' });
  }
  if (/user name is empty|authentication failed|invalid user ID or password/.test(msg)) {
    return new WorkError('UNAUTHENTICATED', `etcd 要求认证或认证失败: ${msg} (${where})`, { details, hint: '在端点配置 username 与 password_ref（file:/env: 引用）' });
  }
  if (status === 403 || code === 7 || /permission denied/.test(msg)) {
    return new WorkError('PERMISSION_DENIED', `etcd 拒绝访问（角色无该键范围的权限）: ${msg} (${where})`, { details, hint: '需要该前缀的 read 权限（etcdctl role grant-permission --prefix）' });
  }
  if (status === 404) {
    return new WorkError('UPSTREAM_UNAVAILABLE', `etcd 网关路径不存在 (${where})`, { details, hint: '确认 url 指向 etcd 客户端端口（v3 JSON 网关，3.4+ 路径为 /v3/*）' });
  }
  if (status === 400 && (code === 3 || code === undefined)) return new WorkError('INVALID_ARGUMENT', `etcd 拒绝请求参数: ${msg} (${where})`, { details });
  return new WorkError('UPSTREAM_UNAVAILABLE', `etcd 返回 HTTP ${status}: ${msg} (${where})`, { details });
}

const NET_CODES = ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE'];

/**
 * Thin client over the etcd v3 HTTP/JSON gateway (POST /v3/<service>/<method>).
 * Optional auth: username + password_ref → POST /v3/auth/authenticate → token in the Authorization header.
 */
export class EtcdClient {
  readonly url: string;
  private token: string | null | undefined;
  private versionCache: string | null | undefined;
  authNote: string | null = null;

  constructor(
    private readonly ctx: Ctx,
    readonly endpoint: Endpoint,
  ) {
    this.url = endpoint.require('url').replace(/\/+$/, '');
  }

  get id(): string {
    return this.endpoint.id;
  }

  private async send(method: 'GET' | 'POST', path: string, body?: unknown, token?: string | null): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token) headers.authorization = token;
    let payload: string | undefined;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
    let res;
    try {
      res = await rawRequest(`${this.url}${path}`, { method, headers, body: payload, timeoutMs: Math.min(this.ctx.remainingMs(), 15_000) });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      const code = err.code ?? (err.cause as NodeJS.ErrnoException | undefined)?.code;
      if (err.name === 'TimeoutError') throw new WorkError('TIMEOUT', `etcd 请求超时 (${safeUrl(this.url + path)})`);
      if (code && NET_CODES.includes(code)) {
        throw new WorkError('UPSTREAM_UNAVAILABLE', `etcd 不可达 (${code}, ${this.id})`, { details: { endpoint: safeUrl(this.url) }, hint: '确认 etcd 已启动、url 指向客户端端口（演示环境 127.0.0.1:12379）' });
      }
      throw e;
    }
    let json: any = null;
    try {
      json = res.text ? JSON.parse(res.text) : null;
    } catch {
      json = res.text;
    }
    return { status: res.status, json };
  }

  private async authToken(): Promise<string | null> {
    if (this.token !== undefined) return this.token;
    const user = this.endpoint.str('username');
    if (!user) return (this.token = null);
    const password = this.endpoint.secret('password');
    if (password === undefined) throw new WorkError('UNAUTHENTICATED', `端点 ${this.id} 配置了 username 但缺少 password_ref`, { hint: 'password_ref: file:<path> 或 env:<NAME>' });
    const r = await this.send('POST', '/v3/auth/authenticate', { name: user, password });
    if (r.status >= 400) {
      const msg = String(r.json?.message ?? r.json?.error ?? '');
      if (/authentication is not enabled/.test(msg)) {
        this.authNote = `etcd 未开启认证，已忽略端点配置的 username（${user}）`;
        return (this.token = null);
      }
      throw mapEtcdError(r.status, r.json, `${safeUrl(this.url)}/v3/auth/authenticate`);
    }
    return (this.token = String(r.json?.token ?? '') || null);
  }

  get username(): string | null {
    return this.endpoint.str('username') ?? null;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const token = await this.authToken();
    const r = await this.send('POST', path, body, token);
    if (r.status >= 400 || (r.json && typeof r.json === 'object' && 'error' in r.json && r.json.code)) {
      throw mapEtcdError(r.status, r.json, `${safeUrl(this.url)}${path}`);
    }
    return r.json as T;
  }

  async getVersion(): Promise<{ etcdserver?: string; etcdcluster?: string }> {
    const r = await this.send('GET', '/version');
    if (r.status >= 400) throw mapEtcdError(r.status, r.json, `${safeUrl(this.url)}/version`);
    return r.json ?? {};
  }

  /** Server version for provenance; null when /version is not reachable (never guessed). */
  async version(): Promise<string | null> {
    if (this.versionCache !== undefined) return this.versionCache;
    try {
      this.versionCache = (await this.getVersion()).etcdserver ?? null;
    } catch {
      this.versionCache = null;
    }
    return this.versionCache;
  }

  range(req: RangeRequest): Promise<RangeResponse> {
    const body: Record<string, unknown> = { key: req.key };
    if (req.range_end) body.range_end = req.range_end;
    if (req.limit) body.limit = String(req.limit);
    if (req.revision) body.revision = String(req.revision);
    if (req.count_only) body.count_only = true;
    if (req.keys_only) body.keys_only = true;
    if (req.sort_order) body.sort_order = req.sort_order;
    if (req.sort_target) body.sort_target = req.sort_target;
    return this.post<RangeResponse>('/v3/kv/range', body);
  }

  timeToLive(id: string): Promise<{ header?: EtcdHeader; ID?: string; TTL?: string; grantedTTL?: string }> {
    return this.post('/v3/lease/timetolive', { ID: id });
  }

  async source(method: string, relation: Source['relation'] = 'explicit'): Promise<Source> {
    const version = await this.version();
    return source('etcd', ETCD_ADAPTER, { endpoint: `${this.id} (${safeUrl(this.url).replace(/\/$/, '')})`, method, relation, ...(version ? { version } : {}) });
  }
}

export function etcdClient(ctx: Ctx, name?: string): EtcdClient {
  return new EtcdClient(ctx, ctx.endpoint('etcd', name));
}
