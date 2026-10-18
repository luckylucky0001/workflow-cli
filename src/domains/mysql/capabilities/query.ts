import type { FieldPacket } from 'mysql2/promise';
import { z } from 'zod';
import { readInputFile } from '../../../core/engine';
import { WorkError } from '../../../core/output';
import { defineCapability } from '../../../core/registry';
import { cell, flattenExplain, maskValue, parseAnalyzeTree } from '../analysis';
import { ADAPTER, AUTH_PROVIDER, GUIDE, mapMysqlError, sensitiveColumns, withMysql, type MysqlSession } from '../client';
import { COMMON_PREREQS, DATABASE, INSTANCE, SQL_FILE, SQL_INLINE, SQL_MAX_BYTES } from '../inputs';
import { guardSql, maskLiterals, sensitiveOutputPlan, type Token } from '../sql-guard';

const DEFAULT_MAX_EXEC_MS = 5000;

/**
 * SQL text from exactly one of --sql / --sql-file. Both go through the same guard and the same
 * size budget as readInputFile (256 KiB).
 */
export function sqlText(i: Record<string, unknown>): { text: string; origin: 'inline' | 'file' } {
  const inline = typeof i.sql === 'string' && i.sql.trim() !== '' ? i.sql : undefined;
  const file = i.sql_file !== undefined && i.sql_file !== null && String(i.sql_file) !== '' ? String(i.sql_file) : undefined;
  if (inline !== undefined && file !== undefined) {
    throw new WorkError('INVALID_ARGUMENT', '--sql 与 --sql-file 只能提供一个', { hint: '内联语句用 --sql "SELECT ..."，或把语句写入文件用 --sql-file q.sql' });
  }
  if (inline === undefined && file === undefined) {
    throw new WorkError('INVALID_ARGUMENT', '缺少 SQL：需要 --sql 或 --sql-file 之一', { hint: '例如 --sql "SELECT * FROM orders WHERE id = 1" 或 --sql-file q.sql' });
  }
  if (inline !== undefined) {
    if (Buffer.byteLength(inline, 'utf8') > SQL_MAX_BYTES) throw new WorkError('INVALID_ARGUMENT', `--sql 超过 ${SQL_MAX_BYTES} 字节上限`);
    return { text: inline, origin: 'inline' };
  }
  return { text: readInputFile(file!, SQL_MAX_BYTES), origin: 'file' };
}

/** The statement names a configured sensitive column, or expands `*` (which may include one). */
export function mayReadSensitive(tokens: Token[], sensitive: Set<string>): boolean {
  if (!sensitive.size) return false;
  return tokens.some(
    (t, idx) =>
      ((t.kind === 'word' || t.kind === 'ident') && sensitive.has((t.kind === 'ident' ? t.text.slice(1, -1).split('``').join('`') : t.text).toLowerCase())) ||
      (t.kind === 'punct' && t.text === '*' && idx > 0 && tokens[idx - 1].text !== '('),
  );
}

/**
 * The optimizer reads const tables (e.g. `WHERE c.id = 1`) while planning and substitutes their
 * column values into other tables' conditions, so EXPLAIN / EXPLAIN ANALYZE text can show a row
 * value (`o.status = '13800001111'`). Mask literals in the operation text; keep cost/actual stats.
 */
export function maskPlanTree(tree: string): string {
  return tree
    .split('\n')
    .map((line) => {
      const m = /^(\s*-> )(.*?)((?:\s*\((?:cost|rows|actual time)=[^)]*\)|\s*\(never executed\))*)$/.exec(line);
      return m ? `${m[1]}${maskLiterals(m[2])}${m[3]}` : maskLiterals(line);
    })
    .join('\n');
}

/** Same for EXPLAIN FORMAT=JSON: literals in *condition* strings (attached_condition, index_condition, ...). */
export function maskPlanConditions(plan: unknown, key = ''): unknown {
  if (typeof plan === 'string') return /condition/i.test(key) ? maskLiterals(plan) : plan;
  if (Array.isArray(plan)) return plan.map((x) => maskPlanConditions(x, key));
  if (plan && typeof plan === 'object') return Object.fromEntries(Object.entries(plan).map(([k, v]) => [k, maskPlanConditions(v, k)]));
  return plan;
}

