import { z } from 'zod';
import { defineCapability } from '../../../core/registry';
import { ADAPTER, AUTH_PROVIDER, GUIDE, isoFromPg, num, statsVisibility, withPg } from '../client';
import { COMMON_PREREQS, INSTANCE } from '../inputs';
import { displaySql } from '../sql-guard';

const HIDDEN = '<insufficient privilege>';

function queryText(v: unknown): { text: string | null; truncated: boolean; hidden: boolean } {
  if (v === HIDDEN) return { text: null, truncated: false, hidden: true };
  return { ...displaySql(v === '' ? null : v), hidden: false };
}

const SessionSchema = z.object({
  pid: z.number(),
  user: z.string().nullable(),
  database: z.string().nullable(),
  application_name: z.string().nullable(),
  client_addr: z.string().nullable(),
  backend_type: z.string().nullable(),
  state: z.string().nullable().describe('active / idle / idle in transaction / idle in transaction (aborted) / fastpath function call / disabled'),
  wait_event_type: z.string().nullable(),
  wait_event: z.string().nullable(),
  backend_start: z.string().nullable(),
  xact_start: z.string().nullable(),
  xact_age_s: z.number().nullable().describe('当前事务已持续秒数'),
  query_start: z.string().nullable(),
  query_age_s: z.number().nullable().describe('active：当前语句已执行秒数；其它状态：最后一条语句开始至今'),
  state_age_s: z.number().nullable().describe('处于当前 state 的秒数（idle in transaction 的空闲时长）'),
  blocked_by: z.array(z.number()).describe('pg_blocking_pids()：阻塞该会话的 pid'),
  query: z.string().nullable().describe('当前/最后一条语句，字面量替换为 ?，截断至 512 字符；无权限查看时为 null'),
  query_truncated: z.boolean(),
  query_hidden: z.boolean().describe('pg_stat_activity 对当前角色隐藏了该会话详情（<insufficient privilege>）'),
});

export const sessionList = defineCapability({
  name: 'postgres.session.list',
  command: 'pg session list',
  summary: '列出当前会话（pg_stat_activity）：状态、等待事件、事务/语句时长、阻塞方，默认只含非 idle 的客户端会话',
  domain: 'postgres',
  inputs: {
    instance: INSTANCE,
    include_idle: { type: 'bool', default: false, description: '包含 state=idle 的会话' },
    include_background: { type: 'bool', default: false, description: '包含后台进程（autovacuum、walwriter、checkpointer 等）' },
  },
  output: z.object({
    instance: z.string(),
    sessions: z.array(SessionSchema),
    summary: z.object({
      total_visible: z.number(),
      returned: z.number(),
      active: z.number(),
      idle_in_transaction: z.number().describe('idle in transaction（含 aborted）：持有事务与锁却不执行语句，常见锁源'),
      waiting_on_lock: z.number().describe('wait_event_type=Lock 的会话'),
      blocked: z.number().describe('pg_blocking_pids 非空的会话'),
      oldest_xact_age_s: z.number().nullable(),
      hidden_details: z.number().describe('详情被隐藏的会话数（缺 pg_read_all_stats）'),
    }),
  }),
  adapter: ADAPTER,
  operation: 'read',
  auth_provider: AUTH_PROVIDER,
  guide: GUIDE,
  prerequisites: [...COMMON_PREREQS, '没有 pg_read_all_stats 时其他角色会话的语句、等待事件等字段被隐藏（结果标记为 partial）'],
  notes: [
    '瞬时快照：会话状态在毫秒级变化，不代表一段时间内的情况',
    '语句文本中的字面量替换为 ?（避免输出敏感值）并截断到 512 字符；原文本身受 track_activity_query_size 截断',
    '已排除 workctl 自身的连接（pg_backend_pid()）',
  ],
  examples: ['workctl pg session list --instance demo-postgres', 'workctl pg session list --instance demo-postgres --include-idle'],
  handler: async (ctx, i) =>
    withPg(ctx, i.instance, async (s) => {
      const vis = await statsVisibility(s);
      const rows = await s.query(
        `SELECT pid, usename, datname, application_name, host(client_addr) AS client_addr, backend_type, state, wait_event_type, wait_event,
                backend_start, xact_start, query_start,
                EXTRACT(EPOCH FROM (clock_timestamp() - xact_start)) AS xact_age_s,
                EXTRACT(EPOCH FROM (clock_timestamp() - query_start)) AS query_age_s,
                EXTRACT(EPOCH FROM (clock_timestamp() - state_change)) AS state_age_s,
                pg_blocking_pids(pid) AS blocked_by, query
           FROM pg_stat_activity
          WHERE pid <> pg_backend_pid()
          ORDER BY xact_start NULLS LAST, query_start NULLS LAST`,
      );
      const round = (v: unknown) => {
        const n = num(v);
        return n === null ? null : Math.round(n * 1000) / 1000;
      };
      const all = rows.map((r) => {
        const q = queryText(r.query);
        return {
          pid: Number(r.pid),
          user: r.usename ?? null,
          database: r.datname ?? null,
          application_name: r.application_name || null,
          client_addr: r.client_addr ?? null,
          backend_type: r.backend_type ?? null,
          state: r.state ?? null,
          wait_event_type: r.wait_event_type ?? null,
          wait_event: r.wait_event ?? null,
          backend_start: isoFromPg(r.backend_start),
          xact_start: isoFromPg(r.xact_start),
          xact_age_s: round(r.xact_age_s),
          query_start: isoFromPg(r.query_start),
          query_age_s: round(r.query_age_s),
          state_age_s: round(r.state_age_s),
          blocked_by: Array.isArray(r.blocked_by) ? r.blocked_by.map(Number) : [],
          query: q.text,
          query_truncated: q.truncated,
          query_hidden: q.hidden,
        };
      });
      const client = (x: (typeof all)[number]) => x.backend_type === 'client backend' || x.backend_type === null;
      const sessions = all.filter((x) => (i.include_background || client(x)) && (i.include_idle || x.state !== 'idle' || x.blocked_by.length > 0));
      const clients = all.filter(client);
      const ages = clients.map((x) => x.xact_age_s).filter((x): x is number => typeof x === 'number');
      const hidden = all.filter((x) => x.query_hidden).length;
      const partial = !vis.all && hidden > 0;
      return {
        status: partial ? 'partial' : 'success',
        data: {
          instance: s.ep.name,
          sessions,
          summary: {
            total_visible: all.length,
            returned: sessions.length,
            active: clients.filter((x) => x.state === 'active').length,
            idle_in_transaction: clients.filter((x) => (x.state ?? '').startsWith('idle in transaction')).length,
            waiting_on_lock: clients.filter((x) => x.wait_event_type === 'Lock').length,
            blocked: clients.filter((x) => x.blocked_by.length > 0).length,
            oldest_xact_age_s: ages.length ? Math.max(...ages) : null,
            hidden_details: hidden,
          },
        },
        sources: [s.src('pg_stat_activity + pg_blocking_pids()')],
        coverage: {
          complete: !partial,
          scope: `${i.include_background ? 'all backends' : 'client backends'}${i.include_idle ? '' : ', excluding idle (unless blocked)'}`,
          notes: [
            ...(partial ? [`角色 ${s.user} 没有 pg_read_all_stats：${hidden} 个会话的语句/等待事件被隐藏`] : []),
            '瞬时快照；语句字面量已替换为 ?，截断至 512 字符；已排除 workctl 自身连接',
          ],
        },
      };
    }),
});

