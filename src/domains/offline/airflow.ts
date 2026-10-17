import { createHash } from 'node:crypto';
import { basicAuth, httpJson, type HttpResponse } from '../../core/http';
import { source, WorkError, type Source } from '../../core/output';
import type { Ctx, Endpoint } from '../../core/runtime';
import { airflowToken, isLogPath, normalizeV2, structuredLogToText, toV2Method, toV2Route } from './airflow-v2';

export type AirflowApiVersion = 'v1' | 'v2';
/** Adapter per REST API version; the one actually used is recorded in every source (meta.sources[].adapter). */
export const AIRFLOW_ADAPTERS: Record<AirflowApiVersion, string> = { v1: 'airflow-rest-v1', v2: 'airflow-rest-v2' };
/** Capability-level adapter (catalog, context.adapter): either API version, chosen by the endpoint's api_version. */
export const AIRFLOW_ADAPTER = 'airflow-rest-v1|v2';
export const AIRFLOW_AUTH = 'airflow-basic|airflow-jwt';
export const OFFLINE_GUIDE = 'docs/guides/offline.md';

const ID_RE = /^[A-Za-z0-9_.\-~:+]+$/;

export function checkId(v: string, flag: string): string {
  if (!v || !ID_RE.test(v) || v.length > 250) throw new WorkError('INVALID_ARGUMENT', `${flag} 含非法字符: ${v}`);
  return v;
}

const versionCache = new WeakMap<Ctx, Map<string, Promise<string | undefined>>>();

/**
 * Airflow REST client bound to one profile endpoint: stable REST API v1 (Airflow 2.x, basic auth) or
 * public REST API v2 (Airflow 3.x, JWT from POST /auth/token). Callers address both with the v1 route
 * table and read v1-shaped objects; for v2 the routes, queries and responses are translated in
 * ./airflow-v2.ts. Credentials come from `password_ref` / `token_ref`; they never appear in sources or errors.
 */
export class AirflowClient {
  readonly ep: Endpoint;
  readonly url: string;
  readonly base: string;
  readonly timezone: string;
  readonly apiVersion: AirflowApiVersion;
  /** Adapter actually used: airflow-rest-v1 / airflow-rest-v2. */
  readonly adapter: string;
  /** `/api/v1` or `/api/v2`, for provenance and plan steps. */
  readonly prefix: string;
  private readonly basic?: string;
  private readonly user?: string;
  private readonly password?: string;
  private readonly staticToken?: string;

  constructor(
    readonly ctx: Ctx,
    name?: string,
  ) {
    this.ep = ctx.endpoint('airflow', name);
    this.url = this.ep.require('url').replace(/\/+$/, '');
    const apiVersion = this.ep.str('api_version', 'v1');
    if (apiVersion !== 'v1' && apiVersion !== 'v2') {
      throw new WorkError('UNSUPPORTED', `Airflow API 版本 ${apiVersion} 尚未接入（已适配 v1 = Airflow 2.x stable REST API，v2 = Airflow 3.x public REST API）`);
    }
    this.apiVersion = apiVersion;
    this.adapter = AIRFLOW_ADAPTERS[apiVersion];
    this.prefix = `/api/${apiVersion}`;
    this.base = `${this.url}${this.prefix}`;
    this.timezone = this.ep.str('timezone', 'UTC');
    const token = apiVersion === 'v2' ? this.ep.secret('token') : undefined;
    if (token) {
      this.staticToken = token;
      return;
    }
    const user = this.ep.str('username');
    const pw = this.ep.secret('password');
    if (!user || pw === undefined) {
      throw new WorkError('UNAUTHENTICATED', `Airflow 端点 ${this.ep.id} 缺少 username 或 password_ref`, {
        hint: `在 profile 的 endpoints.airflow.${this.ep.name} 中配置 username 与 password_ref: file:... / env:...${apiVersion === 'v2' ? '（v2 也可用 token_ref 直接提供令牌）' : ''}`,
      });
    }
    if (apiVersion === 'v1') this.basic = basicAuth(user, pw);
    else {
      this.user = user;
      this.password = pw;
    }
  }

  private async authorization(force: boolean): Promise<string> {
    if (this.basic) return this.basic;
    if (this.staticToken) return `Bearer ${this.staticToken}`;
    return `Bearer ${await airflowToken(this.ctx, this.url, this.user!, this.password!, force)}`;
  }

