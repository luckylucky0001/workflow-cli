import { z } from 'zod';
import { source, WorkError, type Source } from '../../core/output';
import { defineCapability, defineDomain } from '../../core/registry';
import type { Ctx } from '../../core/runtime';
import { AIRFLOW_ADAPTER, AIRFLOW_AUTH, AirflowClient, checkId, OFFLINE_GUIDE, sparkAppIds } from './airflow';
import { backfillExecutor, backfillGet, BackfillGetOut, backfillPlan, BackfillPlanOut, backfillPlanner } from './backfill';
import { catalogSource, downstreamTables, loadOfflineCatalog, partitionSpec, tableByName } from './catalog';
import {
  computeLayer,
  findSparkApps,
  LayerSchema,
  normRun,
  partitionLayer,
  qualityLayer,
  RunSchema,
  runsForBusinessDate,
  targetPartition,
  targetsOf,
  TimePairSchema,
  type LayerState,
} from './runs';
import { businessInterval, durationSeconds, formatInZone, MAPPING_RULE, requireDate, requireTimeZone, timePair, zonedToInstant, addDays } from './time';

const common = {
  adapter: AIRFLOW_ADAPTER,
  auth_provider: AIRFLOW_AUTH,
  guide: OFFLINE_GUIDE,
  backend_modes: ['live' as const],
};

const PREREQ = ['profile 配置 airflow 端点（url、username、password_ref）', 'Airflow 启用 basic_auth API 后端，账号具备 DAG 读权限'];

function tzOf(ctx: Ctx, af: AirflowClient, input?: string): string {
  return requireTimeZone(input ?? af.timezone ?? 'UTC');
}

function timedeltaSeconds(v: any): number | null {
  if (!v || typeof v !== 'object') return null;
  return (Number(v.days ?? 0) * 86400) + Number(v.seconds ?? 0) + Number(v.microseconds ?? 0) / 1e6;
}

function normParams(p: any): Record<string, { default: unknown; description: string | null; schema: unknown }> {
  const out: Record<string, { default: unknown; description: string | null; schema: unknown }> = {};
  for (const [k, v] of Object.entries(p ?? {})) {
    const o = v as any;
    out[k] = o && typeof o === 'object' && '__class' in o
      ? { default: o.value ?? null, description: o.description ?? null, schema: o.schema ?? null }
      : { default: o ?? null, description: null, schema: null };
  }
  return out;
}

// ---------------------------------------------------------------------------
// offline workflow get
// ---------------------------------------------------------------------------

const WorkflowOut = z.object({
  workflow_id: z.string(),
  description: z.string().nullable(),
  schedule: z.object({ type: z.string().nullable(), value: z.string().nullable(), description: z.string().nullable() }),
  timezone: z.string().nullable(),
  start_date: z.string().nullable(),
  catchup: z.boolean().nullable(),
  is_paused: z.boolean().nullable(),
  is_active: z.boolean().nullable(),
  has_import_errors: z.boolean().nullable(),
  owners: z.array(z.string()),
  tags: z.array(z.string()),
  max_active_runs: z.number().nullable(),
  max_active_tasks: z.number().nullable(),
  dagrun_timeout_seconds: z.number().nullable(),
  params: z.record(z.string(), z.object({ default: z.unknown(), description: z.string().nullable(), schema: z.unknown() })),
  code_version: z.object({ source_sha256: z.string().nullable(), file_token: z.string().nullable(), fileloc: z.string().nullable(), last_parsed_time: z.string().nullable(), basis: z.string() }),
  next_run: z.object({ logical_date: TimePairSchema, data_interval_start: TimePairSchema, data_interval_end: TimePairSchema, create_after: TimePairSchema }),
  tasks: z.array(z.object({ task_id: z.string(), operator: z.string().nullable(), pool: z.string().nullable(), downstream_task_ids: z.array(z.string()) })),
  outputs: z.array(z.object({ table: z.string(), write_mode: z.string().nullable(), source: z.string() })),
});

const workflowGet = defineCapability({
  ...common,
  name: 'offline.workflow.get',
  command: 'offline workflow get',
  summary: '查看工作流（Airflow DAG）定义：调度、时区、负责人、暂停状态、代码版本、并发与参数',
  domain: 'offline',
  operation: 'read',
  inputs: {
    id: { type: 'string', required: true, description: '工作流 ID（Airflow dag_id），如 demo-daily-orders' },
  },
  output: WorkflowOut,
  prerequisites: PREREQ,
  notes: [
    '代码版本取 GET /api/v1/dagSources/{file_token} 内容的 sha256 与 last_parsed_time；file_token 只标识文件位置',
    'outputs 来自目录元数据 produced_by（catalog-metadata），不是调度器事实',
  ],
  examples: ['workctl offline workflow get --id demo-daily-orders'],
  handler: async (ctx, inp) => {
    const af = new AirflowClient(ctx);
    const id = checkId(inp.id, '--id');
    const dag = await af.dag(id);
    const tasks = await af.tasks(id);
    const code = await af.codeVersion(dag);
    const tz = dag.timezone ?? af.timezone;
    const sources: Source[] = [
      await af.source(`GET /api/v1/dags/${id}/details`),
      await af.source(`GET /api/v1/dags/${id}/tasks`),
      await af.source(`GET /api/v1/dagSources/{file_token}`, 'derived'),
    ];
    const { catalog } = loadOfflineCatalog(ctx);
    const outputs = catalog ? catalog.tables.filter((t) => t.produced_by?.workflow === id).map((t) => ({ table: t.name, write_mode: t.write_mode ?? null, source: 'catalog-metadata' })) : [];
    if (catalog) sources.push(catalogSource(catalog, 'tables/*.yaml produced_by.workflow'));
    const sched = dag.schedule_interval;
    return {
      data: {
        workflow_id: dag.dag_id,
        description: dag.description ?? null,
        schedule: { type: sched?.__type ?? null, value: sched?.value ?? (typeof sched === 'string' ? sched : null), description: dag.timetable_description ?? null },
        timezone: dag.timezone ?? null,
        start_date: dag.start_date ? formatInZone(Date.parse(dag.start_date), tz) : null,
        catchup: dag.catchup ?? null,
        is_paused: dag.is_paused ?? null,
        is_active: dag.is_active ?? null,
        has_import_errors: dag.has_import_errors ?? null,
        owners: dag.owners ?? [],
        tags: (dag.tags ?? []).map((t: any) => t.name ?? String(t)),
        max_active_runs: dag.max_active_runs ?? null,
        max_active_tasks: dag.max_active_tasks ?? null,
        dagrun_timeout_seconds: timedeltaSeconds(dag.dag_run_timeout),
        params: normParams(dag.params),
        code_version: code,
        next_run: {
          logical_date: timePair(dag.next_dagrun, tz),
          data_interval_start: timePair(dag.next_dagrun_data_interval_start, tz),
          data_interval_end: timePair(dag.next_dagrun_data_interval_end, tz),
          create_after: timePair(dag.next_dagrun_create_after, tz),
        },
        tasks: tasks.map((t) => ({ task_id: t.task_id, operator: t.operator_name ?? t.class_ref?.class_name ?? null, pool: t.pool ?? null, downstream_task_ids: t.downstream_task_ids ?? [] })),
        outputs,
      },
      sources,
      coverage: { complete: true, scope: `DAG ${id}` },
      ...(dag.is_paused ? { warnings: ['DAG 处于暂停状态：调度器不会创建新的定时 run，已触发的 run 也不会被调度'] } : {}),
    };
  },
});

