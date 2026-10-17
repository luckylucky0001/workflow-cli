import { WorkError } from '../../core/output';
import type { Resource } from '../../core/resources';
import type { Ctx } from '../../core/runtime';
import type { ContainerInfo } from './describe';
import {
  enc,
  kubeClient,
  parseQuantity,
  selectorMatchesLabels,
  selectorString,
  type KubeClient,
  type KubeContainerSpec,
  type KubeContainerStatus,
  type KubeList,
  type KubePod,
  type KubeWorkload,
  type LabelSelectorSpec,
} from './kubernetes';
import { ENV_LABEL, RESOURCE_LABEL, SERVICE_LABEL, type Selector } from './workload';

/**
 * Service → Kubernetes workload resolution. A service uses the Kubernetes provider only when the
 * resource bindings say so: the service (or a `container.workload` it `runs_on`) has
 * `endpoint: {kind: kubernetes, name}`. Pods are then selected by a label selector — either the
 * binding's `labels`, or the `spec.selector` of the Deployment/StatefulSet named in
 * `attributes.deployment` / `attributes.statefulset`. Never by name similarity.
 */
export interface KubeBinding {
  service: string;
  resource: Resource;
  endpointName: string;
  namespace?: string;
  workload?: { kind: 'Deployment' | 'StatefulSet'; name: string; attr: string };
  labels: Record<string, string>;
  evidence: string;
  ignored: string[];
}

function bindingOf(service: string, r: Resource, via: string): KubeBinding {
  const a = r.attributes ?? {};
  const ns = typeof a.namespace === 'string' && a.namespace ? a.namespace : undefined;
  let workload: KubeBinding['workload'];
  if (typeof a.deployment === 'string' && a.deployment) workload = { kind: 'Deployment', name: a.deployment, attr: 'deployment' };
  else if (typeof a.statefulset === 'string' && a.statefulset) workload = { kind: 'StatefulSet', name: a.statefulset, attr: 'statefulset' };
  return { service, resource: r, endpointName: r.endpoint!.name, namespace: ns, workload, labels: { ...(r.labels ?? {}) }, evidence: via, ignored: [] };
}

/** Kubernetes bindings of a service (null → the Docker provider applies). */
export function kubeBindingFor(ctx: Ctx, service: string, env: string | null): KubeBinding | null {
  let store;
  try {
    store = ctx.resources();
  } catch {
    return null;
  }
  const res = store.get(service);
  if (!res) return null;
  const inEnv = (r: Resource) => !r.env || !env || r.env === env;
  const found: KubeBinding[] = [];
  if (res.endpoint?.kind === 'kubernetes' && inEnv(res)) found.push(bindingOf(service, res, `bindings: ${res.id}.endpoint=kubernetes/${res.endpoint.name}`));
  for (const rel of store.relationsOf(service, 'downstream')) {
    if (rel.type !== 'runs_on') continue;
    const w = store.get(rel.to);
    if (w?.type === 'container.workload' && w.endpoint?.kind === 'kubernetes' && inEnv(w)) {
      found.push(bindingOf(service, w, `bindings: ${service} runs_on ${w.id}（endpoint kubernetes/${w.endpoint.name}）`));
    }
  }
  if (!found.length) return null;
  const [first, ...rest] = found;
  first.ignored = rest.map((b) => b.resource.id);
  return first;
}

/** All Kubernetes-bound workloads of an env (capacity summary scope). */
export function kubeBindingsInEnv(ctx: Ctx, env: string): Resource[] {
  let store;
  try {
    store = ctx.resources();
  } catch {
    return [];
  }
  return store.resources.filter((r) => r.endpoint?.kind === 'kubernetes' && (!r.env || r.env === env));
}

export interface KubeTargets {
  binding: KubeBinding;
  client: KubeClient;
  namespace: string;
  selector: Selector;
  labelSelector: string;
  workloads: KubeWorkload[];
  pods: KubePod[];
  excluded_by_env: { name: string; env: string }[];
  missing_env_label: string[];
  notes: string[];
  warnings: string[];
  methods: string[];
}

const PLURAL = { Deployment: 'deployments', StatefulSet: 'statefulsets' } as const;

export function workloadPath(ns: string, kind: 'Deployment' | 'StatefulSet', name?: string): string {
  return `/apis/apps/v1/namespaces/${enc(ns)}/${PLURAL[kind]}${name ? `/${enc(name)}` : ''}`;
}