  /**
   * One REST call. `path` and `query` use the v1 route table; for v2 they are translated and the
   * JSON response is normalised to the v1 shape (task logs come back as text in `text`/`body`).
   */
  async request<T = any>(method: string, path: string, opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; accept?: string; allowStatus?: number[] } = {}): Promise<HttpResponse<T>> {
    const v2 = this.apiVersion === 'v2';
    const route = v2 ? toV2Route(path, opts.query) : { path, query: opts.query ?? {} };
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(route.query)) if (v !== undefined) qs.set(k, String(v));
    const url = `${this.base}${route.path}${qs.size ? `?${qs}` : ''}`;
    // Airflow 3 serves task logs as JSON / NDJSON only (406 for text/plain); converted to text below
    const log = v2 && isLogPath(path);
    const accept = log ? 'application/json' : opts.accept;
    this.ctx.debug(`airflow ${method} ${this.prefix}${route.path}${qs.size ? `?${qs}` : ''}`);
    const send = async (force: boolean) =>
      httpJson<T>(this.ctx, url, {
        method,
        headers: { authorization: await this.authorization(force), ...(accept ? { accept } : {}) },
        body: opts.body,
        allowStatus: opts.allowStatus,
      });
    try {
      let r: HttpResponse<T>;
      try {
        r = await send(false);
      } catch (e) {
        // a cached JWT may have expired or been revoked: fetch a new one once
        if (v2 && !this.staticToken && e instanceof WorkError && e.code === 'UNAUTHENTICATED' && e.details?.stage !== 'auth/token') r = await send(true);
        else throw e;
      }
      if (!v2 || r.status >= 400) return r;
      if (log) {
        const text = structuredLogToText(r.body);
        return { ...r, body: text as T, text };
      }
      return { ...r, body: normalizeV2(path, r.body) as T };
    } catch (e) {
      if (e instanceof WorkError && e.code === 'UNAUTHENTICATED' && e.details?.stage !== 'auth/token') {
        throw new WorkError('UNAUTHENTICATED', `Airflow 认证失败 (${this.ep.id})`, {
          hint: v2
            ? '检查 username / password_ref（Airflow 3 通过 POST /auth/token 换取 JWT）或 token_ref'
            : '检查 username / password_ref；Airflow 需启用 basic_auth API 后端（[api] auth_backends）',
          details: e.details,
        });
      }
      throw e;
    }
  }

  async get<T = any>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    return (await this.request<T>('GET', path, { query })).body;
  }

  /** GET that returns null on 404 instead of throwing. */
  async getOrNull<T = any>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T | null> {
    const r = await this.request<T>('GET', path, { query, allowStatus: [404] });
    return r.status === 404 ? null : r.body;
  }

  /** Actual Airflow version from GET /api/v{1,2}/version (cached per invocation). */
  version(): Promise<string | undefined> {
    let m = versionCache.get(this.ctx);
    if (!m) versionCache.set(this.ctx, (m = new Map()));
    let p = m.get(this.ep.id);
    if (!p) {
      p = this.get<{ version?: string }>('/version').then((v) => v?.version, () => undefined);
      m.set(this.ep.id, p);
    }
    return p;
  }

  /** A provenance method written against v1 (`GET /api/v1/...`), as actually called for this API version. */
  method(m: string): string {
    return this.apiVersion === 'v2' ? toV2Method(m) : m;
  }

  async source(method: string, relation: Source['relation'] = 'explicit'): Promise<Source> {
    return source('airflow', this.adapter, { endpoint: this.ep.id, method: this.method(method), version: await this.version(), relation });
  }

  // ------------------------------------------------------------------ helpers

  async dag(dagId: string): Promise<any> {
    const d = await this.getOrNull(`/dags/${encodeURIComponent(dagId)}/details`);
    if (!d) throw new WorkError('NOT_FOUND', `Airflow 中没有 DAG ${dagId}`, { hint: `用 Airflow UI 或 GET ${this.prefix}/dags 确认 dag_id；DAG 文件可能有导入错误` });
    if (!Array.isArray(d.owners) || d.owners.length === 0) {
      // Airflow 2.10 /details returns owners=[]; the plain DAG endpoint carries them.
      const basic = await this.getOrNull(`/dags/${encodeURIComponent(dagId)}`);
      if (basic?.owners) d.owners = basic.owners;
    }
    return d;
  }

  async tasks(dagId: string): Promise<any[]> {
    const r = await this.get<{ tasks: any[] }>(`/dags/${encodeURIComponent(dagId)}/tasks`);
    return r.tasks ?? [];
  }

  async dagRun(dagId: string, runId: string): Promise<any | null> {
    return this.getOrNull(`/dags/${encodeURIComponent(dagId)}/dagRuns/${encodeURIComponent(runId)}`);
  }

  /**
   * All task instances of a run. Both API versions page at most 100 entries (maximum_page_limit),
   * so mapped tasks / large DAGs need offset paging; capped at `max` entries.
   */
  async taskInstances(dagId: string, runId: string, max = 2000): Promise<any[]> {
    const path = `/dags/${encodeURIComponent(dagId)}/dagRuns/${encodeURIComponent(runId)}/taskInstances`;
    const out: any[] = [];
    for (let offset = 0; offset < max; ) {
      const r = await this.get<{ task_instances: any[]; total_entries?: number }>(path, { limit: 100, offset });
      const page = r.task_instances ?? [];
      out.push(...page);
      offset += page.length;
      if (!page.length || offset >= Number(r.total_entries ?? 0)) break;
    }
    return out;
  }

  /**
   * Locate a run by id. With `dagId` this is one call; otherwise DAGs are scanned
   * (bounded by `maxDags`) and the coverage says so.
   */
  async findRun(runId: string, dagId?: string, maxDags = 100): Promise<{ dagId: string; run: any; scanned: number; complete: boolean }> {
    if (dagId) {
      const run = await this.dagRun(dagId, runId);
      if (!run) throw new WorkError('NOT_FOUND', `DAG ${dagId} 中没有 run ${runId}`, { hint: '用 workctl offline run list --workflow ... --data-date ... 查找 run_id' });
      return { dagId, run, scanned: 1, complete: true };
    }
    const r = await this.get<{ dags: any[]; total_entries: number }>('/dags', { limit: maxDags, only_active: true });
    const dags = r.dags ?? [];
    for (const d of dags) {
      const run = await this.dagRun(d.dag_id, runId);
      if (run) return { dagId: d.dag_id, run, scanned: dags.length, complete: true };
    }
    const complete = (r.total_entries ?? dags.length) <= dags.length;
    throw new WorkError('NOT_FOUND', `在 ${dags.length} 个 DAG 中没有找到 run ${runId}${complete ? '' : '（DAG 数超过检索上限，结果不完整）'}`, {
      hint: '加 --workflow <dag_id> 精确查找',
    });
  }

  /** DAG source as serialized by the scheduler; sha256 of it is the code version we report. */
  async codeVersion(dag: any): Promise<{ source_sha256: string | null; file_token: string | null; fileloc: string | null; last_parsed_time: string | null; basis: string }> {
    const token = dag.file_token ?? null;
    let sha: string | null = null;
    let basis: string;
    if (this.apiVersion === 'v2') {
      // Airflow 3 keys DAG source by dag_id (latest DAG version) and returns JSON {content, version_number}
      const r = await this.request('GET', `/dagSources/${encodeURIComponent(dag.dag_id)}`, { allowStatus: [404] });
      const content = r.status === 200 ? (r.body as any)?.content : null;
      if (typeof content === 'string' && content) sha = createHash('sha256').update(content).digest('hex');
      basis = 'source_sha256 = sha256(GET /api/v2/dagSources/{dag_id} 的 content)，即调度器当前（最新 DAG 版本）解析到的 DAG 文件内容；file_token 只标识文件位置，不代表内容版本';
    } else {
      if (token) {
        const r = await this.request('GET', `/dagSources/${encodeURIComponent(token)}`, { accept: 'text/plain', allowStatus: [404] });
        if (r.status === 200 && r.text) sha = createHash('sha256').update(r.text).digest('hex');
      }
      basis = 'source_sha256 = sha256(GET /api/v1/dagSources/{file_token})，即调度器当前解析到的 DAG 文件内容；file_token 只标识文件位置，不代表内容版本';
    }
    return {
      source_sha256: sha,
      file_token: token,
      fileloc: dag.fileloc ?? null,
      last_parsed_time: dag.last_parsed_time ?? null,
      basis,
    };
  }
}

/** Extract `WORKCTL_SPARK_APP_ID=<id>` markers (and spark-submit "Submitted application" lines) from text. */
export function sparkAppIds(text: string): string[] {
  const ids = new Set<string>();
  for (const m of text.matchAll(/WORKCTL_SPARK_APP_ID=([A-Za-z0-9_\-]+)/g)) ids.add(m[1]);
  for (const m of text.matchAll(/Submitted application (application_\d+_\d+)/g)) ids.add(m[1]);
  return [...ids];
}
