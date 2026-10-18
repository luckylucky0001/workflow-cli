import { z } from 'zod';
import { WorkError } from '../../../core/output';
import { defineCapability } from '../../../core/registry';
import { formatDuration, parseDuration, sleep } from '../../../core/runtime';
import { ADAPTER, AUTH_PROVIDER, GUIDE, isoFromPg, num, statsVisibility, withPg, type PgSession } from '../client';
import { COMMON_PREREQS, INSTANCE } from '../inputs';
import { displaySql } from '../sql-guard';

export function parseWindow(v: unknown): number {
  const t = String(v ?? '').trim();
  if (/^0+(ms|s|m)?$/.test(t)) return 0;
  return parseDuration(t);
}

export interface PssRow {
  key: string;
  queryid: string | null;
  database: string | null;
  user: string | null;
  query: string | null;
  calls: number;
  total_ms: number;
  max_ms: number | null;
  rows: number;
  shared_blks_hit: number;
  shared_blks_read: number;
  temp_blks_written: number;
  /** min_exec_time: can only go down while an entry lives; going up means the entry was re-created. */
  min_ms?: number | null;
  /** PG17+ pg_stat_statements.stats_since: changes when the single entry is reset. */
  stats_since?: string | null;
}

export interface PssStat {
  queryid: string | null;
  database: string | null;
  user: string | null;
  query: string | null;
  query_truncated: boolean;
  calls: number;
  total_exec_ms: number;
  mean_exec_ms: number | null;
  max_exec_ms?: number | null;
  rows: number;
  rows_per_call: number | null;
  shared_blks_hit: number;
  shared_blks_read: number;
  cache_hit_ratio: number | null;
  temp_blks_written: number;
  reset_detected?: boolean;
}

const ORDER = ['total_time', 'calls', 'mean_time', 'rows', 'shared_blks_read'] as const;
type Order = (typeof ORDER)[number];

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Did this entry get reset (pg_stat_statements_reset(userid, dbid, queryid) removes it, it is then
 * re-created with fresh counters) between the snapshots? PG17+: stats_since changed. Otherwise any
 * monotonic counter going backwards, max_exec_time dropping or min_exec_time rising — the
 * re-created entry may already have more calls than before, so `calls` alone misses it.
 */
export function entryWasReset(a: PssRow, b: PssRow): boolean {
  if (a.stats_since && b.stats_since) return a.stats_since !== b.stats_since;
  if (b.calls < a.calls || b.total_ms < a.total_ms || b.rows < a.rows) return true;
  if (b.shared_blks_hit < a.shared_blks_hit || b.shared_blks_read < a.shared_blks_read || b.temp_blks_written < a.temp_blks_written) return true;
  if (a.max_ms != null && b.max_ms != null && b.max_ms < a.max_ms) return true;
  if (a.min_ms != null && b.min_ms != null && a.calls > 0 && b.min_ms > a.min_ms) return true;
  return false;
}

/** Window delta t1 − t0 keyed by (userid, dbid, queryid, toplevel). A reset entry counts only its post-reset values. */
export function diffStatements(t0In: PssRow[], t1In: PssRow[]): { stats: PssStat[]; reset: number; disappeared: number } {
  // without pg_read_all_stats other roles' entries have queryid NULL, so several statements share one
  // key: diff their per-key sums instead of pairing arbitrary entries (which fakes resets / deltas)
  const t0 = mergeByKey(t0In);
  const t1 = mergeByKey(t1In);
  const before = new Map(t0.map((r) => [r.key, r]));
  const afterKeys = new Set(t1.map((r) => r.key));
  let reset = 0;
  const stats: PssStat[] = [];
  for (const b of t1) {
    const a = before.get(b.key);
    let resetDetected = false;
    let base = a;
    if (a && entryWasReset(a, b)) {
      reset++;
      resetDetected = true;
      base = undefined;
    }
    const calls = b.calls - (base?.calls ?? 0);
    if (calls <= 0) continue;
    const total = b.total_ms - (base?.total_ms ?? 0);
    const rows = b.rows - (base?.rows ?? 0);
    const hit = b.shared_blks_hit - (base?.shared_blks_hit ?? 0);
    const read = b.shared_blks_read - (base?.shared_blks_read ?? 0);
    stats.push({
      ...toStat({ ...b, calls, total_ms: total, rows, shared_blks_hit: hit, shared_blks_read: read, temp_blks_written: b.temp_blks_written - (base?.temp_blks_written ?? 0) }),
      ...(resetDetected || !a ? { reset_detected: resetDetected } : {}),
    });
  }
  const disappeared = t0.filter((r) => !afterKeys.has(r.key)).length;
  return { stats, reset, disappeared };
}

