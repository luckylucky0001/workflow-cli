import YAML from 'yaml';
import { basicAuth, httpJson, safeUrl } from '../../core/http';
import { source, WorkError, type Source } from '../../core/output';
import type { Ctx, Endpoint } from '../../core/runtime';
import { shortId } from '../container/docker';
import { levelRank, parseLogLine, type LogEntry, type LogFilter } from './logs';

/**
 * Loki provider for `log query` / `trace get`. Same entry shape as the Docker path:
 * every Loki line is re-parsed with `parseLogLine` and re-checked with `matches`, so
 * LogQL filters only narrow what is transferred; the final decision is the shared filter.
 */
export const LOKI_ADAPTER = 'loki-http-api';
export type LogProviderKind = 'docker' | 'loki';

export interface LogProviderChoice {
  kind: LogProviderKind;
  /** Loki endpoint name (undefined → profile defaults.loki or the only endpoint). */
  endpoint?: string;
  /** Where the choice came from, for coverage notes. */
  origin: string;
  /** Explicit LogQL stream selector from the binding (`attributes.log_selector`). */
  selector?: string;
}

const PROVIDERS: LogProviderKind[] = ['docker', 'loki'];

/**
 * Which log provider serves a service: binding attribute `log_provider` (+ optional
 * `log_endpoint`, `log_selector`) first, then profile `defaults.logs`, else docker.
 */
export function resolveLogProvider(ctx: Ctx, service: string): LogProviderChoice {
  let attrs: Record<string, unknown> | undefined;
  try {
    attrs = ctx.resources().get(service)?.attributes as Record<string, unknown> | undefined;
  } catch {
    attrs = undefined;
  }
  const check = (v: unknown, where: string): LogProviderKind => {
    const s = String(v);
    if (!PROVIDERS.includes(s as LogProviderKind)) {
      throw new WorkError('NOT_CONFIGURED', `${where}=${s} 不是支持的日志 provider`, { hint: `可选: ${PROVIDERS.join(', ')}` });
    }
    return s as LogProviderKind;
  };
  const selector = typeof attrs?.log_selector === 'string' && attrs.log_selector ? attrs.log_selector : undefined;
  const endpoint = typeof attrs?.log_endpoint === 'string' && attrs.log_endpoint ? attrs.log_endpoint : undefined;
  if (attrs?.log_provider !== undefined && attrs.log_provider !== null && attrs.log_provider !== '') {
    const kind = check(attrs.log_provider, `bindings: ${service}.attributes.log_provider`);
    return { kind, endpoint, selector, origin: `bindings: ${service}.attributes.log_provider=${kind}` };
  }
  const d = ctx.profile?.defaults?.logs;
  if (d) {
    const kind = check(d, `profiles.${ctx.profileName}.defaults.logs`);
    return { kind, endpoint, selector, origin: `profiles.${ctx.profileName}.defaults.logs=${kind}` };
  }
  return { kind: 'docker', origin: '默认 provider（未配置 defaults.logs / attributes.log_provider）' };
}

// ---------------------------------------------------------------------------
// LogQL building
// ---------------------------------------------------------------------------
const SAFE_VALUE = /^[A-Za-z0-9._:-]+$/;
export const DEFAULT_SELECTOR_TEMPLATE = '{service="$service"}';

/** Quote a string as a LogQL (Go) string literal; JSON string escaping is a subset of Go's. */
export function logqlString(s: string): string {
  return JSON.stringify(s);
}

/**
 * Stream selector for a service. `labels` is either a template string such as
 * `{service="$service", env="$env"}` or a map `{service: $service, env: $env}`.
 */
export function renderSelector(labels: unknown, service: string, env: string | null): string {
  if (!SAFE_VALUE.test(service)) throw new WorkError('INVALID_ARGUMENT', `服务名含不允许的字符: ${service}`);
  let tpl: string;
  if (labels === undefined || labels === null || labels === '') tpl = DEFAULT_SELECTOR_TEMPLATE;
  else if (typeof labels === 'string') tpl = labels.trim();
  else if (typeof labels === 'object' && !Array.isArray(labels)) {
    const parts = Object.entries(labels as Record<string, unknown>).map(([k, v]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new WorkError('NOT_CONFIGURED', `Loki labels 映射中的标签名不合法: ${k}`);
      return `${k}=${logqlString(String(v))}`;
    });
    if (!parts.length) throw new WorkError('NOT_CONFIGURED', 'Loki labels 映射为空');
    tpl = `{${parts.join(', ')}}`;
  } else throw new WorkError('NOT_CONFIGURED', 'Loki labels 须为字符串模板或标签映射');
  if (!/^\{.*\}$/s.test(tpl)) throw new WorkError('NOT_CONFIGURED', `Loki labels 模板须是流选择器 {…}: ${tpl}`);
  if (tpl.includes('$env')) {
    if (!env) throw new WorkError('NOT_CONFIGURED', 'Loki labels 模板引用了 $env，但 profile 没有 env 且未指定 --env');
    if (!SAFE_VALUE.test(env)) throw new WorkError('INVALID_ARGUMENT', `env 含不允许的字符: ${env}`);
  }
  return tpl.replaceAll('$service', service).replaceAll('$env', env ?? '');
}