export async function resolveKubeTargets(ctx: Ctx, b: KubeBinding, env: string | null): Promise<KubeTargets> {
  const client = kubeClient(ctx, b.endpointName);
  const ns = b.namespace ?? client.defaultNamespace;
  const notes: string[] = [];
  const warnings: string[] = [];
  const methods: string[] = [];
  let workloads: KubeWorkload[] = [];
  let podSelector: LabelSelectorSpec;
  let matchedBy: string;
  let missing = false;
  if (b.workload) {
    const path = workloadPath(ns, b.workload.kind, b.workload.name);
    methods.push(`GET ${path}`);
    const r = await client.request<KubeWorkload>('GET', path, { allowStatus: [404] });
    if (r.status === 404) {
      missing = true;
      warnings.push(`资源绑定 ${b.resource.id} 指定的 ${b.workload.kind} ${ns}/${b.workload.name} 不存在`);
      podSelector = { matchLabels: b.labels };
    } else {
      const w = { ...r.body, kind: b.workload.kind };
      workloads = [w];
      podSelector = w.spec.selector;
      const tmpl = w.spec.template?.metadata?.labels ?? {};
      const extra = Object.entries(b.labels).filter(([k, v]) => tmpl[k] !== v);
      if (extra.length) warnings.push(`绑定 ${b.resource.id} 的 labels ${extra.map(([k, v]) => `${k}=${v}`).join(',')} 与 ${b.workload.kind} ${w.metadata.name} 的 Pod 模板标签不一致；以 spec.selector 为准`);
    }
    matchedBy = `label selector ${selectorString(podSelector) || '(空)'}（${b.workload.kind} ${ns}/${b.workload.name} 的 spec.selector，binding ${b.resource.id}.attributes.${b.workload.attr}）`;
  } else if (Object.keys(b.labels).length) {
    podSelector = { matchLabels: b.labels };
    matchedBy = `label selector ${selectorString(podSelector)}（binding ${b.resource.id}.labels，namespace ${ns}）`;
    // owning workloads: those whose pod template satisfies the selector (spec metadata, not names)
    for (const kind of ['Deployment', 'StatefulSet'] as const) {
      const path = workloadPath(ns, kind);
      const r = await client.request<KubeList<KubeWorkload>>('GET', path, { allowStatus: kind === 'StatefulSet' ? [403, 404] : [] });
      if (r.status !== 200) {
        notes.push(`未能列出 StatefulSet（HTTP ${r.status}），只按 Deployment 关联工作负载`);
        continue;
      }
      methods.push(`GET ${path}`);
      for (const w of r.body.items ?? []) if (selectorMatchesLabels(podSelector, w.spec.template?.metadata?.labels)) workloads.push({ ...w, kind });
    }
  } else {
    throw new WorkError('NOT_CONFIGURED', `资源绑定 ${b.resource.id}（kubernetes）没有 labels，也没有 attributes.deployment / attributes.statefulset，无法选择 Pod`, {
      hint: '在绑定中写 labels（Pod 标签选择器）或 attributes.deployment',
    });
  }
  const labelSelector = selectorString(podSelector);
  if (!labelSelector && !missing) throw new WorkError('PRECONDITION_FAILED', `工作负载选择器为空，拒绝匹配 namespace ${ns} 的全部 Pod`);
  let pods: KubePod[] = [];
  const podsPath = `/api/v1/namespaces/${enc(ns)}/pods?labelSelector=${enc(labelSelector)}`;
  if (!missing) {
    methods.push(`GET /api/v1/namespaces/${ns}/pods?labelSelector=${labelSelector}`);
    pods = (await client.get<KubeList<KubePod>>(podsPath)).items ?? [];
  }
  const kept: KubePod[] = [];
  const excluded: { name: string; env: string }[] = [];
  const missingEnv: string[] = [];
  for (const p of pods) {
    const pEnv = p.metadata.labels?.[ENV_LABEL];
    if (env && pEnv && pEnv !== env) {
      excluded.push({ name: p.metadata.name, env: pEnv });
      continue;
    }
    if (env && !pEnv) missingEnv.push(p.metadata.name);
    kept.push(p);
  }
  kept.sort((a, c) => a.metadata.name.localeCompare(c.metadata.name));
  const selector: Selector = { kind: 'label', label: labelSelector, origin: 'binding-file', evidence: b.evidence, matched_by: matchedBy };
  notes.unshift(`Pod 选择器: ${matchedBy}（${b.evidence}）；不按名称相似度匹配`);
  if (b.ignored.length) warnings.push(`服务 ${b.service} 还绑定了其他 Kubernetes 工作负载 ${b.ignored.join(', ')}，本次只查询 ${b.resource.id}`);
  if (excluded.length) notes.push(`因 ${ENV_LABEL} 不同被排除: ${excluded.map((e) => `${e.name}(${e.env})`).join(', ')}`);
  if (missingEnv.length) notes.push(`环境以 namespace ${ns} 区分；Pod 缺少 ${ENV_LABEL} 标签（保留）: ${missingEnv.length} 个`);
  return { binding: b, client, namespace: ns, selector, labelSelector, workloads, pods: kept, excluded_by_env: excluded, missing_env_label: missingEnv, notes, warnings, methods };
}

