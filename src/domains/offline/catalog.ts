import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { source, type Source } from '../../core/output';
import type { Ctx, Endpoint } from '../../core/runtime';

/**
 * Lenient, read-only view of the file catalog (demo/catalog/tables/<db>.<table>.yaml)
 * for the offline domain: which table a workflow produces, its partition key, write mode,
 * upstream tables, consumers and freshness. Validation of the metadata itself belongs to
 * the data domain (`data table get`); invalid files are skipped here and reported.
 */

export interface OfflineTableMeta {
  name: string;
  file: string;
  partition_key?: { name: string; type?: string; timezone?: string };
  write_mode?: string;
  success_marker?: string | null;
  produced_by?: { scheduler?: string; workflow?: string; task?: string; sql_file?: string; status?: string };
  upstream: string[];
  consumers: { type: string; id: string; note?: string }[];
  freshness?: { expected_by: string; day_offset: number; timezone?: string };
  location?: string;
}

export interface OfflineCatalog {
  name: string;
  endpoint: Endpoint;
  tablesDir: string;
  tables: OfflineTableMeta[];
  skipped: string[];
}

/** Returns null (with a reason) instead of throwing: catalog metadata is an optional enrichment. */
export function loadOfflineCatalog(ctx: Ctx): { catalog: OfflineCatalog | null; reason?: string } {
  if (!ctx.hasEndpoint('catalog')) return { catalog: null, reason: '当前 profile 未配置 catalog 端点' };
  let ep: Endpoint;
  try {
    ep = ctx.endpoint('catalog');
  } catch (e) {
    return { catalog: null, reason: e instanceof Error ? e.message : String(e) };
  }
  const dir = ep.path('metadata_dir');
  if (!dir) return { catalog: null, reason: `catalog 端点 ${ep.id} 未配置 metadata_dir` };
  const tablesDir = join(dir, 'tables');
  if (!existsSync(tablesDir)) return { catalog: null, reason: `目录元数据目录不存在: ${tablesDir}` };
  const tables: OfflineTableMeta[] = [];
  const skipped: string[] = [];
  for (const f of readdirSync(tablesDir).filter((x) => /\.ya?ml$/.test(x)).sort()) {
    try {
      const raw = YAML.parse(readFileSync(join(tablesDir, f), 'utf8')) as Record<string, any>;
      if (!raw || typeof raw.name !== 'string') {
        skipped.push(`${f}: 缺少 name`);
        continue;
      }
      const pk = Array.isArray(raw.partition_keys) && raw.partition_keys[0] ? raw.partition_keys[0] : undefined;
      tables.push({
        name: raw.name,
        file: join(tablesDir, f),
        ...(pk?.name ? { partition_key: { name: String(pk.name), type: pk.type, timezone: pk.timezone } } : {}),
        ...(raw.write_mode ? { write_mode: String(raw.write_mode) } : {}),
        ...(raw.success_marker !== undefined ? { success_marker: raw.success_marker } : {}),
        ...(raw.produced_by && typeof raw.produced_by === 'object' ? { produced_by: raw.produced_by } : {}),
        upstream: (Array.isArray(raw.upstream) ? raw.upstream : [])
          .map((u: any) => (typeof u === 'string' ? u : u?.table))
          .filter((u: unknown): u is string => typeof u === 'string'),
        consumers: (Array.isArray(raw.consumers) ? raw.consumers : [])
          .map((c: any) => (typeof c === 'string' ? { type: 'unknown', id: c } : { type: String(c?.type ?? 'unknown'), id: String(c?.id ?? ''), ...(c?.note ? { note: String(c.note) } : {}) }))
          .filter((c: { id: string }) => c.id),
        ...(raw.freshness?.expected_by
          ? { freshness: { expected_by: String(raw.freshness.expected_by), day_offset: Number(raw.freshness.day_offset ?? 1), ...(raw.freshness.timezone ? { timezone: String(raw.freshness.timezone) } : {}) } }
          : {}),
        ...(raw.location ? { location: String(raw.location) } : {}),
      });
    } catch (e) {
      skipped.push(`${f}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { catalog: { name: ep.name, endpoint: ep, tablesDir, tables, skipped } };
}

export function tablesProducedBy(cat: OfflineCatalog, workflow: string): OfflineTableMeta[] {
  return cat.tables.filter((t) => t.produced_by?.workflow === workflow);
}

export function tableByName(cat: OfflineCatalog, name: string): OfflineTableMeta | undefined {
  return cat.tables.find((t) => t.name === name);
}

/** Tables that list `name` as upstream (reverse edge), in addition to declared consumers. */
export function downstreamTables(cat: OfflineCatalog, name: string): OfflineTableMeta[] {
  return cat.tables.filter((t) => t.upstream.includes(name));
}

export function partitionSpec(t: OfflineTableMeta, businessDate: string): string | null {
  return t.partition_key ? `${t.partition_key.name}=${businessDate}` : null;
}

export function catalogSource(cat: OfflineCatalog, method: string): Source {
  return source('catalog', 'file-catalog', { endpoint: cat.endpoint.id, method, relation: 'explicit' });
}