// ---------------------------------------------------------------------------
// offline task get
// ---------------------------------------------------------------------------

const taskGet = defineCapability({
  ...common,
  name: 'offline.task.get',
  command: 'offline task get',
  summary: '查看工作流中任务的定义：算子、重试、资源池、上下游、触发规则与超时',
  domain: 'offline',
  operation: 'read',
  inputs: {
    workflow: { type: 'string', required: true, description: '工作流 ID（dag_id）' },
    task: { type: 'string', required: true, description: '任务 ID（task_id）' },
  },
  output: z.object({
    workflow_id: z.string(),
    task_id: z.string(),
    operator: z.string().nullable(),
    operator_module: z.string().nullable(),
    owner: z.string().nullable(),
    retries: z.number().nullable(),
    retry_delay_seconds: z.number().nullable(),
    retry_exponential_backoff: z.boolean().nullable(),
    pool: z.string().nullable(),
    pool_slots: z.number().nullable(),
    queue: z.string().nullable(),
    priority_weight: z.number().nullable(),
    trigger_rule: z.string().nullable(),
    depends_on_past: z.boolean().nullable(),
    execution_timeout_seconds: z.number().nullable(),
    upstream_task_ids: z.array(z.string()),
    downstream_task_ids: z.array(z.string()),
    template_fields: z.array(z.string()),
    is_mapped: z.boolean().nullable(),
    not_exposed: z.array(z.string()),
  }),
  prerequisites: PREREQ,
  notes: ['upstream_task_ids 由同一 DAG 所有任务的 downstream_task_ids 反推（derived）', 'SLA、传感器 mode/poke_interval/timeout 不在 REST 任务接口中，见 not_exposed'],
  examples: ['workctl offline task get --workflow demo-daily-orders --task aggregate_orders'],
  handler: async (ctx, inp) => {
    const af = new AirflowClient(ctx);
    const dagId = checkId(inp.workflow, '--workflow');
    const taskId = checkId(inp.task, '--task');
    const t = await af.getOrNull(`/dags/${encodeURIComponent(dagId)}/tasks/${encodeURIComponent(taskId)}`);
    if (!t) {
      await af.dag(dagId); // distinguishes missing DAG from missing task
      throw new WorkError('NOT_FOUND', `DAG ${dagId} 中没有任务 ${taskId}`, { hint: `用 workctl offline workflow get --id ${dagId} 查看任务列表` });
    }
    const all = await af.tasks(dagId);
    const upstream = all.filter((x) => (x.downstream_task_ids ?? []).includes(taskId)).map((x) => x.task_id);
    const isSensor = /Sensor/.test(String(t.operator_name ?? ''));
    return {
      data: {
        workflow_id: dagId,
        task_id: t.task_id,
        operator: t.operator_name ?? t.class_ref?.class_name ?? null,
        operator_module: t.class_ref?.module_path ?? null,
        owner: t.owner ?? null,
        retries: t.retries ?? null,
        retry_delay_seconds: timedeltaSeconds(t.retry_delay),
        retry_exponential_backoff: t.retry_exponential_backoff ?? null,
        pool: t.pool ?? null,
        pool_slots: t.pool_slots ?? null,
        queue: t.queue ?? null,
        priority_weight: t.priority_weight ?? null,
        trigger_rule: t.trigger_rule ?? null,
        depends_on_past: t.depends_on_past ?? null,
        execution_timeout_seconds: timedeltaSeconds(t.execution_timeout),
        upstream_task_ids: upstream,
        downstream_task_ids: t.downstream_task_ids ?? [],
        template_fields: t.template_fields ?? [],
        is_mapped: t.is_mapped ?? null,
        not_exposed: ['sla', ...(isSensor ? ['sensor.mode', 'sensor.poke_interval', 'sensor.timeout'] : [])],
      },
      sources: [
        await af.source(`GET /api/v1/dags/${dagId}/tasks/${taskId}`),
        await af.source(`GET /api/v1/dags/${dagId}/tasks`, 'derived'),
      ],
      coverage: { complete: true, scope: `${dagId}.${taskId}` },
    };
  },
});

// ---------------------------------------------------------------------------
// offline run list
// ---------------------------------------------------------------------------

const MappingSchema = z.object({
  rule: z.string(),
  business_date: z.string(),
  timezone: z.string(),
  business_interval: z.object({ start_local: z.string(), end_local: z.string(), start_utc: z.string(), end_utc: z.string() }),
  query: z.record(z.string(), z.unknown()),
});

