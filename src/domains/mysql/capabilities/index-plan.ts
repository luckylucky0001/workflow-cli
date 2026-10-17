import { z } from 'zod';
import { PlanSchema, type PlanDraft } from '../../../core/operations';
import { source, WorkError } from '../../../core/output';
import { defineCapability, type Planner } from '../../../core/registry';
import type { Ctx } from '../../../core/runtime';
import { big, psToMs } from '../analysis';
import { ADAPTER, AUTH_PROVIDER, GUIDE, assertIdentifier, assertTableAccessible, num, quoteId, withMysql } from '../client';
import { COMMON_PREREQS, DATABASE, INSTANCE, TABLE } from '../inputs';

export const INDEX_CREATE_KIND = 'mysql.index.create';

const TEXT_TYPES = new Set(['tinytext', 'text', 'mediumtext', 'longtext', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'json', 'geometry']);
const FIXED_BYTES: Record<string, number> = { tinyint: 1, smallint: 2, mediumint: 3, int: 4, integer: 4, bigint: 8, float: 4, double: 8, date: 3, datetime: 5, timestamp: 4, time: 3, year: 1 };

function humanBytes(n: number | null): string | null {
  if (n === null) return null;
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let k = 0;
  while (v >= 1024 && k < u.length - 1) {
    v /= 1024;
    k++;
  }
  return `${v.toFixed(v < 10 && k ? 1 : 0)} ${u[k]}`;
}

/** Rough per-entry key width (bytes) for the size heuristic; not a measurement. */
function keyBytes(col: { DATA_TYPE: string; CHARACTER_MAXIMUM_LENGTH: unknown; CHARACTER_OCTET_LENGTH: unknown; NUMERIC_PRECISION: unknown }): number {
  const t = String(col.DATA_TYPE).toLowerCase();
  if (FIXED_BYTES[t] !== undefined) return FIXED_BYTES[t];
  if (t === 'decimal') return Math.ceil((num(col.NUMERIC_PRECISION) ?? 10) / 2) + 1;
  const octets = num(col.CHARACTER_OCTET_LENGTH) ?? 16;
  // variable-length strings are rarely full; assume half of the declared width + 2 length bytes
  return Math.min(octets, 3072) / 2 + 2;
}

export const indexCreatePlanner: Planner = {
  kind: INDEX_CREATE_KIND,
  summary: '为 MySQL 表新增二级索引的变更计划（只生成计划，执行属于 DBA 变更流程）',
  plan: (ctx: Ctx, params: Record<string, string>) => planIndexCreate(ctx, params),
};

