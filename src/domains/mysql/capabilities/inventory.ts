import { z } from 'zod';
import { WorkError, type Source } from '../../../core/output';
import { defineCapability } from '../../../core/registry';
import {
  ADAPTER,
  AUTH_PROVIDER,
  GUIDE,
  assertTableAccessible,
  bindingFor,
  globalStatus,
  globalVariables,
  isoFromMysql,
  num,
  sensitiveColumns,
  withMysql,
} from '../client';
import { COMMON_PREREQS, DATABASE, INSTANCE, TABLE } from '../inputs';

const KEY_VARIABLES = [
  'performance_schema',
  'slow_query_log',
  'long_query_time',
  'log_output',
  'max_connections',
  'read_only',
  'super_read_only',
  'innodb_buffer_pool_size',
  'performance_schema_digests_size',
  'max_digest_length',
  'information_schema_stats_expiry',
  'max_execution_time',
  'transaction_isolation',
  'version_comment',
];
const KEY_STATUS = ['Uptime', 'Threads_connected', 'Threads_running', 'Questions', 'Slow_queries', 'Aborted_connects', 'Aborted_clients', 'Connections', 'Max_used_connections'];
const STATUS_SEMANTICS: Record<string, 'gauge' | 'cumulative_since_start'> = {
  Uptime: 'gauge',
  Threads_connected: 'gauge',
  Threads_running: 'gauge',
  Questions: 'cumulative_since_start',
  Slow_queries: 'cumulative_since_start',
  Aborted_connects: 'cumulative_since_start',
  Aborted_clients: 'cumulative_since_start',
  Connections: 'cumulative_since_start',
  Max_used_connections: 'cumulative_since_start',
};

const BindingSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    env: z.string().nullable(),
    owner: z.string().nullable(),
    labels: z.record(z.string(), z.string()),
    attributes: z.record(z.string(), z.unknown()),
  })
  .nullable()
  .describe('平台元数据（资源绑定文件），不是引擎查询结果');

export const instanceGet = defineCapability({
  name: 'mysql.instance.get',
  command: 'mysql instance get',
  summary: '查看 MySQL 实例概况：版本、运行时长、关键参数与状态计数，并附平台绑定元数据',
  domain: 'mysql',
  inputs: { instance: INSTANCE },
  output: z.object({
    instance: z.string(),
    binding: BindingSchema,
    engine: z.object({
      version: z.string(),
      version_comment: z.string().nullable(),
      current_user: z.string(),
      uptime_s: z.number().nullable(),
      started_at: z.string().nullable(),
      read_only: z.boolean(),
      super_read_only: z.boolean(),
    }),
    variables: z.record(z.string(), z.string()).describe('GLOBAL 变量原值'),
    status: z.record(z.string(), z.number().nullable()).describe('GLOBAL STATUS 数值'),
    status_semantics: z.record(z.string(), z.enum(['gauge', 'cumulative_since_start'])),
    observability: z.object({
      performance_schema: z.boolean(),
      slow_log: z.enum(['table', 'file_only', 'off']),
      long_query_time_s: z.number().nullable(),
    }),
  }),
  adapter: ADAPTER,
  operation: 'read',
  auth_provider: AUTH_PROVIDER,
  guide: GUIDE,
  prerequisites: COMMON_PREREQS,
  notes: [
    'binding 来自资源绑定文件（平台元数据，relation=explicit），engine/variables/status 来自引擎实时查询，两者分开标注',
    'Questions、Slow_queries、Aborted_connects 等是自启动以来的累计值，不是窗口值；窗口速率用 mysql statement summary',
  ],
  examples: ['workctl mysql instance get --instance demo-mysql'],
  handler: async (ctx, i) =>
    withMysql(ctx, i.instance, async (s) => {
      const vars = await globalVariables(s, KEY_VARIABLES);
      const st = await globalStatus(s, KEY_STATUS);
      const uptime = num(st.Uptime);
      const { binding, source: bsrc } = bindingFor(ctx, 'mysql', s.ep.name);
      const logOutput = (vars.log_output ?? '').toUpperCase();
      const slow = vars.slow_query_log === 'ON' ? (logOutput.includes('TABLE') ? 'table' : 'file_only') : 'off';
      const sources: Source[] = [s.src('SHOW GLOBAL VARIABLES; SHOW GLOBAL STATUS; SELECT VERSION(), CURRENT_USER()')];
      if (bsrc) sources.push(bsrc);
      return {
        data: {
          instance: s.ep.name,
          binding,
          engine: {
            version: s.version,
            version_comment: vars.version_comment ?? null,
            current_user: s.user,
            uptime_s: uptime,
            started_at: uptime !== null ? new Date(Date.now() - uptime * 1000).toISOString() : null,
            read_only: vars.read_only === 'ON',
            super_read_only: vars.super_read_only === 'ON',
          },
          variables: vars,
          status: Object.fromEntries(KEY_STATUS.map((k) => [k, num(st[k])])),
          status_semantics: STATUS_SEMANTICS,
          observability: {
            performance_schema: vars.performance_schema === 'ON',
            slow_log: slow as 'table' | 'file_only' | 'off',
            long_query_time_s: num(vars.long_query_time),
          },
        },
        sources,
        coverage: { complete: true, notes: binding ? [] : ['资源绑定中没有该端点的平台元数据（binding=null）'] },
      };
    }),
});

