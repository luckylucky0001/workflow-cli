import { readFileSync, existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { dirname, isAbsolute, resolve } from 'node:path';
import YAML from 'yaml';
import { safeUrl } from '../../core/http';
import { source, WorkError, type Source } from '../../core/output';
import type { Ctx, Endpoint } from '../../core/runtime';

/**
 * Minimal Kubernetes REST client (no client library): bearer token or client
 * certificate, custom CA, JSON in/out. Endpoint kind `kubernetes`:
 *   server, token_ref | kubeconfig (+ context), ca_file | insecure_skip_tls_verify, namespace, event_ttl
 */
export const K8S_ADAPTER = 'kubernetes-api';
export const K8S_AUTH = 'kubernetes-bearer';
export const DEFAULT_EVENT_TTL_MS = 3_600_000;

export interface KubeVersion {
  major: string;
  minor: string;
  gitVersion: string;
  platform?: string;
}

interface KubeAuth {
  token?: string;
  cert?: string | Buffer;
  key?: string | Buffer;
}

interface KubeTls {
  ca?: string | Buffer;
  insecure: boolean;
}

export class KubeClient {
  private versionPromise?: Promise<KubeVersion>;

  constructor(
    readonly endpointId: string,
    readonly server: string,
    private readonly auth: KubeAuth,
    private readonly tls: KubeTls,
    readonly defaultNamespace: string,
    readonly eventTtlMs: number,
    private readonly ctx: Ctx | null,
    readonly authMode: string,
  ) {}

  async request<T = unknown>(method: string, path: string, opts: { body?: unknown; contentType?: string; allowStatus?: number[]; timeoutMs?: number } = {}): Promise<{ status: number; body: T }> {
    const url = `${this.server}${path}`;
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'workctl' };
    if (this.auth.token) headers.authorization = `Bearer ${this.auth.token}`;
    let payload: string | undefined;
    if (opts.body !== undefined) {
      payload = JSON.stringify(opts.body);
      headers['content-type'] = opts.contentType ?? 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }
    const timeoutMs = opts.timeoutMs ?? this.ctx?.remainingMs() ?? 30_000;
    let res: { status: number; text: string; contentType: string };
    try {
      res = await this.raw(method, url, headers, payload, timeoutMs);
    } catch (e) {
      throw mapKubeTransportError(e, this.endpointId);
    }
    let body: unknown = res.text;
    if (res.text && /json/.test(res.contentType)) {
      try {
        body = JSON.parse(res.text);
      } catch {
        body = res.text;
      }
    }
    if (res.status >= 400 && !(opts.allowStatus ?? []).includes(res.status)) throw kubeHttpError(method, path, res.status, body, this.endpointId);
    return { status: res.status, body: body as T };
  }

  private raw(method: string, url: string, headers: Record<string, string>, payload: string | undefined, timeoutMs: number): Promise<{ status: number; text: string; contentType: string }> {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    return new Promise((resolvePromise, reject) => {
      const base = {
        method,
        hostname: u.hostname.replace(/^\[|\]$/g, ''),
        port: u.port || (isHttps ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        headers,
      };
      const onRes = (res: import('node:http').IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), contentType: String(res.headers['content-type'] ?? '') }));
        res.on('error', reject);
      };
      // node:http(s) directly: a custom CA / client certificate is needed, and a cluster API
      // server must never be reached through a global HTTP(S) proxy by accident.
      const req = isHttps
        ? httpsRequest(
            {
              ...base,
              agent: false,
              ...(this.tls.ca ? { ca: this.tls.ca } : {}),
              ...(this.auth.cert ? { cert: this.auth.cert } : {}),
              ...(this.auth.key ? { key: this.auth.key } : {}),
              rejectUnauthorized: !this.tls.insecure,
            },
            onRes,
          )
        : httpRequest({ ...base, agent: false }, onRes);
      req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error(`timeout after ${timeoutMs}ms`), { name: 'TimeoutError' })));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  get<T = unknown>(path: string): Promise<T> {
    return this.request<T>('GET', path).then((r) => r.body);
  }

  version(): Promise<KubeVersion> {
    this.versionPromise ??= this.get<KubeVersion>('/version');
    return this.versionPromise;
  }

  /** Provenance record; `version` is the API server's gitVersion. */
  async source(method: string, relation: Source['relation'] = 'explicit'): Promise<Source> {
    let version: string | undefined;
    try {
      version = (await this.version()).gitVersion;
    } catch {
      version = undefined;
    }
    return source('kubernetes', K8S_ADAPTER, { endpoint: this.endpointId, method, relation, ...(version ? { version } : {}) });
  }
}

