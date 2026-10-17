import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import YAML from 'yaml';
import { z } from 'zod';
import { WorkError } from '../../core/output';
import { parseDuration } from '../../core/runtime';
import { businessTimezone, type Catalog, type ParsedPartition, type TableMeta } from './catalog';
import { physicalState, readRecords, updatedAtMs, type DataFile, type PartitionScan, type PartitionState } from './partitions';
import { addDays, dateInZone, formatInZone, isValidTimeZone, zonedToInstant } from './time';

// ---------------------------------------------------------------------------
// Ruleset model: <rules_dir>/<ruleset>.yaml
// ---------------------------------------------------------------------------

const base = {
  id: z.string().regex(/^[A-Za-z0-9_.:()#,-]+$/).optional(),
  description: z.string().optional(),
  severity: z.enum(['error', 'warn']).default('error').describe('warn 级失败不改变总体 quality_state'),
};

export const RuleSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('partition_exists'), require_success_marker: z.boolean().default(true) }),
  z.object({ ...base, type: z.literal('row_count_min'), min: z.number().int().nonnegative() }),
  z.object({ ...base, type: z.literal('row_count_max'), max: z.number().int().nonnegative() }),
  z.object({ ...base, type: z.literal('not_null'), columns: z.array(z.string()).min(1) }),
  z.object({ ...base, type: z.literal('unique'), columns: z.array(z.string()).min(1) }),
  z.object({ ...base, type: z.literal('accepted_values'), column: z.string(), values: z.array(z.union([z.string(), z.number(), z.boolean()])).min(1) }),
  z.object({ ...base, type: z.literal('value_range'), column: z.string(), min: z.number().optional(), max: z.number().optional() }),
  z.object({
    ...base,
    type: z.literal('partition_value_match'),
    column: z.string(),
    key: z.string().optional().describe('分区键名，默认第一个分区键；date 键按业务时区比较日期'),
  }),
  z.object({ ...base, type: z.literal('schema_match'), expected_columns: z.array(z.string()).optional(), allow_extra: z.boolean().default(false) }),
  z.object({
    ...base,
    type: z.literal('freshness'),
    expected_by: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().describe('业务时区 HH:MM；默认取表元数据 freshness'),
    day_offset: z.number().int().min(0).optional(),
    timezone: z.string().optional(),
    max_age: z.string().optional().describe('如 26h；相对检查时刻'),
  }),
]);
export type Rule = z.infer<typeof RuleSchema>;

export const RulesetSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  table: z.string().optional().describe('适用的表；设置后与 --dataset 解析结果必须一致'),
  rules: z.array(RuleSchema).min(1),
});
export type Ruleset = z.infer<typeof RulesetSchema>;

export function loadRuleset(cat: Catalog, name: string): { ruleset: Ruleset; file: string } {
  if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.includes('..')) throw new WorkError('INVALID_ARGUMENT', `规则集名称不合法: ${name}`);
  const file = [join(cat.rulesDir, `${name}.yaml`), join(cat.rulesDir, `${name}.yml`)].find((f) => existsSync(f));
  if (!file) {
    throw new WorkError('NOT_FOUND', `规则集不存在: ${name}`, { hint: `规则集目录: ${cat.rulesDir}（端点 rules_dir，默认 <metadata_dir>/../quality-rules）` });
  }
  let raw: unknown;
  try {
    raw = YAML.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new WorkError('INVALID_ARGUMENT', `规则集 YAML 无法解析: ${file}`, { details: { reason: String(e) } });
  }
  const parsed = RulesetSchema.safeParse(raw);
  if (!parsed.success) {
    throw new WorkError('INVALID_ARGUMENT', `规则集结构不合法: ${file}`, { details: { issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) } });
  }
  return { ruleset: parsed.data, file };
}

