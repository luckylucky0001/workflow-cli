import { createReadStream, existsSync, readdirSync, statSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import type { TableMeta } from './catalog';
import { isValidDate } from './time';

/**
 * Physical partition inspection on a local filesystem warehouse.
 * Layout: <table_dir>/<key>=<value>[/<key2>=<value2>]/part-*.json|csv
 * Spark side files are ignored: `_SUCCESS` (checked separately), `_temporary`,
 * `*.crc`, and anything hidden (`.` / `_` prefix).
 */

export interface DataFile {
  name: string;
  path: string;
  bytes: number;
  modified_ms: number;
}

export interface PartitionScan {
  path: string;
  exists: boolean;
  is_dir: boolean;
  files: DataFile[];
  ignored: string[];
  in_progress_markers: string[];
  marker: { name: string; present: boolean; modified_ms?: number } | null;
  dir_modified_ms?: number;
}

export type PartitionState = 'missing' | 'empty' | 'incomplete' | 'unreadable' | 'present';

function safeStat(p: string): Stats | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

export function isDataFileName(name: string): boolean {
  return !name.startsWith('.') && !name.startsWith('_') && !name.endsWith('.crc');
}

export function scanPartitionDir(dir: string, meta: TableMeta): PartitionScan {
  const st = safeStat(dir);
  const markerName = meta.success_marker;
  const scan: PartitionScan = {
    path: dir,
    exists: st !== null,
    is_dir: st?.isDirectory() ?? false,
    files: [],
    ignored: [],
    in_progress_markers: [],
    marker: markerName ? { name: markerName, present: false } : null,
    ...(st ? { dir_modified_ms: st.mtimeMs } : {}),
  };
  if (!st || !st.isDirectory()) return scan;
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const s = safeStat(full);
    if (!s) continue;
    if (markerName && name === markerName && s.isFile()) {
      scan.marker = { name, present: true, modified_ms: s.mtimeMs };
      continue;
    }
    if (s.isDirectory()) {
      if (name === '_temporary' || name.startsWith('.spark-staging') || name.startsWith('_temporary')) scan.in_progress_markers.push(`${name}/`);
      else scan.ignored.push(`${name}/`);
      continue;
    }
    if (!s.isFile() || !isDataFileName(name)) {
      scan.ignored.push(name);
      continue;
    }
    scan.files.push({ name, path: full, bytes: s.size, modified_ms: s.mtimeMs });
  }
  return scan;
}

export function totalBytes(scan: PartitionScan): number {
  return scan.files.reduce((a, f) => a + f.bytes, 0);
}

/** Latest write evidence: the success marker if present, else the newest data file. */
export function updatedAtMs(scan: PartitionScan): number | null {
  if (scan.marker?.present && scan.marker.modified_ms !== undefined) return scan.marker.modified_ms;
  if (!scan.files.length) return null;
  return Math.max(...scan.files.map((f) => f.modified_ms));
}

export function physicalState(scan: PartitionScan): Exclude<PartitionState, 'unreadable'> {
  if (!scan.exists || !scan.is_dir) return 'missing';
  if (!scan.files.length || totalBytes(scan) === 0) return 'empty';
  if (scan.marker && !scan.marker.present) return 'incomplete';
  return 'present';
}

// ---------------------------------------------------------------------------
// Partition directory listing
// ---------------------------------------------------------------------------

export interface PartitionDir {
  spec: string;
  values: Record<string, string>;
  dir: string;
}

export function listPartitionDirs(tableDir: string, meta: TableMeta): { partitions: PartitionDir[]; nonconforming: string[] } {
  const partitions: PartitionDir[] = [];
  const nonconforming: string[] = [];
  const walk = (dir: string, depth: number, values: Record<string, string>, prefix: string[]) => {
    const key = meta.partition_keys[depth];
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith('.') || name.startsWith('_')) continue;
      const full = join(dir, name);
      const st = safeStat(full);
      if (!st?.isDirectory()) {
        if (depth === 0 && st?.isFile() && name.endsWith('.crc')) continue;
        nonconforming.push([...prefix, name].join('/'));
        continue;
      }
      const m = name.startsWith(`${key.name}=`) ? name.slice(key.name.length + 1) : null;
      if (m === null || !m || (key.type === 'date' && !isValidDate(m))) {
        nonconforming.push([...prefix, `${name}/`].join('/'));
        continue;
      }
      const v = { ...values, [key.name]: m };
      const p = [...prefix, name];
      if (depth + 1 < meta.partition_keys.length) walk(full, depth + 1, v, p);
      else partitions.push({ spec: p.join('/'), values: v, dir: full });
    }
  };
  if (meta.partition_keys.length && existsSync(tableDir)) walk(tableDir, 0, {}, []);
  return { partitions, nonconforming };
}

