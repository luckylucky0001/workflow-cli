import { z } from 'zod';
import { WorkError } from '../../../core/output';
import { defineCapability } from '../../../core/registry';
import { formatDuration, parseDuration, sleep } from '../../../core/runtime';
import { diffDigests, statFromRow, psToMs, big, type DigestRow, type DigestStat } from '../analysis';
import { ADAPTER, AUTH_PROVIDER, GUIDE, globalStatus, globalVariables, isoFromMysql, num, withMysql, type MysqlSession } from '../client';
import { COMMON_PREREQS, INSTANCE } from '../inputs';
import { maskLiterals, truncate } from '../sql-guard';

const DIGEST_SQL = `SELECT SCHEMA_NAME AS \`schema\`, DIGEST AS digest, DIGEST_TEXT AS digest_text, COUNT_STAR AS count_star,
       SUM_TIMER_WAIT AS sum_timer_wait, MAX_TIMER_WAIT AS max_timer_wait, SUM_ROWS_EXAMINED AS sum_rows_examined,
       SUM_ROWS_SENT AS sum_rows_sent, SUM_ROWS_AFFECTED AS sum_rows_affected, SUM_NO_INDEX_USED AS sum_no_index_used,
       SUM_NO_GOOD_INDEX_USED AS sum_no_good_index_used, SUM_ERRORS AS sum_errors,
       SUM_CREATED_TMP_DISK_TABLES AS sum_created_tmp_disk_tables, SUM_SORT_ROWS AS sum_sort_rows,
       FIRST_SEEN AS first_seen, LAST_SEEN AS last_seen
  FROM performance_schema.events_statements_summary_by_digest`;

async function snapshot(s: MysqlSession, database?: string): Promise<DigestRow[]> {
  const rows = database ? await s.query<any>(`${DIGEST_SQL} WHERE SCHEMA_NAME = ?`, [database]) : await s.query<any>(DIGEST_SQL);
  return rows.map((r) => ({ ...r, schema: r.schema ?? null, digest: r.digest ?? null, digest_text: r.digest_text ?? null })) as DigestRow[];
}

/** Ensure performance_schema statement digests are being collected; otherwise COLLECTION_DISABLED. */
export async function assertDigestCollection(s: MysqlSession): Promise<{ digests_size: number | null; max_digest_length: number | null; rows: number | null }> {
  const v = await globalVariables(s, ['performance_schema', 'performance_schema_digests_size', 'max_digest_length']);
  if (v.performance_schema !== 'ON') {
    throw new WorkError('COLLECTION_DISABLED', `实例 ${s.ep.name} 未开启 performance_schema，没有语句摘要可读`, {
      hint: '在 my.cnf 中设置 performance_schema=ON 并重启实例（静态参数）；这不代表“没有慢语句”',
    });
  }
  const c = await s.query(`SELECT NAME, ENABLED FROM performance_schema.setup_consumers WHERE NAME IN ('statements_digest', 'global_instrumentation', 'thread_instrumentation')`);
  const off = c.filter((r) => r.ENABLED !== 'YES').map((r) => String(r.NAME));
  if (off.length) {
    throw new WorkError('COLLECTION_DISABLED', `performance_schema consumer 未启用: ${off.join(', ')}`, {
      hint: "UPDATE performance_schema.setup_consumers SET ENABLED='YES' WHERE NAME IN (...)（需要 DBA 权限）",
    });
  }
  const [cnt] = await s.query('SELECT COUNT(*) AS n FROM performance_schema.events_statements_summary_by_digest');
  return { digests_size: num(v.performance_schema_digests_size), max_digest_length: num(v.max_digest_length), rows: num(cnt?.n) };
}

