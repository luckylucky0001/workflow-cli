import { z } from 'zod';
import { PlanSchema } from '../../core/operations';
import { source, WorkError, type Result } from '../../core/output';
import { defineCapability, defineDomain } from '../../core/registry';
import { formatDuration, windowFromNow, type Ctx } from '../../core/runtime';
import { ContainerInfoSchema, describeContainer } from './describe';
import { containerName, cpuLimit, DOCKER_ADAPTER, dockerClient, filtersParam, shortId, type ContainerInspect, type ContainerSummary } from './docker';
import { planRestart, restartExecutor, restartPlanner, RESTART_KIND } from './restart';
import { parseStats, round, type DockerStats } from './stats';
import { ENV_LABEL, listServiceContainers, resolveEnv, selectionNotes, selectorMatches } from './workload';

const GUIDE = 'docs/guides/infrastructure.md';
const AUTH = 'docker-socket';
const PREREQ = ['profile 配置 endpoints.docker.<name>.socket（或 url）', '运行 workctl 的用户可访问 Docker socket'];

const serviceInputs = {
  service: { type: 'string' as const, required: true, description: '服务 ID（资源绑定中的 service，按容器标签解析）' },
  env: { type: 'string' as const, description: '环境（容器标签 workctl.env）；默认取 profile 的 env' },
};

const SelectorSchema = z.object({
  kind: z.enum(['label', 'name']).describe('label=按 Docker 标签；name=按资源绑定中声明的精确容器名'),
  label: z.string(),
  origin: z.enum(['binding-file', 'label-convention']),
  evidence: z.string(),
  matched_by: z.string().describe('实际匹配到容器的选择器，如 label workctl.resource=demo-mysql 或 binding attribute container=demo-mysql'),
});

// ---------------------------------------------------------------------------
// container workload get
// ---------------------------------------------------------------------------
const workloadGet = defineCapability({
  name: 'container.workload.get',
  command: 'container workload get',
  domain: 'container',
  summary: '查看服务对应容器的运行状态、健康、重启、退出码、OOM、镜像、端口和资源限制',
  description: '按容器标签（资源绑定或 workctl.service 约定）解析服务的容器，返回 Docker inspect 的实际状态。',
  inputs: serviceInputs,
  output: z.object({
    service: z.string(),
    env: z.string().nullable(),
    selector: SelectorSchema,
    provider: z.literal('docker'),
    containers: z.array(ContainerInfoSchema),
    summary: z.object({ total: z.number(), running: z.number(), unhealthy: z.number(), oom_killed: z.number(), restarted: z.number() }),
  }),
  adapter: DOCKER_ADAPTER,
  operation: 'read',
  auth_provider: AUTH,
  guide: GUIDE,
  prerequisites: PREREQ,
  notes: [
    'RestartCount 只统计重启策略触发的自动重启；手动 docker restart 不计入，需结合 container event list',
    '服务与容器的关系只来自标签/资源绑定，不按名称相似度推断',
    'Kubernetes 工作负载是规划中的 provider（见 container.kubernetes.workload.get）',
  ],
  examples: ['workctl container workload get --service demo-order --env sandbox'],
  handler: async (ctx, i): Promise<Result> => {
    const docker = dockerClient(ctx);
    const env = resolveEnv(ctx, i.env);
    const sc = await listServiceContainers(ctx, docker, i.service, env);
    const containers = [];
    for (const c of sc.containers) containers.push(describeContainer(await docker.getJson<ContainerInspect>(`/containers/${c.Id}/json`)));
    const warnings: string[] = [];
    if (!containers.length) warnings.push(`没有容器匹配 ${sc.selector.label}${env ? `（env=${env}）` : ''}；服务可能未部署在该 Docker 主机，或标签未设置`);
    return {
      data: {
        service: i.service,
        env,
        selector: sc.selector,
        provider: 'docker',
        containers,
        summary: {
          total: containers.length,
          running: containers.filter((c) => c.state === 'running').length,
          unhealthy: containers.filter((c) => c.health === 'unhealthy').length,
          oom_killed: containers.filter((c) => c.oom_killed).length,
          restarted: containers.filter((c) => c.restart_count > 0).length,
        },
      },
      sources: [
        await docker.source(`GET /containers/json?all=1&filters={label:${sc.selector.label}}`),
        await docker.source('GET /containers/{id}/json'),
        ...(sc.selector.origin === 'binding-file' ? [source('workctl', 'resource-bindings', { method: sc.selector.evidence, relation: 'explicit' })] : []),
      ],
      coverage: { complete: true, scope: `Docker 主机 ${docker.endpointId} 上带标签 ${sc.selector.label} 的容器（含已停止）`, notes: selectionNotes(sc) },
      warnings,
    };
  },
});

