import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { buildSearchBody, DEFAULT_MAX_HITS, MAX_AGG_OUTPUT_BYTES, MAX_HITS_CAP, parseDsl, TRACK_TOTAL_HITS_LIMIT, truncateSource, type DslInput } from './dsl';
import { encodeIndexList, makeSource, mapOsError, observeVersion, OsClient, requireIndexName, requireSearchTarget, resolveEndpoint, type ClusterVersion } from './opensearch';
import { PluginError, type HandlerResult, type PluginRequest, type Source } from './protocol';
import type { ClusterGetData, IndexGetData, QueryData } from './schemas';

export type Handler = (req: PluginRequest, inputs: Record<string, unknown>, timeoutMs: number) => Promise<HandlerResult>;

const int = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

// ---------------------------------------------------------------------------------------------
// search.cluster.get
// ---------------------------------------------------------------------------------------------
export function shapeClusterGet(cluster: string, version: ClusterVersion | null, health: any, catIndices: any[], observedAt: string): { data: ClusterGetData; warnings: string[] } {
  const warnings: string[] = [];
  const byHealth = { green: 0, yellow: 0, red: 0, unknown: 0 };
  let closed = 0;
  let dot = 0;
  for (const row of catIndices) {
    const h = row?.health;
    if (h === 'green' || h === 'yellow' || h === 'red') byHealth[h as 'green']++;
    else byHealth.unknown++;
    if (row?.status === 'close') closed++;
    if (String(row?.index ?? '').startsWith('.')) dot++;
  }
  const status = health.status as 'green' | 'yellow' | 'red';
  if (status === 'red') warnings.push(`集群状态 red：有 ${health.unassigned_shards} 个分片未分配，其中至少一个主分片不可用，涉及的索引读写可能失败或结果不完整`);
  if (status === 'yellow') warnings.push(`集群状态 yellow：所有主分片可用，但有 ${health.unassigned_shards} 个副本分片未分配（单节点集群上配置了副本时必然如此），数据冗余不足`);
  if (health.timed_out) warnings.push('_cluster/health 请求超时（timed_out=true），健康数据可能不是最新');
  if (health.relocating_shards > 0 || health.initializing_shards > 0) warnings.push(`有分片正在迁移（${health.relocating_shards}）或初始化（${health.initializing_shards}）`);
  return {
    data: {
      cluster,
      cluster_name: health.cluster_name ?? version?.cluster_name ?? null,
      cluster_uuid: version?.cluster_uuid ?? null,
      distribution: version?.distribution ?? null,
      version: version?.number ?? null,
      lucene_version: version?.lucene_version ?? null,
      health: {
        status,
        timed_out: !!health.timed_out,
        number_of_nodes: int(health.number_of_nodes) ?? 0,
        number_of_data_nodes: int(health.number_of_data_nodes) ?? 0,
        active_primary_shards: int(health.active_primary_shards) ?? 0,
        active_shards: int(health.active_shards) ?? 0,
        relocating_shards: int(health.relocating_shards) ?? 0,
        initializing_shards: int(health.initializing_shards) ?? 0,
        unassigned_shards: int(health.unassigned_shards) ?? 0,
        delayed_unassigned_shards: int(health.delayed_unassigned_shards) ?? 0,
        number_of_pending_tasks: int(health.number_of_pending_tasks) ?? 0,
        active_shards_percent: typeof health.active_shards_percent_as_number === 'number' ? health.active_shards_percent_as_number : null,
      },
      indices: { total: catIndices.length, by_health: byHealth, closed, dot_prefixed: dot },
      observed_at: observedAt,
    },
    warnings,
  };
}

