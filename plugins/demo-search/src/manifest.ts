/**
 * Source of truth for workctl-plugin.json (build.mjs serialises this object).
 * Capability names here must match HANDLERS (available) and OUTPUT_SCHEMAS.
 */

type InputType = 'string' | 'int' | 'number' | 'bool' | 'duration' | 'enum' | 'file' | 'list';

export interface ManifestInput {
  type: InputType;
  description: string;
  required?: boolean;
  default?: string | number | boolean | string[];
  enum?: string[];
}

export interface ManifestCapability {
  name: string;
  command: string;
  summary: string;
  description?: string;
  inputs: Record<string, ManifestInput>;
  output_schema?: string;
  adapter: string;
  operation: 'read' | 'diagnose' | 'plan' | 'execute';
  auth_provider: string;
  capability_version: string;
  guide: string;
  status: 'available' | 'planned';
  notes?: string[];
  examples?: string[];
  prerequisites?: string[];
}

export const PLUGIN_NAME = 'demo-search';
export const PLUGIN_VERSION = '0.1.0';
/** Engine versions this plugin was actually run against (GET / of demo-search: version.number). */
export const VERIFIED_OPENSEARCH_VERSIONS = ['2.19.3'];

const cluster: ManifestInput = { type: 'string', required: true, description: 'OpenSearch 集群（profile.endpoints.opensearch 下的 endpoint 名，如 demo-search）' };
const common = { adapter: 'opensearch-http', operation: 'read' as const, auth_provider: 'search-profile', capability_version: '1.0.0', guide: 'guides/search.md' };
const prereqs = ['端点 url 可达；启用安全插件时配置 username + password_ref（basic auth），账号只需 monitor 与 read 权限'];