// ---------------------------------------------------------------------------
// container event list
// ---------------------------------------------------------------------------
interface DockerEvent {
  Type: string;
  Action: string;
  Actor: { ID: string; Attributes: Record<string, string> };
  time: number;
  timeNano?: number;
}

export const DAEMON_EVENT_BUFFER = 256;

/**
 * The daemon keeps a fixed-size ring buffer of recent events. When it is full the
 * oldest event it returns marks the start of the visible history.
 */
export function eventHorizon(all: { time: number; timeNano?: number }[], windowStartMs: number): { buffer_full: boolean; visible_since: string } {
  const full = all.length >= DAEMON_EVENT_BUFFER;
  if (!full || !all.length) return { buffer_full: false, visible_since: new Date(windowStartMs).toISOString() };
  const oldest = Math.min(...all.map((e) => (e.timeNano ? Math.floor(e.timeNano / 1e6) : e.time * 1000)));
  return { buffer_full: oldest > windowStartMs, visible_since: new Date(Math.max(oldest, windowStartMs)).toISOString() };
}

export function parseEventStream(text: string): DockerEvent[] {
  const out: DockerEvent[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // ignore partial lines
    }
  }
  return out;
}

const EventSchema = z.object({
  time: z.string(),
  type: z.string(),
  action: z.string(),
  container_id: z.string(),
  container_name: z.string().nullable(),
  image: z.string().nullable(),
  exit_code: z.number().nullable(),
  signal: z.string().nullable(),
  attributes: z.record(z.string(), z.string()).describe('事件属性（不含容器标签）'),
});