const runList = defineCapability({
  ...common,
  name: 'offline.run.list',
  command: 'offline run list',
  summary: '按业务日期查找工作流的运行（DAG run）：业务日期映射为业务时区的数据区间并按 data_interval 匹配',
  domain: 'offline',
  operation: 'read',
  inputs: {
    workflow: { type: 'string', required: true, description: '工作流 ID（dag_id）' },
    data_date: { type: 'string', required: true, description: '业务日期 YYYY-MM-DD（不是启动日期）' },
    timezone: { type: 'string', description: '业务时区（默认取 airflow 端点 timezone）' },
    limit: { type: 'int', default: 20, description: '最多返回的 run 数' },
  },
  output: z.object({ workflow: z.string(), mapping: MappingSchema, runs: z.array(RunSchema), total_matched: z.number(), notes: z.array(z.string()) }),
  prerequisites: PREREQ,
  notes: [MAPPING_RULE, '手动触发且未显式传 data_interval 的 run，Airflow 按时间表推断为“logical_date 之前最近一个完整区间”，其业务日期可能比 logical_date 早一天'],
  examples: ['workctl offline run list --workflow demo-daily-orders --data-date 2026-10-16 --timezone Asia/Shanghai'],
  handler: async (ctx, inp) => {
    const af = new AirflowClient(ctx);
    const dagId = checkId(inp.workflow, '--workflow');
    const date = requireDate(inp.data_date, '--data-date');
    const tz = tzOf(ctx, af, inp.timezone);
    const iv = businessInterval(date, tz);
    await af.dag(dagId);
    const r = await runsForBusinessDate(af, dagId, iv);
    const runs = r.matched.slice(0, inp.limit).map((m) => normRun(m.run, tz, m.match));
    const notes: string[] = [];
    if (!r.matched.length) notes.push(`没有 data_interval 与 ${date}（${tz}）相交的 run：该业务日期尚未调度、未触发，或 run 已被删除`);
    if (r.matched.length > runs.length) notes.push(`匹配 ${r.matched.length} 个，按 --limit 返回 ${runs.length} 个`);
    const now = Date.now();
    if (iv.endMs > now) notes.push(`业务日期 ${date} 的数据区间尚未结束（结束于 ${iv.end_local}），定时 run 通常在区间结束后创建`);
    return {
      data: {
        workflow: dagId,
        mapping: { rule: MAPPING_RULE, business_date: date, timezone: tz, business_interval: { start_local: iv.start_local, end_local: iv.end_local, start_utc: iv.start_utc, end_utc: iv.end_utc }, query: r.query },
        runs,
        total_matched: r.matched.length,
        notes,
      },
      sources: [await af.source(`GET /api/v1/dags/${dagId}/dagRuns`)],
      coverage: {
        complete: !r.truncated && r.matched.length <= runs.length,
        scope: `logical_date ∈ [${r.query.execution_date_gte}, ${r.query.execution_date_lte}]`,
        ...(r.truncated || r.matched.length > runs.length ? { truncated: true } : {}),
        limit: inp.limit,
        window: { start: iv.start_utc, end: iv.end_utc },
        notes: ['只检索 logical_date 在业务日期前后 1 天内的 run；周期长于 1 天的 DAG 可能遗漏覆盖该日期的 run'],
      },
    };
  },
});

// ---------------------------------------------------------------------------
// offline run get (layered status)
// ---------------------------------------------------------------------------

const TaskInstanceSchema = z.object({
  task_id: z.string(),
  state: z.string().nullable(),
  try_number: z.number().nullable(),
  max_tries: z.number().nullable(),
  operator: z.string().nullable(),
  pool: z.string().nullable(),
  hostname: z.string().nullable(),
  queued_when: TimePairSchema,
  start_date: TimePairSchema,
  end_date: TimePairSchema,
  duration_seconds: z.number().nullable(),
  map_index: z.number().nullable(),
});

function normTi(ti: any, tz: string): z.infer<typeof TaskInstanceSchema> {
  return {
    task_id: ti.task_id,
    state: ti.state ?? null,
    try_number: ti.try_number ?? null,
    max_tries: ti.max_tries ?? null,
    operator: ti.operator ?? null,
    pool: ti.pool ?? null,
    hostname: ti.hostname || null,
    queued_when: timePair(ti.queued_when, tz),
    start_date: timePair(ti.start_date, tz),
    end_date: timePair(ti.end_date, tz),
    duration_seconds: ti.duration ?? durationSeconds(ti.start_date, ti.end_date),
    map_index: ti.map_index ?? null,
  };
}

const SummarySchema = z.object({
  workflow: z.string(),
  run_id: z.string(),
  business_date: z.string().nullable(),
  data_interval: z.object({ start: TimePairSchema, end: TimePairSchema }),
  target_partition: z.object({ table: z.string(), partition: z.string().nullable(), write_mode: z.string().nullable() }).nullable(),
  scheduler_state: z.string(),
  compute_state: z.string(),
  output_state: z.string(),
  quality_state: z.string(),
  layers: z.object({ scheduler: LayerSchema, compute: LayerSchema, output: LayerSchema, quality: LayerSchema }),
  findings: z.array(z.object({ kind: z.enum(['fact', 'inconsistency']), message: z.string() })),
});

