import { readFileSync } from 'node:fs';
import { resolveSqlFile, type Catalog, type TableMeta } from './catalog';

/**
 * Regex-based SQL lineage inference. Deliberately conservative:
 *  - targets:  INSERT INTO|OVERWRITE [TABLE] x, CREATE [OR REPLACE] TABLE x AS, MERGE INTO x
 *  - sources:  identifiers after FROM / JOIN (and comma joins), excluding CTE names,
 *              temporary views created in the same file, subqueries and FROM inside
 *              EXTRACT/TRIM/SUBSTRING/... function calls
 * Dynamic SQL, temp views registered from program code and DataFrame reads are invisible.
 */

export interface SqlRef {
  name: string;
  line: number;
}

export interface SqlInference {
  targets: SqlRef[];
  sources: SqlRef[];
  path_sources: SqlRef[];
  ctes: string[];
  temp_views: string[];
}

/** Replace comments and string literals with spaces, keeping line structure. */
export function stripSql(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];
    if (c === '-' && c2 === '-') {
      while (i < n && sql[i] !== '\n') {
        out += ' ';
        i++;
      }
    } else if (c === '/' && c2 === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) {
        out += sql[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out += '  ';
        i += 2;
      }
    } else if (c === "'" || c === '"') {
      const q = c;
      out += ' ';
      i++;
      while (i < n && sql[i] !== q) {
        if (sql[i] === '\\') {
          out += ' ';
          i++;
        }
        if (i < n) {
          out += sql[i] === '\n' ? '\n' : ' ';
          i++;
        }
      }
      out += ' ';
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const KEYWORDS = new Set([
  'select', 'where', 'group', 'order', 'by', 'having', 'limit', 'union', 'on', 'join', 'left', 'right', 'inner', 'outer', 'full',
  'cross', 'lateral', 'as', 'with', 'insert', 'into', 'overwrite', 'table', 'values', 'partition', 'unnest', 'window', 'qualify',
]);
const FROM_FUNCS = new Set(['extract', 'trim', 'substring', 'position', 'overlay', 'substr']);
const IDENT_RE = '(`[^`]+`|[A-Za-z_][\\w$]*)(?:\\s*\\.\\s*(`[^`]+`|[A-Za-z_][\\w$]*))?(?:\\s*\\.\\s*(`[^`]+`|[A-Za-z_][\\w$]*))?';

function unquote(s: string): string {
  return s.replace(/`/g, '');
}

function lineAt(text: string, idx: number): number {
  let n = 1;
  for (let i = 0; i < idx && i < text.length; i++) if (text[i] === '\n') n++;
  return n;
}

/** Word before the innermost unclosed '(' preceding idx (to detect EXTRACT(x FROM y)). */
function enclosingFunction(text: string, idx: number): string | null {
  let depth = 0;
  for (let i = idx - 1; i >= 0; i--) {
    const c = text[i];
    if (c === ')') depth++;
    else if (c === '(') {
      if (depth === 0) {
        const m = /([A-Za-z_]\w*)\s*$/.exec(text.slice(Math.max(0, i - 40), i));
        return m ? m[1].toLowerCase() : null;
      }
      depth--;
    }
  }
  return null;
}

export function inferSql(sql: string): SqlInference {
  const text = stripSql(sql);
  const ctes = new Set<string>();
  for (const m of text.matchAll(/(?:\bwith\s+(?:recursive\s+)?|,\s*)([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s+as\s*\(/gi)) ctes.add(m[1].toLowerCase());
  const tempViews = new Set<string>();
  for (const m of text.matchAll(/\bcreate\s+(?:or\s+replace\s+)?(?:global\s+)?temp(?:orary)?\s+view\s+(?:if\s+not\s+exists\s+)?([\w.`]+)/gi)) {
    tempViews.add(unquote(m[1]).toLowerCase());
  }
  const targets: SqlRef[] = [];
  // INSERT OVERWRITE [LOCAL] DIRECTORY '...' writes files, not a table
  const targetRe = new RegExp(`\\b(?:insert\\s+(?:into|overwrite)\\s+(?!(?:local\\s+)?directory\\b)(?:table\\s+)?|create\\s+(?:or\\s+replace\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?|merge\\s+into\\s+)${IDENT_RE}`, 'gi');
  for (const m of text.matchAll(targetRe)) {
    const name = [m[1], m[2], m[3]].filter(Boolean).map(unquote).join('.');
    targets.push({ name, line: lineAt(text, m.index ?? 0) });
  }
  const sources: SqlRef[] = [];
  const pathSources: SqlRef[] = [];
  const fromRe = /\b(from|join)\s+/gi;
  for (const m of text.matchAll(fromRe)) {
    const kw = m[1].toLowerCase();
    const at = (m.index ?? 0) + m[0].length;
    if (kw === 'from') {
      const before = text.slice(Math.max(0, (m.index ?? 0) - 12), m.index).toLowerCase();
      if (/\bdistinct\s*$/.test(before)) continue;
      const fn = enclosingFunction(text, m.index ?? 0);
      if (fn && FROM_FUNCS.has(fn)) continue;
    }
    let pos = at;
    for (let guard = 0; guard < 50; guard++) {
      const rest = text.slice(pos);
      if (/^\s*\(/.test(rest) || /^\s*lateral\b/i.test(rest)) break;
      // Spark file source: json.`/path` / parquet.`/path`
      const pathM = /^\s*(json|csv|parquet|orc|text|avro|delta)\s*\.\s*`([^`]+)`/i.exec(rest);
      if (pathM) {
        pathSources.push({ name: `${pathM[1].toLowerCase()}:${pathM[2]}`, line: lineAt(text, pos) });
      } else {
        const idM = new RegExp(`^\\s*${IDENT_RE}`).exec(rest);
        if (!idM) break;
        const name = [idM[1], idM[2], idM[3]].filter(Boolean).map(unquote).join('.');
        const lower = name.toLowerCase();
        if (!KEYWORDS.has(lower) && !ctes.has(lower) && !tempViews.has(lower)) {
          // skip table-valued functions: name followed by '('
          const after = rest.slice(idM[0].length);
          if (!/^\s*\(/.test(after)) sources.push({ name, line: lineAt(text, pos) });
        }
      }
      if (kw === 'join') break;
      // comma join: FROM a x, b y
      const consumed = pathM ? pathM[0].length : (new RegExp(`^\\s*${IDENT_RE}`).exec(rest)?.[0].length ?? 0);
      const tail = text.slice(pos + consumed);
      const comma = /^\s*(?:(?:as\s+)?(?!(?:where|group|order|having|limit|union|join|left|right|inner|outer|full|cross|on|lateral|window)\b)[A-Za-z_]\w*)?\s*,/i.exec(tail);
      if (!comma) break;
      pos = pos + consumed + comma[0].length;
    }
  }
  // MERGE INTO target [AS] [alias] USING source — the source of a MERGE is not after FROM/JOIN
  const mergeRe = new RegExp(`\\bmerge\\s+into\\s+${IDENT_RE}(?:\\s+(?:as\\s+)?(?!using\\b)[A-Za-z_]\\w*)?\\s+using\\s+(?!\\()${IDENT_RE}`, 'gi');
  for (const m of text.matchAll(mergeRe)) {
    const name = [m[4], m[5], m[6]].filter(Boolean).map(unquote).join('.');
    const lower = name.toLowerCase();
    if (!KEYWORDS.has(lower) && !ctes.has(lower) && !tempViews.has(lower)) {
      sources.push({ name, line: lineAt(text, (m.index ?? 0) + m[0].length - 1) });
    }
  }
  const dedupe = (refs: SqlRef[]) => {
    const seen = new Map<string, SqlRef>();
    for (const r of refs) if (!seen.has(r.name.toLowerCase())) seen.set(r.name.toLowerCase(), r);
    return [...seen.values()];
  };
  return {
    targets: dedupe(targets),
    sources: dedupe(sources),
    path_sources: dedupe(pathSources),
    ctes: [...ctes],
    temp_views: [...tempViews],
  };
}

// ---------------------------------------------------------------------------
// Lineage graph
// ---------------------------------------------------------------------------

export type NodeType = 'table' | 'external' | 'workflow' | 'report' | 'service' | 'unresolved';

export interface LineageNode {
  id: string;
  type: NodeType;
  in_catalog: boolean;
  depth: number;
  note?: string;
}

export interface Evidence {
  relation: 'explicit' | 'inferred';
  source: string;
  detail?: string;
}

export interface LineageEdge {
  from: string;
  to: string;
  relations: ('explicit' | 'inferred')[];
  confirmed_by_both: boolean;
  via?: { workflow: string; task?: string; status?: string };
  columns?: string[];
  evidence: Evidence[];
}

export interface SqlScan {
  table: string;
  sql_file: string;
  resolved_path: string | null;
  status: 'parsed' | 'missing' | 'error';
  targets: string[];
  sources: string[];
  path_sources: string[];
  note?: string;
}

/** Parse each producing SQL file once (cached across traversal). */
export class SqlInferenceCache {
  readonly scans = new Map<string, SqlScan>();
  constructor(private readonly cat: Catalog) {}

  forTable(meta: TableMeta): SqlScan | null {
    const sqlFile = meta.produced_by?.sql_file;
    if (!sqlFile) return null;
    const hit = this.scans.get(meta.name);
    if (hit) return hit;
    const { path, tried } = resolveSqlFile(this.cat, sqlFile);
    let scan: SqlScan;
    if (!path) {
      scan = { table: meta.name, sql_file: sqlFile, resolved_path: null, status: 'missing', targets: [], sources: [], path_sources: [], note: `SQL 文件不存在（已尝试 ${tried.length} 个位置）` };
    } else {
      try {
        const inf = inferSql(readFileSync(path, 'utf8'));
        scan = {
          table: meta.name,
          sql_file: sqlFile,
          resolved_path: path,
          status: 'parsed',
          targets: inf.targets.map((t) => t.name),
          sources: inf.sources.map((s) => `${s.name}@L${s.line}`),
          path_sources: inf.path_sources.map((s) => `${s.name}@L${s.line}`),
        };
        if (!inf.targets.length) scan.note = 'SQL 中未发现 INSERT/CREATE TABLE AS 目标；写入目标只能取自元数据 produced_by（explicit）';
      } catch (e) {
        scan = { table: meta.name, sql_file: sqlFile, resolved_path: path, status: 'error', targets: [], sources: [], path_sources: [], note: e instanceof Error ? e.message : String(e) };
      }
    }
    this.scans.set(meta.name, scan);
    return scan;
  }
}

export function refName(s: string): { name: string; line?: number } {
  const m = /^(.*)@L(\d+)$/.exec(s);
  return m ? { name: m[1], line: Number(m[2]) } : { name: s };
}
