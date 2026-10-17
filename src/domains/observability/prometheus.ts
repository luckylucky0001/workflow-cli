import { httpJson, safeUrl } from '../../core/http';
import { source, WorkError, type Source } from '../../core/output';
import type { Ctx, Endpoint } from '../../core/runtime';

export const PROM_ADAPTER = 'prometheus-http-api';

export interface CatalogEntry {
  name: string;
  description: string | null;
  query: string;
  unit: string | null;
}

interface PromResponse<T> {
  status: 'success' | 'error';
  data?: T;
  errorType?: string;
  error?: string;
  warnings?: string[];
  infos?: string[];
}

export interface MatrixSeries {
  metric: Record<string, string>;
  values?: [number, string][];
}

export class PromClient {
  private versionP?: Promise<string | undefined>;
  constructor(
    readonly ep: Endpoint,
    readonly baseUrl: string,
    private readonly ctx: Ctx,
  ) {}

  async get<T>(path: string, params: Record<string, string> = {}): Promise<{ data: T; warnings: string[] }> {
    const qs = new URLSearchParams(params).toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;
    let res;
    try {
      res = await httpJson<PromResponse<T>>(this.ctx, url, { allowStatus: [400, 422, 503] });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (e instanceof WorkError) throw e;
      if (['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(err?.code ?? '')) {
        throw new WorkError('UPSTREAM_UNAVAILABLE', `Prometheus 不可达 (${err.code}, ${safeUrl(this.baseUrl)})`, {
          hint: '确认 Prometheus 已启动（demo: docker compose up -d prometheus），以及 endpoints.prometheus.<name>.url',
        });
      }
      if (err?.name === 'TimeoutError') throw new WorkError('TIMEOUT', 'Prometheus 查询超时', { hint: '缩小窗口或增大 --step' });
      throw e;
    }
    const body = res.body;
    if (typeof body !== 'object' || body === null) {
      throw new WorkError('UPSTREAM_UNAVAILABLE', `Prometheus 返回非 JSON 响应 (HTTP ${res.status})`);
    }
    if (body.status !== 'success') {
      const msg = `${body.errorType ?? 'error'}: ${body.error ?? '未知错误'}`;
      if (body.errorType === 'bad_data' || res.status === 400) throw new WorkError('INVALID_ARGUMENT', `Prometheus 拒绝查询: ${msg}`, { hint: '检查 PromQL 语法与参数' });
      if (body.errorType === 'timeout') throw new WorkError('TIMEOUT', `Prometheus 查询超时: ${msg}`);
      throw new WorkError('UPSTREAM_UNAVAILABLE', `Prometheus 查询失败: ${msg}`);
    }
    return { data: body.data as T, warnings: [...(body.warnings ?? []), ...(body.infos ?? [])] };
  }

  version(): Promise<string | undefined> {
    this.versionP ??= this.get<{ version: string }>('/api/v1/status/buildinfo')
      .then((r) => r.data.version)
      .catch(() => undefined);
    return this.versionP;
  }

  async source(method: string, relation: Source['relation'] = 'explicit'): Promise<Source> {
    const v = await this.version();
    return source('prometheus', PROM_ADAPTER, { endpoint: `${this.ep.id} (${safeUrl(this.baseUrl)})`, method, relation, ...(v ? { version: v } : {}) });
  }
}

export function promClient(ctx: Ctx, name?: string): PromClient {
  const ep = ctx.endpoint('prometheus', name);
  return new PromClient(ep, ep.require('url').replace(/\/$/, ''), ctx);
}

export function catalog(ep: Endpoint): CatalogEntry[] {
  const raw = ep.obj<Record<string, { description?: string; query?: string; unit?: string }>>('metrics') ?? {};
  return Object.entries(raw)
    .filter(([, v]) => v && typeof v.query === 'string')
    .map(([name, v]) => ({ name, description: v.description ?? null, query: String(v.query), unit: v.unit ?? null }));
}

const SAFE_LABEL_VALUE = /^[A-Za-z0-9._:-]+$/;

/** Render a catalog template; `$service` (and `$resource`) are replaced by the resource id. */
export function renderQuery(template: string, resource: string): string {
  if (!SAFE_LABEL_VALUE.test(resource)) {
    throw new WorkError('INVALID_ARGUMENT', `资源 ID 含不允许的字符: ${resource}`, { hint: '只允许字母、数字和 . _ : -' });
  }
  return template.replaceAll('$service', resource).replaceAll('$resource', resource);
}

export interface SeriesSummary {
  points: number;
  nan_points: number;
  /** +Inf / -Inf samples (e.g. histogram_quantile above the largest finite bucket); not NaN, not missing. */
  inf_points: number;
  min: number | null;
  max: number | null;
  avg: number | null;
  last: number | null;
  last_at: string | null;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Converts Prometheus sample values ("NaN", "+Inf", numbers) to number|null and summarises them. */
export function summarize(values: [number, string][]): { points: [string, number | null][]; summary: SeriesSummary } {
  const points: [string, number | null][] = [];
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let n = 0;
  let nan = 0;
  let inf = 0;
  let last: number | null = null;
  let lastAt: string | null = null;
  for (const [t, v] of values) {
    const at = new Date(t * 1000).toISOString();
    // Prometheus encodes infinities as "+Inf" / "-Inf", which Number() parses as NaN
    const num = v === '+Inf' || v === 'Inf' ? Infinity : v === '-Inf' ? -Infinity : Number(v);
    if (!Number.isFinite(num)) {
      // Prometheus encodes +Inf/-Inf as strings; they are real (unbounded) values, not missing data
      if (num === Infinity || num === -Infinity) inf++;
      else nan++;
      points.push([at, null]);
      continue;
    }
    points.push([at, round6(num)]);
    min = Math.min(min, num);
    max = Math.max(max, num);
    sum += num;
    n++;
    last = round6(num);
    lastAt = at;
  }
  return {
    points,
    summary: {
      points: values.length,
      nan_points: nan,
      inf_points: inf,
      min: n ? round6(min) : null,
      max: n ? round6(max) : null,
      avg: n ? round6(sum / n) : null,
      last,
      last_at: lastAt,
    },
  };
}