export async function planIndexCreate(ctx: Ctx, params: Record<string, string>): Promise<PlanDraft> {
  const database = assertIdentifier('库', String(params.database ?? ''));
  const table = assertIdentifier('表', String(params.table ?? ''));
  const columns = String(params.columns ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => assertIdentifier('列', c));
  if (!columns.length) throw new WorkError('INVALID_ARGUMENT', '缺少 columns（逗号分隔的列名，按索引顺序）');
  if (new Set(columns.map((c) => c.toLowerCase())).size !== columns.length) throw new WorkError('INVALID_ARGUMENT', 'columns 中有重复列');
  const indexName = assertIdentifier('索引', params.name?.trim() || `idx_${columns.join('_')}`.slice(0, 64));

  return withMysql(ctx, params.instance || undefined, async (s) => {
    const [t] = await s.query(
      `SELECT TABLE_TYPE, ENGINE, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, AVG_ROW_LENGTH FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [database, table],
    );
    if (!t) {
      await assertTableAccessible(s, database, table);
      throw new WorkError('NOT_FOUND', `表不存在: ${database}.${table}`);
    }
    if (t.TABLE_TYPE !== 'BASE TABLE') throw new WorkError('INVALID_ARGUMENT', `${database}.${table} 是 ${t.TABLE_TYPE}，不能建索引`);
    const colRows = await s.query(
      `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, CHARACTER_OCTET_LENGTH, NUMERIC_PRECISION, COLUMN_KEY
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [database, table],
    );
    const colMap = new Map(colRows.map((c) => [String(c.COLUMN_NAME).toLowerCase(), c]));
    const missing = columns.filter((c) => !colMap.has(c.toLowerCase()));
    if (missing.length) throw new WorkError('INVALID_ARGUMENT', `列不存在: ${missing.join(', ')}`, { hint: `先用 workctl mysql table get --database ${database} --table ${table} 查看列` });
    const needPrefix = columns.filter((c) => TEXT_TYPES.has(String(colMap.get(c.toLowerCase())!.DATA_TYPE).toLowerCase()));

    const stats = await s.query(
      `SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
      [database, table],
    );
    const existing = new Map<string, string[]>();
    for (const r of stats) {
      const k = String(r.INDEX_NAME);
      if (!existing.has(k)) existing.set(k, []);
      existing.get(k)!.push(String(r.COLUMN_NAME ?? '').toLowerCase());
    }
    const want = columns.map((c) => c.toLowerCase());
    const covering = [...existing.entries()].filter(([, cols]) => want.every((c, idx) => cols[idx] === c)).map(([k, cols]) => `${k}(${cols.join(',')})`);
    const prefixOfNew = [...existing.entries()]
      .filter(([k, cols]) => k !== 'PRIMARY' && cols.length < want.length && cols.every((c, idx) => want[idx] === c))
      .map(([k, cols]) => `${k}(${cols.join(',')})`);
    const nameTaken = [...existing.keys()].some((k) => k.toLowerCase() === indexName.toLowerCase());

    // primary key width (secondary index entries carry the PK)
    const pkCols = existing.get('PRIMARY') ?? [];
    const pkBytes = pkCols.reduce((a, c) => a + (colMap.has(c) ? keyBytes(colMap.get(c) as any) : 8), 0) || 6;
    const entryBytes = columns.reduce((a, c) => a + keyBytes(colMap.get(c.toLowerCase()) as any), 0) + pkBytes + 14;
    const rows = num(t.TABLE_ROWS);
    const estIndexBytes = rows !== null ? Math.round(rows * entryBytes * 1.45) : null; // ~69% page fill after sorted build
    const dataBytes = num(t.DATA_LENGTH);

    const longTrx = await s.query(
      `SELECT trx_mysql_thread_id AS pid, TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS age_s FROM information_schema.INNODB_TRX
        WHERE trx_started < NOW() - INTERVAL 60 SECOND ORDER BY trx_started LIMIT 5`,
    );

    // statements touching the table (cumulative digest statistics; text match → inferred)
    let affected: Record<string, unknown>[] = [];
    let affectedNote = '';
    try {
      const needle = `\`${table}\``;
      const dig = await s.query(
        `SELECT SCHEMA_NAME, DIGEST, DIGEST_TEXT, COUNT_STAR, SUM_TIMER_WAIT, SUM_ROWS_EXAMINED, SUM_NO_INDEX_USED, FIRST_SEEN
           FROM performance_schema.events_statements_summary_by_digest
          WHERE DIGEST_TEXT LIKE ? AND (SCHEMA_NAME = ? OR DIGEST_TEXT LIKE ?)
            AND DIGEST_TEXT NOT LIKE '%events_statements_summary_by_digest%' AND DIGEST_TEXT NOT LIKE '%information_schema%' AND DIGEST_TEXT NOT LIKE 'EXPLAIN%'
          ORDER BY SUM_TIMER_WAIT DESC LIMIT 10`,
        [`%${needle}%`, database, `%\`${database}\` . ${needle}%`],
      );
      const lead = `\`${columns[0]}\``;
      affected = dig.map((r) => {
        const text = String(r.DIGEST_TEXT ?? '');
        const count = Number(big(r.COUNT_STAR));
        const kind = text.split(/\s+/)[0]?.toUpperCase() ?? '';
        return {
          digest: r.DIGEST,
          schema: r.SCHEMA_NAME ?? null,
          statement: kind,
          digest_text: text.length > 300 ? `${text.slice(0, 300)}…` : text,
          count,
          total_latency_ms: Math.round(psToMs(big(r.SUM_TIMER_WAIT))),
          avg_rows_examined: count ? Math.round(Number(big(r.SUM_ROWS_EXAMINED)) / count) : null,
          no_index_used_count: Number(big(r.SUM_NO_INDEX_USED)),
          references_leading_column: text.includes(lead),
          effect: ['INSERT', 'UPDATE', 'DELETE', 'REPLACE'].includes(kind) ? '写入需额外维护新索引' : text.includes(lead) ? '可能受益（引用了索引首列，需 EXPLAIN 确认）' : '不直接相关',
          first_seen: r.FIRST_SEEN ? `${String(r.FIRST_SEEN).replace(' ', 'T')}Z` : null,
        };
      });
      affectedNote = '受影响语句来自 events_statements_summary_by_digest 的累计值（自启动/重置以来），按 DIGEST_TEXT 文本匹配表名（推断，relation=inferred）';
    } catch (e) {
      affectedNote = `未能读取语句摘要: ${e instanceof Error ? e.message : String(e)}`;
    }

    const colList = columns.map(quoteId).join(', ');
    const fq = `${quoteId(database)}.${quoteId(table)}`;
    const ddl = `ALTER TABLE ${fq} ADD INDEX ${quoteId(indexName)} (${colList}), ALGORITHM=INPLACE, LOCK=NONE;`;
    const rollback = `ALTER TABLE ${fq} DROP INDEX ${quoteId(indexName)}, ALGORITHM=INPLACE, LOCK=NONE;`;
    const sizeClass = dataBytes === null ? 'unknown' : dataBytes < 1 << 30 ? 'small (<1GiB)' : dataBytes < 50 * (1 << 30) ? 'medium (1–50GiB)' : 'large (>50GiB)';

    return {
      kind: INDEX_CREATE_KIND,
      title: `为 ${database}.${table} 新增索引 ${indexName}(${columns.join(', ')})`,
      params: { instance: s.ep.name, database, table, columns, name: indexName },
      targets: [
        {
          type: 'mysql.table',
          instance: s.ep.name,
          engine_version: s.version,
          database,
          table,
          engine: t.ENGINE ?? null,
          rows_estimate: rows,
          data_bytes: dataBytes,
          data_size: humanBytes(dataBytes),
          index_bytes: num(t.INDEX_LENGTH),
          index_size: humanBytes(num(t.INDEX_LENGTH)),
          existing_indexes: [...existing.entries()].map(([k, cols]) => `${k}(${cols.join(',')})`),
          observed_at: new Date().toISOString(),
        },
      ],
      impact: {
        ddl,
        algorithm: 'INPLACE, LOCK=NONE（在线 DDL：构建期间允许并发读写；开始和结束时短暂需要元数据锁）',
        size_class: sizeClass,
        estimated_new_index_bytes: estIndexBytes,
        estimated_new_index_size: humanBytes(estIndexBytes),
        estimate_basis: `启发式估计（非测量）：rows_estimate × 每条约 ${Math.round(entryBytes)} 字节（索引列 + 主键 + 行开销）× 1.45 页填充系数`,
        build_cost: '需要全表扫描并排序一次；耗时与表大小、IO 能力、并发写入量相关，建议在低峰执行并先在同规格副本上实测',
        temp_space: '排序临时文件约等于新索引大小（innodb_tmpdir / tmpdir）；并发 DML 写入在线日志（innodb_online_alter_log_max_size 上限）',
        replication: '主从环境下从库会在回放时重新构建索引，可能产生复制延迟',
        affected_statements: affected,
        affected_statements_note: affectedNote,
        long_running_transactions: longTrx.map((r) => ({ thread_id: num(r.pid), age_s: num(r.age_s) })),
      },
      preconditions: [
        { check: 'table_exists', ok: true, detail: `${database}.${table} (${t.ENGINE})` },
        { check: 'columns_exist', ok: true, detail: columns.join(', ') },
        { check: 'engine_supports_online_ddl', ok: String(t.ENGINE).toLowerCase() === 'innodb', detail: `ENGINE=${t.ENGINE}` },
        { check: 'index_name_unused', ok: !nameTaken, detail: nameTaken ? `已存在同名索引 ${indexName}` : `${indexName} 未被使用` },
        {
          check: 'no_index_with_same_leading_columns',
          ok: covering.length === 0,
          detail: covering.length ? `已有索引以相同列开头: ${covering.join('; ')}（新索引可能冗余）` : '没有以相同列开头的现有索引',
        },
        ...(prefixOfNew.length ? [{ check: 'existing_prefix_index', ok: true, detail: `现有索引 ${prefixOfNew.join('; ')} 是新索引的前缀，新索引建成后可考虑删除（需单独评估）` }] : []),
        {
          check: 'no_prefix_length_needed',
          ok: needPrefix.length === 0,
          detail: needPrefix.length ? `列 ${needPrefix.join(', ')} 为 TEXT/BLOB/JSON，需要指定前缀长度或函数索引，当前计划不支持` : '所有列可直接建索引',
        },
        {
          check: 'no_long_running_transactions',
          ok: longTrx.length === 0,
          detail: longTrx.length ? `${longTrx.length} 个事务已运行超过 60 秒，DDL 可能等待元数据锁并阻塞后续语句` : '当前没有运行超过 60 秒的事务（计划生成时）',
        },
      ],
      steps: [
        { name: 'review', detail: '复核本计划：目标表、DDL、受影响语句与前置条件（计划生成时的快照，执行前需重新检查）' },
        { name: 'verify_benefit', detail: `用 workctl mysql query explain 对受益语句确认当前为全表扫描（access_type=ALL），建索引后应变为 ref 并使用 ${indexName}` },
        { name: 'execute_via_change_process', detail: `由 DBA 变更流程在低峰执行（workctl 不提供该计划的执行器，executable=false；workctl_ro 也没有 ALTER 权限）: ${ddl}` },
        { name: 'monitor', detail: '执行中观察 performance_schema.events_stages_current（stage/innodb/alter%）进度、复制延迟与元数据锁等待（workctl mysql lock list）' },
        { name: 'validate', detail: `执行后: workctl mysql index list 确认 ${indexName} 存在；mysql query explain 确认计划使用新索引；mysql statement summary 对比窗口内 rows_examined / 延迟` },
      ],
      rollback,
      idempotent: false,
      cancellable: false,
    };
  });
}

