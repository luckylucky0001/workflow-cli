import { z } from 'zod';
import type { Plan, PlanDraft } from '../../core/operations';
import { WorkError, type Result, type Source } from '../../core/output';
import type { Executor, Planner } from '../../core/registry';
import { sleep, type Ctx } from '../../core/runtime';
import { AirflowClient, checkId } from './airflow';
import { catalogSource, downstreamTables, partitionSpec, tableByName } from './catalog';
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
  // Only a partition positively known to be missing is safe to append to; unknown/unreadable
  // partitions may already hold rows (the check failed, not the data).
  const writes = actions.filter((a) => ['rerun', 'clear_failed', 'trigger_new'].includes(a.action));
  const rewriting = writes.filter((a) => a.partition_state !== 'missing');
  const unknown = rewriting.filter((a) => !['present', 'incomplete', 'empty', 'unreadable'].includes(a.partition_state));
  if (!writeMode) return { ok: true, detail: '目录未声明 write_mode，无法判断重跑幂等性（按非幂等对待并人工确认）' };
  if (writeMode === 'overwrite_partition') return { ok: true, detail: 'overwrite_partition：重跑覆盖目标分区，幂等' };
  if (writeMode === 'append') {
    if (!rewriting.length) return { ok: true, detail: 'append：本次动作涉及的分区当前均不存在（missing），不会重复写入' };
    const what = `${rewriting.length} 个分区${unknown.length ? `（其中 ${unknown.length} 个状态未能确认）` : ''}可能已有数据，重跑会追加写入`;
    return allowAppend
      ? { ok: true, detail: `append：${what}，已通过 --allow-append-duplicates 明确接受重复风险` }
      : { ok: false, detail: `append：${what}，可能产生重复数据；先确认/清理分区或加 --allow-append-duplicates 明确接受` };
  }
  return { ok: true, detail: `write_mode=${writeMode}` };
}