// ---------------------------------------------------------------------------
// configuration (endpoint keys + minimal kubeconfig)
// ---------------------------------------------------------------------------
interface KubeconfigFile {
  'current-context'?: string;
  clusters?: { name: string; cluster: Record<string, unknown> }[];
  users?: { name: string; user: Record<string, unknown> }[];
  contexts?: { name: string; context: { cluster: string; user: string; namespace?: string } }[];
}

interface ResolvedKubeconfig {
  server?: string;
  namespace?: string;
  ca?: string | Buffer;
  insecure?: boolean;
  token?: string;
  cert?: string | Buffer;
  key?: string | Buffer;
  context: string;
}

function readPath(p: string, base: string): Buffer {
  const full = isAbsolute(p) ? p : resolve(base, p);
  if (!existsSync(full)) throw new WorkError('NOT_CONFIGURED', `kubeconfig 引用的文件不存在: ${p}`);
  return readFileSync(full);
}

/** Minimal kubeconfig support: server, CA, token / client certificate of one context. No exec / auth-provider plugins. */
export function loadKubeconfig(path: string, context?: string): ResolvedKubeconfig {
  if (!existsSync(path)) throw new WorkError('NOT_CONFIGURED', `kubeconfig 不存在: ${path}`);
  let kc: KubeconfigFile;
  try {
    kc = (YAML.parse(readFileSync(path, 'utf8')) ?? {}) as KubeconfigFile;
  } catch (e) {
    // never echo the parser message: YAML errors quote the offending source line, which can be a token or key
    const pos = (e as { linePos?: { line: number; col: number }[] }).linePos?.[0];
    throw new WorkError('INVALID_ARGUMENT', `kubeconfig 无法解析: ${path}`, {
      details: { code: (e as { code?: string }).code ?? 'YAML_PARSE_ERROR', ...(pos ? { line: pos.line, column: pos.col } : {}) },
    });
  }
  const ctxName = context ?? kc['current-context'];
  if (!ctxName) throw new WorkError('NOT_CONFIGURED', `kubeconfig ${path} 没有 current-context，需要在端点中配置 context`);
  const c = kc.contexts?.find((x) => x.name === ctxName)?.context;
  if (!c) throw new WorkError('NOT_CONFIGURED', `kubeconfig 中没有 context ${ctxName}`, { hint: `可用: ${(kc.contexts ?? []).map((x) => x.name).join(', ') || '(无)'}` });
  const cluster = kc.clusters?.find((x) => x.name === c.cluster)?.cluster ?? {};
  const user = kc.users?.find((x) => x.name === c.user)?.user ?? {};
  if (user.exec || user['auth-provider']) {
    throw new WorkError('UNSUPPORTED', `kubeconfig 用户 ${c.user} 使用 exec/auth-provider 插件，workctl 只支持 token 或客户端证书`, {
      hint: '为 workctl 创建 ServiceAccount token，用 token_ref: file:/path 引用',
    });
  }
  const base = dirname(path);
  const b64 = (v: unknown) => (typeof v === 'string' && v ? Buffer.from(v, 'base64') : undefined);
  const out: ResolvedKubeconfig = { context: ctxName };
  if (typeof cluster.server === 'string') out.server = cluster.server;
  out.ca = b64(cluster['certificate-authority-data']) ?? (typeof cluster['certificate-authority'] === 'string' ? readPath(cluster['certificate-authority'], base) : undefined);
  if (cluster['insecure-skip-tls-verify'] === true) out.insecure = true;
  if (typeof user.token === 'string' && user.token) out.token = user.token;
  else if (typeof user.tokenFile === 'string') out.token = readPath(user.tokenFile, base).toString('utf8').trim();
  out.cert = b64(user['client-certificate-data']) ?? (typeof user['client-certificate'] === 'string' ? readPath(user['client-certificate'], base) : undefined);
  out.key = b64(user['client-key-data']) ?? (typeof user['client-key'] === 'string' ? readPath(user['client-key'], base) : undefined);
  if (c.namespace) out.namespace = c.namespace;
  return out;
}

const clients = new WeakMap<Ctx, Map<string, KubeClient>>();

export function kubeClient(ctx: Ctx, name?: string): KubeClient {
  const ep = ctx.endpoint('kubernetes', name);
  let perCtx = clients.get(ctx);
  if (!perCtx) clients.set(ctx, (perCtx = new Map()));
  const cached = perCtx.get(ep.name);
  if (cached) return cached;
  const client = buildClient(ctx, ep);
  perCtx.set(ep.name, client);
  return client;
}

