import { z } from 'zod';
import type { Plan, PlanDraft } from '../../core/operations';
import { WorkError, type Result, type Source } from '../../core/output';
import type { Executor, Planner } from '../../core/registry';
import { sleep, type Ctx } from '../../core/runtime';
import { AirflowClient, checkId } from './airflow';
import { catalogSource, downstreamTables, partitionSpec } from './catalog';
import { partitionLayer, runsForBusinessDate, targetsOf } from './runs';
import { businessInterval, dateRange, requireDate, requireTimeZone, timePair } from './time';

const ACTIVE = new Set(['queued', 'running']);
const TERMINAL = new Set(['success', 'failed']);

export type BackfillAction = 'skip_succeeded' | 'skip_in_progress' | 'trigger_new' | 'clear_failed' | 'rerun';

export interface BackfillTargetInput {
  existing: { run_id: string; state: string | null; run_type: string | null; match: string }[];
  rerunSucceeded: boolean;
}

/** Pure decision for one business date (unit-tested). */
export function decideAction(inp: BackfillTargetInput): { action: BackfillAction; run_id: string | null; reason: string } {
  const exact = inp.existing.filter((r) => r.match === 'exact');
  const pool = exact.length ? exact : inp.existing;
  if (!pool.length) return { action: 'trigger_new', run_id: null, reason: '该业务日期没有 run' };
  const active = pool.find((r) => r.state && ACTIVE.has(r.state));
  if (active) return { action: 'skip_in_progress', run_id: active.run_id, reason: `已有在途 run（${active.state}），等待其结束后再评估` };
  const ok = pool.find((r) => r.state === 'success');
  if (ok) {
    return inp.rerunSucceeded
      ? { action: 'rerun', run_id: ok.run_id, reason: '已成功，按 --rerun-succeeded 清理全部任务实例重跑' }
      : { action: 'skip_succeeded', run_id: ok.run_id, reason: '已成功（调度层），默认跳过；如需重跑使用 --rerun-succeeded' };
  }
  const failed = pool.find((r) => r.state === 'failed') ?? pool[0];
  return { action: 'clear_failed', run_id: failed.run_id, reason: `现有 run 状态 ${failed.state ?? 'unknown'}，清理失败任务实例后由调度器重跑` };
}

/** Write-mode safety for actions that rewrite an existing partition (unit-tested). */
export function writeModeCheck(writeMode: string | null, actions: { action: BackfillAction; partition_state: string }[], allowAppend: boolean): { ok: boolean; detail: string } {
  const rewriting = actions.filter((a) => ['rerun', 'clear_failed', 'trigger_new'].includes(a.action) && ['present', 'incomplete', 'empty'].includes(a.partition_state));
  if (!writeMode) return { ok: true, detail: '目录未声明 write_mode，无法判断重跑幂等性（按非幂等对待并人工确认）' };
  if (writeMode === 'overwrite_partition') return { ok: true, detail: 'overwrite_partition：重跑覆盖目标分区，幂等' };
  if (writeMode === 'append') {
    if (!rewriting.length) return { ok: true, detail: 'append：本次动作涉及的分区当前不存在数据，不会重复写入' };
    return allowAppend
      ? { ok: true, detail: `append：${rewriting.length} 个已有数据的分区会被追加写入，已通过 --allow-append-duplicates 明确接受重复风险` }
      : { ok: false, detail: `append：${rewriting.length} 个已有数据的分区重跑会追加重复数据；先清理分区或加 --allow-append-duplicates 明确接受` };
  }
  return { ok: true, detail: `write_mode=${writeMode}` };
}

export const BackfillTargetSchema = z.object({
  business_date: z.string(),
  data_interval: z.object({ start_local: z.string(), end_local: z.string(), start_utc: z.string(), end_utc: z.string() }),
  existing_runs: z.array(z.object({ run_id: z.string(), state: z.string().nullable(), run_type: z.string().nullable(), match: z.string() })),
  action: z.enum(['skip_succeeded', 'skip_in_progress', 'trigger_new', 'clear_failed', 'rerun']),
  run_id: z.string().nullable(),
  reason: z.string(),
  target_partition: z.string().nullable(),
  partition_state: z.string(),
  not_due: z.boolean(),
});