export const indexPlan = defineCapability({
  name: 'mysql.index.plan',
  command: 'mysql index plan',
  summary: '生成新增索引的变更计划（解析目标表、DDL、影响语句、前置条件、回滚），不执行',
  domain: 'mysql',
  inputs: {
    instance: INSTANCE,
    database: DATABASE,
    table: TABLE,
    columns: { type: 'list', required: true, description: '索引列（按顺序，逗号分隔），如 customer_id,created_at' },
    name: { type: 'string', description: '索引名（缺省 idx_<列名>）' },
  },
  output: PlanSchema,
  adapter: ADAPTER,
  operation: 'plan',
  auth_provider: AUTH_PROVIDER,
  guide: GUIDE,
  idempotent: false,
  cancellable: false,
  prerequisites: [...COMMON_PREREQS, '生成计划只需只读权限；执行需要单独的变更账号与 DBA 流程'],
  notes: [
    '计划预览不是执行成功的证据；mysql.index.create 没有执行器（executable=false），执行属于 DBA 变更流程',
    '索引大小与构建成本是启发式估计；受影响语句来自累计摘要统计的文本匹配（inferred）',
    '等价于 workctl operation plan --action mysql.index.create --param instance=... --param database=... --param table=... --param columns=...',
  ],
  examples: ['workctl mysql index plan --instance demo-mysql --database demo --table orders --columns customer_id'],
  handler: async (ctx, i) => {
    const params: Record<string, string> = {
      ...(i.instance ? { instance: String(i.instance) } : {}),
      database: String(i.database),
      table: String(i.table),
      columns: (i.columns as string[]).join(','),
      ...(i.name ? { name: String(i.name) } : {}),
    };
    const planner = ctx.registry.planners.get(INDEX_CREATE_KIND) ?? indexCreatePlanner;
    const draft = await planner.plan(ctx, params);
    const plan = ctx.plans().create(draft, { profile: ctx.profileName, env: ctx.env, executable: ctx.registry.executors.has(draft.kind) });
    return {
      data: plan,
      sources: [
        source('mysql', ADAPTER, { endpoint: `mysql/${String(draft.params.instance)}`, method: 'information_schema.TABLES/COLUMNS/STATISTICS + INNODB_TRX', relation: 'explicit' }),
        source('mysql', ADAPTER, { endpoint: `mysql/${String(draft.params.instance)}`, method: 'performance_schema.events_statements_summary_by_digest (cumulative, text match)', relation: 'inferred' }),
        source('workctl', 'plan-store', { endpoint: ctx.plans().dir, relation: 'derived' }),
      ],
      coverage: {
        complete: true,
        notes: ['计划为生成时快照；执行前需重新检查前置条件', ...(plan.executable ? [] : ['executable=false：workctl 只生成计划，执行属于 DBA 变更流程'])],
      },
    };
  },
});