function mergeByKey(rows: PssRow[]): PssRow[] {
  const out = new Map<string, PssRow>();
  for (const r of rows) {
    const a = out.get(r.key);
    if (!a) {
      out.set(r.key, { ...r });
      continue;
    }
    const pick = (x: number | null | undefined, y: number | null | undefined, f: (...v: number[]) => number) => (x == null ? (y ?? null) : y == null ? x : f(x, y));
    out.set(r.key, {
      ...a,
      calls: a.calls + r.calls,
      total_ms: a.total_ms + r.total_ms,
      rows: a.rows + r.rows,
      shared_blks_hit: a.shared_blks_hit + r.shared_blks_hit,
      shared_blks_read: a.shared_blks_read + r.shared_blks_read,
      temp_blks_written: a.temp_blks_written + r.temp_blks_written,
      max_ms: pick(a.max_ms, r.max_ms, Math.max),
      min_ms: pick(a.min_ms, r.min_ms, Math.min),
      stats_since: null,
    });
  }
  return [...out.values()];
}

export function toStat(r: PssRow, withMax = false): PssStat {
  const q = displaySql(r.query);
  return {
    queryid: r.queryid,
    database: r.database,
    user: r.user,
    query: q.text,
    query_truncated: q.truncated,
    calls: r.calls,
    total_exec_ms: r3(r.total_ms),
    mean_exec_ms: r.calls > 0 ? r3(r.total_ms / r.calls) : null,
    ...(withMax ? { max_exec_ms: r.max_ms === null ? null : r3(r.max_ms) } : {}),
    rows: r.rows,
    rows_per_call: r.calls > 0 ? r3(r.rows / r.calls) : null,
    shared_blks_hit: r.shared_blks_hit,
    shared_blks_read: r.shared_blks_read,
    cache_hit_ratio: r.shared_blks_hit + r.shared_blks_read > 0 ? Math.round((r.shared_blks_hit / (r.shared_blks_hit + r.shared_blks_read)) * 10000) / 10000 : null,
    temp_blks_written: r.temp_blks_written,
  };
}

export function sortStats(stats: PssStat[], order: Order): PssStat[] {
  const key: Record<Order, (x: PssStat) => number> = {
    total_time: (x) => x.total_exec_ms,
    calls: (x) => x.calls,
    mean_time: (x) => x.mean_exec_ms ?? 0,
    rows: (x) => x.rows,
    shared_blks_read: (x) => x.shared_blks_read,
  };
  return [...stats].sort((a, b) => key[order](b) - key[order](a));
}

/** Our own sampling statement shows up in pg_stat_statements; it is excluded from results. */
export function isSelf(query: string | null): boolean {
  return /\bpg_stat_statements(_info)?\b/.test(query ?? '');
}

/**
 * pg_stat_statements must be (1) loaded via shared_preload_libraries and (2) created as an
 * extension in the connected database, and (3) tracking must not be `none`. Each missing piece
 * is COLLECTION_DISABLED — "not collected" is never reported as "no statements".
 */