const PINO: Record<string, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const LEVEL_NAMES = ['trace', 'debug', 'info', 'notice', 'warn', 'warning', 'error', 'err', 'fatal', 'critical', 'panic'];

/** Regex (fully anchored by LogQL) of `level` values whose rank is ≥ min, incl. pino numeric levels. */
export function levelRegex(minLevel: string): string {
  const min = levelRank(minLevel) ?? 0;
  const names = LEVEL_NAMES.filter((n) => (levelRank(n) ?? -1) >= min);
  const nums = Object.entries(PINO)
    .filter(([n]) => (levelRank(n) ?? -1) >= min)
    .map(([, v]) => String(v));
  return `(?i)(${[...names, ...nums].join('|')})`;
}

/** Extracted-label names used in the pipelines (prefixed to avoid clashing with stream labels). */
const L_LEVEL = 'workctl_level';
const L_KIND = 'workctl_kind';

/**
 * LogQL for a log query. Line filters (`|=`) for --contains / --trace-id, then one `| json`
 * stage that extracts only level/kind for --level and the span exclusion.
 */
export function buildLogQuery(selector: string, f: LogFilter): string {
  const parts = [selector];
  if (f.traceId) parts.push(`|= ${logqlString(f.traceId)}`);
  if (f.contains) parts.push(`|= ${logqlString(f.contains)}`);
  const needJson = !!f.minLevel || !f.includeSpans;
  if (needJson) parts.push(`| json ${L_LEVEL}="level", ${L_KIND}="kind"`);
  if (f.minLevel) parts.push(`| ${L_LEVEL}=~${logqlString(levelRegex(f.minLevel))}`);
  if (!f.includeSpans) parts.push(`| ${L_KIND}!="span"`);
  return parts.join(' ');
}

const DROP_ERR = '| drop __error__, __error_details__';

/** Metric queries (instant, range = window) that yield the stats the Docker path counts while scanning. */
export function buildStatQueries(selector: string, f: LogFilter, rangeS: number): Record<'scanned' | 'matched' | 'unparsed' | 'spans', string> {
  const r = `[${rangeS}s]`;
  // matched: same filters as the log query, grouped by container and level (for by_level)
  let matched = buildLogQuery(selector, f);
  if (!matched.includes('| json ')) matched += ` | json ${L_LEVEL}="level", ${L_KIND}="kind"`;
  return {
    scanned: `sum by (container, container_id) (count_over_time(${selector}${r}))`,
    matched: `sum by (container, container_id, ${L_LEVEL}) (count_over_time(${matched} ${DROP_ERR}${r}))`,
    unparsed: `sum(count_over_time(${selector} | json ${L_KIND}="kind" | __error__="JSONParserErr" ${DROP_ERR}${r}))`,
    spans: `sum(count_over_time(${selector} | json ${L_KIND}="kind" | ${L_KIND}="span" ${DROP_ERR}${r}))`,
  };
}

// ---------------------------------------------------------------------------
// time helpers
// ---------------------------------------------------------------------------
export function isoToNs(iso: string): bigint {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new WorkError('INVALID_ARGUMENT', `无法解析时间: ${iso}`);
  return BigInt(ms) * 1_000_000n;
}

/** Nanosecond epoch → RFC3339 with a fixed 9-digit fraction (the form Docker's timestamps=1 uses). */
export function nsToIso(ns: string | bigint): string {
  const b = BigInt(ns);
  const sec = b / 1_000_000_000n;
  const frac = (b % 1_000_000_000n).toString().padStart(9, '0');
  return `${new Date(Number(sec) * 1000).toISOString().slice(0, 19)}.${frac}Z`;
}

