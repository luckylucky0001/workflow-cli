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
import { capacityFlags } from './flags';
import { k8sCapacitySummary, k8sEventList, k8sProbe, k8sStatsGet, k8sWorkloadGet } from './k8s-capabilities';
import { kubeBindingFor, kubeBindingsInEnv } from './k8s-workload';
import { K8S_ADAPTER, kubeClient } from './kubernetes';

export { capacityFlags } from './flags';

const GUIDE = 'docs/guides/infrastructure.md';
const AUTH = 'docker-socket | kubernetes-bearer';
/** Static capability metadata; each result's meta.sources names the adapter actually used. */
const ADAPTERS = `${DOCKER_ADAPTER} | ${K8S_ADAPTER}`;
const PREREQ = [
  'Docker（默认）：profile 配置 endpoints.docker.<name>.socket（或 url），运行 workctl 的用户可访问 Docker socket',
  'Kubernetes：资源绑定中服务 runs_on 的 container.workload 声明 endpoint {kind: kubernetes}；profile 配置 endpoints.kubernetes.<name>（server + token_ref 或 kubeconfig）',
];
const PROVIDER_NOTE = 'provider 由资源绑定决定：服务（或其 runs_on 的 container.workload）绑定 kubernetes 端点时走 Kubernetes API，否则走 Docker（默认）';
const ProviderSchema = z.enum(['docker', 'kubernetes']);

const serviceInputs = {
  service: { type: 'string' as const, required: true, description: '服务 ID（资源绑定中的 service；Docker 按容器标签、Kubernetes 按绑定的 Pod 标签选择器解析）' },
  env: { type: 'string' as const, description: '环境（容器标签 workctl.env）；默认取 profile 的 env' },
};

const SelectorSchema = z.object({
  kind: z.enum(['label', 'name']).describe('label=按 Docker 标签 / Kubernetes 标签选择器；name=按资源绑定中声明的精确容器名'),
  label: z.string().describe('Docker: key=value；Kubernetes: labelSelector 字符串（如 app=demo-order,tier=web）'),
  origin: z.enum(['binding-file', 'label-convention']),
  evidence: z.string(),
  matched_by: z.string().describe('实际匹配到容器的选择器，如 label workctl.resource=demo-mysql、binding attribute container=demo-mysql，或 Kubernetes label selector app=demo-order（Deployment demo/demo-order 的 spec.selector）'),
});

const KubeWorkloadSchema = z.object({
  kind: z.string(),
  name: z.string(),
  namespace: z.string().nullable(),
  uid: z.string().nullable(),
  generation: z.number().nullable(),
  observed_generation: z.number().nullable(),
  replicas: z.number(),
  ready_replicas: z.number(),
  updated_replicas: z.number(),
  available_replicas: z.number(),
  selector: z.string(),
  progressing: z.object({ status: z.string(), reason: z.string().nullable() }).nullable(),
  restarted_at: z.string().nullable().describe('Pod 模板注解 kubectl.kubernetes.io/restartedAt'),
});

