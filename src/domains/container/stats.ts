/**
 * Pure parsers for Docker `/containers/{id}/stats?stream=false` responses.
 * The CPU figure is a rate between two daemon samples (precpu → cpu); memory,
 * pids are point-in-time; network / block I/O are cumulative since container start.
 */
export interface DockerStats {
  read?: string;
  preread?: string;
  pids_stats?: { current?: number; limit?: number };
  cpu_stats?: CpuStats;
  precpu_stats?: CpuStats;
  memory_stats?: { usage?: number; limit?: number; stats?: Record<string, number> };
  networks?: Record<string, { rx_bytes: number; tx_bytes: number; rx_errors?: number; tx_errors?: number; rx_dropped?: number; tx_dropped?: number }>;
  blkio_stats?: { io_service_bytes_recursive?: { op: string; value: number }[] | null };
}

interface CpuStats {
  cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
  system_cpu_usage?: number;
  online_cpus?: number;
}

export interface ParsedStats {
  read_at: string | null;
  preread_at: string | null;
  sample_interval_ms: number | null;
  cpu: { cores_used: number; percent: number; online_cpus: number; percent_of_limit: number | null } | null;
  memory: {
    usage_bytes: number;
    working_set_bytes: number;
    limit_bytes: number | null;
    limit_source: 'container' | 'host';
    percent_of_limit: number | null;
  } | null;
  pids: number | null;
  network: { rx_bytes: number; tx_bytes: number; rx_errors: number; tx_errors: number } | null;
  block_io: { read_bytes: number; write_bytes: number } | null;
  notes: string[];
}

const NULL_TIME = /^0001-01-01/;

export function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/**
 * @param cpuLimitCores container CPU limit (null = unlimited)
 * @param memLimitConfigured container memory limit configured in HostConfig (0/undefined = unlimited)
 */
export function parseStats(s: DockerStats, cpuLimitCores: number | null, memLimitConfigured?: number): ParsedStats {
  const notes: string[] = [];
  const readAt = s.read && !NULL_TIME.test(s.read) ? s.read : null;
  const prereadAt = s.preread && !NULL_TIME.test(s.preread) ? s.preread : null;
  const interval = readAt && prereadAt ? Date.parse(readAt) - Date.parse(prereadAt) : null;

  let cpu: ParsedStats['cpu'] = null;
  const cur = s.cpu_stats;
  const prev = s.precpu_stats;
  const cpuDelta = (cur?.cpu_usage?.total_usage ?? 0) - (prev?.cpu_usage?.total_usage ?? 0);
  const sysDelta = (cur?.system_cpu_usage ?? 0) - (prev?.system_cpu_usage ?? 0);
  const online = cur?.online_cpus || cur?.cpu_usage?.percpu_usage?.length || 0;
  if (!prev?.system_cpu_usage || !cur?.system_cpu_usage || sysDelta <= 0 || online <= 0) {
    notes.push('缺少前一次 CPU 采样（precpu_stats），无法计算 CPU 使用率');
  } else if (cpuDelta < 0) {
    notes.push('CPU 计数器回退（容器可能刚重启），本次不计算 CPU 使用率');
  } else {
    const cores = (cpuDelta / sysDelta) * online;
    cpu = {
      cores_used: round(cores, 4),
      percent: round(cores * 100, 2),
      online_cpus: online,
      percent_of_limit: cpuLimitCores ? round((cores / cpuLimitCores) * 100, 2) : null,
    };
  }

  let memory: ParsedStats['memory'] = null;
  const ms = s.memory_stats;
  if (ms && typeof ms.usage === 'number') {
    // same working-set definition as `docker stats`: usage minus inactive page cache
    const inactive = ms.stats?.inactive_file ?? ms.stats?.total_inactive_file ?? 0;
    const ws = Math.max(0, ms.usage - (inactive < ms.usage ? inactive : 0));
    const limited = !!memLimitConfigured && memLimitConfigured > 0;
    const limit = typeof ms.limit === 'number' && ms.limit > 0 ? ms.limit : null;
    memory = {
      usage_bytes: ms.usage,
      working_set_bytes: ws,
      limit_bytes: limit,
      limit_source: limited ? 'container' : 'host',
      percent_of_limit: limit ? round((ws / limit) * 100, 2) : null,
    };
    if (!limited) notes.push('容器未设置内存上限，limit 为宿主机可用内存');
  } else {
    notes.push('响应中没有内存统计（容器可能未运行或 cgroup 不支持）');
  }

  let network: ParsedStats['network'] = null;
  if (s.networks) {
    network = { rx_bytes: 0, tx_bytes: 0, rx_errors: 0, tx_errors: 0 };
    for (const n of Object.values(s.networks)) {
      network.rx_bytes += n.rx_bytes ?? 0;
      network.tx_bytes += n.tx_bytes ?? 0;
      network.rx_errors += n.rx_errors ?? 0;
      network.tx_errors += n.tx_errors ?? 0;
    }
  }

  let blockIo: ParsedStats['block_io'] = null;
  const io = s.blkio_stats?.io_service_bytes_recursive;
  if (Array.isArray(io)) {
    blockIo = { read_bytes: 0, write_bytes: 0 };
    for (const e of io) {
      const op = e.op.toLowerCase();
      if (op === 'read') blockIo.read_bytes += e.value;
      else if (op === 'write') blockIo.write_bytes += e.value;
    }
  } else {
    notes.push('块设备 I/O 统计不可用（blkio_stats 为空，常见于部分 cgroup v2 环境）');
  }

  return {
    read_at: readAt,
    preread_at: prereadAt,
    sample_interval_ms: interval,
    cpu,
    memory,
    pids: s.pids_stats?.current ?? null,
    network,
    block_io: blockIo,
    notes,
  };
}