export async function assertPssCollection(s: PgSession): Promise<{ schema: string; version: string; track: string | null; max: number | null }> {
  const [ext] = await s.query(`SELECT e.extversion, n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_stat_statements'`);
  const [g] = await s.query(`SELECT current_setting('pg_stat_statements.track', true) AS track, current_setting('pg_stat_statements.max', true) AS max`);
  const loaded = g?.track !== null && g?.track !== undefined;
  if (!ext) {
    throw new WorkError('COLLECTION_DISABLED', `库 ${s.database} 中未安装 pg_stat_statements 扩展，没有语句统计可读`, {
      hint: `${loaded ? '' : "先在 postgresql.conf 设置 shared_preload_libraries='pg_stat_statements' 并重启；"}由 DBA 在库 ${s.database} 执行 CREATE EXTENSION pg_stat_statements（扩展按库创建；若其它库已创建，可把端点 database 指向该库）；这不代表“没有慢语句”`,
      details: { database: s.database, module_loaded: loaded },
    });
  }
  if (!loaded) {
    throw new WorkError('COLLECTION_DISABLED', 'pg_stat_statements 扩展已创建，但模块未通过 shared_preload_libraries 加载', {
      hint: "在 postgresql.conf 设置 shared_preload_libraries='pg_stat_statements' 并重启实例（静态参数）",
    });
  }
  if (String(g.track) === 'none') {
    throw new WorkError('COLLECTION_DISABLED', 'pg_stat_statements.track = none，语句统计未采集', { hint: "ALTER SYSTEM SET pg_stat_statements.track = 'top'; SELECT pg_reload_conf();（需 DBA）" });
  }
  return { schema: String(ext.nspname), version: String(ext.extversion), track: g.track ?? null, max: num(g.max) };
}

async function snapshot(s: PgSession, schema: string, database: string | undefined): Promise<PssRow[]> {
  const q = (n: string) => `"${schema.replace(/"/g, '""')}".${n}`;
  const total = s.versionNum >= 130000 ? 'total_exec_time' : 'total_time';
  const max = s.versionNum >= 130000 ? 'max_exec_time' : 'max_time';
  const min = s.versionNum >= 130000 ? 'min_exec_time' : 'min_time';
  const since = s.versionNum >= 170000 ? 'p.stats_since::text' : 'NULL::text';
  const toplevel = s.versionNum >= 140000 ? 'p.toplevel::text' : "'t'";
  const rows = await s.query(
    `SELECT p.userid::text || '/' || p.dbid::text || '/' || coalesce(p.queryid::text, '') || '/' || ${toplevel} AS key,
            p.queryid::text AS queryid, d.datname, r.rolname, p.query, p.calls, p.${total} AS total_ms, p.${max} AS max_ms, p.${min} AS min_ms, ${since} AS stats_since, p.rows,
            p.shared_blks_hit, p.shared_blks_read, p.temp_blks_written
       FROM ${q('pg_stat_statements')} p
       LEFT JOIN pg_database d ON d.oid = p.dbid
       LEFT JOIN pg_roles r ON r.oid = p.userid
      WHERE ($1::text IS NULL OR d.datname = $1)`,
    [database ?? null],
  );
  return rows.map((r) => ({
    key: String(r.key),
    queryid: r.queryid ?? null,
    database: r.datname ?? null,
    user: r.rolname ?? null,
    query: r.query ?? null,
    calls: Number(r.calls),
    total_ms: Number(r.total_ms),
    max_ms: num(r.max_ms),
    rows: Number(r.rows),
    shared_blks_hit: Number(r.shared_blks_hit),
    shared_blks_read: Number(r.shared_blks_read),
    temp_blks_written: Number(r.temp_blks_written),
    min_ms: num(r.min_ms),
    stats_since: r.stats_since ?? null,
  }));
}

