import { existsSync } from 'node:fs';
import { z } from 'zod';
import { source, WorkError } from '../../core/output';
import { defineCapability, defineDomain } from '../../core/registry';
import { AIRFLOW_AUTH, AirflowClient, checkId } from '../offline/airflow';
import { checkAppId, COMPUTE_GUIDE, deriveStatus, driverFailureSignal, driverLogPath, SPARK_HISTORY_ADAPTER, SPARK_LOG_ADAPTER, SparkHistory, tailFile } from './spark';

const iso = (ms: unknown): string | null => (typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : null);
const sparkTime = (v: unknown): string | null => {
  if (typeof v !== 'string' || !v) return null;
  // Spark REST times look like 2026-10-17T12:25:51.123GMT
  const t = Date.parse(v.replace(/GMT$/, 'Z'));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

// ---------------------------------------------------------------------------
// compute job get
// ---------------------------------------------------------------------------

const JobOut = z.object({
  app_id: z.string(),
  name: z.string().nullable(),
  status: z.enum(['running', 'succeeded', 'failed', 'incomplete']),
  status_basis: z.string(),
  spark_version: z.string().nullable(),
  user: z.string().nullable(),
  attempts: z.array(z.object({ attempt_id: z.string().nullable(), start_time: z.string().nullable(), end_time: z.string().nullable(), last_updated: z.string().nullable(), duration_ms: z.number().nullable(), completed: z.boolean() })),
  start_time: z.string().nullable(),
  end_time: z.string().nullable(),
  duration_ms: z.number().nullable(),
  jobs: z.object({
    total: z.number(),
    succeeded: z.number(),
    failed: z.number(),
    running: z.number(),
    items: z.array(z.object({ job_id: z.number(), name: z.string().nullable(), status: z.string(), stage_ids: z.array(z.number()), num_tasks: z.number().nullable(), num_failed_tasks: z.number().nullable(), submission_time: z.string().nullable(), completion_time: z.string().nullable() })),
  }),
  executors: z.object({ count: z.number(), total_cores: z.number(), failed_tasks: z.number(), completed_tasks: z.number(), max_memory_bytes: z.number(), total_gc_time_ms: z.number() }),
  driver_log: z.string().nullable(),
});

const jobGet = defineCapability({
  name: 'compute.job.get',
  command: 'compute job get',
  summary: '查看 Spark 应用：尝试、持续时间、状态、作业与 executor 汇总（Spark history server REST）',
  domain: 'compute',
  adapter: SPARK_HISTORY_ADAPTER,
  auth_provider: 'none',
  guide: COMPUTE_GUIDE,
  operation: 'read',
  backend_modes: ['live'],
  inputs: { id: { type: 'string', required: true, description: 'Spark application id（如 local-1792239950565）' } },
  output: JobOut,
  prerequisites: ['spark 端点配置 history_url', '应用提交时开启事件日志（spark.eventLog.enabled=true），且 history server 读取同一目录'],
  notes: [
    'history server 不记录 local 模式驱动的退出码：status 由 attempt.completed 与作业状态推导（derived），依据见 status_basis',
    '未在 history 中找到：事件日志存在但未加载 → DATA_UNAVAILABLE；只有 driver 日志没有事件日志 → COLLECTION_DISABLED；都没有 → NOT_FOUND',
  ],
  examples: ['workctl compute job get --id local-1792239950565'],
  handler: async (ctx, inp) => {
    const sh = new SparkHistory(ctx);
    const id = checkAppId(inp.id);
    const app = await sh.application(id);
    const jobs: any[] = await sh.get(`/applications/${encodeURIComponent(id)}/jobs`);
    const execs: any[] = await sh.get(`/applications/${encodeURIComponent(id)}/allexecutors`).catch(() => sh.get(`/applications/${encodeURIComponent(id)}/executors`));
    const attempts = (app.attempts ?? []).map((a: any) => ({
      attempt_id: a.attemptId ?? null,
      start_time: iso(a.startTimeEpoch) ?? sparkTime(a.startTime),
      end_time: a.completed ? iso(a.endTimeEpoch) ?? sparkTime(a.endTime) : null,
      last_updated: iso(a.lastUpdatedEpoch) ?? sparkTime(a.lastUpdated),
      duration_ms: typeof a.duration === 'number' && a.completed ? a.duration : null,
      completed: Boolean(a.completed),
    }));
    const st = deriveStatus(app, jobs);
    const appVersion = (app.attempts ?? [])[0]?.appSparkVersion ?? null;
    const first = attempts[0];
    const startMs = first?.start_time ? Date.parse(first.start_time) : NaN;
    const ep = sh.ep;
    const driverLog = driverLogPath(ep, id);
    let driverChecked = false;
    if (st.status === 'succeeded') {
      // history has no driver exit code: a driver that failed before/after its jobs (e.g. table
      // not found, missing input) still shows a completed app without failed jobs
      if (driverLog) {
        try {
          const signal = driverFailureSignal(tailFile(driverLog, 400).lines);
          driverChecked = true;
          if (signal) {
            st.status = 'failed';
            st.basis = `应用已结束且没有失败作业，但 driver 日志末尾有未处理异常（驱动程序失败）: ${signal}`;
          } else st.basis = `${st.basis}；driver 日志末尾没有未处理异常`;
        } catch {
          driverChecked = false;
        }
      }
      if (!driverChecked) st.basis = `${st.basis}；未能检查 driver 日志：驱动在作业之外失败时仍会显示为 succeeded`;
    }
    return {
      data: {
        app_id: app.id,
        name: app.name ?? null,
        status: st.status,
        status_basis: st.basis,
        spark_version: appVersion,
        user: (app.attempts ?? [])[0]?.sparkUser ?? null,
        attempts,
        start_time: first?.start_time ?? null,
        end_time: first?.end_time ?? null,
        duration_ms: first?.duration_ms ?? (Number.isFinite(startMs) && st.status === 'running' ? Date.now() - startMs : null),
        jobs: {
          total: jobs.length,
          succeeded: jobs.filter((j) => j.status === 'SUCCEEDED').length,
          failed: jobs.filter((j) => j.status === 'FAILED').length,
          running: jobs.filter((j) => j.status === 'RUNNING').length,
          items: jobs.slice(0, 50).map((j) => ({
            job_id: j.jobId,
            name: j.name ?? null,
            status: j.status,
            stage_ids: j.stageIds ?? [],
            num_tasks: j.numTasks ?? null,
            num_failed_tasks: j.numFailedTasks ?? null,
            submission_time: sparkTime(j.submissionTime),
            completion_time: sparkTime(j.completionTime),
          })),
        },
        executors: {
          count: execs.length,
          total_cores: execs.reduce((a, e) => a + Number(e.totalCores ?? 0), 0),
          failed_tasks: execs.reduce((a, e) => a + Number(e.failedTasks ?? 0), 0),
          completed_tasks: execs.reduce((a, e) => a + Number(e.completedTasks ?? 0), 0),
          max_memory_bytes: execs.reduce((a, e) => a + Number(e.maxMemory ?? 0), 0),
          total_gc_time_ms: execs.reduce((a, e) => a + Number(e.totalGCTime ?? 0), 0),
        },
        driver_log: driverLog,
      },
      sources: [
        await sh.source(`GET /api/v1/applications/${id}`, appVersion ?? undefined),
        await sh.source(`GET /api/v1/applications/${id}/jobs`, appVersion ?? undefined),
        await sh.source(`GET /api/v1/applications/${id}/allexecutors`, appVersion ?? undefined),
        source('spark', SPARK_HISTORY_ADAPTER, { method: `status = f(attempt.completed, job states${driverChecked ? ', driver log tail' : ''})`, relation: 'derived' }),
      ],
      coverage: { complete: jobs.length <= 50, scope: id, ...(jobs.length > 50 ? { truncated: true, limit: 50 } : {}) },
    };
  },
});

// ---------------------------------------------------------------------------
// compute stage list
// ---------------------------------------------------------------------------

const stageList = defineCapability({
  name: 'compute.stage.list',
  command: 'compute stage list',
  summary: '列出 Spark 应用的阶段：状态、任务数/失败数、耗时、输入输出与 shuffle 字节、失败原因',
  domain: 'compute',
  adapter: SPARK_HISTORY_ADAPTER,
  auth_provider: 'none',
  guide: COMPUTE_GUIDE,
  operation: 'read',
  backend_modes: ['live'],
  inputs: {
    job_id: { type: 'string', required: true, description: 'Spark application id' },
    status: { type: 'enum', enum: ['active', 'complete', 'pending', 'failed', 'skipped'], description: '只看某种状态的阶段' },
    limit: { type: 'int', default: 100, description: '最多返回的阶段数' },
  },
  output: z.object({
    app_id: z.string(),
    stages: z.array(z.object({
      stage_id: z.number(),
      attempt_id: z.number(),
      name: z.string().nullable(),
      status: z.string(),
      num_tasks: z.number(),
      num_complete_tasks: z.number(),
      num_failed_tasks: z.number(),
      num_killed_tasks: z.number(),
      submission_time: z.string().nullable(),
      completion_time: z.string().nullable(),
      duration_ms: z.number().nullable(),
      executor_run_time_ms: z.number().nullable(),
      input_bytes: z.number(),
      input_records: z.number(),
      output_bytes: z.number(),
      output_records: z.number(),
      shuffle_read_bytes: z.number(),
      shuffle_write_bytes: z.number(),
      failure_reason: z.string().nullable(),
    })),
    total: z.number(),
  }),
  prerequisites: ['spark 端点配置 history_url；应用开启事件日志'],
  notes: ['duration_ms = completionTime - submissionTime（墙钟时间）；executor_run_time_ms 为所有任务执行时间之和'],
  examples: ['workctl compute stage list --job-id local-1792239950565', 'workctl compute stage list --job-id local-1792239950565 --status failed'],
  handler: async (ctx, inp) => {
    const sh = new SparkHistory(ctx);
    const id = checkAppId(inp.job_id);
    const app = await sh.application(id);
    const stages: any[] = await sh.get(`/applications/${encodeURIComponent(id)}/stages`, inp.status ? { status: inp.status } : undefined);
    const sorted = [...stages].sort((a, b) => a.stageId - b.stageId || a.attemptId - b.attemptId);
    const items = sorted.slice(0, inp.limit).map((s) => {
      const sub = sparkTime(s.submissionTime);
      const comp = sparkTime(s.completionTime);
      return {
        stage_id: s.stageId,
        attempt_id: s.attemptId ?? 0,
        name: s.name ?? null,
        status: s.status,
        num_tasks: s.numTasks ?? 0,
        num_complete_tasks: s.numCompleteTasks ?? 0,
        num_failed_tasks: s.numFailedTasks ?? 0,
        num_killed_tasks: s.numKilledTasks ?? 0,
        submission_time: sub,
        completion_time: comp,
        duration_ms: sub && comp ? Date.parse(comp) - Date.parse(sub) : null,
        executor_run_time_ms: s.executorRunTime ?? null,
        input_bytes: s.inputBytes ?? 0,
        input_records: s.inputRecords ?? 0,
        output_bytes: s.outputBytes ?? 0,
        output_records: s.outputRecords ?? 0,
        shuffle_read_bytes: s.shuffleReadBytes ?? 0,
        shuffle_write_bytes: s.shuffleWriteBytes ?? 0,
        failure_reason: s.failureReason ? String(s.failureReason).slice(0, 2000) : null,
      };
    });
    const ver = (app.attempts ?? [])[0]?.appSparkVersion;
    return {
      data: { app_id: id, stages: items, total: stages.length },
      sources: [await sh.source(`GET /api/v1/applications/${id}/stages${inp.status ? `?status=${inp.status}` : ''}`, ver)],
      coverage: { complete: stages.length <= items.length, scope: id, ...(stages.length > items.length ? { truncated: true, limit: inp.limit } : {}) },
    };
  },
});

// ---------------------------------------------------------------------------
// compute log get
// ---------------------------------------------------------------------------

const logGet = defineCapability({
  name: 'compute.log.get',
  command: 'compute log get',
  summary: '读取 Spark 应用 driver 日志尾部（来自 driver 日志目录）',
  domain: 'compute',
  adapter: SPARK_LOG_ADAPTER,
  auth_provider: 'filesystem',
  guide: COMPUTE_GUIDE,
  operation: 'read',
  backend_modes: ['live'],
  inputs: {
    job_id: { type: 'string', required: true, description: 'Spark application id' },
    limit_lines: { type: 'int', default: 200, description: '返回末尾行数（上限 2000）' },
  },
  output: z.object({
    app_id: z.string(),
    path: z.string(),
    in_progress: z.boolean().describe('应用仍在运行时日志为符号链接指向的临时文件'),
    bytes: z.number(),
    total_lines: z.number().nullable(),
    returned_lines: z.number(),
    truncated: z.boolean(),
    provenance: z.string(),
    lines: z.array(z.string()),
  }),
  prerequisites: ['spark 端点配置 driver_log_dir；提交脚本把 driver 输出落盘为 <driver_log_dir>/<app_id>.log'],
  notes: ['driver 日志不是 Spark REST 接口提供的：演示环境由 spark-submit 包装脚本（tee）落盘；YARN/K8s 环境应改用对应的日志聚合适配器'],
  examples: ['workctl compute log get --job-id local-1792239950565 --limit-lines 100'],
  handler: async (ctx, inp) => {
    const ep = ctx.endpoint('spark');
    const id = checkAppId(inp.job_id);
    const dir = ep.path('driver_log_dir');
    if (!dir) throw new WorkError('NOT_CONFIGURED', `spark 端点 ${ep.id} 未配置 driver_log_dir`);
    const p = driverLogPath(ep, id);
    if (!p) {
      throw new WorkError('NOT_FOUND', `driver 日志目录中没有 ${id}.log`, {
        hint: '应用可能不是经 workctl/演示包装脚本提交的，或日志已清理；可用 compute job get 查看 history 信息',
        details: { driver_log_dir: dir },
      });
    }
    const limit = Math.min(Math.max(1, inp.limit_lines), 2000);
    const t = tailFile(p, limit);
    return {
      data: {
        app_id: id,
        path: p,
        in_progress: t.real_path !== p,
        bytes: t.bytes,
        total_lines: t.total_lines,
        returned_lines: t.lines.length,
        truncated: t.truncated,
        provenance: 'spark-submit 包装脚本 tee 的 driver stdout/stderr（log4j 控制台输出）',
        lines: t.lines,
      },
      sources: [source('filesystem', SPARK_LOG_ADAPTER, { endpoint: `${ep.id}:driver_log_dir`, method: `tail ${id}.log`, relation: 'explicit' })],
      coverage: { complete: !t.truncated, scope: `${id}.log`, ...(t.truncated ? { truncated: true, limit } : {}) },
    };
  },
});

// ---------------------------------------------------------------------------
// compute queue get (Airflow pool)
// ---------------------------------------------------------------------------

const queueGet = defineCapability({
  name: 'compute.queue.get',
  command: 'compute queue get',
  summary: '查看计算资源队列/池的容量与占用（当前接入 Airflow pool）',
  domain: 'compute',
  adapter: 'airflow-pool',
  auth_provider: AIRFLOW_AUTH,
  guide: COMPUTE_GUIDE,
  operation: 'read',
  backend_modes: ['live'],
  inputs: { id: { type: 'string', required: true, description: '队列/池 ID，如 demo-batch-pool' } },
  output: z.object({
    id: z.string(),
    provider: z.literal('airflow-pool'),
    description: z.string().nullable(),
    slots: z.number(),
    occupied_slots: z.number(),
    running_slots: z.number(),
    queued_slots: z.number(),
    scheduled_slots: z.number(),
    deferred_slots: z.number(),
    open_slots: z.number(),
    include_deferred: z.boolean().nullable(),
    utilization: z.number().nullable().describe('occupied / slots'),
    waiting_slots: z.number().describe('queued + scheduled：已就绪但等待执行槽'),
  }),
  prerequisites: ['airflow 端点（pool 读权限）'],
  notes: ['Airflow pool 只限制并发槽，不代表 CPU/内存；reschedule 模式的传感器等待时不占槽', 'YARN 队列（容量、已用、挂起应用）为待接入能力 compute.yarn-queue.get'],
  examples: ['workctl compute queue get --id demo-batch-pool'],
  handler: async (ctx, inp) => {
    const af = new AirflowClient(ctx);
    const id = checkId(inp.id, '--id');
    const p = await af.getOrNull(`/pools/${encodeURIComponent(id)}`);
    if (!p) {
      const bound = ctx.resources().configured ? ctx.resources().get(id) : undefined;
      throw new WorkError('NOT_FOUND', `Airflow 中没有 pool ${id}`, {
        hint: bound ? `资源绑定中 ${id} 的 provider 为 ${String(bound.attributes.provider ?? '未知')}` : '用 Airflow UI 查看 pool 列表',
      });
    }
    const slots = Number(p.slots ?? 0);
    const occupied = Number(p.occupied_slots ?? 0);
    return {
      data: {
        id: p.name,
        provider: 'airflow-pool' as const,
        description: p.description ?? null,
        slots,
        occupied_slots: occupied,
        running_slots: Number(p.running_slots ?? 0),
        queued_slots: Number(p.queued_slots ?? 0),
        scheduled_slots: Number(p.scheduled_slots ?? 0),
        deferred_slots: Number(p.deferred_slots ?? 0),
        open_slots: Number(p.open_slots ?? 0),
        include_deferred: p.include_deferred ?? null,
        utilization: slots > 0 ? Math.round((occupied / slots) * 1000) / 1000 : null,
        waiting_slots: Number(p.queued_slots ?? 0) + Number(p.scheduled_slots ?? 0),
      },
      sources: [await af.source(`GET /api/v1/pools/${id}`)],
      coverage: { complete: true, scope: `pool ${id}`, notes: ['瞬时值（观测时刻），不是窗口统计'] },
    };
  },
});

const yarnQueue = defineCapability({
  name: 'compute.yarn-queue.get',
  command: 'compute yarn-queue get',
  summary: '查看 YARN 队列容量、已用资源与挂起应用（待接入）',
  domain: 'compute',
  adapter: 'yarn-rm-rest',
  auth_provider: 'yarn-kerberos-or-simple',
  guide: COMPUTE_GUIDE,
  operation: 'read',
  status: 'planned',
  inputs: { id: { type: 'string', required: true, description: 'YARN 队列路径，如 root.batch' } },
  notes: ['计划通过 ResourceManager REST /ws/v1/cluster/scheduler 接入'],
});

const instanceGet = defineCapability({
  name: 'compute.instance.get',
  command: 'compute instance get',
  summary: '查看计算实例（VM / 节点）规格、状态与负载（待接入）',
  domain: 'compute',
  adapter: 'cloud-compute-api',
  auth_provider: 'cloud-iam',
  guide: COMPUTE_GUIDE,
  operation: 'read',
  status: 'planned',
  inputs: { id: { type: 'string', required: true, description: '实例 ID' } },
  notes: ['需要云厂商/虚拟化平台适配器；演示环境没有 VM'],
});

export default defineDomain({
  name: 'compute',
  title: '计算作业',
  summary: 'Spark 应用（history server REST）、阶段、driver 日志与计算资源池',
  pillar: 'offline',
  guide: COMPUTE_GUIDE,
  skill: 'skills/offline-operations/SKILL.md',
  capabilities: [jobGet, stageList, logGet, queueGet, yarnQueue, instanceGet],
  probes: {
    spark: async (ctx, name) => {
      const sh = new SparkHistory(ctx, name);
      const version = await sh.get<{ spark?: string }>('/version').then((v) => v?.spark);
      const dirs = (['event_log_dir', 'driver_log_dir', 'query_state_dir'] as const).map((k) => {
        const p = sh.ep.path(k);
        return `${k}=${p ? (existsSync(p) ? '存在' : '不存在') : '未配置'}`;
      });
      return { ok: true, identity: 'anonymous (history server 无认证)', version, detail: `history server 可达；${dirs.join('，')}` };
    },
  },
});