const PlanOut = z.object({
  plan_id: z.string(),
  status: z.string(),
  expires_at: z.string(),
  executable: z.boolean(),
  workflow: z.string(),
  targets: z.array(BackfillTargetSchema),
  impact: z.record(z.string(), z.unknown()),
  preconditions: z.array(z.object({ check: z.string(), ok: z.boolean(), detail: z.string().optional() })),
  steps: z.array(z.object({ name: z.string(), detail: z.string() })),
  next: z.string(),
});
export { PlanOut as BackfillPlanOut };

async function buildDraft(ctx: Ctx, params: Record<string, unknown>): Promise<{ draft: PlanDraft; sources: Source[]; warnings: string[] }> {
  const af = new AirflowClient(ctx, params.airflow_endpoint as string | undefined);
  const dagId = checkId(String(params.workflow), '--workflow');
  const from = requireDate(String(params.from), '--from');
  const to = requireDate(String(params.to), '--to');
  const tz = requireTimeZone(String(params.timezone ?? af.timezone));
  const rerun = params.rerun_succeeded === true || params.rerun_succeeded === 'true';
  const allowAppend = params.allow_append_duplicates === true || params.allow_append_duplicates === 'true';
  const dates = dateRange(from, to, 31);
  const dag = await af.dag(dagId);
  const code = await af.codeVersion(dag);
  const sources: Source[] = [await af.source(`GET /api/v1/dags/${dagId}/details`), await af.source(`GET /api/v1/dags/${dagId}/dagRuns`)];
  const warnings: string[] = [];

  const targets = targetsOf(ctx, dagId);
  const table = targets.tables[0];
  if (targets.catalog) sources.push(catalogSource(targets.catalog, `produced_by.workflow=${dagId}`));
  const now = Date.now();
  const rows: z.infer<typeof BackfillTargetSchema>[] = [];
  for (const d of dates) {
    const iv = businessInterval(d, tz);
    const r = await runsForBusinessDate(af, dagId, iv);
    const existing = r.matched.map((m) => ({ run_id: String(m.run.dag_run_id), state: m.run.state ?? null, run_type: m.run.run_type ?? null, match: m.match }));
    const dec = decideAction({ existing, rerunSucceeded: rerun });
    const spec = table ? partitionSpec(table, d) : null;
    let pstate = 'unknown';
    if (table && spec && targets.catalog) {
      const l = await partitionLayer(ctx, targets.catalog.name, table.name, spec);
      pstate = l.state;
      if (l.source && rows.length === 0) sources.push(l.source);
    }
    rows.push({
      business_date: d,
      data_interval: { start_local: iv.start_local, end_local: iv.end_local, start_utc: iv.start_utc, end_utc: iv.end_utc },
      existing_runs: existing,
      action: dec.action,
      run_id: dec.run_id,
      reason: dec.reason,
      target_partition: spec,
      partition_state: pstate,
      not_due: iv.endMs > now,
    });
  }

  // concurrency budget
  const dagMax = Number(dag.max_active_runs ?? 16);
  const requested = params.max_active_runs !== undefined && params.max_active_runs !== null ? Number(params.max_active_runs) : Math.min(dagMax, 2);
  const active = await Promise.all(['running', 'queued'].map((s) => af.get<{ total_entries: number }>(`/dags/${encodeURIComponent(dagId)}/dagRuns`, { state: s, limit: 1 }).then((x) => x.total_entries ?? 0)));
  const tasks = await af.tasks(dagId);
  const pools = [...new Set(tasks.map((t) => t.pool).filter(Boolean))] as string[];
  const poolInfo = [];
  for (const p of pools) {
    const info = await af.getOrNull(`/pools/${encodeURIComponent(p)}`);
    if (info) poolInfo.push({ pool: p, slots: info.slots, open_slots: info.open_slots, running_slots: info.running_slots, queued_slots: info.queued_slots });
  }
  if (pools.length) sources.push(await af.source('GET /api/v1/pools/{pool}'));

  // downstream impact
  const downstream: { kind: string; id: string; edge_source: string; note?: string }[] = [];
  if (table && targets.catalog) {
    for (const c of table.consumers) downstream.push({ kind: c.type, id: c.id, edge_source: 'catalog-metadata', ...(c.note ? { note: c.note } : {}) });
    for (const t of downstreamTables(targets.catalog, table.name)) downstream.push({ kind: 'table', id: t.name, edge_source: 'catalog-metadata', note: `上游含 ${table.name}` });
  }
  const store = ctx.resources();
  if (store.configured) {
    for (const p of store.relations.filter((x) => x.from === dagId && x.type === 'produces')) {
      for (const c of store.relations.filter((x) => x.to === p.to && x.type === 'reads_from')) {
        if (!downstream.some((d) => d.id === c.from)) downstream.push({ kind: 'workflow', id: c.from, edge_source: 'binding-file', note: `读取 ${p.to}` });
      }
    }
  }

  const actionable = rows.filter((r) => ['trigger_new', 'clear_failed', 'rerun'].includes(r.action));
  const wm = writeModeCheck(table?.write_mode ?? null, actionable.map((a) => ({ action: a.action, partition_state: a.partition_state })), allowAppend);
  const notDue = actionable.filter((r) => r.not_due);
  const preconditions = [
    { check: 'dag_importable', ok: !dag.has_import_errors && dag.is_active !== false, detail: dag.has_import_errors ? 'DAG 有导入错误' : 'DAG 可解析且处于活跃状态' },
    { check: 'dag_not_paused', ok: !dag.is_paused, detail: dag.is_paused ? 'DAG 已暂停：触发的 run 不会被调度，需先恢复（属于变更，需单独授权）' : 'DAG 未暂停' },
    { check: 'write_mode_safe', ok: wm.ok, detail: wm.detail },
    { check: 'intervals_complete', ok: notDue.length === 0, detail: notDue.length ? `业务日期 ${notDue.map((r) => r.business_date).join(', ')} 的数据区间尚未结束` : '所有动作对应的数据区间均已结束' },
    { check: 'has_actions', ok: actionable.length > 0, detail: actionable.length ? `${actionable.length} 个业务日期需要动作` : '没有需要执行的动作（全部跳过）' },
    { check: 'max_active_runs_valid', ok: requested >= 1 && requested <= dagMax, detail: `计划并发 ${requested}，DAG max_active_runs=${dagMax}` },
  ];
  if (!table) warnings.push(`目录中没有 ${dagId} 产出的表：无法检查目标分区与写入模式（${targets.reason ?? ''}）`);
  if (rerun && table?.write_mode !== 'overwrite_partition') warnings.push('要求重跑已成功的日期，但目标表不是 overwrite_partition');

  const counts = rows.reduce<Record<string, number>>((a, r) => ((a[r.action] = (a[r.action] ?? 0) + 1), a), {});
  const draft: PlanDraft = {
    kind: 'offline.backfill',
    title: `补数 ${dagId} ${from}..${to}（${tz}）`,
    params: { workflow: dagId, from, to, timezone: tz, rerun_succeeded: rerun, max_active_runs: requested, allow_append_duplicates: allowAppend, airflow_endpoint: af.ep.name },
    targets: rows,
    impact: {
      workflow: dagId,
      business_dates: dates.length,
      actions: counts,
      target_table: table?.name ?? null,
      write_mode: table?.write_mode ?? null,
      idempotent_rewrite: table?.write_mode === 'overwrite_partition',
      downstream,
      code_version: { ...code, note: '重跑与新触发的 run 使用调度器当前解析的 DAG 代码，而非原 run 当时的代码' },
      concurrency: { planned_max_in_flight: requested, dag_max_active_runs: dagMax, currently_running: active[0], currently_queued: active[1], pools: poolInfo },
    },
    preconditions,
    steps: [
      ...actionable.map((r) => ({
        name: `${r.action} ${r.business_date}`,
        detail:
          r.action === 'trigger_new'
            ? `POST /api/v1/dags/${dagId}/dagRuns logical_date=${r.data_interval.start_utc} data_interval=[${r.data_interval.start_local}, ${r.data_interval.end_local})`
            : `POST /api/v1/dags/${dagId}/clearTaskInstances dag_run_id=${r.run_id} only_failed=${r.action === 'clear_failed'} dry_run=false`,
      })),
      { name: 'throttle', detail: `同时在途的 run 不超过 ${requested} 个；超出时等待已提交的 run 结束` },
    ],
    idempotent: table?.write_mode === 'overwrite_partition',
    cancellable: false,
    rollback: '已触发的 run 可在 Airflow 中标记失败/删除；已覆盖的分区不能自动恢复（overwrite_partition 会替换旧数据）',
    ttlMs: 2 * 3_600_000,
  };
  return { draft, sources, warnings };
}