const LockedObjectSchema = z.object({
  locktype: z.string(),
  mode: z.string().describe('请求的锁模式，如 ShareLock、RowExclusiveLock、AccessExclusiveLock'),
  relation: z.string().nullable().describe('关系名（仅当前连接库内可解析；其它库显示 OID）'),
  transactionid: z.string().nullable().describe('locktype=transactionid 时等待的事务 ID（典型的行锁等待）'),
});

const BlockerSchema = z.object({
  pid: z.number(),
  user: z.string().nullable(),
  database: z.string().nullable(),
  state: z.string().nullable(),
  xact_age_s: z.number().nullable(),
  state_age_s: z.number().nullable(),
  wait_event_type: z.string().nullable(),
  query: z.string().nullable().describe('阻塞方当前/最后一条语句（不一定是持锁语句）；idle in transaction 时为最后执行的语句'),
  is_root: z.boolean().describe('自身不在等待中的阻塞方（链条源头）'),
});

export const lockList = defineCapability({
  name: 'postgres.lock.list',
  command: 'pg lock list',
  summary: '列出锁等待与阻塞链：谁在等（等什么锁）、被谁阻塞（pg_blocking_pids），以及链条源头',
  domain: 'postgres',
  inputs: { instance: INSTANCE },
  output: z.object({
    instance: z.string(),
    waits: z.array(
      z.object({
        pid: z.number(),
        user: z.string().nullable(),
        database: z.string().nullable(),
        wait_event_type: z.string().nullable(),
        wait_event: z.string().nullable(),
        wait_age_s: z.number().nullable().describe('处于当前等待状态的秒数（state_change 起）'),
        xact_age_s: z.number().nullable(),
        query: z.string().nullable(),
        waiting_for: z.array(LockedObjectSchema).describe('pg_locks 中该 pid 未授予（granted=false）的锁'),
        blocked_by: z.array(z.number()),
      }),
    ),
    blockers: z.array(BlockerSchema),
    summary: z.object({ waiting: z.number(), blockers: z.number(), root_blockers: z.array(z.number()), max_chain_depth: z.number() }),
  }),
  adapter: ADAPTER,
  operation: 'read',
  auth_provider: AUTH_PROVIDER,
  guide: GUIDE,
  prerequisites: [...COMMON_PREREQS, 'pg_locks 对所有角色可见；阻塞方语句需 pg_read_all_stats'],
  notes: [
    '没有锁等待时返回空列表（success），不是错误',
    '阻塞方 query 是其当前/最后一条语句，不一定是持锁语句；idle in transaction 的阻塞方需要应用提交/回滚或由 DBA 处理',
    '瞬时快照；锁等待可能在毫秒内结束。行锁等待在 pg_locks 中表现为 transactionid 锁（等待持锁事务结束）',
  ],
  examples: ['workctl pg lock list --instance demo-postgres'],
  handler: async (ctx, i) =>
    withPg(ctx, i.instance, async (s) => {
      const vis = await statsVisibility(s);
      const waiting = await s.query(
        `SELECT a.pid, a.usename, a.datname, a.wait_event_type, a.wait_event,
                EXTRACT(EPOCH FROM (clock_timestamp() - a.state_change)) AS wait_age_s,
                EXTRACT(EPOCH FROM (clock_timestamp() - a.xact_start)) AS xact_age_s,
                a.query, pg_blocking_pids(a.pid) AS blocked_by
           FROM pg_stat_activity a
          WHERE a.pid <> pg_backend_pid() AND cardinality(pg_blocking_pids(a.pid)) > 0
          ORDER BY a.state_change`,
      );
      const waitPids = waiting.map((r) => Number(r.pid));
      const locks = waitPids.length
        ? await s.query(
            `SELECT l.pid, l.locktype, l.mode, l.transactionid::text AS transactionid,
                    CASE WHEN l.relation IS NULL THEN NULL
                         WHEN l.database = (SELECT oid FROM pg_database WHERE datname = current_database()) THEN l.relation::regclass::text
                         ELSE l.relation::text END AS relation
               FROM pg_locks l WHERE NOT l.granted AND l.pid = ANY($1::int[])`,
            [waitPids],
          )
        : [];
      const blockerPids = [...new Set(waiting.flatMap((r) => (r.blocked_by as number[]).map(Number)))];
      const blockerRows = blockerPids.length
        ? await s.query(
            `SELECT pid, usename, datname, state, wait_event_type, query,
                    EXTRACT(EPOCH FROM (clock_timestamp() - xact_start)) AS xact_age_s,
                    EXTRACT(EPOCH FROM (clock_timestamp() - state_change)) AS state_age_s
               FROM pg_stat_activity WHERE pid = ANY($1::int[])`,
            [blockerPids],
          )
        : [];
      const round = (v: unknown) => {
        const n = num(v);
        return n === null ? null : Math.round(n * 1000) / 1000;
      };
      const waitSet = new Set(waitPids);
      const waits = waiting.map((r) => ({
        pid: Number(r.pid),
        user: r.usename ?? null,
        database: r.datname ?? null,
        wait_event_type: r.wait_event_type ?? null,
        wait_event: r.wait_event ?? null,
        wait_age_s: round(r.wait_age_s),
        xact_age_s: round(r.xact_age_s),
        query: queryText(r.query).text,
        waiting_for: locks
          .filter((l) => Number(l.pid) === Number(r.pid))
          .map((l) => ({ locktype: String(l.locktype), mode: String(l.mode), relation: l.relation ?? null, transactionid: l.transactionid ?? null })),
        blocked_by: (r.blocked_by as number[]).map(Number),
      }));
      const blockers = blockerPids.map((pid) => {
        const b = blockerRows.find((x) => Number(x.pid) === pid);
        return {
          pid,
          user: b?.usename ?? null,
          database: b?.datname ?? null,
          state: b?.state ?? null,
          xact_age_s: round(b?.xact_age_s),
          state_age_s: round(b?.state_age_s),
          wait_event_type: b?.wait_event_type ?? null,
          query: queryText(b?.query).text,
          is_root: !waitSet.has(pid),
        };
      });
      // chain depth: longest path waiting → blocker → ... (cycle-safe)
      const edges = new Map(waits.map((w) => [w.pid, w.blocked_by]));
      const depth = (pid: number, seen: Set<number>): number => {
        const next = edges.get(pid);
        if (!next || seen.has(pid)) return 0;
        seen.add(pid);
        return 1 + Math.max(0, ...next.map((p) => depth(p, new Set(seen))));
      };
      const hiddenBlockers = blockerRows.filter((b) => b.query === HIDDEN).length;
      return {
        status: !vis.all && hiddenBlockers > 0 ? 'partial' : 'success',
        data: {
          instance: s.ep.name,
          waits,
          blockers,
          summary: {
            waiting: waits.length,
            blockers: blockers.length,
            root_blockers: blockers.filter((b) => b.is_root).map((b) => b.pid),
            max_chain_depth: waits.length ? Math.max(...waits.map((w) => depth(w.pid, new Set()))) : 0,
          },
        },
        sources: [s.src('pg_stat_activity + pg_blocking_pids() + pg_locks (granted=false)')],
        coverage: {
          complete: vis.all || hiddenBlockers === 0,
          notes: [
            ...(waits.length ? [] : ['当前没有被阻塞的会话']),
            ...(!vis.all && hiddenBlockers ? [`角色 ${s.user} 没有 pg_read_all_stats：${hiddenBlockers} 个阻塞方的语句不可见`] : []),
            '瞬时快照；语句字面量已替换为 ?',
          ],
        },
      };
    }),
});
