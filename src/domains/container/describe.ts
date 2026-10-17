import { z } from 'zod';
import { containerName, cpuLimit, dockerTime, shortId, type ContainerInspect } from './docker';
import { ENV_LABEL, SERVICE_LABEL } from './workload';

export const PortSchema = z.object({
  container_port: z.number(),
  protocol: z.string(),
  host_ip: z.string().nullable(),
  host_port: z.number().nullable(),
});

export const ContainerInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  service: z.string().nullable(),
  env: z.string().nullable(),
  image: z.string(),
  image_id: z.string(),
  created: z.string(),
  state: z.string().describe('Docker State.Status：running/exited/restarting/paused/created/dead'),
  health: z.string().describe('healthy/unhealthy/starting；未配置健康检查为 none'),
  health_failing_streak: z.number().nullable(),
  last_health_check: z.object({ at: z.string(), exit_code: z.number(), output: z.string() }).nullable(),
  restart_count: z.number().describe('Docker RestartCount：仅统计重启策略触发的重启，不含手动 restart'),
  restart_policy: z.string().nullable(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable().describe('最近一次退出时间；从未退出为 null'),
  exit_code: z.number(),
  oom_killed: z.boolean(),
  error: z.string().nullable(),
  ports: z.array(PortSchema),
  limits: z.object({
    cpus: z.number().nullable().describe('CPU 上限（核）；null 表示未限制'),
    memory_bytes: z.number().nullable().describe('内存上限；null 表示未限制'),
    memory_reservation_bytes: z.number().nullable(),
    pids_limit: z.number().nullable(),
  }),
  log_driver: z.string().nullable(),
  networks: z.array(z.object({ name: z.string(), ip: z.string().nullable(), aliases: z.array(z.string()) })),
  mounts: z.array(z.object({ type: z.string(), name: z.string().nullable(), source: z.string(), destination: z.string(), rw: z.boolean() })),
  labels: z.record(z.string(), z.string()),
  kubernetes: z
    .object({
      namespace: z.string().nullable(),
      pod: z.string(),
      container: z.string(),
      pod_uid: z.string().nullable(),
      node: z.string().nullable(),
      phase: z.string().nullable().describe('Pod phase：Pending/Running/Succeeded/Failed/Unknown'),
      pod_ready: z.boolean().nullable().describe('Pod 条件 Ready'),
      container_ready: z.boolean().nullable(),
      qos_class: z.string().nullable(),
      owner: z.string().nullable().describe('控制者 ownerReference，如 ReplicaSet/demo-order-7c9d8f6b5'),
      state_reason: z.string().nullable().describe('waiting/terminated 原因，如 CrashLoopBackOff、ImagePullBackOff、OOMKilled'),
      last_termination: z.object({ reason: z.string().nullable(), exit_code: z.number(), finished_at: z.string().nullable() }).nullable().describe('lastState.terminated'),
      requests: z.object({ cpus: z.number().nullable(), memory_bytes: z.number().nullable() }),
      conditions: z.array(z.object({ type: z.string(), status: z.string(), reason: z.string().nullable() })),
    })
    .optional()
    .describe('仅 Kubernetes provider：Pod 与容器的原生状态（name 为 <pod>/<container>）'),
});
export type ContainerInfo = z.infer<typeof ContainerInfoSchema>;

export function portsOf(i: ContainerInspect): z.infer<typeof PortSchema>[] {
  const out: z.infer<typeof PortSchema>[] = [];
  for (const [spec, bindings] of Object.entries(i.NetworkSettings?.Ports ?? {})) {
    const [port, proto] = spec.split('/');
    if (!bindings || !bindings.length) {
      out.push({ container_port: Number(port), protocol: proto ?? 'tcp', host_ip: null, host_port: null });
      continue;
    }
    for (const b of bindings) {
      out.push({ container_port: Number(port), protocol: proto ?? 'tcp', host_ip: b.HostIp || null, host_port: b.HostPort ? Number(b.HostPort) : null });
    }
  }
  return out.sort((a, b) => a.container_port - b.container_port || String(a.host_ip).localeCompare(String(b.host_ip)));
}

export function describeContainer(i: ContainerInspect): ContainerInfo {
  const labels = i.Config?.Labels ?? {};
  const h = i.HostConfig ?? {};
  const health = i.State?.Health;
  const lastCheck = health?.Log?.length ? health.Log[health.Log.length - 1] : undefined;
  return {
    id: shortId(i.Id),
    name: containerName(i),
    service: labels[SERVICE_LABEL] ?? null,
    env: labels[ENV_LABEL] ?? null,
    image: i.Config?.Image ?? i.Image,
    image_id: shortId(i.Image),
    created: i.Created,
    state: i.State.Status,
    health: health?.Status ?? 'none',
    health_failing_streak: health ? health.FailingStreak : null,
    last_health_check: lastCheck ? { at: lastCheck.End, exit_code: lastCheck.ExitCode, output: lastCheck.Output.trim().slice(0, 300) } : null,
    restart_count: i.RestartCount ?? 0,
    restart_policy: h.RestartPolicy?.Name || null,
    started_at: dockerTime(i.State.StartedAt),
    finished_at: dockerTime(i.State.FinishedAt),
    exit_code: i.State.ExitCode,
    oom_killed: i.State.OOMKilled,
    error: i.State.Error || null,
    ports: portsOf(i),
    limits: {
      cpus: cpuLimit(h),
      memory_bytes: h.Memory && h.Memory > 0 ? h.Memory : null,
      memory_reservation_bytes: h.MemoryReservation && h.MemoryReservation > 0 ? h.MemoryReservation : null,
      pids_limit: h.PidsLimit && h.PidsLimit > 0 ? h.PidsLimit : null,
    },
    log_driver: h.LogConfig?.Type ?? null,
    networks: Object.entries(i.NetworkSettings?.Networks ?? {}).map(([name, n]) => ({ name, ip: n.IPAddress || null, aliases: [...new Set(n.Aliases ?? [])] })),
    mounts: (i.Mounts ?? []).map((m) => ({ type: m.Type, name: m.Name ?? null, source: m.Source, destination: m.Destination, rw: m.RW })),
    labels,
  };
}