export const backfillPlanner: Planner = {
  kind: 'offline.backfill',
  summary: '按业务日期区间补数（触发新 run / 清理失败任务实例 / 重跑）',
  plan: async (ctx, params) => (await buildDraft(ctx, params)).draft,
};

export async function backfillPlan(ctx: Ctx, inp: Record<string, any>): Promise<Result> {
  const { draft, sources, warnings } = await buildDraft(ctx, inp);
  const plan = ctx.plans().create(draft, { profile: ctx.profileName, env: ctx.env, executable: true });
  const blocked = plan.preconditions.filter((p) => !p.ok && p.check !== 'has_actions');
  return {
    data: {
      plan_id: plan.id,
      status: plan.status,
      expires_at: plan.expires_at,
      executable: plan.executable,
      workflow: String(draft.params.workflow),
      targets: plan.targets as z.infer<typeof BackfillTargetSchema>[],
      impact: plan.impact,
      preconditions: plan.preconditions,
      steps: plan.steps,
      next: blocked.length
        ? `前置条件未满足（${blocked.map((b) => b.check).join(', ')}），执行会被拒绝`
        : `确认后执行: workctl operation execute --id ${plan.id} --confirm ${plan.id}`,
    },
    sources,
    warnings,
    coverage: { complete: true, scope: `${draft.params.workflow} ${draft.params.from}..${draft.params.to}` },
  };
}

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

