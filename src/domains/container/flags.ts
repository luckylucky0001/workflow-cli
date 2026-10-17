/** Capacity risk flags shared by the Docker and Kubernetes providers. */
export interface FlagInput {
  limits: { cpus: number | null; memory_bytes: number | null };
  usage: ({ cpu_percent_of_limit: number | null; memory_percent_of_limit: number | null } & Record<string, unknown>) | null;
  oom_killed: boolean;
  restart_count: number;
}

export function capacityFlags(item: FlagInput): string[] {
  const f: string[] = [];
  if (item.limits.cpus === null) f.push('no_cpu_limit');
  if (item.limits.memory_bytes === null) f.push('no_memory_limit');
  if (item.usage?.cpu_percent_of_limit != null && item.usage.cpu_percent_of_limit >= 80) f.push('cpu_above_80pct_of_limit');
  if (item.usage?.memory_percent_of_limit != null && item.usage.memory_percent_of_limit >= 80) f.push('memory_above_80pct_of_limit');
  if (item.oom_killed) f.push('oom_killed_last_exit');
  if (item.restart_count > 0) f.push('auto_restarted');
  return f;
}