function capacityNote(info: { digests_size: number | null; rows: number | null }): string {
  const full = info.digests_size !== null && info.rows !== null && info.digests_size > 0 && info.rows >= info.digests_size;
  return `摘要表占用 ${info.rows ?? 'unknown'}/${info.digests_size ?? 'unknown'} 行（performance_schema_digests_size）${full ? '：已满，新语句归入 DIGEST=NULL 行，统计不完整' : '；表满后新语句归入 DIGEST=NULL 行'}`;
}

/** Our own snapshot statement shows up in the digest table; it is excluded from results. */
function isSelf(r: { digest_text: string | null }): boolean {
  return (r.digest_text ?? '').includes('events_statements_summary_by_digest');
}

const DigestStatSchema = z.object({
  schema: z.string().nullable(),
  digest: z.string().nullable(),
  digest_text: z.string().nullable().describe('归一化语句（字面量为 ?），可能被 max_digest_length 截断'),
  count: z.number(),
  total_latency_ms: z.number(),
  avg_latency_ms: z.number().nullable(),
  max_latency_ms: z.number().optional().describe('仅累计模式：自 first_seen 以来单条最大耗时'),
  rows_examined: z.number(),
  rows_sent: z.number(),
  rows_affected: z.number(),
  avg_rows_examined: z.number().nullable(),
  no_index_used_count: z.number(),
  no_good_index_used_count: z.number(),
  errors: z.number(),
  first_seen: z.string().nullable(),
  last_seen: z.string().nullable(),
  reset_detected: z.boolean().optional(),
});

