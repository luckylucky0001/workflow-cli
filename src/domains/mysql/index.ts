import { defineDomain } from '../../core/registry';
import { GUIDE, mapMysqlError, withMysql } from './client';
import { lockList, sessionList } from './capabilities/activity';
import { indexCreatePlanner, indexPlan } from './capabilities/index-plan';
import { indexList, instanceGet, tableGet } from './capabilities/inventory';
import { queryAnalyze, queryExecute, queryExplain } from './capabilities/query';
import { slowlogList, statementSummary } from './capabilities/statements';

/**
 * MySQL domain (adapter mysql-driver / mysql2). Read-only diagnostics through a dedicated
 * read-only account; DDL is plan-only (no executor). See docs/guides/mysql.md.
 */
export default defineDomain({
  name: 'mysql',
  title: 'MySQL',
  summary: 'MySQL 实例、表结构、会话与锁、语句摘要、慢日志、执行计划、受限查询与索引变更计划',
  pillar: 'middleware',
  guide: GUIDE,
  skill: 'skills/mysql-operations/SKILL.md',
  capabilities: [
    instanceGet,
    tableGet,
    indexList,
    sessionList,
    lockList,
    statementSummary,
    slowlogList,
    queryExplain,
    queryAnalyze,
    queryExecute,
    indexPlan,
  ],
  planners: [indexCreatePlanner],
  probes: {
    mysql: async (ctx, name) =>
      withMysql(ctx, name, async (s) => {
        const grants = await s.query('SHOW GRANTS');
        return {
          ok: true,
          identity: s.user,
          version: s.version,
          privileges: grants.map((g) => String(Object.values(g)[0])),
        };
      }),
  },
  mapError: (e) => mapMysqlError(e),
});