export const clusterGet: Handler = async (req, inputs, timeoutMs) => {
  const ep = resolveEndpoint(req, inputs.cluster);
  const client = new OsClient(ep, timeoutMs);
  try {
    const warnings: string[] = [];
    const version = await observeVersion(client, warnings);
    const versionAt = new Date().toISOString();
    const health = await client.request<any>('GET', '/_cluster/health');
    const healthAt = new Date().toISOString();
    let cat: any[] = [];
    let catOk = true;
    try {
      cat = await client.request<any[]>('GET', '/_cat/indices?format=json&h=index,health,status&expand_wildcards=all');
    } catch (e) {
      const m = mapOsError(e, { cluster: ep.name });
      if (m.code !== 'PERMISSION_DENIED') throw m;
      catOk = false;
      warnings.push('无权读取 _cat/indices（indices:monitor/stats），indices 统计为空');
    }
    const observedAt = new Date().toISOString();
    const shaped = shapeClusterGet(ep.name, version, health, cat, observedAt);
    const sources: Source[] = [
      makeSource(ep, version, 'GET /', 'explicit', versionAt),
      makeSource(ep, version, 'GET /_cluster/health', 'explicit', healthAt),
      ...(catOk ? [makeSource(ep, version, 'GET /_cat/indices?expand_wildcards=all', 'explicit', observedAt)] : []),
    ];
    return {
      status: catOk ? 'success' : 'partial',
      data: shaped.data,
      sources,
      coverage: {
        complete: catOk,
        scope: `集群 ${ep.name} 的健康状态、版本与全部索引（含隐藏/系统索引）计数`,
        notes: ['health 是 observed_at 时刻的快照；yellow/red 的原因需要看具体索引的分片分配（search index get）'],
      },
      warnings: [...warnings, ...shaped.warnings],
    };
  } catch (e) {
    throw mapOsError(e, { cluster: ep.name });
  }
};

// ---------------------------------------------------------------------------------------------
// search.index.get
// ---------------------------------------------------------------------------------------------
/** Count leaf fields of a mapping (properties + multi-fields). */
export function countMappingFields(properties: Record<string, any> | undefined): number {
  let n = 0;
  for (const def of Object.values(properties ?? {})) {
    if (def?.properties) n += countMappingFields(def.properties);
    else n++;
    if (def?.fields) n += countMappingFields(def.fields);
  }
  return n;
}

export function shapeShards(rows: any[]): IndexGetData['shards'] {
  const shaped = rows
    .map((r) => ({
      shard: int(r.shard) ?? -1,
      prirep: (r.prirep === 'p' ? 'p' : 'r') as 'p' | 'r',
      state: String(r.state ?? 'UNKNOWN'),
      node: r.node ?? null,
      docs: int(r.docs),
      store_bytes: int(r.store),
      unassigned_reason: r['unassigned.reason'] ?? null,
    }))
    .sort((a, b) => a.shard - b.shard || a.prirep.localeCompare(b.prirep));
  const byState: Record<string, number> = {};
  for (const r of shaped) byState[r.state] = (byState[r.state] ?? 0) + 1;
  const primaries = new Set(shaped.filter((r) => r.prirep === 'p').map((r) => r.shard)).size;
  return {
    primaries,
    replicas_per_primary: primaries ? Math.round(shaped.filter((r) => r.prirep === 'r').length / primaries) : null,
    copies_total: shaped.length,
    by_state: byState,
    unassigned: shaped.filter((r) => r.state === 'UNASSIGNED'),
    nodes: [...new Set(shaped.map((r) => r.node).filter((x): x is string => !!x))].sort(),
    rows: shaped,
  };
}