/** Loki/Prometheus style durations: 72h, 3d, 1w, 1h30m, 0s. Returns ms. */
export function parseLokiDuration(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  const re = /(\d+(?:\.\d+)?)(ms|y|w|d|h|m|s)/g;
  const mult: Record<string, number> = { ms: 1, s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7, w: 6.048e8, y: 3.1536e10 };
  let total = 0;
  let consumed = 0;
  for (const m of s.matchAll(re)) {
    total += Number(m[1]) * mult[m[2]];
    consumed += m[0].length;
  }
  return consumed === s.length && consumed > 0 ? total : null;
}

// ---------------------------------------------------------------------------
// client
// ---------------------------------------------------------------------------
export interface LokiStream {
  stream: Record<string, string>;
  values: [string, string][];
}
export interface LokiVectorSample {
  metric: Record<string, string>;
  value: [number, string];
}
interface LokiResponse<T> {
  status: string;
  data: T;
}

const NET_CODES = ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'];

export class LokiClient {
  private versionP?: Promise<string | undefined>;
  constructor(
    readonly ep: Endpoint,
    readonly baseUrl: string,
    private readonly ctx: Ctx,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = {};
    const tenant = this.ep.str('tenant');
    if (tenant) h['X-Scope-OrgID'] = tenant;
    const user = this.ep.str('username');
    if (user) {
      const pw = this.ep.secret('password');
      if (pw === undefined) throw new WorkError('UNAUTHENTICATED', `端点 ${this.ep.id} 配置了 username 但缺少 password_ref`);
      h.authorization = basicAuth(user, pw);
    }
    return h;
  }

  /** GET with Loki-specific error mapping. Loki error bodies are plain text. */
  async get<T = unknown>(path: string, params: Record<string, string> | [string, string][] = {}, opts: { timeoutMs?: number; text?: boolean } = {}): Promise<T> {
    const qs = new URLSearchParams(params).toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;
    let res;
    try {
      res = await httpJson<unknown>(this.ctx, url, {
        headers: this.headers(),
        allowStatus: [400, 401, 403, 404, 429, 500, 502, 503, 504],
        ...(opts.timeoutMs ? { timeoutMs: Math.min(opts.timeoutMs, this.ctx.remainingMs()) } : {}),
      });
    } catch (e) {
      if (e instanceof WorkError) throw e;
      const err = e as NodeJS.ErrnoException;
      const code = err?.code ?? (err?.cause as NodeJS.ErrnoException | undefined)?.code ?? '';
      if (NET_CODES.includes(code)) {
        throw new WorkError('UPSTREAM_UNAVAILABLE', `Loki 不可达 (${code}, ${safeUrl(this.baseUrl)})`, {
          hint: '确认 Loki 已启动（demo: docker compose up -d loki promtail），以及 endpoints.loki.<name>.url',
        });
      }
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new WorkError('TIMEOUT', 'Loki 查询超时', { hint: '缩小 --window 或增大 --timeout' });
      throw e;
    }
    const detail = res.text.trim().slice(0, 300);
    const where = `${safeUrl(url)}`;
    if (res.status === 400) throw new WorkError('INVALID_ARGUMENT', `Loki 拒绝查询: ${detail}`, { hint: '检查 LogQL（labels 映射、过滤条件）', details: { status: 400 } });
    if (res.status === 401) throw new WorkError('UNAUTHENTICATED', `Loki 认证失败 (${where})`, { hint: '检查 username / password_ref', details: { status: 401 } });
    if (res.status === 403) throw new WorkError('PERMISSION_DENIED', `Loki 拒绝访问 (${where})`, { hint: '检查 tenant（X-Scope-OrgID）与账号权限', details: { status: 403 } });
    if (res.status === 404) throw new WorkError('UPSTREAM_UNAVAILABLE', `Loki API 路径不存在 (${where})`, { hint: 'url 是否指向 Loki（含路径前缀）', details: { status: 404 } });
    if (res.status === 429) throw new WorkError('UPSTREAM_UNAVAILABLE', `Loki 限流 (HTTP 429): ${detail}`, { hint: '稍后重试或缩小窗口', details: { status: 429 } });
    if (res.status >= 500) throw new WorkError('UPSTREAM_UNAVAILABLE', `Loki 返回 HTTP ${res.status}: ${detail}`, { details: { status: res.status } });
    if (opts.text) return res.text as T;
    const body = res.body as LokiResponse<unknown> | string;
    if (typeof body !== 'object' || body === null) throw new WorkError('UPSTREAM_UNAVAILABLE', `Loki 返回非 JSON 响应 (HTTP ${res.status}, ${where})`);
    return body as T;
  }

