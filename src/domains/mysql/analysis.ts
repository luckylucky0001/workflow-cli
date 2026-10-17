/**
 * Pure helpers (no I/O) for MySQL capabilities: statement digest diffing, EXPLAIN JSON
 * flattening, EXPLAIN ANALYZE tree parsing, value masking. Unit-tested without a server.
 */

// ---------------------------------------------------------------- statement digests

export interface DigestRow {
  schema: string | null;
  digest: string | null;
  digest_text: string | null;
  count_star: string; // BIGINT UNSIGNED as decimal string (exact)
  sum_timer_wait: string; // picoseconds
  max_timer_wait?: string;
  sum_rows_examined: string;
  sum_rows_sent: string;
  sum_rows_affected: string;
  sum_no_index_used: string;
  sum_no_good_index_used: string;
  sum_errors: string;
  sum_created_tmp_disk_tables?: string;
  sum_sort_rows?: string;
  first_seen: string | null;
  last_seen: string | null;
}

export interface DigestStat {
  schema: string | null;
  digest: string | null;
  digest_text: string | null;
  count: number;
  total_latency_ms: number;
  avg_latency_ms: number | null;
  rows_examined: number;
  rows_sent: number;
  rows_affected: number;
  avg_rows_examined: number | null;
  no_index_used_count: number;
  no_good_index_used_count: number;
  errors: number;
  first_seen: string | null;
  last_seen: string | null;
  /** True when the digest's counters went backwards inside the window (table truncated / row evicted and re-created). */
  reset_detected?: boolean;
  /** Present only for cumulative output: maximum single-statement latency since first_seen. */
  max_latency_ms?: number;
}

const PS_PER_MS = 1_000_000_000n;

export function big(v: unknown): bigint {
  if (v === null || v === undefined || v === '') return 0n;
  try {
    return BigInt(String(v).split('.')[0]);
  } catch {
    return 0n;
  }
}

export function psToMs(ps: bigint): number {
  // keep 3 decimals without losing precision on huge picosecond sums
  const whole = ps / PS_PER_MS;
  const frac = Number((ps % PS_PER_MS) / 1_000_000n) / 1000;
  return Number(whole) + frac;
}

function round(n: number, d = 3): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

export function digestKey(r: { schema: string | null; digest: string | null }): string {
  return `${r.schema ?? ''}\u0000${r.digest ?? 'NULL'}`;
}

export function statFromRow(r: DigestRow, base?: DigestRow): DigestStat {
  const d = (k: keyof DigestRow) => big(r[k]) - (base ? big(base[k]) : 0n);
  const count = d('count_star');
  const sumWait = d('sum_timer_wait');
  const examined = d('sum_rows_examined');
  const totalMs = psToMs(sumWait);
  return {
    schema: r.schema,
    digest: r.digest,
    digest_text: r.digest_text,
    count: Number(count),
    total_latency_ms: round(totalMs),
    avg_latency_ms: count > 0n ? round(totalMs / Number(count)) : null,
    rows_examined: Number(examined),
    rows_sent: Number(d('sum_rows_sent')),
    rows_affected: Number(d('sum_rows_affected')),
    avg_rows_examined: count > 0n ? round(Number(examined) / Number(count), 1) : null,
    no_index_used_count: Number(d('sum_no_index_used')),
    no_good_index_used_count: Number(d('sum_no_good_index_used')),
    errors: Number(d('sum_errors')),
    first_seen: r.first_seen,
    last_seen: r.last_seen,
  };
}

export interface DigestDiff {
  stats: DigestStat[];
  /** digests present at t0 but missing at t1 (evicted or table truncated). */
  disappeared: number;
  /** digests whose COUNT_STAR decreased (reset) — their window value is a lower bound. */
  reset: number;
  /** digests new in t1 whose FIRST_SEEN predates the window start (were evicted before t0 or table reset). */
  reappeared: number;
  /** activity aggregated into the DIGEST=NULL row (digest table full). */
  null_digest_count: number;
}