export const CAPABILITIES: ManifestCapability[] = [
  {
    name: 'search.cluster.get',
    command: 'search cluster get',
    summary: '查看 OpenSearch 集群健康（状态、节点、分片分配）、实际版本与索引数量',
    description: '读取 GET /（版本）、GET /_cluster/health（状态、节点数、活跃/迁移/初始化/未分配分片）和 _cat/indices（索引总数、按健康状态计数）。集群 red/yellow 时仍返回 success，并在 warnings 中说明。',
    inputs: { cluster },
    output_schema: 'schemas/search.cluster.get.v1.json',
    ...common,
    status: 'available',
    notes: [
      'red = 至少一个主分片未分配；yellow = 主分片都可用但有副本未分配（单节点集群配置副本时必然 yellow）',
      'red/yellow 不视为调用失败：status 为 success，原因写在 warnings；要定位具体索引用 search index get',
      'indices.total 含隐藏/系统索引（expand_wildcards=all）与关闭的索引',
    ],
    prerequisites: prereqs,
    examples: ['workctl search cluster get --cluster demo-search'],
  },
  {
    name: 'search.index.get',
    command: 'search index get',
    summary: '查看 OpenSearch 索引的设置、映射摘要、文档数/容量、累计读写统计与分片分配',
    description:
      '读取 _cat/indices（健康/状态/uuid，并把别名解析为具体索引）、_settings、_mapping（字段数、顶层字段类型）、_alias、_stats（文档数、存储大小、累计 query/indexing 计数）和 _cat/shards（分片状态、节点、未分配原因）。别名指向多个索引时返回 INVALID_ARGUMENT 并列出这些索引。',
    inputs: {
      cluster,
      index: { type: 'string', required: true, description: '索引名或只指向一个索引的别名（不支持通配符与逗号列表）' },
    },
    output_schema: 'schemas/search.index.get.v1.json',
    ...common,
    status: 'available',
    notes: [
      'cumulative_stats 是自分片启动/重新分配以来的累计值（所有分片副本之和），不是窗口值；速率需两次采样差分',
      'docs.count 是 Lucene 文档数（nested 子文档也计入），只含已 refresh 的文档',
      '不存在的索引/别名返回 NOT_FOUND；别名解析结果写在 data.resolved_from_alias 与 warnings',
    ],
    prerequisites: prereqs,
    examples: ['workctl search index get --cluster demo-search --index demo-orders', 'workctl search index get --cluster demo-search --index demo-orders-current --json'],
  },
  {
    name: 'search.query',
    command: 'search query',
    summary: '对 OpenSearch 执行受限只读查询（query_string 或受限 DSL），返回命中数、命中与聚合',
    description:
      '只调用 POST /{index}/_search。--query 以 query_string 执行（禁止前导通配符）；--dsl-file 只允许 query / size / sort / _source / aggs，拒绝脚本（script、script_score、scripted_metric、_script 排序、runtime_mappings、terms_set 的 minimum_should_match_script、base64 的 wrapper 查询等）、聚合中的 top_hits 和跨索引读取（terms lookup、indexed_shape）。size ≤ 100（--max-hits，默认 20），timeout 由时间预算设置，track_total_hits ≤ 10000（--track-total-hits）。',
    inputs: {
      cluster,
      index: { type: 'string', required: true, description: '索引、别名或带尾部 * 的前缀，可逗号分隔（≤10 个）；禁止 _all 与 . 开头的系统索引' },
      query: { type: 'string', description: 'query_string 查询，如 "status:paid AND city:shanghai"；与 DSL 中的 query 二选一' },
      dsl_file: { type: 'file', description: '受限 DSL 的 JSON 文件（只允许 query、size、sort、_source、aggs）；相对路径按调用方目录解析' },
      max_hits: { type: 'int', default: 20, description: '最多返回的命中条数（1-100）' },
      track_total_hits: { type: 'int', default: 10000, description: '精确计数上限（1-10000）；命中数超过它时 total.relation=gte' },
    },
    output_schema: 'schemas/search.query.v1.json',
    ...common,
    status: 'available',
    notes: [
      'total.relation=eq 为精确命中数；gte 表示“至少”（超过 track_total_hits（默认且最大 10000）后停止计数）',
      '命中列表最多 100 条；匹配文档多于返回条数时 coverage.truncated=true',
      '部分分片失败或搜索超时（timed_out）时 status=partial，失败原因在 data.shard_failures',
      'skipped 分片是 can_match 预筛选判定不可能匹配而跳过的，不影响完整性',
      '近实时：refresh（默认 1s）之前写入的文档不可见',
      '_update_by_query / _delete_by_query 等写入端点永远不会被调用',
    ],
    prerequisites: [...prereqs, '读取目标索引需要 indices:data/read/search 权限'],
    examples: [
      'workctl search query --cluster demo-search --index demo-orders --query "status:paid AND city:shanghai"',
      'workctl search query --cluster demo-search --index demo-orders --dsl-file "$PWD/demo/scenarios/search/dsl/paid_by_city.json"',
    ],
  },
  {
    name: 'search.snapshot.list',
    command: 'search snapshot list',
    summary: '列出 OpenSearch 快照仓库中的快照及状态（待接入）',
    inputs: {
      cluster,
      repository: { type: 'string', required: true, description: '快照仓库名' },
    },
    adapter: 'opensearch-http',
    operation: 'read',
    auth_provider: 'search-profile',
    capability_version: '1.0.0',
    guide: 'guides/search.md',
    status: 'planned',
    notes: ['规划通过 GET /_snapshot/{repository}/_all 读取快照状态、开始/结束时间与包含的索引；演示环境未配置快照仓库'],
  },
];

export function buildManifest(): Record<string, unknown> {
  return {
    plugin_api: 'workctl-plugin/1',
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    description: '演示插件：通过插件机制接入 OpenSearch 搜索引擎（集群健康、索引详情、受限查询），实现内置目录中待接入的 search 能力；快照列表待接入',
    backend_mode: 'live',
    entry: 'dist/plugin.mjs',
    domain: {
      name: 'search',
      title: '搜索引擎',
      summary: 'OpenSearch 集群健康、索引分片/容量/映射、受限只读查询；以插件形式接入',
      pillar: 'middleware',
      guide: 'guides/search.md',
      skill: 'skills/search-operations',
    },
    endpoint_kinds: ['opensearch'],
    compatibility: {
      workctl: '>=0.1.0',
      engines: [{ engine: 'opensearch', versions: '2.x', verified: VERIFIED_OPENSEARCH_VERSIONS }],
      client: 'Node.js fetch（HTTP/JSON REST，无额外依赖）',
      unverified: ['OpenSearch 1.x / 3.x', 'Elasticsearch（7.x/8.x）', '启用安全插件（basic auth / TLS）的集群'],
    },
    capabilities: CAPABILITIES,
  };
}