const eventList = defineCapability({
  name: 'container.event.list',
  command: 'container event list',
  domain: 'container',
  summary: '列出服务容器在时间窗口内的 Docker 事件（启动、退出、OOM、重启、健康状态变化）',
  inputs: {
    ...serviceInputs,
    window: { type: 'duration', default: '1h', description: '回看窗口，如 15m、1h、6h' },
    include_exec: { type: 'bool', default: false, description: '是否包含 exec_* 事件（健康检查会产生大量 exec 事件）' },
  },
  output: z.object({
    service: z.string(),
    env: z.string().nullable(),
    selector: SelectorSchema,
    window: z.object({ start: z.string(), end: z.string() }),
    visible_since: z.string().describe('守护进程事件缓冲实际覆盖的起点；早于此的事件不可见'),
    daemon_buffer_full: z.boolean(),
    events: z.array(EventSchema),
    counts_by_action: z.record(z.string(), z.number()),
  }),
  adapter: DOCKER_ADAPTER,
  operation: 'read',
  auth_provider: AUTH,
  guide: GUIDE,
  prerequisites: PREREQ,
  notes: [
    'Docker 守护进程只在内存中保留最近有限条事件（守护进程重启后清空），窗口早期的事件可能已不可见',
    '事件按时间正序返回',
  ],
  examples: ['workctl container event list --service demo-order --window 1h'],
  handler: async (ctx, i): Promise<Result> => {
    const docker = dockerClient(ctx);
    const env = resolveEnv(ctx, i.env);
    const sc = await listServiceContainers(ctx, docker, i.service, env);
    const now = new Date();
    const win = windowFromNow(i.window as number, now);
    const since = Math.floor(Date.parse(win.start) / 1000);
    const until = Math.floor(now.getTime() / 1000);
    // Unfiltered read: the daemon's ring buffer is shared by all containers, so the
    // oldest event it still holds tells us how far back the visible history reaches.
    const r = await docker.get<string>(`/events?since=${since}&until=${until}`);
    const all = parseEventStream(r.text);
    const horizon = eventHorizon(all, Date.parse(win.start));
    // container events carry the container's labels and `name` as attributes
    const raw = all.filter((e) => e.Type === 'container' && selectorMatches(sc.selector, { labels: e.Actor?.Attributes ?? {}, name: e.Actor?.Attributes?.name ?? '' }));
    let execSkipped = 0;
    let envSkipped = 0;
    const events: z.infer<typeof EventSchema>[] = [];
    for (const e of raw) {
      const a = e.Actor?.Attributes ?? {};
      if (env && a[ENV_LABEL] && a[ENV_LABEL] !== env) {
        envSkipped++;
        continue;
      }
      if (!i.include_exec && e.Action.startsWith('exec_')) {
        execSkipped++;
        continue;
      }
      const labelKeys = new Set(Object.keys(a).filter((k) => k.includes('.') || k === 'maintainer'));
      const attrs: Record<string, string> = {};
      for (const [k, v] of Object.entries(a)) if (!labelKeys.has(k) && !['name', 'image', 'exitCode', 'signal'].includes(k)) attrs[k] = v;
      events.push({
        time: e.timeNano ? new Date(Math.floor(e.timeNano / 1e6)).toISOString() : new Date(e.time * 1000).toISOString(),
        type: e.Type,
        action: e.Action,
        container_id: shortId(e.Actor.ID),
        container_name: a.name ?? null,
        image: a.image ?? null,
        exit_code: a.exitCode !== undefined ? Number(a.exitCode) : null,
        signal: a.signal ?? null,
        attributes: attrs,
      });
    }
    const counts: Record<string, number> = {};
    for (const e of events) {
      const k = e.action.split(':')[0];
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const notes = [...selectionNotes(sc), 'Docker 守护进程只保留最近有限条事件，且重启后清空；窗口内事件不全时以容器 inspect 状态为准'];
    if (execSkipped) notes.push(`已省略 ${execSkipped} 条 exec_* 事件（--include-exec 可返回）`);
    if (envSkipped) notes.push(`已排除 ${envSkipped} 条其他环境的事件`);
    if (horizon.buffer_full) {
      notes.push(
        `守护进程事件缓冲已满（${all.length} 条，上限约 ${DAEMON_EVENT_BUFFER}），可见历史只从 ${horizon.visible_since} 开始；` +
          '更早的事件已被挤出（健康检查产生的 exec 事件会快速占满缓冲）。更长历史需要事件采集（如日志/事件转发）',
      );
    }
    return {
      data: {
        service: i.service,
        env,
        selector: sc.selector,
        window: win,
        visible_since: horizon.visible_since,
        daemon_buffer_full: horizon.buffer_full,
        events,
        counts_by_action: counts,
      },
      sources: [await docker.source(`GET /events?since=${since}&until=${until}（本地按标签 ${sc.selector.label} 过滤）`)],
      coverage: {
        complete: !horizon.buffer_full,
        window: win,
        ...(horizon.buffer_full ? { truncated: true } : {}),
        scope: horizon.buffer_full
          ? `窗口 ${formatDuration(i.window as number)} 中仅 ${horizon.visible_since} 之后的部分可见`
          : `守护进程内存中保留的事件（窗口 ${formatDuration(i.window as number)}）`,
        notes,
      },
    };
  },
});

// ---------------------------------------------------------------------------
// container stats get (snapshot)
// ---------------------------------------------------------------------------
const StatsSchema = z.object({
  read_at: z.string().nullable(),
  preread_at: z.string().nullable(),
  sample_interval_ms: z.number().nullable().describe('CPU 使用率所依据的两次守护进程采样间隔'),
  cpu: z.object({ cores_used: z.number(), percent: z.number().describe('100 = 1 核（与 docker stats 一致）'), online_cpus: z.number(), percent_of_limit: z.number().nullable() }).nullable(),
  memory: z
    .object({
      usage_bytes: z.number(),
      working_set_bytes: z.number().describe('usage 减去 inactive_file（与 docker stats 一致）'),
      limit_bytes: z.number().nullable(),
      limit_source: z.enum(['container', 'host']),
      percent_of_limit: z.number().nullable(),
    })
    .nullable(),
  pids: z.number().nullable(),
  network: z.object({ rx_bytes: z.number(), tx_bytes: z.number(), rx_errors: z.number(), tx_errors: z.number() }).nullable().describe('自容器启动以来累计值'),
  block_io: z.object({ read_bytes: z.number(), write_bytes: z.number() }).nullable().describe('自容器启动以来累计值'),
  notes: z.array(z.string()),
});

async function containerStats(ctx: Ctx, id: string, inspect: ContainerInspect) {
  const docker = dockerClient(ctx);
  const s = await docker.getJson<DockerStats>(`/containers/${id}/stats?stream=false`);
  return parseStats(s, cpuLimit(inspect.HostConfig), inspect.HostConfig.Memory);
}

const statsGet = defineCapability({
  name: 'container.stats.get',
  command: 'container stats get',
  domain: 'container',
  summary: '获取服务容器的资源使用快照：CPU、内存（相对上限）、进程数、网络与块设备 I/O 累计值',
  inputs: serviceInputs,
  output: z.object({
    kind: z.literal('snapshot'),
    observed_at: z.string(),
    service: z.string(),
    env: z.string().nullable(),
    containers: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        state: z.string(),
        limits: z.object({ cpus: z.number().nullable(), memory_bytes: z.number().nullable() }),
        stats: StatsSchema.nullable(),
        note: z.string().nullable(),
      }),
    ),
  }),
  adapter: DOCKER_ADAPTER,
  operation: 'read',
  auth_provider: AUTH,
  guide: GUIDE,
  prerequisites: PREREQ,
  notes: [
    '这是快照（snapshot），不是时间窗口统计：CPU 为守护进程两次采样（约 1s）间的速率，内存为当前值',
    '网络与块设备 I/O 是自容器启动以来的累计值，不能当作窗口流量；窗口趋势请用 metric query',
  ],
  examples: ['workctl container stats get --service demo-order'],
  handler: async (ctx, i): Promise<Result> => {
    const docker = dockerClient(ctx);
    const env = resolveEnv(ctx, i.env);
    const sc = await listServiceContainers(ctx, docker, i.service, env);
    const containers = [];
    for (const c of sc.containers) {
      const insp = await docker.getJson<ContainerInspect>(`/containers/${c.Id}/json`);
      const limits = { cpus: cpuLimit(insp.HostConfig), memory_bytes: insp.HostConfig.Memory && insp.HostConfig.Memory > 0 ? insp.HostConfig.Memory : null };
      if (!insp.State.Running) {
        containers.push({ id: shortId(c.Id), name: containerName(insp), state: insp.State.Status, limits, stats: null, note: '容器未运行，没有资源使用数据' });
        continue;
      }
      containers.push({ id: shortId(c.Id), name: containerName(insp), state: insp.State.Status, limits, stats: await containerStats(ctx, c.Id, insp), note: null });
    }
    const observed = new Date().toISOString();
    return {
      data: { kind: 'snapshot', observed_at: observed, service: i.service, env, matched_by: sc.selector.matched_by, containers },
      sources: [await docker.source('GET /containers/{id}/stats?stream=false', 'sampled'), await docker.source('GET /containers/{id}/json')],
      coverage: {
        complete: true,
        scope: 'snapshot：单次采样，不代表时间窗口',
        notes: [...selectionNotes(sc), 'CPU 使用率来自守护进程 precpu→cpu 两次采样；网络/块 I/O 为累计值'],
      },
      warnings: containers.length ? [] : [`没有容器匹配 ${sc.selector.label}`],
    };
  },
});