export const tableGet = defineCapability({
  name: 'mysql.table.get',
  command: 'mysql table get',
  summary: '查看表结构与表级统计（information_schema.TABLES / COLUMNS），行数为估计值',
  domain: 'mysql',
  inputs: { instance: INSTANCE, database: DATABASE, table: TABLE },
  output: z.object({
    instance: z.string(),
    database: z.string(),
    table: z.string(),
    table_type: z.string(),
    engine: z.string().nullable(),
    row_format: z.string().nullable(),
    rows_estimate: z.number().nullable().describe('TABLE_ROWS：InnoDB 为采样估计值，可能与 COUNT(*) 相差较大'),
    avg_row_length: z.number().nullable(),
    data_length_bytes: z.number().nullable(),
    index_length_bytes: z.number().nullable(),
    data_free_bytes: z.number().nullable(),
    auto_increment: z.string().nullable(),
    collation: z.string().nullable(),
    comment: z.string().nullable(),
    create_time: z.string().nullable(),
    update_time: z.string().nullable(),
    columns: z.array(
      z.object({
        name: z.string(),
        position: z.number(),
        column_type: z.string(),
        data_type: z.string(),
        nullable: z.boolean(),
        default: z.string().nullable(),
        key: z.string().nullable().describe('PRI/UNI/MUL（只反映索引首列）'),
        extra: z.string().nullable(),
        charset: z.string().nullable(),
        collation: z.string().nullable(),
        comment: z.string().nullable(),
        sensitive: z.boolean().describe('列名命中端点 sensitive_columns（query execute 会脱敏）'),
      }),
    ),
  }),
  adapter: ADAPTER,
  operation: 'read',
  auth_provider: AUTH_PROVIDER,
  guide: GUIDE,
  prerequisites: [...COMMON_PREREQS, '对目标表有任一权限（information_schema 只显示有权限的对象）'],
  notes: [
    'rows_estimate、data_length 等来自 InnoDB 统计信息，是估计值；且受 information_schema_stats_expiry 缓存影响（默认 86400 秒）',
    '表不可见时会区分“不存在”(NOT_FOUND) 与“无权限”(PERMISSION_DENIED)',
  ],
  examples: ['workctl mysql table get --instance demo-mysql --database demo --table orders'],
  handler: async (ctx, i) =>
    withMysql(ctx, i.instance, async (s) => {
      const [t] = await s.query(
        `SELECT TABLE_TYPE, ENGINE, ROW_FORMAT, TABLE_ROWS, AVG_ROW_LENGTH, DATA_LENGTH, INDEX_LENGTH, DATA_FREE, AUTO_INCREMENT,
                TABLE_COLLATION, TABLE_COMMENT, CREATE_TIME, UPDATE_TIME
           FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
        [i.database, i.table],
      );
      if (!t) {
        await assertTableAccessible(s, i.database, i.table);
        throw new WorkError('NOT_FOUND', `表不存在: ${i.database}.${i.table}`);
      }
      const cols = await s.query(
        `SELECT COLUMN_NAME, ORDINAL_POSITION, COLUMN_TYPE, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA,
                CHARACTER_SET_NAME, COLLATION_NAME, COLUMN_COMMENT
           FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
        [i.database, i.table],
      );
      const sens = sensitiveColumns(s.ep);
      return {
        data: {
          instance: s.ep.name,
          database: i.database,
          table: i.table,
          table_type: String(t.TABLE_TYPE),
          engine: t.ENGINE ?? null,
          row_format: t.ROW_FORMAT ?? null,
          rows_estimate: num(t.TABLE_ROWS),
          avg_row_length: num(t.AVG_ROW_LENGTH),
          data_length_bytes: num(t.DATA_LENGTH),
          index_length_bytes: num(t.INDEX_LENGTH),
          data_free_bytes: num(t.DATA_FREE),
          auto_increment: t.AUTO_INCREMENT === null || t.AUTO_INCREMENT === undefined ? null : String(t.AUTO_INCREMENT),
          collation: t.TABLE_COLLATION ?? null,
          comment: t.TABLE_COMMENT || null,
          create_time: isoFromMysql(t.CREATE_TIME),
          update_time: isoFromMysql(t.UPDATE_TIME),
          columns: cols.map((c) => ({
            name: String(c.COLUMN_NAME),
            position: Number(c.ORDINAL_POSITION),
            column_type: String(c.COLUMN_TYPE),
            data_type: String(c.DATA_TYPE),
            nullable: c.IS_NULLABLE === 'YES',
            default: c.COLUMN_DEFAULT === null || c.COLUMN_DEFAULT === undefined ? null : String(c.COLUMN_DEFAULT),
            key: c.COLUMN_KEY || null,
            extra: c.EXTRA || null,
            charset: c.CHARACTER_SET_NAME ?? null,
            collation: c.COLLATION_NAME ?? null,
            comment: c.COLUMN_COMMENT || null,
            sensitive: sens.has(String(c.COLUMN_NAME).toLowerCase()),
          })),
        },
        sources: [s.src('information_schema.TABLES + information_schema.COLUMNS')],
        coverage: { complete: true, notes: ['rows_estimate / data_length 为 InnoDB 统计估计值（受 information_schema_stats_expiry 缓存影响），精确行数需 COUNT(*)'] },
      };
    }),
});