/**
 * Window delta between two snapshots of events_statements_summary_by_digest, keyed by
 * (SCHEMA_NAME, DIGEST). Never produces negative values: a decreasing counter is treated
 * as a reset and the t1 value (activity since the reset) is used and flagged.
 */
export function diffDigests(t0: DigestRow[], t1: DigestRow[], windowStartIso: string): DigestDiff {
  const before = new Map(t0.map((r) => [digestKey(r), r]));
  const seen = new Set<string>();
  const stats: DigestStat[] = [];
  let reset = 0;
  let reappeared = 0;
  let nullDigest = 0;
  for (const r of t1) {
    const k = digestKey(r);
    seen.add(k);
    const b = before.get(k);
    let stat: DigestStat;
    if (b && big(r.count_star) >= big(b.count_star)) {
      stat = statFromRow(r, b);
    } else if (b) {
      reset++;
      stat = { ...statFromRow(r), reset_detected: true };
    } else {
      if (r.first_seen && windowStartIso && Date.parse(isoish(r.first_seen)) < Date.parse(windowStartIso) - 1000) {
        reappeared++;
        stat = { ...statFromRow(r), reset_detected: true };
      } else stat = statFromRow(r);
    }
    if (stat.count <= 0) continue;
    if (r.digest === null) nullDigest += stat.count;
    stats.push(stat);
  }
  let disappeared = 0;
  for (const k of before.keys()) if (!seen.has(k)) disappeared++;
  stats.sort((a, b) => b.total_latency_ms - a.total_latency_ms);
  return { stats, disappeared, reset, reappeared, null_digest_count: nullDigest };
}

function isoish(s: string): string {
  return /^\d{4}-\d{2}-\d{2} /.test(s) ? `${s.replace(' ', 'T')}Z` : s;
}

// ---------------------------------------------------------------- EXPLAIN FORMAT=JSON

export interface PlanTable {
  table: string;
  select_id: number | null;
  access_type: string | null;
  possible_keys: string[] | null;
  key: string | null;
  used_key_parts: string[] | null;
  key_length: string | null;
  rows_examined_per_scan: number | null;
  rows_produced_per_join: number | null;
  filtered: number | null;
  using_index: boolean;
  using_filesort: boolean;
  using_temporary_table: boolean;
  attached_condition: string | null;
  prefix_cost: number | null;
}

export interface PlanSummary {
  query_cost: number | null;
  tables: PlanTable[];
  using_filesort: boolean;
  using_temporary_table: boolean;
  full_scans: string[];
}