export function ruleId(rule: Rule): string {
  if (rule.id) return rule.id;
  if ('columns' in rule && rule.columns) return `${rule.type}(${rule.columns.join(',')})`;
  if ('column' in rule) return `${rule.type}(${rule.column})`;
  return rule.type;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export const RuleStatus = z.enum(['pass', 'fail', 'error', 'skipped']);

export const RuleResultSchema = z.object({
  id: z.string(),
  type: z.string(),
  severity: z.enum(['error', 'warn']),
  implicit: z.boolean().describe('规则集未声明、由检查器自动加入的检查'),
  status: RuleStatus,
  evaluated_on: z.enum(['full', 'sample', 'filesystem', 'none']).describe('full=全量记录；sample=抽样记录；filesystem=目录/文件属性'),
  conclusive: z.boolean().describe('抽样模式下的 pass 不是结论性的；fail 总是结论性的'),
  message: z.string(),
  expected: z.record(z.string(), z.unknown()).optional(),
  observed: z.record(z.string(), z.unknown()).optional(),
  samples: z.array(z.record(z.string(), z.unknown())).optional().describe('最多 5 条违规样本，敏感列已脱敏'),
});
export type RuleResult = z.infer<typeof RuleResultSchema>;

export const QualityResultSchema = z.object({
  dataset: z.object({ input: z.string(), catalog: z.string(), table: z.string(), method: z.string() }),
  partition: z.string(),
  ruleset: z.object({ name: z.string(), file: z.string(), rules: z.number() }),
  quality_state: z.enum(['pass', 'fail', 'error']),
  conclusive: z.boolean(),
  precondition: z.object({ ok: z.boolean(), partition_state: z.enum(['missing', 'empty', 'incomplete', 'unreadable', 'present']), path: z.string(), reason: z.string().optional() }),
  summary: z.object({ total: z.number(), pass: z.number(), fail: z.number(), error: z.number(), skipped: z.number(), warn_failures: z.number() }),
  results: z.array(RuleResultSchema),
  scan: z.object({
    mode: z.enum(['full', 'sampled', 'none']),
    sample_rows: z.number().optional(),
    rows_read: z.number(),
    rows_total: z.number().nullable(),
    files_read: z.number(),
    files_total: z.number(),
    parse_errors: z.number(),
  }),
  checked_at: z.string(),
  persisted_to: z.string().nullable(),
});
export type QualityResult = z.infer<typeof QualityResultSchema>;

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

const MAX_SAMPLES = 5;
/** Full scans stop after this many records; the result is then marked sampled. */
const FULL_SCAN_ROW_CAP = 2_000_000;

type Row = Record<string, unknown>;
interface Loc {
  file: string;
  line: number;
}

function isNull(v: unknown): boolean {
  return v === null || v === undefined;
}

export function maskRow(row: Row, sensitive: Set<string>): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (sensitive.has(k) && !isNull(v)) out[k] = '***';
    else if (typeof v === 'string' && v.length > 200) out[k] = `${v.slice(0, 200)}…`;
    else out[k] = v;
  }
  return out;
}

interface Acc {
  observe(row: Row, loc: Loc): void;
  finish(): Pick<RuleResult, 'status' | 'message' | 'observed' | 'expected' | 'samples'>;
}