export const statementSummary = defineCapability({
  name: 'mysql.statement.summary',
  command: 'mysql statement summary',
  summary: '按语句摘要统计窗口内的执行次数、耗时、扫描行数和未用索引次数（performance_schema 两次快照差分）',
  domain: 'mysql',
  inputs: {
    instance: INSTANCE,
    sample_window: { type: 'string', default: '10s', description: '采样窗口，如 5s、30s；0 表示返回累计值（不是窗口值）。窗口须小于 --timeout' },
    top: { type: 'int', default: 10, description: '按总耗时取前 N 个摘要' },
    database: { type: 'string', description: '只看该默认库（SCHEMA_NAME）下的语句' },
  },
  output: z.object({
    instance: z.string(),
    aggregation: z.enum(['window_delta', 'cumulative_since']),
    window: z.object({ start: z.string(), end: z.string(), duration_ms: z.number() }).nullable(),
    cumulative_since: z
      .object({ server_started_at: z.string().nullable(), earliest_first_seen: z.string().nullable() })
      .nullable()
      .describe('累计模式下的统计起点：服务启动或摘要表重置；每行另有 first_seen'),
    database: z.string().nullable(),
    top: z.number(),
    digests: z.array(DigestStatSchema),
    totals: z.object({ digests_with_activity: z.number(), statements: z.number(), total_latency_ms: z.number() }),
    excluded_self_digests: z.number().describe('已排除的采样语句摘要数（查询 events_statements_summary_by_digest 的语句，含 workctl 自身）'),
  }),
  adapter: ADAPTER,
  operation: 'diagnose',
  auth_provider: AUTH_PROVIDER,
  guide: GUIDE,
  prerequisites: [...COMMON_PREREQS, 'performance_schema=ON 且 statements_digest consumer 启用'],
  notes: [
    '窗口值 = t1 快照 − t0 快照（按 SCHEMA_NAME + DIGEST）；采样期间命令会等待整个窗口，窗口须小于 --timeout（默认 30s）',
    '--sample-window 0 返回自服务启动/摘要表重置（或该摘要首次出现）以来的累计值，aggregation=cumulative_since，不能当作窗口值',
    '摘要表满（performance_schema_digests_size）或被 TRUNCATE 时结果标记为 partial；计数回退的摘要只计入重置后的部分',
    '耗时单位为毫秒（由皮秒换算）；no_index_used_count 是未使用索引（全表扫描）的执行次数',
  ],
  examples: [
    'workctl mysql statement summary --instance demo-mysql --sample-window 5s --top 10',
    'workctl --timeout 60s mysql statement summary --instance demo-mysql --sample-window 30s --database demo',
    'workctl mysql statement summary --instance demo-mysql --sample-window 0',
  ],
  handler: async (ctx, i) => {
    const windowMs = parseWindow(i.sample_window);
    const top = Math.max(1, Math.min(Number(i.top), 100));
    // refuse before connecting when the window cannot fit in the time budget
    if (windowMs > 0 && windowMs + 3000 > ctx.remainingMs()) {
      throw new WorkError('INVALID_ARGUMENT', `采样窗口 ${formatDuration(windowMs)} 超过剩余时间预算 ${Math.floor(ctx.remainingMs() / 1000)}s`, {
        hint: `增大 --timeout（如 --timeout ${Math.ceil((windowMs + 10_000) / 1000)}s）或缩小 --sample-window`,
      });
    }
    return withMysql(ctx, i.instance, async (s) => {
      const info = await assertDigestCollection(s);
      const notes: string[] = [];
      if (info.max_digest_length !== null) notes.push(`digest_text 最长 ${info.max_digest_length} 字节（max_digest_length），超出部分被截断`);

      if (windowMs === 0) {
        const st = await globalStatus(s, ['Uptime']);
        const all = await snapshot(s, i.database);
        const rows = all.filter((r) => !isSelf(r));
        const stats: DigestStat[] = rows
          .map((r) => ({ ...statFromRow(r), max_latency_ms: psToMs(big(r.max_timer_wait)) }))
          .filter((x) => x.count > 0)
          .sort((a, b) => b.total_latency_ms - a.total_latency_ms);
        const uptime = num(st.Uptime);
        const firstSeen = rows.map((r) => isoFromMysql(r.first_seen)).filter((x): x is string => !!x).sort()[0] ?? null;
        return {
          data: {
            instance: s.ep.name,
            aggregation: 'cumulative_since' as const,
            window: null,
            cumulative_since: { server_started_at: uptime !== null ? new Date(Date.now() - uptime * 1000).toISOString() : null, earliest_first_seen: firstSeen },
            database: i.database ?? null,
            top,
            digests: stats.slice(0, top).map(isoRow),
            totals: totals(stats),
            excluded_self_digests: all.length - rows.length,
          },
          sources: [s.src('performance_schema.events_statements_summary_by_digest (cumulative)')],
          coverage: {
            complete: true,
            limit: top,
            truncated: stats.length > top,
            notes: [
              '累计值：自服务启动、摘要表重置或该摘要首次出现（first_seen）以来，不是窗口值',
              ...notes,
              capacityNote(info),
            ],
          },
        };
      }

      const lost0 = await globalStatus(s, ['Performance_schema_digest_lost']);
      const t0 = await snapshot(s, i.database);
      const start = new Date();
      await sleep(windowMs, ctx.signal);
      const t1 = await snapshot(s, i.database);
      const end = new Date();
      const lost1 = await globalStatus(s, ['Performance_schema_digest_lost']);
      const diff = diffDigests(t0, t1, start.toISOString());
      const stats = diff.stats.filter((r) => !isSelf(r));
      const excluded = diff.stats.length - stats.length;
      const lostDelta = Number(big(lost1.Performance_schema_digest_lost) - big(lost0.Performance_schema_digest_lost));
      const partialReasons: string[] = [];
      if (diff.disappeared) partialReasons.push(`${diff.disappeared} 个摘要在窗口内从表中消失（摘要表被 TRUNCATE 或重置），其窗口内活动未计入`);
      if (diff.reset) partialReasons.push(`${diff.reset} 个摘要计数回退（表被重置），只计入重置后的部分（reset_detected=true）`);
      if (diff.reappeared) partialReasons.push(`${diff.reappeared} 个摘要在 t0 不存在但 first_seen 早于窗口开始，取其全部计数（reset_detected=true，可能偏大）`);
      if (lostDelta > 0) partialReasons.push(`窗口内 ${lostDelta} 条语句因摘要表已满未能归档（Performance_schema_digest_lost 增加）`);
      if (diff.null_digest_count > 0) partialReasons.push(`${diff.null_digest_count} 次执行被归入 DIGEST=NULL 行（摘要表已满）`);
      return {
        status: partialReasons.length ? 'partial' : 'success',
        data: {
          instance: s.ep.name,
          aggregation: 'window_delta' as const,
          window: { start: start.toISOString(), end: end.toISOString(), duration_ms: end.getTime() - start.getTime() },
          cumulative_since: null,
          database: i.database ?? null,
          top,
          digests: stats.slice(0, top).map(isoRow),
          totals: totals(stats),
          excluded_self_digests: excluded,
        },
        sources: [s.src('performance_schema.events_statements_summary_by_digest (t1 − t0)', 'derived')],
        coverage: {
          complete: partialReasons.length === 0,
          limit: top,
          truncated: stats.length > top,
          window: { start: start.toISOString(), end: end.toISOString() },
          notes: [
            ...partialReasons,
            ...notes,
            capacityNote(info),
            '已排除查询 events_statements_summary_by_digest 的语句（含 workctl 自身采样）；窗口内没有执行的摘要不出现',
          ],
        },
      };
    });
  },
});