function runIdFor(planId: string, date: string): string {
  return `workctl_backfill__${date}__${planId}`;
}

export const backfillExecutor: Executor = async (ctx, plan, report) => {
  const failed = plan.preconditions.filter((p) => !p.ok && p.check !== 'has_actions');
  if (failed.length) {
    throw new WorkError('PRECONDITION_FAILED', `补数计划前置条件未满足: ${failed.map((f) => `${f.check}(${f.detail ?? ''})`).join('; ')}`);
  }
  const af = new AirflowClient(ctx, plan.params.airflow_endpoint as string | undefined);
  const dagId = String(plan.params.workflow);
  const tz = String(plan.params.timezone);
  const maxInFlight = Math.max(1, Number(plan.params.max_active_runs ?? 1));
  const targets = (plan.targets as z.infer<typeof BackfillTargetSchema>[]).filter((t) => ['trigger_new', 'clear_failed', 'rerun'].includes(t.action));
  const submitted: Record<string, unknown>[] = [];
  const skipped: Record<string, unknown>[] = [];
  const notSubmitted: Record<string, unknown>[] = [];
  const inFlight = new Set<string>();

  const refreshInFlight = async () => {
    for (const id of [...inFlight]) {
      const r = await af.dagRun(dagId, id);
      if (!r || TERMINAL.has(r.state)) inFlight.delete(id);
    }
  };

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    await refreshInFlight();
    while (inFlight.size >= maxInFlight) {
      if (ctx.remainingMs() < 15_000) break;
      report(`在途 run ${inFlight.size} 个，达到并发上限 ${maxInFlight}，等待中`);
      await sleep(5000, ctx.signal);
      await refreshInFlight();
    }
    if (inFlight.size >= maxInFlight) {
      for (const rest of targets.slice(i)) notSubmitted.push({ business_date: rest.business_date, action: rest.action, reason: '时间预算内并发槽未释放，未提交；可用 offline backfill plan 重新生成剩余部分' });
      break;
    }
    // re-validate against live state: the plan may be stale
    const iv = businessInterval(t.business_date, tz);
    const live = await runsForBusinessDate(af, dagId, iv);
    const exact = live.matched.filter((m) => m.match === 'exact').map((m) => m.run);
    if (t.action === 'trigger_new') {
      if (exact.length) {
        skipped.push({ business_date: t.business_date, action: t.action, reason: `计划生成后已出现 run ${exact[0].dag_run_id}（${exact[0].state}），未重复触发` });
        continue;
      }
      const runId = runIdFor(plan.id, t.business_date);
      const r = await af.request('POST', `/dags/${encodeURIComponent(dagId)}/dagRuns`, {
        body: { dag_run_id: runId, logical_date: iv.start_utc, data_interval_start: iv.start_utc, data_interval_end: iv.end_utc, conf: {}, note: `workctl backfill plan ${plan.id}` },
      });
      const body = r.body as any;
      inFlight.add(String(body.dag_run_id ?? runId));
      submitted.push({ business_date: t.business_date, action: t.action, run_id: body.dag_run_id ?? runId, state_at_submit: body.state ?? null, logical_date: timePair(body.logical_date ?? iv.start_utc, tz) });
      report(`已触发 ${t.business_date} → ${body.dag_run_id ?? runId}`);
    } else {
      const cur = exact.find((r) => r.dag_run_id === t.run_id) ?? (t.run_id ? await af.dagRun(dagId, t.run_id) : null);
      if (!cur) {
        skipped.push({ business_date: t.business_date, action: t.action, reason: `run ${t.run_id} 已不存在` });
        continue;
      }
      if (ACTIVE.has(cur.state)) {
        skipped.push({ business_date: t.business_date, action: t.action, reason: `run ${t.run_id} 当前为 ${cur.state}，未清理` });
        continue;
      }
      if (t.action === 'clear_failed' && cur.state === 'success') {
        skipped.push({ business_date: t.business_date, action: t.action, reason: `run ${t.run_id} 已变为 success，未清理` });
        continue;
      }
      const r = await af.request('POST', `/dags/${encodeURIComponent(dagId)}/clearTaskInstances`, {
        body: { dry_run: false, dag_run_id: t.run_id, only_failed: t.action === 'clear_failed', reset_dag_runs: true, include_downstream: true, include_upstream: false, include_future: false, include_past: false },
      });
      const cleared = ((r.body as any)?.task_instances ?? []).map((x: any) => x.task_id);
      inFlight.add(String(t.run_id));
      submitted.push({ business_date: t.business_date, action: t.action, run_id: t.run_id, cleared_tasks: cleared });
      report(`已清理 ${t.business_date} run ${t.run_id} 的任务实例: ${cleared.join(', ') || '(无)'}`);
    }
  }
  return { workflow: dagId, max_in_flight: maxInFlight, submitted, skipped, not_submitted: notSubmitted, note: '提交成功只代表调度系统已接受请求；用 workctl offline backfill get --id 查看 run 的实时状态' };
};

