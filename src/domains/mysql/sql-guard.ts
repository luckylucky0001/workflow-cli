import { WorkError } from '../../core/output';

/**
 * Static SQL checks for the guarded query capabilities. This is the *program* layer of the
 * read boundary; the database account (e.g. workctl_ro without write privileges), the
 * read-only transaction and MAX_EXECUTION_TIME are the other layers. A lexer is used (not
 * regexes over raw text) so quotes, identifiers and comments cannot hide keywords.
 */

export interface Token {
  kind: 'word' | 'string' | 'ident' | 'number' | 'punct' | 'variable' | 'hint';
  text: string;
  /** Upper-cased text for words. */
  upper: string;
  depth: number;
}

export interface Lexed {
  /** SQL with comments removed (optimizer hints /*+ ... *\/ kept), trimmed, trailing `;` removed. */
  sql: string;
  tokens: Token[];
  statements: number;
}

const WORD = /[A-Za-z0-9_$\u0080-￿]/;

/** MySQL treats only ASCII space/control characters as whitespace (and after `--`); U+0080+ are identifier characters. */
function isSqlSpace(c: string | undefined): boolean {
  return c !== undefined && c.charCodeAt(0) <= 0x20;
}

/**
 * @param opts.backslashEscapes false = lex as the server does under NO_BACKSLASH_ESCAPES
 *   (backslash is an ordinary character inside quotes). guardSql checks both interpretations.
 */