// ---------------------------------------------------------------------------
// container workload get
// ---------------------------------------------------------------------------
const workloadGet = defineCapability({
  name: 'container.workload.get',
  command: 'container workload get',
  domain: 'container',
  summary: '查看服务对应容器的运行状态、健康、重启、退出码、OOM、镜像、端口和资源限制',
  description: '按容器标签（资源绑定或 workctl.service 约定）解析服务的容器，返回 Docker inspect 的实际状态；服务绑定到 Kubernetes 时按标签选择器解析 Deployment/StatefulSet 的 Pod，每个容器一条。',
  inputs: serviceInputs,
  output: z.object({
    service: z.string(),
    env: z.string().nullable(),
    selector: SelectorSchema,
    provider: ProviderSchema,
    containers: z.array(ContainerInfoSchema),
    summary: z.object({ total: z.number(), running: z.number(), unhealthy: z.number(), oom_killed: z.number(), restarted: z.number() }),
    kubernetes: z
      .object({
        endpoint: z.string(),
        namespace: z.string(),
        server_version: z.string().nullable(),
        label_selector: z.string(),
        workloads: z.array(KubeWorkloadSchema),
        pods: z.array(z.object({ name: z.string(), phase: z.string().nullable(), ready: z.boolean(), node: z.string().nullable(), pod_ip: z.string().nullable(), start_time: z.string().nullable(), restarts: z.number() })),
      })
      .optional()
      .describe('仅 Kubernetes provider：工作负载 rollout 状态与 Pod 列表'),
  }),
  adapter: ADAPTERS,
  operation: 'read',
  auth_provider: AUTH,
  guide: GUIDE,
  prerequisites: PREREQ,
  notes: [
    PROVIDER_NOTE,
    'Docker：RestartCount 只统计重启策略触发的自动重启；手动 docker restart 不计入，需结合 container event list',
    'Kubernetes：restart_count 为 kubelet 统计的容器重启（含存活探针失败、OOM），Pod 被替换后归零；oom_killed 来自 state/lastState.terminated.reason=OOMKilled；容器名为 <pod>/<container>',
    '服务与容器的关系只来自标签/资源绑定，不按名称相似度推断',
  ],
  examples: ['workctl container workload get --service demo-order --env sandbox'],
  handler: async (ctx, i): Promise<Result> => {
    const env = resolveEnv(ctx, i.env);
    const kb = kubeBindingFor(ctx, i.service, env);
    if (kb) return k8sWorkloadGet(ctx, kb, i.service, env);
    const docker = dockerClient(ctx);
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
        await docker.source(`GET /containers/json?all=1&filters={${sc.selector.kind === 'name' ? `name:${sc.selector.label.slice(5)}（精确名）` : `label:${sc.selector.label}`}}`),
        await docker.source('GET /containers/{id}/json'),
        ...(sc.selector.origin === 'binding-file' ? [source('workctl', 'resource-bindings', { method: sc.selector.evidence, relation: 'explicit' })] : []),
      ],
      coverage: { complete: true, scope: `Docker 主机 ${docker.endpointId} 上匹配 ${sc.selector.matched_by} 的容器（含已停止）`, notes: selectionNotes(sc) },
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
  summary: '列出服务容器在时间窗口内的事件（Docker：启动、退出、OOM、重启、健康状态变化；Kubernetes：Pod/工作负载事件）',
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
    visible_since: z.string().describe('事件历史实际覆盖的起点（Docker 守护进程缓冲 / Kubernetes event-ttl）；早于此的事件不可见'),
    daemon_buffer_full: z.boolean().describe('Docker 守护进程事件缓冲是否已满；Kubernetes 恒为 false（保留由 event-ttl 决定，见 retention）'),
    events: z.array(EventSchema),
    counts_by_action: z.record(z.string(), z.number()),
    provider: ProviderSchema.optional(),
    retention: z
      .object({ kind: z.literal('kubernetes-event-ttl'), ttl: z.string(), configured: z.boolean().describe('false 表示按默认 1h 计算（未在端点 event_ttl 中声明）') })
      .optional()
      .describe('仅 Kubernetes provider：事件保留口径'),
  }),
  adapter: ADAPTERS,
  operation: 'read',
  auth_provider: AUTH,
  guide: GUIDE,
  prerequisites: PREREQ,
  notes: [
    PROVIDER_NOTE,
    'Docker 守护进程只在内存中保留最近有限条事件（守护进程重启后清空），窗口早期的事件可能已不可见',
    'Kubernetes 事件由 API server 按 event-ttl 保留（默认 1h），窗口超过 TTL 时 coverage.complete=false；action 为事件 reason（如 BackOff、Killing、OOMKilling），type 为对象类型（pod/deployment/replicaset）',
    '事件按时间正序返回',
  ],
  examples: ['workctl container event list --service demo-order --window 1h'],
  handler: async (ctx, i): Promise<Result> => {
    const env = resolveEnv(ctx, i.env);
    const kb = kubeBindingFor(ctx, i.service, env);
    if (kb) return k8sEventList(ctx, kb, i.service, env, i.window as number);
    const docker = dockerClient(ctx);
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
  summary: '获取服务容器的资源使用快照：CPU、内存（相对上限）、进程数、网络与块设备 I/O 累计值（Kubernetes 来自 metrics-server）',
  inputs: serviceInputs,
  output: z.object({
    kind: z.literal('snapshot'),
    observed_at: z.string(),
    service: z.string(),
    matched_by: z.string().describe('匹配容器所用的选择器'),
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
    provider: ProviderSchema.optional(),
  }),
  adapter: ADAPTERS,
  operation: 'read',
  auth_provider: AUTH,
  guide: GUIDE,
  prerequisites: PREREQ,
  notes: [
    PROVIDER_NOTE,
    '这是快照（snapshot），不是时间窗口统计：CPU 为守护进程两次采样（约 1s）间的速率，内存为当前值',
    '网络与块设备 I/O 是自容器启动以来的累计值，不能当作窗口流量；窗口趋势请用 metric query',
    'Kubernetes：依赖 metrics.k8s.io（metrics-server），API 不存在返回 COLLECTION_DISABLED；CPU 为 metrics window 内平均速率，内存为工作集，pids/网络/块 I/O 为 null；online_cpus 取节点容量（无 get nodes 权限时为 0，表示未知）',
  ],
  examples: ['workctl container stats get --service demo-order'],
  handler: async (ctx, i): Promise<Result> => {
    const env = resolveEnv(ctx, i.env);
    const kb = kubeBindingFor(ctx, i.service, env);
    if (kb) return k8sStatsGet(ctx, kb, i.service, env);
    const docker = dockerClient(ctx);
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
  name: z.string().describe('Docker 容器名；Kubernetes 为 <pod>/<container>'),
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
  flags: z.array(z.string()).describe('no_cpu_limit、no_memory_limit、cpu/memory_above_80pct_of_limit、oom_killed_last_exit、auto_restarted；Kubernetes 另有 no_cpu_request、no_memory_request'),
  namespace: z.string().nullable().optional().describe('仅 Kubernetes'),
  node: z.string().nullable().optional().describe('仅 Kubernetes'),
  owner: z.string().nullable().optional().describe('仅 Kubernetes：控制者 ownerReference'),
  requests: z.object({ cpus: z.number().nullable(), memory_bytes: z.number().nullable() }).optional().describe('仅 Kubernetes：resources.requests'),
});

