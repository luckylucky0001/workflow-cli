import { z } from 'zod';
import { WorkError } from '../../../core/output';
import { defineCapability } from '../../../core/registry';
import { ADAPTER, AUTH_PROVIDER, GUIDE, endpointStatementTimeout, num, sensitiveColumns, withPg, type PgSession } from '../client';
import { COMMON_PREREQS, DATABASE_OPT, INSTANCE, SQL_FILE, SQL_INLINE, sqlText } from '../inputs';
import { cell, guardPg, maskValue, type GuardResult } from '../sql-guard';

function limitMs(s: PgSession, ctxRemaining: number): number {
  return Math.max(100, Math.min(endpointStatementTimeout(s.ep), ctxRemaining - 500));
}

/**
 * The static guard lexes '...' with standard_conforming_strings=on. With it off (settable per role /
 * database) the server treats `\'` as an escaped quote, so `SELECT '\'' ; <stmt> -- '` is one string to
 * the guard but two statements to the server: refuse instead of running unguarded text.
 */
export async function assertStandardStrings(s: Pick<PgSession, 'query' | 'ep'>): Promise<void> {
  const [r] = await s.query("SELECT current_setting('standard_conforming_strings') AS scs");
  if (String(r?.scs) !== 'on') {
    throw new WorkError('UNSUPPORTED', `会话的 standard_conforming_strings=${String(r?.scs)}，SQL 静态检查假定为 on，拒绝执行 (${s.ep.id})`, {
      hint: '为 workctl 使用的角色/库设置 standard_conforming_strings=on（PostgreSQL 9.1 起的默认值）',
      details: { endpoint: s.ep.id, standard_conforming_strings: r?.scs ?? null },
    });
  }
}

/** BEGIN READ ONLY + SET LOCAL statement_timeout. The role's own default_transaction_read_only is a further layer. */
async function beginReadOnly(s: PgSession, ms: number): Promise<void> {
  await assertStandardStrings(s);
  await s.query('BEGIN TRANSACTION READ ONLY');
  await s.query(`SET LOCAL statement_timeout = ${Math.floor(ms)}`);
  await s.query('SET LOCAL lock_timeout = 2000');
  await s.query("SET LOCAL idle_in_transaction_session_timeout = '60s'");
}

async function rollbackQuietly(s: PgSession): Promise<void> {
  try {
    await s.query('ROLLBACK');
  } catch {
    /* connection may already be closed */
  }
}

/** Lower-cased words and identifiers of the statement (candidate column / relation names). */
function statementNames(g: GuardResult): string[] {
  return [...new Set(g.tokens.filter((t) => t.kind === 'word' || t.kind === 'ident').map((t) => (t.kind === 'word' ? t.text.toLowerCase() : t.upper)))];
}

/** Relations named in the statement that carry a sensitive column (names are lower-cased, quoted ones too: match case-insensitively). */
async function sensitiveRelations(s: PgSession, names: string[], sens: Set<string>): Promise<string[]> {
  if (!sens.size || !names.length) return [];
  const rows = await s.query(
    `SELECT DISTINCT c.relname FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE lower(c.relname) = ANY($1::text[]) AND c.relkind IN ('r','p','v','m','f') AND a.attnum > 0 AND NOT a.attisdropped
        AND lower(a.attname) = ANY($2::text[]) ORDER BY 1`,
    [names, [...sens]],
  );
  return rows.map((x) => String(x.relname));
}

/**
 * PostgreSQL error text quotes the offending value (`invalid input syntax for type integer: "+86-138…"`,
 * `relation "…" does not exist` for `phone::regclass`; DETAIL may carry it unquoted), so an error over a
 * sensitive column would bypass masking: hide quoted text and drop DETAIL/HINT.
 */
