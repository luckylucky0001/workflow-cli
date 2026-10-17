import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { source, WorkError, type Source } from '../../core/output';
import type { Ctx, Endpoint } from '../../core/runtime';
import { isValidDate, isValidTimeZone } from './time';

export const ADAPTER = 'file-catalog';
export const GUIDE = 'docs/guides/data.md';

// ---------------------------------------------------------------------------
// Table metadata model (provider `file`: one YAML per table under <metadata_dir>/tables)
// ---------------------------------------------------------------------------

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/;

export const PartitionKeySchema = z.object({
  name: z.string().regex(IDENT),
  type: z.enum(['date', 'string']),
  format: z.string().optional().describe('date 类型固定为 YYYY-MM-DD'),
  timezone: z.string().optional().refine((v) => v === undefined || isValidTimeZone(v), { message: '不是有效的 IANA 时区' }),
  semantics: z.string().describe('分区值的业务含义，如“业务日期，Asia/Shanghai 自然日”'),
});
export type PartitionKey = z.infer<typeof PartitionKeySchema>;

export const ColumnSchema = z.object({
  name: z.string().regex(IDENT),
  type: z.string(),
  nullable: z.boolean().default(true),
  description: z.string().optional(),
  sensitive: z.boolean().default(false).describe('敏感列：输出样本中脱敏'),
});
export type Column = z.infer<typeof ColumnSchema>;

export const UpstreamSchema = z.object({
  table: z.string().describe('db.table（目录内表）或外部来源 URI，如 mysql://demo-mysql/demo.orders'),
  relation: z.literal('explicit').default('explicit'),
  columns: z.array(z.string()).optional(),
  note: z.string().optional(),
});

export const ConsumerSchema = z.object({
  type: z.enum(['workflow', 'report', 'service']),
  id: z.string(),
  note: z.string().optional(),
});

export const TableMetaSchema = z.object({
  name: z.string().regex(TABLE_NAME_RE, { message: '表名须为 db.table' }),
  description: z.string(),
  owner: z.string(),
  format: z.enum(['json', 'csv']),
  location: z.string().describe('相对 warehouse_root 的目录'),
  partition_keys: z.array(PartitionKeySchema).default([]),
  columns: z.array(ColumnSchema).min(1),
  write_mode: z.enum(['overwrite_partition', 'append']),
  success_marker: z.string().nullable().default('_SUCCESS').describe('写入完成标记；null 表示该表不写标记'),
  produced_by: z
    .object({
      scheduler: z.string(),
      workflow: z.string(),
      task: z.string().optional(),
      sql_file: z.string().optional().describe('产出 SQL；相对路径按 metadata_dir 及其上级目录依次解析'),
      input_views: z
        .record(z.string(), z.string())
        .optional()
        .describe('调度任务注册给 SQL 的视图名 → 目录表（如 ods_orders: ods.orders）；推断血缘只按此声明解析视图名'),
      status: z.enum(['active', 'planned']).default('active').describe('planned 表示该产出流程尚未在调度系统中接入'),
    })
    .optional(),
  upstream: z.array(UpstreamSchema).default([]),
  consumers: z.array(ConsumerSchema).default([]),
  quality_ruleset: z.string().optional(),
  freshness: z
    .object({
      expected_by: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: '格式为 HH:MM' }),
      day_offset: z.number().int().min(0).default(1).describe('相对业务日期的天数，默认次日'),
      timezone: z.string().optional(),
    })
    .optional(),
});
export type TableMeta = z.infer<typeof TableMetaSchema>;

export interface LoadedTable {
  meta: TableMeta;
  file: string;
}

export interface Catalog {
  name: string;
  endpoint: Endpoint;
  provider: string;
  metadataDir: string;
  tablesDir: string;
  warehouseRoot: string;
  storage: string;
  rulesDir: string;
  tables: Map<string, LoadedTable>;
  /** Files that failed to parse or validate. */
  invalid: { file: string; issues: string[] }[];
  metadataFiles: number;
}

