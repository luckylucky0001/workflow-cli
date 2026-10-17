import { z } from 'zod';
import { defineCapability } from '../../../core/registry';
import { ADAPTER, AUTH_PROVIDER, GUIDE, isoFromMysql, num, withMysql, type MysqlSession } from '../client';
import { INSTANCE, COMMON_PREREQS } from '../inputs';
import { maskLiterals, truncate } from '../sql-guard';

const SQL_TEXT_MAX = 512;

function sqlText(v: unknown): { text: string | null; truncated: boolean } {
  if (v === null || v === undefined) return { text: null, truncated: false };
  return truncate(maskLiterals(Buffer.isBuffer(v) ? v.toString('utf8') : String(v)), SQL_TEXT_MAX);
}

async function hasPrivilege(s: MysqlSession, priv: string): Promise<boolean> {
  const rows = await s.query(`SELECT COUNT(*) AS n FROM information_schema.USER_PRIVILEGES WHERE PRIVILEGE_TYPE IN (?, 'SUPER')`, [priv]);
  return Number(rows[0]?.n ?? 0) > 0;
}

const SessionSchema = z.object({
  id: z.number(),
  user: z.string().nullable(),
  host: z.string().nullable(),
  db: z.string().nullable(),
  command: z.string().nullable(),
  time_s: z.number().nullable().describe('当前状态持续秒数'),
  state: z.string().nullable(),
  sql_text: z.string().nullable().describe('当前语句，字面量已替换为 ?，截断至 512 字符'),
  sql_truncated: z.boolean(),
  trx: z
    .object({
      id: z.string(),
      state: z.string(),
      started_at: z.string().nullable(),
      age_s: z.number().nullable(),
      isolation_level: z.string().nullable(),
      rows_locked: z.number().nullable(),
      rows_modified: z.number().nullable(),
      wait_started_at: z.string().nullable(),
    })
    .nullable(),
});

export const sessionList = defineCapability({
  name: 'mysql.session.list',
  command: 'mysql session list',
  summary: '列出当前会话与事务（processlist + INNODB_TRX），默认只含活跃会话或持有事务的会话',
  domain: 'mysql',
  inputs: {
    instance: INSTANCE,
    include_idle: { type: 'bool', default: false, description: '包含空闲 (Sleep) 且无事务的会话' },
  },
  output: z.object({
    instance: z.string(),
    sessions: z.array(SessionSchema),
    summary: z.object({
      total_visible: z.number(),
      returned: z.number(),
      active: z.number(),
      with_open_trx: z.number(),
      idle_in_trx: z.number().describe('Sleep 但持有未提交事务的会话（常见锁源）'),
      oldest_trx_age_s: z.number().nullable(),
    }),
  }),
  adapter: ADAPTER,
  operation: 'read',
  auth_provider: AUTH_PROVIDER,
  guide: GUIDE,
  prerequisites: [...COMMON_PREREQS, '没有 PROCESS 权限时只能看到本账号的会话（结果标记为 partial）'],
  notes: [
    'SQL 文本中的字面量替换为 ?（避免输出敏感值）并截断到 512 字符',
    '这是瞬时快照：会话状态在毫秒级变化，不代表一段时间内的情况',
    '已排除 workctl 自身的连接',
  ],
  examples: ['workctl mysql session list --instance demo-mysql', 'workctl mysql session list --instance demo-mysql --include-idle'],
  handler: async (ctx, i) =>
    withMysql(ctx, i.instance, async (s) => {
      const rows = await s.query(
        `SELECT p.ID, p.USER, p.HOST, p.DB, p.COMMAND, p.TIME, p.STATE, p.INFO,
                t.trx_id, t.trx_state, t.trx_started, TIMESTAMPDIFF(SECOND, t.trx_started, NOW()) AS trx_age_s,
                t.trx_isolation_level, t.trx_rows_locked, t.trx_rows_modified, t.trx_wait_started
           FROM performance_schema.processlist p
           LEFT JOIN information_schema.INNODB_TRX t ON t.trx_mysql_thread_id = p.ID
          WHERE p.ID <> CONNECTION_ID()
          ORDER BY t.trx_started IS NULL, t.trx_started, p.TIME DESC`,
      );
      const process = await hasPrivilege(s, 'PROCESS');
      const all = rows.map((r) => {
        const q = sqlText(r.INFO);
        return {
          id: Number(r.ID),
          user: r.USER ?? null,
          host: r.HOST ?? null,
          db: r.DB ?? null,
          command: r.COMMAND ?? null,
          time_s: num(r.TIME),
          state: r.STATE || null,
          sql_text: q.text,
          sql_truncated: q.truncated,
          trx: r.trx_id
            ? {
                id: String(r.trx_id),
                state: String(r.trx_state),
                started_at: isoFromMysql(r.trx_started),
                age_s: num(r.trx_age_s),
                isolation_level: r.trx_isolation_level ?? null,
                rows_locked: num(r.trx_rows_locked),
                rows_modified: num(r.trx_rows_modified),
                wait_started_at: isoFromMysql(r.trx_wait_started),
              }
            : null,
        };
      });
      const isBackground = (x: (typeof all)[number]) => x.user === 'event_scheduler' || x.command === 'Daemon';
      const sessions = all.filter((x) => i.include_idle || (x.command !== 'Sleep' && !isBackground(x)) || x.trx !== null);
      const ages = all.map((x) => x.trx?.age_s).filter((x): x is number => typeof x === 'number');
      return {
        status: process ? 'success' : 'partial',
        data: {
          instance: s.ep.name,
          sessions,
          summary: {
            total_visible: all.length,
            returned: sessions.length,
            active: all.filter((x) => x.command !== 'Sleep' && !isBackground(x)).length,
            with_open_trx: all.filter((x) => x.trx).length,
            idle_in_trx: all.filter((x) => x.command === 'Sleep' && x.trx).length,
            oldest_trx_age_s: ages.length ? Math.max(...ages) : null,
          },
        },
        sources: [s.src('performance_schema.processlist LEFT JOIN information_schema.INNODB_TRX')],
        coverage: {
          complete: process,
          scope: i.include_idle ? 'all visible sessions' : 'active sessions + sessions with open transactions',
          notes: [
            ...(process ? [] : [`账号 ${s.user} 无 PROCESS 权限，只能看到本账号的会话`]),
            '瞬时快照；SQL 字面量已替换为 ?，截断至 512 字符；已排除 workctl 自身连接',
          ],
        },
      };
    }),
});

