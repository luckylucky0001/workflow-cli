import { createHash } from 'node:crypto';
import { httpJson } from '../../core/http';
import { WorkError } from '../../core/output';
import type { Ctx } from '../../core/runtime';

/**
 * Airflow 3.x public REST API (v2) compatibility layer.
 *
 * Capabilities address Airflow with the v1 route table and consume v1-shaped objects. For an
 * `api_version: v2` endpoint the client (airflow.ts) sends every call through the functions below:
 *   - auth: username/password → POST /auth/token → `Authorization: Bearer <JWT>` (cached per process)
 *   - routes/queries: v1 path + query → v2 path + query (`toV2Route`)
 *   - responses: v2 payloads → the v1 shape the capabilities already read (`normalizeV2`)
 * The output contract of the capabilities therefore stays the same; only `meta.sources`
 * (adapter `airflow-rest-v2`, method `GET /api/v2/...`, actual version 3.x) shows the difference.
 * Every derived field is listed in docs/guides/offline.md (Airflow 2 / Airflow 3 section).
 */

// ---------------------------------------------------------------------------
// auth: JWT from POST /auth/token
// ---------------------------------------------------------------------------

interface CachedToken {
  token: string;
  /** epoch ms; refresh 60 s before */
  exp: number;
}

const tokenCache = new Map<string, Promise<CachedToken>>();

function jwtExpiry(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
    if (typeof payload.exp === 'number') return payload.exp * 1000;
  } catch {
    /* opaque token */
  }
  return Date.now() + 10 * 60_000;
}

/** Bearer token for (url, user). Cached per process; `force` drops the cached one (after a 401). */
export async function airflowToken(ctx: Ctx, url: string, user: string, password: string, force = false): Promise<string> {
  // the password digest is part of the key so a rotated password never reuses an old token
  const key = `${url}|${user}|${createHash('sha256').update(password).digest('hex').slice(0, 16)}`;
  let p = force ? undefined : tokenCache.get(key);
  if (p) {
    const t = await p.catch(() => undefined);
    if (t && t.exp - 60_000 > Date.now()) return t.token;
  }
  p = (async () => {
    ctx.debug(`airflow POST /auth/token (user ${user})`);
    const r = await httpJson<{ access_token?: string }>(ctx, `${url}/auth/token`, {
      method: 'POST',
      body: { username: user, password },
      allowStatus: [400, 401, 403, 404, 405],
    });
    if (r.status === 404 || r.status === 405) {
      throw new WorkError('UNAUTHENTICATED', `Airflow 端点 ${url} 没有 POST /auth/token`, {
        hint: 'Airflow 3 的 SimpleAuthManager / FAB auth manager 提供 /auth/token；其他 auth manager 请在端点配置 token_ref',
        details: { status: r.status, stage: 'auth/token' },
      });
    }
    if (r.status >= 400 || !r.body?.access_token) {
      throw new WorkError('UNAUTHENTICATED', `Airflow 令牌获取失败（POST /auth/token 返回 HTTP ${r.status}）`, {
        hint: '检查 username / password_ref 与 Airflow auth manager 中的用户',
        details: { status: r.status, stage: 'auth/token' },
      });
    }
    return { token: r.body.access_token, exp: jwtExpiry(r.body.access_token) };
  })();
  tokenCache.set(key, p);
  p.catch(() => tokenCache.delete(key));
  return (await p).token;
}

/** For tests. */
export function clearAirflowTokenCache(): void {
  tokenCache.clear();
}

// ---------------------------------------------------------------------------
// routes and queries
// ---------------------------------------------------------------------------

type Query = Record<string, string | number | boolean | undefined>;

const QUERY_RENAMES: Record<string, string> = {
  execution_date_gte: 'logical_date_gte',
  execution_date_lte: 'logical_date_lte',
  execution_date_gt: 'logical_date_gt',
  execution_date_lt: 'logical_date_lt',
};

/**
 * v1 route + query → v2 route + query. Paths are relative to the API base.
 * - GET /dags?only_active=true → exclude_stale=true (Airflow 3 replaced is_active by is_stale)
 * - dagRuns: execution_date_* → logical_date_*, order_by=-execution_date → -logical_date
 * - /dagSources/{file_token} is keyed by dag_id in v2 (handled by the client's codeVersion)
 */
