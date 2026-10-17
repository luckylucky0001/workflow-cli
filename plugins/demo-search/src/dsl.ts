import { PluginError } from './protocol';

/** Hard cap on hits returned by search.query (both --max-hits and DSL size). */
export const MAX_HITS_CAP = 100;
export const DEFAULT_MAX_HITS = 20;
/** Upper bound (and default) for track_total_hits: totals above it come back with relation "gte". */
export const TRACK_TOTAL_HITS_LIMIT = 10_000;
/** Bucket `size`/`shard_size` cap inside aggregations. */
export const MAX_AGG_BUCKETS = 1000;
export const MAX_QUERY_STRING_LENGTH = 4096;

export const ALLOWED_TOP_LEVEL = ['query', 'size', 'sort', '_source', 'aggs'] as const;

/**
 * Keys rejected anywhere in the DSL: everything that runs a script (Painless) or defines
 * runtime fields. Pipeline aggregations such as bucket_script / bucket_selector carry a
 * `script` key and are rejected through it.
 */
export const FORBIDDEN_KEYS = new Set(['script', 'script_score', 'scripted_metric', '_script', 'script_fields', 'runtime_mappings', 'stored_script', 'bucket_script', 'bucket_selector', 'minimum_should_match_script']);
/** Constructs that read documents from other indices than the search target. */
const CROSS_INDEX_KEYS = new Set(['indexed_shape']);
/** `wrapper` carries a base64-encoded query that this scan cannot inspect (it may contain scripts). */
const OPAQUE_KEYS = new Set(['wrapper']);

const MAX_DEPTH = 40;
const MAX_NODES = 5000;

export interface DslInput {
  query?: unknown;
  size?: number;
  sort?: unknown;
  _source?: unknown;
  aggs?: Record<string, unknown>;
}

export interface GuardedRequest {
  body: Record<string, unknown>;
  size: number;
  requested_size: number;
  query_source: 'query_string' | 'dsl' | 'match_all';
}

function bad(message: string, details?: Record<string, unknown>, hint?: string): PluginError {
  return new PluginError('INVALID_ARGUMENT', message, { details, hint: hint ?? `受限 DSL 只允许顶层字段 ${ALLOWED_TOP_LEVEL.join(', ')}；禁止脚本与跨索引读取` });
}