/** `0` (or 0s/0ms) means cumulative; otherwise a duration such as 5s / 30s / 2m. */
export function parseWindow(v: unknown): number {
  const t = String(v ?? '').trim();
  if (/^0+(ms|s|m)?$/.test(t)) return 0;
  return parseDuration(t);
}

function isoRow(r: DigestStat): DigestStat {
  return { ...r, first_seen: isoFromMysql(r.first_seen), last_seen: isoFromMysql(r.last_seen) };
}

function totals(stats: DigestStat[]) {
  return {
    digests_with_activity: stats.length,
    statements: stats.reduce((a, b) => a + b.count, 0),
    total_latency_ms: Math.round(stats.reduce((a, b) => a + b.total_latency_ms, 0) * 1000) / 1000,
  };
}

// ------------------------------------------------------------------ slow log

export const slowlogList = defineCapability({
  name: 'mysql.slowlog.list',
  command: 'mysql slowlog list',
  summary: '读取慢查询日志（mysql.slow_log 表），区分“未开启/不可读”与“窗口内没有慢查询”',
  domain: 'mysql',
  inputs: {
    instance: INSTANCE,
    since: { type: 'duration', default: '1h', description: '时间范围（从现在往前）' },
    limit: { type: 'int', default: 20, description: '最多返回条数（按开始时间倒序）' },
  },
  output: z.object({
    instance: z.string(),
    config: z.object({ slow_query_log: z.boolean(), log_output: z.string(), long_query_time_s: z.number().nullable(), log_queries_not_using_indexes: z.boolean() }),
    entries: z.array(
      z.object({
        start_time: z.string().nullable(),
        query_time_ms: z.number().nullable(),
        lock_time_ms: z.number().nullable(),
        rows_sent: z.number().nullable(),
        rows_examined: z.number().nullable(),
        db: z.string().nullable(),
        user_host: z.string().nullable(),
        thread_id: z.number().nullable(),
        sql_text: z.string().nullable().describe('字面量已替换为 ?，截断至 512 字符'),
        sql_truncated: z.boolean(),
      }),
    ),
  }),
  adapter: ADAPTER,
  operation: 'read',
  auth_provider: AUTH_PROVIDER,
  guide: GUIDE,
  prerequisites: [...COMMON_PREREQS, 'slow_query_log=ON 且 log_output 含 TABLE；账号有 SELECT on mysql.slow_log'],
  notes: [
    'slow_query_log=OFF 或 log_output 不含 TABLE 时返回 COLLECTION_DISABLED（不是“没有慢查询”）',
    '只记录超过 long_query_time 的语句（及开启 log_queries_not_using_indexes 时未用索引的语句）；query_time 含锁等待时间',
    'SQL 文本中的字面量替换为 ?，避免输出敏感值',
  ],
  examples: ['workctl mysql slowlog list --instance demo-mysql --since 1h --limit 20'],
  handler: async (ctx, i) =>
    withMysql(ctx, i.instance, async (s) => {
      const v = await globalVariables(s, ['slow_query_log', 'log_output', 'long_query_time', 'log_queries_not_using_indexes']);
      const config = {
        slow_query_log: v.slow_query_log === 'ON',
        log_output: v.log_output ?? 'unknown',
        long_query_time_s: num(v.long_query_time),
        log_queries_not_using_indexes: v.log_queries_not_using_indexes === 'ON',
      };
      if (!config.slow_query_log) {
        throw new WorkError('COLLECTION_DISABLED', `实例 ${s.ep.name} 未开启慢查询日志 (slow_query_log=OFF)`, {
          hint: 'SET GLOBAL slow_query_log=ON 并设置 log_output 含 TABLE（需 DBA 权限）；未开启时无法判断是否存在慢查询，可改用 mysql statement summary',
          details: config,
        });
      }
      if (!config.log_output.toUpperCase().includes('TABLE')) {
        throw new WorkError('COLLECTION_DISABLED', `慢查询日志只写文件 (log_output=${config.log_output})，无法通过 SQL 读取`, {
          hint: 'SET GLOBAL log_output=\'FILE,TABLE\'，或由主机侧采集慢日志文件；也可改用 mysql statement summary',
          details: config,
        });
      }
      const sinceMs = Number(i.since);
      const limit = Math.max(1, Math.min(Number(i.limit), 500));
      const rows = await s.query(
        `SELECT start_time, user_host, db, thread_id, rows_sent, rows_examined,
                HOUR(query_time) * 3600000 + MINUTE(query_time) * 60000 + SECOND(query_time) * 1000 + MICROSECOND(query_time) / 1000 AS query_time_ms,
                HOUR(lock_time) * 3600000 + MINUTE(lock_time) * 60000 + SECOND(lock_time) * 1000 + MICROSECOND(lock_time) / 1000 AS lock_time_ms,
                LEFT(CONVERT(sql_text USING utf8mb4), 4096) AS sql_text
           FROM mysql.slow_log
          WHERE start_time >= NOW(6) - INTERVAL ? MICROSECOND
          ORDER BY start_time DESC
          LIMIT ?`,
        [sinceMs * 1000, limit + 1],
      );
      const truncated = rows.length > limit;
      const end = new Date();
      const start = new Date(end.getTime() - sinceMs);
      const entries = rows.slice(0, limit).map((r) => {
        const q = truncate(r.sql_text === null ? null : maskLiterals(String(r.sql_text)), 512);
        return {
          start_time: isoFromMysql(r.start_time),
          query_time_ms: num(r.query_time_ms),
          lock_time_ms: num(r.lock_time_ms),
          rows_sent: num(r.rows_sent),
          rows_examined: num(r.rows_examined),
          db: r.db || null,
          user_host: r.user_host ?? null,
          thread_id: num(r.thread_id),
          sql_text: q.text,
          sql_truncated: q.truncated,
        };
      });
      return {
        data: { instance: s.ep.name, config, entries },
        sources: [s.src('mysql.slow_log')],
        coverage: {
          complete: !truncated,
          truncated,
          limit,
          window: { start: start.toISOString(), end: end.toISOString() },
          notes: [
            ...(entries.length ? [] : [`窗口内没有超过 long_query_time=${config.long_query_time_s}s 的语句（慢日志已开启且可读）`]),
            ...(truncated ? [`窗口内超过 ${limit} 条，只返回最近 ${limit} 条`] : []),
            '时间为 UTC；SQL 字面量已替换为 ?',
          ],
        },
      };
    }),
});