function findings(s: { scheduler: string; compute: string; output: string; quality: string }, tasks: { task_id: string; state: string | null }[]): { kind: 'fact' | 'inconsistency'; message: string }[] {
  const out: { kind: 'fact' | 'inconsistency'; message: string }[] = [];
  if (s.scheduler === 'success' && ['missing', 'empty', 'incomplete', 'unreadable'].includes(s.output)) {
    out.push({ kind: 'inconsistency', message: `调度状态 success，但目标分区状态为 ${s.output}：调度成功不代表数据产出` });
  }
  if (s.compute === 'succeeded' && ['missing', 'empty'].includes(s.output)) {
    out.push({ kind: 'inconsistency', message: `Spark 应用成功结束，但目标分区 ${s.output}：可能写到了其他分区或路径（需查看计算日志与输出路径确认）` });
  }
  if (s.scheduler === 'success' && s.compute === 'failed') out.push({ kind: 'inconsistency', message: '调度成功但关联 Spark 应用有失败作业' });
  const waiting = tasks.filter((t) => t.state === 'up_for_reschedule' || t.state === 'deferred');
  for (const t of waiting) out.push({ kind: 'fact', message: `任务 ${t.task_id} 处于 ${t.state}（传感器等待上游条件，未占用执行槽）` });
  const failed = tasks.filter((t) => t.state === 'failed' || t.state === 'upstream_failed');
  for (const t of failed) out.push({ kind: 'fact', message: `任务 ${t.task_id} 状态 ${t.state}` });
  if (s.output === 'present' && s.quality === 'not_run') out.push({ kind: 'fact', message: '目标分区存在，但没有质量检查记录：分区存在不代表数据正确' });
  return out;
}

export async function buildRunDetail(ctx: Ctx, af: AirflowClient, runId: string, dagId?: string) {
  const found = await af.findRun(runId, dagId);
  const dag = await af.dag(found.dagId);
  const tz = dag.timezone ?? af.timezone;
  const run = found.run;
  const tis = await af.taskInstances(found.dagId, runId);
  const sources: Source[] = [
    await af.source(`GET /api/v1/dags/${found.dagId}/dagRuns/${runId}`),
    await af.source(`GET /api/v1/dags/${found.dagId}/dagRuns/${runId}/taskInstances`),
  ];
  const warnings: string[] = [];
  const schedulerLayer: LayerState = { state: String(run.state ?? 'unknown'), source: sources[0], ...(run.state === 'success' ? { detail: 'Airflow DAG run 状态；只代表调度层任务全部成功' } : {}) };

  // compute
  const apps = await findSparkApps(af, found.dagId, runId, tis);
  if (apps.length) sources.push(await af.source(`GET .../taskInstances/{task}/xcomEntries/return_value | logs`, 'derived'));
  const compute = await computeLayer(ctx, apps);
  if (compute.source) sources.push(compute.source);

  // output + quality via catalog metadata
  const targets = targetsOf(ctx, found.dagId);
  let output: LayerState = { state: 'unknown', detail: targets.reason ?? '没有目标表', source: null };
  let quality: LayerState = { state: 'unknown', detail: targets.reason ?? '没有目标表', source: null };
  let target: { table: string; partition: string | null; write_mode: string | null } | null = null;
  if (targets.catalog && targets.tables.length) {
    sources.push(catalogSource(targets.catalog, `tables/*.yaml produced_by.workflow=${found.dagId}`));
    if (targets.tables.length > 1) warnings.push(`目录中有 ${targets.tables.length} 张表由 ${found.dagId} 产出，汇总只展示 ${targets.tables[0].name}`);
    const tp = targetPartition(targets.tables[0], run, tz);
    target = { table: tp.table, partition: tp.partition, write_mode: tp.write_mode };
    if (tp.partition) {
      output = await partitionLayer(ctx, targets.catalog.name, tp.table, tp.partition);
      quality = await qualityLayer(ctx, tp.table, tp.partition);
      if (output.source) sources.push(output.source);
      if (quality.source) sources.push(quality.source);
    } else {
      output = { state: 'unknown', detail: `表 ${tp.table} 没有分区键定义`, source: null };
    }
  }
  const tiViews = tis.map((ti) => normTi(ti, tz));
  const summary = {
    workflow: found.dagId,
    run_id: runId,
    business_date: normRun(run, tz).business_date,
    data_interval: { start: timePair(run.data_interval_start, tz), end: timePair(run.data_interval_end, tz) },
    target_partition: target,
    scheduler_state: schedulerLayer.state,
    compute_state: compute.state,
    output_state: output.state,
    quality_state: quality.state,
    layers: { scheduler: schedulerLayer, compute, output, quality },
    findings: findings({ scheduler: schedulerLayer.state, compute: compute.state, output: output.state, quality: quality.state }, tiViews),
  };
  return { dagId: found.dagId, tz, run: normRun(run, tz), tasks: tiViews, summary, sources, warnings, scanned: found.scanned, spark_apps: apps };
}

const runGet = defineCapability({
  ...common,
  name: 'offline.run.get',
  command: 'offline run get',
  summary: '查看一次运行：任务实例状态，并分层汇总调度、计算、数据产出、质量四个检查项',
  domain: 'offline',
  operation: 'diagnose',
  inputs: {
    id: { type: 'string', required: true, description: 'run_id（如 manual__2026-10-16T00:00:00+08:00）' },
    workflow: { type: 'string', description: '工作流 ID；省略时在活跃 DAG 中查找（有上限）' },
  },
  output: z.object({ run: RunSchema, tasks: z.array(TaskInstanceSchema), summary: SummarySchema }),
  prerequisites: [...PREREQ, '计算层需要 Spark history server 与事件日志；产出层需要 catalog 端点与 data 域；质量层读取 data quality check 的最近结果'],
  notes: [
    '四个检查项分别验证：scheduler（Airflow run 状态）、compute（Spark 应用，通过任务记录的 application id 关联）、output（目标分区，经 data.partition.get）、quality（最近一次质量检查结果）',
    '目标表与分区由目录元数据 produced_by 推导，分区值取 data_interval_start 在分区时区的日期',
  ],
  examples: ['workctl offline run get --workflow demo-daily-orders --id "manual__2026-10-16T00:00:00+08:00"'],
  handler: async (ctx, inp) => {
    const af = new AirflowClient(ctx);
    const d = await buildRunDetail(ctx, af, checkId(inp.id, '--id'), inp.workflow ? checkId(inp.workflow, '--workflow') : undefined);
    const unknownLayers = Object.entries(d.summary.layers).filter(([, l]) => l.state === 'unknown').map(([k, l]) => `${k}: ${l.detail ?? 'unknown'}`);
    return {
      data: { run: d.run, tasks: d.tasks, summary: d.summary },
      sources: d.sources,
      warnings: d.warnings,
      coverage: {
        complete: unknownLayers.length === 0,
        scope: `run ${d.run.run_id} of ${d.dagId}`,
        ...(unknownLayers.length ? { notes: unknownLayers.map((u) => `未能确定的检查项 ${u}`) } : {}),
      },
    };
  },
});