/** Walk the DSL once: forbidden keys, terms lookups, agg bucket sizes, depth and size limits. */
export function scanDsl(value: unknown): void {
  let nodes = 0;
  const walk = (v: unknown, path: string, depth: number, inAggs: boolean): void => {
    if (++nodes > MAX_NODES) throw bad(`DSL 过大（超过 ${MAX_NODES} 个节点）`);
    if (depth > MAX_DEPTH) throw bad(`DSL 嵌套过深（超过 ${MAX_DEPTH} 层）`);
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1, inAggs));
      return;
    }
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const p = path ? `${path}.${k}` : k;
      if (FORBIDDEN_KEYS.has(k)) throw bad(`DSL 含有禁止的脚本相关字段 ${k}（位置 ${p}）`, { forbidden_key: k, path: p }, '脚本查询/脚本聚合/运行时字段会在集群上执行任意代码，受限查询不允许；改用普通 query/aggs');
      if (CROSS_INDEX_KEYS.has(k)) throw bad(`DSL 含有跨索引读取 ${k}（位置 ${p}）`, { forbidden_key: k, path: p });
      if (OPAQUE_KEYS.has(k)) throw bad(`DSL 含有 ${k} 查询（位置 ${p}）：其内容为 base64 编码，无法检查`, { forbidden_key: k, path: p }, '直接写出 query 结构，不要用 wrapper 包装');
      // top_hits returns documents inside aggregation buckets: bypasses the hit cap and _source truncation
      if (k === 'top_hits' && inAggs) {
        throw bad(`聚合 ${p} 会在聚合结果中返回文档，受限查询不允许`, { forbidden_key: k, path: p }, `文档只通过命中列表返回（最多 ${MAX_HITS_CAP} 条）；用 query 过滤 + sort + size 取样本`);
      }
      // terms lookup: {"terms": {"field": {"index": "...", "id": "...", "path": "..."}}} reads another index
      // (also inside aggregations: filter / filters / significant_terms.background_filter carry queries)
      if (k === 'terms' && x && typeof x === 'object' && !Array.isArray(x)) {
        for (const [f, spec] of Object.entries(x as Record<string, unknown>)) {
          if (spec && typeof spec === 'object' && !Array.isArray(spec) && ('index' in spec || 'id' in spec || 'path' in spec)) {
            throw bad(`DSL 含有 terms lookup（${p}.${f}），会读取其他索引的文档`, { path: `${p}.${f}` });
          }
        }
      }
      // more_like_this / percolate referencing stored documents of (possibly) other indices
      if ((k === '_index' || k === 'index') && /(^|\.)(like|unlike|percolate)(\[|\.|$)/.test(path)) {
        throw bad(`DSL 引用了其他索引的文档（${p}）`, { path: p });
      }
      // OpenSearch also accepts numeric strings ("size": "5000")
      const num = typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN;
      if (inAggs && (k === 'size' || k === 'shard_size') && num > MAX_AGG_BUCKETS) {
        throw bad(`聚合 ${p} 超过桶数上限 ${MAX_AGG_BUCKETS}`, { path: p, value: x, limit: MAX_AGG_BUCKETS });
      }
      walk(x, p, depth + 1, inAggs || k === 'aggs' || k === 'aggregations');
    }
  };
  walk(value, '', 0, false);
}

/** Parse and restrict a DSL document (content of --dsl-file). */
export function parseDsl(text: string): DslInput {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw bad(`--dsl-file 不是合法 JSON: ${(e as Error).message}`);
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw bad('--dsl-file 顶层必须是 JSON 对象');
  const obj = json as Record<string, unknown>;
  const extra = Object.keys(obj).filter((k) => !(ALLOWED_TOP_LEVEL as readonly string[]).includes(k));
  if (extra.length) {
    throw bad(`DSL 含有不允许的顶层字段: ${extra.join(', ')}`, { disallowed: extra, allowed: [...ALLOWED_TOP_LEVEL] }, 'from/search_after/timeout/track_total_hits 等由 workctl 控制；分页与脚本不在受限查询范围内');
  }
  if (obj.size !== undefined && (typeof obj.size !== 'number' || !Number.isInteger(obj.size) || obj.size < 0)) throw bad('DSL size 必须是非负整数');
  if (obj.size !== undefined && (obj.size as number) > MAX_HITS_CAP) {
    throw bad(`DSL size=${obj.size} 超过上限 ${MAX_HITS_CAP}`, { size: obj.size, limit: MAX_HITS_CAP }, '受限查询最多返回 100 条命中；需要统计请用 aggs');
  }
  if (obj.query !== undefined && (!obj.query || typeof obj.query !== 'object' || Array.isArray(obj.query))) throw bad('DSL query 必须是对象');
  if (obj.aggs !== undefined && (!obj.aggs || typeof obj.aggs !== 'object' || Array.isArray(obj.aggs))) throw bad('DSL aggs 必须是对象');
  if (obj.sort !== undefined && typeof obj.sort !== 'string' && !Array.isArray(obj.sort) && (typeof obj.sort !== 'object' || !obj.sort)) throw bad('DSL sort 必须是字符串、对象或数组');
  const src = obj._source;
  if (src !== undefined && typeof src !== 'boolean' && typeof src !== 'string' && !Array.isArray(src) && (typeof src !== 'object' || !src)) throw bad('DSL _source 必须是布尔、字符串、数组或 {includes, excludes}');
  scanDsl(obj);
  return obj as DslInput;
}

