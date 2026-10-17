import { WorkError } from '../../core/output';

/**
 * Static SQL checks for the guarded PostgreSQL query capabilities. This is the *program* layer
 * of the read boundary; the database role (e.g. workctl_ro: SELECT only,
 * default_transaction_read_only=on), the READ ONLY transaction and statement_timeout are the
 * other layers — and the role is the real one. A lexer is used (not regexes over raw text) so
 * quotes, dollar-quoting, identifiers and (nested) comments cannot hide keywords.
 */

export interface PgToken {
  kind: 'word' | 'string' | 'ident' | 'number' | 'punct' | 'param';
  text: string;
  /** Upper-cased text for words; unquoted lower-cased name for identifiers. */
  upper: string;
  depth: number;
  /** U&"..." identifier: its real name is only known after Unicode-escape decoding. */
  unicode?: boolean;
}

export interface PgLexed {
  /** SQL with comments removed, trimmed, trailing `;` removed. */
  sql: string;
  tokens: PgToken[];
  statements: number;
}

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD = /[A-Za-z0-9_$\u0080-￿]/;

function reject(message: string, hint?: string): never {
  throw new WorkError('INVALID_ARGUMENT', message, hint ? { hint } : {});
}

/** Dollar-quote opening tag at `i` ($$ or $tag$), or null. */
function dollarTag(input: string, i: number): string | null {
  const m = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(input.slice(i, i + 66));
  return m ? m[0] : null;
}