// ---------------------------------------------------------------------------
// offline dependency list
// ---------------------------------------------------------------------------

const EdgeSource = z.enum(['scheduler-metadata', 'catalog-metadata', 'binding-file']);

const dependencyList = defineCapability({
  ...common,
  name: 'offline.dependency.list',
  command: 'offline dependency list',
  summary: '列出一次运行的上游/下游依赖：DAG 内任务、输入/输出数据分区、跨工作流关系，并标注每条边的来源',
  domain: 'offline',
  operation: 'diagnose',
  inputs: {
    run_id: { type: 'string', required: true, description: 'run_id' },
    direction: { type: 'enum', enum: ['upstream', 'downstream'], default: 'upstream', description: '方向' },
    workflow: { type: 'string', description: '工作流 ID；省略时查找' },
  },
  output: z.object({
    workflow: z.string(),
    run_id: z.string(),
    direction: z.enum(['upstream', 'downstream']),
    business_date: z.string().nullable(),
    task_edges: z.array(z.object({ from: z.string(), to: z.string(), from_state: z.string().nullable(), to_state: z.string().nullable(), edge_source: EdgeSource })),
    data_dependencies: z.array(z.object({ table: z.string(), partition: z.string().nullable(), role: z.enum(['input', 'output', 'consumer_input']), state: z.string(), detail: z.string().optional(), edge_source: EdgeSource })),
    workflow_dependencies: z.array(z.object({
      workflow: z.string(),
      relation: z.string(),
      via: z.string().nullable(),
      edge_source: EdgeSource,
      evidence: z.string().nullable(),
      run: z.object({ run_id: z.string(), state: z.string().nullable(), match: z.string().optional() }).nullable(),
      run_lookup: z.string(),
    })),
    notes: z.array(z.string()),
  }),
  prerequisites: [...PREREQ, '数据依赖需要 catalog 端点（upstream/consumers）；跨工作流关系来自 resources_file 绑定'],
  notes: ['只报告平台显式记录的关系（调度元数据、目录元数据、绑定文件），不根据相似名称推断依赖'],
  examples: ['workctl offline dependency list --workflow demo-daily-orders --run-id "manual__2026-10-14T00:00:00+08:00" --direction upstream'],
  handler: async (ctx, inp) => {
    const af = new AirflowClient(ctx);
    const runId = checkId(inp.run_id, '--run-id');
    const found = await af.findRun(runId, inp.workflow ? checkId(inp.workflow, '--workflow') : undefined);
    const dagId = found.dagId;
    const dag = await af.dag(dagId);
    const tz = dag.timezone ?? af.timezone;
    const dir: 'upstream' | 'downstream' = inp.direction;
    const tasks = await af.tasks(dagId);
    const tis = await af.taskInstances(dagId, runId);
    const stateOf = new Map(tis.map((t) => [t.task_id, t.state ?? null]));
    const sources: Source[] = [await af.source(`GET /api/v1/dags/${dagId}/tasks`), await af.source(`GET /api/v1/dags/${dagId}/dagRuns/${runId}/taskInstances`)];
    const notes: string[] = [];
    const taskEdges = tasks.flatMap((t) => (t.downstream_task_ids ?? []).map((d: string) => ({ from: t.task_id, to: d, from_state: stateOf.get(t.task_id) ?? null, to_state: stateOf.get(d) ?? null, edge_source: 'scheduler-metadata' as const })));

    const businessDateFor = (t?: { partition_key?: { timezone?: string } }) => normRun({ ...found.run, data_interval_start: found.run.data_interval_start }, t?.partition_key?.timezone ?? tz).business_date;
    const bd = businessDateFor();
    const data: any[] = [];
    const targets = targetsOf(ctx, dagId);
    if (!targets.catalog) notes.push(`目录元数据不可用: ${targets.reason}`);
    else {
      sources.push(catalogSource(targets.catalog, 'tables/*.yaml upstream/consumers/produced_by'));
      for (const t of targets.tables) {
        const tbd = businessDateFor(t);
        if (dir === 'upstream') {
          for (const up of t.upstream) {
            const meta = tableByName(targets.catalog, up);
            if (!meta) {
              data.push({ table: up, partition: null, role: 'input', state: 'external', detail: '上游不在目录中（外部来源），未检查', edge_source: 'catalog-metadata' });
              continue;
            }
            const spec = tbd ? partitionSpec(meta, tbd) : null;
            const layer = spec ? await partitionLayer(ctx, targets.catalog.name, up, spec) : { state: 'unknown', detail: '上游表无分区键', source: null };
            if (layer.source) sources.push(layer.source);
            data.push({ table: up, partition: spec, role: 'input', state: layer.state, ...(layer.detail ? { detail: layer.detail } : {}), edge_source: 'catalog-metadata' });
          }
        } else {
          const spec = tbd ? partitionSpec(t, tbd) : null;
          const layer = spec ? await partitionLayer(ctx, targets.catalog.name, t.name, spec) : { state: 'unknown', detail: '无分区键', source: null };
          if (layer.source) sources.push(layer.source);
          data.push({ table: t.name, partition: spec, role: 'output', state: layer.state, ...(layer.detail ? { detail: layer.detail } : {}), edge_source: 'catalog-metadata' });
          for (const down of downstreamTables(targets.catalog, t.name)) {
            data.push({ table: down.name, partition: tbd ? partitionSpec(down, tbd) : null, role: 'consumer_input', state: 'not_checked', detail: `${down.name} 以 ${t.name} 为上游（产出流程 ${down.produced_by?.workflow ?? '未知'}）`, edge_source: 'catalog-metadata' });
          }
        }
      }
    }

    // cross-workflow edges
    const wf: any[] = [];
    const seen = new Set<string>();
    const store = ctx.resources();
    const addWf = (workflow: string, relation: string, via: string | null, edgeSource: 'binding-file' | 'catalog-metadata', evidence: string | null) => {
      const key = `${workflow}|${relation}|${via}`;
      if (seen.has(key) || workflow === dagId) return;
      seen.add(key);
      wf.push({ workflow, relation, via, edge_source: edgeSource, evidence });
    };
    if (store.configured) {
      sources.push(source('binding-file', 'resources-file', { endpoint: store.path ?? undefined, method: 'relations', relation: 'explicit' }));
      const rels = store.relations;
      if (dir === 'upstream') {
        for (const r of rels.filter((x) => x.from === dagId && (x.type === 'reads_from' || x.type === 'depends_on'))) {
          if (r.type === 'depends_on' && store.get(r.to)?.type === 'offline.workflow') addWf(r.to, 'depends_on', null, 'binding-file', r.evidence ?? null);
          for (const p of rels.filter((x) => x.to === r.to && x.type === 'produces')) addWf(p.from, 'produces_input', r.to, 'binding-file', p.evidence ?? `${p.from} produces ${r.to}`);
        }
      } else {
        for (const r of rels.filter((x) => x.from === dagId && x.type === 'produces')) {
          for (const c of rels.filter((x) => x.to === r.to && x.type === 'reads_from')) addWf(c.from, 'consumes_output', r.to, 'binding-file', c.evidence ?? `${c.from} reads_from ${r.to}`);
        }
        for (const r of rels.filter((x) => x.to === dagId && x.type === 'depends_on')) addWf(r.from, 'depends_on', null, 'binding-file', r.evidence ?? null);
      }
    } else notes.push('当前 profile 未配置 resources_file，未检查跨工作流绑定关系');
    if (targets.catalog) {
      for (const t of targets.tables) {
        if (dir === 'upstream') {
          for (const up of t.upstream) {
            const producer = tableByName(targets.catalog, up)?.produced_by?.workflow;
            if (producer) addWf(producer, 'produces_input', up, 'catalog-metadata', `${up}.produced_by.workflow`);
          }
        } else {
          for (const c of t.consumers.filter((c) => c.type === 'workflow')) addWf(c.id, 'consumes_output', t.name, 'catalog-metadata', `${t.name}.consumers`);
        }
      }
    }
    const runCache = new Map<string, any>();
    for (const w of wf) {
      if (runCache.has(w.workflow)) {
        Object.assign(w, runCache.get(w.workflow));
        continue;
      }
      let look: any;
      if (!bd) look = { run: null, run_lookup: '本次 run 没有 data_interval，无法按业务日期查找' };
      else {
        try {
          const r = await runsForBusinessDate(af, w.workflow, businessInterval(bd, tz));
          const m = r.matched.find((x) => x.match === 'exact') ?? r.matched[0];
          look = m
            ? { run: { run_id: m.run.dag_run_id, state: m.run.state ?? null, match: m.match }, run_lookup: `按业务日期 ${bd} 匹配到 ${r.matched.length} 个 run` }
            : { run: null, run_lookup: `业务日期 ${bd} 没有 run（未调度/未触发）` };
        } catch (e) {
          look = { run: null, run_lookup: `查询失败: ${e instanceof WorkError ? `${e.code} ${e.message}` : String(e)}` };
        }
      }
      runCache.set(w.workflow, look);
      Object.assign(w, look);
    }
    if (wf.length) sources.push(await af.source('GET /api/v1/dags/{dag}/dagRuns (related workflows)', 'derived'));
    return {
      data: { workflow: dagId, run_id: runId, direction: dir, business_date: bd, task_edges: taskEdges, data_dependencies: data, workflow_dependencies: wf, notes },
      sources,
      coverage: { complete: !!targets.catalog && store.configured, scope: `${dir} of ${dagId}/${runId}`, notes: ['task_edges 为 DAG 内全部边（两个方向）；数据与跨工作流依赖按 direction 过滤'] },
    };
  },
});

