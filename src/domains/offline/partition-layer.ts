import type { Ctx } from '../../core/runtime';
import { isPartitionPrefix, type OfflineTableMeta } from './catalog';
import { partitionLayer, type LayerState } from './runs';

/** Sub-partitions checked one by one under a business-date prefix; more are reported as not checked. */
export const MAX_SUB_PARTITIONS = 20;

/**
 * Partition state of a table's business-date partition. Single-key tables go straight to
 * data.partition.get; for multi-key tables (dt + region) `spec` is the business-date prefix: the
 * sub-partitions under it are listed with data.partition.list and each is checked with
 * data.partition.get, then aggregated. Never throws.
 */
export async function tablePartitionLayer(ctx: Ctx, catalogName: string | undefined, t: OfflineTableMeta, spec: string): Promise<LayerState> {
  if (!isPartitionPrefix(t)) return partitionLayer(ctx, catalogName, t.name, spec);
  const keys = t.partition_keys!.map((k) => k.name).join('/');
  if (!ctx.registry.get('data.partition.list')) {
    return { state: 'unknown', detail: `表 ${t.name} 按 ${keys} 多级分区，当前构建未注册 data.partition.list，无法列出 ${spec} 下的子分区`, source: null, table: t.name, partition: spec };
  }
  const value = spec.slice(spec.indexOf('=') + 1);
  const env = await ctx.call('data.partition.list', { ...(catalogName ? { catalog: catalogName } : {}), table: t.name, from: value, to: value, limit: 1000 });
  if (env.status === 'error') {
    return { state: 'unknown', detail: `data.partition.list 失败: ${env.error?.code} ${env.error?.message}`, source: null, table: t.name, partition: spec, error_code: env.error?.code };
  }
  const listSource = env.meta.sources.find((s) => s.system === 'local-filesystem') ?? env.meta.sources[0] ?? null;
  const subs = (((env.data ?? {}) as any).partitions ?? []) as { partition: string }[];
  if (!subs.length) {
    return {
      state: 'missing',
      detail: `表 ${t.name} 按 ${keys} 多级分区，${spec} 下没有任何子分区目录`,
      source: listSource,
      table: t.name,
      partition: spec,
      sub_partitions: [],
      via: 'data.partition.list',
    };
  }
  const checked = subs.slice(0, MAX_SUB_PARTITIONS);
  const layers: LayerState[] = [];
  for (const sp of checked) layers.push(await partitionLayer(ctx, catalogName, t.name, sp.partition));
  const states = [...new Set(layers.map((l) => l.state))];
  const notChecked = subs.length - checked.length;
  // one state for all sub-partitions is that state; a mix is incomplete (unknown if any is unknown)
  const state = notChecked ? (states.includes('unknown') ? 'unknown' : 'incomplete') : states.length === 1 ? states[0] : states.includes('unknown') ? 'unknown' : 'incomplete';
  const updates = layers.map((l) => (typeof l.updated_at === 'string' ? Date.parse(l.updated_at) : NaN)).filter(Number.isFinite);
  const allUpdated = updates.length === layers.length && !notChecked;
  const summary = states.map((s) => `${s} ${layers.filter((l) => l.state === s).length}`).join('，');
  return {
    state,
    detail:
      `表 ${t.name} 按 ${keys} 多级分区：${spec} 下有 ${subs.length} 个子分区（${summary}${notChecked ? `；另有 ${notChecked} 个未逐个检查` : ''}）。` +
      '目录未声明子分区的期望取值，只能检查已存在的子分区，不能证明子分区齐全',
    source: layers.find((l) => l.source)?.source ?? listSource,
    table: t.name,
    partition: spec,
    // the last write over all sub-partitions; only when every sub-partition has write evidence
    ...(allUpdated ? { updated_at: new Date(Math.max(...updates)).toISOString() } : {}),
    sub_partitions: layers.map((l) => ({ partition: l.partition, state: l.state, ...(l.updated_at ? { updated_at: l.updated_at } : {}) })),
    via: 'data.partition.list+data.partition.get',
  };
}