export const indexList = defineCapability({
  name: 'mysql.index.list',
  command: 'mysql index list',
  summary: '列出表的索引（按索引分组的列顺序、唯一性、基数估计），附自启动以来的索引访问计数',
  domain: 'mysql',
  inputs: { instance: INSTANCE, database: DATABASE, table: TABLE },
  output: z.object({
    instance: z.string(),
    database: z.string(),
    table: z.string(),
    indexes: z.array(
      z.object({
        name: z.string(),
        unique: z.boolean(),
        primary: z.boolean(),
        type: z.string(),
        visible: z.boolean(),
        columns: z.array(
          z.object({
            seq: z.number(),
            column: z.string().nullable(),
            expression: z.string().nullable(),
            sub_part: z.number().nullable(),
            cardinality_estimate: z.number().nullable(),
            nullable: z.boolean(),
          }),
        ),
        comment: z.string().nullable(),
      }),
    ),
    io_by_index: z
      .array(z.object({ index: z.string().nullable(), count_star: z.number(), count_read: z.number(), count_fetch: z.number() }))
      .nullable()
      .describe('performance_schema.table_io_waits_summary_by_index_usage，自启动/重置以来累计；index=null 表示未使用索引的行访问'),
  }),
  adapter: ADAPTER,
  operation: 'read',
  auth_provider: AUTH_PROVIDER,
  guide: GUIDE,
  prerequisites: COMMON_PREREQS,
  notes: [
    'cardinality_estimate 是统计估计值（ANALYZE TABLE 后更新），不是精确去重计数',
    'io_by_index 是累计值（自启动或 performance_schema 重置以来），不能当作窗口值；index=null 行代表不走索引的行读取（全表扫描）',
  ],
  examples: ['workctl mysql index list --instance demo-mysql --database demo --table orders'],
  handler: async (ctx, i) =>
    withMysql(ctx, i.instance, async (s) => {
      const rows = await s.query(
        `SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, EXPRESSION, SUB_PART, CARDINALITY, INDEX_TYPE, NULLABLE, IS_VISIBLE, INDEX_COMMENT
           FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
          ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX`,
        [i.database, i.table],
      );
      if (!rows.length) await assertTableAccessible(s, i.database, i.table);
      const byName = new Map<string, any>();
      for (const r of rows) {
        const name = String(r.INDEX_NAME);
        if (!byName.has(name)) {
          byName.set(name, {
            name,
            unique: String(r.NON_UNIQUE) === '0',
            primary: name === 'PRIMARY',
            type: String(r.INDEX_TYPE),
            visible: r.IS_VISIBLE !== 'NO',
            columns: [],
            comment: r.INDEX_COMMENT || null,
          });
        }
        byName.get(name).columns.push({
          seq: Number(r.SEQ_IN_INDEX),
          column: r.COLUMN_NAME ?? null,
          expression: r.EXPRESSION ?? null,
          sub_part: num(r.SUB_PART),
          cardinality_estimate: num(r.CARDINALITY),
          nullable: r.NULLABLE === 'YES',
        });
      }
      const sources: Source[] = [s.src('information_schema.STATISTICS')];
      let io: { index: string | null; count_star: number; count_read: number; count_fetch: number }[] | null = null;
      const [psRow] = await s.query('SELECT @@global.performance_schema AS ps');
      const psOn = String(psRow?.ps) === '1';
      if (!psOn) ctx.warn('performance_schema=OFF，索引访问计数不可用（io_by_index=null）');
      else {
        try {
          const ioRows = await s.query(
            `SELECT INDEX_NAME, COUNT_STAR, COUNT_READ, COUNT_FETCH FROM performance_schema.table_io_waits_summary_by_index_usage
              WHERE OBJECT_SCHEMA = ? AND OBJECT_NAME = ? ORDER BY COUNT_STAR DESC`,
            [i.database, i.table],
          );
          io = ioRows.map((r) => ({ index: r.INDEX_NAME ?? null, count_star: Number(r.COUNT_STAR), count_read: Number(r.COUNT_READ), count_fetch: Number(r.COUNT_FETCH) }));
          sources.push(s.src('performance_schema.table_io_waits_summary_by_index_usage'));
        } catch (e) {
          ctx.warn(`索引访问计数不可用: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const indexes = [...byName.values()];
      return {
        data: { instance: s.ep.name, database: i.database, table: i.table, indexes, io_by_index: io },
        sources,
        coverage: {
          complete: true,
          notes: [
            ...(indexes.length ? [] : ['该表没有任何索引（包括主键）']),
            'cardinality_estimate 为统计估计值；io_by_index 为累计值（非窗口）',
          ],
        },
      };
    }),
});
