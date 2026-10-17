import { safeUrl } from '../../core/http';
import { source, WorkError, type Result, type Source } from '../../core/output';
import { formatDuration, windowFromNow, type Ctx } from '../../core/runtime';
import { capacityFlags } from './flags';
import {
  describeKubeContainer,
  kubeBindingsInEnv,
  limitsOf,
  ownerLabel,
  parseGoDuration,
  podContainers,
  resolveKubeTargets,
  shortRuntimeId,
  workloadSummary,
  type KubeBinding,
  type KubeTargets,
} from './k8s-workload';
import { enc, kubeClient, parseQuantity, type KubeClient, type KubeEvent, type KubeList, type KubeNode, type KubePod, type PodMetrics } from './kubernetes';
import { round } from './stats';
import { ENV_LABEL } from './workload';

const METRICS_API = '/apis/metrics.k8s.io/v1beta1';

function bindingSource(t: KubeTargets): Source {
  return source('workctl', 'resource-bindings', { method: t.binding.evidence, relation: 'explicit' });
}

async function sourcesFor(t: KubeTargets, extra: { method: string; relation?: Source['relation'] }[] = []): Promise<Source[]> {
  const out: Source[] = [];
  for (const m of t.methods) out.push(await t.client.source(m));
  for (const e of extra) out.push(await t.client.source(e.method, e.relation));
  out.push(bindingSource(t));
  return out;
}

