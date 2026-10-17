/**
 * Pure helpers for Redis INFO parsing and metric semantics (no I/O; unit-tested).
 */

export type InfoValue = string | number | Record<string, string | number>;
export type InfoSections = Record<string, Record<string, InfoValue>>;

function scalar(v: string): string | number {
  if (/^-?\d+(\.\d+)?$/.test(v) && v.length < 16) return Number(v);
  return v;
}

/**
 * Parse INFO output into { section: { key: value } }. Section names are lower-cased.
 * Composite values like `db0:keys=1,expires=0,avg_ttl=0` or commandstats
 * `cmdstat_get:calls=1,usec=2,...` become objects.
 */
export function parseInfo(text: string): InfoSections {
  const out: InfoSections = {};
  let section = 'default';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      section = line.slice(1).trim().toLowerCase();
      out[section] ??= {};
      continue;
    }
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx);
    const val = line.slice(idx + 1);
    out[section] ??= {};
    if (/^[a-z_]+=/.test(val) && val.includes('=') && (section === 'keyspace' || section === 'commandstats' || section === 'errorstats' || section === 'latencystats' || /^(slave\d+|db\d+)$/.test(key))) {
      const obj: Record<string, string | number> = {};
      for (const part of val.split(',')) {
        const eq = part.indexOf('=');
        if (eq > 0) obj[part.slice(0, eq)] = scalar(part.slice(eq + 1));
      }
      out[section][key] = obj;
    } else out[section][key] = scalar(val);
  }
  return out;
}

export type Semantics = 'cumulative_since_start' | 'gauge' | 'instantaneous_estimate' | 'static' | 'timestamp';

const CUMULATIVE = new Set([
  'total_connections_received',
  'total_commands_processed',
  'total_net_input_bytes',
  'total_net_output_bytes',
  'total_net_repl_input_bytes',
  'total_net_repl_output_bytes',
  'rejected_connections',
  'sync_full',
  'sync_partial_ok',
  'sync_partial_err',
  'expired_keys',
  'expired_stale_perc',
  'expired_time_cap_reached_count',
  'expire_cycle_cpu_milliseconds',
  'evicted_keys',
  'evicted_clients',
  'evicted_scripts',
  'total_eviction_exceeded_time',
  'keyspace_hits',
  'keyspace_misses',
  'pubsub_channels',
  'total_forks',
  'total_error_replies',
  'dump_payload_sanitizations',
  'total_reads_processed',
  'total_writes_processed',
  'io_threaded_reads_processed',
  'io_threaded_writes_processed',
  'unexpected_error_replies',
  'total_active_defrag_time',
  'active_defrag_hits',
  'active_defrag_misses',
  'active_defrag_key_hits',
  'active_defrag_key_misses',
  'acl_access_denied_auth',
  'acl_access_denied_cmd',
  'acl_access_denied_key',
  'acl_access_denied_channel',
  'client_query_buffer_limit_disconnections',
  'client_output_buffer_limit_disconnections',
  'reply_buffer_shrinks',
  'reply_buffer_expands',
  'total_blocking_keys',
  'used_cpu_sys',
  'used_cpu_user',
  'used_cpu_sys_children',
  'used_cpu_user_children',
  'used_cpu_sys_main_thread',
  'used_cpu_user_main_thread',
  'rdb_saves',
  'stat_numcommands',
  'aof_rewrites',
]);
const STATIC_SECTIONS = new Set(['server']);
const STATIC_KEYS = new Set(['maxmemory', 'maxmemory_policy', 'maxmemory_human', 'maxclients', 'role', 'aof_enabled', 'cluster_enabled', 'mem_allocator', 'total_system_memory', 'total_system_memory_human']);

export function semanticsOf(section: string, key: string): Semantics {
  if (section === 'commandstats' || section === 'errorstats' || section === 'latencystats') return 'cumulative_since_start';
  if (key.startsWith('instantaneous_')) return 'instantaneous_estimate';
  if (CUMULATIVE.has(key)) return 'cumulative_since_start';
  if (/(_time|_timestamp)$/.test(key) && /last_|_save_time|started/.test(key)) return 'timestamp';
  if (STATIC_KEYS.has(key)) return 'static';
  if (STATIC_SECTIONS.has(section)) return key === 'uptime_in_seconds' || key === 'uptime_in_days' || key === 'lru_clock' ? 'gauge' : 'static';
  return 'gauge';
}

// ------------------------------------------------------------------ window sampling

export const WINDOW_COUNTERS = [
  'keyspace_hits',
  'keyspace_misses',
  'total_commands_processed',
  'evicted_keys',
  'expired_keys',
  'rejected_connections',
  'total_connections_received',
  'total_net_input_bytes',
  'total_net_output_bytes',
  'total_error_replies',
] as const;

export interface StatsSnapshot {
  at: number; // epoch ms (client clock)
  run_id: string | null;
  uptime_s: number | null;
  counters: Partial<Record<(typeof WINDOW_COUNTERS)[number], number>>;
}

export function snapshotFromInfo(info: InfoSections, at: number): StatsSnapshot {
  const counters: StatsSnapshot['counters'] = {};
  for (const k of WINDOW_COUNTERS) {
    const v = info.stats?.[k];
    if (typeof v === 'number') counters[k] = v;
  }
  const runId = info.server?.run_id;
  const up = info.server?.uptime_in_seconds;
  return { at, run_id: runId === undefined ? null : String(runId), uptime_s: typeof up === 'number' ? up : null, counters };
}