export function redactErrorValues(e: WorkError): WorkError {
  const scrub = (t: unknown) => (typeof t === 'string' ? t.replace(/"(?:[^"]|"")*"/g, '"***"').replace(/'(?:[^']|'')*'/g, "'***'") : t);
  const { server_detail, server_hint, ...rest } = e.details ?? {};
  if (scrub(e.message) === e.message && scrub(rest.reason) === rest.reason && server_detail === undefined && server_hint === undefined) return e;
  return new WorkError(e.code, String(scrub(e.message)), {
    hint: `${e.hint ? `${e.hint}；` : ''}语句涉及敏感列，错误信息中引号内的值已隐藏${server_detail !== undefined || server_hint !== undefined ? '，DETAIL/HINT 已省略' : ''}`,
    details: { ...rest, ...(rest.reason !== undefined ? { reason: scrub(rest.reason) } : {}), ...(server_detail !== undefined || server_hint !== undefined ? { server_detail_redacted: true } : {}) },
  });
}

/** Redact a server error raised while executing `g` when the statement touches sensitive columns (call after ROLLBACK). */
async function redactIfSensitive(s: PgSession, g: GuardResult, e: unknown): Promise<unknown> {
  const sens = sensitiveColumns(s.ep);
  if (!(e instanceof WorkError) || !sens.size || e.details?.sql_state === undefined) return e;
  const names = statementNames(g);
  let touches = names.some((n) => sens.has(n));
  if (!touches) {
    try {
      touches = (await sensitiveRelations(s, names, sens)).length > 0;
    } catch {
      touches = true;
    }
  }
  return touches ? redactErrorValues(e) : e;
}

export interface PlanNodeSummary {
  depth: number;
  node_type: string;
  relation: string | null;
  alias: string | null;
  index: string | null;
  join_type: string | null;
  startup_cost: number | null;
  total_cost: number | null;
  plan_rows: number | null;
  filter: string | null;
  index_cond: string | null;
  actual_total_ms?: number | null;
  actual_rows?: number | null;
  loops?: number | null;
  rows_removed_by_filter?: number | null;
  shared_hit_blocks?: number | null;
  shared_read_blocks?: number | null;
  never_executed?: boolean;
}

/** Flatten EXPLAIN (FORMAT JSON) output into a node list + quick findings. */
export function flattenPlan(plan: unknown, analyzed: boolean): {
  total_cost: number | null;
  plan_rows: number | null;
  seq_scans: string[];
  index_scans: string[];
  sorts: number;
  nodes: PlanNodeSummary[];
  planning_ms: number | null;
  execution_ms: number | null;
} {
  const root = Array.isArray(plan) ? (plan[0] as Record<string, any>) : (plan as Record<string, any>);
  const top = root?.Plan as Record<string, any> | undefined;
  const nodes: PlanNodeSummary[] = [];
  const walk = (n: Record<string, any>, depth: number) => {
    const node: PlanNodeSummary = {
      depth,
      node_type: String(n['Node Type'] ?? 'unknown'),
      relation: n['Relation Name'] ?? null,
      alias: n['Alias'] ?? null,
      index: n['Index Name'] ?? null,
      join_type: n['Join Type'] ?? null,
      startup_cost: num(n['Startup Cost']),
      total_cost: num(n['Total Cost']),
      plan_rows: num(n['Plan Rows']),
      filter: n['Filter'] ?? null,
      index_cond: n['Index Cond'] ?? n['Recheck Cond'] ?? null,
    };
    if (analyzed) {
      const loops = num(n['Actual Loops']);
      node.actual_total_ms = num(n['Actual Total Time']);
      node.actual_rows = num(n['Actual Rows']);
      node.loops = loops;
      node.rows_removed_by_filter = num(n['Rows Removed by Filter']);
      node.shared_hit_blocks = num(n['Shared Hit Blocks']);
      node.shared_read_blocks = num(n['Shared Read Blocks']);
      node.never_executed = loops === 0;
    }
    nodes.push(node);
    for (const c of (n.Plans as Record<string, any>[] | undefined) ?? []) walk(c, depth + 1);
  };
  if (top) walk(top, 0);
  const rel = (x: PlanNodeSummary) => x.relation ?? x.alias ?? '?';
  return {
    total_cost: num(top?.['Total Cost']),
    plan_rows: num(top?.['Plan Rows']),
    seq_scans: nodes.filter((x) => x.node_type === 'Seq Scan' || x.node_type === 'Parallel Seq Scan').map(rel),
    index_scans: nodes.filter((x) => /Index/.test(x.node_type)).map((x) => `${rel(x)}:${x.index ?? '?'}`),
    sorts: nodes.filter((x) => x.node_type === 'Sort' || x.node_type === 'Incremental Sort').length,
    nodes,
    planning_ms: num(root?.['Planning Time']),
    execution_ms: num(root?.['Execution Time']),
  };
}