function maskPlanText(v: string): string {
  if (/^\s*[{[]/.test(v)) {
    try {
      return JSON.stringify(maskPlanConditions(JSON.parse(v)), null, 2);
    } catch {
      /* not JSON */
    }
  }
  return v.includes('-> ') ? maskPlanTree(v) : v;
}

/** Server errors whose text names only identifiers / the submitted SQL, never row values. */
const IDENTIFIER_ONLY_ERRORS = new Set([
  'ER_NO_SUCH_TABLE', 'ER_BAD_DB_ERROR', 'ER_BAD_TABLE_ERROR', 'ER_BAD_FIELD_ERROR', 'ER_PARSE_ERROR', 'ER_WRONG_NUMBER_OF_COLUMNS_IN_SELECT',
  'ER_TABLEACCESS_DENIED_ERROR', 'ER_COLUMNACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR', 'ER_SPECIFIC_ACCESS_DENIED_ERROR', 'ER_QUERY_TIMEOUT',
]);

/**
 * Server error messages can echo row values (XPATH syntax error: '~<phone>', Malformed GTID set
 * specification '<email>', Truncated incorrect ... value: '<v>'), which would bypass result masking.
 * When the statement may read sensitive columns (a configured name or a `*` expansion), quoted
 * values / numbers in such messages are replaced with `?`.
 */
export function redactErrorValues(e: unknown, tokens: Token[], sensitive: Set<string>): unknown {
  if (!(e instanceof WorkError) || !sensitive.size) return e;
  const driverCode = String(e.details?.driver_code ?? '');
  if (!e.details || IDENTIFIER_ONLY_ERRORS.has(driverCode) || !('reason' in e.details)) return e;
  if (!mayReadSensitive(tokens, sensitive)) return e;
  return new WorkError(e.code, maskLiterals(e.message), {
    hint: e.hint,
    details: { ...e.details, reason: maskLiterals(String(e.details.reason)), values_redacted: '语句引用了敏感列（或 *），服务端错误信息中的值已替换为 ?' },
  });
}

const CONDITION_MASK_NOTE = '语句引用了敏感列（或 *）：计划中条件里的字面量已替换为 ?（优化器会把常量表的行值代入条件）';

function maxExecMs(s: MysqlSession): number {
  return Math.max(100, Math.floor(s.ep.num('max_execution_time_ms', DEFAULT_MAX_EXEC_MS) ?? DEFAULT_MAX_EXEC_MS));
}

/** MySQL protocol column type codes (include/field_types.h). */
const MYSQL_TYPES: Record<number, string> = {
  0: 'DECIMAL', 1: 'TINYINT', 2: 'SMALLINT', 3: 'INT', 4: 'FLOAT', 5: 'DOUBLE', 6: 'NULL', 7: 'TIMESTAMP', 8: 'BIGINT',
  9: 'MEDIUMINT', 10: 'DATE', 11: 'TIME', 12: 'DATETIME', 13: 'YEAR', 14: 'DATE', 15: 'VARCHAR', 16: 'BIT', 245: 'JSON',
  246: 'DECIMAL', 247: 'ENUM', 248: 'SET', 249: 'TINYBLOB', 250: 'MEDIUMBLOB', 251: 'LONGBLOB', 252: 'BLOB',
  253: 'VARCHAR', 254: 'CHAR', 255: 'GEOMETRY',
};

function typeName(f: FieldPacket): string {
  const t = f.columnType ?? f.type;
  return t !== undefined ? (MYSQL_TYPES[t] ?? String(t)) : (f.typeName ?? 'UNKNOWN');
}

/** Enter the guarded read context: read-only transaction + per-statement execution limit. */
async function enterReadOnly(s: MysqlSession, limitMs: number): Promise<void> {
  await s.query('SET SESSION TRANSACTION READ ONLY');
  await s.query(`SET SESSION MAX_EXECUTION_TIME = ${Math.floor(limitMs)}`);
  await s.query('START TRANSACTION READ ONLY');
}

async function rollbackQuietly(s: MysqlSession): Promise<void> {
  try {
    await s.query('ROLLBACK', undefined, { timeoutMs: 2000 });
  } catch {
    /* connection may already be closed (row cap reached) */
  }
}

/**
 * Stream rows and stop reading once `maxRows` is exceeded (the connection is dropped, the
 * server aborts the read-only statement). Avoids buffering an unbounded result set.
 */
function streamRows(s: MysqlSession, sql: string, maxRows: number, timeoutMs: number): Promise<{ fields: FieldPacket[]; rows: unknown[][]; truncated: boolean }> {
  const raw = (s.conn as unknown as { connection: any }).connection;
  return new Promise((resolve, reject) => {
    const rows: unknown[][] = [];
    let fields: FieldPacket[] = [];
    let done = false;
    const q = raw.query({ sql, rowsAsArray: true, timeout: timeoutMs });
    q.on('fields', (f: FieldPacket[]) => {
      fields = f ?? [];
    });
    q.on('result', (row: unknown) => {
      if (done) return;
      if (!Array.isArray(row)) return; // OK packet for statements without a result set
      if (rows.length < maxRows) {
        rows.push(row);
        return;
      }
      done = true;
      try {
        raw.destroy();
      } catch {
        /* ignore */
      }
      resolve({ fields, rows, truncated: true });
    });
    q.on('error', (e: unknown) => {
      if (done) return;
      done = true;
      reject(mapMysqlError(e, s.ep) ?? e);
    });
    q.on('end', () => {
      if (done) return;
      done = true;
      resolve({ fields, rows, truncated: false });
    });
  });
}

export const queryExecute = defineCapability({
  name: 'mysql.query.execute',
  command: 'mysql query execute',
  summary: '受限只读查询：单条 SELECT/WITH/SHOW/DESCRIBE/EXPLAIN，只读事务 + 执行时间上限 + 行数上限 + 敏感列脱敏',
  domain: 'mysql',
  inputs: {
    instance: INSTANCE,
    database: DATABASE,
    sql: SQL_INLINE,
    sql_file: SQL_FILE,
    max_rows: { type: 'int', default: 20, description: '最多返回行数（上限 1000）；超出时 coverage.truncated=true' },
  },
  output: z.object({
    instance: z.string(),
    database: z.string(),
    statement_type: z.string(),
    columns: z.array(z.object({ name: z.string(), type: z.string(), table: z.string().nullable(), source_column: z.string().nullable(), masked: z.boolean() })),
    rows: z.array(z.array(z.unknown())).describe('按 columns 顺序排列的值；BIGINT/DECIMAL 以字符串返回以保证精度'),
    row_count: z.number(),
    max_rows: z.number(),
    truncated: z.boolean(),
    masked_columns: z.array(z.string()),
    guards: z.object({
      static_check: z.literal('passed'),
      read_only_transaction: z.boolean(),
      max_execution_time_ms: z.number(),
      sql_select_limit: z.number(),
    }),
    elapsed_ms: z.number(),
  }),
  adapter: ADAPTER,
  operation: 'read',
  auth_provider: AUTH_PROVIDER,
  guide: GUIDE,
  prerequisites: [...COMMON_PREREQS, '端点 max_execution_time_ms（默认 5000）与 sensitive_columns 配置'],
  notes: [
    '实际权限边界是数据库账号（workctl_ro 只有 SELECT）；程序层静态检查、只读事务、MAX_EXECUTION_TIME、行数上限是额外防线',
    '静态检查：只允许单条 SELECT / WITH...SELECT / SHOW / DESCRIBE / EXPLAIN；拒绝 INTO OUTFILE/DUMPFILE、FOR UPDATE/SHARE、LOCK IN SHARE MODE、变量赋值、可执行注释、EXPLAIN ANALYZE；SHOW 中不允许 SLEEP/BENCHMARK/子查询（SHOW 不受 MAX_EXECUTION_TIME 约束）',
    'MAX_EXECUTION_TIME 只约束 SELECT；SHOW 等语句只受客户端超时约束',
    '敏感列按列名/原始列名匹配端点 sensitive_columns 脱敏；选择列表中引用敏感列的表达式/别名、UNION 对应位置、引用敏感列的派生表/CTE、非首个 UNION 分支或派生表/CTE 中的 * 会保守地整列脱敏；语句可能读取敏感列时，服务端错误信息与 EXPLAIN 条件中的字面量替换为 ?；仍不能替代数据库侧的列权限或脱敏视图',
    'SQL 来源二选一：--sql（内联，≤256KB）或 --sql-file；两者走同一静态检查；拒绝 MAX_EXECUTION_TIME / SET_VAR / RESOURCE_GROUP 优化器提示',
  ],
  examples: [
    'workctl mysql query execute --instance demo-mysql --database demo --sql "SELECT id, status FROM orders WHERE customer_id = 42" --max-rows 20',
    'workctl mysql query execute --instance demo-mysql --database demo --sql-file ./q.sql --max-rows 20',
  ],
  handler: async (ctx, i) => {
    const { text } = sqlText(i);
    const g = guardSql(text, 'execute');
    const maxRows = Math.max(1, Math.min(Number(i.max_rows), 1000));
    return withMysql(
      ctx,
      i.instance,
      async (s) => {
        const limitMs = maxExecMs(s);
        await s.query(`SET SESSION sql_select_limit = ${maxRows + 1}`);
        await enterReadOnly(s, limitMs);
        const started = Date.now();
        let r: Awaited<ReturnType<typeof streamRows>>;
        try {
          r = await streamRows(s, g.sql, maxRows, Math.min(limitMs + 3000, ctx.remainingMs()));
        } catch (e) {
          throw redactErrorValues(e, g.tokens, sensitiveColumns(s.ep));
        }
        const elapsed = Date.now() - started;
        if (!r.truncated) await rollbackQuietly(s);
        const hitLimit = elapsed >= limitMs * 0.98 && g.statement_type === 'SELECT';
        const warnings = hitLimit ? [`耗时 ${elapsed}ms 达到 MAX_EXECUTION_TIME=${limitMs}ms，语句可能被中断（如 SLEEP() 被中断时返回 1），结果可能不完整`] : [];
        const sens = sensitiveColumns(s.ep);
        // metadata names catch direct references; the token analysis catches expressions/aliases,
        // UNION branches and derived tables built from sensitive columns
        const flow = sensitiveOutputPlan(g.tokens, sens);
        const columns = r.fields.map((f, idx) => {
          const masked =
            sens.has(String(f.name).toLowerCase()) || (!!f.orgName && sens.has(String(f.orgName).toLowerCase())) || flow.all || flow.positions.has(idx);
          return { name: String(f.name), type: typeName(f), table: f.orgTable || f.table || null, source_column: f.orgName || null, masked };
        });
        let cellTruncated = 0;
        // EXPLAIN [FORMAT=TREE|JSON] text can carry const-table row values in its conditions
        const planText = ['EXPLAIN', 'DESCRIBE', 'DESC'].includes(g.leading) && mayReadSensitive(g.tokens, sens);
        const rows = r.rows.map((row) =>
          row.map((v, idx) => {
            if (columns[idx]?.masked) return maskValue(v);
            if (planText && typeof v === 'string') v = maskPlanText(v);
            const c = cell(v);
            if (c.truncated) cellTruncated++;
            return c.value;
          }),
        );
        const maskedCols = columns.filter((c) => c.masked).map((c) => c.name);
        return {
          data: {
            instance: s.ep.name,
            database: String(i.database),
            statement_type: g.statement_type,
            columns,
            rows,
            row_count: rows.length,
            max_rows: maxRows,
            truncated: r.truncated,
            masked_columns: maskedCols,
            guards: { static_check: 'passed' as const, read_only_transaction: true, max_execution_time_ms: limitMs, sql_select_limit: maxRows + 1 },
            elapsed_ms: elapsed,
          },
          warnings,
          sources: [s.src(`START TRANSACTION READ ONLY; ${g.statement_type} (guarded)`)],
          coverage: {
            complete: !r.truncated && cellTruncated === 0 && !hitLimit,
            truncated: r.truncated || cellTruncated > 0,
            limit: maxRows,
            notes: [
              ...(r.truncated ? [`结果超过 ${maxRows} 行，只返回前 ${maxRows} 行（已停止读取剩余行）`] : []),
              ...(cellTruncated ? [`${cellTruncated} 个单元格超过 2048 字符被截断`] : []),
              ...(hitLimit ? ['达到执行时间上限，结果可能不完整'] : []),
              ...(planText ? [CONDITION_MASK_NOTE] : []),
              ...(maskedCols.length ? [`已脱敏列: ${maskedCols.join(', ')}（按端点 sensitive_columns${flow.reasons.length ? `；${flow.reasons.join('；')}` : ''}）`] : []),
            ],
          },
        };
      },
      { database: String(i.database) },
    );
  },
});

export const queryExplain = defineCapability({
  name: 'mysql.query.explain',
  command: 'mysql query explain',
  summary: '查看语句的执行计划（EXPLAIN FORMAT=JSON，不执行语句），附扁平化摘要',
  domain: 'mysql',
  inputs: { instance: INSTANCE, database: DATABASE, sql: SQL_INLINE, sql_file: SQL_FILE },
  output: z.object({
    instance: z.string(),
    database: z.string(),
    statement_type: z.string(),
    estimate_only: z.literal(true).describe('优化器估计，非实际执行'),
    summary: z.object({
      query_cost: z.number().nullable(),
      full_scans: z.array(z.string()).describe('access_type=ALL 的表（全表扫描）'),
      full_index_scans: z.array(z.string()).describe('access_type=index 的表（遍历整个索引）'),
      using_filesort: z.boolean(),
      using_temporary_table: z.boolean(),
      tables: z.array(
        z.object({
          table: z.string(),
          select_id: z.number().nullable(),
          access_type: z.string().nullable(),
          possible_keys: z.array(z.string()).nullable(),
          key: z.string().nullable(),
          used_key_parts: z.array(z.string()).nullable(),
          key_length: z.string().nullable(),
          rows_examined_per_scan: z.number().nullable(),
          rows_produced_per_join: z.number().nullable(),
          filtered: z.number().nullable(),
          using_index: z.boolean(),
          using_filesort: z.boolean(),
          using_temporary_table: z.boolean(),
          attached_condition: z.string().nullable(),
          prefix_cost: z.number().nullable(),
        }),
      ),
    }),
    plan: z.unknown().describe('EXPLAIN FORMAT=JSON 原文（解析后的 JSON）'),
  }),
  adapter: ADAPTER,
  operation: 'read',
  auth_provider: AUTH_PROVIDER,
  guide: GUIDE,
  prerequisites: [...COMMON_PREREQS, 'EXPLAIN 需要与执行该语句相同的权限（只读账号 EXPLAIN UPDATE/DELETE 会被拒绝）'],
  notes: [
    '优化器估计，非实际执行：rows_examined_per_scan / filtered / cost 都是估计值；实际耗时用 mysql query analyze（会执行语句）',
    '只接受单条语句；带 EXPLAIN ANALYZE 前缀的输入会被拒绝',
    'SQL 来源二选一：--sql（内联，≤256KB）或 --sql-file',
  ],
  examples: [
    'workctl mysql query explain --instance demo-mysql --database demo --sql "SELECT * FROM orders WHERE customer_id = 42"',
    'workctl mysql query explain --instance demo-mysql --database demo --sql-file ./q.sql',
  ],
  handler: async (ctx, i) => {
    const { text } = sqlText(i);
    const g = guardSql(text, 'explain');
    return withMysql(
      ctx,
      i.instance,
      async (s) => {
        // EXPLAIN evaluates const subqueries / derived tables while optimizing (verified live:
        // EXPLAIN ... WHERE id = (SELECT 1 FROM (SELECT SLEEP(3)) x) took 3.4s), so bound it too
        const limitMs = maxExecMs(s);
        await s.query(`SET SESSION MAX_EXECUTION_TIME = ${Math.floor(limitMs)}`);
        const rows = await s.query(`EXPLAIN FORMAT=JSON ${g.sql}`, undefined, { timeoutMs: limitMs + 3000 });
        const raw = rows[0]?.EXPLAIN;
        if (raw === undefined) throw new WorkError('UPSTREAM_UNAVAILABLE', 'EXPLAIN 没有返回计划');
        const redact = mayReadSensitive(g.tokens, sensitiveColumns(s.ep));
        let plan: unknown;
        try {
          plan = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch {
          throw new WorkError('UNSUPPORTED', '无法解析 EXPLAIN FORMAT=JSON 输出', { details: { sample: redact ? '(已隐藏)' : String(raw).slice(0, 200) } });
        }
        if (redact) plan = maskPlanConditions(plan);
        return {
          data: {
            instance: s.ep.name,
            database: String(i.database),
            statement_type: g.statement_type,
            estimate_only: true as const,
            summary: flattenExplain(plan),
            plan,
          },
          sources: [s.src('EXPLAIN FORMAT=JSON', 'derived')],
          coverage: { complete: true, notes: ['优化器估计，非实际执行', ...(redact ? [CONDITION_MASK_NOTE] : [])] },
        };
      },
      { database: String(i.database) },
    );
  },
});

export const queryAnalyze = defineCapability({
  name: 'mysql.query.analyze',
  command: 'mysql query analyze',
  summary: '用 EXPLAIN ANALYZE 实际执行 SELECT 并返回各算子的实际耗时与行数（只读事务 + 执行时间上限）',
  domain: 'mysql',
  inputs: { instance: INSTANCE, database: DATABASE, sql: SQL_INLINE, sql_file: SQL_FILE },
  output: z.object({
    instance: z.string(),
    database: z.string(),
    statement_type: z.string(),
    executed: z.literal(true).describe('EXPLAIN ANALYZE 会实际执行语句'),
    tree: z.string().describe('EXPLAIN ANALYZE 原始 TREE 输出'),
    nodes: z.array(
      z.object({
        depth: z.number(),
        operation: z.string(),
        estimated_cost: z.number().nullable(),
        estimated_rows: z.number().nullable(),
        actual_first_row_ms: z.number().nullable(),
        actual_last_row_ms: z.number().nullable(),
        actual_rows: z.number().nullable(),
        loops: z.number().nullable(),
        never_executed: z.boolean(),
      }),
    ),
    elapsed_ms: z.number().describe('客户端测得的总耗时（含网络）'),
    guards: z.object({ read_only_transaction: z.boolean(), max_execution_time_ms: z.number() }),
  }),
  adapter: ADAPTER,
  operation: 'diagnose',
  auth_provider: AUTH_PROVIDER,
  guide: GUIDE,
  prerequisites: [...COMMON_PREREQS],
  notes: [
    'EXPLAIN ANALYZE 会实际执行语句（消耗实例资源、读取数据），只允许 SELECT；在只读事务中执行并受 MAX_EXECUTION_TIME 约束',
    'actual time 单位为毫秒，是每次 loop 的平均值；rows 也是每次 loop 的平均值',
    '结果集本身不返回，只返回计划与实际统计',
    'SQL 来源二选一：--sql（内联，≤256KB）或 --sql-file；拒绝 MAX_EXECUTION_TIME / SET_VAR / RESOURCE_GROUP 优化器提示',
  ],
  examples: [
    'workctl mysql query analyze --instance demo-mysql --database demo --sql "SELECT * FROM orders WHERE customer_id = 42"',
    'workctl mysql query analyze --instance demo-mysql --database demo --sql-file ./q.sql',
  ],
  handler: async (ctx, i) => {
    const { text } = sqlText(i);
    const g = guardSql(text, 'analyze');
    return withMysql(
      ctx,
      i.instance,
      async (s) => {
        const limitMs = maxExecMs(s);
        await enterReadOnly(s, limitMs);
        const started = Date.now();
        let rows;
        try {
          rows = await s.query(`EXPLAIN ANALYZE ${g.sql}`, undefined, { timeoutMs: limitMs + 3000 });
        } catch (e) {
          throw redactErrorValues(e, g.tokens, sensitiveColumns(s.ep));
        } finally {
          await rollbackQuietly(s);
        }
        const elapsed = Date.now() - started;
        const rawTree = String(rows[0]?.EXPLAIN ?? '');
        const redact = mayReadSensitive(g.tokens, sensitiveColumns(s.ep));
        const tree = redact ? maskPlanTree(rawTree) : rawTree;
        if (/maximum statement execution time exceeded|interrupted/i.test(tree)) {
          throw new WorkError('TIMEOUT', `语句超过执行时间上限 ${limitMs}ms`, { hint: '缩小查询范围，或先用 mysql query explain 查看估计计划' });
        }
        return {
          warnings: elapsed >= limitMs * 0.98 ? [`耗时 ${elapsed}ms 达到 MAX_EXECUTION_TIME=${limitMs}ms，执行可能被中断，实际统计可能不完整`] : [],
          data: {
            instance: s.ep.name,
            database: String(i.database),
            statement_type: g.statement_type,
            executed: true as const,
            tree,
            nodes: parseAnalyzeTree(tree),
            elapsed_ms: elapsed,
            guards: { read_only_transaction: true, max_execution_time_ms: limitMs },
          },
          sources: [s.src('EXPLAIN ANALYZE (read-only transaction)')],
          coverage: { complete: true, notes: ['语句已实际执行一次；实际耗时受缓存命中（buffer pool）影响，重复执行可能更快', ...(redact ? [CONDITION_MASK_NOTE] : [])] },
        };
      },
      { database: String(i.database) },
    );
  },
});