export const BackfillTargetSchema = z.object({
  business_date: z.string(),
  data_interval: z.object({ start_local: z.string(), end_local: z.string(), start_utc: z.string(), end_utc: z.string() }),
  existing_runs: z.array(z.object({ run_id: z.string(), state: z.string().nullable(), run_type: z.string().nullable(), match: z.string(), conf: z.record(z.string(), z.unknown()) })),
  action: z.enum(['skip_succeeded', 'skip_in_progress', 'trigger_new', 'clear_failed', 'rerun']),
  run_id: z.string().nullable(),
  reason: z.string(),
  target_partition: z.string().nullable(),
  partition_state: z.string(),
  upstream_inputs: z.array(z.object({ table: z.string(), partition: z.string().nullable(), state: z.string() })).describe('目录 upstream 中同业务日期的输入分区（外部来源标为 external，不检查）'),
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
    const existing = r.matched.map((m) => ({
      run_id: String(m.run.dag_run_id),
      state: m.run.state ?? null,
      run_type: m.run.run_type ?? null,
      match: m.match,
      conf: m.run.conf && typeof m.run.conf === 'object' ? (m.run.conf as Record<string, unknown>) : {},
    }));
    const dec = decideAction({ existing, rerunSucceeded: rerun });
    const spec = table ? partitionSpec(table, d) : null;
    let pstate = 'unknown';
    if (table && spec && targets.catalog) {
      const l = await partitionLayer(ctx, targets.catalog.name, table.name, spec);
      pstate = l.state;
      if (l.source && rows.length === 0) sources.push(l.source);
    }
    const inputs: { table: string; partition: string | null; state: string }[] = [];
    if (table && targets.catalog && ['trigger_new', 'clear_failed', 'rerun'].includes(dec.action)) {
      for (const up of table.upstream) {
        const meta = tableByName(targets.catalog, up);
        if (!meta) {
          inputs.push({ table: up, partition: null, state: 'external' });
          continue;
        }
        const uspec = partitionSpec(meta, d);
        const l = uspec ? await partitionLayer(ctx, targets.catalog.name, up, uspec) : { state: 'unknown' };
        inputs.push({ table: up, partition: uspec, state: l.state });
      }
    }
    let reasonText = dec.reason;
    const reused = existing.find((e) => e.run_id === dec.run_id);
    if ((dec.action === 'rerun' || dec.action === 'clear_failed') && reused && Object.keys(reused.conf).length) {
      reasonText = `${reasonText}；清理重跑沿用原 run 的 conf ${JSON.stringify(reused.conf)}`;
      warnings.push(`${d}: ${dec.action} 会沿用 run ${reused.run_id} 的 conf ${JSON.stringify(reused.conf)}；如 conf 是问题来源，应改为删除该 run 后 trigger_new`);
    }
    if (dec.action === 'skip_succeeded' && table && pstate !== 'present' && pstate !== 'unknown') {
      reasonText = `${dec.reason}；注意：调度成功但目标分区 ${spec} 状态为 ${pstate}，重跑前先确认原因（同一 run 的 conf/代码会被沿用）`;
      warnings.push(`${d}: 调度层 success 但目标分区 ${pstate}`);
    }
    rows.push({
      business_date: d,
      data_interval: { start_local: iv.start_local, end_local: iv.end_local, start_utc: iv.start_utc, end_utc: iv.end_utc },
      existing_runs: existing,
      action: dec.action,
      run_id: dec.run_id,
      reason: reasonText,
      target_partition: spec,
      partition_state: pstate,
      upstream_inputs: inputs,
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
  const missingInputs = actionable.flatMap((r) => r.upstream_inputs.filter((u) => !['present', 'external'].includes(u.state)).map((u) => `${r.business_date}:${u.table}/${u.partition}=${u.state}`));
  const preconditions = [
    { check: 'dag_importable', ok: !dag.has_import_errors && dag.is_active !== false, detail: dag.has_import_errors ? 'DAG 有导入错误' : 'DAG 可解析且处于活跃状态' },
    { check: 'dag_not_paused', ok: !dag.is_paused, detail: dag.is_paused ? 'DAG 已暂停：触发的 run 不会被调度，需先恢复（属于变更，需单独授权）' : 'DAG 未暂停' },
    { check: 'write_mode_safe', ok: wm.ok, detail: wm.detail },
    {
      check: 'upstream_inputs_present',
      ok: missingInputs.length === 0,
      detail: missingInputs.length
        ? `上游输入分区未就绪，运行会在传感器处等待或失败: ${missingInputs.join(', ')}；先补上游`
        : '动作涉及的目录内上游输入分区均为 present（外部来源未检查）',
    },
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

/** Running + queued DAG runs right now (all run types, not only the ones this plan submitted). */
async function liveActiveRuns(af: AirflowClient, dagId: string): Promise<number> {
  const counts = await Promise.all(
    ['running', 'queued'].map((s) => af.get<{ total_entries: number }>(`/dags/${encodeURIComponent(dagId)}/dagRuns`, { state: s, limit: 1 }).then((x) => Number(x.total_entries ?? 0))),
  );
  return counts.reduce((a, b) => a + b, 0);
}

export const backfillExecutor: Executor = async (ctx, plan, report) => {
  const failed = plan.preconditions.filter((p) => !p.ok && p.check !== 'has_actions');
  if (failed.length) {
    throw new WorkError('PRECONDITION_FAILED', `补数计划前置条件未满足: ${failed.map((f) => `${f.check}(${f.detail ?? ''})`).join('; ')}`);
  }
  const af = new AirflowClient(ctx, plan.params.airflow_endpoint as string | undefined);
  const dagId = String(plan.params.workflow);
  const tz = String(plan.params.timezone);
  const rerunSucceeded = plan.params.rerun_succeeded === true || plan.params.rerun_succeeded === 'true';
  const maxInFlight = Math.max(1, Number(plan.params.max_active_runs ?? 1));
  const targets = (plan.targets as z.infer<typeof BackfillTargetSchema>[]).filter((t) => ['trigger_new', 'clear_failed', 'rerun'].includes(t.action));
  const submitted: Record<string, unknown>[] = [];
  const skipped: Record<string, unknown>[] = [];
  const notSubmitted: Record<string, unknown>[] = [];
  const inFlight = new Set<string>();
  const result = () => ({ workflow: dagId, max_in_flight: maxInFlight, submitted, skipped, not_submitted: notSubmitted, note: '提交成功只代表调度系统已接受请求；用 workctl offline backfill get --id 查看 run 的实时状态' });

  // The in-flight budget covers every running/queued run of the DAG (scheduled, manual, other
  // backfills), not only the runs this plan submitted.
  let liveActive = 0;
  const refreshInFlight = async () => {
    for (const id of [...inFlight]) {
      const r = await af.dagRun(dagId, id);
      if (!r || TERMINAL.has(r.state)) inFlight.delete(id);
    }
    liveActive = await liveActiveRuns(af, dagId);
  };
  const occupied = () => Math.max(inFlight.size, liveActive);

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    try {
      await refreshInFlight();
      while (occupied() >= maxInFlight) {
        if (ctx.remainingMs() < 15_000) break;
        report(`在途 run ${occupied()} 个（本计划提交 ${inFlight.size} 个），达到并发上限 ${maxInFlight}，等待中`);
        await sleep(5000, ctx.signal);
        await refreshInFlight();
      }
      if (occupied() >= maxInFlight) {
        for (const rest of targets.slice(i)) notSubmitted.push({ business_date: rest.business_date, action: rest.action, reason: '时间预算内并发槽未释放，未提交；可用 offline backfill plan 重新生成剩余部分' });
        break;
      }
      // re-validate against live state: the plan may be stale (another run may have been
      // triggered, succeeded or started for this business date since planning)
      const iv = businessInterval(t.business_date, tz);
      const live = await runsForBusinessDate(af, dagId, iv);
      const liveExisting = live.matched.map((m) => ({ run_id: String(m.run.dag_run_id), state: m.run.state ?? null, run_type: m.run.run_type ?? null, match: m.match }));
      const now = decideAction({ existing: liveExisting, rerunSucceeded });
      if (now.action !== t.action || (t.action !== 'trigger_new' && now.run_id !== t.run_id)) {
        skipped.push({ business_date: t.business_date, action: t.action, reason: `计划生成后状态已变化：当前应为 ${now.action}${now.run_id ? `（run ${now.run_id}）` : ''}，与计划不一致，未执行；需要时重新生成计划` });
        continue;
      }
      if (t.action === 'trigger_new') {
        const runId = runIdFor(plan.id, t.business_date);
        let r;
        try {
          r = await af.request('POST', `/dags/${encodeURIComponent(dagId)}/dagRuns`, {
            body: { dag_run_id: runId, logical_date: iv.start_utc, data_interval_start: iv.start_utc, data_interval_end: iv.end_utc, conf: {}, note: `workctl backfill plan ${plan.id}` },
          });
        } catch (e) {
          if (e instanceof WorkError && e.code === 'CONFLICT') {
            skipped.push({ business_date: t.business_date, action: t.action, reason: `Airflow 拒绝重复的 run（logical_date ${iv.start_utc} 或 run_id ${runId} 已存在），未重复触发` });
            continue;
          }
          throw e;
        }
        const body = r.body as any;
        inFlight.add(String(body.dag_run_id ?? runId));
        submitted.push({ business_date: t.business_date, action: t.action, run_id: body.dag_run_id ?? runId, state_at_submit: body.state ?? null, logical_date: timePair(body.logical_date ?? iv.start_utc, tz) });
        report(`已触发 ${t.business_date} → ${body.dag_run_id ?? runId}`);
      } else {
        const r = await af.request('POST', `/dags/${encodeURIComponent(dagId)}/clearTaskInstances`, {
          body: { dry_run: false, dag_run_id: t.run_id, only_failed: t.action === 'clear_failed', reset_dag_runs: true, include_downstream: true, include_upstream: false, include_future: false, include_past: false },
        });
        const cleared = ((r.body as any)?.task_instances ?? []).map((x: any) => x.task_id);
        if (!cleared.length) {
          // e.g. a run marked failed by dagrun_timeout / manually with no failed task instance:
          // nothing was reset, so nothing will rerun — do not report it as submitted
          skipped.push({ business_date: t.business_date, action: t.action, run_id: t.run_id, reason: `run ${t.run_id} 没有可清理的${t.action === 'clear_failed' ? '失败' : ''}任务实例，调度器不会重跑；需人工确认原因（如 dagrun_timeout / 手动标记失败）` });
          continue;
        }
        inFlight.add(String(t.run_id));
        submitted.push({ business_date: t.business_date, action: t.action, run_id: t.run_id, cleared_tasks: cleared });
        report(`已清理 ${t.business_date} run ${t.run_id} 的任务实例: ${cleared.join(', ')}`);
      }
    } catch (e) {
      // keep what was already submitted on the plan before failing, so `backfill get` can
      // still track those runs
      for (const rest of targets.slice(i + 1)) notSubmitted.push({ business_date: rest.business_date, action: rest.action, reason: '执行中途出错，未提交' });
      notSubmitted.unshift({ business_date: t.business_date, action: t.action, reason: `提交失败: ${e instanceof WorkError ? `${e.code} ${e.message}` : e instanceof Error ? e.message : String(e)}` });
      try {
        const store = ctx.plans();
        const p = store.get(plan.id);
        p.result = { ...result(), partial: true };
        store.save(p);
      } catch {
        /* best effort */
      }
      throw e;
    }
  }
  return result();
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