function parsePlanCell(rows: Record<string, unknown>[]): unknown {
  const raw = rows[0]?.['QUERY PLAN'];
  if (raw === undefined) throw new WorkError('UPSTREAM_UNAVAILABLE', 'EXPLAIN 没有返回计划');
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      throw new WorkError('UNSUPPORTED', '无法解析 EXPLAIN (FORMAT JSON) 输出', { details: { sample: raw.slice(0, 200) } });
    }
  }
  return raw;
}

const PlanSummarySchema = z.object({
  total_cost: z.number().nullable(),
  plan_rows: z.number().nullable(),
  seq_scans: z.array(z.string()).describe('Seq Scan 的表（全表顺序扫描）'),
  index_scans: z.array(z.string()).describe('表:索引'),
  sorts: z.number(),
  planning_ms: z.number().nullable(),
  execution_ms: z.number().nullable(),
});

const NodeSchema = z.object({
  depth: z.number(),
  node_type: z.string(),
  relation: z.string().nullable(),
  alias: z.string().nullable(),
  index: z.string().nullable(),
  join_type: z.string().nullable(),
  startup_cost: z.number().nullable(),
  total_cost: z.number().nullable(),
  plan_rows: z.number().nullable().describe('优化器估计行数'),
  filter: z.string().nullable(),
  index_cond: z.string().nullable(),
  actual_total_ms: z.number().nullable().optional().describe('仅 analyze：每次 loop 的平均耗时（毫秒）'),
  actual_rows: z.number().nullable().optional().describe('仅 analyze：每次 loop 的平均行数'),
  loops: z.number().nullable().optional(),
  rows_removed_by_filter: z.number().nullable().optional(),
  shared_hit_blocks: z.number().nullable().optional(),
  shared_read_blocks: z.number().nullable().optional(),
  never_executed: z.boolean().optional(),
});

function summaryOf(f: ReturnType<typeof flattenPlan>) {
  const { nodes: _n, ...rest } = f;
  return rest;
}