/** Business date of a cell value (date or timestamp) in `tz`; null when it cannot be interpreted. */
export function cellDate(v: unknown, tz: string | undefined): string | null {
  if (typeof v !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m = /^(\d{4}-\d{2}-\d{2})[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(v);
  if (!m) return null;
  if (!m[4]) return m[1]; // no offset: already local wall-clock time
  const ms = Date.parse(v.replace(' ', 'T'));
  if (!Number.isFinite(ms) || !tz) return null;
  return dateInZone(ms, tz);
}

function makeAcc(rule: Rule, meta: TableMeta, mask: (r: Row) => Row, format: 'json' | 'csv', part: ParsedPartition): Acc | null {
  const sample = (samples: Row[], row: Row, loc: Loc, extra: Row = {}) => {
    if (samples.length < MAX_SAMPLES) samples.push({ file: loc.file, line: loc.line, ...extra, row: mask(row) });
  };
  switch (rule.type) {
    case 'not_null': {
      const counts: Record<string, number> = Object.fromEntries(rule.columns.map((c) => [c, 0]));
      const samples: Row[] = [];
      let rows = 0;
      return {
        observe(row, loc) {
          rows++;
          let bad = false;
          for (const c of rule.columns) if (isNull(row[c])) {
            counts[c]++;
            bad = true;
          }
          if (bad) sample(samples, row, loc);
        },
        finish() {
          const total = Object.values(counts).reduce((a, b) => a + b, 0);
          return {
            status: total ? 'fail' : 'pass',
            message: total ? `${Object.entries(counts).filter(([, n]) => n).map(([c, n]) => `${c} 有 ${n} 行为空`).join('，')}` : `${rule.columns.join(', ')} 均无空值`,
            expected: { columns: rule.columns, null_count: 0 },
            observed: { rows_checked: rows, null_counts: counts, ...(format === 'json' ? { null_semantics: 'JSON null 或字段缺失均计为空' } : { null_semantics: 'CSV 空字段计为空' }) },
            ...(samples.length ? { samples } : {}),
          };
        },
      };
    }
    case 'unique': {
      const seen = new Map<string, { count: number; first: Loc }>();
      const samples: Row[] = [];
      let nullKeys = 0;
      let rows = 0;
      return {
        observe(row, loc) {
          rows++;
          const vals = rule.columns.map((c) => row[c]);
          if (vals.some(isNull)) {
            nullKeys++;
            return;
          }
          const key = JSON.stringify(vals.map((v) => String(v)));
          const hit = seen.get(key);
          if (hit) {
            hit.count++;
            sample(samples, row, loc, { key: Object.fromEntries(rule.columns.map((c, i) => [c, vals[i]])), first_seen: `${hit.first.file}:${hit.first.line}` });
          } else seen.set(key, { count: 1, first: loc });
        },
        finish() {
          let dupKeys = 0;
          let dupRows = 0;
          for (const v of seen.values()) if (v.count > 1) {
            dupKeys++;
            dupRows += v.count - 1;
          }
          return {
            status: dupKeys ? 'fail' : 'pass',
            message: dupKeys ? `${rule.columns.join(', ')} 有 ${dupKeys} 个重复键（多出 ${dupRows} 行）` : `${rule.columns.join(', ')} 无重复`,
            expected: { columns: rule.columns, duplicate_keys: 0 },
            observed: { rows_checked: rows, distinct_keys: seen.size, duplicate_keys: dupKeys, extra_rows: dupRows, null_key_rows_skipped: nullKeys },
            ...(samples.length ? { samples } : {}),
          };
        },
      };
    }
    case 'accepted_values': {
      const allowed = new Set(rule.values.map((v) => String(v)));
      const invalid = new Map<string, number>();
      const samples: Row[] = [];
      let rows = 0;
      let nulls = 0;
      let bad = 0;
      return {
        observe(row, loc) {
          rows++;
          const v = row[rule.column];
          if (isNull(v)) {
            nulls++;
            return;
          }
          if (!allowed.has(String(v))) {
            bad++;
            invalid.set(String(v), (invalid.get(String(v)) ?? 0) + 1);
            sample(samples, row, loc);
          }
        },
        finish() {
          const top = [...invalid.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([value, count]) => ({ value: meta.columns.find((c) => c.name === rule.column)?.sensitive ? '***' : value, count }));
          return {
            status: bad ? 'fail' : 'pass',
            message: bad ? `${rule.column} 有 ${bad} 行取值不在允许列表中` : `${rule.column} 取值均在允许列表中`,
            expected: { column: rule.column, values: rule.values },
            observed: { rows_checked: rows, invalid_rows: bad, invalid_values: top, null_rows_skipped: nulls },
            ...(samples.length ? { samples } : {}),
          };
        },
      };
    }
    case 'value_range': {
      const samples: Row[] = [];
      let rows = 0;
      let below = 0;
      let above = 0;
      let nonNumeric = 0;
      let nulls = 0;
      let minSeen: number | null = null;
      let maxSeen: number | null = null;
      return {
        observe(row, loc) {
          rows++;
          const v = row[rule.column];
          if (isNull(v)) {
            nulls++;
            return;
          }
          const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
          if (!Number.isFinite(n)) {
            nonNumeric++;
            sample(samples, row, loc, { reason: 'non_numeric' });
            return;
          }
          minSeen = minSeen === null ? n : Math.min(minSeen, n);
          maxSeen = maxSeen === null ? n : Math.max(maxSeen, n);
          if (rule.min !== undefined && n < rule.min) {
            below++;
            sample(samples, row, loc, { reason: 'below_min' });
          } else if (rule.max !== undefined && n > rule.max) {
            above++;
            sample(samples, row, loc, { reason: 'above_max' });
          }
        },
        finish() {
          const bad = below + above + nonNumeric;
          return {
            status: bad ? 'fail' : 'pass',
            message: bad ? `${rule.column} 有 ${bad} 行超出范围或不是数值` : `${rule.column} 均在范围内`,
            expected: { column: rule.column, ...(rule.min !== undefined ? { min: rule.min } : {}), ...(rule.max !== undefined ? { max: rule.max } : {}), inclusive: true },
            observed: { rows_checked: rows, below_min: below, above_max: above, non_numeric: nonNumeric, null_rows_skipped: nulls, min_observed: minSeen, max_observed: maxSeen },
            ...(samples.length ? { samples } : {}),
          };
        },
      };
    }
    case 'partition_value_match': {
      const keyName = rule.key ?? meta.partition_keys[0]?.name;
      const key = part.values.find((k) => k.name === keyName);
      const tz = key?.timezone ?? businessTimezone(meta);
      const seen = new Map<string, number>();
      const samples: Row[] = [];
      let rows = 0;
      let mismatched = 0;
      return {
        observe(row, loc) {
          if (!key) return;
          rows++;
          const v = row[rule.column];
          const norm = key.type === 'date' ? cellDate(v, tz) : isNull(v) ? null : String(v);
          const label = norm ?? `(无法解析: ${isNull(v) ? 'null' : String(v).slice(0, 40)})`;
          seen.set(label, (seen.get(label) ?? 0) + 1);
          if (norm !== key.value) {
            mismatched++;
            sample(samples, row, loc);
          }
        },
        finish() {
          if (!key) return { status: 'error', message: `表没有分区键 ${keyName ?? '(无)'}` };
          const values = [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([value, count]) => ({ value, count }));
          return {
            status: mismatched ? 'fail' : 'pass',
            message: mismatched ? `${mismatched} 行的 ${rule.column} 与分区 ${key.name}=${key.value} 不一致（分区路径与数据内容错位）` : `${rule.column} 均与分区 ${key.name}=${key.value} 一致`,
            expected: { column: rule.column, partition_key: key.name, value: key.value, ...(key.type === 'date' && tz ? { timezone: tz } : {}) },
            observed: { rows_checked: rows, mismatched, values },
            ...(samples.length ? { samples } : {}),
          };
        },
      };
    }
    case 'schema_match': {
      const observedCols = new Set<string>();
      let rows = 0;
      return {
        observe(row) {
          rows++;
          for (const k of Object.keys(row)) observedCols.add(k);
        },
        finish() {
          const expected = rule.expected_columns ?? meta.columns.map((c) => c.name);
          const partKeys = new Set(meta.partition_keys.map((k) => k.name));
          const missing = expected.filter((c) => !observedCols.has(c));
          const absentNullable = format === 'json' ? missing.filter((c) => meta.columns.find((m) => m.name === c)?.nullable === true) : [];
          const missingRequired = missing.filter((c) => !absentNullable.includes(c));
          const extra = [...observedCols].filter((c) => !expected.includes(c) && !partKeys.has(c)).sort();
          const fail = rows > 0 && (missingRequired.length > 0 || (extra.length > 0 && !rule.allow_extra));
          const msgs: string[] = [];
          if (missingRequired.length) msgs.push(`缺少列 ${missingRequired.join(', ')}`);
          if (extra.length) msgs.push(`多出列 ${extra.join(', ')}${rule.allow_extra ? '（允许）' : ''}`);
          if (absentNullable.length) msgs.push(`可空列 ${absentNullable.join(', ')} 未出现（Spark 写 JSON 默认省略 null 字段，可能整列为空）`);
          return {
            status: rows === 0 ? 'skipped' : fail ? 'fail' : 'pass',
            message: rows === 0 ? '没有可读记录，无法比较结构' : msgs.length ? msgs.join('；') : '观测到的列与期望一致',
            expected: { columns: expected, allow_extra: rule.allow_extra },
            observed: { rows_checked: rows, columns: [...observedCols].sort(), missing: missingRequired, absent_nullable: absentNullable, extra },
          };
        },
      };
    }
    default:
      return null;
  }
}

function partitionDate(part: ParsedPartition): string | undefined {
  return part.values.find((v) => v.type === 'date')?.value;
}

function evalFreshness(rule: Extract<Rule, { type: 'freshness' }>, meta: TableMeta, part: ParsedPartition, scan: PartitionScan, now: number): Pick<RuleResult, 'status' | 'message' | 'observed' | 'expected'> {
  const updated = updatedAtMs(scan);
  const tz = rule.timezone ?? businessTimezone(meta);
  const expectedBy = rule.expected_by ?? meta.freshness?.expected_by;
  const offset = rule.day_offset ?? meta.freshness?.day_offset ?? 1;
  if (!expectedBy && !rule.max_age) {
    return { status: 'error', message: '规则和表元数据都没有配置 expected_by 或 max_age' };
  }
  if (updated === null) return { status: 'fail', message: '分区没有数据文件或完成标记，无法确定更新时间' };
  const observed: Record<string, unknown> = {
    updated_at: new Date(updated).toISOString(),
    basis: scan.marker?.present ? `${scan.marker.name} 文件修改时间（本地文件系统 mtime）` : '最新数据文件修改时间（本地文件系统 mtime）',
  };
  const expected: Record<string, unknown> = {};
  const problems: string[] = [];
  if (expectedBy) {
    const date = partitionDate(part);
    if (!date) return { status: 'error', message: 'expected_by 需要 date 类型分区键作为业务日期' };
    if (!tz || !isValidTimeZone(tz)) return { status: 'error', message: '无法确定业务时区（分区键 timezone / freshness.timezone）' };
    const deadline = zonedToInstant(addDays(date, offset), expectedBy, tz);
    expected.deadline = formatInZone(deadline, tz);
    expected.rule = `业务日期 ${date} + ${offset} 天 ${expectedBy} (${tz}) 前产出`;
    observed.updated_at_local = formatInZone(updated, tz);
    if (updated > deadline) problems.push(`更新时间 ${formatInZone(updated, tz)} 晚于期限 ${formatInZone(deadline, tz)}`);
  }
  if (rule.max_age) {
    let maxAge: number;
    try {
      maxAge = parseDuration(rule.max_age);
    } catch {
      return { status: 'error', message: `max_age 无法解析: ${rule.max_age}` };
    }
    expected.max_age = rule.max_age;
    observed.age_seconds = Math.round((now - updated) / 1000);
    if (now - updated > maxAge) problems.push(`距今 ${Math.round((now - updated) / 60000)} 分钟，超过 max_age ${rule.max_age}`);
  }
  return { status: problems.length ? 'fail' : 'pass', message: problems.length ? problems.join('；') : '分区在期限内产出', expected, observed };
}

async function countRecords(path: string, format: 'json' | 'csv'): Promise<number> {
  if (format === 'csv') {
    let n = 0;
    for await (const item of readRecords(path, 'csv')) if (!item.header) n++;
    return n;
  }
  const stream = createReadStream(path);
  const input = path.endsWith('.gz') ? stream.pipe(createGunzip()) : stream;
  const rl = createInterface({ input, crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const line of rl) if (line.trim()) n++;
  } finally {
    rl.close();
    stream.destroy();
  }
  return n;
}

export interface EvaluateInput {
  meta: TableMeta;
  part: ParsedPartition;
  scan: PartitionScan;
  ruleset: Ruleset;
  sampleRows?: number;
  now?: number;
}

export interface Evaluation {
  quality_state: QualityResult['quality_state'];
  conclusive: boolean;
  precondition: QualityResult['precondition'];
  summary: QualityResult['summary'];
  results: RuleResult[];
  scan: QualityResult['scan'];
}

export async function evaluateRuleset(inp: EvaluateInput): Promise<Evaluation> {
  const { meta, part, scan, ruleset } = inp;
  const now = inp.now ?? Date.now();
  const sensitive = new Set(meta.columns.filter((c) => c.sensitive).map((c) => c.name));
  const mask = (r: Row) => maskRow(r, sensitive);
  const state: PartitionState = physicalState(scan);

  const rules = [...ruleset.rules];
  const implicit = new Set<Rule>();
  if (!rules.some((r) => r.type === 'partition_exists')) {
    const r: Rule = { type: 'partition_exists', severity: 'error', require_success_marker: true };
    rules.unshift(r);
    implicit.add(r);
  }
  const pe = rules.find((r) => r.type === 'partition_exists') as Extract<Rule, { type: 'partition_exists' }>;
  const requireMarker = pe.require_success_marker && scan.marker !== null;
  let preReason: string | undefined;
  if (state === 'missing') preReason = '分区目录不存在';
  else if (state === 'incomplete' && requireMarker) preReason = `分区缺少完成标记 ${scan.marker?.name}，可能仍在写入或写入失败`;
  const preOk = !preReason;

  const ids = new Map<string, number>();
  const uid = (r: Rule) => {
    const id = ruleId(r);
    const n = (ids.get(id) ?? 0) + 1;
    ids.set(id, n);
    return n > 1 ? `${id}#${n}` : id;
  };

  const sampleMode = inp.sampleRows !== undefined && inp.sampleRows > 0;
  let budget = sampleMode ? inp.sampleRows! : FULL_SCAN_ROW_CAP;
  const accs = new Map<Rule, Acc>();
  const needsRows = preOk && rules.some((r) => !['partition_exists', 'freshness', 'row_count_min', 'row_count_max'].includes(r.type));
  const needsCount = preOk && rules.some((r) => r.type === 'row_count_min' || r.type === 'row_count_max');
  for (const r of rules) {
    const a = makeAcc(r, meta, mask, meta.format, part);
    if (a) accs.set(r, a);
  }

  let rowsRead = 0;
  let parseErrors = 0;
  const parseSamples: Row[] = [];
  let filesRead = 0;
  let rowsTotal: number | null = null;
  if (preOk && (needsRows || needsCount)) {
    let total = 0;
    for (const f of scan.files as DataFile[]) {
      let inFile = 0;
      let headerErrors = 0;
      let exhausted = false;
      if (needsRows && budget > 0) {
        filesRead++;
        const before = budget;
        for await (const item of readRecords(f.path, meta.format, budget)) {
          inFile++;
          if (item.header) headerErrors++;
          if (item.record) {
            rowsRead++;
            for (const a of accs.values()) a.observe(item.record, { file: f.name, line: item.line });
          } else {
            parseErrors++;
            if (parseSamples.length < MAX_SAMPLES) parseSamples.push({ file: f.name, line: item.line, error: item.error });
          }
        }
        budget -= inFile;
        exhausted = inFile < before;
      }
      // row_count rules always use the full count, also in sample mode
      total += exhausted ? inFile - headerErrors : await countRecords(f.path, meta.format);
    }
    rowsTotal = total;
  }
  const sampled = needsRows && rowsTotal !== null && rowsRead + parseErrors < rowsTotal;
  const evaluatedOn: RuleResult['evaluated_on'] = sampled ? 'sample' : 'full';

  const results: RuleResult[] = [];
  const push = (r: Rule, res: Pick<RuleResult, 'status' | 'message'> & Partial<RuleResult>, on: RuleResult['evaluated_on']) => {
    results.push({
      id: uid(r),
      type: r.type,
      severity: r.severity,
      implicit: implicit.has(r),
      evaluated_on: on,
      conclusive: res.status === 'fail' || (res.status === 'pass' && on !== 'sample'),
      ...res,
    });
  };

  for (const r of rules) {
    if (r.type === 'partition_exists') {
      const ok = state !== 'missing' && !(state === 'incomplete' && requireMarker);
      push(r, {
        status: ok ? 'pass' : 'fail',
        message: ok ? `分区存在${scan.marker?.present ? `，含完成标记 ${scan.marker.name}` : ''}` : preReason ?? '分区不满足存在条件',
        expected: { exists: true, success_marker: requireMarker ? scan.marker?.name : null },
        observed: { partition_state: state, path: scan.path, success_marker_present: scan.marker?.present ?? null, data_files: scan.files.length },
      }, 'filesystem');
      continue;
    }
    if (!preOk) {
      push(r, { status: 'skipped', message: `前置条件不满足：${preReason}` }, 'none');
      continue;
    }
    if (r.type === 'freshness') {
      push(r, evalFreshness(r, meta, part, scan, now), 'filesystem');
      continue;
    }
    if (r.type === 'row_count_min' || r.type === 'row_count_max') {
      const n = rowsTotal ?? 0;
      const ok = r.type === 'row_count_min' ? n >= r.min : n <= r.max;
      push(r, {
        status: ok ? 'pass' : 'fail',
        message: ok ? `行数 ${n} 满足要求` : r.type === 'row_count_min' ? `行数 ${n} 少于下限 ${r.min}` : `行数 ${n} 超过上限 ${r.max}`,
        expected: r.type === 'row_count_min' ? { min: r.min } : { max: r.max },
        observed: { rows: n, counting: meta.format === 'json' ? '非空行数（含无法解析的行）' : 'CSV 数据记录数' },
      }, 'full');
      continue;
    }
    if (r.type === 'value_range' && r.min === undefined && r.max === undefined) {
      push(r, { status: 'error', message: 'value_range 需要 min 或 max' }, 'none');
      continue;
    }
    const acc = accs.get(r);
    if (!acc) {
      push(r, { status: 'error', message: `未知规则类型 ${(r as Rule).type}` }, 'none');
      continue;
    }
    const declared = new Set(meta.columns.map((c) => c.name));
    const cols = 'columns' in r && r.columns ? r.columns : 'column' in r ? [r.column] : [];
    const undeclared = cols.filter((c) => !declared.has(c));
    const res = acc.finish();
    if (undeclared.length) res.message += `（注意：列 ${undeclared.join(', ')} 未在表元数据中声明）`;
    push(r, res, evaluatedOn);
  }
  // implicit: records must parse
  if (preOk && needsRows) {
    results.push({
      id: 'records_parseable',
      type: 'records_parseable',
      severity: 'error',
      implicit: true,
      status: parseErrors ? 'fail' : 'pass',
      evaluated_on: evaluatedOn,
      conclusive: parseErrors > 0 || evaluatedOn === 'full',
      message: parseErrors ? `${parseErrors} 行无法解析为 ${meta.format.toUpperCase()} 记录` : `读取的 ${rowsRead} 行均可解析`,
      observed: { rows_read: rowsRead, parse_errors: parseErrors },
      ...(parseSamples.length ? { samples: parseSamples } : {}),
    });
  }

  const blocking = results.filter((r) => r.severity === 'error');
  const qualityState: Evaluation['quality_state'] = !preOk || blocking.some((r) => r.status === 'fail') ? 'fail' : blocking.some((r) => r.status === 'error') ? 'error' : 'pass';
  const summary = {
    total: results.length,
    pass: results.filter((r) => r.status === 'pass').length,
    fail: results.filter((r) => r.status === 'fail').length,
    error: results.filter((r) => r.status === 'error').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    warn_failures: results.filter((r) => r.severity === 'warn' && r.status === 'fail').length,
  };
  const conclusive = qualityState === 'fail' || (qualityState === 'pass' && results.every((r) => r.status !== 'pass' || r.conclusive || r.severity === 'warn'));
  return {
    quality_state: qualityState,
    conclusive,
    precondition: { ok: preOk, partition_state: state === 'present' && parseErrors > 0 ? 'unreadable' : state, path: scan.path, ...(preReason ? { reason: preReason } : {}) },
    summary,
    results,
    scan: {
      mode: !preOk || !(needsRows || needsCount) ? 'none' : sampled ? 'sampled' : 'full',
      ...(sampleMode ? { sample_rows: inp.sampleRows } : {}),
      rows_read: rowsRead + parseErrors,
      rows_total: rowsTotal,
      files_read: filesRead,
      files_total: scan.files.length,
      parse_errors: parseErrors,
    },
  };
}

// ---------------------------------------------------------------------------
// Persistence of the latest result
// ---------------------------------------------------------------------------

function partitionFileName(partition: string): string {
  return `${partition.split('/').filter(Boolean).join('__').replace(/[^A-Za-z0-9_=.:+-]/g, '_')}.json`;
}

export function qualityResultPath(stateDir: string, table: string, partition: string): string {
  if (!/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(table)) throw new WorkError('INVALID_ARGUMENT', `表名须为 db.table: ${table}`);
  return join(stateDir, 'quality', table, partitionFileName(partition));
}

export interface StoredQualityResult extends QualityResult {
  stored_schema_version: '1';
  request_id: string;
  profile: string | null;
  sources: unknown[];
  coverage: unknown;
}

export function writeQualityResult(stateDir: string, table: string, partition: string, record: StoredQualityResult): string {
  const f = qualityResultPath(stateDir, table, partition);
  mkdirSync(join(stateDir, 'quality', table), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2));
  renameSync(tmp, f);
  return f;
}

/**
 * Latest persisted quality result for `table` (db.table) and `partition`
 * (e.g. `dt=2026-10-16`), or null if no check has been recorded. Other domains
 * (offline pipeline checks) use this to report quality_state without rerunning
 * the rules; callers must surface `checked_at` so staleness is visible.
 */
export function readLatestQualityResult(stateDir: string, table: string, partition: string): StoredQualityResult | null {
  const f = qualityResultPath(stateDir, table, partition);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as StoredQualityResult;
  } catch {
    return null;
  }
}