// ---------------------------------------------------------------------------
// offline log get
// ---------------------------------------------------------------------------

const logGet = defineCapability({
  ...common,
  name: 'offline.log.get',
  command: 'offline log get',
  summary: '读取任务某次尝试的日志尾部（Airflow 任务日志）',
  domain: 'offline',
  operation: 'read',
  inputs: {
    run_id: { type: 'string', required: true, description: 'run_id' },
    task: { type: 'string', required: true, description: '任务 ID' },
    try: { type: 'int', description: '尝试序号（默认取任务实例当前 try_number）' },
    workflow: { type: 'string', description: '工作流 ID；省略时查找' },
    limit_lines: { type: 'int', default: 200, description: '返回末尾行数（上限 2000）' },
  },
  output: z.object({
    workflow: z.string(),
    run_id: z.string(),
    task_id: z.string(),
    try_number: z.number(),
    task_state: z.string().nullable(),
    total_lines: z.number(),
    returned_lines: z.number(),
    truncated: z.boolean(),
    spark_app_ids: z.array(z.string()),
    lines: z.array(z.string()),
  }),
  prerequisites: PREREQ,
  notes: ['日志由 Airflow webserver 从任务日志存储读取；reschedule 模式的传感器每次 poke 都追加到同一 try 的日志', '日志为目标系统原文，可能包含业务路径等信息，按需裁剪后再转述'],
  examples: ['workctl offline log get --workflow demo-daily-orders --run-id "manual__2026-10-16T00:00:00+08:00" --task aggregate_orders --limit-lines 50'],
  handler: async (ctx, inp) => {
    const af = new AirflowClient(ctx);
    const runId = checkId(inp.run_id, '--run-id');
    const taskId = checkId(inp.task, '--task');
    const found = await af.findRun(runId, inp.workflow ? checkId(inp.workflow, '--workflow') : undefined);
    const base = `/dags/${encodeURIComponent(found.dagId)}/dagRuns/${encodeURIComponent(runId)}/taskInstances/${encodeURIComponent(taskId)}`;
    const ti = await af.getOrNull(base);
    if (!ti) throw new WorkError('NOT_FOUND', `run ${runId} 中没有任务实例 ${taskId}`);
    const tryNo = inp.try ?? ti.try_number ?? 0;
    if (!tryNo || tryNo < 1) {
      throw new WorkError('DATA_UNAVAILABLE', `任务 ${taskId} 尚未开始执行（state=${ti.state ?? 'none'}，try_number=0），没有日志`, { hint: '用 workctl offline run get 查看任务状态' });
    }
    const r = await af.request('GET', `${base}/logs/${tryNo}`, { query: { full_content: true }, accept: 'text/plain', allowStatus: [404] });
    if (r.status === 404) throw new WorkError('NOT_FOUND', `任务 ${taskId} 没有第 ${tryNo} 次尝试的日志`);
    const all = r.text.replace(/\r\n/g, '\n').split('\n');
    if (all.length && all[all.length - 1] === '') all.pop();
    const limit = Math.min(Math.max(1, inp.limit_lines), 2000);
    const lines = all.slice(-limit);
    return {
      data: {
        workflow: found.dagId,
        run_id: runId,
        task_id: taskId,
        try_number: tryNo,
        task_state: ti.state ?? null,
        total_lines: all.length,
        returned_lines: lines.length,
        truncated: all.length > lines.length,
        spark_app_ids: sparkAppIds(r.text),
        lines,
      },
      sources: [await af.source(`GET /api/v1/dags/${found.dagId}/dagRuns/${runId}/taskInstances/${taskId}/logs/${tryNo}`)],
      coverage: { complete: all.length <= lines.length, scope: `try ${tryNo}`, ...(all.length > lines.length ? { truncated: true, limit } : {}) },
    };
  },
});