const capacitySummary = defineCapability({
  name: 'container.capacity.summary',
  command: 'capacity summary',
  domain: 'container',
  summary: '汇总环境内容器的资源上限与当前使用（快照），标出未设上限、接近上限、OOM 等',
  inputs: {
    env: { type: 'string', description: '环境（容器标签 workctl.env）；默认取 profile 的 env' },
    provider: {
      type: 'enum',
      enum: ['auto', 'docker', 'kubernetes'],
      default: 'auto',
      description: 'auto：环境有 Kubernetes 资源绑定且 profile 没有 docker 端点时用 Kubernetes，否则 Docker',
    },
  },
  output: z.object({
    kind: z.literal('snapshot'),
    observed_at: z.string(),
    env: z.string(),
    host: z.object({
      name: z.string().nullable(),
      ncpu: z.number().describe('Docker 主机 CPU 数；Kubernetes 为节点 allocatable 合计（无 list nodes 权限时为 0，见 kubernetes.capacity_known）'),
      mem_total_bytes: z.number(),
      docker_version: z.string().describe('Docker 版本；Kubernetes 为节点容器运行时版本（containerRuntimeVersion）'),
      cgroup_version: z.string().nullable(),
      provider: ProviderSchema.optional(),
      kubernetes: z
        .object({ server_version: z.string().nullable(), nodes: z.number().nullable(), namespaces: z.array(z.string()), capacity_known: z.boolean() })
        .optional()
        .describe('仅 Kubernetes provider'),
    }),
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
      cpu_request_sum: z.number().optional().describe('仅 Kubernetes：requests.cpu 合计'),
      memory_request_sum_bytes: z.number().optional().describe('仅 Kubernetes：requests.memory 合计'),
    }),
    containers: z.array(CapacityItem),
  }),
  adapter: ADAPTERS,
  operation: 'read',
  auth_provider: AUTH,
  guide: GUIDE,
  prerequisites: PREREQ,
  notes: [
    '快照：上限来自 inspect，使用量来自单次 stats 采样；容量趋势需结合 metric query 的窗口数据',
    '未设置上限的容器在合计中单独计数（cpu_unlimited / memory_unlimited），不计入上限合计',
    'Docker：只统计带 workctl.env=<env> 标签的容器',
    'Kubernetes：范围是该环境 Kubernetes 资源绑定涉及的 namespace 的全部 Pod；上限/requests 来自 Pod spec，使用量来自 metrics-server（缺失时 status=partial、usage=null），host 为节点 allocatable 合计（需 list nodes 权限）',
  ],
  examples: ['workctl capacity summary --env sandbox'],
  handler: async (ctx, i): Promise<Result> => {
    const env = resolveEnv(ctx, i.env);
    if (!env) throw new WorkError('INVALID_ARGUMENT', '需要 --env 或 profile env');
    const provider = i.provider === 'auto' || !i.provider ? (kubeBindingsInEnv(ctx, env).length && !ctx.hasEndpoint('docker') ? 'kubernetes' : 'docker') : i.provider;
    if (provider === 'kubernetes') return k8sCapacitySummary(ctx, env);
    const docker = dockerClient(ctx);
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
        notes: [
          ...notes,
          '上限合计只计已设置上限的容器；使用量为单次快照',
          ...(i.provider === 'auto' && kubeBindingsInEnv(ctx, env).length ? ['该环境还有 Kubernetes 资源绑定，未计入；用 --provider kubernetes 汇总'] : []),
        ],
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
  summary: '为重启服务容器生成计划：实际目标容器（Kubernetes 为工作负载）、依赖影响、前置条件与步骤（不执行）',
  inputs: serviceInputs,
  output: PlanSchema,
  adapter: ADAPTERS,
  operation: 'plan',
  auth_provider: AUTH,
  guide: GUIDE,
  prerequisites: PREREQ,
  idempotent: true,
  cancellable: false,
  notes: [
    '计划预览不是执行成功的证据；执行用 workctl operation execute --id <plan> --confirm <plan>（需要 profile allow_execute）',
    '等价于 workctl operation plan --action container.restart --param service=<service>',
    'Docker：执行时逐个重启并轮询 inspect 校验已重新运行（及健康检查状态）；计划 idempotent=true',
    'Kubernetes：等价于 kubectl rollout restart（PATCH Pod 模板注解 kubectl.kubernetes.io/restartedAt），轮询 observedGeneration/updatedReplicas/availableReplicas 直到 rollout 完成或超时；计划 idempotent=false（每次执行都会触发新的滚动更新），需要 patch deployments 权限',
    PROVIDER_NOTE,
  ],
  examples: ['workctl container workload restart-plan --service demo-order --env sandbox'],
  handler: async (ctx, i): Promise<Result> => {
    const draft = await planRestart(ctx, { service: i.service, ...(i.env ? { env: i.env } : {}) });
    const plan = ctx.plans().create(draft, { profile: ctx.profileName, env: ctx.env, executable: true });
    const k8s = draft.params.provider === 'kubernetes';
    const providerSource = k8s
      ? await kubeClient(ctx, String(draft.params.endpoint)).source(`GET /apis/apps/v1/namespaces/${String(draft.params.namespace)}/{deployments|statefulsets} + /api/v1/namespaces/${String(draft.params.namespace)}/pods`)
      : await dockerClient(ctx).source('GET /containers/json + /containers/{id}/json');
    return {
      data: plan,
      sources: [providerSource, source('workctl', 'plan-store', { endpoint: ctx.plans().dir, relation: 'derived' })],
      coverage: { complete: true, scope: '计划生成时解析出的目标', notes: [`执行: workctl operation execute --id ${plan.id} --confirm ${plan.id}`] },
    };
  },
});

export default defineDomain({
  name: 'container',
  title: '容器与资源容量',
  summary: '容器工作负载状态、事件、资源快照、容量汇总与受控重启（Docker Engine API；按资源绑定可走 Kubernetes API）',
  pillar: 'infrastructure',
  guide: GUIDE,
  skill: 'skills/infra-operations/SKILL.md',
  capabilities: [workloadGet, eventList, statsGet, capacitySummary, restartPlan],
  planners: [restartPlanner],
  executors: { [RESTART_KIND]: restartExecutor },
  probes: {
    docker: async (ctx, name) => {
      const docker = dockerClient(ctx, name);
      const v = await docker.version();
      return { ok: true, version: `${v.Version} (API ${v.ApiVersion})`, detail: `${v.Os ?? ''}/${v.Arch ?? ''}` };
    },
    kubernetes: k8sProbe,
  },
});