export function toV2Route(path: string, query: Query = {}): { path: string; query: Query } {
  const q: Query = {};
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    if (k === 'only_active') {
      if (v === true || v === 'true') q.exclude_stale = true;
      continue;
    }
    if (k === 'order_by' && typeof v === 'string') {
      q.order_by = v.replace(/execution_date/g, 'logical_date');
      continue;
    }
    q[QUERY_RENAMES[k] ?? k] = v;
  }
  return { path, query: q };
}

/** Rewrite a provenance method written against v1 (`GET /api/v1/...`) to the v2 route actually called. */
export function toV2Method(method: string): string {
  return method.replace(/\/api\/v1\//g, '/api/v2/').replace('/dagSources/{file_token}', '/dagSources/{dag_id}');
}

// ---------------------------------------------------------------------------
// response normalisation (v2 → v1 shape)
// ---------------------------------------------------------------------------

const CRON_RE = /^(@\w+|(\S+\s+){4}\S+|(\S+\s+){5}\S+)$/;

/** ISO 8601 duration (pydantic timedelta, e.g. "PT1800S", "P1DT2H") → v1 TimeDelta object. */
export function isoDurationToTimedelta(v: unknown): { __type: 'TimeDelta'; days: number; seconds: number; microseconds: number } | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return v as any;
  const m = /^(-)?P(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(v));
  if (!m) return null;
  const sign = m[1] ? -1 : 1;
  const total = sign * ((Number(m[2] ?? 0) * 7 + Number(m[3] ?? 0)) * 86400 + Number(m[4] ?? 0) * 3600 + Number(m[5] ?? 0) * 60 + Number(m[6] ?? 0));
  const days = Math.floor(total / 86400);
  const rest = total - days * 86400;
  const seconds = Math.floor(rest);
  return { __type: 'TimeDelta', days, seconds, microseconds: Math.round((rest - seconds) * 1e6) };
}

/** v2 params `{name: {value, schema, description, source}}` → v1 serialized Param `{__class, value, ...}`. */
function normParamsV2(p: any): any {
  if (!p || typeof p !== 'object') return p ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    const o = v as any;
    out[k] = o && typeof o === 'object' && ('value' in o || 'schema' in o) && !('__class' in o)
      ? { __class: 'airflow.sdk.definitions.param.Param', value: o.value ?? null, description: o.description ?? null, schema: o.schema ?? null }
      : o;
  }
  return out;
}

export function normDagV2(d: any): any {
  if (!d || typeof d !== 'object') return d;
  const summary: string | null = d.timetable_summary ?? null;
  return {
    ...d,
    // v2 has no schedule_interval; timetable_summary is the cron expression / timetable summary
    schedule_interval: summary === null ? null : { __type: CRON_RE.test(summary.trim()) ? 'CronExpression' : 'Timetable', value: summary },
    // Airflow 3 replaced is_active with is_stale (inverted)
    is_active: typeof d.is_stale === 'boolean' ? !d.is_stale : (d.is_active ?? null),
    next_dagrun: d.next_dagrun ?? d.next_dagrun_logical_date ?? null,
    next_dagrun_create_after: d.next_dagrun_create_after ?? d.next_dagrun_run_after ?? null,
    dag_run_timeout: isoDurationToTimedelta(d.dag_run_timeout),
    params: normParamsV2(d.params),
  };
}

export function normTaskV2(t: any): any {
  if (!t || typeof t !== 'object') return t;
  return {
    ...t,
    // Airflow 3 serializes retry_exponential_backoff as a number (0 = off); the contract is "enabled?"
    retry_exponential_backoff: typeof t.retry_exponential_backoff === 'number' ? t.retry_exponential_backoff > 0 : (t.retry_exponential_backoff ?? null),
    execution_timeout: isoDurationToTimedelta(t.execution_timeout),
    retry_delay: isoDurationToTimedelta(t.retry_delay),
  };
}

const EXTERNAL_TRIGGERS = new Set(['cli', 'operator', 'rest_api', 'ui', 'test']);
const INTERNAL_TRIGGERS = new Set(['timetable', 'asset', 'dataset', 'backfill']);