function buildClient(ctx: Ctx, ep: Endpoint): KubeClient {
  const kcPath = ep.path('kubeconfig');
  const kc = kcPath ? loadKubeconfig(kcPath, ep.str('context')) : undefined;
  const server = (ep.str('server') ?? kc?.server)?.replace(/\/$/, '');
  if (!server) throw new WorkError('NOT_CONFIGURED', `端点 ${ep.id} 需要配置 server 或 kubeconfig`);
  if (!/^https?:\/\//.test(server)) throw new WorkError('INVALID_ARGUMENT', `端点 ${ep.id} 的 server 必须是 http(s) URL`);
  const token = ep.secret('token') ?? kc?.token;
  const caFile = ep.path('ca_file');
  const ca = caFile ? readPath(caFile, ctx.loaded.baseDir) : kc?.ca;
  const insecure = ep.cfg.insecure_skip_tls_verify !== undefined ? ep.bool('insecure_skip_tls_verify') : kc?.insecure ?? false;
  const auth: KubeAuth = token ? { token } : kc?.cert && kc?.key ? { cert: kc.cert, key: kc.key } : {};
  const authMode = token ? 'bearer-token' : auth.cert ? 'client-certificate' : 'anonymous';
  if (authMode === 'anonymous') ctx.warn(`端点 ${ep.id} 未配置 token_ref 或 kubeconfig 凭据，以匿名身份访问 API server`);
  if (insecure) ctx.warn(`端点 ${ep.id} 关闭了 TLS 证书校验（insecure_skip_tls_verify）`);
  const ttl = ep.str('event_ttl');
  let eventTtlMs = DEFAULT_EVENT_TTL_MS;
  if (ttl) {
    const m = /^(\d+)(s|m|h)$/.exec(ttl);
    if (!m) throw new WorkError('INVALID_ARGUMENT', `端点 ${ep.id}.event_ttl 格式不正确: ${ttl}（示例 1h、90m）`);
    eventTtlMs = Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] as 's' | 'm' | 'h'];
  }
  const ns = ep.str('namespace') ?? kc?.namespace ?? 'default';
  const id = `${ep.id} (${safeUrl(server)}${kc ? `, context ${kc.context}` : ''})`;
  return new KubeClient(id, server, auth, { ca, insecure }, ns, eventTtlMs, ctx, authMode);
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------
export interface KubeStatus {
  kind?: string;
  status?: string;
  message?: string;
  reason?: string;
  details?: { name?: string; group?: string; kind?: string };
  code?: number;
}

