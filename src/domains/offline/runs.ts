import { z } from 'zod';
import { source, type Envelope, type Source } from '../../core/output';
import type { Ctx } from '../../core/runtime';
import { AirflowClient, sparkAppIds } from './airflow';
import { loadOfflineCatalog, partitionSpec, tablesProducedBy, type OfflineCatalog, type OfflineTableMeta } from './catalog';
import { businessInterval, dateInZone, durationSeconds, matchInterval, requireTimeZone, timePair, type BusinessInterval, type IntervalMatch } from './time';

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
 * [D 00:00 - 1d, D+1 00:00 + 1d] — a manual run triggered during D+1 without an explicit
 * interval gets the inferred interval [D, D+1) but a logical date after D+1 00:00, so the
 * upper bound must extend past the end of the day too. Runs of DAGs with intervals longer
 * than one day may still be missed (stated in coverage).
 */
export async function runsForBusinessDate(af: AirflowClient, dagId: string, iv: BusinessInterval, limit = 100) {
  const gte = new Date(iv.startMs - 86_400_000).toISOString();
  const lte = new Date(iv.endMs + 86_400_000).toISOString();
  // REST v1 filters on execution_date, v2 (Airflow 3) on logical_date; `query` is reported as actually sent
  const query =
    af.apiVersion === 'v2'
      ? { logical_date_gte: gte, logical_date_lte: lte, order_by: '-logical_date', limit }
      : { execution_date_gte: gte, execution_date_lte: lte, order_by: '-execution_date', limit };
  const r = await af.get<{ dag_runs: any[]; total_entries: number }>(`/dags/${encodeURIComponent(dagId)}/dagRuns`, query);
  const all = [...(r.dag_runs ?? [])];
  let total = Number(r.total_entries ?? all.length);
  let truncated = total > all.length;
  if (af.apiVersion === 'v2') {
    // Airflow 3 runs may have logical_date = null (still with a data interval inferred from
    // run_after); a logical_date filter never returns them, so look them up by run_after too —
    // otherwise backfill would see "no run" for a date such a run already processed.
    const extra = await af.get<{ dag_runs: any[]; total_entries: number }>(`/dags/${encodeURIComponent(dagId)}/dagRuns`, { run_after_gte: gte, run_after_lte: lte, order_by: '-run_after', limit });
    const seen = new Set(all.map((x) => x.dag_run_id));
    const nullLogical = (extra.dag_runs ?? []).filter((x) => (x.logical_date === null || x.logical_date === undefined) && !seen.has(x.dag_run_id));
    all.push(...nullLogical);
    total += nullLogical.length;
    if (Number(extra.total_entries ?? 0) > (extra.dag_runs ?? []).length) truncated = true;
  }
  const matched: { run: any; match: IntervalMatch }[] = [];
  for (const run of all) {
    const rs = Date.parse(run.data_interval_start ?? run.logical_date ?? run.execution_date);
    const re = Date.parse(run.data_interval_end ?? run.logical_date ?? run.execution_date);
    const m = matchInterval(rs, re, iv.startMs, iv.endMs);
    if (m) matched.push({ run, match: m });
  }
  return { matched, scanned: all.length, total, query, window: { gte, lte }, truncated };
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

/** Context used to judge whether a stored quality result still describes the partition. */
export interface QualityFreshnessInput {
  /** Partition write evidence (data.partition.get updated_at). */
  partitionUpdatedAt?: string | null;
  partitionState?: string | null;
  /** End of the scheduler run that should have produced the partition. */
  runEndDate?: string | null;
}

/**
 * stale=true when the stored check predates the partition's last write, or the partition is
 * missing and the check predates the end of the run (the check describes an earlier state).
 * null when there is no basis for comparison.
 */
export function qualityStaleness(checkedAt: string | null | undefined, f: QualityFreshnessInput): { stale: boolean | null; stale_reason?: string } {
  const c = checkedAt ? Date.parse(checkedAt) : NaN;
  if (!Number.isFinite(c)) return { stale: null, stale_reason: '检查时间未知，无法判断是否过期' };
  const upd = f.partitionUpdatedAt ? Date.parse(f.partitionUpdatedAt) : NaN;
  if (f.partitionState === 'missing') {
    const end = f.runEndDate ? Date.parse(f.runEndDate) : NaN;
    if (Number.isFinite(end)) {
      return c < end
        ? { stale: true, stale_reason: `分区缺失，且检查时间 ${checkedAt} 早于 run 结束时间 ${f.runEndDate}：结果描述的是 run 之前的状态` }
        : { stale: false };
    }
    return { stale: null, stale_reason: '分区缺失且 run 未结束，无法判断检查结果是否过期' };
  }
  if (Number.isFinite(upd)) {
    return c < upd ? { stale: true, stale_reason: `检查时间 ${checkedAt} 早于分区最近写入 ${f.partitionUpdatedAt}：分区已被重写，结果可能已失效` } : { stale: false };
  }
  return { stale: null, stale_reason: '没有分区更新时间证据，无法判断检查结果是否过期' };
}

const MAX_FAILED_RULES = 5;

/** Latest stored data quality result (written by `data quality check`). Never throws. */
export async function qualityLayer(ctx: Ctx, table: string, partition: string, freshness: QualityFreshnessInput = {}): Promise<LayerState> {
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
      table,
      partition,
      detail: `没有 ${table}/${partition} 的质量检查记录（用 workctl data quality check 运行）`,
      source: source('workctl-state', 'data-quality-store', { method: 'readLatestQualityResult', relation: 'derived' }),
    };
  }
  const results: any[] = Array.isArray(r.results) ? r.results : [];
  const clip = (v: unknown) => {
    const t = String(v ?? '');
    return t.length > 300 ? `${t.slice(0, 300)}…` : t;
  };
  const bad = results.filter((x) => x?.status === 'fail' || x?.status === 'error');
  const failedRules = bad.slice(0, MAX_FAILED_RULES).map((x) => ({ rule: String(x.id ?? x.type ?? 'unknown'), type: String(x.type ?? 'unknown'), status: String(x.status), severity: x.severity ?? null, message: clip(x.message) }));
  const skipped = results.filter((x) => x?.status === 'skipped');
  const skippedReason = skipped.length
    ? r.precondition && r.precondition.ok === false
      ? `${skipped.length} 条规则被跳过：前置条件不满足（分区 ${r.precondition.partition_state ?? 'unknown'}${r.precondition.reason ? `：${r.precondition.reason}` : ''}）`
      : `${skipped.length} 条规则被跳过：${clip(skipped[0].message)}`
    : null;
  const st = qualityStaleness(r.checked_at, freshness);
  return {
    state: String(r.quality_state ?? 'unknown'),
    table: r.dataset?.table ?? table,
    partition: r.partition ?? partition,
    checked_at: r.checked_at ?? null,
    conclusive: r.conclusive ?? null,
    ruleset: r.ruleset?.name ?? null,
    ...(r.summary ? { summary: r.summary } : {}),
    failed_rules: failedRules,
    ...(bad.length > failedRules.length ? { failed_rules_truncated: bad.length - failedRules.length } : {}),
    skipped_reason: skippedReason,
    ...(r.precondition?.partition_state ? { partition_state_at_check: r.precondition.partition_state } : {}),
    stale: st.stale,
    ...(st.stale_reason ? { stale_reason: st.stale_reason } : {}),
    detail: `最近一次检查 ${r.checked_at ?? '(时间未知)'}${st.stale === true ? '；结果已过期（见 stale_reason）' : st.stale === null ? '；无法判断是否过期，注意与分区更新时间比较' : ''}`,
    source: source('workctl-state', 'data-quality-store', { method: 'readLatestQualityResult', observed_at: r.checked_at ?? new Date().toISOString(), relation: 'derived' }),
  };
}