export function lex(input: string, opts: { backslashEscapes?: boolean } = {}): Lexed {
  const backslashEscapes = opts.backslashEscapes ?? true;
  const tokens: Token[] = [];
  let out = '';
  let depth = 0;
  let statements = 0;
  let current = ''; // text of the current statement (for empty-statement detection)
  const flushStatement = () => {
    if (current.trim()) statements++;
    current = '';
  };
  let i = 0;
  const n = input.length;
  const push = (kind: Token['kind'], text: string) => {
    tokens.push({ kind, text, upper: kind === 'word' ? text.toUpperCase() : text, depth });
  };
  while (i < n) {
    const c = input[i];
    const next = input[i + 1];
    // comments
    if (c === '#' || (c === '-' && next === '-' && (i + 2 >= n || isSqlSpace(input[i + 2])))) {
      while (i < n && input[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      const end = input.indexOf('*/', i + 2);
      if (end < 0) throw new WorkError('INVALID_ARGUMENT', 'SQL 注释未闭合 (/* 缺少 */)');
      const body = input.slice(i, end + 2);
      if (input[i + 2] === '!') {
        throw new WorkError('INVALID_ARGUMENT', '不支持 MySQL 可执行注释 /*! ... */', { hint: '去掉可执行注释，直接写出语句' });
      }
      if (input[i + 2] === '+') {
        push('hint', body);
        out += body;
        current += body;
      } else {
        out += ' ';
      }
      i = end + 2;
      continue;
    }
    // quoted strings / identifiers
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (backslashEscapes && input[j] === '\\' && c !== '`') {
          j += 2;
          continue;
        }
        if (input[j] === c) {
          if (input[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      if (j >= n) throw new WorkError('INVALID_ARGUMENT', `SQL 中的引号未闭合 (${c})`);
      const text = input.slice(i, j + 1);
      push(c === '`' ? 'ident' : 'string', text);
      out += text;
      current += text;
      i = j + 1;
      continue;
    }
    if (c === ';') {
      flushStatement();
      out += ';';
      i++;
      continue;
    }
    if (isSqlSpace(c)) {
      out += c;
      i++;
      continue;
    }
    if (c === '@') {
      let j = i + 1;
      while (j < n && (WORD.test(input[j]) || input[j] === '@' || input[j] === '.')) j++;
      const text = input.slice(i, j);
      push('variable', text);
      out += text;
      current += text;
      i = j;
      continue;
    }
    if (WORD.test(c)) {
      let j = i;
      while (j < n && WORD.test(input[j])) j++;
      const text = input.slice(i, j);
      push(/^\d/.test(text) ? 'number' : 'word', text);
      out += text;
      current += text;
      i = j;
      continue;
    }
    if (c === '(') depth++;
    const two = input.slice(i, i + 2);
    if (two === ':=' || two === '<=' || two === '>=' || two === '<>' || two === '!=') {
      push('punct', two);
      out += two;
      current += two;
      i += 2;
      continue;
    }
    push('punct', c);
    if (c === ')') depth = Math.max(0, depth - 1);
    out += c;
    current += c;
    i++;
  }
  flushStatement();
  let sql = out.trim();
  while (sql.endsWith(';')) sql = sql.slice(0, -1).trimEnd();
  return { sql, tokens, statements };
}

export type GuardMode = 'execute' | 'explain' | 'analyze';

export interface GuardResult {
  sql: string;
  /** Lexed tokens (comments removed) — used for sensitive-column analysis. */
  tokens: Token[];
  /** First keyword of the statement as written (SELECT, WITH, SHOW, ...). */
  leading: string;
  /** Main statement keyword (for WITH ... SELECT/UPDATE this is the keyword after the CTE list). */
  statement_type: string;
}

const EXECUTE_ALLOWED = new Set(['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN']);
const EXPLAIN_TARGETS = new Set(['SELECT', 'UPDATE', 'DELETE', 'INSERT', 'REPLACE', 'TABLE', 'WITH']);
const MAIN_KEYWORDS = new Set(['SELECT', 'UPDATE', 'DELETE', 'INSERT', 'REPLACE', 'TABLE', 'VALUES']);
const DENY_FUNCTIONS = new Set(['GET_LOCK', 'RELEASE_LOCK', 'RELEASE_ALL_LOCKS', 'LOAD_FILE', 'SOURCE_POS_WAIT', 'MASTER_POS_WAIT', 'WAIT_FOR_EXECUTED_GTID_SET']);

function mainKeyword(tokens: Token[]): string {
  const first = tokens.find((t) => t.kind === 'word' || (t.kind === 'punct' && t.text === '('));
  if (!first) return '';
  if (first.kind === 'punct') {
    // ( SELECT ... ) UNION ...
    const w = tokens.find((t) => t.kind === 'word');
    return w?.upper ?? '';
  }
  if (first.upper !== 'WITH') return first.upper;
  // WITH [RECURSIVE] cte AS (...), ... <main statement>: first depth-0 main keyword
  const base = first.depth;
  for (const t of tokens.slice(tokens.indexOf(first) + 1)) {
    if (t.kind === 'word' && t.depth === base && MAIN_KEYWORDS.has(t.upper)) return t.upper;
  }
  return 'WITH';
}

function reject(msg: string, hint?: string): never {
  throw new WorkError('INVALID_ARGUMENT', msg, hint ? { hint } : {});
}

/**
 * Validate a single statement for one of the guarded modes.
 * - execute: SELECT / WITH(SELECT) / SHOW / DESCRIBE / EXPLAIN (not EXPLAIN ANALYZE)
 * - explain: target statement for EXPLAIN FORMAT=JSON (SELECT/UPDATE/DELETE/INSERT/REPLACE/TABLE/WITH)
 * - analyze: SELECT / WITH(SELECT) / TABLE only — EXPLAIN ANALYZE really executes the statement
 */
export function guardSql(input: string, mode: GuardMode): GuardResult {
  const result = guardOnce(input, mode, true);
  // The server may run with NO_BACKSLASH_ESCAPES (or ANSI_QUOTES): then a backslash does not
  // escape a quote and the statement boundaries/keywords differ from what we lexed. Require the
  // statement to pass under that interpretation too, so quoting tricks cannot hide keywords.
  if (input.includes('\\')) {
    try {
      guardOnce(input, mode, false);
    } catch (e) {
      const why = e instanceof WorkError ? e.message : String(e);
      reject(`SQL 中的反斜杠转义在 NO_BACKSLASH_ESCAPES 模式下含义不同，按该模式解析未通过检查: ${why}`, "字符串中的引号用两个引号转义（如 'it''s'），不要用反斜杠");
    }
  }
  return result;
}

/** Optimizer hints that would override the guards (execution time limit, session variables, resource group). */
const DENY_HINTS = /\b(MAX_EXECUTION_TIME|SET_VAR|RESOURCE_GROUP)\b/i;

function unquoteName(t: Token): string | null {
  if (t.kind === 'word') return t.upper;
  if (t.kind === 'ident' || (t.kind === 'string' && t.text.startsWith('"'))) {
    const q = t.text[0];
    return t.text.slice(1, -1).split(q + q).join(q).toUpperCase();
  }
  return null;
}

function guardOnce(input: string, mode: GuardMode, backslashEscapes: boolean): GuardResult {
  const lexed = lex(input, { backslashEscapes });
  if (!lexed.sql || lexed.statements === 0) reject('SQL 文件为空（去掉注释后没有语句）');
  if (lexed.statements > 1) reject(`只允许单条语句，检测到 ${lexed.statements} 条`, '拆分为多个文件分别执行');
  const words = lexed.tokens.filter((t) => t.kind === 'word');
  const leading = words[0]?.upper ?? '';
  const firstSig = lexed.tokens.find((t) => t.kind !== 'hint');
  const leadingParen = firstSig?.kind === 'punct' && firstSig.text === '(';

  if (leading === 'EXPLAIN' || leading === 'DESCRIBE' || leading === 'DESC') {
    const second = words[1]?.upper;
    if (second === 'ANALYZE' || (second === 'FORMAT' && words.some((w) => w.upper === 'ANALYZE'))) {
      reject('EXPLAIN ANALYZE 会实际执行语句，不能通过该命令提交', '改用 workctl mysql query analyze（受限：只读事务 + 执行时间上限）');
    }
    if (mode === 'explain' || mode === 'analyze') {
      reject('请只提供被分析的语句本身，不要带 EXPLAIN/DESCRIBE 前缀', `workctl 会自动加 ${mode === 'explain' ? 'EXPLAIN FORMAT=JSON' : 'EXPLAIN ANALYZE'}`);
    }
  }

  const statementType = leadingParen ? mainKeyword(lexed.tokens) : leading === 'WITH' ? mainKeyword(lexed.tokens) : leading;

  if (mode === 'execute') {
    if (!(EXECUTE_ALLOWED.has(leading) || (leadingParen && statementType === 'SELECT'))) {
      reject(`受限查询只允许 SELECT / WITH / SHOW / DESCRIBE / EXPLAIN，收到 ${leading || '(无法识别)'}`, '写操作与 DDL 走变更流程（mysql index plan / operation plan）');
    }
    if (leading === 'WITH' && statementType !== 'SELECT') reject(`WITH 后的主语句必须是 SELECT，收到 ${statementType}`);
  } else if (mode === 'explain') {
    if (!(EXPLAIN_TARGETS.has(leading) || (leadingParen && statementType === 'SELECT'))) {
      reject(`EXPLAIN 只支持 SELECT / UPDATE / DELETE / INSERT / REPLACE / TABLE / WITH，收到 ${leading || '(无法识别)'}`);
    }
  } else {
    if (!(['SELECT', 'WITH', 'TABLE'].includes(leading) || (leadingParen && statementType === 'SELECT'))) {
      reject(`query analyze 只允许 SELECT（含 WITH ... SELECT / TABLE），收到 ${leading || '(无法识别)'}`, 'EXPLAIN ANALYZE 会实际执行语句，写语句只能用 mysql query explain 查看估计计划');
    }
    if (leading === 'WITH' && statementType !== 'SELECT') reject(`WITH 后的主语句必须是 SELECT，收到 ${statementType}`);
  }

  // Constructs that write files, take locks or assign variables are refused in every mode that runs SQL.
  if (mode !== 'explain') {
    const t = lexed.tokens;
    for (let k = 0; k < t.length; k++) {
      const w = t[k];
      if (w.kind === 'word' && w.upper === 'INTO') {
        const nx = t[k + 1];
        if (nx && nx.kind === 'word' && (nx.upper === 'OUTFILE' || nx.upper === 'DUMPFILE')) reject(`不允许 INTO ${nx.upper}`);
        if (nx && nx.kind === 'variable') reject('不允许 SELECT ... INTO @变量（变量赋值）');
        if (statementType === 'SELECT') reject('SELECT 中不允许 INTO 子句');
      }
      if (w.kind === 'word' && w.upper === 'FOR' && t[k + 1]?.kind === 'word' && ['UPDATE', 'SHARE'].includes(t[k + 1].upper)) reject(`不允许 FOR ${t[k + 1].upper}（加锁读）`);
      if (w.kind === 'word' && w.upper === 'LOCK' && t[k + 1]?.upper === 'IN' && t[k + 2]?.upper === 'SHARE') reject('不允许 LOCK IN SHARE MODE（加锁读）');
      if (w.kind === 'punct' && w.text === ':=') reject('不允许变量赋值 (:=)');
      if (w.kind === 'variable' && t[k + 1]?.kind === 'punct' && t[k + 1].text === '=' && k > 0 && t[k - 1].kind === 'word' && t[k - 1].upper === 'SET') reject('不允许 SET 变量');
      // quoted names (`GET_LOCK`(...), or "GET_LOCK"(...) under ANSI_QUOTES) still call the built-in
      const fname = unquoteName(w);
      if (fname && DENY_FUNCTIONS.has(fname) && t[k + 1]?.text === '(') reject(`不允许调用 ${fname}()`);
      if (w.kind === 'hint' && DENY_HINTS.test(w.text)) {
        reject(`不允许优化器提示 ${DENY_HINTS.exec(w.text)![1].toUpperCase()}（会覆盖执行时间上限或会话变量）`, '去掉该提示；执行时间上限由端点 max_execution_time_ms 决定');
      }
    }
  }
  return { sql: lexed.sql, leading, statement_type: statementType, tokens: lexed.tokens };
}

// ---------------------------------------------------------------- sensitive output analysis

export interface SensitiveOutputPlan {
  /** Mask every result column (sensitive data may flow through derived tables / CTEs / ambiguous positions). */
  all: boolean;
  /** 0-based result column positions computed from a sensitive column (expressions, aliases, UNION branches). */
  positions: Set<number>;
  reasons: string[];
}

const ITEM_END = new Set(['FROM', 'INTO', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'UNION', 'EXCEPT', 'INTERSECT', 'WINDOW', 'FOR', 'LOCK']);
const SELECT_MODIFIERS = new Set(['DISTINCT', 'ALL', 'DISTINCTROW', 'HIGH_PRIORITY', 'STRAIGHT_JOIN', 'SQL_SMALL_RESULT', 'SQL_BIG_RESULT', 'SQL_BUFFER_RESULT', 'SQL_NO_CACHE', 'SQL_CALC_FOUND_ROWS']);
const FROM_END = new Set(['WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'UNION', 'EXCEPT', 'INTERSECT', 'WINDOW', 'FOR', 'LOCK', 'INTO']);

function tokenName(t: Token): string | null {
  if (t.kind === 'word') return t.text.toLowerCase();
  if (t.kind === 'ident') return t.text.slice(1, -1).split('``').join('`').toLowerCase();
  return null;
}

/**
 * Which result columns of a guarded SELECT can carry values of sensitive columns although the
 * driver metadata does not name them (CONCAT(phone,'') AS x, UNION branches, derived tables).
 * Conservative: references only in WHERE/ON/GROUP BY/ORDER BY do not taint; references inside
 * derived tables or CTEs taint every column; ambiguous positions (SELECT * next to a tainted
 * expression) taint every column.
 */
export function sensitiveOutputPlan(tokens: Token[], sensitive: Set<string>): SensitiveOutputPlan {
  const plan: SensitiveOutputPlan = { all: false, positions: new Set(), reasons: [] };
  if (!sensitive.size) return plan;
  const isSens = (t: Token) => {
    const nm = tokenName(t);
    return nm !== null && sensitive.has(nm);
  };
  if (!tokens.some(isSens)) return plan;
  const selects = tokens.map((t, idx) => ({ t, idx })).filter((x) => x.t.kind === 'word' && x.t.upper === 'SELECT');
  if (!selects.length) return plan;
  // main statement starts after the CTE list for WITH
  const firstWord = tokens.find((t) => t.kind === 'word');
  let mainFrom = 0;
  if (firstWord?.upper === 'WITH') {
    const base = firstWord.depth;
    const main = tokens.findIndex((t, idx) => idx > tokens.indexOf(firstWord) && t.kind === 'word' && t.depth === base && t.upper === 'SELECT');
    mainFrom = main < 0 ? tokens.length : main;
    if (tokens.slice(0, mainFrom).some(isSens)) {
      plan.all = true;
      plan.reasons.push('CTE 中引用了敏感列，结果列可能携带其值');
      return plan;
    }
  }
  const mainSelects = selects.filter((x) => x.idx >= mainFrom);
  if (!mainSelects.length) return plan;
  const branchDepth = Math.min(...mainSelects.map((x) => x.t.depth));
  const branches = mainSelects.filter((x) => x.t.depth === branchDepth).map((x) => x.idx);
  for (const start of branches) {
    // select list
    const items: Token[][] = [[]];
    let k = start + 1;
    for (; k < tokens.length; k++) {
      const t = tokens[k];
      if (t.depth < branchDepth) break;
      if (t.depth === branchDepth && t.kind === 'word' && ITEM_END.has(t.upper)) break;
      if (t.depth === branchDepth && t.kind === 'punct' && t.text === ')') break;
      if (t.depth === branchDepth && t.kind === 'punct' && t.text === ',') {
        items.push([]);
        continue;
      }
      if (t.kind === 'hint') continue;
      if (items[items.length - 1].length === 0 && t.kind === 'word' && SELECT_MODIFIERS.has(t.upper)) continue;
      items[items.length - 1].push(t);
    }
    const star = items.some((it) => it.length > 0 && it[it.length - 1].kind === 'punct' && it[it.length - 1].text === '*' && (it.length === 1 || it[it.length - 2]?.text === '.'));
    const tainted = items.map((it, pos) => (it.some(isSens) ? pos : -1)).filter((p) => p >= 0);
    if (tainted.length && star) {
      plan.all = true;
      plan.reasons.push('选择列表同时含 * 与引用敏感列的表达式，无法按位置对应，全部列脱敏');
    } else for (const p of tainted) plan.positions.add(p);
    // FROM clause: sensitive references inside derived tables (deeper parentheses)
    if (k < tokens.length && tokens[k].kind === 'word' && tokens[k].upper === 'FROM') {
      for (let j = k + 1; j < tokens.length; j++) {
        const t = tokens[j];
        if (t.depth < branchDepth || (t.depth === branchDepth && ((t.kind === 'word' && FROM_END.has(t.upper)) || (t.kind === 'punct' && t.text === ')')))) break;
        if (t.depth > branchDepth && isSens(t)) {
          plan.all = true;
          plan.reasons.push('派生表/子查询（FROM 中）引用了敏感列，结果列可能携带其值');
          break;
        }
      }
    }
  }
  if (plan.positions.size) plan.reasons.push('选择列表中的表达式/别名引用了敏感列');
  return plan;
}

/**
 * Replace string and numeric literals with `?` (same idea as statement digests) so SQL text
 * taken from sessions / slow log does not leak values such as phone numbers.
 */
export function maskLiterals(sqlText: string): string {
  let out = '';
  let i = 0;
  const n = sqlText.length;
  while (i < n) {
    const c = sqlText[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        if (sqlText[j] === '\\') {
          j += 2;
          continue;
        }
        if (sqlText[j] === c) {
          if (sqlText[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out += '?';
      i = Math.min(n, j + 1);
      continue;
    }
    if (c === '`') {
      const j = sqlText.indexOf('`', i + 1);
      const end = j < 0 ? n : j + 1;
      out += sqlText.slice(i, end);
      i = end;
      continue;
    }
    if (/[0-9]/.test(c) && (i === 0 || !/[A-Za-z0-9_$.]/.test(sqlText[i - 1]))) {
      let j = i;
      while (j < n && /[0-9a-fA-FxX.eE]/.test(sqlText[j])) j++;
      if (j < n && /[A-Za-z_$]/.test(sqlText[j])) {
        // identifier starting with digits (e.g. 1abc) — keep as is
        while (j < n && /[A-Za-z0-9_$]/.test(sqlText[j])) j++;
        out += sqlText.slice(i, j);
      } else out += '?';
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function truncate(s: string | null | undefined, max: number): { text: string | null; truncated: boolean } {
  if (s === null || s === undefined) return { text: null, truncated: false };
  return s.length > max ? { text: `${s.slice(0, max)}…`, truncated: true } : { text: s, truncated: false };
}