/** Parse the RBAC denial text: `User "x" cannot patch resource "deployments" in API group "apps" in the namespace "demo"`. */
export function parseForbidden(message: string): { user?: string; verb?: string; resource?: string; group?: string; namespace?: string } {
  const m = /User "([^"]*)" cannot (\S+) resource "([^"]+)"(?: in API group "([^"]*)")?(?: in the namespace "([^"]+)"| at the cluster scope)?/.exec(message);
  if (!m) return {};
  return { user: m[1], verb: m[2], resource: m[3], group: m[4] ?? '', ...(m[5] ? { namespace: m[5] } : {}) };
}

export function kubeHttpError(method: string, path: string, status: number, body: unknown, endpointId: string): WorkError {
  const st = (body && typeof body === 'object' ? body : {}) as KubeStatus;
  const msg = st.message ?? (typeof body === 'string' ? body.slice(0, 300) : '');
  const where = `${method} ${path.split('?')[0]}`;
  const details: Record<string, unknown> = { status, reason: st.reason ?? null, message: msg || null, endpoint: endpointId };
  if (status === 401) {
    return new WorkError('UNAUTHENTICATED', `Kubernetes API 认证失败 (${where})`, {
      hint: '检查 token_ref / kubeconfig 凭据是否有效、是否过期',
      details,
    });
  }
  if (status === 403) {
    const f = parseForbidden(msg);
    const what = f.verb && f.resource ? `${f.verb} ${f.group ? `${f.resource}.${f.group}` : f.resource}${f.namespace ? `（namespace ${f.namespace}）` : ''}` : msg;
    return new WorkError('PERMISSION_DENIED', `Kubernetes RBAC 拒绝: ${what}`, {
      hint: f.verb && f.resource ? `为 ${f.user ?? '当前身份'} 授予 ${f.verb} ${f.resource}${f.group ? `（apiGroup ${f.group}）` : ''} 权限（Role/RoleBinding）` : '检查 Role/RoleBinding',
      details: { ...details, rbac: f },
    });
  }
  if (status === 404) return new WorkError('NOT_FOUND', `Kubernetes 对象或 API 不存在 (${where})${msg ? `: ${msg}` : ''}`, { details });
  if (status === 409) return new WorkError('CONFLICT', `Kubernetes 报告冲突 (${where}): ${msg}`, { details });
  if (status === 400 || status === 422) return new WorkError('INVALID_ARGUMENT', `Kubernetes 拒绝请求 (${where}): ${msg}`, { details });
  return new WorkError('UPSTREAM_UNAVAILABLE', `Kubernetes API 返回 HTTP ${status} (${where})${msg ? `: ${msg}` : ''}`, { details });
}

export function mapKubeTransportError(e: unknown, endpointId: string): WorkError {
  if (e instanceof WorkError) return e;
  const err = e as NodeJS.ErrnoException;
  if (err?.name === 'TimeoutError') return new WorkError('TIMEOUT', `Kubernetes API 调用超时 (${endpointId})`, { hint: '增大 --timeout' });
  const code = err?.code;
  if (code && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|DEPTH_ZERO/.test(code)) {
    return new WorkError('UPSTREAM_UNAVAILABLE', `Kubernetes API TLS 校验失败 (${code}, ${endpointId})`, { hint: '配置 ca_file 或 kubeconfig 中的 certificate-authority-data', details: { code } });
  }
  return new WorkError('UPSTREAM_UNAVAILABLE', `Kubernetes API 不可达 (${code ?? err?.message ?? 'unknown'}, ${endpointId})`, {
    hint: '确认 server 地址、网络与 API server 状态',
    details: { code: code ?? null },
  });
}

// ---------------------------------------------------------------------------
// quantities and label selectors
// ---------------------------------------------------------------------------
const SUFFIX: Record<string, number> = {
  n: 1e-9, u: 1e-6, m: 1e-3, '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
  Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6,
};

/** Kubernetes resource.Quantity → number (cores for CPU, bytes for memory). */
export function parseQuantity(q: string | number | undefined | null): number | null {
  if (q === undefined || q === null || q === '') return null;
  if (typeof q === 'number') return q;
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(Ki|Mi|Gi|Ti|Pi|Ei|n|u|m|k|K|M|G|T|P|E)?$/.exec(q.trim());
  if (!m) return null;
  return Number(m[1]) * SUFFIX[m[2] ?? ''];
}

export interface LabelSelectorSpec {
  matchLabels?: Record<string, string>;
  matchExpressions?: { key: string; operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist'; values?: string[] }[];
}

// label key: optional DNS-subdomain prefix + '/' + name (≤63); value: empty or ≤63 alnum with -_. inside
const LABEL_NAME = /^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$/;
const LABEL_PREFIX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const LABEL_VALUE = /^([A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?)?$/;

export function validLabelKey(k: string): boolean {
  const i = k.lastIndexOf('/');
  if (i < 0) return LABEL_NAME.test(k);
  const prefix = k.slice(0, i);
  return prefix.length <= 253 && LABEL_PREFIX.test(prefix) && LABEL_NAME.test(k.slice(i + 1));
}

export function validLabelValue(v: string): boolean {
  return LABEL_VALUE.test(v);
}

/**
 * metav1.LabelSelector → the string form accepted by `?labelSelector=`. Keys and values are
 * validated (the selector syntax has no escaping): a value such as `a,env!=prod` from a binding
 * file would otherwise change the meaning of the selector.
 */
export function selectorString(sel: LabelSelectorSpec): string {
  const bad: string[] = [];
  for (const [k, v] of Object.entries(sel.matchLabels ?? {})) {
    if (!validLabelKey(k) || !validLabelValue(String(v))) bad.push(`${k}=${v}`);
  }
  for (const e of sel.matchExpressions ?? []) {
    if (!validLabelKey(e.key) || (e.values ?? []).some((v) => !validLabelValue(String(v)))) bad.push(`${e.key} ${e.operator} (${(e.values ?? []).join(',')})`);
  }
  if (bad.length) {
    throw new WorkError('INVALID_ARGUMENT', `标签选择器含不合法的标签键或值: ${bad.join('; ')}`, { hint: '标签值只能是字母数字及 - _ .（≤63 字符），不能包含逗号、空格、= ! ( ) 等' });
  }
  const parts = Object.entries(sel.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`);
  for (const e of sel.matchExpressions ?? []) {
    if (e.operator === 'In') parts.push(`${e.key} in (${(e.values ?? []).join(',')})`);
    else if (e.operator === 'NotIn') parts.push(`${e.key} notin (${(e.values ?? []).join(',')})`);
    else if (e.operator === 'Exists') parts.push(e.key);
    else if (e.operator === 'DoesNotExist') parts.push(`!${e.key}`);
  }
  return parts.join(',');
}

/** Whether labels satisfy a metav1.LabelSelector (empty selector matches everything, as in the API). */
export function selectorMatchesLabels(sel: LabelSelectorSpec, labels: Record<string, string> | undefined): boolean {
  const l = labels ?? {};
  for (const [k, v] of Object.entries(sel.matchLabels ?? {})) if (l[k] !== v) return false;
  for (const e of sel.matchExpressions ?? []) {
    const has = Object.prototype.hasOwnProperty.call(l, e.key);
    if (e.operator === 'In' && !(has && (e.values ?? []).includes(l[e.key]))) return false;
    if (e.operator === 'NotIn' && has && (e.values ?? []).includes(l[e.key])) return false;
    if (e.operator === 'Exists' && !has) return false;
    if (e.operator === 'DoesNotExist' && has) return false;
  }
  return true;
}

export function enc(s: string): string {
  return encodeURIComponent(s);
}

// ---------------------------------------------------------------------------
// API shapes (only the fields read)
// ---------------------------------------------------------------------------
export interface ObjectMeta {
  name: string;
  namespace?: string;
  uid?: string;
  generation?: number;
  resourceVersion?: string;
  creationTimestamp?: string;
  deletionTimestamp?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  ownerReferences?: { kind: string; name: string; uid: string; controller?: boolean }[];
}

export interface KubeContainerSpec {
  name: string;
  image: string;
  ports?: { containerPort: number; protocol?: string; hostPort?: number; hostIP?: string; name?: string }[];
  resources?: { limits?: Record<string, string>; requests?: Record<string, string> };
  readinessProbe?: unknown;
  livenessProbe?: unknown;
  startupProbe?: unknown;
  volumeMounts?: { name: string; mountPath: string; readOnly?: boolean }[];
}

export interface KubeContainerState {
  running?: { startedAt?: string };
  waiting?: { reason?: string; message?: string };
  terminated?: { exitCode: number; reason?: string; message?: string; startedAt?: string; finishedAt?: string; signal?: number };
}

export interface KubeContainerStatus {
  name: string;
  state?: KubeContainerState;
  lastState?: KubeContainerState;
  ready: boolean;
  started?: boolean;
  restartCount: number;
  image: string;
  imageID?: string;
  containerID?: string;
}

export interface KubePod {
  metadata: ObjectMeta;
  spec: {
    nodeName?: string;
    restartPolicy?: string;
    containers: KubeContainerSpec[];
    volumes?: ({ name: string } & Record<string, unknown>)[];
  };
  status: {
    phase?: string;
    reason?: string;
    message?: string;
    podIP?: string;
    hostIP?: string;
    startTime?: string;
    qosClass?: string;
    conditions?: { type: string; status: string; reason?: string; message?: string; lastTransitionTime?: string }[];
    containerStatuses?: KubeContainerStatus[];
  };
}

export interface KubeWorkload {
  kind?: string;
  metadata: ObjectMeta;
  spec: {
    replicas?: number;
    paused?: boolean;
    selector: LabelSelectorSpec;
    template: { metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> }; spec?: { containers?: KubeContainerSpec[] } };
    progressDeadlineSeconds?: number;
    strategy?: { type?: string };
    updateStrategy?: { type?: string };
  };
  status?: {
    observedGeneration?: number;
    replicas?: number;
    updatedReplicas?: number;
    readyReplicas?: number;
    availableReplicas?: number;
    unavailableReplicas?: number;
    currentRevision?: string;
    updateRevision?: string;
    conditions?: { type: string; status: string; reason?: string; message?: string; lastUpdateTime?: string }[];
  };
}

export interface KubeList<T> {
  items: T[];
  metadata?: { resourceVersion?: string; continue?: string };
}

export interface KubeEvent {
  metadata: ObjectMeta;
  involvedObject: { kind: string; name: string; namespace?: string; uid?: string; fieldPath?: string };
  reason?: string;
  message?: string;
  type?: string;
  count?: number;
  firstTimestamp?: string | null;
  lastTimestamp?: string | null;
  eventTime?: string | null;
  series?: { count?: number; lastObservedTime?: string } | null;
  source?: { component?: string; host?: string };
  reportingComponent?: string;
  reportingInstance?: string;
}

export interface PodMetrics {
  metadata: ObjectMeta;
  timestamp: string;
  window: string;
  containers: { name: string; usage: { cpu?: string; memory?: string } }[];
}

export interface KubeNode {
  metadata: ObjectMeta;
  status: { capacity?: Record<string, string>; allocatable?: Record<string, string>; nodeInfo?: { containerRuntimeVersion?: string; kubeletVersion?: string } };
}