// ---------------------------------------------------------------------------
// capacity summary --env (snapshot)
// ---------------------------------------------------------------------------
interface DockerInfo {
  NCPU: number;
  MemTotal: number;
  ServerVersion: string;
  Name?: string;
  OperatingSystem?: string;
  CgroupVersion?: string;
}

const CapacityItem = z.object({
  name: z.string(),
  id: z.string(),
  owner_label: z.string().nullable().describe('workctl.service 或 workctl.resource 标签'),
  state: z.string(),
  limits: z.object({ cpus: z.number().nullable(), memory_bytes: z.number().nullable() }),
  usage: z
    .object({
      cpu_cores: z.number().nullable(),
      cpu_percent_of_limit: z.number().nullable(),
      memory_working_set_bytes: z.number().nullable(),
      memory_percent_of_limit: z.number().nullable(),
      pids: z.number().nullable(),
    })
    .nullable(),
  oom_killed: z.boolean(),
  restart_count: z.number(),
  flags: z.array(z.string()),
});

export function capacityFlags(item: { limits: { cpus: number | null; memory_bytes: number | null }; usage: z.infer<typeof CapacityItem>['usage']; oom_killed: boolean; restart_count: number }): string[] {
  const f: string[] = [];
  if (item.limits.cpus === null) f.push('no_cpu_limit');
  if (item.limits.memory_bytes === null) f.push('no_memory_limit');
  if (item.usage?.cpu_percent_of_limit != null && item.usage.cpu_percent_of_limit >= 80) f.push('cpu_above_80pct_of_limit');
  if (item.usage?.memory_percent_of_limit != null && item.usage.memory_percent_of_limit >= 80) f.push('memory_above_80pct_of_limit');
  if (item.oom_killed) f.push('oom_killed_last_exit');
  if (item.restart_count > 0) f.push('auto_restarted');
  return f;
}