// ---------------------------------------------------------------------------
// offline freshness check
// ---------------------------------------------------------------------------

const freshnessCheck = defineCapability({
  ...common,
  adapter: 'file-catalog+airflow-rest-v1',
  name: 'offline.freshness.check',
  command: 'offline freshness check',
  summary: '按目录约定的产出时限检查数据集某业务日期是否准时：on_time / late / missing / not_due',
  domain: 'offline',
  operation: 'diagnose',
  inputs: {
    dataset: { type: 'string', required: true, description: '数据集（目录表名 db.table），如 analytics.daily_orders' },
    data_date: { type: 'string', required: true, description: '业务日期 YYYY-MM-DD' },
    timezone: { type: 'string', description: '业务时区（默认取目录 freshness.timezone / 分区键时区）' },
  },
  output: z.object({
    dataset: z.string(),
    business_date: z.string(),
    partition: z.string().nullable(),
    verdict: z.enum(['on_time', 'late', 'missing', 'not_due', 'unknown']),
    reason: z.string(),
    expected_by: z.object({ local: z.string(), utc: z.string(), rule: z.string() }),
    checked_at: z.object({ local: z.string(), utc: z.string() }),
    partition_state: z.string(),
    partition_updated_at: TimePairSchema,
    lateness_minutes: z.number().nullable(),
    producer: z.object({ workflow: z.string(), runs: z.array(z.object({ run_id: z.string(), state: z.string().nullable(), start_date: TimePairSchema, end_date: TimePairSchema })), lookup: z.string() }).nullable(),
  }),
  prerequisites: ['catalog 端点，表元数据含 freshness.expected_by', 'data 域的 data.partition.get', '（可选）airflow 端点，用于附带产出工作流的 run 状态'],
  notes: [
    'expected_by 为业务日期 + day_offset 天在业务时区的 HH:MM；分区更新时间取 data.partition.get 返回的写入证据（成功标记或最新数据文件）',
    'present 以外的分区状态（empty/incomplete/unreadable）不算准时产出',
  ],
  examples: ['workctl offline freshness check --dataset analytics.daily_orders --data-date 2026-10-16'],
  handler: async (ctx, inp) => {
    const date = requireDate(inp.data_date, '--data-date');
    const { catalog, reason } = loadOfflineCatalog(ctx);
    if (!catalog) throw new WorkError('NOT_CONFIGURED', `目录元数据不可用: ${reason}`);
    const t = tableByName(catalog, inp.dataset);
    if (!t) throw new WorkError('NOT_FOUND', `目录中没有表 ${inp.dataset}`, { hint: `已登记: ${catalog.tables.map((x) => x.name).join(', ') || '(无)'}` });
    if (!t.freshness) throw new WorkError('NOT_CONFIGURED', `表 ${t.name} 未在目录中声明 freshness.expected_by`, { hint: '在目录元数据中补充 freshness: {expected_by: "HH:MM", day_offset: 1}' });
    const tz = requireTimeZone(inp.timezone ?? t.freshness.timezone ?? t.partition_key?.timezone ?? 'UTC');
    const dueDate = addDays(date, t.freshness.day_offset);
    const dueMs = zonedToInstant(dueDate, t.freshness.expected_by, tz);
    const now = Date.now();
    const sources: Source[] = [catalogSource(catalog, `${t.name}.freshness`)];
    const spec = partitionSpec(t, date);
    const layer: LayerState = spec ? await partitionLayer(ctx, catalog.name, t.name, spec) : { state: 'unknown', detail: '表没有分区键', source: null };
    if (layer.source) sources.push(layer.source);
    const updatedMs = typeof layer.updated_at === 'string' ? Date.parse(layer.updated_at) : NaN;
    let verdict: 'on_time' | 'late' | 'missing' | 'not_due' | 'unknown';
    let why: string;
    if (layer.state === 'unknown') {
      verdict = 'unknown';
      why = `无法确定分区状态: ${layer.detail ?? ''}`;
    } else if (layer.state === 'present') {
      if (!Number.isFinite(updatedMs)) {
        verdict = 'unknown';
        why = '分区存在但没有可用的更新时间证据';
      } else if (updatedMs <= dueMs) {
        verdict = 'on_time';
        why = `分区在时限前产出（${formatInZone(updatedMs, tz)} ≤ ${formatInZone(dueMs, tz)}）`;
      } else {
        verdict = 'late';
        why = `分区已产出但晚于时限 ${Math.round((updatedMs - dueMs) / 60000)} 分钟`;
      }
    } else if (now < dueMs) {
      verdict = 'not_due';
      why = `分区状态 ${layer.state}，但尚未到产出时限 ${formatInZone(dueMs, tz)}`;
    } else {
      verdict = 'missing';
      why = `已超过产出时限 ${formatInZone(dueMs, tz)}，分区状态 ${layer.state}`;
    }
    let producer: any = null;
    const wfId = t.produced_by?.workflow;
    if (wfId && ctx.hasEndpoint('airflow')) {
      try {
        const af = new AirflowClient(ctx);
        const r = await runsForBusinessDate(af, wfId, businessInterval(date, tz));
        producer = {
          workflow: wfId,
          runs: r.matched.map((m) => ({ run_id: m.run.dag_run_id, state: m.run.state ?? null, start_date: timePair(m.run.start_date, tz), end_date: timePair(m.run.end_date, tz) })),
          lookup: r.matched.length ? `按业务日期 ${date} 匹配 ${r.matched.length} 个 run` : `业务日期 ${date} 没有 run`,
        };
        sources.push(await af.source(`GET /api/v1/dags/${wfId}/dagRuns`, 'derived'));
      } catch (e) {
        producer = { workflow: wfId, runs: [], lookup: `查询产出工作流失败: ${e instanceof WorkError ? e.code : String(e)}` };
      }
    }
    return {
      data: {
        dataset: t.name,
        business_date: date,
        partition: spec,
        verdict,
        reason: why,
        expected_by: { local: formatInZone(dueMs, tz), utc: new Date(dueMs).toISOString(), rule: `业务日期 + ${t.freshness.day_offset} 天 ${t.freshness.expected_by}（${tz}）` },
        checked_at: { local: formatInZone(now, tz), utc: new Date(now).toISOString() },
        partition_state: layer.state,
        partition_updated_at: Number.isFinite(updatedMs) ? timePair(new Date(updatedMs).toISOString(), tz) : null,
        lateness_minutes: Number.isFinite(updatedMs) && updatedMs > dueMs ? Math.round((updatedMs - dueMs) / 60000) : verdict === 'missing' ? Math.round((now - dueMs) / 60000) : null,
        producer,
      },
      sources,
      coverage: { complete: verdict !== 'unknown', scope: `${t.name}/${spec ?? '(no partition)'}` },
    };
  },
});