export function shapeIndexGet(input: {
  cluster: string;
  requested: string;
  index: string;
  resolvedFromAlias: string | null;
  cat: any;
  settings: any;
  mapping: any;
  stats: any;
  shards: any[];
  aliases: any;
  observedAt: string;
}): IndexGetData {
  const s = input.settings?.[input.index]?.settings ?? {};
  const flat = (k: string): any => s[`index.${k}`] ?? k.split('.').reduce((o: any, p) => o?.[p], s.index);
  const mappings = input.mapping?.[input.index]?.mappings ?? {};
  const props: Record<string, any> = mappings.properties ?? {};
  const st = input.stats?.indices?.[input.index] ?? {};
  const pri = st.primaries ?? {};
  const tot = st.total ?? {};
  const creation = int(flat('creation_date'));
  const aliasMap: Record<string, any> = input.aliases?.[input.index]?.aliases ?? {};
  return {
    cluster: input.cluster,
    requested: input.requested,
    index: input.index,
    resolved_from_alias: input.resolvedFromAlias,
    uuid: input.cat?.uuid ?? flat('uuid') ?? null,
    health: ['green', 'yellow', 'red'].includes(input.cat?.health) ? input.cat.health : null,
    status: input.cat?.status ?? null,
    aliases: Object.entries(aliasMap)
      .map(([name, a]) => ({ name, is_write_index: typeof a?.is_write_index === 'boolean' ? a.is_write_index : null }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    settings: {
      number_of_shards: int(flat('number_of_shards')),
      number_of_replicas: int(flat('number_of_replicas')),
      refresh_interval: flat('refresh_interval') ?? null,
      creation_date: creation !== null ? new Date(creation).toISOString() : null,
      version_created: flat('version.created') ?? null,
    },
    mapping: {
      dynamic: mappings.dynamic !== undefined ? String(mappings.dynamic) : null,
      field_count: countMappingFields(props),
      top_level_fields: Object.entries(props)
        .map(([name, def]) => ({ name, type: String(def?.type ?? (def?.properties ? 'object' : 'unknown')) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    },
    docs: { count: int(pri.docs?.count), deleted: int(pri.docs?.deleted) },
    store: { primaries_bytes: int(pri.store?.size_in_bytes), total_bytes: int(tot.store?.size_in_bytes) },
    cumulative_stats: {
      basis: 'cumulative_since_shard_start',
      scope: 'total',
      search_query_total: int(tot.search?.query_total),
      search_query_time_ms: int(tot.search?.query_time_in_millis),
      search_fetch_total: int(tot.search?.fetch_total),
      indexing_index_total: int(tot.indexing?.index_total),
      indexing_index_time_ms: int(tot.indexing?.index_time_in_millis),
      indexing_index_failed: int(tot.indexing?.index_failed),
      refresh_total: int(tot.refresh?.total),
    },
    shards: shapeShards(input.shards),
    observed_at: input.observedAt,
  };
}

export const indexGet: Handler = async (req, inputs, timeoutMs) => {
  const ep = resolveEndpoint(req, inputs.cluster);
  const requested = requireIndexName(inputs.index);
  const ctx = { cluster: ep.name, index: requested };
  const client = new OsClient(ep, timeoutMs);
  try {
    const warnings: string[] = [];
    const version = await observeVersion(client, warnings);
    const enc = encodeURIComponent(requested);
    // _cat/indices resolves aliases to their backing indices; 404 index_not_found -> NOT_FOUND
    const catRows = await client.request<any[]>('GET', `/_cat/indices/${enc}?format=json&bytes=b&expand_wildcards=all`);
    const catAt = new Date().toISOString();
    let index = requested;
    let resolvedFromAlias: string | null = null;
    if (!catRows.some((r) => r.index === requested)) {
      const backing = catRows.map((r) => String(r.index)).sort();
      if (backing.length !== 1) {
        throw new PluginError('INVALID_ARGUMENT', `${requested} 是别名，指向 ${backing.length} 个索引；search index get 只描述单个索引`, {
          hint: `对其中一个索引调用，例如 --index ${backing[0] ?? '<index>'}`,
          details: { cluster: ep.name, alias: requested, resolved_indices: backing },
        });
      }
      index = backing[0];
      resolvedFromAlias = requested;
      warnings.push(`${requested} 是别名，已解析为索引 ${index}`);
    }
    const cat = catRows.find((r) => r.index === index) ?? null;
    const ienc = encodeURIComponent(index);
    const settings = await client.request('GET', `/${ienc}/_settings?flat_settings=true`);
    const mapping = await client.request('GET', `/${ienc}/_mapping`);
    const aliases = await client.request('GET', `/${ienc}/_alias`);
    const metaAt = new Date().toISOString();
    // a closed index has settings / mapping / aliases, but _stats and _cat/shards reject it (index_closed_exception)
    const closed = cat?.status === 'close';
    const stats = closed ? null : await client.request<any>('GET', `/${ienc}/_stats/docs,store,search,indexing,refresh`);
    const statsAt = new Date().toISOString();
    const shards = closed ? [] : await client.request<any[]>('GET', `/_cat/shards/${ienc}?format=json&bytes=b&h=index,shard,prirep,state,docs,store,node,unassigned.reason`);
    const observedAt = new Date().toISOString();
    const data = shapeIndexGet({ cluster: ep.name, requested, index, resolvedFromAlias, cat, settings, mapping, stats, shards, aliases, observedAt });

    const statsFailed = int(stats?._shards?.failed) ?? 0;
    if (statsFailed > 0) warnings.push(`_stats 有 ${statsFailed} 个分片未返回统计，docs/store/累计统计偏小`);
    if (closed) warnings.push('索引处于关闭状态（close），不可搜索；_stats 与 _cat/shards 不接受关闭的索引，docs/store/累计统计与分片分配未采集（null / 空）');
    if (data.health === 'red') warnings.push('索引健康为 red：有主分片未分配，部分数据当前不可读');
    if (data.shards.unassigned.length) {
      warnings.push(`有 ${data.shards.unassigned.length} 个分片副本未分配（${data.shards.unassigned.map((u) => `${u.shard}${u.prirep}${u.unassigned_reason ? `:${u.unassigned_reason}` : ''}`).join(', ')}）`);
    }
    const partial = statsFailed > 0 || closed;
    return {
      status: partial ? 'partial' : 'success',
      data,
      sources: [
        makeSource(ep, version, `GET /_cat/indices/${requested}?bytes=b`, 'explicit', catAt),
        makeSource(ep, version, `GET /${index}/_settings, /${index}/_mapping, /${index}/_alias`, 'explicit', metaAt),
        ...(closed
          ? []
          : [
              makeSource(ep, version, `GET /${index}/_stats/docs,store,search,indexing,refresh`, 'explicit', statsAt),
              makeSource(ep, version, `GET /_cat/shards/${index}?bytes=b`, 'explicit', observedAt),
            ]),
        makeSource(ep, version, 'mapping.field_count / shards 汇总', 'derived', observedAt),
      ],
      coverage: {
        complete: !partial,
        scope: `索引 ${index}${resolvedFromAlias ? `（由别名 ${resolvedFromAlias} 解析）` : ''} 的设置、映射、统计与分片分配`,
        notes: [
          'cumulative_stats 是自分片启动/重新分配以来的累计值（所有分片副本之和），不是时间窗口内的速率；求速率需两次采样差分',
          'docs.count 来自 _stats primaries，是 Lucene 文档数（nested 子文档也计入）；刚写入、尚未 refresh 的文档不计入',
          '各接口分次读取，不是原子快照',
        ],
      },
      warnings,
    };
  } catch (e) {
    throw mapOsError(e, ctx);
  }
};

// ---------------------------------------------------------------------------------------------
// search.query
// ---------------------------------------------------------------------------------------------
export function readDslFile(path: unknown): DslInput | null {
  if (path === undefined || path === null || path === '') return null;
  if (typeof path !== 'string') throw new PluginError('INVALID_ARGUMENT', '--dsl-file 必须是文件路径');
  if (!isAbsolute(path) && !existsSync(path)) {
    throw new PluginError('INVALID_ARGUMENT', `--dsl-file 使用了相对路径且在插件工作目录下找不到: ${path}`, {
      hint: '经 workctl 调用时 core 会把相对路径转成绝对路径；直接按协议调用插件时请传绝对路径（插件工作目录是安装目录）',
    });
  }
  if (!existsSync(path) || !statSync(path).isFile()) throw new PluginError('INVALID_ARGUMENT', `--dsl-file 不存在或不是普通文件: ${path}`);
  if (statSync(path).size > 256 * 1024) throw new PluginError('INVALID_ARGUMENT', '--dsl-file 超过 256 KiB 上限');
  return parseDsl(readFileSync(path, 'utf8'));
}

export function shapeSearchResponse(input: {
  cluster: string;
  index: string;
  guarded: ReturnType<typeof buildSearchBody>;
  maxHits: number;
  res: any;
  observedAt: string;
}): { data: QueryData; status: 'success' | 'partial'; truncated: boolean; warnings: string[]; notes: string[] } {
  const { res, guarded } = input;
  const tth = Number(guarded.body.track_total_hits);
  const sh = res?._shards ?? {};
  const shards = { total: int(sh.total) ?? 0, successful: int(sh.successful) ?? 0, skipped: int(sh.skipped) ?? 0, failed: int(sh.failed) ?? 0 };
  // every index has >= 1 shard: zero shards means a wildcard matched no open index (expand_wildcards=open,
  // allow_no_indices) — nothing was searched, which must not read as "0 matching documents"
  if (sh.total !== undefined && shards.total === 0) {
    throw new PluginError('NOT_FOUND', `${input.index} 没有匹配到任何打开的索引，未搜索任何数据`, {
      hint: '通配符只展开打开的索引（关闭的索引不可搜索）；用 search cluster get 查看索引数与 closed 计数，或用具体索引名/别名',
      details: { cluster: input.cluster, index: input.index },
    });
  }
  const failures = (Array.isArray(sh.failures) ? sh.failures : []).slice(0, 20).map((f: any) => ({
    index: f?.index ?? null,
    shard: int(f?.shard),
    type: f?.reason?.type ?? null,
    reason: [f?.reason?.reason, f?.reason?.caused_by?.reason].filter(Boolean).join(': ') || null,
  }));
  const rawTotal = res?.hits?.total;
  const total =
    typeof rawTotal === 'number'
      ? { value: rawTotal, relation: 'eq' as const }
      : { value: int(rawTotal?.value) ?? 0, relation: (rawTotal?.relation === 'gte' ? 'gte' : 'eq') as 'eq' | 'gte' };
  let anySourceTruncated = false;
  const hits = (Array.isArray(res?.hits?.hits) ? res.hits.hits : []).map((h: any) => {
    const t = truncateSource(h?._source);
    if (t.truncated) anySourceTruncated = true;
    return {
      index: String(h?._index ?? ''),
      id: String(h?._id ?? ''),
      score: typeof h?._score === 'number' ? h._score : null,
      ...(Array.isArray(h?.sort) ? { sort: h.sort } : {}),
      source: t.source,
      source_truncated: t.truncated,
    };
  });
  const timedOut = !!res?.timed_out;
  // shards with no active copy (red index) are left out of `failed` and `failures`: only
  // successful (which includes skipped) < total reveals them
  const unavailable = Math.max(0, shards.total - shards.successful - shards.failed);
  let aggregations: Record<string, unknown> | null = res?.aggregations && typeof res.aggregations === 'object' ? res.aggregations : null;
  // histograms and the like have no size: bound the serialized output so it never hits the plugin output limit
  const aggBytes = aggregations ? Buffer.byteLength(JSON.stringify(aggregations)) : 0;
  const aggsDropped = aggBytes > MAX_AGG_OUTPUT_BYTES;
  if (aggsDropped) aggregations = null;
  const partial = shards.failed > 0 || unavailable > 0 || timedOut || aggsDropped;
  // size=0 (aggregation-only / count-only): no hit list was requested, so returning 0 hits is not a
  // truncation; only an inexact total (relation=gte) leaves the result incomplete
  const hitsRequested = guarded.size > 0;
  const truncated = total.relation === 'gte' || (hitsRequested && total.value > hits.length);
  const warnings: string[] = [];
  if (shards.failed > 0) {
    warnings.push(`${shards.failed}/${shards.total} 个分片查询失败，命中数与聚合只来自成功的分片（见 data.shard_failures）`);
  }
  if (unavailable > 0) {
    warnings.push(`${unavailable}/${shards.total} 个分片没有可用副本（索引 red / 主分片未分配），未参与查询，命中数与聚合不含这些分片的数据；用 search index get 查看分片分配`);
  }
  if (timedOut) warnings.push(`搜索在 ${guarded.body.timeout} 内未完成（timed_out=true），结果只包含超时前已收集的命中`);
  if (total.relation === 'gte') warnings.push(`total.relation=gte：命中数至少 ${total.value}（达到 track_total_hits=${tth} 后停止精确计数），不是精确值`);
  if (guarded.requested_size > input.maxHits) warnings.push(`DSL size=${guarded.requested_size} 大于 --max-hits=${input.maxHits}，实际只取 ${guarded.size} 条`);
  if (aggsDropped) {
    warnings.push(`聚合结果约 ${Math.round(aggBytes / 1024 / 1024)} MiB，超过输出上限 ${MAX_AGG_OUTPUT_BYTES / 1024 / 1024} MiB，已省略（aggregations=null）；请减小 size、加大 histogram interval 或缩小查询范围`);
  }
  if (anySourceTruncated) warnings.push('部分命中的 _source 过长，已截断（source_truncated=true）');
  const notes = [
    `total 关系为 ${total.relation}：${total.relation === 'eq' ? '精确命中数' : '下限值（实际命中数更多）'}；track_total_hits=${tth}（上限 ${TRACK_TOTAL_HITS_LIMIT}）`,
    hitsRequested
      ? `只返回前 ${guarded.size} 条命中（--max-hits 上限 ${MAX_HITS_CAP}）；${total.value > hits.length || total.relation === 'gte' ? `匹配文档多于返回条数，命中列表是截断的` : '已返回全部匹配文档'}`
      : `DSL size=0：只取命中数${guarded.body.aggs !== undefined ? '与聚合' : ''}，不返回命中文档（不是截断）；聚合在全部匹配文档上计算，不受 size 与 track_total_hits 影响`,
    '近实时：最近一次 refresh（默认 1s）之后写入的文档不可见',
    ...(shards.skipped > 0 ? [`${shards.skipped} 个分片被 can_match 预筛选跳过（判定其中不可能有匹配），不影响结果完整性`] : []),
  ];
  return {
    data: {
      cluster: input.cluster,
      index: input.index,
      query_source: guarded.query_source,
      request: {
        size: guarded.size,
        requested_size: guarded.requested_size,
        max_hits: input.maxHits,
        timeout: String(guarded.body.timeout),
        track_total_hits: tth,
        sort: guarded.body.sort !== undefined,
        aggs: guarded.body.aggs !== undefined,
      },
      took_ms: int(res?.took) ?? 0,
      timed_out: timedOut,
      shards,
      shard_failures: failures,
      total,
      returned: hits.length,
      hits,
      aggregations,
      observed_at: input.observedAt,
    },
    status: partial ? 'partial' : 'success',
    truncated,
    warnings,
    notes,
  };
}

export const query: Handler = async (req, inputs, timeoutMs) => {
  const ep = resolveEndpoint(req, inputs.cluster);
  const targets = requireSearchTarget(inputs.index);
  const index = targets.join(',');
  const maxHits = inputs.max_hits === undefined || inputs.max_hits === null ? DEFAULT_MAX_HITS : Number(inputs.max_hits);
  const queryString = typeof inputs.query === 'string' && inputs.query.trim() ? inputs.query.trim() : null;
  const dsl = readDslFile(inputs.dsl_file);
  // leave ~1.5s for version probe, transfer and response shaping
  const trackTotalHits = inputs.track_total_hits === undefined || inputs.track_total_hits === null ? TRACK_TOTAL_HITS_LIMIT : Number(inputs.track_total_hits);
  const guarded = buildSearchBody({ queryString, dsl, maxHits, trackTotalHits, timeoutMs: Math.max(100, timeoutMs - 1500) });
  const ctx = { cluster: ep.name, index };
  const client = new OsClient(ep, timeoutMs);
  try {
    const warnings: string[] = [];
    const version = await observeVersion(client, warnings);
    // read-only endpoint only (_search); allow_partial_search_results keeps shard failures visible
    const path = `/${encodeIndexList(targets)}/_search?allow_partial_search_results=true&expand_wildcards=open&ignore_unavailable=false`;
    const res = await client.request<any>('POST', path, guarded.body);
    const observedAt = new Date().toISOString();
    const shaped = shapeSearchResponse({ cluster: ep.name, index, guarded, maxHits, res, observedAt });
    return {
      status: shaped.status,
      data: shaped.data,
      sources: [makeSource(ep, version, `POST /${index}/_search`, 'explicit', observedAt)],
      coverage: {
        complete: shaped.status === 'success' && !shaped.truncated,
        truncated: shaped.truncated,
        limit: guarded.size,
        scope: `${index} 上匹配查询的文档（${guarded.query_source}）`,
        notes: shaped.notes,
      },
      warnings: [...warnings, ...shaped.warnings],
    };
  } catch (e) {
    // 400 search_phase_execution_exception "all shards failed" = every shard rejected the query -> INVALID_ARGUMENT
    throw mapOsError(e, ctx);
  }
};

export const HANDLERS: Record<string, Handler> = {
  'search.cluster.get': clusterGet,
  'search.index.get': indexGet,
  'search.query': query,
};