export function lexPg(input: string): PgLexed {
  const tokens: PgToken[] = [];
  const parts: string[] = [];
  let depth = 0;
  let statements = 0;
  let current = '';
  const push = (kind: PgToken['kind'], text: string, upper = kind === 'word' ? text.toUpperCase() : text) => {
    tokens.push({ kind, text, upper, depth });
    parts.push(text);
    current += text;
  };
  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input[i];
    const next = input[i + 1];
    if (c === '-' && next === '-') {
      while (i < n && input[i] !== '\n') i++;
      parts.push(' ');
      continue;
    }
    if (c === '/' && next === '*') {
      // PostgreSQL block comments nest
      let level = 1;
      let j = i + 2;
      while (j < n && level > 0) {
        if (input[j] === '/' && input[j + 1] === '*') {
          level++;
          j += 2;
        } else if (input[j] === '*' && input[j + 1] === '/') {
          level--;
          j += 2;
        } else j++;
      }
      if (level > 0) reject('SQL 注释未闭合 (/* 缺少 */)');
      parts.push(' ');
      i = j;
      continue;
    }
    if (c === "'") {
      // E'...' strings honour backslash escapes; standard strings only '' (standard_conforming_strings=on)
      const prev = tokens[tokens.length - 1];
      const escape = !!prev && prev.kind === 'word' && /^[Ee]$/.test(prev.text) && parts[parts.length - 1] === prev.text;
      let j = i + 1;
      while (j < n) {
        if (escape && input[j] === '\\') {
          j += 2;
          continue;
        }
        if (input[j] === "'") {
          if (input[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      if (j >= n) reject("SQL 中的引号未闭合 (')");
      push('string', input.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (input[j] === '"') {
          if (input[j + 1] === '"') {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      if (j >= n) reject('SQL 中的双引号标识符未闭合 (")');
      const text = input.slice(i, j + 1);
      push('ident', text, text.slice(1, -1).split('""').join('"').toLowerCase());
      // U&"\0071uery_to_xml" names query_to_xml once the server decodes it
      if (i >= 2 && /[Uu]/.test(input[i - 2]) && input[i - 1] === '&' && (i === 2 || !WORD.test(input[i - 3]))) tokens[tokens.length - 1].unicode = true;
      i = j + 1;
      continue;
    }
    if (c === '$') {
      if (next !== undefined && /[0-9]/.test(next)) {
        let j = i + 1;
        while (j < n && /[0-9]/.test(input[j])) j++;
        push('param', input.slice(i, j));
        i = j;
        continue;
      }
      const tag = dollarTag(input, i);
      if (tag) {
        const end = input.indexOf(tag, i + tag.length);
        if (end < 0) reject(`SQL 中的 dollar 引用未闭合 (${tag})`);
        push('string', input.slice(i, end + tag.length));
        i = end + tag.length;
        continue;
      }
    }
    if (c === ';') {
      if (current.trim()) statements++;
      current = '';
      parts.push(';');
      i++;
      continue;
    }
    if (c.charCodeAt(0) <= 0x20) {
      parts.push(c);
      i++;
      continue;
    }
    if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < n && WORD.test(input[j])) j++;
      push('word', input.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && next !== undefined && /[0-9]/.test(next))) {
      let j = i + 1;
      while (j < n && /[0-9.eE_]/.test(input[j])) j++;
      push('number', input.slice(i, j));
      i = j;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') depth = Math.max(0, depth - 1);
    push('punct', c);
    i++;
  }
  if (current.trim()) statements++;
  const sql = parts.join('').trim().replace(/;\s*$/, '').trim();
  return { sql, tokens, statements };
}

export type GuardMode = 'run' | 'explain' | 'analyze';

export interface GuardResult {
  sql: string;
  statement_type: string;
  tokens: PgToken[];
  /** `$n` placeholders present (pg_stat_statements text); EXPLAIN needs GENERIC_PLAN. */
  has_params: boolean;
}

/** Keywords that make a statement write, lock, change session state or run other statements. */
const WRITE_WORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'COPY', 'CREATE', 'ALTER', 'DROP', 'GRANT', 'REVOKE', 'CALL', 'DO', 'LOCK',
  'VACUUM', 'CLUSTER', 'REINDEX', 'REFRESH', 'NOTIFY', 'LISTEN', 'UNLISTEN', 'SET', 'RESET', 'DISCARD', 'PREPARE', 'EXECUTE',
  'DEALLOCATE', 'BEGIN', 'START', 'COMMIT', 'END', 'ROLLBACK', 'ABORT', 'SAVEPOINT', 'RELEASE', 'CHECKPOINT', 'LOAD', 'SECURITY',
  'IMPORT', 'COMMENT', 'DECLARE', 'FETCH', 'MOVE', 'CLOSE',
]);
// END is also CASE ... END: only treated as a statement keyword when it leads the statement.
const STATEMENT_ONLY_WORDS = new Set(['END', 'START', 'SECURITY', 'LOAD', 'CLOSE', 'MOVE', 'FETCH', 'COMMENT', 'IMPORT', 'RELEASE', 'ABORT', 'DO', 'SET', 'LOCK']);

/**
 * Functions with side effects outside the transaction (signals, files, advisory locks,
 * sequences, configuration, stats resets) or that run arbitrary SQL text. Not exhaustive —
 * user-defined functions can do anything their owner can; the role is the real boundary.
 */
const DENY_FUNCTIONS = [
  /^pg_(terminate|cancel)_backend$/, /^pg_reload_conf$/, /^pg_rotate_logfile/, /^set_config$/, /^pg_(try_)?advisory/, /^lo_/,
  /^pg_read_(binary_)?file$/, /^pg_ls_/, /^pg_stat_file$/, /^dblink/, /^pg_stat_reset/, /^pg_stat_statements_reset$/, /^pg_switch_wal$/,
  /^pg_promote$/, /^pg_create_/, /^pg_drop_replication_slot$/, /^pg_replication_origin_/, /^pg_logical_/, /^pg_notify$/, /^nextval$/,
  /^setval$/, /^(query|cursor)_to_xml/, /^(database|schema|table)_to_xml/, /^ts_stat$/, /^pg_backup_/, /^pg_wal_replay_/, /^pg_file_/,
  /^pg_import_system_collations$/, /^pg_log_backend_memory_contexts$/,
  // ts_rewrite(tsquery, text) runs the text as a query; these assign an XID even in a READ ONLY transaction
  /^ts_rewrite$/, /^txid_current$/, /^pg_current_xact_id$/,
];

const RUN_LEADING = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE']);
const EXPLAIN_LEADING = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE', 'INSERT', 'UPDATE', 'DELETE', 'MERGE']);

/** Main statement keyword after a WITH clause (first top-level DML/SELECT word). */
function mainKeyword(tokens: PgToken[]): string {
  const top = tokens.filter((t) => t.depth === 0 && t.kind === 'word');
  const main = top.find((t, idx) => idx > 0 && ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'VALUES', 'TABLE'].includes(t.upper));
  return main?.upper ?? 'WITH';
}

export function guardPg(input: string, mode: GuardMode): GuardResult {
  const lexed = lexPg(input);
  if (!lexed.sql || lexed.statements === 0) reject('SQL 为空（去掉注释后没有语句）');
  if (lexed.statements > 1) reject(`只允许单条语句，检测到 ${lexed.statements} 条`, '拆分为多次调用');
  // the name checks below compare identifier text; a Unicode-escaped identifier would slip past them
  if (lexed.tokens.some((t) => t.unicode)) reject('不支持 U&"..." 形式的 Unicode 转义标识符', '直接写出标识符，如 "my_col"');
  const words = lexed.tokens.filter((t) => t.kind === 'word');
  const firstSig = lexed.tokens[0];
  const leadingParen = firstSig?.kind === 'punct' && firstSig.text === '(';
  const leading = leadingParen ? (words[0]?.upper ?? '') : (firstSig?.kind === 'word' ? firstSig.upper : '');

  if (leading === 'EXPLAIN') {
    if (mode === 'run') reject('受限查询不接受 EXPLAIN（EXPLAIN ANALYZE 会实际执行语句）', '估计计划用 workctl pg query explain；实际执行统计用 workctl pg query analyze');
    reject('请只提供被分析的语句本身，不要带 EXPLAIN 前缀', `workctl 会自动加 ${mode === 'explain' ? 'EXPLAIN (FORMAT JSON)' : 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)'}`);
  }
  const statementType = leading === 'WITH' ? mainKeyword(lexed.tokens) : leading;

  if (mode === 'explain') {
    if (!EXPLAIN_LEADING.has(leading)) reject(`EXPLAIN 只支持 SELECT / WITH / VALUES / TABLE / INSERT / UPDATE / DELETE / MERGE，收到 ${leading || '(无法识别)'}`);
  } else {
    if (!RUN_LEADING.has(leading)) {
      reject(
        `${mode === 'run' ? '受限查询' : 'query analyze'} 只允许 SELECT（含 WITH ... SELECT / VALUES / TABLE），收到 ${leading || '(无法识别)'}`,
        mode === 'run' ? '写操作与 DDL 不在 workctl 只读查询范围内' : 'EXPLAIN ANALYZE 会实际执行语句；写语句只能用 workctl pg query explain 查看估计计划',
      );
    }
    for (let k = 0; k < words.length; k++) {
      const w = words[k];
      if (!WRITE_WORDS.has(w.upper)) continue;
      if (STATEMENT_ONLY_WORDS.has(w.upper)) continue;
      reject(`语句中包含写入/会话控制关键字 ${w.upper}（含数据修改型 CTE），只允许纯查询`, '若这是列名，请用双引号引用，如 "update"');
    }
    // SELECT ... INTO creates a table; FOR UPDATE/SHARE takes row locks
    for (let k = 0; k < words.length; k++) {
      if (words[k].upper === 'INTO') reject('不允许 SELECT ... INTO（会创建表）');
      if (words[k].upper === 'FOR' && ['UPDATE', 'SHARE', 'NO', 'KEY'].includes(words[k + 1]?.upper ?? '')) reject('不允许 FOR UPDATE / FOR SHARE 等行锁子句');
    }
  }
  // functions with side effects — in every mode: EXPLAIN does not execute the query, but the planner
  // may pre-evaluate (constant-fold) functions, so keep the surface small everywhere
  for (let k = 0; k < lexed.tokens.length - 1; k++) {
    const t = lexed.tokens[k];
    const nx = lexed.tokens[k + 1];
    if (!(nx.kind === 'punct' && nx.text === '(')) continue;
    const name = t.kind === 'word' ? t.text.toLowerCase() : t.kind === 'ident' ? t.upper : null;
    if (name && DENY_FUNCTIONS.some((re) => re.test(name))) {
      reject(`不允许调用有副作用或执行任意 SQL 的函数 ${name}()`, '只读查询不应终止会话、读写文件、加咨询锁、修改序列或重置统计');
    }
  }
  return { sql: lexed.sql, statement_type: statementType, tokens: lexed.tokens, has_params: lexed.tokens.some((t) => t.kind === 'param') };
}

/**
 * Replace literals in SQL text with `?` before it is shown (pg_stat_activity.query contains the
 * raw text; pg_stat_statements is already normalised to $n but utility statements may not be).
 * Strings ('...', E'...', $tag$...$tag$) and numbers are masked; identifiers and $n are kept.
 * Never throws (text may be truncated by track_activity_query_size).
 */
export function maskPgLiterals(sqlText: string): string {
  let out = '';
  let i = 0;
  const n = sqlText.length;
  while (i < n) {
    const c = sqlText[i];
    if (c === "'") {
      const escape = i > 0 && /[Ee]/.test(sqlText[i - 1]) && (i < 2 || !/[A-Za-z0-9_]/.test(sqlText[i - 2]));
      let j = i + 1;
      while (j < n) {
        if (escape && sqlText[j] === '\\') {
          j += 2;
          continue;
        }
        if (sqlText[j] === "'") {
          if (sqlText[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      if (escape) out = out.slice(0, -1);
      out += '?';
      i = Math.min(n, j + 1);
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && !(sqlText[j] === '"' && sqlText[j + 1] !== '"')) j += sqlText[j] === '"' ? 2 : 1;
      out += sqlText.slice(i, Math.min(n, j + 1));
      i = Math.min(n, j + 1);
      continue;
    }
    if (c === '$') {
      if (/[0-9]/.test(sqlText[i + 1] ?? '')) {
        let j = i + 1;
        while (j < n && /[0-9]/.test(sqlText[j])) j++;
        out += sqlText.slice(i, j);
        i = j;
        continue;
      }
      const tag = dollarTag(sqlText, i);
      if (tag && (i === 0 || !/[A-Za-z0-9_]/.test(sqlText[i - 1]))) {
        const end = sqlText.indexOf(tag, i + tag.length);
        out += '?';
        i = end < 0 ? n : end + tag.length;
        continue;
      }
    }
    if (/[0-9]/.test(c) && (i === 0 || !/[A-Za-z0-9_$.]/.test(sqlText[i - 1]))) {
      let j = i;
      while (j < n && /[0-9.eE_]/.test(sqlText[j])) j++;
      if (j < n && /[A-Za-z_]/.test(sqlText[j])) {
        while (j < n && /[A-Za-z0-9_]/.test(sqlText[j])) j++;
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

/** Masked + truncated statement text for display. */
export function displaySql(v: unknown, max = 512): { text: string | null; truncated: boolean } {
  if (v === null || v === undefined) return { text: null, truncated: false };
  return truncate(maskPgLiterals(String(v)), max);
}

/** Mask a sensitive value: keep a little shape (e-mail domain, phone prefix/suffix), hide the rest. */
export function maskValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  const s = Buffer.isBuffer(v) ? '' : typeof v === 'object' ? '' : String(v);
  if (!s) return '***';
  // composite rows, arrays, JSON text and long values may carry several fields: hide entirely
  if (s.length > 64 || /^[({[]/.test(s)) return '***';
  const at = s.indexOf('@');
  if (at > 0) return `${s[0]}***${s.slice(at)}`;
  if (s.length >= 11) return `${s.slice(0, 3)}****${s.slice(-4)}`;
  if (s.length >= 6) return `${s[0]}****${s.slice(-1)}`;
  return '***';
}

/** JSON-safe cell value: bytea → \x hex, long text capped. */
export function cell(v: unknown, maxChars = 2048): { value: unknown; truncated: boolean } {
  if (v === null || v === undefined) return { value: null, truncated: false };
  if (Buffer.isBuffer(v)) {
    const s = `\\x${v.toString('hex')}`;
    return s.length > maxChars ? { value: `${s.slice(0, maxChars)}…`, truncated: true } : { value: s, truncated: false };
  }
  if (typeof v === 'string' && v.length > maxChars) return { value: `${v.slice(0, maxChars)}…`, truncated: true };
  if (typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > maxChars ? { value: `${s.slice(0, maxChars)}…`, truncated: true } : { value: v, truncated: false };
  }
  return { value: v, truncated: false };
}