/**
 * Build the _search body: query_string from --query or the DSL query, hit size capped,
 * timeout from the remaining budget, track_total_hits bounded.
 */
export function buildSearchBody(opts: { queryString?: string | null; dsl?: DslInput | null; maxHits: number; timeoutMs: number; trackTotalHits?: number }): GuardedRequest {
  const { queryString, dsl } = opts;
  if (!Number.isInteger(opts.maxHits) || opts.maxHits < 1 || opts.maxHits > MAX_HITS_CAP) throw bad(`--max-hits 必须是 1..${MAX_HITS_CAP} 之间的整数`);
  const tth = opts.trackTotalHits ?? TRACK_TOTAL_HITS_LIMIT;
  if (!Number.isInteger(tth) || tth < 1 || tth > TRACK_TOTAL_HITS_LIMIT) throw bad(`--track-total-hits 必须是 1..${TRACK_TOTAL_HITS_LIMIT} 之间的整数`);
  if (queryString && dsl?.query) throw bad('--query 与 DSL 中的 query 只能提供一个', undefined, '把 query_string 写进 DSL 的 query，或去掉 DSL 中的 query');
  let query: unknown;
  let source: GuardedRequest['query_source'];
  if (queryString) {
    if (queryString.length > MAX_QUERY_STRING_LENGTH) throw bad(`--query 超过 ${MAX_QUERY_STRING_LENGTH} 字符`);
    // allow_leading_wildcard=false: leading wildcards force a full term-dictionary scan
    query = { query_string: { query: queryString, allow_leading_wildcard: false } };
    source = 'query_string';
  } else if (dsl?.query) {
    query = dsl.query;
    source = 'dsl';
  } else if (dsl) {
    query = { match_all: {} };
    source = 'match_all';
  } else {
    throw bad('需要 --query <query_string> 或 --dsl-file <json>', undefined, '示例: --query "status:paid AND city:shanghai"');
  }
  const requested = dsl?.size ?? opts.maxHits;
  const size = Math.min(requested, opts.maxHits);
  const body: Record<string, unknown> = {
    query,
    size,
    timeout: `${Math.max(100, Math.floor(opts.timeoutMs))}ms`,
    track_total_hits: tth,
  };
  if (dsl?.sort !== undefined) body.sort = dsl.sort;
  if (dsl?._source !== undefined) body._source = dsl._source;
  if (dsl?.aggs !== undefined) body.aggs = dsl.aggs;
  return { body, size, requested_size: requested, query_source: source };
}

export const MAX_SOURCE_STRING = 512;
export const MAX_SOURCE_FIELDS = 50;
export const MAX_SOURCE_BYTES = 8192;

/** Truncate one hit's _source: long strings, many fields, oversized documents. */
export function truncateSource(src: unknown): { source: unknown; truncated: boolean } {
  if (!src || typeof src !== 'object') return { source: src ?? null, truncated: false };
  let truncated = false;
  const cut = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string' && v.length > MAX_SOURCE_STRING) {
      truncated = true;
      return `${v.slice(0, MAX_SOURCE_STRING)}…[截断，原长 ${v.length}]`;
    }
    if (Array.isArray(v)) {
      if (v.length > MAX_SOURCE_FIELDS) truncated = true;
      return v.slice(0, MAX_SOURCE_FIELDS).map((x) => cut(x, depth + 1));
    }
    if (v && typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.length > MAX_SOURCE_FIELDS) truncated = true;
      return Object.fromEntries(entries.slice(0, MAX_SOURCE_FIELDS).map(([k, x]) => [k, depth > 8 ? '[嵌套过深，已省略]' : cut(x, depth + 1)]));
    }
    return v;
  };
  let out = cut(src, 0);
  const json = JSON.stringify(out);
  if (json.length > MAX_SOURCE_BYTES) {
    truncated = true;
    out = { _truncated_preview: `${json.slice(0, MAX_SOURCE_BYTES)}…` };
  }
  return { source: out, truncated };
}