const capacitySummary = defineCapability({
  name: 'container.capacity.summary',
  command: 'capacity summary',
  domain: 'container',
  summary: '汇总环境内容器的资源上限与当前使用（快照），标出未设上限、接近上限、OOM 等',
  inputs: { env: { type: 'string', description: '环境（容器标签 workctl.env）；默认取 profile 的 env' } },
  output: z.object({
    kind: z.literal('snapshot'),
    observed_at: z.string(),
    env: z.string(),
    host: z.object({ name: z.string().nullable(), ncpu: z.number(), mem_total_bytes: z.number(), docker_version: z.string(), cgroup_version: z.string().nullable() }),
    totals: z.object({
      containers: z.number(),
      running: z.number(),
      cpu_limit_sum: z.number(),
      cpu_unlimited: z.number(),
      memory_limit_sum_bytes: z.number(),
      memory_unlimited: z.number(),
      cpu_used_cores: z.number(),
      memory_working_set_bytes: z.number(),
      cpu_limit_to_host_ratio: z.number(),
      memory_limit_to_host_ratio: z.number(),
    }),
    containers: z.array(CapacityItem),
  }),
  adapter: DOCKER_ADAPTER,
  operation: 'read',
  auth_provider: AUTH,
  guide: GUIDE,
  prerequisites: PREREQ,
  notes: [
    '快照：上限来自 inspect，使用量来自单次 stats 采样；容量趋势需结合 metric query 的窗口数据',
    '未设置上限的容器在合计中单独计数（cpu_unlimited / memory_unlimited），不计入上限合计',
    '只统计带 workctl.env=<env> 标签的容器',
  ],
  examples: ['workctl capacity summary --env sandbox'],
  handler: async (ctx, i): Promise<Result> => {
    const docker = dockerClient(ctx);
    const env = resolveEnv(ctx, i.env);
    if (!env) throw new WorkError('INVALID_ARGUMENT', '需要 --env 或 profile env');
    const info = await docker.getJson<DockerInfo>('/info');
    const list = await docker.getJson<ContainerSummary[]>(`/containers/json?all=1&filters=${filtersParam({ label: [`${ENV_LABEL}=${env}`] })}`);
    const items: z.infer<typeof CapacityItem>[] = [];
    const notes: string[] = [`容器范围: label ${ENV_LABEL}=${env}`];
    await Promise.all(
      list.map(async (c) => {
        const insp = await docker.getJson<ContainerInspect>(`/containers/${c.Id}/json`);
        const limits = { cpus: cpuLimit(insp.HostConfig), memory_bytes: insp.HostConfig.Memory && insp.HostConfig.Memory > 0 ? insp.HostConfig.Memory : null };
        let usage: z.infer<typeof CapacityItem>['usage'] = null;
        if (insp.State.Running) {
          try {
            const st = await containerStats(ctx, c.Id, insp);
            usage = {
              cpu_cores: st.cpu?.cores_used ?? null,
              cpu_percent_of_limit: st.cpu?.percent_of_limit ?? null,
              memory_working_set_bytes: st.memory?.working_set_bytes ?? null,
              memory_percent_of_limit: limits.memory_bytes && st.memory ? round((st.memory.working_set_bytes / limits.memory_bytes) * 100, 2) : null,
              pids: st.pids,
            };
          } catch (e) {
            notes.push(`${containerName(insp)}: stats 读取失败 (${e instanceof Error ? e.message : String(e)})`);
          }
        }
        const labels = insp.Config.Labels ?? {};
        const item = {
          name: containerName(insp),
          id: shortId(insp.Id),
          owner_label: labels['workctl.service'] ? `workctl.service=${labels['workctl.service']}` : labels['workctl.resource'] ? `workctl.resource=${labels['workctl.resource']}` : null,
          state: insp.State.Status,
          limits,
          usage,
          oom_killed: insp.State.OOMKilled,
          restart_count: insp.RestartCount ?? 0,
          flags: [] as string[],
        };
        item.flags = capacityFlags(item);
        items.push(item);
      }),
    );
    items.sort((a, b) => a.name.localeCompare(b.name));
    const sum = (xs: (number | null | undefined)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);
    const cpuLimitSum = round(sum(items.map((x) => x.limits.cpus)), 3);
    const memLimitSum = sum(items.map((x) => x.limits.memory_bytes));
    const failedStats = items.filter((x) => x.state === 'running' && !x.usage).length;
    return {
      status: failedStats ? 'partial' : 'success',
      data: {
        kind: 'snapshot',
        observed_at: new Date().toISOString(),
        env,
        host: { name: info.Name ?? null, ncpu: info.NCPU, mem_total_bytes: info.MemTotal, docker_version: info.ServerVersion, cgroup_version: info.CgroupVersion ?? null },
        totals: {
          containers: items.length,
          running: items.filter((x) => x.state === 'running').length,
          cpu_limit_sum: cpuLimitSum,
          cpu_unlimited: items.filter((x) => x.limits.cpus === null).length,
          memory_limit_sum_bytes: memLimitSum,
          memory_unlimited: items.filter((x) => x.limits.memory_bytes === null).length,
          cpu_used_cores: round(sum(items.map((x) => x.usage?.cpu_cores)), 4),
          memory_working_set_bytes: sum(items.map((x) => x.usage?.memory_working_set_bytes)),
          cpu_limit_to_host_ratio: round(cpuLimitSum / (info.NCPU || 1), 3),
          memory_limit_to_host_ratio: round(memLimitSum / (info.MemTotal || 1), 3),
        },
        containers: items,
      },
      sources: [
        await docker.source('GET /info'),
        await docker.source(`GET /containers/json?filters={label:${ENV_LABEL}=${env}}`),
        await docker.source('GET /containers/{id}/stats?stream=false', 'sampled'),
      ],
      coverage: {
        complete: failedStats === 0,
        scope: `snapshot：Docker 主机 ${docker.endpointId} 上 ${ENV_LABEL}=${env} 的容器`,
        notes: [...notes, '上限合计只计已设置上限的容器；使用量为单次快照'],
      },
      warnings: items.length ? [] : [`没有容器带标签 ${ENV_LABEL}=${env}`],
    };
  },
});