  async queryRange(query: string, startNs: bigint, endNs: bigint, limit: number, direction: 'backward' | 'forward'): Promise<LokiStream[]> {
    const r = await this.get<LokiResponse<{ resultType: string; result: LokiStream[] }>>('/loki/api/v1/query_range', {
      query,
      start: startNs.toString(),
      end: endNs.toString(),
      limit: String(limit),
      direction,
    });
    if (r.status !== 'success') throw new WorkError('UPSTREAM_UNAVAILABLE', `Loki query_range 状态 ${r.status}`);
    if (r.data.resultType !== 'streams') throw new WorkError('UPSTREAM_UNAVAILABLE', `Loki 返回的结果类型是 ${r.data.resultType}，预期 streams`);
    return r.data.result ?? [];
  }

  async instant(query: string, timeNs: bigint): Promise<LokiVectorSample[]> {
    const r = await this.get<LokiResponse<{ resultType: string; result: LokiVectorSample[] }>>('/loki/api/v1/query', { query, time: timeNs.toString() });
    if (r.data.resultType !== 'vector') throw new WorkError('UPSTREAM_UNAVAILABLE', `Loki 返回的结果类型是 ${r.data.resultType}，预期 vector`);
    return r.data.result ?? [];
  }

  async series(selector: string, startNs: bigint, endNs: bigint): Promise<Record<string, string>[]> {
    const r = await this.get<LokiResponse<Record<string, string>[]>>('/loki/api/v1/series', [
      ['match[]', selector],
      ['start', startNs.toString()],
      ['end', endNs.toString()],
    ]);
    return r.data ?? [];
  }

  version(): Promise<string | undefined> {
    this.versionP ??= this.get<{ version?: string }>('/loki/api/v1/status/buildinfo', {}, { timeoutMs: 5000 })
      .then((b) => b.version)
      .catch(() => undefined);
    return this.versionP;
  }

