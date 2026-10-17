import { defineCapability, defineDomain } from '../../core/registry';
import { ADAPTER, AUTH_PROVIDER, ENDPOINT_KIND, GUIDE, isDbError, mapPgError, withPg } from './client';
import { lockList, sessionList } from './capabilities/activity';
import { databaseList, instanceGet, tableGet } from './capabilities/inventory';
import { queryAnalyze, queryExplain, queryRun } from './capabilities/query';
import { statementSummary } from './capabilities/statements';

/** In the catalog but not callable yet (no handler → status planned). */
const planned = (name: string, command: string, summary: string, operation: 'read' | 'diagnose' | 'plan' = 'read') =>
  defineCapability({ name, command, summary, domain: 'postgres', adapter: ADAPTER, operation, auth_provider: AUTH_PROVIDER, guide: GUIDE, status: 'planned' });

/**
 * PostgreSQL domain (adapter pg-driver / node-postgres). Read-only diagnostics through a
 * dedicated read-only role; no writes, no DDL executor. See docs/guides/postgres.md.
 */
export default defineDomain({
  name: 'postgres',
  title: 'PostgreSQL',
  summary: 'PostgreSQL 实例、数据库、表结构与统计、会话与锁等待、语句统计（pg_stat_statements）、执行计划与受限只读查询',
  pillar: 'middleware',
  guide: GUIDE,
  skill: 'skills/postgres-operations/SKILL.md',
  capabilities: [
    instanceGet,
    databaseList,
    tableGet,
    sessionList,
    lockList,
    statementSummary,
    queryExplain,
    queryAnalyze,
    queryRun,
    planned('postgres.replication.get', 'pg replication get', '查看流复制状态与延迟（pg_stat_replication 的 write/flush/replay lag、复制槽保留的 WAL；需 pg_read_all_stats / pg_monitor）'),
    planned('postgres.vacuum.plan', 'pg vacuum plan', '根据死元组比例、事务 ID 年龄与最近 autovacuum 生成 VACUUM / ANALYZE 变更计划（只生成计划，不执行）', 'plan'),
    planned('postgres.index.plan', 'pg index plan', '为指定表/列生成 CREATE INDEX CONCURRENTLY 变更计划并附 EXPLAIN 前后对比（只生成计划，不执行）', 'plan'),
  ],
  probes: {
    [ENDPOINT_KIND]: async (ctx, name) =>
      withPg(ctx, name, async (s) => {
        const rows = await s.query(
          `SELECT r.rolsuper, r.rolcanlogin,
                  (SELECT coalesce(array_agg(b.rolname::text ORDER BY b.rolname), '{}'::text[]) FROM pg_auth_members m JOIN pg_roles b ON b.oid = m.roleid WHERE m.member = r.oid) AS member_of,
                  coalesce(current_setting('default_transaction_read_only', true), 'off') AS ro
             FROM pg_roles r WHERE r.rolname = current_user`,
        );
        const r = rows[0] ?? {};
        return {
          ok: true,
          identity: s.user,
          version: s.version,
          privileges: [
            ...(r.rolsuper ? ['SUPERUSER'] : []),
            ...((r.member_of as string[] | undefined) ?? []).map((x) => `MEMBER OF ${x}`),
            `default_transaction_read_only=${r.ro}`,
            `database=${s.database}`,
          ],
        };
      }),
  },
  // domain-wide fallback: only server-side PostgreSQL errors; network/driver errors are mapped inside withPg
  // with their endpoint, so a refused connection elsewhere is never reported as "PostgreSQL 不可达"
  mapError: (e) => (isDbError(e) ? mapPgError(e) : undefined),
});