/** Cap on a task log scanned for Spark app ids (only its tail is kept past it). Tests may lower it. */
export const sparkIdLogLimits = { maxBytes: 16 * 1024 * 1024 };

/** Find Spark application ids recorded by the run's tasks: XCom return_value first, then task logs. */
export async function findSparkApps(
  af: AirflowClient,
  dagId: string,
  runId: string,
  tis: any[],
  /** Receives coverage notes, e.g. a task log too large to read whole (app ids in its dropped head are missed). */
  notes: string[] = [],
): Promise<{ task_id: string; app_id: string; via: string; try_number: number | null }[]> {
  const found: { task_id: string; app_id: string; via: string; try_number: number | null }[] = [];
  for (const ti of tis) {
    if (!ti.try_number || !['success', 'failed', 'running', 'up_for_retry'].includes(ti.state)) continue;
    const base = `/dags/${encodeURIComponent(dagId)}/dagRuns/${encodeURIComponent(runId)}/taskInstances/${encodeURIComponent(ti.task_id)}`;
    // mapped task instances (map_index >= 0) are addressed with ?map_index=N; without it Airflow
    // looks up map_index=-1 and answers 404, hiding the app ids of every mapped Spark task
    const mapQ = typeof ti.map_index === 'number' && ti.map_index >= 0 ? { map_index: ti.map_index } : {};
    const x = await af.request('GET', `${base}/xcomEntries/return_value`, { query: mapQ, allowStatus: [404, 400] });
    const xv = x.status === 200 ? String((x.body as any)?.value ?? '') : '';
    let ids = sparkAppIds(xv);
    let via = 'xcom:return_value';
    if (!ids.length && /Bash|Spark/i.test(String(ti.operator ?? ''))) {
      const tryNo = ti.try_number;
      const lr = await af.request('GET', `${base}/logs/${tryNo}`, { query: { full_content: true, ...mapQ }, accept: 'text/plain', allowStatus: [404, 400], tail: true, maxBytes: sparkIdLogLimits.maxBytes });
      if (lr.status === 200) {
        // a byte-cut v1 tail starts mid-line (v2 NDJSON tails are already cut at a message boundary)
        ids = sparkAppIds(lr.truncated && af.apiVersion !== 'v2' ? lr.text.slice(lr.text.indexOf('\n') + 1) : lr.text);
        if (lr.truncated) {
          notes.push(`任务 ${ti.task_id} 第 ${tryNo} 次尝试的日志共 ${lr.bytes ?? '?'} 字节，超过读取上限，只扫描了末尾部分：只出现在被丢弃的日志开头的 Spark 应用 ID 可能缺失`);
        }
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
/**
 * Business timezone of a workflow, one rule for every offline capability (docs/guides/offline.md §1):
 * explicit --timezone, else the DAG's own timezone (Airflow `timezone`, also served as
 * `Timezone('X')` by some 2.x versions), else the endpoint's default `timezone`.
 */
export function businessTimeZone(dag: { timezone?: unknown } | null | undefined, endpointTz: string | undefined, input?: string | null): string {
  if (input) return requireTimeZone(input);
  const raw = typeof dag?.timezone === 'string' ? dag.timezone.trim().replace(/^Timezone\(['"]?(.*?)['"]?\)$/, '$1') : '';
  if (raw) {
    try {
      return requireTimeZone(raw);
    } catch {
      // unknown/non-IANA DAG timezone: fall back to the endpoint default
    }
  }
  return requireTimeZone(endpointTz || 'UTC');
}

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