// ---------------------------------------------------------------------------
// Record reading (JSON lines / CSV with header)
// ---------------------------------------------------------------------------

export interface RecordItem {
  line: number;
  record?: Record<string, unknown>;
  error?: string;
  /** CSV header problem: an error item that is not a data row. */
  header?: boolean;
}

function lineReader(path: string) {
  const stream = createReadStream(path);
  const input = path.endsWith('.gz') ? stream.pipe(createGunzip()) : stream;
  const rl = createInterface({ input, crlfDelay: Infinity });
  return { rl, close: () => { rl.close(); stream.destroy(); } };
}

export function parseCsvLine(line: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += c;
    } else if (c === '"') {
      if (cur.length) return null;
      inQ = true;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (inQ) return null;
  out.push(cur);
  return out;
}

function quoteBalanced(s: string): boolean {
  let n = 0;
  for (const c of s) if (c === '"') n++;
  return n % 2 === 0;
}

/**
 * Yield records of one data file. Blank lines are skipped. Each yielded item is
 * either a parsed record or a parse error with its 1-based line number.
 * CSV: header row required; empty fields become null (CSV has no null literal).
 */
export async function* readRecords(file: string, format: 'json' | 'csv', maxRecords = Infinity): AsyncGenerator<RecordItem> {
  if (maxRecords <= 0) return;
  const { rl, close } = lineReader(file);
  let lineNo = 0;
  let emitted = 0;
  try {
    if (format === 'json') {
      for await (const raw of rl) {
        lineNo++;
        const line = lineNo === 1 ? raw.replace(/^\uFEFF/, '') : raw;
        if (!line.trim()) continue;
        let item: RecordItem;
        try {
          const v = JSON.parse(line);
          item = v && typeof v === 'object' && !Array.isArray(v) ? { line: lineNo, record: v } : { line: lineNo, error: '不是 JSON 对象' };
        } catch (e) {
          item = { line: lineNo, error: e instanceof Error ? e.message.slice(0, 160) : String(e) };
        }
        yield item;
        if (++emitted >= maxRecords) return;
      }
      return;
    }
    let header: string[] | null = null;
    let pending = '';
    let startLine = 0;
    for await (const raw of rl) {
      lineNo++;
      const line = lineNo === 1 ? raw.replace(/^\uFEFF/, '') : raw;
      if (!pending && !line.trim()) continue;
      if (!pending) startLine = lineNo;
      pending = pending ? `${pending}\n${line}` : line;
      if (!quoteBalanced(pending)) continue;
      const fields = parseCsvLine(pending);
      pending = '';
      if (!header) {
        if (!fields || !fields.length || fields.some((f) => !f.trim())) {
          yield { line: startLine, error: 'CSV 表头无法解析或含空列名', header: true };
          return;
        }
        header = fields.map((f) => f.trim());
        continue;
      }
      let item: RecordItem;
      if (!fields) item = { line: startLine, error: 'CSV 引号不匹配' };
      else if (fields.length !== header.length) item = { line: startLine, error: `字段数 ${fields.length} 与表头 ${header.length} 不一致` };
      else item = { line: startLine, record: Object.fromEntries(header.map((h, i) => [h, fields[i] === '' ? null : fields[i]])) };
      yield item;
      if (++emitted >= maxRecords) return;
    }
    // a file without any non-blank line has no header and no rows: empty, not malformed
    if (pending) yield { line: startLine, error: 'CSV 记录在文件末尾未闭合（引号不匹配）' };
  } finally {
    close();
  }
}

export interface ReadabilityResult {
  file: string;
  ok: boolean;
  records_parsed: number;
  parse_error_count: number;
  parse_errors: { line: number; error: string }[];
  open_error?: string;
}

/** Open each file and parse its first `n` records. */
export async function checkReadability(files: DataFile[], format: 'json' | 'csv', n: number): Promise<{ results: ReadabilityResult[]; observed_columns: string[] }> {
  const results: ReadabilityResult[] = [];
  const cols = new Set<string>();
  for (const f of files) {
    const r: ReadabilityResult = { file: f.name, ok: true, records_parsed: 0, parse_error_count: 0, parse_errors: [] };
    try {
      for await (const item of readRecords(f.path, format, n)) {
        if (item.record) {
          r.records_parsed++;
          for (const k of Object.keys(item.record)) cols.add(k);
        } else {
          r.parse_error_count++;
          if (r.parse_errors.length < 5) r.parse_errors.push({ line: item.line, error: item.error ?? 'unknown' });
        }
      }
    } catch (e) {
      r.open_error = e instanceof Error ? e.message : String(e);
    }
    r.ok = !r.open_error && r.parse_error_count === 0;
    results.push(r);
  }
  return { results, observed_columns: [...cols].sort() };
}
