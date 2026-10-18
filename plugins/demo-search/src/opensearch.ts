import { z } from 'zod';
import { PluginError, type PluginRequest, type Source } from './protocol';

export const SYSTEM = 'opensearch';
export const ADAPTER = 'opensearch-http';
export const ENDPOINT_KIND = 'opensearch';

/**
 * Endpoint config for kind `opensearch` (profile.endpoints.opensearch.<name>).
 * `password_ref` is resolved by core and arrives as `password` (stdin only).
 */
export const OpenSearchEndpointSchema = z.object({
  // no user:password@ in the url: credentials only via username + password_ref (fetch would echo the url in its error)
  url: z.string().regex(/^https?:\/\/[^\s/@]+(\/.*)?$/, { message: '须为 http(s)://host:port，且不能内嵌 user:password@（用 username + password_ref）' }),
  username: z.string().min(1).optional(),
  password: z.string().optional(),
  connect_timeout_ms: z.number().int().positive().optional(),
});
export type OpenSearchEndpoint = z.infer<typeof OpenSearchEndpointSchema>;

export interface ResolvedEndpoint {
  name: string;
  config: OpenSearchEndpoint;
  /** endpoint label without credentials, used in meta.sources */
  label: string;
  baseUrl: string;
}

export function resolveEndpoint(req: PluginRequest, cluster: unknown): ResolvedEndpoint {
  const configured = req.endpoints[ENDPOINT_KIND] ?? {};
  const name = typeof cluster === 'string' && cluster ? cluster : req.defaults[ENDPOINT_KIND];
  if (!name) {
    throw new PluginError('INVALID_ARGUMENT', '缺少 --cluster，且 profile 未设置 defaults.opensearch', {
      hint: '指定 --cluster <endpoint 名>',
      details: { configured_clusters: Object.keys(configured) },
    });
  }
  const raw = configured[name];
  if (!raw) {
    throw new PluginError('NOT_CONFIGURED', `当前 profile 未配置 OpenSearch 集群 ${name}`, {
      hint: '在 profile.endpoints.opensearch 下添加该集群（url；需要认证时配置 username 与 password_ref）',
      details: { cluster: name, configured_clusters: Object.keys(configured) },
    });
  }
  const parsed = OpenSearchEndpointSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PluginError('NOT_CONFIGURED', `OpenSearch 集群 ${name} 的端点配置不完整`, {
      hint: '至少需要 url: http(s)://host:port',
      details: { cluster: name, issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
    });
  }
  if (parsed.data.username && !parsed.data.password) {
    throw new PluginError('UNAUTHENTICATED', `OpenSearch 集群 ${name} 配置了 username，但缺少 password_ref 或引用解析为空`, {
      hint: '配置 password_ref（env:NAME 或 file:PATH）',
      details: { cluster: name },
    });
  }
  return { name, config: parsed.data, label: `opensearch/${name}`, baseUrl: parsed.data.url.replace(/\/+$/, '') };
}

/** Non-2xx answer from OpenSearch, with its parsed error body. */
export class OsHttpError extends Error {
  readonly status: number;
  readonly body: any;
  readonly method: string;
  readonly path: string;
  constructor(method: string, path: string, status: number, body: any) {
    super(`${method} ${path} -> HTTP ${status}`);
    this.name = 'OsHttpError';
    this.status = status;
    this.body = body;
    this.method = method;
    this.path = path;
  }
}

/** Minimal JSON client bound to a deadline; every call shares the plugin's time budget. */
export class OsClient {
  private readonly deadline: number;
  constructor(readonly ep: ResolvedEndpoint, budgetMs: number) {
    this.deadline = Date.now() + budgetMs;
  }

  remainingMs(): number {
    return Math.max(0, this.deadline - Date.now());
  }

