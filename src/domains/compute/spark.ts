import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { httpJson } from '../../core/http';
import { source, WorkError, type Source } from '../../core/output';
import type { Ctx, Endpoint } from '../../core/runtime';

export const SPARK_HISTORY_ADAPTER = 'spark-history-rest';
export const SPARK_LOG_ADAPTER = 'spark-driver-log-dir';
export const COMPUTE_GUIDE = 'docs/guides/compute.md';

const APP_ID_RE = /^[A-Za-z0-9_\-]{3,128}$/;

export function checkAppId(id: string): string {
  if (!APP_ID_RE.test(id)) throw new WorkError('INVALID_ARGUMENT', `Spark application id 格式不正确: ${id}`, { hint: '形如 local-1792239950565 或 application_1700000000000_0001' });
  return id;
}

const versionCache = new WeakMap<Ctx, Promise<string | undefined>>();

/** Spark monitoring REST API served by the history server (/api/v1). */
export class SparkHistory {
  readonly ep: Endpoint;
  readonly base: string;

  constructor(readonly ctx: Ctx, name?: string) {
    this.ep = ctx.endpoint('spark', name);
    this.base = `${this.ep.require('history_url').replace(/\/+$/, '')}/api/v1`;
  }

  async get<T = any>(path: string, query?: Record<string, string>): Promise<T> {
    const qs = query && Object.keys(query).length ? `?${new URLSearchParams(query)}` : '';
    this.ctx.debug(`spark-history GET ${path}${qs}`);
    return (await httpJson<T>(this.ctx, `${this.base}${path}${qs}`)).body;
  }

  async getOrNull<T = any>(path: string): Promise<T | null> {
    const r = await httpJson<T>(this.ctx, `${this.base}${path}`, { allowStatus: [404] });
    return r.status === 404 ? null : r.body;
  }

  /** History server version (GET /api/v1/version). */
  version(): Promise<string | undefined> {
    let p = versionCache.get(this.ctx);
    if (!p) {
      p = this.get<{ spark?: string }>('/version').then((v) => v?.spark, () => undefined);
      versionCache.set(this.ctx, p);
    }
    return p;
  }

  async source(method: string, version?: string, relation: Source['relation'] = 'explicit'): Promise<Source> {
    return source('spark', SPARK_HISTORY_ADAPTER, { endpoint: this.ep.id, method, version: version ?? (await this.version()), relation });
  }

  /** Application or a precise error that distinguishes "not loaded yet" from "no event log". */
  async application(appId: string): Promise<any> {
    const app = await this.getOrNull(`/applications/${encodeURIComponent(appId)}`);
    if (app) return app;
    const eventDir = this.ep.path('event_log_dir');
    const evt = eventDir && existsSync(eventDir) ? readdirSync(eventDir).find((f) => f.startsWith(appId)) : undefined;
    const driverLog = driverLogPath(this.ep, appId);
    if (evt) {
      throw new WorkError('DATA_UNAVAILABLE', `history server 尚未加载应用 ${appId}（事件日志 ${evt} 已存在）`, {
        hint: 'history server 按 spark.history.fs.update.interval 周期扫描事件日志，稍后重试',
      });
    }
    if (driverLog) {
      throw new WorkError('COLLECTION_DISABLED', `应用 ${appId} 有 driver 日志但没有事件日志，history server 无法提供作业/阶段信息`, {
        hint: '提交时开启 spark.eventLog.enabled=true 且 spark.eventLog.dir 指向 history server 读取的目录',
        details: { driver_log: driverLog },
      });
    }
    throw new WorkError('NOT_FOUND', `Spark history server 中没有应用 ${appId}`, { hint: '确认 application id；应用可能运行在其他集群或事件日志已清理' });
  }
}

/** <driver_log_dir>/<app_id>.log (symlink while the app is running). */
export function driverLogPath(ep: Endpoint, appId: string): string | null {
  const dir = ep.path('driver_log_dir');
  if (!dir) return null;
  const p = join(dir, `${appId}.log`);
  return existsSync(p) ? p : null;
}

export function tailFile(path: string, limit: number, maxBytes = 4 * 1024 * 1024): { lines: string[]; total_lines: number | null; truncated: boolean; bytes: number; real_path: string } {
  const real = realpathSync(path);
  const st = statSync(real);
  let text: string;
  let partial = false;
  if (st.size > maxBytes) {
    const buf = readFileSync(real);
    text = buf.subarray(buf.length - maxBytes).toString('utf8');
    text = text.slice(text.indexOf('\n') + 1);
    partial = true;
  } else text = readFileSync(real, 'utf8');
  const all = text.split('\n');
  if (all.length && all[all.length - 1] === '') all.pop();
  const lines = all.slice(-limit);
  return { lines, total_lines: partial ? null : all.length, truncated: partial || all.length > lines.length, bytes: st.size, real_path: real };
}

/** Status of an application, derived from attempts + job states (history server has no final status for local apps). */
export function deriveStatus(app: any, jobs: any[]): { status: 'running' | 'succeeded' | 'failed' | 'incomplete'; basis: string } {
  const attempt = (app.attempts ?? [])[0] ?? {};
  const failedJobs = jobs.filter((j) => j.status === 'FAILED').length;
  const runningJobs = jobs.filter((j) => j.status === 'RUNNING').length;
  if (attempt.completed) {
    return failedJobs
      ? { status: 'failed', basis: `应用已结束（attempt.completed=true），${failedJobs} 个作业失败` }
      : { status: 'succeeded', basis: '应用已结束（attempt.completed=true）且没有失败作业；history server 不记录驱动进程退出码' };
  }
  const idleMs = Date.now() - Number(attempt.lastUpdatedEpoch ?? Date.parse(attempt.lastUpdated ?? '') ?? 0);
  if (runningJobs || idleMs < 10 * 60_000) return { status: 'running', basis: `事件日志仍在写入（in-progress），${runningJobs} 个作业运行中` };
  return { status: 'incomplete', basis: `事件日志未正常结束且 ${Math.round(idleMs / 60000)} 分钟无更新：驱动可能被终止或崩溃` };
}