// ---------------------------------------------------------------------------
// workload get
// ---------------------------------------------------------------------------
export async function k8sWorkloadGet(ctx: Ctx, b: KubeBinding, service: string, env: string | null): Promise<Result> {
  const t = await resolveKubeTargets(ctx, b, env);
  const containers = podContainers(t.pods).map(({ pod, spec }) => describeKubeContainer(pod, spec));
  const warnings = [...t.warnings];
  if (!containers.length && !warnings.length) warnings.push(`namespace ${t.namespace} 中没有 Pod 匹配 ${t.labelSelector}`);
  const version = await t.client.version().catch(() => undefined);
  return {
    data: {
      service,
      env,
      selector: t.selector,
      provider: 'kubernetes',
      containers,
      summary: {
        total: containers.length,
        running: containers.filter((c) => c.state === 'running').length,
        unhealthy: containers.filter((c) => c.health === 'unhealthy').length,
        oom_killed: containers.filter((c) => c.oom_killed).length,
        restarted: containers.filter((c) => c.restart_count > 0).length,
      },
      kubernetes: {
        endpoint: t.client.endpointId,
        namespace: t.namespace,
        server_version: version?.gitVersion ?? null,
        label_selector: t.labelSelector,
        workloads: t.workloads.map(workloadSummary),
        pods: t.pods.map((p) => ({
          name: p.metadata.name,
          phase: p.status.phase ?? null,
          ready: (p.status.conditions ?? []).find((c) => c.type === 'Ready')?.status === 'True',
          node: p.spec.nodeName ?? null,
          pod_ip: p.status.podIP ?? null,
          start_time: p.status.startTime ?? null,
          restarts: (p.status.containerStatuses ?? []).reduce((a, s) => a + (s.restartCount ?? 0), 0),
        })),
      },
    },
    sources: await sourcesFor(t),
    coverage: {
      complete: true,
      scope: `Kubernetes ${t.client.endpointId} namespace ${t.namespace} 中匹配 ${t.labelSelector} 的 Pod（每个容器一条）`,
      notes: [
        ...t.notes,
        'restart_count 为 kubelet 统计的容器重启次数（含存活探针失败、OOM），与 Docker RestartCount 口径不同；Pod 被替换后计数归零',
        'state 映射：running / exited（terminated）/ restarting（CrashLoopBackOff）/ waiting（其他等待原因，见 kubernetes.state_reason）',
        'health 来自容器 ready 与探针配置：未配置任何探针为 none',
      ],
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// event list
// ---------------------------------------------------------------------------
export function eventTime(e: KubeEvent): string | null {
  return e.lastTimestamp ?? e.series?.lastObservedTime ?? e.eventTime ?? e.firstTimestamp ?? e.metadata.creationTimestamp ?? null;
}

export async function k8sEventList(ctx: Ctx, b: KubeBinding, service: string, env: string | null, windowMs: number): Promise<Result> {
  const t = await resolveKubeTargets(ctx, b, env);
  const now = new Date();
  const win = windowFromNow(windowMs, now);
  const ttl = t.client.eventTtlMs;
  const ttlStart = now.getTime() - ttl;
  const beyondTtl = Date.parse(win.start) < ttlStart;
  const visibleSince = new Date(Math.max(Date.parse(win.start), ttlStart)).toISOString();
  // objects the service owns: matched pods, their controlling ReplicaSets (ownerReferences), the workloads
  const uids = new Set<string>();
  const names = new Set<string>();
  const add = (kind: string, name: string, uid?: string) => {
    if (uid) uids.add(uid);
    names.add(`${kind}/${name}`);
  };
  for (const p of t.pods) {
    add('Pod', p.metadata.name, p.metadata.uid);
    for (const o of p.metadata.ownerReferences ?? []) add(o.kind, o.name, o.uid);
  }
  for (const w of t.workloads) add(w.kind ?? 'Deployment', w.metadata.name, w.metadata.uid);
  const path = `/api/v1/namespaces/${enc(t.namespace)}/events`;
  const list = await t.client.get<KubeList<KubeEvent>>(path);
  const events = [];
  let outside = 0;
  for (const e of list.items ?? []) {
    const io = e.involvedObject;
    const mine = io.uid ? uids.has(io.uid) : names.has(`${io.kind}/${io.name}`);
    if (!mine) continue;
    const at = eventTime(e);
    if (!at || Date.parse(at) < Date.parse(win.start) || Date.parse(at) > now.getTime()) {
      outside++;
      continue;
    }
    const attrs: Record<string, string> = { namespace: io.namespace ?? t.namespace, kind: io.kind, event_type: e.type ?? 'Normal' };
    if (e.message) attrs.message = e.message.slice(0, 500);
    const count = e.series?.count ?? e.count;
    if (count !== undefined) attrs.count = String(count);
    if (e.firstTimestamp) attrs.first_timestamp = e.firstTimestamp;
    if (io.fieldPath) attrs.field_path = io.fieldPath;
    const comp = e.reportingComponent || e.source?.component;
    if (comp) attrs.reporting_component = comp;
    const host = e.reportingInstance || e.source?.host;
    if (host) attrs.reporting_instance = host;
    events.push({
      time: new Date(Date.parse(at)).toISOString(),
      type: io.kind.toLowerCase(),
      action: e.reason ?? 'Unknown',
      container_id: shortRuntimeId(io.uid?.replace(/-/g, '')),
      container_name: io.name,
      image: null,
      exit_code: null,
      signal: null,
      attributes: attrs,
    });
  }
  events.sort((a, c) => a.time.localeCompare(c.time));
  const counts: Record<string, number> = {};
  for (const e of events) counts[e.action] = (counts[e.action] ?? 0) + 1;
  const ttlText = formatDuration(ttl);
  const notes = [
    ...t.notes,
    `Kubernetes 事件只保留 event-ttl（kube-apiserver --event-ttl，默认 1h；本端点按 ${ttlText} 计算）；更早的事件已被删除，不代表“没有事件”`,
    '同类事件会被聚合：count 为自 first_timestamp 起的累计次数，时间取最近一次（lastTimestamp / series.lastObservedTime）',
    '只包含当前匹配的 Pod、其 ReplicaSet/StatefulSet 和工作负载的事件；已被替换/删除的旧 Pod 的事件不按名称推断归属，未包含',
    '--include-exec 对 Kubernetes 不适用（没有 exec 事件）',
  ];
  if (outside) notes.push(`${outside} 条相关事件的时间不在窗口内，已排除`);
  if (beyondTtl) notes.push(`窗口 ${formatDuration(windowMs)} 超过事件保留时间 ${ttlText}，只有 ${visibleSince} 之后的部分可见`);
  return {
    data: {
      service,
      env,
      selector: t.selector,
      window: win,
      visible_since: visibleSince,
      daemon_buffer_full: false,
      events,
      counts_by_action: counts,
      provider: 'kubernetes',
      retention: { kind: 'kubernetes-event-ttl', ttl: ttlText, configured: ttl !== 3_600_000 },
    },
    sources: await sourcesFor(t, [{ method: `GET ${path}（本地按 involvedObject uid 过滤）` }]),
    coverage: {
      complete: !beyondTtl,
      window: win,
      ...(beyondTtl ? { truncated: true } : {}),
      scope: beyondTtl ? `窗口 ${formatDuration(windowMs)} 中仅 ${visibleSince} 之后的部分可见（event-ttl ${ttlText}）` : `API server 保留的事件（窗口 ${formatDuration(windowMs)}，event-ttl ${ttlText}）`,
      notes,
    },
    warnings: t.warnings,
  };
}

// ---------------------------------------------------------------------------
// metrics helpers
// ---------------------------------------------------------------------------
async function podMetrics(client: KubeClient, ns: string, labelSelector?: string): Promise<{ items: PodMetrics[]; method: string }> {
  const q = labelSelector ? `?labelSelector=${enc(labelSelector)}` : '';
  const path = `${METRICS_API}/namespaces/${enc(ns)}/pods${q}`;
  const method = `GET ${METRICS_API}/namespaces/${ns}/pods${labelSelector ? `?labelSelector=${labelSelector}` : ''}`;
  const r = await client.request<KubeList<PodMetrics>>('GET', path, { allowStatus: [404] });
  if (r.status === 404) {
    throw new WorkError('COLLECTION_DISABLED', `集群没有 metrics.k8s.io API（未安装或未注册 metrics-server），无法取得 Pod 资源使用`, {
      hint: '安装 metrics-server（k3s 默认自带）；确认 kubectl get apiservice v1beta1.metrics.k8s.io 为 Available。窗口趋势请用 metric query（Prometheus）',
      details: { api: 'metrics.k8s.io/v1beta1', endpoint: client.endpointId },
    });
  }
  return { items: r.body.items ?? [], method };
}

async function nodeInfo(client: KubeClient, names: string[], notes: string[]): Promise<Map<string, KubeNode>> {
  const out = new Map<string, KubeNode>();
  for (const n of [...new Set(names)]) {
    const r = await client.request<KubeNode>('GET', `/api/v1/nodes/${enc(n)}`, { allowStatus: [403, 404] });
    if (r.status === 200) out.set(n, r.body);
    else {
      notes.push(`无法读取节点 ${n}（HTTP ${r.status}${r.status === 403 ? '，需要集群级 get nodes 权限' : ''}）：online_cpus=0 表示未取得节点 CPU 数，未设上限容器的内存上限未知`);
      break;
    }
  }
  return out;
}

function containerUsage(m: PodMetrics | undefined, container: string) {
  const c = m?.containers.find((x) => x.name === container);
  if (!c) return null;
  return { cpu: parseQuantity(c.usage.cpu), memory: parseQuantity(c.usage.memory) };
}

// ---------------------------------------------------------------------------
// stats get (snapshot from metrics-server)
// ---------------------------------------------------------------------------
export async function k8sStatsGet(ctx: Ctx, b: KubeBinding, service: string, env: string | null): Promise<Result> {
  const t = await resolveKubeTargets(ctx, b, env);
  const notes = [...t.notes];
  const extra: { method: string; relation?: Source['relation'] }[] = [];
  let metrics: PodMetrics[] = [];
  if (t.pods.length) {
    const m = await podMetrics(t.client, t.namespace, t.labelSelector);
    metrics = m.items;
    extra.push({ method: m.method, relation: 'sampled' });
  }
  const nodes = t.pods.length ? await nodeInfo(t.client, t.pods.map((p) => p.spec.nodeName ?? '').filter(Boolean), notes) : new Map();
  if (nodes.size) extra.push({ method: 'GET /api/v1/nodes/{name}' });
  let missingSamples = 0;
  const containers = podContainers(t.pods).map(({ pod, spec }) => {
    const info = describeKubeContainer(pod, spec);
    const lim = limitsOf(spec).limits;
    const base = { id: info.id, name: info.name, state: info.state, limits: lim };
    if (info.state !== 'running') return { ...base, stats: null, note: '容器未运行，没有资源使用数据' };
    const pm = metrics.find((x) => x.metadata.name === pod.metadata.name);
    const u = containerUsage(pm, spec.name);
    if (!pm || !u) {
      missingSamples++;
      return { ...base, stats: null, note: 'metrics-server 尚无该容器的样本（Pod 刚启动或抓取失败）' };
    }
    const node = nodes.get(pod.spec.nodeName ?? '');
    const nodeCpu = parseQuantity(node?.status.capacity?.cpu) ?? 0;
    const nodeMem = parseQuantity(node?.status.capacity?.memory);
    const windowMs = parseGoDuration(pm.window);
    const readAt = pm.timestamp;
    const cores = u.cpu ?? 0;
    const memLimit = lim.memory_bytes ?? nodeMem;
    const cnotes = ['memory 为 metrics-server 的工作集（working set），没有 usage 含页缓存的口径；pids、网络与块 I/O 不由 metrics.k8s.io 提供'];
    if (!lim.memory_bytes) cnotes.push(nodeMem ? '容器未设置内存上限，limit 为节点内存容量' : '容器未设置内存上限，节点内存容量未知');
    return {
      ...base,
      stats: {
        read_at: readAt,
        preread_at: windowMs !== null ? new Date(Date.parse(readAt) - windowMs).toISOString() : null,
        sample_interval_ms: windowMs,
        cpu: u.cpu === null ? null : { cores_used: round(cores, 4), percent: round(cores * 100, 2), online_cpus: nodeCpu, percent_of_limit: lim.cpus ? round((cores / lim.cpus) * 100, 2) : null },
        memory:
          u.memory === null
            ? null
            : { usage_bytes: u.memory, working_set_bytes: u.memory, limit_bytes: memLimit ?? null, limit_source: lim.memory_bytes ? ('container' as const) : ('host' as const), percent_of_limit: memLimit ? round((u.memory / memLimit) * 100, 2) : null },
        pids: null,
        network: null,
        block_io: null,
        notes: cnotes,
      },
      note: null,
    };
  });
  const warnings = [...t.warnings];
  if (!containers.length && !warnings.length) warnings.push(`namespace ${t.namespace} 中没有 Pod 匹配 ${t.labelSelector}`);
  return {
    status: missingSamples ? 'partial' : 'success',
    data: { kind: 'snapshot', observed_at: new Date().toISOString(), service, env, matched_by: t.selector.matched_by, containers, provider: 'kubernetes' },
    sources: await sourcesFor(t, extra),
    coverage: {
      complete: missingSamples === 0,
      scope: 'snapshot：metrics-server 最近一次采样，不代表时间窗口',
      notes: [...notes, 'CPU 为 metrics-server 在 sample_interval_ms（metrics window）内的平均速率；内存为工作集', ...(missingSamples ? [`${missingSamples} 个运行中的容器没有 metrics 样本`] : [])],
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// capacity summary (requests/limits vs metrics)
// ---------------------------------------------------------------------------
export async function k8sCapacitySummary(ctx: Ctx, env: string): Promise<Result> {
  const bound = kubeBindingsInEnv(ctx, env);
  const endpointNames = [...new Set(bound.map((r) => r.endpoint!.name))];
  const client = kubeClient(ctx, endpointNames[0]);
  const notes: string[] = [];
  if (endpointNames.length > 1) notes.push(`环境 ${env} 的绑定涉及多个 Kubernetes 端点，本次只汇总 ${endpointNames[0]}（其余: ${endpointNames.slice(1).join(', ')}）`);
  const nss = [
    ...new Set(
      bound
        .filter((r) => r.endpoint!.name === endpointNames[0])
        .map((r) => (typeof r.attributes?.namespace === 'string' && r.attributes.namespace ? r.attributes.namespace : client.defaultNamespace)),
    ),
  ];
  if (!nss.length) nss.push(client.defaultNamespace);
  notes.push(`范围: namespace ${nss.join(', ')} 的全部 Pod（来自环境 ${env} 的 Kubernetes 资源绑定${bound.length ? '' : '；无绑定，使用端点 namespace'}）`);
  const sources: Source[] = [await client.source('GET /version')];
  let pods: KubePod[] = [];
  for (const ns of nss) {
    pods = pods.concat((await client.get<KubeList<KubePod>>(`/api/v1/namespaces/${enc(ns)}/pods`)).items ?? []);
    sources.push(await client.source(`GET /api/v1/namespaces/${ns}/pods`));
  }
  const excluded = pods.filter((p) => p.metadata.labels?.[ENV_LABEL] && p.metadata.labels[ENV_LABEL] !== env);
  if (excluded.length) notes.push(`因 ${ENV_LABEL} 标签不是 ${env} 被排除: ${excluded.map((p) => p.metadata.name).join(', ')}`);
  pods = pods.filter((p) => !excluded.includes(p));
  let metrics: PodMetrics[] | null = [];
  for (const ns of nss) {
    try {
      const m = await podMetrics(client, ns);
      metrics = metrics ? metrics.concat(m.items) : null;
      sources.push(await client.source(m.method, 'sampled'));
    } catch (e) {
      if (e instanceof WorkError && e.code === 'COLLECTION_DISABLED') {
        metrics = null;
        notes.push('集群没有 metrics.k8s.io（metrics-server）：只汇总 requests/limits，usage 为 null（COLLECTION_DISABLED），不是 0');
        break;
      }
      throw e;
    }
  }
  const nodesR = await client.request<KubeList<KubeNode>>('GET', '/api/v1/nodes', { allowStatus: [403] });
  const nodes = nodesR.status === 200 ? nodesR.body.items ?? [] : null;
  if (nodes) sources.push(await client.source('GET /api/v1/nodes'));
  else notes.push('无权 list nodes（集群级权限）：host.ncpu / mem_total_bytes 为 0 表示未取得，不是 0 容量；比值无意义');
  const items = podContainers(pods).map(({ pod, spec }) => {
    const info = describeKubeContainer(pod, spec);
    const { limits, requests } = limitsOf(spec);
    let usage = null;
    if (info.state === 'running' && metrics) {
      const u = containerUsage(metrics.find((m) => m.metadata.name === pod.metadata.name && m.metadata.namespace === pod.metadata.namespace) ?? metrics.find((m) => m.metadata.name === pod.metadata.name), spec.name);
      if (u) {
        usage = {
          cpu_cores: u.cpu === null ? null : round(u.cpu, 4),
          cpu_percent_of_limit: u.cpu !== null && limits.cpus ? round((u.cpu / limits.cpus) * 100, 2) : null,
          memory_working_set_bytes: u.memory,
          memory_percent_of_limit: u.memory !== null && limits.memory_bytes ? round((u.memory / limits.memory_bytes) * 100, 2) : null,
          pids: null,
        };
      }
    }
    const item = {
      name: info.name,
      id: info.id,
      owner_label: ownerLabel(pod.metadata.labels),
      state: info.state,
      limits,
      usage,
      oom_killed: info.oom_killed,
      restart_count: info.restart_count,
      flags: [] as string[],
      namespace: pod.metadata.namespace ?? null,
      node: pod.spec.nodeName ?? null,
      owner: info.kubernetes.owner,
      requests,
    };
    item.flags = capacityFlags(item);
    if (requests.cpus === null) item.flags.push('no_cpu_request');
    if (requests.memory_bytes === null) item.flags.push('no_memory_request');
    return item;
  });
  items.sort((a, c) => a.name.localeCompare(c.name));
  const sum = (xs: (number | null | undefined)[]) => xs.reduce<number>((a, c) => a + (c ?? 0), 0);
  const ncpu = nodes ? sum(nodes.map((n) => parseQuantity(n.status.allocatable?.cpu ?? n.status.capacity?.cpu))) : 0;
  const mem = nodes ? sum(nodes.map((n) => parseQuantity(n.status.allocatable?.memory ?? n.status.capacity?.memory))) : 0;
  const runtimes = nodes ? [...new Set(nodes.map((n) => n.status.nodeInfo?.containerRuntimeVersion).filter(Boolean))] : [];
  const cpuLimitSum = round(sum(items.map((x) => x.limits.cpus)), 3);
  const memLimitSum = sum(items.map((x) => x.limits.memory_bytes));
  const runningNoSample = metrics ? items.filter((x) => x.state === 'running' && !x.usage).length : 0;
  if (runningNoSample) notes.push(`${runningNoSample} 个运行中的容器没有 metrics 样本`);
  const version = await client.version().catch(() => undefined);
  const complete = !!metrics && !!nodes && runningNoSample === 0 && endpointNames.length <= 1;
  notes.push('Kubernetes 的 host 为集群节点 allocatable 合计；requests/limits 来自 Pod spec，使用量来自 metrics-server 快照');
  return {
    status: complete ? 'success' : 'partial',
    data: {
      kind: 'snapshot',
      observed_at: new Date().toISOString(),
      env,
      host: {
        name: `kubernetes ${safeUrl(client.server)}`,
        ncpu: round(ncpu, 3),
        mem_total_bytes: mem,
        docker_version: runtimes.length ? runtimes.join(', ') : 'unknown',
        cgroup_version: null,
        provider: 'kubernetes',
        kubernetes: { server_version: version?.gitVersion ?? null, nodes: nodes ? nodes.length : null, namespaces: nss, capacity_known: !!nodes },
      },
      totals: {
        containers: items.length,
        running: items.filter((x) => x.state === 'running').length,
        cpu_limit_sum: cpuLimitSum,
        cpu_unlimited: items.filter((x) => x.limits.cpus === null).length,
        memory_limit_sum_bytes: memLimitSum,
        memory_unlimited: items.filter((x) => x.limits.memory_bytes === null).length,
        cpu_used_cores: round(sum(items.map((x) => x.usage?.cpu_cores)), 4),
        memory_working_set_bytes: sum(items.map((x) => x.usage?.memory_working_set_bytes)),
        cpu_limit_to_host_ratio: ncpu ? round(cpuLimitSum / ncpu, 3) : 0,
        memory_limit_to_host_ratio: mem ? round(memLimitSum / mem, 3) : 0,
        cpu_request_sum: round(sum(items.map((x) => x.requests.cpus)), 3),
        memory_request_sum_bytes: sum(items.map((x) => x.requests.memory_bytes)),
      },
      containers: items,
    },
    sources,
    coverage: { complete, scope: `snapshot：Kubernetes ${client.endpointId} namespace ${nss.join(', ')}`, notes },
    warnings: items.length ? [] : [`namespace ${nss.join(', ')} 中没有 Pod`],
  };
}

// ---------------------------------------------------------------------------
// probe (auth status --probe / access check)
// ---------------------------------------------------------------------------
interface SelfSubjectReview {
  status?: { userInfo?: { username?: string; groups?: string[] } };
}
interface RulesReview {
  status?: { resourceRules?: { verbs: string[]; apiGroups?: string[]; resources?: string[] }[]; incomplete?: boolean; evaluationError?: string };
}

const RELEVANT = ['pods', 'deployments', 'statefulsets', 'events', 'nodes', '*'];

export async function k8sProbe(ctx: Ctx, name: string) {
  const client = kubeClient(ctx, name);
  const v = await client.version();
  const details: string[] = [`auth=${client.authMode}`, `namespace=${client.defaultNamespace}`];
  let identity: string | undefined;
  const ssr = await client.request<SelfSubjectReview>('POST', '/apis/authentication.k8s.io/v1/selfsubjectreviews', {
    body: { apiVersion: 'authentication.k8s.io/v1', kind: 'SelfSubjectReview' },
    allowStatus: [403, 404],
  });
  if (ssr.status < 300) {
    const u = ssr.body.status?.userInfo;
    identity = u?.username ? `${u.username}${u.groups?.length ? ` (groups: ${u.groups.join(',')})` : ''}` : undefined;
  } else details.push(`SelfSubjectReview 不可用（HTTP ${ssr.status}），身份未确认`);
  let privileges: string[] | undefined;
  const rr = await client.request<RulesReview>('POST', '/apis/authorization.k8s.io/v1/selfsubjectrulesreviews', {
    body: { apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectRulesReview', spec: { namespace: client.defaultNamespace } },
    allowStatus: [403, 404],
  });
  if (rr.status < 300) {
    privileges = (rr.body.status?.resourceRules ?? [])
      .filter((r) => (r.resources ?? []).some((x) => RELEVANT.some((k) => x === k || x.startsWith(`${k}/`))) || (r.apiGroups ?? []).includes('metrics.k8s.io'))
      .map((r) => `${r.verbs.join(',')} ${(r.resources ?? []).join(',')}${r.apiGroups?.length && !(r.apiGroups.length === 1 && r.apiGroups[0] === '') ? ` [${r.apiGroups.join(',')}]` : ''}`);
    if (rr.body.status?.incomplete) details.push('SelfSubjectRulesReview 结果不完整（授权模块不支持枚举）');
  } else details.push(`SelfSubjectRulesReview 不可用（HTTP ${rr.status}）`);
  return { ok: true, identity, version: v.gitVersion, detail: details.join('；'), ...(privileges ? { privileges } : {}) };
}