// ---------------------------------------------------------------------------
// backfill
// ---------------------------------------------------------------------------

const backfillPlanCap = defineCapability({
  ...common,
  name: 'offline.backfill.plan',
  command: 'offline backfill plan',
  summary: '生成补数计划：逐个业务日期给出现有运行、目标分区状态、动作、写入幂等性、下游影响、代码版本与并发预算（不执行）',
  domain: 'offline',
  operation: 'plan',
  inputs: {
    workflow: { type: 'string', required: true, description: '工作流 ID（dag_id）' },
    from: { type: 'string', required: true, description: '起始业务日期 YYYY-MM-DD（含）' },
    to: { type: 'string', required: true, description: '结束业务日期 YYYY-MM-DD（含），最多 31 天' },
    timezone: { type: 'string', description: '业务时区（默认 airflow 端点 timezone）' },
    rerun_succeeded: { type: 'bool', default: false, description: '对已成功的业务日期也重跑（清理全部任务实例）' },
    max_active_runs: { type: 'int', description: '执行时同时在途的 run 上限（默认 min(DAG max_active_runs, 2)）' },
    allow_append_duplicates: { type: 'bool', default: false, description: '目标表为 append 写入时，明确接受重跑可能产生重复数据' },
  },
  output: BackfillPlanOut,
  idempotent: false,
  cancellable: false,
  prerequisites: [...PREREQ, '执行需要 profile allow_execute=true，并通过 workctl operation execute --id <plan> 确认'],
  notes: [
    '计划只做预览，不触发任何运行；计划预览不是执行成功的证据',
    '动作：skip_succeeded（已成功且未要求重跑）、skip_in_progress（在途）、trigger_new（无 run，POST dagRuns 并显式传 data_interval）、clear_failed（只清理失败任务实例）、rerun（清理全部任务实例）',
    'overwrite_partition 表重跑为幂等覆盖；append 表重跑有重复风险，未显式允许时前置条件失败',
    '重跑使用调度器当前解析的 DAG 代码（code_version），不是原始 run 当时的代码',
  ],
  examples: ['workctl offline backfill plan --workflow demo-daily-orders --from 2026-10-14 --to 2026-10-16 --timezone Asia/Shanghai'],
  handler: backfillPlan,
});

const backfillGetCap = defineCapability({
  ...common,
  name: 'offline.backfill.get',
  command: 'offline backfill get',
  summary: '查看补数计划及其已触发运行的实时状态',
  domain: 'offline',
  operation: 'read',
  inputs: { id: { type: 'string', required: true, description: '计划 ID（op-YYYYMMDD-xxxxxx）' } },
  output: BackfillGetOut,
  prerequisites: PREREQ,
  examples: ['workctl offline backfill get --id op-20261017-abc123'],
  handler: backfillGet,
});

export default defineDomain({
  name: 'offline',
  title: '离线调度',
  summary: '离线工作流（Airflow）：工作流/任务定义、按业务日期查找运行、分层状态、依赖、日志、补数计划与产出时效',
  pillar: 'offline',
  guide: OFFLINE_GUIDE,
  skill: 'skills/offline-operations/SKILL.md',
  capabilities: [workflowGet, taskGet, runList, runGet, dependencyList, logGet, backfillPlanCap, backfillGetCap, freshnessCheck],
  planners: [backfillPlanner],
  executors: { 'offline.backfill': backfillExecutor },
});