  async request<T = any>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const remaining = this.remainingMs();
    if (remaining < 50) throw new PluginError('TIMEOUT', `时间预算已用尽（${method} ${path} 未发出）`, { hint: '增大 --timeout' });
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.ep.config.username) {
      headers.authorization = `Basic ${Buffer.from(`${this.ep.config.username}:${this.ep.config.password ?? ''}`).toString('base64')}`;
    }
    const res = await fetch(`${this.ep.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(remaining),
      redirect: 'error',
    });
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text.slice(0, 500) };
    }
    if (!res.ok) throw new OsHttpError(method, path, res.status, json);
    return json as T;
  }
}

export interface ClusterVersion {
  distribution: string;
  number: string | null;
  cluster_name: string | null;
  cluster_uuid: string | null;
  lucene_version: string | null;
}

/** GET / — version banner. Missing permission is reported as a warning, never fatal. */
export async function observeVersion(client: OsClient, warnings: string[]): Promise<ClusterVersion | null> {
  try {
    const r = await client.request<any>('GET', '/');
    return {
      distribution: String(r?.version?.distribution ?? 'elasticsearch'),
      number: r?.version?.number ?? null,
      cluster_name: r?.cluster_name ?? null,
      cluster_uuid: r?.cluster_uuid ?? null,
      lucene_version: r?.version?.lucene_version ?? null,
    };
  } catch (e) {
    const mapped = mapOsError(e, { cluster: client.ep.name });
    if (mapped.code === 'PERMISSION_DENIED') {
      warnings.push('无权读取 GET /（cluster:monitor/main），sources.version 留空');
      return null;
    }
    throw mapped;
  }
}

export function makeSource(ep: ResolvedEndpoint, v: ClusterVersion | null, method: string, relation: Source['relation'] = 'explicit', observedAt = new Date().toISOString()): Source {
  return {
    system: SYSTEM,
    adapter: ADAPTER,
    endpoint: ep.label,
    method,
    observed_at: observedAt,
    ...(v?.number ? { version: `${v.distribution} ${v.number}` } : {}),
    relation,
  };
}

/** First root cause of an OpenSearch error body: {type, reason}. */
export function rootCause(body: any): { type: string | null; reason: string | null } {
  const err = body?.error;
  if (typeof err === 'string') return { type: null, reason: err };
  const rc = Array.isArray(err?.root_cause) && err.root_cause.length ? err.root_cause[0] : err;
  // search_phase_execution_exception: the useful reason is in failed_shards[0].reason.caused_by
  const shardReason = err?.failed_shards?.[0]?.reason;
  const caused = shardReason?.caused_by ?? err?.caused_by;
  const reason = [rc?.reason, caused?.reason && caused.reason !== rc?.reason ? caused.reason : null].filter(Boolean).join(': ').replace(/\s+/g, ' ');
  return { type: rc?.type ?? err?.type ?? null, reason: reason ? (reason.length > 400 ? `${reason.slice(0, 400)}…` : reason) : null };
}

const NET_CODES = ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'];

/** Map fetch / HTTP errors to stable protocol codes. Messages never include credentials. */
export function mapOsError(e: unknown, ctx: { cluster: string; index?: string }): PluginError {
  if (e instanceof PluginError) return e;
  if (e instanceof OsHttpError) {
    const { type, reason } = rootCause(e.body);
    const details: Record<string, unknown> = { cluster: ctx.cluster, http_status: e.status, request: `${e.method} ${e.path}`, opensearch_error_type: type };
    const msg = reason ?? `HTTP ${e.status}`;
    if (e.status === 401) {
      return new PluginError('UNAUTHENTICATED', `OpenSearch 集群 ${ctx.cluster} 认证失败（HTTP 401）`, { hint: '检查端点 username / password_ref', details });
    }
    if (e.status === 403) {
      return new PluginError('PERMISSION_DENIED', `OpenSearch 拒绝了该操作（HTTP 403${type ? ` ${type}` : ''}）: ${msg}`, {
        hint: '只读账号需要 cluster:monitor/* 与目标索引的 indices:monitor/*、indices:data/read/search 权限',
        details,
      });
    }
    if (e.status === 404 && (type === 'index_not_found_exception' || /no such index/.test(msg))) {
      const index = e.body?.error?.index ?? ctx.index ?? null;
      return new PluginError('NOT_FOUND', `索引或别名不存在: ${index ?? '(未知)'}`, {
        hint: `用 workctl search cluster get --cluster ${ctx.cluster} 查看索引数量；核对索引/别名名称`,
        details: { ...details, index },
      });
    }
    if (e.status === 404) return new PluginError('NOT_FOUND', `OpenSearch 返回 404: ${msg}`, { details });
    if (type === 'index_closed_exception') {
      // not a query problem: the target (or an alias' backing index) is closed and cannot be searched
      const index = e.body?.error?.index ?? ctx.index ?? null;
      return new PluginError('DATA_UNAVAILABLE', `索引处于关闭状态（close），不可搜索: ${index ?? '(未知)'}`, {
        hint: '关闭的索引需由管理员 _open 后才能查询；workctl search index get 可查看其设置与映射',
        details: { ...details, index },
      });
    }
    if (e.status === 400) {
      return new PluginError('INVALID_ARGUMENT', `OpenSearch 拒绝了查询（${type ?? 'bad_request'}）: ${msg}`, {
        hint: '检查 query_string 语法（括号、引号、字段名:值）或 DSL 结构',
        details,
      });
    }
    if (e.status === 408 || e.status === 504) return new PluginError('TIMEOUT', `OpenSearch 请求超时（HTTP ${e.status}）: ${msg}`, { hint: '增大 --timeout 或缩小查询范围', details });
    if (e.status === 429) return new PluginError('UPSTREAM_UNAVAILABLE', `OpenSearch 拒绝执行（HTTP 429，线程池/熔断）: ${msg}`, { hint: '稍后重试；检查集群负载', details });
    return new PluginError('UPSTREAM_UNAVAILABLE', `OpenSearch 返回 HTTP ${e.status}: ${msg}`, { details });
  }
  const err = e as Error & { cause?: any; code?: string };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return new PluginError('TIMEOUT', `OpenSearch 请求超过时间预算（${ctx.cluster}）`, { hint: '增大 --timeout 或检查集群负载', details: { cluster: ctx.cluster } });
  }
  const code = err?.cause?.code ?? err?.code;
  if ((err instanceof TypeError && /fetch failed/i.test(err.message)) || (code && NET_CODES.includes(code))) {
    return new PluginError('UPSTREAM_UNAVAILABLE', `OpenSearch 集群 ${ctx.cluster} 不可达: ${err?.cause?.message ?? err.message}`, {
      hint: '检查端点 url、网络连通性与 OpenSearch 进程状态',
      details: { cluster: ctx.cluster, ...(code ? { errno: code } : {}) },
    });
  }
  return new PluginError('INTERNAL', err?.message ?? String(e), { details: { cluster: ctx.cluster } });
}

// Index names: lowercase, no \ / * ? " < > | space , # :, must not start with - _ +, not . or ..
const INDEX_RE = /^[a-z0-9][a-z0-9._+-]{0,254}$/;

/** A single concrete index or alias name (no wildcard, no comma, no hidden/system `.` prefix). */
export function requireIndexName(v: unknown, flag = '--index'): string {
  if (typeof v !== 'string' || !v.trim()) throw new PluginError('INVALID_ARGUMENT', `缺少必填参数 ${flag}`);
  const s = v.trim();
  if (/[*?,]/.test(s) || s === '_all') {
    throw new PluginError('INVALID_ARGUMENT', `${flag} 必须是单个索引或别名，不支持通配符、逗号列表或 _all: ${s}`, { hint: '先用别名或具体索引名' });
  }
  if (!INDEX_RE.test(s)) {
    throw new PluginError('INVALID_ARGUMENT', `${flag} 不是合法的索引/别名名称: ${s}`, { hint: '小写字母、数字、. _ - +，不能以 . _ - + 开头（系统/隐藏索引不在范围内）' });
  }
  return s;
}

/** Search target: one or more names/aliases, optionally with a trailing `*` wildcard; never `_all` or `.`-prefixed. */
export function requireSearchTarget(v: unknown, flag = '--index'): string[] {
  if (typeof v !== 'string' || !v.trim()) throw new PluginError('INVALID_ARGUMENT', `缺少必填参数 ${flag}`);
  const parts = v.split(',').map((x) => x.trim()).filter(Boolean);
  if (!parts.length || parts.length > 10) throw new PluginError('INVALID_ARGUMENT', `${flag} 需要 1-10 个索引/别名`);
  for (const p of parts) {
    const base = p.endsWith('*') ? p.slice(0, -1) : p;
    if (p === '_all' || p === '*' || base.length < 2 || !INDEX_RE.test(base) || base.includes('*')) {
      throw new PluginError('INVALID_ARGUMENT', `${flag} 含不允许的目标: ${p}`, {
        hint: '只允许具体索引/别名，或带尾部 * 的前缀（至少 2 个字符）；禁止 _all、* 和 . 开头的系统索引',
      });
    }
  }
  return parts;
}

export function encodeIndexList(names: string[]): string {
  return names.map((n) => encodeURIComponent(n).replace(/%2A/g, '*')).join(',');
}