  async ready(): Promise<{ ok: boolean; detail: string }> {
    try {
      const t = await this.get<string>('/ready', {}, { timeoutMs: 5000, text: true });
      return { ok: /ready/i.test(t), detail: t.trim().slice(0, 200) };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Effective look-back limit: endpoint `retention` if configured, else Loki's own
   * limits_config (retention_period / max_query_lookback from GET /config). Best effort.
   */
  async lookback(): Promise<{ ms: number | null; origin: string }> {
    const cfg = parseLokiDuration(this.ep.str('retention'));
    if (cfg) return { ms: cfg, origin: `endpoints.loki.${this.ep.name}.retention` };
    try {
      const text = await this.get<string>('/config', {}, { timeoutMs: 3000, text: true });
      const doc = YAML.parse(text) as { limits_config?: Record<string, unknown> } | null;
      const lc = doc?.limits_config ?? {};
      const vals = [parseLokiDuration(lc.retention_period), parseLokiDuration(lc.max_query_lookback)].filter((x): x is number => !!x && x > 0);
      if (!vals.length) return { ms: null, origin: 'Loki /config（未设置保留期）' };
      return { ms: Math.min(...vals), origin: 'Loki /config limits_config' };
    } catch {
      return { ms: null, origin: '未知（Loki /config 不可读）' };
    }
  }

  async source(method: string, relation: Source['relation'] = 'explicit'): Promise<Source> {
    const v = await this.version();
    return source('loki', LOKI_ADAPTER, { endpoint: `${this.ep.id} (${safeUrl(this.baseUrl)})`, method, relation, ...(v ? { version: v } : {}) });
  }
}

export function lokiClient(ctx: Ctx, name?: string): LokiClient {
  const ep = ctx.endpoint('loki', name);
  return new LokiClient(ep, ep.require('url').replace(/\/$/, ''), ctx);
}

// ---------------------------------------------------------------------------
// shared scanning
// ---------------------------------------------------------------------------
export interface LokiLine {
  ns: bigint;
  ts: string;
  line: string;
  labels: Record<string, string>;
}

/** Flatten streams into lines ordered by the query direction (newest first for backward). */
export function flattenStreams(streams: LokiStream[], direction: 'backward' | 'forward'): LokiLine[] {
  const out: LokiLine[] = [];
  for (const s of streams) {
    for (const [ns, line] of s.values ?? []) out.push({ ns: BigInt(ns), ts: nsToIso(ns), line: line.replace(/\r?\n$/, ''), labels: s.stream ?? {} });
  }
  out.sort((a, b) => (a.ns === b.ns ? 0 : a.ns < b.ns ? -1 : 1));
  return direction === 'backward' ? out.reverse() : out;
}

export function containerOf(labels: Record<string, string>): string {
  return labels.container ?? labels.container_name ?? labels.service ?? '(无 container 标签)';
}

export function streamOf(labels: Record<string, string>): { stream: 'stdout' | 'stderr'; known: boolean } {
  if (labels.stream === 'stderr') return { stream: 'stderr', known: true };
  if (labels.stream === 'stdout') return { stream: 'stdout', known: true };
  return { stream: 'stdout', known: false };
}

/** Parse a Loki line exactly like a Docker `timestamps=1` line (`<ts> <content>`). */
export function toEntry(l: LokiLine): { entry: LogEntry; full: string; streamKnown: boolean } {
  const { stream, known } = streamOf(l.labels);
  const full = `${l.ts} ${l.line}`;
  return { entry: parseLogLine(full, containerOf(l.labels), stream), full, streamKnown: known };
}

export interface PagedResult {
  matched: LogEntry[];
  fetched: number;
  pages: number;
  exhausted: boolean;
  streamUnknown: number;
  clientRejected: number;
  labels: Map<string, Record<string, string>>;
  stoppedAtSameTimestamp: boolean;
}

/**
 * Page through query_range until `want` entries passed the shared filter or the
 * window is exhausted. Boundaries are inclusive and de-duplicated (Loki's end is exclusive).
 */
export async function pagedQuery(
  loki: LokiClient,
  query: string,
  win: { startNs: bigint; endNs: bigint },
  direction: 'backward' | 'forward',
  want: number,
  accept: (e: LogEntry, full: string) => boolean,
  opts: { pageSize?: number; maxPages?: number } = {},
): Promise<PagedResult> {
  const out: PagedResult = { matched: [], fetched: 0, pages: 0, exhausted: false, streamUnknown: 0, clientRejected: 0, labels: new Map(), stoppedAtSameTimestamp: false };
  const seen = new Set<string>();
  let start = win.startNs;
  let end = win.endNs;
  const maxPages = opts.maxPages ?? 20;
  while (out.pages < maxPages) {
    const size = Math.min(opts.pageSize ?? 5000, Math.max(1, want - out.matched.length));
    const streams = await loki.queryRange(query, start, end, size, direction);
    out.pages++;
    const lines = flattenStreams(streams, direction);
    let fresh = 0;
    for (const l of lines) {
      const key = `${l.ns}|${JSON.stringify(l.labels)}|${l.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fresh++;
      out.fetched++;
      const { entry, full, streamKnown } = toEntry(l);
      if (!streamKnown) out.streamUnknown++;
      out.labels.set(`${l.labels.container ?? ''}|${l.labels.container_id ?? ''}`, l.labels);
      if (accept(entry, full)) out.matched.push(entry);
      else out.clientRejected++;
      if (out.matched.length >= want) break;
    }
    if (out.matched.length >= want) break;
    if (lines.length < size) {
      out.exhausted = true;
      break;
    }
    if (!fresh) {
      // a full page of lines sharing one timestamp: cannot move the boundary further
      out.stoppedAtSameTimestamp = true;
      break;
    }
    const edge = lines[lines.length - 1].ns;
    if (direction === 'backward') end = edge + 1n;
    else start = edge;
  }
  return out;
}

/** Sum vector samples by a label key. */
export function sumBy(samples: LokiVectorSample[], key: (m: Record<string, string>) => string): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of samples) {
    const k = key(s.metric ?? {});
    out.set(k, (out.get(k) ?? 0) + Number(s.value?.[1] ?? 0));
  }
  return out;
}

const PINO_NAMES: Record<string, string> = { '10': 'trace', '20': 'debug', '30': 'info', '40': 'warn', '50': 'error', '60': 'fatal' };

/** Normalise an extracted `level` value the way parseLogLine does (lower case, pino numbers). */
export function normaliseLevel(v: string | undefined): string {
  if (!v) return 'unknown';
  if (/^\d+$/.test(v)) return PINO_NAMES[v] ?? v;
  return v.toLowerCase();
}

export const LEVEL_LABEL = L_LEVEL;