// ---------------------------------------------------------------------------
// pod/container → ContainerInfo (same contract as Docker, k8s specifics in `kubernetes`)
// ---------------------------------------------------------------------------
export function shortRuntimeId(id: string | undefined): string {
  if (!id) return '';
  return id.replace(/^[a-z0-9-]+:\/\//, '').replace(/^sha256:/, '').slice(0, 12);
}

function imageDigest(imageID: string | undefined): string {
  if (!imageID) return '';
  const at = imageID.lastIndexOf('@');
  return shortRuntimeId(at >= 0 ? imageID.slice(at + 1) : imageID);
}

/** Docker-compatible state: running / exited / restarting (CrashLoopBackOff) / waiting (other waiting reasons). */
export function containerState(s: KubeContainerStatus | undefined, pod: KubePod): string {
  if (!s?.state) return pod.status.phase === 'Pending' ? 'waiting' : 'unknown';
  if (s.state.running) return 'running';
  if (s.state.terminated) return 'exited';
  if (s.state.waiting?.reason === 'CrashLoopBackOff') return 'restarting';
  return 'waiting';
}

export function containerHealth(spec: KubeContainerSpec, s: KubeContainerStatus | undefined): string {
  if (!spec.readinessProbe && !spec.livenessProbe && !spec.startupProbe) return 'none';
  if (!s?.state?.running) return 'unhealthy';
  if (s.ready) return 'healthy';
  if (s.started === false) return 'starting';
  return spec.readinessProbe ? 'unhealthy' : 'healthy';
}

export function limitsOf(spec: KubeContainerSpec) {
  const l = spec.resources?.limits ?? {};
  const r = spec.resources?.requests ?? {};
  return {
    limits: { cpus: parseQuantity(l.cpu), memory_bytes: parseQuantity(l.memory) },
    requests: { cpus: parseQuantity(r.cpu), memory_bytes: parseQuantity(r.memory) },
  };
}

function volumeSource(v: Record<string, unknown> | undefined): { type: string; source: string } {
  if (!v) return { type: 'unknown', source: '' };
  for (const [k, val] of Object.entries(v)) {
    if (k === 'name') continue;
    const o = (val ?? {}) as Record<string, unknown>;
    const src = o.claimName ?? o.name ?? o.path ?? o.secretName ?? '';
    return { type: k, source: String(src) };
  }
  return { type: 'unknown', source: '' };
}

export type KubeContainerInfo = ContainerInfo & { kubernetes: NonNullable<ContainerInfo['kubernetes']> };

export function describeKubeContainer(pod: KubePod, spec: KubeContainerSpec): KubeContainerInfo {
  const s = pod.status.containerStatuses?.find((x) => x.name === spec.name);
  const labels = pod.metadata.labels ?? {};
  const term = s?.state?.terminated ?? s?.lastState?.terminated;
  const { limits, requests } = limitsOf(spec);
  const ready = pod.status.conditions?.find((c) => c.type === 'Ready');
  const owner = pod.metadata.ownerReferences?.find((o) => o.controller) ?? pod.metadata.ownerReferences?.[0];
  return {
    id: shortRuntimeId(s?.containerID) || shortRuntimeId(pod.metadata.uid?.replace(/-/g, '')),
    name: `${pod.metadata.name}/${spec.name}`,
    service: labels[SERVICE_LABEL] ?? null,
    env: labels[ENV_LABEL] ?? null,
    image: spec.image,
    image_id: imageDigest(s?.imageID),
    created: pod.metadata.creationTimestamp ?? '',
    state: containerState(s, pod),
    health: containerHealth(spec, s),
    health_failing_streak: null,
    last_health_check: null,
    restart_count: s?.restartCount ?? 0,
    restart_policy: pod.spec.restartPolicy ?? null,
    started_at: s?.state?.running?.startedAt ?? s?.state?.terminated?.startedAt ?? null,
    finished_at: s?.state?.terminated?.finishedAt ?? s?.lastState?.terminated?.finishedAt ?? null,
    exit_code: term?.exitCode ?? 0,
    oom_killed: term?.reason === 'OOMKilled',
    error: s?.state?.waiting?.message ?? s?.state?.terminated?.message ?? null,
    ports: (spec.ports ?? [])
      .map((p) => ({ container_port: p.containerPort, protocol: (p.protocol ?? 'TCP').toLowerCase(), host_ip: p.hostIP ?? null, host_port: p.hostPort ?? null }))
      .sort((a, b) => a.container_port - b.container_port),
    limits: { cpus: limits.cpus, memory_bytes: limits.memory_bytes, memory_reservation_bytes: null, pids_limit: null },
    log_driver: null,
    networks: [{ name: 'pod', ip: pod.status.podIP ?? null, aliases: [] }],
    mounts: (spec.volumeMounts ?? []).map((m) => {
      const v = volumeSource(pod.spec.volumes?.find((x) => x.name === m.name));
      return { type: v.type, name: m.name, source: v.source, destination: m.mountPath, rw: !m.readOnly };
    }),
    labels,
    kubernetes: {
      namespace: pod.metadata.namespace ?? null,
      pod: pod.metadata.name,
      container: spec.name,
      pod_uid: pod.metadata.uid ?? null,
      node: pod.spec.nodeName ?? null,
      phase: pod.status.phase ?? null,
      pod_ready: ready ? ready.status === 'True' : null,
      container_ready: s?.ready ?? null,
      qos_class: pod.status.qosClass ?? null,
      owner: owner ? `${owner.kind}/${owner.name}` : null,
      state_reason: s?.state?.waiting?.reason ?? s?.state?.terminated?.reason ?? null,
      last_termination: s?.lastState?.terminated
        ? { reason: s.lastState.terminated.reason ?? null, exit_code: s.lastState.terminated.exitCode, finished_at: s.lastState.terminated.finishedAt ?? null }
        : null,
      requests,
      conditions: (pod.status.conditions ?? []).map((c) => ({ type: c.type, status: c.status, reason: c.reason ?? null })),
    },
  };
}

export function podContainers(pods: KubePod[]): { pod: KubePod; spec: KubeContainerSpec }[] {
  return pods.flatMap((pod) => pod.spec.containers.map((spec) => ({ pod, spec })));
}

export function ownerLabel(labels: Record<string, string> | undefined): string | null {
  const l = labels ?? {};
  if (l[SERVICE_LABEL]) return `${SERVICE_LABEL}=${l[SERVICE_LABEL]}`;
  if (l[RESOURCE_LABEL]) return `${RESOURCE_LABEL}=${l[RESOURCE_LABEL]}`;
  return null;
}

export function workloadSummary(w: KubeWorkload) {
  const progressing = w.status?.conditions?.find((c) => c.type === 'Progressing');
  return {
    kind: w.kind ?? 'Deployment',
    name: w.metadata.name,
    namespace: w.metadata.namespace ?? null,
    uid: w.metadata.uid ?? null,
    generation: w.metadata.generation ?? null,
    observed_generation: w.status?.observedGeneration ?? null,
    replicas: w.spec.replicas ?? 1,
    ready_replicas: w.status?.readyReplicas ?? 0,
    updated_replicas: w.status?.updatedReplicas ?? 0,
    available_replicas: w.status?.availableReplicas ?? 0,
    selector: selectorString(w.spec.selector),
    progressing: progressing ? { status: progressing.status, reason: progressing.reason ?? null } : null,
    restarted_at: w.spec.template?.metadata?.annotations?.['kubectl.kubernetes.io/restartedAt'] ?? null,
  };
}

/** Go duration string as used by metrics-server (`15.015s`, `1m0s`, `500ms`) → ms. */
export function parseGoDuration(d: string | undefined): number | null {
  if (!d) return null;
  const re = /(\d+(?:\.\d+)?)(h|ms|m|s|us|µs|ns)/g;
  let total = 0;
  let matched = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) {
    matched += m[0];
    total += Number(m[1]) * { h: 3_600_000, m: 60_000, s: 1000, ms: 1, us: 1e-3, µs: 1e-3, ns: 1e-6 }[m[2] as 'h']!;
  }
  return matched === d ? Math.round(total) : null;
}