export interface WindowDelta {
  duration_ms: number;
  restart_detected: boolean;
  reset_counters: string[];
  deltas: Record<string, number | null>;
  rates_per_sec: Record<string, number | null>;
  hit_ratio: number | null;
  hit_ratio_note: string;
}

/**
 * Window deltas between two INFO snapshots. A restart (run_id changed or uptime went
 * backwards) or a counter that decreased (CONFIG RESETSTAT) yields null instead of a
 * negative or misleading value.
 */
export function windowDelta(a: StatsSnapshot, b: StatsSnapshot): WindowDelta {
  const duration = Math.max(1, b.at - a.at);
  const restart = (a.run_id !== null && b.run_id !== null && a.run_id !== b.run_id) || (a.uptime_s !== null && b.uptime_s !== null && b.uptime_s < a.uptime_s);
  const deltas: Record<string, number | null> = {};
  const rates: Record<string, number | null> = {};
  const reset: string[] = [];
  for (const k of WINDOW_COUNTERS) {
    const x = a.counters[k];
    const y = b.counters[k];
    if (restart || x === undefined || y === undefined) {
      deltas[k] = null;
      rates[k] = null;
      continue;
    }
    if (y < x) {
      reset.push(k);
      deltas[k] = null;
      rates[k] = null;
      continue;
    }
    deltas[k] = y - x;
    rates[k] = Math.round(((y - x) / (duration / 1000)) * 100) / 100;
  }
  const hits = deltas.keyspace_hits;
  const misses = deltas.keyspace_misses;
  let ratio: number | null = null;
  let note: string;
  if (hits === null || misses === null || hits === undefined || misses === undefined) note = '窗口内计数器不可比（重启或重置），无法计算命中率';
  else if (hits + misses === 0) note = '窗口内没有键查找（hits+misses=0），命中率无定义（null），不是 0';
  else {
    ratio = Math.round((hits / (hits + misses)) * 10000) / 10000;
    note = `hits/(hits+misses)，基于窗口内 ${hits + misses} 次键查找`;
  }
  return { duration_ms: duration, restart_detected: restart, reset_counters: reset, deltas, rates_per_sec: rates, hit_ratio: ratio, hit_ratio_note: note };
}

// ------------------------------------------------------------------ slowlog / sampling helpers

const NO_ARGS = new Set(['AUTH', 'HELLO', 'MIGRATE']);
/** Script/function calls: first argument is the script body / sha / function name, not a key. */
const SCRIPT_CALLS = new Set(['EVAL', 'EVAL_RO', 'EVALSHA', 'EVALSHA_RO', 'FCALL', 'FCALL_RO']);
const SUBCOMMAND = new Set(['ACL', 'CONFIG', 'CLIENT', 'CLUSTER', 'COMMAND', 'DEBUG', 'FUNCTION', 'SCRIPT', 'MEMORY', 'OBJECT', 'XINFO', 'XGROUP', 'MODULE', 'LATENCY', 'SLOWLOG', 'PUBSUB']);
const KEY_AFTER_SUBCOMMAND = new Set(['MEMORY', 'OBJECT', 'XINFO', 'XGROUP']);

/**
 * Redact slowlog arguments: keep the command (and sub-command), keep the key name, replace
 * every other argument by `?`. AUTH/HELLO keep no arguments at all.
 */
export function redactCommand(args: string[], maxKeyLen = 128): { command: string; key: string | null; args: string[]; arg_count: number } {
  const cmd = String(args[0] ?? '').toUpperCase();
  const rest = args.slice(1);
  const clip = (s: string) => (s.length > maxKeyLen ? `${s.slice(0, maxKeyLen)}…` : s);
  if (NO_ARGS.has(cmd)) return { command: cmd, key: null, args: rest.map(() => '?'), arg_count: rest.length };
  if (SCRIPT_CALLS.has(cmd)) {
    // EVAL script numkeys key... arg...: the script source can embed literal values; keep only the first key
    const numkeys = Number(rest[1]);
    const key = Number.isInteger(numkeys) && numkeys > 0 && rest[2] !== undefined ? clip(String(rest[2])) : null;
    return { command: cmd, key, args: rest.map((a, idx) => (idx === 2 && key !== null ? clip(String(a)) : idx === 1 ? String(a) : '?')), arg_count: rest.length };
  }
  if (SUBCOMMAND.has(cmd)) {
    const sub = String(rest[0] ?? '').toUpperCase();
    const keyIdx = KEY_AFTER_SUBCOMMAND.has(cmd) ? 1 : -1;
    const key = keyIdx > 0 && rest[keyIdx] !== undefined ? clip(String(rest[keyIdx])) : null;
    return {
      command: sub ? `${cmd} ${sub}` : cmd,
      key,
      args: rest.slice(1).map((a, idx) => (idx + 1 === keyIdx ? clip(String(a)) : '?')),
      arg_count: rest.length,
    };
  }
  const key = rest[0] !== undefined ? clip(String(rest[0])) : null;
  return { command: cmd, key, args: rest.map((a, idx) => (idx === 0 ? clip(String(a)) : '?')), arg_count: rest.length };
}

export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** Configuration names whose values must never be printed. */
export function isSensitiveConfig(name: string): boolean {
  return /(pass|auth|secret|requirepass|masterauth|masteruser|tls-.*key|token)/i.test(name);
}