async function info(s: PgSession, schema: string): Promise<{ dealloc: number | null; stats_reset: string | null }> {
  if (s.versionNum < 140000) return { dealloc: null, stats_reset: null };
  const [r] = await s.query(`SELECT dealloc, stats_reset FROM "${schema.replace(/"/g, '""')}".pg_stat_statements_info`);
  return { dealloc: num(r?.dealloc), stats_reset: isoFromPg(r?.stats_reset) };
}

const StatSchema = z.object({
  queryid: z.string().nullable(),
  database: z.string().nullable(),
  user: z.string().nullable(),
  query: z.string().nullable().describe('归一化语句（常量为 $n），其余字面量替换为 ?，截断至 512 字符；无权限时为 null'),
  query_truncated: z.boolean(),
  calls: z.number(),
  total_exec_ms: z.number(),
  mean_exec_ms: z.number().nullable(),
  max_exec_ms: z.number().nullable().optional().describe('仅累计模式：自 stats_reset 以来单次最大执行耗时'),
  rows: z.number(),
  rows_per_call: z.number().nullable(),
  shared_blks_hit: z.number(),
  shared_blks_read: z.number(),
  cache_hit_ratio: z.number().nullable(),
  temp_blks_written: z.number(),
  reset_detected: z.boolean().optional(),
});