// ---------------------------------------------------------------------------
// container workload restart-plan
// ---------------------------------------------------------------------------
const restartPlan = defineCapability({
  name: 'container.workload.restart_plan',
  command: 'container workload restart-plan',
  domain: 'container',
  summary: '为重启服务容器生成计划：实际目标容器、依赖影响、前置条件与步骤（不执行）',
  inputs: serviceInputs,
  output: PlanSchema,
  adapter: DOCKER_ADAPTER,
  operation: 'plan',
  auth_provider: AUTH,
  guide: GUIDE,
  prerequisites: PREREQ,
  idempotent: true,
  cancellable: false,
  notes: [
    '计划预览不是执行成功的证据；执行用 workctl operation execute --id <plan> --confirm <plan>（需要 profile allow_execute）',
    '等价于 workctl operation plan --action container.restart --param service=<service>',
    '执行时逐个重启并轮询 inspect 校验已重新运行（及健康检查状态）',
  ],
  examples: ['workctl container workload restart-plan --service demo-order --env sandbox'],
  handler: async (ctx, i): Promise<Result> => {
    const draft = await planRestart(ctx, { service: i.service, ...(i.env ? { env: i.env } : {}) });
    const plan = ctx.plans().create(draft, { profile: ctx.profileName, env: ctx.env, executable: true });
    const docker = dockerClient(ctx);
    return {
      data: plan,
      sources: [await docker.source('GET /containers/json + /containers/{id}/json'), source('workctl', 'plan-store', { endpoint: ctx.plans().dir, relation: 'derived' })],
      coverage: { complete: true, scope: '计划生成时解析出的目标', notes: [`执行: workctl operation execute --id ${plan.id} --confirm ${plan.id}`] },
    };
  },
});

