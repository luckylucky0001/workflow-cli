import { z } from 'zod';
import { source, type Envelope, type Source } from '../../core/output';
import type { Ctx } from '../../core/runtime';
import { AirflowClient, sparkAppIds } from './airflow';
import { loadOfflineCatalog, partitionSpec, tablesProducedBy, type OfflineCatalog, type OfflineTableMeta } from './catalog';
import { businessInterval, dateInZone, durationSeconds, matchInterval, timePair, type BusinessInterval, type IntervalMatch } from './time';

export const TimePairSchema = z.object({ utc: z.string(), local: z.string() }).nullable();

export const RunSchema = z.object({
  run_id: z.string(),
  state: z.string().nullable().describe('Airflow DAG run 状态: queued/running/success/failed'),
  run_type: z.string().nullable().describe('scheduled / manual / backfill / dataset_triggered'),
  external_trigger: z.boolean().nullable(),
  business_date: z.string().nullable().describe('data_interval_start 在业务时区的日期'),
  match: z.string().optional().describe('与查询业务日期区间的关系 exact/contained/covers/overlaps'),
  logical_date: TimePairSchema,
  data_interval: z.object({ start: TimePairSchema, end: TimePairSchema }),
  queued_at: TimePairSchema,
  start_date: TimePairSchema,
  end_date: TimePairSchema,
  duration_seconds: z.number().nullable(),
  last_scheduling_decision: TimePairSchema,
  conf: z.record(z.string(), z.unknown()).nullable(),
  note: z.string().nullable(),
});
export type RunView = z.infer<typeof RunSchema>;

export function normRun(run: any, tz: string, match?: IntervalMatch): RunView {
  const dis = run.data_interval_start ?? null;
  return {
    run_id: String(run.dag_run_id ?? run.run_id),
    state: run.state ?? null,
    run_type: run.run_type ?? null,
    external_trigger: run.external_trigger ?? null,
    business_date: dis ? dateInZone(Date.parse(dis), tz) : null,
    ...(match ? { match } : {}),
    logical_date: timePair(run.logical_date ?? run.execution_date, tz),
    data_interval: { start: timePair(dis, tz), end: timePair(run.data_interval_end, tz) },
    queued_at: timePair(run.queued_at, tz),
    start_date: timePair(run.start_date, tz),
    end_date: timePair(run.end_date, tz),
    duration_seconds: durationSeconds(run.start_date, run.end_date),
    last_scheduling_decision: timePair(run.last_scheduling_decision, tz),
    conf: run.conf && typeof run.conf === 'object' ? run.conf : null,
    note: run.note ?? null,
  };
}

/**
 * DAG runs whose data interval intersects the business day. Queries logical dates in
 * [D-1d, D+1d] — runs of DAGs with intervals longer than one day may be missed (stated in coverage).
 */
export async function runsForBusinessDate(af: AirflowClient, dagId: string, iv: BusinessInterval, limit = 100) {
  const query = {
    execution_date_gte: new Date(iv.startMs - 86_400_000).toISOString(),
    execution_date_lte: new Date(iv.endMs).toISOString(),
    order_by: '-execution_date',
    limit,
  };
  const r = await af.get<{ dag_runs: any[]; total_entries: number }>(`/dags/${encodeURIComponent(dagId)}/dagRuns`, query);
  const all = r.dag_runs ?? [];
  const matched: { run: any; match: IntervalMatch }[] = [];
  for (const run of all) {
    const rs = Date.parse(run.data_interval_start ?? run.logical_date ?? run.execution_date);
    const re = Date.parse(run.data_interval_end ?? run.logical_date ?? run.execution_date);
    const m = matchInterval(rs, re, iv.startMs, iv.endMs);
    if (m) matched.push({ run, match: m });
  }
  return { matched, scanned: all.length, total: r.total_entries ?? all.length, query, truncated: (r.total_entries ?? all.length) > all.length };
}

// ---------------------------------------------------------------------------
// Cross-domain layers (output partition, quality, compute)
// ---------------------------------------------------------------------------

export interface LayerState {
  state: string;
  detail?: string;
  source: Source | null;
  [k: string]: unknown;
}

