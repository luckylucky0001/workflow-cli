import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { source, WorkError, type Source } from '../../core/output';
import { defineCapability, defineDomain, type CapabilityDef } from '../../core/registry';
import type { Ctx } from '../../core/runtime';
import {
  ADAPTER,
  businessTimezone,
  catalogNotes,
  catalogSource,
  fsSource,
  GUIDE,
  openCatalog,
  parsePartition,
  requireTable,
  resolveDataset,
  storageInfo,
  tableDir,
  TableMetaSchema,
  type Catalog,
  type TableMeta,
} from './catalog';
import { refName, SqlInferenceCache, type Evidence, type LineageEdge, type LineageNode, type NodeType } from './lineage';
import { checkReadability, listPartitionDirs, physicalState, scanPartitionDir, totalBytes, updatedAtMs, type PartitionState } from './partitions';
import { evaluateRuleset, loadRuleset, qualityResultPath, QualityResultSchema, writeQualityResult, type QualityResult, type StoredQualityResult } from './quality';
import { formatInZone } from './time';

export { TableMetaSchema, PartitionKeySchema, ColumnSchema, openCatalog, requireTable, parsePartition, resolveDataset } from './catalog';
export { readLatestQualityResult, qualityResultPath, RulesetSchema, RuleSchema, type StoredQualityResult } from './quality';
export { inferSql } from './lineage';
export { scanPartitionDir, physicalState, readRecords } from './partitions';

const AUTH = 'filesystem';
const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

const catalogInput = { type: 'string' as const, description: '目录端点名（profile endpoints.catalog），默认取 profile defaults.catalog' };
const tableInput = { type: 'string' as const, required: true, description: '表名 <database>.<table>，如 analytics.daily_orders' };

const StorageOut = z.object({ type: z.string(), warehouse_root: z.string(), note: z.string() });
const PartitionStateEnum = z.enum(['missing', 'empty', 'incomplete', 'unreadable', 'present']);

function rel(cat: Catalog, p: string): string {
  return relative(cat.warehouseRoot, p) || '.';
}

// ---------------------------------------------------------------------------
// data table get
// ---------------------------------------------------------------------------

