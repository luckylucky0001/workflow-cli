import { z } from 'zod';

/** zod schemas of each capability's `data`; build.mjs turns them into schemas/*.json via z.toJSONSchema. */

const Health = z.enum(['green', 'yellow', 'red']);

export const ClusterGetData = z.object({
  cluster: z.string().describe('endpoint 名（profile.endpoints.opensearch 下的键）'),
  cluster_name: z.string().nullable(),
  cluster_uuid: z.string().nullable(),
  distribution: z.string().nullable().describe('GET / 的 version.distribution（opensearch）'),
  version: z.string().nullable().describe('GET / 的 version.number（实际版本）'),
  lucene_version: z.string().nullable(),
  health: z.object({
    status: Health.describe('集群健康：green 全部分片已分配；yellow 有副本未分配；red 有主分片未分配'),
    timed_out: z.boolean(),
    number_of_nodes: z.number().int(),
    number_of_data_nodes: z.number().int(),
    active_primary_shards: z.number().int(),
    active_shards: z.number().int(),
    relocating_shards: z.number().int(),
    initializing_shards: z.number().int(),
    unassigned_shards: z.number().int(),
    delayed_unassigned_shards: z.number().int(),
    number_of_pending_tasks: z.number().int(),
    active_shards_percent: z.number().nullable(),
  }),
  indices: z.object({
    total: z.number().int().describe('_cat/indices?expand_wildcards=all 的行数（含隐藏/系统索引与关闭的索引）'),
    by_health: z.object({ green: z.number().int(), yellow: z.number().int(), red: z.number().int(), unknown: z.number().int() }),
    closed: z.number().int(),
    dot_prefixed: z.number().int().describe('以 . 开头的索引数（通常为系统/插件内部索引）'),
  }),
  observed_at: z.string(),
});
export type ClusterGetData = z.infer<typeof ClusterGetData>;

const ShardRow = z.object({
  shard: z.number().int(),
  prirep: z.enum(['p', 'r']),
  state: z.string().describe('STARTED / RELOCATING / INITIALIZING / UNASSIGNED'),
  node: z.string().nullable(),
  docs: z.number().int().nullable(),
  store_bytes: z.number().int().nullable(),
  unassigned_reason: z.string().nullable().optional(),
});

export const IndexGetData = z.object({
  cluster: z.string(),
  requested: z.string().describe('调用方传入的名称（索引或别名）'),
  index: z.string().describe('实际查询的具体索引名'),
  resolved_from_alias: z.string().nullable().describe('传入的是别名时为该别名，并已解析为唯一的具体索引'),
  uuid: z.string().nullable(),
  health: Health.nullable(),
  status: z.string().nullable().describe('open / close'),
  aliases: z.array(z.object({ name: z.string(), is_write_index: z.boolean().nullable() })),
  settings: z.object({
    number_of_shards: z.number().int().nullable(),
    number_of_replicas: z.number().int().nullable(),
    refresh_interval: z.string().nullable().describe('索引级设置；null 表示未显式设置，使用集群默认（OpenSearch 默认 1s）'),
    creation_date: z.string().nullable(),
    version_created: z.string().nullable(),
  }),
  mapping: z.object({
    dynamic: z.string().nullable(),
    field_count: z.number().int().describe('映射中的叶子字段数（含 multi-fields 子字段，不含 object 容器本身）'),
    top_level_fields: z.array(z.object({ name: z.string(), type: z.string().describe('object 字段没有 type 时为 object') })),
  }),
  docs: z.object({
    count: z.number().int().nullable().describe('_stats primaries.docs.count（Lucene 文档数，nested 子文档也计入）'),
    deleted: z.number().int().nullable().describe('已标记删除、尚未被段合并清理的文档数'),
  }),
  store: z.object({
    primaries_bytes: z.number().int().nullable(),
    total_bytes: z.number().int().nullable().describe('含副本'),
  }),
  cumulative_stats: z.object({
    basis: z.literal('cumulative_since_shard_start').describe('累计值：自分片在当前节点启动（或重新分配）以来，不是窗口值'),
    scope: z.literal('total').describe('所有已分配分片副本（主 + 副本）之和'),
    search_query_total: z.number().int().nullable(),
    search_query_time_ms: z.number().int().nullable(),
    search_fetch_total: z.number().int().nullable(),
    indexing_index_total: z.number().int().nullable(),
    indexing_index_time_ms: z.number().int().nullable(),
    indexing_index_failed: z.number().int().nullable(),
    refresh_total: z.number().int().nullable(),
  }),
  shards: z.object({
    primaries: z.number().int(),
    replicas_per_primary: z.number().int().nullable(),
    copies_total: z.number().int(),
    by_state: z.record(z.string(), z.number().int()),
    unassigned: z.array(ShardRow),
    nodes: z.array(z.string()),
    rows: z.array(ShardRow),
  }),
  observed_at: z.string(),
});
export type IndexGetData = z.infer<typeof IndexGetData>;

const Hit = z.object({
  index: z.string(),
  id: z.string(),
  score: z.number().nullable().describe('相关性分数；按字段排序时为 null'),
  sort: z.array(z.unknown()).optional(),
  source: z.unknown().describe('_source（长字符串、字段过多或文档过大时截断）'),
  source_truncated: z.boolean(),
});

export const QueryData = z.object({
  cluster: z.string(),
  index: z.string().describe('查询目标（索引 / 别名 / 前缀*，逗号分隔）'),
  query_source: z.enum(['query_string', 'dsl', 'match_all']),
  request: z.object({
    size: z.number().int().describe('实际发送的 size'),
    requested_size: z.number().int(),
    max_hits: z.number().int(),
    timeout: z.string().describe('发送给 OpenSearch 的搜索超时（来自时间预算）'),
    track_total_hits: z.number().int().describe('本次发送的精确计数上限（≤10000）'),
    sort: z.boolean(),
    aggs: z.boolean(),
  }),
  took_ms: z.number().int(),
  timed_out: z.boolean(),
  shards: z.object({ total: z.number().int(), successful: z.number().int(), skipped: z.number().int(), failed: z.number().int() }),
  shard_failures: z.array(z.object({ index: z.string().nullable(), shard: z.number().int().nullable(), type: z.string().nullable(), reason: z.string().nullable() })),
  total: z.object({
    value: z.number().int(),
    relation: z.enum(['eq', 'gte']).describe('eq：精确命中数；gte：至少这么多（超过 track_total_hits 上限后停止计数）'),
  }),
  returned: z.number().int(),
  hits: z.array(Hit),
  aggregations: z.record(z.string(), z.unknown()).nullable(),
  observed_at: z.string(),
});
export type QueryData = z.infer<typeof QueryData>;

export const OUTPUT_SCHEMAS: Record<string, z.ZodType> = {
  'search.cluster.get': ClusterGetData,
  'search.index.get': IndexGetData,
  'search.query': QueryData,
};

/** JSON Schema of every capability's `data` (used by build.mjs). */
export function outputJsonSchemas(): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(OUTPUT_SCHEMAS).map(([name, schema]) => [
      name,
      z.toJSONSchema(schema, { unrepresentable: 'any', io: 'output' }) as Record<string, unknown>,
    ]),
  );
}
