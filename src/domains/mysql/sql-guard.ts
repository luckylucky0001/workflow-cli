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

export function lex(input: string): Lexed {
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
    if (c === '#' || (c === '-' && next === '-' && (i + 2 >= n || /\s/.test(input[i + 2])))) {
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
        if (input[j] === '\\' && c !== '`') {
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
    if (/\s/.test(c)) {
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
  const lexed = lex(input);
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
      if (w.kind === 'word' && DENY_FUNCTIONS.has(w.upper) && t[k + 1]?.text === '(') reject(`不允许调用 ${w.upper}()`);
    }
  }
  return { sql: lexed.sql, leading, statement_type: statementType };
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