export const queryExplain = defineCapability({
  name: 'postgres.query.explain',
  command: 'pg query explain',
  summary: '查看语句的执行计划（EXPLAIN (FORMAT JSON)，不执行语句，只是优化器估计），附扁平化摘要',
  domain: 'postgres',
  inputs: { instance: INSTANCE, database: DATABASE_OPT, sql: SQL_INLINE, sql_file: SQL_FILE },
  output: z.object({
    instance: z.string(),
    database: z.string(),
    statement_type: z.string(),
    estimate_only: z.literal(true).describe('优化器估计，非实际执行'),
    generic_plan: z.boolean().describe('语句含 $n 占位符时用 GENERIC_PLAN（PG16+）生成通用计划'),
    summary: PlanSummarySchema,
    nodes: z.array(NodeSchema),
    plan: z.unknown().describe('EXPLAIN (FORMAT JSON) 原文（解析后的 JSON）'),
  }),
  adapter: ADAPTER,
  operation: 'read',
  auth_provider: AUTH_PROVIDER,
  guide: GUIDE,
  prerequisites: [...COMMON_PREREQS, 'EXPLAIN 需要对涉及的表有相应权限（只读角色 EXPLAIN UPDATE/DELETE 会因缺 UPDATE/DELETE 权限被拒绝）'],
  notes: [
    '优化器估计，非实际执行：cost / plan_rows 都是基于统计信息的估计；实际耗时与行数用 pg query analyze（会执行语句）',
    '只接受单条语句，不要带 EXPLAIN 前缀；含 $1 等占位符（如 pg_stat_statements 中的归一化语句）时在 PG16+ 使用 GENERIC_PLAN',
    '在 READ ONLY 事务中执行并随后回滚；SQL 来源二选一：--sql（内联，≤256KB）或 --sql-file',
  ],
  examples: [
    'workctl pg query explain --instance demo-postgres --sql "SELECT * FROM orders WHERE customer_id = 42"',
    'workctl pg query explain --instance demo-postgres --database demo_orders --sql-file ./q.sql',
  ],
  handler: async (ctx, i) => {
    const g = guardPg(sqlText(i), 'explain');
    return withPg(
      ctx,
      i.instance,
      async (s) => {
        const generic = g.has_params;
        if (generic && s.versionNum < 160000) {
          throw new WorkError('UNSUPPORTED', `语句含 $n 占位符，需要 PostgreSQL 16+ 的 EXPLAIN (GENERIC_PLAN)，当前 ${s.version}`, { hint: '把占位符替换为具体值后再分析' });
        }
        await beginReadOnly(s, limitMs(s, ctx.remainingMs()));
        let rows;
        try {
          const text = `EXPLAIN (${generic ? 'GENERIC_PLAN, ' : ''}FORMAT JSON) ${g.sql}`;
          if (generic) {
            // extended protocol needs a value for every $n, and bound values turn the plan into a custom
            // one (NULL folds to "One-Time Filter: false"). So: let the server parse the exact text as one
            // command via the extended protocol first (result discarded), then plan it generically.
            const maxParam = Math.max(0, ...g.tokens.filter((t) => t.kind === 'param').map((t) => Number(t.text.slice(1)) || 0));
            await s.queryUser(text, new Array(maxParam).fill(null));
            rows = await s.query(text);
          } else {
            rows = await s.queryUser(text);
          }
        } finally {
          await rollbackQuietly(s);
        }
        const plan = parsePlanCell(rows);
        const flat = flattenPlan(plan, false);
        return {
          data: {
            instance: s.ep.name,
            database: s.database,
            statement_type: g.statement_type,
            estimate_only: true as const,
            generic_plan: generic,
            summary: summaryOf(flat),
            nodes: flat.nodes,
            plan,
          },
          sources: [s.src(`EXPLAIN (${generic ? 'GENERIC_PLAN, ' : ''}FORMAT JSON)`, 'derived')],
          coverage: { complete: true, notes: ['优化器估计，非实际执行'] },
        };
      },
      { database: i.database },
    );
  },
});