export function normRunV2(r: any): any {
  if (!r || typeof r !== 'object') return r;
  const by = typeof r.triggered_by === 'string' ? r.triggered_by.toLowerCase() : null;
  return {
    ...r,
    // v2 has no execution_date; logical_date may be null (runs triggered without a logical date)
    execution_date: r.execution_date ?? r.logical_date ?? null,
    // v2 dropped external_trigger: derived from triggered_by (fallback run_type)
    external_trigger:
      r.external_trigger ??
      (by && EXTERNAL_TRIGGERS.has(by) ? true : by && INTERNAL_TRIGGERS.has(by) ? false : r.run_type === 'manual' ? true : r.run_type ? false : null),
  };
}

export function normTiV2(ti: any): any {
  if (!ti || typeof ti !== 'object') return ti;
  return { ...ti, execution_date: ti.execution_date ?? ti.logical_date ?? null };
}

/** v2 log response `{content: StructuredLogMessage[] | string[]}` → plain text, one line per message. */
export function structuredLogToText(body: any): string {
  const content = body && typeof body === 'object' ? body.content : body;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const lines: string[] = [];
  for (const m of content) {
    if (typeof m === 'string') {
      lines.push(m);
      continue;
    }
    if (!m || typeof m !== 'object') continue;
    const ev = typeof m.event === 'string' ? m.event : JSON.stringify(m.event ?? '');
    const head = [m.timestamp ? `[${m.timestamp}]` : null, m.level ? String(m.level).toUpperCase() : null, m.logger ?? null].filter(Boolean).join(' ');
    for (const [i, part] of ev.split('\n').entries()) lines.push(i === 0 && head ? `${head} - ${part}` : part);
    if (m.error_detail) lines.push(`  error_detail: ${JSON.stringify(m.error_detail).slice(0, 2000)}`);
  }
  return lines.join('\n') + (lines.length ? '\n' : '');
}

const SEG = '[^/]+';
const RULES: Array<{ re: RegExp; norm: (body: any) => any }> = [
  { re: new RegExp(`^/dags$`), norm: (b) => ({ ...b, dags: (b?.dags ?? []).map(normDagV2) }) },
  { re: new RegExp(`^/dags/${SEG}(/details)?$`), norm: normDagV2 },
  { re: new RegExp(`^/dags/${SEG}/tasks$`), norm: (b) => ({ ...b, tasks: (b?.tasks ?? []).map(normTaskV2) }) },
  { re: new RegExp(`^/dags/${SEG}/tasks/${SEG}$`), norm: normTaskV2 },
  { re: new RegExp(`^/dags/${SEG}/dagRuns$`), norm: (b) => (Array.isArray(b?.dag_runs) ? { ...b, dag_runs: b.dag_runs.map(normRunV2) } : normRunV2(b)) },
  { re: new RegExp(`^/dags/${SEG}/dagRuns/${SEG}$`), norm: normRunV2 },
  { re: new RegExp(`^/dags/${SEG}/dagRuns/${SEG}/taskInstances$`), norm: (b) => ({ ...b, task_instances: (b?.task_instances ?? []).map(normTiV2) }) },
  { re: new RegExp(`^/dags/${SEG}/dagRuns/${SEG}/taskInstances/${SEG}$`), norm: normTiV2 },
  { re: new RegExp(`^/dags/${SEG}/clearTaskInstances$`), norm: (b) => ({ ...b, task_instances: (b?.task_instances ?? []).map(normTiV2) }) },
  {
    re: new RegExp(`^/dags/${SEG}/dagRuns/${SEG}/taskInstances/${SEG}/xcomEntries/${SEG}$`),
    // v1 returns the stored value as a string; v2 returns the deserialized JSON value
    norm: (b) => (b && typeof b === 'object' && 'value' in b && typeof b.value !== 'string' ? { ...b, value: b.value === null ? null : JSON.stringify(b.value) } : b),
  },
];

/** Normalise a v2 JSON body to the v1 shape for the given (v1-addressed) path. Unknown paths pass through. */
export function normalizeV2(path: string, body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  const rule = RULES.find((r) => r.re.test(path));
  return rule ? rule.norm(body) : body;
}

export function isLogPath(path: string): boolean {
  return new RegExp(`^/dags/${SEG}/dagRuns/${SEG}/taskInstances/${SEG}/logs/\\d+$`).test(path);
}