export const statementSummary = defineCapability({
  name: 'postgres.statement.summary',
  command: 'pg statement summary',
  summary: '按语句（pg_stat_statements）统计调用次数、执行耗时、返回行数和缓存命中；默认两次快照差分得到窗口值',
  domain: 'postgres',
  inputs: {
    instance: INSTANCE,
    sample_window: { type: 'string', default: '10s', description: '采样窗口，如 5s、30s；0 表示返回自 stats_reset 以来的累计值（不是窗口值）。窗口须小于 --timeout' },
    top: { type: 'int', default: 10, description: '取前 N 条' },
    order_by: { type: 'enum', enum: [...ORDER], default: 'total_time', description: '排序：total_time（总耗时）/ calls / mean_time / rows / shared_blks_read' },
    database: { type: 'string', description: '只看该库的语句（pg_stat_statements.dbid）；缺省为全部库' },
  },
  output: z.object({
    instance: z.string(),
    aggregation: z.enum(['window_delta', 'cumulative_since']),
    window: z.object({ start: z.string(), end: z.string(), duration_ms: z.number() }).nullable(),
    cumulative_since: z
      .object({ stats_reset: z.string().nullable().describe('pg_stat_statements_info.stats_reset（PG14+）'), server_started_at: z.string().nullable() })
      .nullable()
      .describe('累计模式的统计起点是 stats_reset（扩展创建或 pg_stat_statements_reset()）；pg_stat_statements.save=on（默认）时正常重启不清空统计，崩溃恢复会清空'),
    database: z.string().nullable(),
    order_by: z.string(),
    top: z.number(),
    statements: z.array(StatSchema),
    totals: z.object({ statements_with_activity: z.number(), calls: z.number(), total_exec_ms: z.number() }),
    collection: z.object({
      extension_version: z.string(),
      track: z.string().nullable(),
      max_entries: z.number().nullable().describe('pg_stat_statements.max：超过后最少执行的条目被淘汰（dealloc）'),
      dealloc: z.number().nullable().describe('累计被淘汰的条目数（PG14+）'),
      text_visible: z.boolean().describe('当前角色能看到其他角色的语句文本（pg_read_all_stats）'),
    }),
    excluded_self: z.number().describe('已排除的采样语句（查询 pg_stat_statements 本身的语句，含 workctl 自身）'),
  }),
  adapter: ADAPTER,
  operation: 'diagnose',
  auth_provider: AUTH_PROVIDER,
  guide: GUIDE,
  prerequisites: [...COMMON_PREREQS, "shared_preload_libraries 含 pg_stat_statements（需重启）且在连接库中 CREATE EXTENSION pg_stat_statements；pg_stat_statements.track ≠ none"],
  notes: [
    'pg_stat_statements 的值是自 stats_reset（扩展创建或 pg_stat_statements_reset()；默认 save=on 时正常重启不清空）以来的累计值；--sample-window 0 直接返回累计值（aggregation=cumulative_since），不能当作窗口值',
    '窗口值 = t1 快照 − t0 快照（按 userid+dbid+queryid+toplevel）；采样期间命令会等待整个窗口，窗口须小于 --timeout（默认 30s）',
    '单条语句被重置（PG17+ 看 stats_since；更早版本看计数/耗时回退、max 下降或 min 上升）时只计入重置后的部分（reset_detected=true）并标记 partial；窗口内有条目被淘汰（dealloc 增加）或消失时也标记为 partial',
    '耗时单位毫秒（total_exec_time，不含规划时间）；扩展未安装/未加载/track=none 时返回 COLLECTION_DISABLED，而不是空结果',
  ],
  examples: [
    'workctl pg statement summary --instance demo-postgres --sample-window 10s --top 10',
    'workctl pg statement summary --instance demo-postgres --sample-window 0 --order-by mean_time --database demo_orders',
  ],
  handler: async (ctx, i) => {
    const windowMs = parseWindow(i.sample_window);
    const top = Math.max(1, Math.min(Number(i.top), 100));
    const order = (ORDER as readonly string[]).includes(String(i.order_by)) ? (String(i.order_by) as Order) : 'total_time';
    if (windowMs > 0 && windowMs + 3000 > ctx.remainingMs()) {
      throw new WorkError('INVALID_ARGUMENT', `采样窗口 ${formatDuration(windowMs)} 超过剩余时间预算 ${Math.floor(ctx.remainingMs() / 1000)}s`, {
        hint: `增大 --timeout（如 --timeout ${Math.ceil((windowMs + 10_000) / 1000)}s）或缩小 --sample-window`,
      });
    }
    return withPg(ctx, i.instance, async (s) => {
      const coll = await assertPssCollection(s);
      const vis = await statsVisibility(s);
      const db = typeof i.database === 'string' && i.database ? i.database : undefined;
      // a misspelt --database would otherwise read as "no statements"
      if (db !== undefined && !(await s.query('SELECT 1 FROM pg_database WHERE datname = $1', [db])).length) {
        throw new WorkError('NOT_FOUND', `数据库不存在: ${db} (${s.ep.id})`, { hint: '用 workctl pg database list 查看可见的库（名称区分大小写）' });
      }
      const collection = (dealloc: number | null) => ({ extension_version: coll.version, track: coll.track, max_entries: coll.max, dealloc, text_visible: vis.all });
      const visibilityNotes = vis.all ? [] : [`角色 ${s.user} 没有 pg_read_all_stats：其他角色的语句文本不可见（query=null）`];
      if (windowMs === 0) {
        const inf = await info(s, coll.schema);
        const [st] = await s.query('SELECT pg_postmaster_start_time() AS t');
        const all = await snapshot(s, coll.schema, db);
        const rows = all.filter((r) => !isSelf(r.query));
        const stats = sortStats(
          rows.filter((r) => r.calls > 0).map((r) => toStat(r, true)),
          order,
        );
        return {
          status: vis.all ? 'success' : 'partial',
          data: {
            instance: s.ep.name,
            aggregation: 'cumulative_since' as const,
            window: null,
            cumulative_since: { stats_reset: inf.stats_reset, server_started_at: isoFromPg(st?.t) },
            database: db ?? null,
            order_by: order,
            top,
            statements: stats.slice(0, top).map(hideText),
            totals: totals(stats),
            collection: collection(inf.dealloc),
            excluded_self: all.length - rows.length,
          },
          sources: [s.src(`${coll.schema}.pg_stat_statements (cumulative)`)],
          coverage: {
            complete: vis.all,
            limit: top,
            truncated: stats.length > top,
            notes: [
              `累计值：自 ${inf.stats_reset ?? '扩展创建或上次重置（PG14 以下无法读取 stats_reset）'} 以来，不是窗口值`,
              ...((inf.dealloc ?? 0) > 0 ? [`共有 ${inf.dealloc} 次条目淘汰（pg_stat_statements.max=${coll.max ?? 'unknown'}），低频语句可能已被移出统计`] : []),
              ...visibilityNotes,
            ],
          },
        };
      }
      const inf0 = await info(s, coll.schema);
      const t0 = await snapshot(s, coll.schema, db);
      const start = new Date();
      await sleep(windowMs, ctx.signal);
      const t1 = await snapshot(s, coll.schema, db);
      const end = new Date();
      const inf1 = await info(s, coll.schema);
      const diff = diffStatements(t0, t1);
      const stats = sortStats(
        diff.stats.filter((x) => !isSelf(x.query)),
        order,
      );
      const excluded = diff.stats.length - stats.length;
      const partialReasons: string[] = [];
      if (inf0.stats_reset !== inf1.stats_reset) partialReasons.push('窗口内执行过 pg_stat_statements_reset()，重置前的活动未计入');
      if (diff.reset) partialReasons.push(`${diff.reset} 条语句在窗口内被单独重置，只计入重置后的部分（reset_detected=true），重置前的窗口内活动未计入`);
      if (diff.disappeared) partialReasons.push(`${diff.disappeared} 条语句在窗口内从统计中消失（被淘汰或重置），其窗口内活动未计入`);
      const deallocDelta = inf0.dealloc !== null && inf1.dealloc !== null ? inf1.dealloc - inf0.dealloc : 0;
      if (deallocDelta > 0) partialReasons.push(`窗口内发生 ${deallocDelta} 次条目淘汰（pg_stat_statements.max=${coll.max ?? 'unknown'}），新出现的语句可能被高估为整段累计`);
      const complete = partialReasons.length === 0 && vis.all;
      return {
        status: complete ? 'success' : 'partial',
        data: {
          instance: s.ep.name,
          aggregation: 'window_delta' as const,
          window: { start: start.toISOString(), end: end.toISOString(), duration_ms: end.getTime() - start.getTime() },
          cumulative_since: null,
          database: db ?? null,
          order_by: order,
          top,
          statements: stats.slice(0, top).map(hideText),
          totals: totals(stats),
          collection: collection(inf1.dealloc),
          excluded_self: excluded,
        },
        sources: [s.src(`${coll.schema}.pg_stat_statements (t1 − t0)`, 'derived')],
        coverage: {
          complete,
          limit: top,
          truncated: stats.length > top,
          window: { start: start.toISOString(), end: end.toISOString() },
          notes: [
            ...(stats.length ? [] : ['窗口内没有语句执行完成（采集正常开启；不是 COLLECTION_DISABLED）']),
            ...partialReasons,
            ...visibilityNotes,
            `窗口值（t1 − t0），窗口 ${formatDuration(end.getTime() - start.getTime())}；t0 中不存在的语句按其全部计数计入（窗口内首次出现）`,
            ...(s.versionNum < 170000
              ? ['PostgreSQL 17 以下没有 stats_since：单条语句被 pg_stat_statements_reset(userid, dbid, queryid) 重置后，只能通过计数/耗时回退或 min/max 变化识别，极少数情况下可能识别不到']
              : []),
          ],
        },
      };
    });
  },
});

function hideText(x: PssStat): PssStat {
  return x.query === '<insufficient privilege>' ? { ...x, query: null } : x;
}

function totals(stats: PssStat[]) {
  return {
    statements_with_activity: stats.length,
    calls: stats.reduce((a, b) => a + b.calls, 0),
    total_exec_ms: r3(stats.reduce((a, b) => a + b.total_exec_ms, 0)),
  };
}