function n(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

export function flattenExplain(plan: unknown): PlanSummary {
  const tables: PlanTable[] = [];
  let anyFilesort = false;
  let anyTemp = false;
  const root = (plan as any)?.query_block ?? plan;
  const walk = (node: unknown, inherited: { filesort: boolean; temp: boolean; selectId: number | null }) => {
    if (Array.isArray(node)) {
      for (const x of node) walk(x, inherited);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const o = node as Record<string, any>;
    const flags = {
      filesort: inherited.filesort || o.using_filesort === true,
      temp: inherited.temp || o.using_temporary_table === true,
      selectId: typeof o.select_id === 'number' ? o.select_id : inherited.selectId,
    };
    if (o.using_filesort === true) anyFilesort = true;
    if (o.using_temporary_table === true) anyTemp = true;
    if (typeof o.table_name === 'string') {
      tables.push({
        table: o.table_name,
        select_id: flags.selectId,
        access_type: o.access_type ?? null,
        possible_keys: Array.isArray(o.possible_keys) ? o.possible_keys : null,
        key: o.key ?? null,
        used_key_parts: Array.isArray(o.used_key_parts) ? o.used_key_parts : null,
        key_length: o.key_length ?? null,
        rows_examined_per_scan: n(o.rows_examined_per_scan),
        rows_produced_per_join: n(o.rows_produced_per_join),
        filtered: n(o.filtered),
        using_index: o.using_index === true,
        using_filesort: flags.filesort,
        using_temporary_table: flags.temp,
        attached_condition: typeof o.attached_condition === 'string' ? o.attached_condition : null,
        prefix_cost: n(o.cost_info?.prefix_cost),
      });
    }
    for (const [k, v] of Object.entries(o)) {
      if (k === 'cost_info' || k === 'used_columns' || k === 'possible_keys' || k === 'used_key_parts') continue;
      if (v && typeof v === 'object') walk(v, flags);
    }
  };
  walk(root, { filesort: false, temp: false, selectId: null });
  return {
    query_cost: n((plan as any)?.query_block?.cost_info?.query_cost),
    tables,
    using_filesort: anyFilesort,
    using_temporary_table: anyTemp,
    full_scans: tables.filter((t) => t.access_type === 'ALL').map((t) => t.table),
  };
}

// ---------------------------------------------------------------- EXPLAIN ANALYZE (TREE)

export interface AnalyzeNode {
  depth: number;
  operation: string;
  estimated_cost: number | null;
  estimated_rows: number | null;
  actual_first_row_ms: number | null;
  actual_last_row_ms: number | null;
  actual_rows: number | null;
  loops: number | null;
  never_executed: boolean;
}

export function parseAnalyzeTree(tree: string): AnalyzeNode[] {
  const out: AnalyzeNode[] = [];
  for (const line of tree.split('\n')) {
    const m = /^(\s*)-> (.*)$/.exec(line);
    if (!m) continue;
    const body = m[2];
    const est = /\(cost=([\d.e+]+)(?:\.\.[\d.e+]+)? rows=([\d.e+]+)\)/.exec(body) ?? /\(rows=([\d.e+]+)\)/.exec(body);
    const act = /\(actual time=([\d.e+]+)\.\.([\d.e+]+) rows=([\d.e+]+) loops=(\d+)\)/.exec(body);
    const op = body.replace(/\s*\((?:cost|rows|actual time)=[^)]*\)/g, '').replace(/\s*\(never executed\)/, '').trim();
    const hasCost = est && est.length === 3;
    out.push({
      depth: Math.floor(m[1].length / 4),
      operation: op,
      estimated_cost: hasCost ? Number(est![1]) : null,
      estimated_rows: est ? Number(hasCost ? est[2] : est[1]) : null,
      actual_first_row_ms: act ? Number(act[1]) : null,
      actual_last_row_ms: act ? Number(act[2]) : null,
      actual_rows: act ? Number(act[3]) : null,
      loops: act ? Number(act[4]) : null,
      never_executed: /\(never executed\)/.test(body),
    });
  }
  return out;
}

// ---------------------------------------------------------------- masking

/** Mask a sensitive value: "13800001111" → "138****1111", "a@b.com" → "a***@b.com", short → "***". */
export function maskValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  const s = Buffer.isBuffer(v) ? '' : String(v);
  if (!s) return '***';
  const at = s.indexOf('@');
  if (at > 0) return `${s[0]}***${s.slice(at)}`;
  if (s.length >= 7) return `${s.slice(0, 3)}****${s.slice(-4)}`;
  return '***';
}

/** JSON-safe cell value: Buffers → utf8 (or hex when binary), long text capped. */
export function cell(v: unknown, maxChars = 2048): { value: unknown; truncated: boolean } {
  if (v === null || v === undefined) return { value: null, truncated: false };
  if (Buffer.isBuffer(v)) {
    const text = v.toString('utf8');
    const isText = !text.includes('�') && !/[\u0000-\u0008\u000E-\u001F]/.test(text);
    const s = isText ? text : `0x${v.toString('hex')}`;
    return s.length > maxChars ? { value: `${s.slice(0, maxChars)}…`, truncated: true } : { value: s, truncated: false };
  }
  if (typeof v === 'string' && v.length > maxChars) return { value: `${v.slice(0, maxChars)}…`, truncated: true };
  if (typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > maxChars ? { value: `${s.slice(0, maxChars)}…`, truncated: true } : { value: v, truncated: false };
  }
  return { value: v, truncated: false };
}