const tableGet = defineCapability({
  name: 'data.table.get',
  command: 'data table get',
  summary: '查看表的目录元数据（分区语义、列、产出任务、上下游声明）与物理位置检查',
  description: '元数据来自目录（explicit）；物理位置、分区数来自本地文件系统列目录（derived）。表存在不代表某个分区存在或可读。',
  domain: 'data',
  inputs: { catalog: catalogInput, table: tableInput },
  output: z.object({
    catalog: z.string(),
    provider: z.string(),
    metadata_file: z.string(),
    table: TableMetaSchema,
    physical: z.object({
      path: z.string(),
      exists: z.boolean(),
      storage: StorageOut,
      partition_count: z.number().nullable(),
      earliest_partition: z.string().nullable(),
      latest_partition: z.string().nullable(),
      nonconforming_entries: z.array(z.string()),
    }),
    bindings: z.array(z.object({ from: z.string(), to: z.string(), type: z.string(), source: z.string() })).describe('资源绑定文件中涉及该表的关系'),
  }),
  adapter: ADAPTER,
  operation: 'read',
  auth_provider: AUTH,
  guide: GUIDE,
  prerequisites: ['profile 配置 catalog 端点（provider/metadata_dir/warehouse_root/storage）'],
  notes: ['storage 当前只支持 local-filesystem；不代表对象存储或 HDFS 已验证', 'Hive Metastore 等 provider 尚未接入，见指南'],
  examples: ['workctl data table get --catalog demo --table analytics.daily_orders'],
  backend_modes: ['live'],
  handler: async (ctx, i) => {
    const cat = openCatalog(ctx, i.catalog);
    const t = requireTable(cat, i.table);
    const dir = tableDir(cat, t.meta);
    const exists = existsSync(dir) && statSync(dir).isDirectory();
    const { partitions, nonconforming } = exists ? listPartitionDirs(dir, t.meta) : { partitions: [], nonconforming: [] };
    const specs = partitions.map((p) => p.spec).sort();
    const warnings: string[] = [];
    if (!exists) warnings.push(`表目录不存在: ${dir}（尚无产出，或 location / warehouse_root 配置有误）`);
    let bindings: { from: string; to: string; type: string; source: string }[] = [];
    try {
      bindings = ctx.resources().relationsOf(t.meta.name, 'both').map((r) => ({ from: r.from, to: r.to, type: r.type, source: r.source }));
    } catch (e) {
      warnings.push(`资源绑定读取失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    return {
      data: {
        catalog: cat.name,
        provider: cat.provider,
        metadata_file: t.file,
        table: t.meta,
        physical: {
          path: dir,
          exists,
          storage: storageInfo(cat),
          partition_count: exists ? specs.length : null,
          earliest_partition: specs[0] ?? null,
          latest_partition: specs[specs.length - 1] ?? null,
          nonconforming_entries: nonconforming.slice(0, 20),
        },
        bindings,
      },
      sources: [
        catalogSource(cat, `read ${relative(cat.metadataDir, t.file)}`),
        fsSource(cat, `readdir ${rel(cat, dir)}`),
        ...(bindings.length ? [source('binding-file', 'resources', { method: 'relations', relation: 'explicit' as const })] : []),
      ],
      coverage: { complete: true, scope: `表 ${t.meta.name}（目录 ${cat.name}）`, notes: ['分区数为目录列举结果，未读取文件内容', ...catalogNotes(cat)] },
      warnings,
    };
  },
});

// ---------------------------------------------------------------------------
// data partition list
// ---------------------------------------------------------------------------

const partitionList = defineCapability({
  name: 'data.partition.list',
  command: 'data partition list',
  summary: '列出表的分区目录：文件数、字节数、最后修改时间、是否有完成标记',
  description: '只列目录与文件属性，不读取文件内容；可读性用 data partition get 检查。按分区值倒序，--limit 截断时标注 truncated。',
  domain: 'data',
  inputs: {
    catalog: catalogInput,
    table: tableInput,
    from: { type: 'string', description: '起始分区值（含），针对第一个分区键，如 2026-10-01' },
    to: { type: 'string', description: '结束分区值（含）' },
    limit: { type: 'int', default: 100, description: '最多返回的分区数（最新的优先）' },
  },
  output: z.object({
    table: z.string(),
    location: z.string(),
    location_exists: z.boolean(),
    storage: StorageOut,
    partition_keys: z.array(z.string()),
    partitions: z.array(
      z.object({
        partition: z.string(),
        values: z.record(z.string(), z.string()),
        path: z.string(),
        file_count: z.number(),
        total_bytes: z.number(),
        last_modified: z.string().nullable(),
        success_marker: z.boolean().nullable().describe('null 表示该表不使用完成标记'),
      }),
    ),
    matched: z.number(),
    returned: z.number(),
    nonconforming_entries: z.array(z.string()),
  }),
  adapter: ADAPTER,
  operation: 'read',
  auth_provider: AUTH,
  guide: GUIDE,
  examples: ['workctl data partition list --catalog demo --table ods.orders --from 2026-10-10 --to 2026-10-16'],
  backend_modes: ['live'],
  handler: async (ctx, i) => {
    const cat = openCatalog(ctx, i.catalog);
    const t = requireTable(cat, i.table);
    if (!t.meta.partition_keys.length) throw new WorkError('INVALID_ARGUMENT', `表 ${t.meta.name} 不是分区表`);
    const limit = i.limit as number;
    if (limit < 1 || limit > 10000) throw new WorkError('INVALID_ARGUMENT', '--limit 取值 1..10000');
    const key = t.meta.partition_keys[0];
    for (const b of [i.from, i.to]) {
      if (b && key.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(b)) throw new WorkError('INVALID_ARGUMENT', `分区键 ${key.name} 是 date 类型，--from/--to 须为 YYYY-MM-DD: ${b}`);
    }
    const dir = tableDir(cat, t.meta);
    const exists = existsSync(dir);
    const { partitions, nonconforming } = listPartitionDirs(dir, t.meta);
    const matched = partitions
      .filter((p) => (!i.from || p.values[key.name] >= i.from) && (!i.to || p.values[key.name] <= i.to))
      .sort((a, b) => (a.spec < b.spec ? 1 : a.spec > b.spec ? -1 : 0));
    const page = matched.slice(0, limit);
    const rows = page.map((p) => {
      const scan = scanPartitionDir(p.dir, t.meta);
      const last = scan.files.length || scan.marker?.present ? Math.max(...scan.files.map((f) => f.modified_ms), scan.marker?.modified_ms ?? 0) : null;
      return {
        partition: p.spec,
        values: p.values,
        path: p.dir,
        file_count: scan.files.length,
        total_bytes: totalBytes(scan),
        last_modified: iso(last),
        success_marker: scan.marker ? scan.marker.present : null,
      };
    });
    const truncated = matched.length > page.length;
    const warnings: string[] = [];
    if (!exists) warnings.push(`表目录不存在: ${dir}；返回空列表不代表分区为空，而是尚无任何产出目录`);
    if (nonconforming.length) warnings.push(`有 ${nonconforming.length} 个目录项不符合分区规范，已忽略`);
    return {
      data: {
        table: t.meta.name,
        location: dir,
        location_exists: exists,
        storage: storageInfo(cat),
        partition_keys: t.meta.partition_keys.map((k) => k.name),
        partitions: rows,
        matched: matched.length,
        returned: rows.length,
        nonconforming_entries: nonconforming.slice(0, 20),
      },
      sources: [catalogSource(cat, `read tables/${t.meta.name}.yaml`), fsSource(cat, `readdir+stat ${rel(cat, dir)}`)],
      coverage: {
        complete: !truncated,
        truncated,
        limit,
        scope: `${t.meta.name}${i.from || i.to ? ` ${key.name} ∈ [${i.from ?? '-∞'}, ${i.to ?? '+∞'}]` : ''}`,
        notes: ['只列目录和文件属性，未读取内容；可读性与完成状态请用 data partition get'],
      },
      warnings,
    };
  },
});

// ---------------------------------------------------------------------------
// data partition get
// ---------------------------------------------------------------------------

const ReadableFile = z.object({
  file: z.string(),
  ok: z.boolean(),
  records_parsed: z.number(),
  parse_error_count: z.number(),
  parse_errors: z.array(z.object({ line: z.number(), error: z.string() })),
  open_error: z.string().optional(),
});

const partitionGet = defineCapability({
  name: 'data.partition.get',
  command: 'data partition get',
  summary: '检查单个分区：是否符合分区定义、目录是否存在、数据文件、完成标记、更新时间、文件是否可读',
  description:
    '分区不存在不是错误：返回 success 且 state=missing，便于链路检查推理；表不存在返回 NOT_FOUND。state 汇总: missing|empty|incomplete(无完成标记)|unreadable|present。',
  domain: 'data',
  inputs: {
    catalog: catalogInput,
    table: tableInput,
    partition: { type: 'string', required: true, description: "分区，如 'dt=2026-10-16'（dt 为业务日期）" },
    sample_records: { type: 'int', default: 20, description: '每个文件实际解析的前 N 条记录（可读性抽查）' },
  },
  output: z.object({
    table: z.string(),
    partition: z.string(),
    path: z.string(),
    storage: StorageOut,
    state: PartitionStateEnum,
    explanation: z.string(),
    checks: z.object({
      defined: z.object({
        ok: z.boolean(),
        keys: z.array(z.object({ name: z.string(), value: z.string(), type: z.string(), timezone: z.string().optional(), semantics: z.string() })),
      }),
      exists: z.object({ ok: z.boolean(), path: z.string() }),
      files: z.object({
        ok: z.boolean().nullable(),
        count: z.number(),
        total_bytes: z.number(),
        files: z.array(z.object({ name: z.string(), bytes: z.number(), modified_at: z.string() })),
        ignored: z.array(z.string()),
        in_progress_markers: z.array(z.string()),
      }),
      success_marker: z.object({ ok: z.boolean().nullable(), name: z.string().nullable(), present: z.boolean().nullable(), modified_at: z.string().nullable() }),
      updated_at: z.object({ value: z.string().nullable(), local: z.string().nullable(), basis: z.string() }),
      readable: z.object({
        ok: z.boolean().nullable(),
        sample_records_per_file: z.number(),
        files: z.array(ReadableFile),
        observed_columns: z.array(z.string()),
        undeclared_columns: z.array(z.string()),
      }),
    }),
  }),
  adapter: ADAPTER,
  operation: 'read',
  auth_provider: AUTH,
  guide: GUIDE,
  notes: ['表存在 ≠ 分区存在 ≠ 文件可读 ≠ 质量规则通过；质量规则用 data quality check', '更新时间取完成标记或最新数据文件的 mtime（本地文件系统）'],
  examples: ["workctl data partition get --catalog demo --table analytics.daily_orders --partition 'dt=2026-10-16'"],
  backend_modes: ['live'],
  handler: async (ctx, i) => {
    const cat = openCatalog(ctx, i.catalog);
    const t = requireTable(cat, i.table);
    const meta = t.meta;
    const part = parsePartition(meta, i.partition);
    const n = i.sample_records as number;
    if (n < 1 || n > 10000) throw new WorkError('INVALID_ARGUMENT', '--sample-records 取值 1..10000');
    const dir = join(tableDir(cat, meta), part.relPath);
    const scan = scanPartitionDir(dir, meta);
    const tz = businessTimezone(meta);
    const updated = updatedAtMs(scan);
    let state: PartitionState = physicalState(scan);
    let readable: { ok: boolean | null; files: z.infer<typeof ReadableFile>[]; observed: string[] } = { ok: null, files: [], observed: [] };
    if (scan.files.length) {
      const r = await checkReadability(scan.files, meta.format, n);
      readable = { ok: r.results.every((x) => x.ok), files: r.results, observed: r.observed_columns };
      if (state === 'present' && !readable.ok) state = 'unreadable';
      const fullyRead = r.results.every((x) => x.records_parsed + x.parse_error_count < n);
      if (state === 'present' && readable.ok && fullyRead && r.results.every((x) => x.records_parsed === 0)) state = 'empty';
    }
    const declared = new Set([...meta.columns.map((c) => c.name), ...meta.partition_keys.map((k) => k.name)]);
    const explanation: Record<PartitionState, string> = {
      missing: '分区目录不存在（未产出、产出到其他位置，或分区值/业务日期不对）',
      empty: '分区目录存在但没有数据记录',
      incomplete: `有数据文件但缺少完成标记 ${meta.success_marker}，可能仍在写入或写入中断`,
      unreadable: '数据文件存在但部分记录无法解析或文件无法打开',
      present: `分区存在、${scan.files.length} 个数据文件${scan.marker ? `、含 ${scan.marker.name}` : ''}，抽查记录可解析（质量规则未检查）`,
    };
    const warnings: string[] = [];
    if (scan.in_progress_markers.length) warnings.push(`分区目录中有写入中间目录 ${scan.in_progress_markers.join(', ')}，可能有写入正在进行或残留`);
    const sources: Source[] = [catalogSource(cat, `read tables/${meta.name}.yaml (partition_keys)`), fsSource(cat, `stat+readdir ${rel(cat, dir)}`)];
    if (scan.files.length) sources.push(fsSource(cat, `open+parse first ${n} records per file`, 'sampled'));
    return {
      data: {
        table: meta.name,
        partition: part.spec,
        path: dir,
        storage: storageInfo(cat),
        state,
        explanation: explanation[state],
        checks: {
          defined: { ok: true, keys: part.values },
          exists: { ok: scan.exists && scan.is_dir, path: dir },
          files: {
            ok: scan.exists ? scan.files.length > 0 && totalBytes(scan) > 0 : null,
            count: scan.files.length,
            total_bytes: totalBytes(scan),
            files: scan.files.slice(0, 50).map((f) => ({ name: f.name, bytes: f.bytes, modified_at: new Date(f.modified_ms).toISOString() })),
            ignored: scan.ignored.slice(0, 20),
            in_progress_markers: scan.in_progress_markers,
          },
          success_marker: scan.marker
            ? { ok: scan.exists ? scan.marker.present : null, name: scan.marker.name, present: scan.exists ? scan.marker.present : null, modified_at: iso(scan.marker.modified_ms) }
            : { ok: null, name: null, present: null, modified_at: null },
          updated_at: {
            value: iso(updated),
            local: updated !== null && tz ? formatInZone(updated, tz) : null,
            basis: scan.marker?.present ? `${scan.marker.name} 的 mtime` : scan.files.length ? '最新数据文件的 mtime' : '无文件',
          },
          readable: {
            ok: readable.ok,
            sample_records_per_file: n,
            files: readable.files,
            observed_columns: readable.observed,
            undeclared_columns: readable.observed.filter((c) => !declared.has(c)),
          },
        },
      },
      sources,
      coverage: {
        complete: true,
        sampled: scan.files.length > 0,
        scope: `${meta.name} ${part.spec}`,
        notes: scan.files.length ? [`可读性只解析每个文件前 ${n} 条记录；全量规则检查用 data quality check`] : [],
      },
      warnings,
    };
  },
});

// ---------------------------------------------------------------------------
// data lineage get
// ---------------------------------------------------------------------------

const lineageGet = defineCapability({
  name: 'data.lineage.get',
  command: 'data lineage get',
  summary: '查询表的上游或下游血缘：区分目录声明（explicit）与 SQL 推断（inferred），并标出两者一致的边',
  description: 'explicit 来自目录元数据的 upstream/consumers；inferred 来自产出 SQL 文件的正则解析（INSERT 目标、FROM/JOIN 来源）。未限定库名的表名不按相似名称匹配目录表。',
  domain: 'data',
  inputs: {
    catalog: catalogInput,
    table: tableInput,
    direction: { type: 'enum', enum: ['upstream', 'downstream'], default: 'upstream', description: '方向' },
    depth: { type: 'int', default: 2, description: '遍历深度 1..5' },
  },
  output: z.object({
    table: z.string(),
    direction: z.enum(['upstream', 'downstream']),
    depth: z.number(),
    nodes: z.array(z.object({ id: z.string(), type: z.enum(['table', 'external', 'workflow', 'report', 'service', 'unresolved']), in_catalog: z.boolean(), depth: z.number(), note: z.string().optional() })),
    edges: z.array(
      z.object({
        from: z.string(),
        to: z.string(),
        relations: z.array(z.enum(['explicit', 'inferred'])),
        confirmed_by_both: z.boolean(),
        via: z.object({ workflow: z.string(), task: z.string().optional(), status: z.string().optional() }).optional(),
        columns: z.array(z.string()).optional(),
        evidence: z.array(z.object({ relation: z.enum(['explicit', 'inferred']), source: z.string(), detail: z.string().optional() })),
      }),
    ),
    sql_scans: z.array(
      z.object({
        table: z.string(),
        sql_file: z.string(),
        resolved_path: z.string().nullable(),
        status: z.enum(['parsed', 'missing', 'error']),
        targets: z.array(z.string()),
        sources: z.array(z.string()),
        path_sources: z.array(z.string()),
        note: z.string().optional(),
      }),
    ),
    scanned: z.object({ metadata_files: z.number(), metadata_invalid: z.number(), sql_files_parsed: z.number(), sql_files_missing: z.number() }),
  }),
  adapter: ADAPTER,
  operation: 'read',
  auth_provider: AUTH,
  guide: GUIDE,
  notes: ['SQL 推断基于正则，可能遗漏动态 SQL、程序中注册的临时视图和 DataFrame 读写', '没有足够依据时不根据相似名称认定依赖关系'],
  examples: [
    'workctl data lineage get --catalog demo --table analytics.daily_orders --direction upstream',
    'workctl data lineage get --catalog demo --table ods.orders --direction downstream --depth 3',
  ],
  backend_modes: ['live'],
  handler: async (ctx, i) => lineage(ctx, i),
});

async function lineage(ctx: Ctx, i: Record<string, any>) {
  const cat = openCatalog(ctx, i.catalog);
  const root = requireTable(cat, i.table).meta;
  const depth = i.depth as number;
  if (depth < 1 || depth > 5) throw new WorkError('INVALID_ARGUMENT', '--depth 取值 1..5');
  const direction = i.direction as 'upstream' | 'downstream';
  const cache = new SqlInferenceCache(cat);
  const nodes = new Map<string, LineageNode>();
  const edges = new Map<string, LineageEdge>();
  const warnings: string[] = [];
  const lowerIndex = new Map([...cat.tables.keys()].map((k) => [k.toLowerCase(), k]));

  const classify = (id: string): { id: string; type: NodeType; in_catalog: boolean; note?: string } => {
    const hit = lowerIndex.get(id.toLowerCase());
    if (hit) return { id: hit, type: 'table', in_catalog: true };
    if (id.includes('://')) return { id, type: 'external', in_catalog: false };
    if (!id.includes('.')) return { id, type: 'unresolved', in_catalog: false, note: '未限定库名，未与目录表匹配（不按相似名称推断）' };
    return { id, type: 'unresolved', in_catalog: false, note: '目录中没有该表' };
  };
  const addNode = (n: { id: string; type: NodeType; in_catalog: boolean; note?: string }, d: number) => {
    const cur = nodes.get(n.id);
    if (!cur) nodes.set(n.id, { ...n, depth: d });
    else if (d < cur.depth) cur.depth = d;
  };
  const addEdge = (from: string, to: string, ev: Evidence, extra: Partial<LineageEdge> = {}) => {
    const key = `${from}\u0000${to}`;
    let e = edges.get(key);
    if (!e) {
      e = { from, to, relations: [], confirmed_by_both: false, evidence: [] };
      edges.set(key, e);
    }
    if (!e.relations.includes(ev.relation)) e.relations.push(ev.relation);
    e.relations.sort();
    e.confirmed_by_both = e.relations.length === 2;
    e.evidence.push(ev);
    if (extra.via && !e.via) e.via = extra.via;
    if (extra.columns && !e.columns) e.columns = extra.columns;
  };
  const metaFile = (m: TableMeta) => `catalog:tables/${m.name}.yaml`;
  const via = (m: TableMeta) => (m.produced_by ? { workflow: m.produced_by.workflow, ...(m.produced_by.task ? { task: m.produced_by.task } : {}), status: m.produced_by.status } : undefined);

  /** Inferred sources of `m` from its SQL file (resolved to node ids). */
  const inferredSources = (m: TableMeta): { id: string; detail: string; sqlFile: string }[] => {
    const scan = cache.forTable(m);
    if (!scan || scan.status !== 'parsed') return [];
    if (scan.targets.length && !scan.targets.some((x) => x.toLowerCase() === m.name.toLowerCase())) {
      warnings.push(`${scan.sql_file} 推断的写入目标 ${scan.targets.join(', ')} 与元数据中的表 ${m.name} 不一致`);
    }
    const out: { id: string; detail: string; sqlFile: string }[] = [];
    const views = new Map(Object.entries(m.produced_by?.input_views ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    for (const s of scan.sources) {
      const r = refName(s);
      const mapped = views.get(r.name.toLowerCase());
      const where = `FROM/JOIN ${r.name}${r.line ? ` @L${r.line}` : ''}`;
      out.push(mapped
        ? { id: classify(mapped).id, detail: `${where}；视图 ${r.name} → ${mapped}（produced_by.input_views 声明）`, sqlFile: scan.sql_file }
        : { id: classify(r.name).id, detail: where, sqlFile: scan.sql_file });
    }
    for (const s of scan.path_sources) {
      const r = refName(s);
      const path = r.name.replace(/^\w+:/, '');
      const byLoc = [...cat.tables.values()].find((t) => path.includes(`/${t.meta.location.replace(/^\.?\/*|\/+$/g, '')}/`) || path.endsWith(`/${t.meta.location.replace(/^\.?\/*|\/+$/g, '')}`));
      out.push({ id: byLoc ? byLoc.meta.name : r.name, detail: `文件源 ${r.name}${r.line ? ` @L${r.line}` : ''}${byLoc ? '（路径与表 location 匹配）' : ''}`, sqlFile: scan.sql_file });
    }
    return out;
  };

  addNode(classify(root.name), 0);
  let frontier = [root.name];
  let truncated = false;
  for (let d = 1; d <= depth + 1 && frontier.length; d++) {
    const next: string[] = [];
    for (const cur of frontier) {
      const t = cat.tables.get(cur);
      if (!t) continue;
      const found: string[] = [];
      if (direction === 'upstream') {
        for (const u of t.meta.upstream) {
          const n = classify(u.table);
          found.push(n.id);
          if (d <= depth) {
            addNode(n, d);
            addEdge(n.id, t.meta.name, { relation: 'explicit', source: metaFile(t.meta), detail: `upstream${u.note ? `: ${u.note}` : ''}` }, { via: via(t.meta), ...(u.columns ? { columns: u.columns } : {}) });
          }
        }
        for (const s of inferredSources(t.meta)) {
          const n = classify(s.id);
          found.push(n.id);
          if (d <= depth) {
            addNode(n, d);
            addEdge(n.id, t.meta.name, { relation: 'inferred', source: `sql:${s.sqlFile}`, detail: s.detail }, { via: via(t.meta) });
          }
        }
      } else {
        for (const other of cat.tables.values()) {
          if (other.meta.upstream.some((u) => u.table.toLowerCase() === cur.toLowerCase())) {
            found.push(other.meta.name);
            if (d <= depth) {
              addNode(classify(other.meta.name), d);
              const u = other.meta.upstream.find((x) => x.table.toLowerCase() === cur.toLowerCase())!;
              addEdge(cur, other.meta.name, { relation: 'explicit', source: metaFile(other.meta), detail: 'upstream' }, { via: via(other.meta), ...(u.columns ? { columns: u.columns } : {}) });
            }
          }
          for (const s of inferredSources(other.meta)) {
            if (s.id.toLowerCase() !== cur.toLowerCase()) continue;
            found.push(other.meta.name);
            if (d <= depth) {
              addNode(classify(other.meta.name), d);
              addEdge(cur, other.meta.name, { relation: 'inferred', source: `sql:${s.sqlFile}`, detail: s.detail }, { via: via(other.meta) });
            }
          }
        }
        for (const c of t.meta.consumers) {
          found.push(c.id);
          if (d <= depth) {
            addNode({ id: c.id, type: c.type, in_catalog: false, ...(c.note ? { note: c.note } : {}) }, d);
            addEdge(cur, c.id, { relation: 'explicit', source: metaFile(t.meta), detail: `consumers (${c.type})` });
          }
        }
      }
      if (d > depth) {
        if (found.length) truncated = true;
        continue;
      }
      for (const f of found) if (cat.tables.has(f) && !next.includes(f) && nodes.get(f)?.depth === d) next.push(f);
    }
    frontier = next;
  }

  const scans = [...cache.scans.values()];
  const missing = scans.filter((s) => s.status !== 'parsed');
  const notes = [
    `扫描了 ${cat.metadataFiles} 个元数据文件、${scans.filter((s) => s.status === 'parsed').length} 个 SQL 文件`,
    'inferred 边来自正则解析 SQL（INSERT/CREATE TABLE AS 目标，FROM/JOIN 来源），可能遗漏动态 SQL、程序内注册的临时视图和 DataFrame 读写',
    ...missing.map((s) => `${s.table} 的 SQL 文件 ${s.sql_file} ${s.status === 'missing' ? '不存在' : '解析失败'}，该表只有 explicit 关系`),
    ...scans.filter((s) => s.note && s.status === 'parsed').map((s) => `${s.sql_file}: ${s.note}`),
    ...catalogNotes(cat),
  ];
  const sources: Source[] = [catalogSource(cat, `read ${cat.metadataFiles} metadata files`, 'explicit')];
  for (const s of scans.filter((x) => x.status === 'parsed')) sources.push(source('sql-file', ADAPTER, { method: `regex-parse ${s.sql_file}`, relation: 'inferred' }));
  return {
    data: {
      table: root.name,
      direction,
      depth,
      nodes: [...nodes.values()].sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id)),
      edges: [...edges.values()],
      sql_scans: scans,
      scanned: {
        metadata_files: cat.metadataFiles,
        metadata_invalid: cat.invalid.length,
        sql_files_parsed: scans.filter((s) => s.status === 'parsed').length,
        sql_files_missing: missing.length,
      },
    },
    sources,
    coverage: {
      complete: !truncated && missing.length === 0 && cat.invalid.length === 0,
      truncated,
      scope: `${root.name} ${direction} depth ${depth}`,
      notes: [...(truncated ? [`深度 ${depth} 之外还有关系，增大 --depth 查看`] : []), ...notes],
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// data quality check
// ---------------------------------------------------------------------------

const qualityCheck = defineCapability({
  name: 'data.quality.check',
  command: 'data quality check',
  summary: '对单个分区执行质量规则集（行数、非空、唯一、取值、范围、结构、时效、分区存在），返回逐条结果与违规样本',
  description:
    '--dataset 接受 <catalog>.<db>.<table>；或 <catalog>.<table>（目录中表名唯一时解析，如 demo.daily_orders → demo / analytics.daily_orders）；带 --catalog 时按 <db>.<table> 解析。分区不存在时除 partition_exists 外的规则均 skipped，总体 fail。最新结果写入状态目录供其他能力读取。',
  domain: 'data',
  inputs: {
    dataset: { type: 'string', required: true, description: '数据集: <catalog>.<db>.<table> 或 <catalog>.<table>，如 demo.daily_orders' },
    partition: { type: 'string', required: true, description: "分区，如 'dt=2026-10-16'" },
    ruleset: { type: 'string', description: '规则集名（<rules_dir>/<name>.yaml）；默认取表元数据 quality_ruleset' },
    sample_rows: { type: 'int', description: '只读取前 N 行做内容规则（行数规则仍全量计数）；不填则全量扫描' },
    catalog: { type: 'string', description: '目录端点名；指定后 --dataset 按 <db>.<table> 解析' },
  },
  output: QualityResultSchema,
  adapter: ADAPTER,
  operation: 'diagnose',
  auth_provider: AUTH,
  guide: GUIDE,
  side_effects: '把最新结果写入 <state_dir>/quality/<table>/<partition>.json（本地状态，不修改数据）',
  idempotent: true,
  notes: ['抽样模式下 pass 不是结论性的（conclusive=false）；fail 总是结论性的', '违规样本最多 5 条，敏感列脱敏', 'freshness 以本地文件 mtime 为依据'],
  examples: ["workctl data quality check --dataset demo.daily_orders --partition 'dt=2026-10-16' --ruleset demo-daily-rules"],
  backend_modes: ['live'],
  handler: async (ctx, i) => {
    const res = resolveDataset(ctx, i.dataset, i.catalog);
    const cat = openCatalog(ctx, res.catalog);
    const t = requireTable(cat, res.table);
    const meta = t.meta;
    const part = parsePartition(meta, i.partition);
    const rulesetName = (i.ruleset as string | undefined) ?? meta.quality_ruleset;
    if (!rulesetName) throw new WorkError('INVALID_ARGUMENT', `表 ${meta.name} 没有配置 quality_ruleset，请用 --ruleset 指定`);
    const { ruleset, file } = loadRuleset(cat, rulesetName);
    if (ruleset.table && ruleset.table !== meta.name) {
      throw new WorkError('INVALID_ARGUMENT', `规则集 ${rulesetName} 适用于 ${ruleset.table}，与数据集 ${meta.name} 不一致`);
    }
    if (i.sample_rows !== undefined && (i.sample_rows < 1 || i.sample_rows > 1_000_000)) throw new WorkError('INVALID_ARGUMENT', '--sample-rows 取值 1..1000000');
    const dir = join(tableDir(cat, meta), part.relPath);
    const scan = scanPartitionDir(dir, meta);
    const ev = await evaluateRuleset({ meta, part, scan, ruleset, sampleRows: i.sample_rows });
    const checkedAt = new Date().toISOString();
    const sources: Source[] = [
      catalogSource(cat, `read tables/${meta.name}.yaml`),
      source('quality-ruleset', ADAPTER, { method: `read ${relative(cat.rulesDir, file)}`, relation: 'explicit' }),
      fsSource(cat, `stat+readdir ${rel(cat, dir)}`),
    ];
    if (ev.scan.mode !== 'none') {
      sources.push(fsSource(cat, `read ${ev.scan.files_read}/${ev.scan.files_total} files, ${ev.scan.rows_read} rows`, ev.scan.mode === 'sampled' ? 'sampled' : 'derived'));
    }
    const coverage = {
      complete: ev.scan.mode !== 'sampled',
      sampled: ev.scan.mode === 'sampled',
      scope: `${meta.name} ${part.spec}`,
      notes: [
        ev.scan.mode === 'full'
          ? `全量扫描 ${ev.scan.files_read} 个文件 ${ev.scan.rows_read} 行`
          : ev.scan.mode === 'sampled'
            ? `抽样读取 ${ev.scan.rows_read}/${ev.scan.rows_total} 行（${ev.scan.files_read}/${ev.scan.files_total} 个文件）；内容规则的 pass 不是结论性的，行数规则为全量计数`
            : `未读取数据内容（${ev.precondition.ok ? '规则无需读取记录' : '前置条件不满足'}）`,
      ],
    };
    const warnings: string[] = [];
    if (scan.in_progress_markers.length) warnings.push(`分区目录中有写入中间目录 ${scan.in_progress_markers.join(', ')}`);
    const data: QualityResult = {
      dataset: res,
      partition: part.spec,
      ruleset: { name: ruleset.name, file, rules: ruleset.rules.length },
      quality_state: ev.quality_state,
      conclusive: ev.conclusive,
      precondition: ev.precondition,
      summary: ev.summary,
      results: ev.results,
      scan: ev.scan,
      checked_at: checkedAt,
      persisted_to: null,
    };
    try {
      data.persisted_to = qualityResultPath(ctx.stateDir, meta.name, part.spec);
      writeQualityResult(ctx.stateDir, meta.name, part.spec, { ...data, stored_schema_version: '1', request_id: ctx.requestId, profile: ctx.profileName, sources, coverage });
    } catch (e) {
      data.persisted_to = null;
      warnings.push(`质量结果未能写入状态目录: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { data, sources, coverage, warnings };
  },
});

// ---------------------------------------------------------------------------
// planned
// ---------------------------------------------------------------------------

const transferGet = defineCapability({
  name: 'data.transfer.get',
  command: 'data transfer get',
  summary: '查看数据同步/传输任务（如 DataX、CDC、跨集群拷贝）的状态、进度与位点',
  domain: 'data',
  adapter: 'data-transfer (待接入)',
  operation: 'read',
  auth_provider: 'tbd',
  guide: GUIDE,
  status: 'planned',
  notes: ['尚未接入；同步任务的成功不等于目标分区可读或质量通过'],
});

const CAPABILITIES: CapabilityDef[] = [tableGet, partitionList, partitionGet, lineageGet, qualityCheck, transferGet];

export default defineDomain({
  name: 'data',
  title: '数据目录、分区、血缘与质量',
  summary: '表元数据与分区语义、分区产出检查、explicit/inferred 血缘、分区质量规则（file 目录 provider + 本地文件系统仓库）',
  pillar: 'offline',
  guide: GUIDE,
  skill: 'skills/data-validation/SKILL.md',
  capabilities: CAPABILITIES,
  probes: {
    catalog: async (ctx, name) => {
      const cat = openCatalog(ctx, name);
      const okWarehouse = existsSync(cat.warehouseRoot);
      const files = existsSync(cat.tablesDir) ? readdirSync(cat.tablesDir).filter((f) => /\.ya?ml$/.test(f)).length : 0;
      return {
        ok: okWarehouse && cat.invalid.length === 0,
        identity: `provider=${cat.provider} storage=${cat.storage}`,
        detail: `${files} 个元数据文件（${cat.tables.size} 个有效）；warehouse_root ${okWarehouse ? '存在' : '不存在'}: ${cat.warehouseRoot}`,
      };
    },
  },
});