const LockWaitSchema = z.object({
  waiting: z.object({
    trx_id: z.string(),
    thread_id: z.number().nullable().describe('processlist ID'),
    wait_age_s: z.number().nullable(),
    trx_age_s: z.number().nullable(),
    lock_mode: z.string().nullable(),
    sql_text: z.string().nullable(),
  }),
  blocking: z.object({
    trx_id: z.string(),
    thread_id: z.number().nullable(),
    trx_state: z.string().nullable(),
    trx_age_s: z.number().nullable(),
    rows_locked: z.number().nullable(),
    lock_mode: z.string().nullable(),
    sql_text: z.string().nullable().describe('阻塞事务当前正在执行的语句；为空表示事务空闲（持锁语句已执行完）'),
  }),
  object: z.object({ schema: z.string().nullable(), table: z.string().nullable(), index: z.string().nullable(), lock_type: z.string().nullable() }),
});

const MdlWaitSchema = z.object({
  thread_id: z.number().nullable(),
  object_type: z.string(),
  schema: z.string().nullable(),
  name: z.string().nullable(),
  lock_type: z.string(),
  wait_s: z.number().nullable(),
  sql_text: z.string().nullable(),
});

export const lockList = defineCapability({
  name: 'mysql.lock.list',
  command: 'mysql lock list',
  summary: '列出 InnoDB 行锁等待（谁在等、被谁阻塞）及元数据锁等待',
  domain: 'mysql',
  inputs: { instance: INSTANCE },
  output: z.object({
    instance: z.string(),
    lock_waits: z.array(LockWaitSchema),
    metadata_lock_waits: z.array(MdlWaitSchema).nullable().describe('performance_schema.metadata_locks 中 PENDING 的等待；null 表示未能读取'),
    summary: z.object({ waiting_trx: z.number(), blocking_trx: z.number(), root_blockers: z.array(z.string()).describe('自身不在等待中的阻塞事务 ID') }),
  }),
  adapter: ADAPTER,
  operation: 'read',
  auth_provider: AUTH_PROVIDER,
  guide: GUIDE,
  prerequisites: [...COMMON_PREREQS, 'performance_schema 开启（data_locks / data_lock_waits，MySQL 8.0+）'],
  notes: [
    '没有锁等待时返回空列表（success），不是错误',
    '阻塞方 sql_text 是其当前语句，不一定是持锁语句；空闲事务持锁时为空',
    '瞬时快照；SQL 字面量已替换为 ?',
  ],
  examples: ['workctl mysql lock list --instance demo-mysql'],
  handler: async (ctx, i) =>
    withMysql(ctx, i.instance, async (s) => {
      const rows = await s.query(
        `SELECT w.REQUESTING_ENGINE_TRANSACTION_ID AS waiting_trx_id, w.BLOCKING_ENGINE_TRANSACTION_ID AS blocking_trx_id,
                rl.OBJECT_SCHEMA, rl.OBJECT_NAME, rl.INDEX_NAME, rl.LOCK_TYPE, rl.LOCK_MODE AS waiting_mode, bl.LOCK_MODE AS blocking_mode,
                rt.trx_mysql_thread_id AS waiting_pid, TIMESTAMPDIFF(SECOND, rt.trx_wait_started, NOW()) AS wait_age_s,
                TIMESTAMPDIFF(SECOND, rt.trx_started, NOW()) AS waiting_trx_age_s, rt.trx_query AS waiting_query,
                bt.trx_mysql_thread_id AS blocking_pid, bt.trx_state AS blocking_state, TIMESTAMPDIFF(SECOND, bt.trx_started, NOW()) AS blocking_trx_age_s,
                bt.trx_rows_locked AS blocking_rows_locked, bt.trx_query AS blocking_query
           FROM performance_schema.data_lock_waits w
           JOIN performance_schema.data_locks rl ON rl.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID AND rl.ENGINE = w.ENGINE
           JOIN performance_schema.data_locks bl ON bl.ENGINE_LOCK_ID = w.BLOCKING_ENGINE_LOCK_ID AND bl.ENGINE = w.ENGINE
           LEFT JOIN information_schema.INNODB_TRX rt ON rt.trx_id = w.REQUESTING_ENGINE_TRANSACTION_ID
           LEFT JOIN information_schema.INNODB_TRX bt ON bt.trx_id = w.BLOCKING_ENGINE_TRANSACTION_ID
          ORDER BY wait_age_s DESC`,
      );
      const waits = rows.map((r) => ({
        waiting: {
          trx_id: String(r.waiting_trx_id),
          thread_id: num(r.waiting_pid),
          wait_age_s: num(r.wait_age_s),
          trx_age_s: num(r.waiting_trx_age_s),
          lock_mode: r.waiting_mode ?? null,
          sql_text: sqlText(r.waiting_query).text,
        },
        blocking: {
          trx_id: String(r.blocking_trx_id),
          thread_id: num(r.blocking_pid),
          trx_state: r.blocking_state ?? null,
          trx_age_s: num(r.blocking_trx_age_s),
          rows_locked: num(r.blocking_rows_locked),
          lock_mode: r.blocking_mode ?? null,
          sql_text: sqlText(r.blocking_query).text,
        },
        object: { schema: r.OBJECT_SCHEMA ?? null, table: r.OBJECT_NAME ?? null, index: r.INDEX_NAME ?? null, lock_type: r.LOCK_TYPE ?? null },
      }));
      const sources = [s.src('performance_schema.data_lock_waits JOIN data_locks / information_schema.INNODB_TRX')];
      let mdl: z.infer<typeof MdlWaitSchema>[] | null = null;
      try {
        const m = await s.query(
          `SELECT t.PROCESSLIST_ID, ml.OBJECT_TYPE, ml.OBJECT_SCHEMA, ml.OBJECT_NAME, ml.LOCK_TYPE, t.PROCESSLIST_TIME, t.PROCESSLIST_INFO
             FROM performance_schema.metadata_locks ml
             JOIN performance_schema.threads t ON t.THREAD_ID = ml.OWNER_THREAD_ID
            WHERE ml.LOCK_STATUS = 'PENDING'`,
        );
        mdl = m.map((r) => ({
          thread_id: num(r.PROCESSLIST_ID),
          object_type: String(r.OBJECT_TYPE),
          schema: r.OBJECT_SCHEMA ?? null,
          name: r.OBJECT_NAME ?? null,
          lock_type: String(r.LOCK_TYPE),
          wait_s: num(r.PROCESSLIST_TIME),
          sql_text: sqlText(r.PROCESSLIST_INFO).text,
        }));
        sources.push(s.src('performance_schema.metadata_locks (LOCK_STATUS=PENDING)'));
      } catch (e) {
        ctx.warn(`元数据锁等待不可用: ${e instanceof Error ? e.message : String(e)}`);
      }
      const waitingIds = new Set(waits.map((w) => w.waiting.trx_id));
      const blockingIds = new Set(waits.map((w) => w.blocking.trx_id));
      return {
        data: {
          instance: s.ep.name,
          lock_waits: waits,
          metadata_lock_waits: mdl,
          summary: { waiting_trx: waitingIds.size, blocking_trx: blockingIds.size, root_blockers: [...blockingIds].filter((id) => !waitingIds.has(id)) },
        },
        sources,
        coverage: {
          complete: mdl !== null,
          notes: [
            ...(waits.length ? [] : ['当前没有 InnoDB 行锁等待']),
            ...(mdl === null ? ['元数据锁等待未能读取（见 warnings）'] : []),
            '瞬时快照；锁等待可能在毫秒内结束',
          ],
        },
      };
    }),
});