// ---------------------------------------------------------------------------
// backfill get
// ---------------------------------------------------------------------------

export async function backfillGet(ctx: Ctx, inp: Record<string, any>): Promise<Result> {
  const plan: Plan = ctx.plans().get(String(inp.id));
  if (plan.kind !== 'offline.backfill') throw new WorkError('INVALID_ARGUMENT', `计划 ${plan.id} 的类型是 ${plan.kind}，不是 offline.backfill`);
  const res = (plan.result ?? null) as any;
  const runs: Record<string, unknown>[] = [];
  const sources: Source[] = [];
  const tz = String(plan.params.timezone ?? 'UTC');
  if (res?.submitted?.length) {
    const af = new AirflowClient(ctx, plan.params.airflow_endpoint as string | undefined);
    for (const s of res.submitted) {
      const r = await af.dagRun(String(plan.params.workflow), String(s.run_id));
      runs.push({ business_date: s.business_date, action: s.action, run_id: s.run_id, live_state: r?.state ?? 'not_found', start_date: timePair(r?.start_date, tz), end_date: timePair(r?.end_date, tz) });
    }
    sources.push(await af.source(`GET /api/v1/dags/${plan.params.workflow}/dagRuns/{run_id}`));
  }
  const progress = runs.reduce<Record<string, number>>((a, r) => ((a[String(r.live_state)] = (a[String(r.live_state)] ?? 0) + 1), a), {});
  return {
    data: {
      plan: { id: plan.id, kind: plan.kind, title: plan.title, status: plan.status, created_at: plan.created_at, expires_at: plan.expires_at, params: plan.params, preconditions: plan.preconditions, history: plan.history, ...(plan.error ? { error: plan.error } : {}) },
      targets: plan.targets,
      execution: res ? { skipped: res.skipped ?? [], not_submitted: res.not_submitted ?? [] } : null,
      runs,
      progress,
      note: plan.status === 'planned' ? '计划尚未执行：以下目标只是预览' : '运行状态为本次查询时从 Airflow 读取的实时值',
    },
    sources: [{ system: 'workctl', adapter: 'plan-store', method: `operations/${plan.id}.json`, observed_at: new Date().toISOString(), relation: 'explicit' }, ...sources],
    coverage: { complete: true, scope: plan.id },
  };
}

export const BackfillGetOut = z.object({
  plan: z.record(z.string(), z.unknown()),
  targets: z.array(z.record(z.string(), z.unknown())),
  execution: z.object({ skipped: z.array(z.unknown()), not_submitted: z.array(z.unknown()) }).nullable(),
  runs: z.array(z.object({ business_date: z.string(), action: z.string(), run_id: z.string(), live_state: z.string(), start_date: z.any(), end_date: z.any() })),
  progress: z.record(z.string(), z.number()),
  note: z.string(),
});