export const queryAnalyze = defineCapability({
  name: 'postgres.query.analyze',
  command: 'pg query analyze',
  summary: '用 EXPLAIN ANALYZE 实际执行 SELECT 并返回各节点的实际耗时、行数与缓冲区命中（READ ONLY 事务 + statement_timeout，结束后回滚）',
  domain: 'postgres',
  inputs: { instance: INSTANCE, database: DATABASE_OPT, sql: SQL_INLINE, sql_file: SQL_FILE },
  output: z.object({
    instance: z.string(),
    database: z.string(),
    statement_type: z.string(),
    executed: z.literal(true).describe('EXPLAIN ANALYZE 会实际执行语句'),
    summary: PlanSummarySchema,
    nodes: z.array(NodeSchema),
    plan: z.unknown(),
    elapsed_ms: z.number().describe('客户端测得的总耗时（含网络）'),
    guards: z.object({ read_only_transaction: z.literal(true), statement_timeout_ms: z.number(), rolled_back: z.literal(true) }),
  }),
  adapter: ADAPTER,
  operation: 'diagnose',
  auth_provider: AUTH_PROVIDER,
  guide: GUIDE,
  prerequisites: [...COMMON_PREREQS, '端点 statement_timeout_ms（默认 10000）'],
  notes: [
    'EXPLAIN ANALYZE 会实际执行语句（消耗实例资源、读取数据），只允许 SELECT / WITH...SELECT / VALUES / TABLE；在 READ ONLY 事务中执行、受 statement_timeout 约束，结束后 ROLLBACK',
    'actual_total_ms / actual_rows 是每次 loop 的平均值；节点总量 ≈ 值 × loops',
    '结果集本身不返回，只返回计划与实际统计；实际耗时受缓存（shared_buffers / OS cache）影响，重复执行可能更快',
    'SQL 来源二选一：--sql（内联，≤256KB）或 --sql-file',
  ],
  examples: [
    'workctl pg query analyze --instance demo-postgres --sql "SELECT * FROM orders WHERE customer_id = 42"',
    'workctl pg query analyze --instance demo-postgres --database demo_orders --sql-file ./q.sql',
  ],
  handler: async (ctx, i) => {
    const g = guardPg(sqlText(i), 'analyze');
    if (g.has_params) throw new WorkError('INVALID_ARGUMENT', 'query analyze 会实际执行语句，不能包含 $n 占位符', { hint: '把占位符替换为具体值；只看估计计划可用 pg query explain' });
    return withPg(
      ctx,
      i.instance,
      async (s) => {
        const ms = limitMs(s, ctx.remainingMs());
        await beginReadOnly(s, ms);
        const started = Date.now();
        let rows;
        try {
          rows = await s.queryUser(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${g.sql}`);
        } catch (e) {
          await rollbackQuietly(s);
          throw await redactIfSensitive(s, g, e);
        } finally {
          await rollbackQuietly(s);
        }
        const elapsed = Date.now() - started;
        const plan = parsePlanCell(rows);
        const flat = flattenPlan(plan, true);
        return {
          data: {
            instance: s.ep.name,
            database: s.database,
            statement_type: g.statement_type,
            executed: true as const,
            summary: summaryOf(flat),
            nodes: flat.nodes,
            plan,
            elapsed_ms: elapsed,
            guards: { read_only_transaction: true as const, statement_timeout_ms: ms, rolled_back: true as const },
          },
          sources: [s.src('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) in READ ONLY transaction')],
          coverage: { complete: true, notes: ['语句已实际执行一次并回滚；实际耗时受缓存命中影响'] },
        };
      },
      { database: i.database },
    );
  },
});

const SELECT_LIST_END = new Set(['FROM', 'INTO', 'WHERE', 'GROUP', 'HAVING', 'WINDOW', 'ORDER', 'LIMIT', 'OFFSET', 'FETCH', 'FOR']);

/**
 * For each item of the outermost SELECT list: whether it is a plain row count — `count(*)`,
 * `count(x)`, `count(DISTINCT x)` (optionally `OVER (...)` / `OVER w`, optionally aliased) — whose
 * value cannot reproduce column values. null when items cannot be matched to output columns
 * (set operations, `*` expansion, VALUES/TABLE, no top-level SELECT).
 */
export function plainCountItems(g: GuardResult): boolean[] | null {
  const t = g.tokens;
  if (t.some((x) => x.depth === 0 && x.kind === 'word' && ['UNION', 'INTERSECT', 'EXCEPT'].includes(x.upper))) return null;
  const sel = t.findIndex((x) => x.depth === 0 && x.kind === 'word' && x.upper === 'SELECT');
  if (sel < 0) return null;
  let i = sel + 1;
  if (t[i]?.kind === 'word' && t[i].upper === 'ALL') i++;
  else if (t[i]?.kind === 'word' && t[i].upper === 'DISTINCT') {
    i++;
    if (t[i]?.kind === 'word' && t[i].upper === 'ON' && t[i + 1]?.text === '(') {
      i += 2;
      while (i < t.length && !(t[i].text === ')' && t[i].depth === 0)) i++;
      i++;
    }
  }
  const items: (typeof t)[] = [[]];
  for (; i < t.length; i++) {
    const x = t[i];
    if (x.depth === 0 && x.kind === 'word' && SELECT_LIST_END.has(x.upper)) break;
    if (x.depth === 0 && x.kind === 'punct' && x.text === ',') items.push([]);
    else items[items.length - 1].push(x);
  }
  const isCount = (it: typeof t): boolean => {
    if (it.length < 3 || it[0].kind !== 'word' || it[0].upper !== 'COUNT' || it[1].text !== '(') return false;
    let j = 2;
    if (it[j]?.text === '*' && it[j + 1]?.text === ')' && it[j + 1].depth === 0) j += 2;
    else {
      while (j < it.length && !(it[j].text === ')' && it[j].depth === 0)) j++;
      if (j >= it.length || j === 2) return false;
      j++;
    }
    if (it[j]?.kind === 'word' && it[j].upper === 'OVER') {
      j++;
      if (it[j]?.text === '(') {
        while (j < it.length && !(it[j].text === ')' && it[j].depth === 0)) j++;
        if (j >= it.length) return false;
        j++;
      } else if (it[j]?.kind === 'word' || it[j]?.kind === 'ident') j++;
      else return false;
    }
    if (it[j]?.kind === 'word' && it[j].upper === 'AS') j++;
    if (j < it.length && (it[j].kind === 'word' || it[j].kind === 'ident')) j++;
    return j === it.length;
  };
  const isStar = (it: typeof t) => it.length > 0 && it[it.length - 1].text === '*' && (it.length === 1 || it[it.length - 2].text === '.');
  if (items.some((it) => !it.length || isStar(it))) return null;
  return items.map(isCount);
}

/**
 * Output column masking. Once the statement references a sensitive column (by name) or a relation
 * that carries one (whole-row `c`, `c::text`, `row_to_json(c)`, `*`), every column that does not
 * resolve to a non-sensitive source column is masked, whatever its type (`ascii(substr(phone,1,1))`,
 * `regexp_replace(c::text,'\D','','g')::numeric` are numeric and still leak digits) — except plain
 * row counts (`count(*)` / `count(x)` / `count(DISTINCT x)`, see {@link plainCountItems}).
 */
export function maskedColumns(
  fields: { name: string; tableID: number; columnID: number; dataTypeID?: number }[],
  sourceNames: Map<string, string>,
  sensitive: Set<string>,
  g: GuardResult,
  rel: { sensitiveRelations: string[]; categoryOf: (oid: number) => string | undefined } = { sensitiveRelations: [], categoryOf: () => undefined },
): { masked: boolean[]; reasons: string[] } {
  const mentioned = g.tokens.filter((t) => (t.kind === 'word' && sensitive.has(t.text.toLowerCase())) || (t.kind === 'ident' && sensitive.has(t.upper))).map((t) => (t.kind === 'word' ? t.text.toLowerCase() : t.upper));
  const reasons: string[] = [];
  const counts = mentioned.length || rel.sensitiveRelations.length ? plainCountItems(g) : null;
  const countOk = counts?.length === fields.length ? counts : null;
  const masked = fields.map((f, idx) => {
    if (sensitive.has(f.name.toLowerCase())) return true;
    const src = f.tableID ? sourceNames.get(`${f.tableID}:${f.columnID}`) : undefined;
    if (src && sensitive.has(src.toLowerCase())) {
      reasons.push(`${f.name} 来自敏感列 ${src}`);
      return true;
    }
    if (src) return false;
    // no resolvable source column: expression, constant, or whole-row reference (tableID set, columnID 0)
    if (!mentioned.length && !rel.sensitiveRelations.length) return false;
    // count() returns bigint (int8, oid 20); anything else under that name is not the built-in aggregate
    if (countOk?.[idx] && (f.dataTypeID === undefined || f.dataTypeID === 20)) return false;
    const why = mentioned.length ? `语句引用了敏感列 ${[...new Set(mentioned)].join(', ')}` : `语句涉及含敏感列的表 ${rel.sensitiveRelations.join(', ')}`;
    reasons.push(`${f.name} 是表达式/派生列（不论类型），而${why}；只有 count(*) / count(x) / count(DISTINCT x) 不脱敏（保守脱敏）`);
    return true;
  });
  return { masked, reasons };
}

export const queryRun = defineCapability({
  name: 'postgres.query.run',
  command: 'pg query run',
  summary: '受限只读查询：单条 SELECT/WITH/VALUES/TABLE，READ ONLY 事务 + statement_timeout + 游标取行上限 + 敏感列脱敏',
  domain: 'postgres',
  inputs: {
    instance: INSTANCE,
    database: DATABASE_OPT,
    sql: SQL_INLINE,
    sql_file: SQL_FILE,
    max_rows: { type: 'int', default: 20, description: '最多返回行数（上限 1000）；超出时 truncated=true' },
  },
  output: z.object({
    instance: z.string(),
    database: z.string(),
    statement_type: z.string(),
    columns: z.array(z.object({ name: z.string(), type: z.string(), source_column: z.string().nullable(), masked: z.boolean() })),
    rows: z.array(z.array(z.unknown())).describe('按 columns 顺序排列的值；bigint/numeric 以字符串返回以保证精度，时间为服务端文本（UTC）'),
    row_count: z.number(),
    max_rows: z.number(),
    truncated: z.boolean(),
    masked_columns: z.array(z.string()),
    guards: z.object({
      static_check: z.literal('passed'),
      read_only_transaction: z.literal(true),
      statement_timeout_ms: z.number(),
      fetch_limit: z.number(),
    }),
    elapsed_ms: z.number(),
  }),
  adapter: ADAPTER,
  operation: 'read',
  auth_provider: AUTH_PROVIDER,
  guide: GUIDE,
  prerequisites: [...COMMON_PREREQS, '端点 statement_timeout_ms（默认 10000）与 sensitive_columns 配置'],
  notes: [
    '真正的权限边界是数据库角色（workctl_ro 只有 SELECT，且 default_transaction_read_only=on）；程序层静态检查、READ ONLY 事务、statement_timeout、行数上限是额外防线，不能替代只读角色',
    '静态检查：只允许单条 SELECT / WITH...SELECT / VALUES / TABLE；拒绝多语句、数据修改型 CTE、SELECT INTO、FOR UPDATE/SHARE，以及终止会话/读写文件/咨询锁/序列/重置统计/执行任意 SQL 文本的函数（不穷尽：自定义函数仍可能有副作用，由角色权限兜底）',
    '通过游标（DECLARE CURSOR + FETCH）只取 max_rows+1 行，不缓冲完整结果集',
    '敏感列：输出列名或其来源列（按系统目录解析，覆盖别名）命中端点 sensitive_columns 时脱敏；语句引用了敏感列、或涉及含敏感列的表（整行引用、row_to_json、c::text 等）时，所有无法解析到非敏感来源列的表达式列一律保守脱敏（不论类型：ascii(substr(phone,1,1))、regexp_replace(c::text,…)::numeric 同样会泄露），只有 count(*) / count(x) / count(DISTINCT x) 例外；不能替代数据库侧列权限或脱敏视图',
  ],
  examples: [
    'workctl pg query run --instance demo-postgres --sql "SELECT id, status, amount FROM orders WHERE customer_id = 42" --max-rows 20',
    'workctl pg query run --instance demo-postgres --database demo_orders --sql-file ./q.sql --max-rows 50',
  ],
  handler: async (ctx, i) => {
    const g = guardPg(sqlText(i), 'run');
    if (g.has_params) throw new WorkError('INVALID_ARGUMENT', '受限查询不支持 $n 占位符', { hint: '把占位符替换为具体值' });
    const maxRows = Math.max(1, Math.min(Number(i.max_rows), 1000));
    return withPg(
      ctx,
      i.instance,
      async (s) => {
        const ms = limitMs(s, ctx.remainingMs());
        await beginReadOnly(s, ms);
        const started = Date.now();
        let r: { rows: unknown[][]; fields: { name: string; tableID: number; columnID: number; dataTypeID: number }[] };
        try {
          await s.queryUser(`DECLARE workctl_cur NO SCROLL CURSOR FOR ${g.sql}`);
          r = await s.queryArrays(`FETCH FORWARD ${maxRows + 1} FROM workctl_cur`);
        } catch (e) {
          await rollbackQuietly(s);
          throw await redactIfSensitive(s, g, e);
        } finally {
          await rollbackQuietly(s);
        }
        const elapsed = Date.now() - started;
        const truncated = r.rows.length > maxRows;
        const rowsRaw = truncated ? r.rows.slice(0, maxRows) : r.rows;
        // resolve type names and source columns through the catalog (covers aliases)
        const typeIds = [...new Set(r.fields.map((f) => f.dataTypeID))];
        const types = typeIds.length ? await s.query('SELECT oid::int AS oid, format_type(oid, NULL) AS name, typcategory AS cat FROM pg_type WHERE oid = ANY($1::oid[])', [typeIds]) : [];
        const typeName = new Map(types.map((t) => [Number(t.oid), String(t.name)]));
        const typeCat = new Map(types.map((t) => [Number(t.oid), String(t.cat)]));
        const srcPairs = r.fields.filter((f) => f.tableID);
        const srcRows = srcPairs.length
          ? await s.query(
              'SELECT attrelid::int AS rel, attnum::int AS num, attname FROM pg_attribute WHERE (attrelid, attnum) IN (SELECT * FROM unnest($1::oid[], $2::int2[]))',
              [srcPairs.map((f) => f.tableID), srcPairs.map((f) => f.columnID)],
            )
          : [];
        const sourceNames = new Map(srcRows.map((x) => [`${x.rel}:${x.num}`, String(x.attname)]));
        const sens = sensitiveColumns(s.ep);
        // relations named in the statement that carry sensitive columns (for whole-row / computed outputs)
        const names = statementNames(g);
        const sensRel = r.fields.some((f) => !f.tableID || !f.columnID || !sourceNames.has(`${f.tableID}:${f.columnID}`)) ? await sensitiveRelations(s, names, sens) : [];
        const { masked, reasons } = maskedColumns(r.fields, sourceNames, sens, g, {
          sensitiveRelations: sensRel,
          categoryOf: (oid) => typeCat.get(oid),
        });
        const columns = r.fields.map((f, idx) => ({
          name: f.name,
          type: typeName.get(f.dataTypeID) ?? String(f.dataTypeID),
          source_column: f.tableID ? (sourceNames.get(`${f.tableID}:${f.columnID}`) ?? null) : null,
          masked: masked[idx],
        }));
        let cellTruncated = 0;
        const rows = rowsRaw.map((row) =>
          row.map((v, idx) => {
            if (columns[idx]?.masked) return maskValue(v);
            const c = cell(v);
            if (c.truncated) cellTruncated++;
            return c.value;
          }),
        );
        const maskedCols = columns.filter((c) => c.masked).map((c) => c.name);
        return {
          data: {
            instance: s.ep.name,
            database: s.database,
            statement_type: g.statement_type,
            columns,
            rows,
            row_count: rows.length,
            max_rows: maxRows,
            truncated,
            masked_columns: maskedCols,
            guards: { static_check: 'passed' as const, read_only_transaction: true as const, statement_timeout_ms: ms, fetch_limit: maxRows + 1 },
            elapsed_ms: elapsed,
          },
          sources: [s.src(`BEGIN READ ONLY; DECLARE CURSOR FOR ${g.statement_type}; FETCH ${maxRows + 1}`)],
          coverage: {
            complete: !truncated && cellTruncated === 0,
            truncated: truncated || cellTruncated > 0,
            limit: maxRows,
            notes: [
              ...(truncated ? [`结果超过 ${maxRows} 行，只返回前 ${maxRows} 行（游标未继续读取）`] : []),
              ...(cellTruncated ? [`${cellTruncated} 个单元格超过 2048 字符被截断`] : []),
              ...(maskedCols.length ? [`已脱敏列: ${maskedCols.join(', ')}（按端点 sensitive_columns${reasons.length ? `；${reasons.join('；')}` : ''}）`] : []),
            ],
          },
        };
      },
      { database: i.database },
    );
  },
});