export const STORAGE_LOCAL = 'local-filesystem';

/** Load the catalog endpoint and all table metadata. */
export function openCatalog(ctx: Ctx, name?: string): Catalog {
  const ep = ctx.endpoint('catalog', name);
  const provider = ep.str('provider', 'file');
  if (provider !== 'file') {
    throw new WorkError('UNSUPPORTED', `目录 provider ${provider} 尚未接入（当前只支持 file）`, {
      hint: 'Hive Metastore / 表格式 provider 的接入方式见 docs/guides/data.md',
    });
  }
  const metadataDir = ep.path('metadata_dir');
  if (!metadataDir) throw new WorkError('NOT_CONFIGURED', `目录端点 ${ep.id} 缺少 metadata_dir`);
  const warehouseRoot = ep.path('warehouse_root');
  if (!warehouseRoot) throw new WorkError('NOT_CONFIGURED', `目录端点 ${ep.id} 缺少 warehouse_root`);
  const storage = ep.str('storage', STORAGE_LOCAL);
  if (storage !== STORAGE_LOCAL) {
    throw new WorkError('UNSUPPORTED', `存储类型 ${storage} 尚未接入（file provider 只通过本地文件系统读取）`, {
      hint: '对象存储 / HDFS 需要单独的存储适配器，不能用本地文件系统结果代替',
    });
  }
  const tablesDir = join(metadataDir, 'tables');
  if (!existsSync(tablesDir)) {
    throw new WorkError('NOT_CONFIGURED', `目录元数据目录不存在: ${tablesDir}`, { hint: `检查端点 ${ep.id} 的 metadata_dir` });
  }
  const rulesDir = ep.path('rules_dir') ?? resolve(metadataDir, '..', 'quality-rules');
  const tables = new Map<string, LoadedTable>();
  const invalid: Catalog['invalid'] = [];
  const files = readdirSync(tablesDir).filter((f) => /\.ya?ml$/.test(f)).sort();
  for (const f of files) {
    const full = join(tablesDir, f);
    let raw: unknown;
    try {
      raw = YAML.parse(readFileSync(full, 'utf8'));
    } catch (e) {
      invalid.push({ file: full, issues: [`YAML 解析失败: ${e instanceof Error ? e.message : String(e)}`] });
      continue;
    }
    const parsed = TableMetaSchema.safeParse(raw);
    if (!parsed.success) {
      invalid.push({ file: full, issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
      continue;
    }
    const expected = f.replace(/\.ya?ml$/, '');
    if (expected !== parsed.data.name) {
      invalid.push({ file: full, issues: [`文件名 ${f} 与 name ${parsed.data.name} 不一致（应为 <db>.<table>.yaml）`] });
      continue;
    }
    if (tables.has(parsed.data.name)) {
      invalid.push({ file: full, issues: [`表 ${parsed.data.name} 重复定义`] });
      continue;
    }
    tables.set(parsed.data.name, { meta: parsed.data, file: full });
  }
  return { name: ep.name, endpoint: ep, provider, metadataDir, tablesDir, warehouseRoot, storage, rulesDir, tables, invalid, metadataFiles: files.length };
}

export function requireTable(cat: Catalog, table: string): LoadedTable {
  if (!TABLE_NAME_RE.test(table)) {
    throw new WorkError('INVALID_ARGUMENT', `表名须为 <database>.<table>: ${table}`, { hint: '示例: --table analytics.daily_orders' });
  }
  const t = cat.tables.get(table);
  if (t) return t;
  const bad = cat.invalid.find((i) => basename(i.file).replace(/\.ya?ml$/, '') === table);
  if (bad) {
    throw new WorkError('INVALID_ARGUMENT', `表 ${table} 的目录元数据不合法: ${bad.file}`, { details: { issues: bad.issues } });
  }
  throw new WorkError('NOT_FOUND', `目录 ${cat.name} 中没有表 ${table}`, {
    hint: `已登记的表: ${[...cat.tables.keys()].join(', ') || '(无)'}`,
  });
}

/** Physical table directory; refuses locations that escape the warehouse root. */
export function tableDir(cat: Catalog, meta: TableMeta): string {
  const dir = isAbsolute(meta.location) ? meta.location : resolve(cat.warehouseRoot, meta.location);
  const rel = relative(cat.warehouseRoot, dir);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new WorkError('INVALID_ARGUMENT', `表 ${meta.name} 的 location 超出 warehouse_root`, { details: { location: meta.location } });
  }
  return dir;
}

export function catalogSource(cat: Catalog, method: string, relation: Source['relation'] = 'explicit'): Source {
  return source(ADAPTER, ADAPTER, { endpoint: cat.endpoint.id, method, relation });
}

export function fsSource(cat: Catalog, method: string, relation: Source['relation'] = 'derived'): Source {
  return source(STORAGE_LOCAL, ADAPTER, { endpoint: `${cat.endpoint.id}:warehouse_root`, method, relation });
}

export function storageInfo(cat: Catalog) {
  return {
    type: cat.storage,
    warehouse_root: cat.warehouseRoot,
    note: '通过本地文件系统读取；未验证对象存储或 HDFS',
  };
}

export function catalogNotes(cat: Catalog): string[] {
  return cat.invalid.map((i) => `元数据文件不合法已跳过: ${basename(i.file)} (${i.issues.slice(0, 2).join('; ')})`);
}

// ---------------------------------------------------------------------------
// Partition specs
// ---------------------------------------------------------------------------

export interface PartitionValue {
  name: string;
  value: string;
  type: PartitionKey['type'];
  timezone?: string;
  semantics: string;
}

export interface ParsedPartition {
  spec: string;
  values: PartitionValue[];
  relPath: string;
}

const SAFE_VALUE = /^[A-Za-z0-9_\-.:+]+$/;

/** Parse `dt=2026-10-16` (or `k1=v1/k2=v2`) against the table's partition keys. */
export function parsePartition(meta: TableMeta, spec: string): ParsedPartition {
  if (!meta.partition_keys.length) {
    throw new WorkError('INVALID_ARGUMENT', `表 ${meta.name} 不是分区表`, { hint: '该表没有 partition_keys 定义' });
  }
  const segs = spec.split('/').filter(Boolean);
  const pairs = segs.map((s) => {
    const i = s.indexOf('=');
    if (i <= 0) throw new WorkError('INVALID_ARGUMENT', `分区格式应为 key=value: ${spec}`, { hint: `示例: --partition ${meta.partition_keys[0].name}=2026-10-16` });
    return [s.slice(0, i), s.slice(i + 1)] as const;
  });
  const expected = meta.partition_keys.map((k) => k.name);
  if (pairs.length !== expected.length || pairs.some(([k], idx) => k !== expected[idx])) {
    throw new WorkError('INVALID_ARGUMENT', `分区键与表定义不一致: 给定 ${pairs.map(([k]) => k).join('/')}，表 ${meta.name} 定义为 ${expected.join('/')}`, {
      hint: `示例: --partition ${expected.map((k) => `${k}=...`).join('/')}`,
      details: { expected_keys: expected, given: spec },
    });
  }
  const values: PartitionValue[] = pairs.map(([k, v], idx) => {
    const key = meta.partition_keys[idx];
    if (!v || !SAFE_VALUE.test(v)) throw new WorkError('INVALID_ARGUMENT', `分区值不合法: ${k}=${v}`);
    if (key.type === 'date' && !isValidDate(v)) {
      throw new WorkError('INVALID_ARGUMENT', `分区 ${k} 是 date 类型，值须为有效日期 YYYY-MM-DD: ${v}`);
    }
    return { name: k, value: v, type: key.type, ...(key.timezone ? { timezone: key.timezone } : {}), semantics: key.semantics };
  });
  return { spec: pairs.map(([k, v]) => `${k}=${v}`).join('/'), values, relPath: pairs.map(([k, v]) => `${k}=${v}`).join(sep) };
}

/** Business timezone of the table: first date key timezone, then freshness timezone. */
export function businessTimezone(meta: TableMeta): string | undefined {
  return meta.partition_keys.find((k) => k.type === 'date' && k.timezone)?.timezone ?? meta.freshness?.timezone;
}

// ---------------------------------------------------------------------------
// Dataset resolution for quality checks
// ---------------------------------------------------------------------------

export interface DatasetResolution {
  input: string;
  catalog: string;
  table: string;
  method: string;
}

/**
 * `<catalog>.<db>.<table>` → explicit.
 * `<a>.<b>` with --catalog → table a.b in that catalog.
 * `<a>.<b>` where a is a configured catalog → table whose name ends with `.b`, only if unique.
 * otherwise `<a>.<b>` is treated as db.table in the default catalog.
 */
export function resolveDataset(ctx: Ctx, dataset: string, catalogName?: string): DatasetResolution {
  const segs = dataset.split('.');
  if (segs.some((s) => !IDENT.test(s)) || segs.length < 2 || segs.length > 3) {
    throw new WorkError('INVALID_ARGUMENT', `--dataset 格式应为 <catalog>.<db>.<table> 或 <catalog>.<table>: ${dataset}`);
  }
  if (segs.length === 3) {
    if (catalogName && catalogName !== segs[0]) {
      throw new WorkError('INVALID_ARGUMENT', `--dataset 中的目录 ${segs[0]} 与 --catalog ${catalogName} 不一致`);
    }
    return { input: dataset, catalog: segs[0], table: `${segs[1]}.${segs[2]}`, method: 'explicit <catalog>.<db>.<table>' };
  }
  if (catalogName) {
    return { input: dataset, catalog: catalogName, table: dataset, method: '--catalog 指定目录，dataset 按 <db>.<table> 解析' };
  }
  const catalogs = ctx.endpointNames('catalog');
  if (catalogs.includes(segs[0])) {
    const cat = openCatalog(ctx, segs[0]);
    const matches = [...cat.tables.keys()].filter((t) => t.split('.')[1] === segs[1]);
    if (matches.length === 1) {
      return { input: dataset, catalog: segs[0], table: matches[0], method: `目录 ${segs[0]} 中表名 ${segs[1]} 唯一匹配` };
    }
    if (matches.length > 1) {
      throw new WorkError('INVALID_ARGUMENT', `目录 ${segs[0]} 中有多个表名为 ${segs[1]}: ${matches.join(', ')}`, {
        hint: `使用完整名称 --dataset ${segs[0]}.<db>.${segs[1]}`,
      });
    }
    if (!cat.tables.has(dataset)) {
      throw new WorkError('NOT_FOUND', `目录 ${segs[0]} 中没有表名为 ${segs[1]} 的表`, { hint: `已登记的表: ${[...cat.tables.keys()].join(', ') || '(无)'}` });
    }
  }
  const def = ctx.endpoint('catalog').name;
  return { input: dataset, catalog: def, table: dataset, method: `默认目录 ${def}，dataset 按 <db>.<table> 解析` };
}

// ---------------------------------------------------------------------------
// SQL file resolution
// ---------------------------------------------------------------------------

/** Resolve a relative sql_file against metadata_dir and up to three ancestors. */
export function resolveSqlFile(cat: Catalog, sqlFile: string): { path: string | null; tried: string[] } {
  if (isAbsolute(sqlFile)) return { path: existsSync(sqlFile) ? sqlFile : null, tried: [sqlFile] };
  const tried: string[] = [];
  let base = cat.metadataDir;
  for (let i = 0; i < 4; i++) {
    const p = resolve(base, sqlFile);
    tried.push(p);
    if (existsSync(p) && statSync(p).isFile()) return { path: p, tried };
    const parent = dirname(base);
    if (parent === base) break;
    base = parent;
  }
  return { path: null, tried };
}