export const LayerSchema = z.looseObject({ state: z.string(), detail: z.string().optional(), source: z.any().nullable() });

function envSource(env: Envelope, fallback: string, preferSystem?: string): Source {
  const preferred = preferSystem ? env.meta.sources.find((s) => s.system === preferSystem) : undefined;
  return preferred ?? env.meta.sources[0] ?? source('workctl', fallback, { method: `ctx.call(${env.capability})`, relation: 'derived' });
}

/** Partition state through `data.partition.get` (data domain). Never throws. */
export async function partitionLayer(ctx: Ctx, catalogName: string | undefined, table: string, partition: string): Promise<LayerState> {
  if (!ctx.registry.get('data.partition.get')) {
    return { state: 'unknown', detail: '当前构建未注册 data.partition.get，无法检查产出分区', source: null };
  }
  const env = await ctx.call('data.partition.get', { ...(catalogName ? { catalog: catalogName } : {}), table, partition });
  if (env.status === 'error') {
    return { state: 'unknown', detail: `data.partition.get 失败: ${env.error?.code} ${env.error?.message}`, source: null, error_code: env.error?.code };
  }
  const d = (env.data ?? {}) as Record<string, any>;
  const pick = (v: any) => (v && typeof v === 'object' ? v.value ?? null : v ?? null);
  const updated = pick(d.checks?.updated_at) ?? pick(d.updated_at) ?? d.last_modified ?? null;
  const detail = d.explanation ?? d.reason ?? d.detail;
  return {
    state: String(d.state ?? 'unknown'),
    ...(detail ? { detail: String(detail) } : {}),
    table,
    partition,
    ...(d.path ? { path: d.path } : {}),
    ...(updated ? { updated_at: updated } : {}),
    via: 'data.partition.get',
    source: envSource(env, 'data.partition.get', 'local-filesystem'),
  };
}

/** Latest stored data quality result (written by `data quality check`). Never throws. */
export async function qualityLayer(ctx: Ctx, table: string, partition: string): Promise<LayerState> {
  let reader: ((stateDir: string, table: string, partition: string) => any) | undefined;
  try {
    const mod: Record<string, unknown> = await import('../data/quality');
    if (typeof mod.readLatestQualityResult === 'function') reader = mod.readLatestQualityResult as typeof reader;
  } catch {
    reader = undefined;
  }
  if (!reader) return { state: 'unknown', detail: '数据域未提供质量结果读取接口', source: null };
  let r: any;
  try {
    r = reader(ctx.stateDir, table, partition);
  } catch (e) {
    return { state: 'unknown', detail: `读取质量结果失败: ${e instanceof Error ? e.message : String(e)}`, source: null };
  }
  if (!r) {
    return {
      state: 'not_run',
      detail: `没有 ${table}/${partition} 的质量检查记录（用 workctl data quality check 运行）`,
      source: source('workctl-state', 'data-quality-store', { method: 'readLatestQualityResult', relation: 'derived' }),
    };
  }
  return {
    state: String(r.quality_state ?? 'unknown'),
    checked_at: r.checked_at ?? null,
    conclusive: r.conclusive ?? null,
    ruleset: r.ruleset?.name ?? null,
    ...(r.summary ? { summary: r.summary } : {}),
    detail: `最近一次检查 ${r.checked_at ?? '(时间未知)'}；结果不会随分区重写自动失效，注意与分区更新时间比较`,
    source: source('workctl-state', 'data-quality-store', { method: 'readLatestQualityResult', observed_at: r.checked_at ?? new Date().toISOString(), relation: 'derived' }),
  };
}

