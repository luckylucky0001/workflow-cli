import { createHash } from 'node:crypto';
import { basicAuth, httpJson, type HttpResponse } from '../../core/http';
import { source, WorkError, type Source } from '../../core/output';
import type { Ctx, Endpoint } from '../../core/runtime';

export const AIRFLOW_ADAPTER = 'airflow-rest-v1';
export const AIRFLOW_AUTH = 'airflow-basic';
export const OFFLINE_GUIDE = 'docs/guides/offline.md';

const ID_RE = /^[A-Za-z0-9_.\-~:+]+$/;

export function checkId(v: string, flag: string): string {
  if (!v || !ID_RE.test(v) || v.length > 250) throw new WorkError('INVALID_ARGUMENT', `${flag} 含非法字符: ${v}`);
  return v;
}

const versionCache = new WeakMap<Ctx, Map<string, Promise<string | undefined>>>();

/**
 * Airflow stable REST API (v1) client bound to one profile endpoint.
 * Credentials come from `password_ref`; they never appear in sources or errors.
 */
export class AirflowClient {
  readonly ep: Endpoint;
  readonly base: string;
  readonly timezone: string;
  private readonly auth: string;

  constructor(
    readonly ctx: Ctx,
    name?: string,
  ) {
    this.ep = ctx.endpoint('airflow', name);
    const url = this.ep.require('url').replace(/\/+$/, '');
    const apiVersion = this.ep.str('api_version', 'v1');
    if (apiVersion !== 'v1') {
      throw new WorkError('UNSUPPORTED', `Airflow API 版本 ${apiVersion} 尚未接入（当前适配 stable REST API v1，Airflow 2.x）`);
    }
    this.base = `${url}/api/v1`;
    this.timezone = this.ep.str('timezone', 'UTC');
    const user = this.ep.str('username');
    const pw = this.ep.secret('password');
    if (!user || pw === undefined) {
      throw new WorkError('UNAUTHENTICATED', `Airflow 端点 ${this.ep.id} 缺少 username 或 password_ref`, {
        hint: `在 profile 的 endpoints.airflow.${this.ep.name} 中配置 username 与 password_ref: file:... / env:...`,
      });
    }
    this.auth = basicAuth(user, pw);
  }

  async request<T = any>(method: string, path: string, opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; accept?: string; allowStatus?: number[] } = {}): Promise<HttpResponse<T>> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) qs.set(k, String(v));
    const url = `${this.base}${path}${qs.size ? `?${qs}` : ''}`;
    this.ctx.debug(`airflow ${method} ${path}${qs.size ? `?${qs}` : ''}`);
    try {
      return await httpJson<T>(this.ctx, url, {
        method,
        headers: { authorization: this.auth, ...(opts.accept ? { accept: opts.accept } : {}) },
        body: opts.body,
        allowStatus: opts.allowStatus,
      });
    } catch (e) {
      if (e instanceof WorkError && e.code === 'UNAUTHENTICATED') {
        throw new WorkError('UNAUTHENTICATED', `Airflow 认证失败 (${this.ep.id})`, {
          hint: '检查 username / password_ref；Airflow 需启用 basic_auth API 后端（[api] auth_backends）',
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

  /** Actual Airflow version from GET /api/v1/version (cached per invocation). */
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

  async source(method: string, relation: Source['relation'] = 'explicit'): Promise<Source> {
    return source('airflow', AIRFLOW_ADAPTER, { endpoint: this.ep.id, method, version: await this.version(), relation });
  }

  // ------------------------------------------------------------------ helpers

  async dag(dagId: string): Promise<any> {
    const d = await this.getOrNull(`/dags/${encodeURIComponent(dagId)}/details`);
    if (!d) throw new WorkError('NOT_FOUND', `Airflow 中没有 DAG ${dagId}`, { hint: '用 Airflow UI 或 GET /api/v1/dags 确认 dag_id；DAG 文件可能有导入错误' });
    return d;
  }

  async tasks(dagId: string): Promise<any[]> {
    const r = await this.get<{ tasks: any[] }>(`/dags/${encodeURIComponent(dagId)}/tasks`);
    return r.tasks ?? [];
  }

  async dagRun(dagId: string, runId: string): Promise<any | null> {
    return this.getOrNull(`/dags/${encodeURIComponent(dagId)}/dagRuns/${encodeURIComponent(runId)}`);
  }

  async taskInstances(dagId: string, runId: string): Promise<any[]> {
    const r = await this.get<{ task_instances: any[] }>(`/dags/${encodeURIComponent(dagId)}/dagRuns/${encodeURIComponent(runId)}/taskInstances`, { limit: 100 });
    return r.task_instances ?? [];
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
    if (token) {
      const r = await this.request('GET', `/dagSources/${encodeURIComponent(token)}`, { accept: 'text/plain', allowStatus: [404] });
      if (r.status === 200 && r.text) sha = createHash('sha256').update(r.text).digest('hex');
    }
    return {
      source_sha256: sha,
      file_token: token,
      fileloc: dag.fileloc ?? null,
      last_parsed_time: dag.last_parsed_time ?? null,
      basis: 'source_sha256 = sha256(GET /api/v1/dagSources/{file_token})，即调度器当前解析到的 DAG 文件内容；file_token 只标识文件位置，不代表内容版本',
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