// ---------------------------------------------------------------------------
// planned
// ---------------------------------------------------------------------------
const k8sWorkload = defineCapability({
  name: 'container.kubernetes.workload.get',
  command: 'kubernetes workload get',
  domain: 'container',
  summary: '查看 Kubernetes Deployment/StatefulSet/Pod 状态、事件与资源配额（规划中）',
  adapter: 'kubernetes-api (待接入)',
  operation: 'read',
  auth_provider: 'kubeconfig',
  guide: GUIDE,
  status: 'planned',
  notes: ['与 container workload get 使用同一对象模型（服务 → 工作负载 → 实例）'],
});

export default defineDomain({
  name: 'container',
  title: '容器与资源容量',
  summary: '容器工作负载状态、事件、资源快照、容量汇总与受控重启（Docker Engine API；Kubernetes 规划中）',
  pillar: 'infrastructure',
  guide: GUIDE,
  skill: 'skills/infra-operations/SKILL.md',
  capabilities: [workloadGet, eventList, statsGet, capacitySummary, restartPlan, k8sWorkload],
  planners: [restartPlanner],
  executors: { [RESTART_KIND]: restartExecutor },
  probes: {
    docker: async (ctx, name) => {
      const docker = dockerClient(ctx, name);
      const v = await docker.version();
      return { ok: true, version: `${v.Version} (API ${v.ApiVersion})`, detail: `${v.Os ?? ''}/${v.Arch ?? ''}` };
    },
  },
});