/** Find Spark application ids recorded by the run's tasks: XCom return_value first, then task logs. */
export async function findSparkApps(af: AirflowClient, dagId: string, runId: string, tis: any[]): Promise<{ task_id: string; app_id: string; via: string; try_number: number | null }[]> {
  const found: { task_id: string; app_id: string; via: string; try_number: number | null }[] = [];
  for (const ti of tis) {
    if (!ti.try_number || !['success', 'failed', 'running', 'up_for_retry'].includes(ti.state)) continue;
    const base = `/dags/${encodeURIComponent(dagId)}/dagRuns/${encodeURIComponent(runId)}/taskInstances/${encodeURIComponent(ti.task_id)}`;
    const x = await af.request('GET', `${base}/xcomEntries/return_value`, { allowStatus: [404, 400] });
    const xv = x.status === 200 ? String((x.body as any)?.value ?? '') : '';
    let ids = sparkAppIds(xv);
    let via = 'xcom:return_value';
    if (!ids.length && /Bash|Spark/i.test(String(ti.operator ?? ''))) {
      const tryNo = ti.try_number;
      const lr = await af.request('GET', `${base}/logs/${tryNo}`, { query: { full_content: true }, accept: 'text/plain', allowStatus: [404, 400] });
      if (lr.status === 200) {
        ids = sparkAppIds(lr.text);
        via = `task log try ${tryNo}`;
      }
    }
    for (const id of ids) found.push({ task_id: ti.task_id, app_id: id, via, try_number: ti.try_number ?? null });
  }
  return found;
}

export async function computeLayer(ctx: Ctx, apps: { task_id: string; app_id: string; via: string }[], tis: any[] = []): Promise<LayerState> {
  if (!apps.length) {
    const candidates = tis.filter((t) => /Bash|Spark/i.test(String(t.operator ?? '')));
    const notStarted = candidates.length > 0 && candidates.every((t) => !t.try_number || [null, 'none', 'scheduled', 'queued', 'upstream_failed', 'skipped', 'removed'].includes(t.state ?? null));
    if (notStarted) {
      return {
        state: 'not_started',
        detail: `计算任务尚未执行（${candidates.map((t) => `${t.task_id}=${t.state ?? 'none'}`).join(', ')}）`,
        source: null,
      };
    }
    return { state: 'unknown', detail: '本次 run 的任务未记录 Spark application id（XCom / 任务日志中无 WORKCTL_SPARK_APP_ID）', source: null };
  }
  const last = apps[apps.length - 1];
  if (!ctx.registry.get('compute.job.get')) {
    return { state: 'unknown', app_id: last.app_id, task_id: last.task_id, detail: '未注册 compute.job.get', source: null };
  }
  const env = await ctx.call('compute.job.get', { id: last.app_id });
  if (env.status === 'error') {
    return { state: 'unknown', app_id: last.app_id, task_id: last.task_id, app_id_via: last.via, detail: `compute.job.get 失败: ${env.error?.code} ${env.error?.message}`, source: null };
  }
  const d = env.data as Record<string, any>;
  return {
    state: String(d.status ?? 'unknown'),
    app_id: last.app_id,
    task_id: last.task_id,
    app_id_via: last.via,
    ...(d.status_basis ? { detail: String(d.status_basis) } : {}),
    duration_ms: d.duration_ms ?? null,
    failed_jobs: d.jobs?.failed ?? null,
    ...(apps.length > 1 ? { other_app_ids: apps.slice(0, -1).map((a) => a.app_id) } : {}),
    source: envSource(env, 'compute.job.get'),
  };
}

export interface TargetInfo {
  catalog: OfflineCatalog | null;
  reason?: string;
  tables: OfflineTableMeta[];
}

export function targetsOf(ctx: Ctx, dagId: string): TargetInfo {
  const { catalog, reason } = loadOfflineCatalog(ctx);
  if (!catalog) return { catalog: null, reason, tables: [] };
  const tables = tablesProducedBy(catalog, dagId);
  return { catalog, tables, ...(tables.length ? {} : { reason: `目录中没有 produced_by.workflow=${dagId} 的表` }) };
}

/** Business date of a run for a target table: data_interval_start in the table's partition timezone. */
export function runBusinessDate(run: any, tz: string): string | null {
  const dis = run.data_interval_start ?? run.logical_date ?? run.execution_date;
  return dis ? dateInZone(Date.parse(dis), tz) : null;
}

export function targetPartition(t: OfflineTableMeta, run: any, defaultTz: string) {
  const tz = t.partition_key?.timezone ?? defaultTz;
  const bd = runBusinessDate(run, tz);
  return { table: t.name, partition: bd ? partitionSpec(t, bd) : null, business_date: bd, timezone: tz, write_mode: t.write_mode ?? null };
}

export { businessInterval };
