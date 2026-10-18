import { execFileSync, spawn } from 'node:child_process';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { installPlugin, loadPlugins, PluginManifestSchema } from '../../src/core/plugins';
import { builtinRegistry } from '../../src/domains';
import { countMappingFields, HANDLERS, topBucketAggregations, readDslFile, shapeClusterGet, shapeIndexGet, shapeSearchResponse, shapeShards } from '../../plugins/demo-search/src/capabilities';
import { aggBucketBound, buildSearchBody, hasQueryStringRegex, MAX_AGG_OUTPUT_BYTES, MAX_HITS_CAP, parseDsl, scanDsl, TRACK_TOTAL_HITS_LIMIT, truncateSource } from '../../plugins/demo-search/src/dsl';
import { buildManifest, CAPABILITIES } from '../../plugins/demo-search/src/manifest';
import { mapOsError, OsClient, OsHttpError, requireIndexName, requireSearchTarget, resolveEndpoint } from '../../plugins/demo-search/src/opensearch';
import { RequestSchema } from '../../plugins/demo-search/src/protocol';
import { OUTPUT_SCHEMAS } from '../../plugins/demo-search/src/schemas';

const pluginDir = resolve(__dirname, '..', '..', 'plugins', 'demo-search');
const entry = join(pluginDir, 'dist', 'plugin.mjs');
const tgz = join(pluginDir, 'dist', 'demo-search-plugin.tgz');
const repoRoot = resolve(__dirname, '..', '..');

const invalid = expect.objectContaining({ code: 'INVALID_ARGUMENT' });

describe('demo-search DSL guard', () => {
  it('accepts only query/size/sort/_source/aggs at the top level', () => {
    const ok = parseDsl(JSON.stringify({ query: { term: { status: 'paid' } }, size: 5, sort: [{ amount: 'desc' }], _source: ['order_id'], aggs: { c: { terms: { field: 'city', size: 10 } } } }));
    expect(ok.size).toBe(5);
    for (const extra of ['from', 'search_after', 'timeout', 'track_total_hits', 'script_fields', 'runtime_mappings', 'highlight', 'aggregations']) {
      expect(() => parseDsl(JSON.stringify({ query: { match_all: {} }, [extra]: 1 })), extra).toThrow(invalid);
    }
    expect(() => parseDsl('{not json')).toThrow(invalid);
    expect(() => parseDsl('[]')).toThrow(invalid);
    expect(() => parseDsl(JSON.stringify({ query: 'status:paid' }))).toThrow(invalid);
  });

  it('rejects scripts anywhere: queries, sorts, metric and pipeline aggregations', () => {
    const cases: unknown[] = [
      { query: { script_score: { query: { match_all: {} }, script: { source: '1' } } } },
      { query: { bool: { filter: [{ script: { script: { source: "doc['amount'].value > 1" } } }] } } },
      { query: { function_score: { query: { match_all: {} }, functions: [{ script_score: { script: 'x' } }] } } },
      { query: { match_all: {} }, sort: [{ _script: { type: 'number', script: { source: '1' }, order: 'asc' } }] },
      { aggs: { m: { scripted_metric: { init_script: 'x', map_script: 'y', combine_script: 'z', reduce_script: 'w' } } } },
      { aggs: { d: { date_histogram: { field: 'created_at', calendar_interval: 'day' }, aggs: { r: { bucket_script: { buckets_path: {}, script: 'x' } } } } } },
      { aggs: { s: { sum: { field: 'amount', script: { source: '_value * 2' } } } } },
    ];
    for (const c of cases) {
      expect(() => parseDsl(JSON.stringify(c)), JSON.stringify(c)).toThrow(invalid);
    }
    try {
      parseDsl(JSON.stringify(cases[0]));
    } catch (e: any) {
      expect(e.details.forbidden_key).toBe('script_score');
      expect(e.details.path).toBe('query.script_score');
    }
  });

  it('rejects cross-index reads but allows a plain terms query / terms aggregation', () => {
    expect(() => scanDsl({ query: { terms: { customer_id: { index: 'other', id: '1', path: 'ids' } } } })).toThrow(invalid);
    expect(() => scanDsl({ query: { geo_shape: { loc: { indexed_shape: { index: 'shapes', id: '1' } } } } })).toThrow(invalid);
    expect(() => scanDsl({ query: { more_like_this: { fields: ['note'], like: [{ _index: 'other', _id: '1' }] } } })).toThrow(invalid);
    expect(() => scanDsl({ query: { terms: { status: ['paid', 'shipped'] } }, aggs: { c: { terms: { field: 'city', size: 20 } } } })).not.toThrow();
  });

  it('caps sizes: DSL size <= 100, aggregation buckets <= 1000, depth and node budget', () => {
    expect(() => parseDsl(JSON.stringify({ size: MAX_HITS_CAP + 1 }))).toThrow(invalid);
    expect(() => parseDsl(JSON.stringify({ size: -1 }))).toThrow(invalid);
    expect(() => parseDsl(JSON.stringify({ size: 1.5 }))).toThrow(invalid);
    expect(parseDsl(JSON.stringify({ size: MAX_HITS_CAP })).size).toBe(100);
    expect(() => scanDsl({ aggs: { c: { terms: { field: 'city', size: 5000 } } } })).toThrow(invalid);
    let deep: any = { match_all: {} };
    for (let i = 0; i < 60; i++) deep = { bool: { must: [deep] } };
    expect(() => scanDsl({ query: deep })).toThrow(invalid);
  });

  it('review: closes guard bypasses confirmed on OpenSearch 2.19.3', () => {
    // wrapper = base64-encoded query, ran a script query live
    const wrapped = Buffer.from(JSON.stringify({ script: { script: { source: 'true' } } })).toString('base64');
    expect(() => scanDsl({ query: { wrapper: { query: wrapped } } })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT', details: expect.objectContaining({ forbidden_key: 'wrapper' }) }));
    // terms_set runs Painless through minimum_should_match_script
    expect(() => scanDsl({ query: { terms_set: { status: { terms: ['paid'], minimum_should_match_script: { source: '1' } } } } })).toThrow(invalid);
    // cross-index reads inside query-bearing aggregations (filter / filters / significant_terms.background_filter)
    expect(() => scanDsl({ aggs: { f: { filter: { terms: { status: { index: 'other', id: '1', path: 'status' } } } } } })).toThrow(invalid);
    expect(() => scanDsl({ aggs: { f: { filters: { filters: { a: { more_like_this: { fields: ['note'], like: [{ _index: 'other', _id: '1' }] } } } } } } })).toThrow(invalid);
    // OpenSearch accepts numeric strings for bucket sizes ("5000" returned 3000 buckets live)
    expect(() => scanDsl({ aggs: { c: { terms: { field: 'order_id', size: '5000' } } } })).toThrow(invalid);
    expect(() => scanDsl({ aggs: { c: { terms: { field: 'order_id', shard_size: ' 1001 ' } } } })).toThrow(invalid);
    // top_hits returned 1000 untruncated documents in aggregations, past the 100-hit cap
    expect(() => scanDsl({ size: 0, aggs: { c: { terms: { field: 'order_id', size: 1000 }, aggs: { h: { top_hits: { size: 100 } } } } } })).toThrow(invalid);
    // still allowed: terms aggregation with ordinary options, filter aggregation with a plain terms query, field named size
    expect(() => scanDsl({ aggs: { c: { terms: { field: 'city', size: '20', order: { _count: 'desc' } } }, f: { filter: { terms: { status: ['paid'] } } }, s: { filter: { term: { size: 'large' } } } } })).not.toThrow();
  });
});

describe('demo-search expensive query guards', () => {
  it('rejects regex in --query but keeps escaped and quoted slashes', () => {
    expect(() => buildSearchBody({ queryString: 'name:/joh?n(ath[oa]n)/', maxHits: 5, timeoutMs: 1000 })).toThrow(/正则/);
    expect(hasQueryStringRegex('path:"/api/v1"')).toBe(false);
    expect(hasQueryStringRegex('path:\\/api')).toBe(false);
    expect(hasQueryStringRegex('a:/.*/')).toBe(true);
  });

  it('rejects leading-wildcard options and huge automata in the DSL; defaults query_string to no leading wildcard', () => {
    expect(() => parseDsl(JSON.stringify({ query: { query_string: { query: '*abc', allow_leading_wildcard: true } } }))).toThrow(/allow_leading_wildcard/);
    expect(() => parseDsl(JSON.stringify({ query: { regexp: { name: { value: '.*a.*b.*', max_determinized_states: 1000000 } } } }))).toThrow(/max_determinized_states/);
    expect(() => parseDsl(JSON.stringify({ query: { query_string: { query: 'a', max_determinized_states: '50000' } } }))).toThrow(/max_determinized_states/);
    expect(() => parseDsl(JSON.stringify({ query: { wildcard: { name: { value: '*son' } } } }))).toThrow(/通配符开头/);
    expect(() => parseDsl(JSON.stringify({ query: { bool: { filter: [{ wildcard: { name: '?ohn' } }] } } }))).toThrow(/通配符开头/);
    const d = parseDsl(JSON.stringify({ query: { query_string: { query: 'status:paid' } }, aggs: { f: { filter: { query_string: { query: 'x' } } } } }));
    expect((d.query as any).query_string.allow_leading_wildcard).toBe(false);
    expect((d.aggs as any).f.filter.query_string.allow_leading_wildcard).toBe(false);
    expect(() => parseDsl(JSON.stringify({ query: { wildcard: { name: { value: 'jo*' } } } }))).not.toThrow();
  });

  it('bounds nested bucket aggregations and drops oversized aggregation output as partial', () => {
    const nested = { aggs: { a: { terms: { field: 'a', size: 1000 }, aggs: { b: { terms: { field: 'b', size: 1000 } } } } } };
    expect(aggBucketBound(nested.aggs)).toBe(1_001_000);
    expect(() => parseDsl(JSON.stringify(nested))).toThrow(/桶/);
    expect(() => parseDsl(JSON.stringify({ aggs: { a: { terms: { field: 'a', size: 100 }, aggs: { b: { terms: { field: 'b', size: 50 } } } } } }))).not.toThrow();
    const guarded = buildSearchBody({ queryString: 'x', maxHits: 2, timeoutMs: 1000 });
    const buckets = Array.from({ length: Math.ceil(MAX_AGG_OUTPUT_BYTES / 40) + 10 }, (_, i) => ({ key: i, doc_count: 1, key_as_string: 'x'.repeat(10) }));
    const res = { took: 1, timed_out: false, _shards: { total: 1, successful: 1, skipped: 0, failed: 0 }, hits: { total: { value: 0, relation: 'eq' }, hits: [] }, aggregations: { h: { buckets } } };
    const s = shapeSearchResponse({ cluster: 'c', index: 'i', guarded, maxHits: 2, res, observedAt: 't' });
    expect(s.status).toBe('partial');
    expect(s.data.aggregations).toBeNull();
    expect(s.warnings.join(' ')).toContain('聚合结果');
    expect(OUTPUT_SCHEMAS['search.query'].safeParse(s.data).success).toBe(true);
  });
});

describe('demo-search terms top buckets', () => {
  it('names terms aggregations with sum_other_doc_count > 0 in a coverage note, without marking the result partial', () => {
    const guarded = buildSearchBody({ dsl: { size: 0, aggs: { by_status: { terms: { field: 'status', size: 2 } } } }, maxHits: 2, timeoutMs: 1000 });
    const aggregations = {
      by_status: { doc_count_error_upper_bound: 0, sum_other_doc_count: 7, buckets: [{ key: 'paid', doc_count: 10, by_city: { sum_other_doc_count: 3, buckets: [{ key: 'x', doc_count: 4 }] } }, { key: 'new', doc_count: 5 }] },
      all_status: { doc_count_error_upper_bound: 0, sum_other_doc_count: 0, buckets: [{ key: 'paid', doc_count: 10 }] },
    };
    const res = { took: 1, timed_out: false, _shards: { total: 1, successful: 1, skipped: 0, failed: 0 }, hits: { total: { value: 22, relation: 'eq' }, hits: [] }, aggregations };
    expect(topBucketAggregations(aggregations)).toEqual([{ name: 'by_status', other_docs: 7 }, { name: 'by_status > by_city', other_docs: 3 }]);
    const s = shapeSearchResponse({ cluster: 'c', index: 'i', guarded, maxHits: 2, res, observedAt: 't' });
    expect(s.status).toBe('success');
    const note = s.notes.join('\n');
    expect(note).toMatch(/terms 聚合 by_status .*sum_other_doc_count=7/);
    expect(note).toMatch(/by_status > by_city/);
    expect(note).not.toMatch(/all_status/);
  });
});

describe('demo-search request building', () => {
  it('query_string from --query with leading wildcards disabled, timeout and bounded track_total_hits', () => {
    const g = buildSearchBody({ queryString: 'status:paid', maxHits: 20, timeoutMs: 8000 });
    expect(g.body).toEqual({ query: { query_string: { query: 'status:paid', allow_leading_wildcard: false, max_determinized_states: 10_000 } }, size: 20, timeout: '8000ms', track_total_hits: TRACK_TOTAL_HITS_LIMIT });
    expect(g.query_source).toBe('query_string');
    expect(buildSearchBody({ queryString: 'x', maxHits: 1, timeoutMs: 10, trackTotalHits: 500 }).body).toMatchObject({ timeout: '100ms', track_total_hits: 500 });
    expect(() => buildSearchBody({ queryString: 'x', maxHits: 1, timeoutMs: 1000, trackTotalHits: 10_001 })).toThrow(invalid);
  });

  it('effective size is min(DSL size, --max-hits); --max-hits must be 1..100', () => {
    expect(buildSearchBody({ dsl: { size: 80 }, maxHits: 20, timeoutMs: 1000 })).toMatchObject({ size: 20, requested_size: 80, query_source: 'match_all' });
    expect(buildSearchBody({ dsl: { size: 0, aggs: {} }, maxHits: 20, timeoutMs: 1000 }).size).toBe(0);
    expect(buildSearchBody({ dsl: { query: { match_all: {} } }, maxHits: 7, timeoutMs: 1000 }).size).toBe(7);
    for (const m of [0, 101, 2.5]) expect(() => buildSearchBody({ queryString: 'x', maxHits: m, timeoutMs: 1000 })).toThrow(invalid);
  });

  it('needs exactly one query source', () => {
    expect(() => buildSearchBody({ maxHits: 20, timeoutMs: 1000 })).toThrow(invalid);
    expect(() => buildSearchBody({ queryString: 'a', dsl: { query: { match_all: {} } }, maxHits: 20, timeoutMs: 1000 })).toThrow(invalid);
    // --query + DSL without query: DSL contributes sort/aggs only
    const g = buildSearchBody({ queryString: 'a', dsl: { sort: [{ amount: 'desc' }], aggs: { c: { terms: { field: 'city' } } } }, maxHits: 5, timeoutMs: 1000 });
    expect(g.body).toMatchObject({ sort: [{ amount: 'desc' }], aggs: { c: { terms: { field: 'city' } } }, query: { query_string: { query: 'a' } } });
    expect(() => buildSearchBody({ queryString: 'x'.repeat(5000), maxHits: 5, timeoutMs: 1000 })).toThrow(invalid);
  });

  it('validates index targets', () => {
    expect(requireIndexName('demo-orders')).toBe('demo-orders');
    for (const bad of ['', 'demo-*', 'a,b', '_all', '.kibana', 'Upper', 'has space', '-x']) expect(() => requireIndexName(bad), bad).toThrow(invalid);
    expect(requireSearchTarget('demo-orders, demo-orders-archive')).toEqual(['demo-orders', 'demo-orders-archive']);
    expect(requireSearchTarget('demo-orders*')).toEqual(['demo-orders*']);
    for (const bad of ['*', '_all', '.opendistro*', 'a*b', 'd*', Array(11).fill('x1').join(',')]) expect(() => requireSearchTarget(bad), bad).toThrow(invalid);
  });

  it('reads the DSL file only from an absolute path (plugin cwd is the install dir)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'workctl-search-dsl-'));
    try {
      const f = join(dir, 'q.json');
      writeFileSync(f, JSON.stringify({ query: { match_all: {} }, size: 3 }));
      expect(readDslFile(f)).toEqual({ query: { match_all: {} }, size: 3 });
      expect(readDslFile(undefined)).toBeNull();
      expect(() => readDslFile('relative/does-not-exist.json')).toThrow(invalid);
      writeFileSync(f, JSON.stringify({ query: { match_all: {} }, script_fields: {} }));
      expect(() => readDslFile(f)).toThrow(invalid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('truncates long _source values and flags it', () => {
    expect(truncateSource({ a: 'short', n: 1 })).toEqual({ source: { a: 'short', n: 1 }, truncated: false });
    const t = truncateSource({ note: 'x'.repeat(2000) });
    expect(t.truncated).toBe(true);
    expect((t.source as any).note).toContain('原长 2000');
    const wide = truncateSource(Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`f${i}`, i])));
    expect(wide.truncated).toBe(true);
    expect(Object.keys(wide.source as object)).toHaveLength(50);
    expect(truncateSource(null)).toEqual({ source: null, truncated: false });
  });
});

describe('demo-search error mapping and endpoints', () => {
  const ctx = { cluster: 'demo-search', index: 'demo-orders' };
  const http = (status: number, type: string, reason = 'r') => new OsHttpError('POST', '/x/_search', status, { error: { root_cause: [{ type, reason }], type, reason }, status });

  it('maps HTTP statuses and OpenSearch error types to stable codes', () => {
    const nf = mapOsError(new OsHttpError('GET', '/nope', 404, { error: { root_cause: [{ type: 'index_not_found_exception', reason: 'no such index [nope]', index: 'nope' }], type: 'index_not_found_exception', reason: 'no such index [nope]', index: 'nope' }, status: 404 }), ctx);
    expect(nf.code).toBe('NOT_FOUND');
    expect(nf.details?.index).toBe('nope');
    // a closed target is not a query syntax problem
    const closed = mapOsError(http(400, 'index_closed_exception', 'closed'), ctx);
    expect(closed.code).toBe('DATA_UNAVAILABLE');
    expect(closed.hint).not.toContain('query_string');
    const parse = mapOsError(
      new OsHttpError('POST', '/demo-orders/_search', 400, {
        error: { root_cause: [{ type: 'query_shard_exception', reason: 'Failed to parse query [status:(paid]' }], type: 'search_phase_execution_exception', reason: 'all shards failed', failed_shards: [{ reason: { type: 'query_shard_exception', caused_by: { type: 'parse_exception', reason: "Cannot parse 'status:(paid'" } } }] },
        status: 400,
      }),
      ctx,
    );
    expect(parse.code).toBe('INVALID_ARGUMENT');
    expect(parse.message).toContain('Cannot parse');
    expect(parse.details?.opensearch_error_type).toBe('query_shard_exception');
    expect(mapOsError(http(401, 'security_exception'), ctx).code).toBe('UNAUTHENTICATED');
    expect(mapOsError(http(403, 'security_exception'), ctx).code).toBe('PERMISSION_DENIED');
    expect(mapOsError(http(429, 'es_rejected_execution_exception'), ctx).code).toBe('UPSTREAM_UNAVAILABLE');
    expect(mapOsError(http(503, 'cluster_block_exception'), ctx).code).toBe('UPSTREAM_UNAVAILABLE');
    expect(mapOsError(http(504, 'timeout'), ctx).code).toBe('TIMEOUT');
    expect(mapOsError(http(400, 'x', 'y'.repeat(2000)), ctx).message.length).toBeLessThan(600);
  });

  it('maps network failures and timeouts', () => {
    const refused = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }) });
    const m = mapOsError(refused, ctx);
    expect(m.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(m.details?.errno).toBe('ECONNREFUSED');
    expect(mapOsError(Object.assign(new Error('aborted'), { name: 'TimeoutError' }), ctx).code).toBe('TIMEOUT');
    expect(mapOsError(new RangeError('boom'), ctx).code).toBe('INTERNAL');
  });

  it('resolves endpoints; username without a resolved password is UNAUTHENTICATED', () => {
    const req = RequestSchema.parse({
      protocol: 'workctl-plugin/1',
      capability: 'search.cluster.get',
      endpoints: { opensearch: { 'demo-search': { url: 'http://127.0.0.1:19200/' }, secured: { url: 'https://os:9200', username: 'ro' }, broken: { url: 'not a url' } } },
      defaults: { opensearch: 'demo-search' },
    });
    expect(resolveEndpoint(req, undefined)).toMatchObject({ name: 'demo-search', label: 'opensearch/demo-search', baseUrl: 'http://127.0.0.1:19200' });
    expect(() => resolveEndpoint(req, 'nope')).toThrow(expect.objectContaining({ code: 'NOT_CONFIGURED' }));
    expect(() => resolveEndpoint(req, 'broken')).toThrow(expect.objectContaining({ code: 'NOT_CONFIGURED' }));
    expect(() => resolveEndpoint(req, 'secured')).toThrow(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
  });

  it('review: a url with embedded user:password@ is refused without echoing it (fetch errors print the url)', () => {
    const req = RequestSchema.parse({ protocol: 'workctl-plugin/1', capability: 'search.cluster.get', endpoints: { opensearch: { inline: { url: 'http://ro:inline-pw-9876@127.0.0.1:19200' } } } });
    let err: any;
    try {
      resolveEndpoint(req, 'inline');
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe('NOT_CONFIGURED');
    expect(JSON.stringify({ m: err.message, h: err.hint, d: err.details })).not.toContain('inline-pw-9876');
  });

  it('sends basic auth when configured and maps a 401 from the server', async () => {
    let seen: IncomingHttpHeaders | null = null;
    const server = createServer((req, res) => {
      seen = req.headers;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { root_cause: [{ type: 'security_exception', reason: 'missing authentication credentials' }], type: 'security_exception' }, status: 401 }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as any).port;
    try {
      const req = RequestSchema.parse({ protocol: 'workctl-plugin/1', capability: 'search.cluster.get', endpoints: { opensearch: { s: { url: `http://127.0.0.1:${port}`, username: 'ro', password: 'pw-123456' } } } });
      const out = await HANDLERS['search.cluster.get'](req, { cluster: 's' }, 5000).catch((e) => e);
      expect(out.code).toBe('UNAUTHENTICATED');
      expect(JSON.stringify({ m: out.message, d: out.details })).not.toContain('pw-123456');
      expect(seen!.authorization).toBe(`Basic ${Buffer.from('ro:pw-123456').toString('base64')}`);
      const client = new OsClient(resolveEndpoint(req, 's'), 5000);
      await expect(client.request('GET', '/')).rejects.toBeInstanceOf(OsHttpError);
    } finally {
      server.close();
    }
  });
});

describe('demo-search response shaping', () => {
  const guarded = buildSearchBody({ queryString: 'status:paid', maxHits: 2, timeoutMs: 5000 });

  it('success with exact total; truncated when more matches than returned', () => {
    const res = {
      took: 5,
      timed_out: false,
      _shards: { total: 2, successful: 2, skipped: 0, failed: 0 },
      hits: { total: { value: 121, relation: 'eq' }, max_score: 1, hits: [{ _index: 'demo-orders', _id: 'a', _score: 1.5, _source: { order_id: 'a' } }, { _index: 'demo-orders', _id: 'b', _score: 1.2, _source: { order_id: 'b' } }] },
    };
    const s = shapeSearchResponse({ cluster: 'c', index: 'demo-orders', guarded, maxHits: 2, res, observedAt: 't' });
    expect(s.status).toBe('success');
    expect(s.truncated).toBe(true);
    expect(s.data.total).toEqual({ value: 121, relation: 'eq' });
    expect(s.data.hits[0]).toEqual({ index: 'demo-orders', id: 'a', score: 1.5, source: { order_id: 'a' }, source_truncated: false });
    expect(OUTPUT_SCHEMAS['search.query'].safeParse(s.data).success).toBe(true);
    const all = shapeSearchResponse({ cluster: 'c', index: 'i', guarded, maxHits: 2, res: { ...res, hits: { ...res.hits, total: { value: 2, relation: 'eq' } } }, observedAt: 't' });
    expect(all.truncated).toBe(false);
  });

  it('size=0 (aggregation-only) is complete, not a truncated hit list; an inexact total still is', () => {
    const aggOnly = buildSearchBody({ dsl: { size: 0, aggs: { s: { terms: { field: 'status' } } } }, maxHits: 20, timeoutMs: 5000 });
    const res = {
      took: 3,
      timed_out: false,
      _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
      hits: { total: { value: 3000, relation: 'eq' }, hits: [] },
      aggregations: { s: { doc_count_error_upper_bound: 0, sum_other_doc_count: 0, buckets: [{ key: 'paid', doc_count: 3000 }] } },
    };
    const s = shapeSearchResponse({ cluster: 'c', index: 'demo-orders', guarded: aggOnly, maxHits: 20, res, observedAt: 't' });
    expect(s.status).toBe('success');
    expect(s.truncated).toBe(false);
    expect(s.notes.join(' ')).toContain('size=0');
    expect(s.notes.join(' ')).not.toContain('命中列表是截断的');
    const gte = shapeSearchResponse({ cluster: 'c', index: 'i', guarded: aggOnly, maxHits: 20, res: { ...res, hits: { total: { value: 10000, relation: 'gte' }, hits: [] } }, observedAt: 't' });
    expect(gte.truncated).toBe(true);
  });

  it('gte relation is reported as a lower bound', () => {
    const res = { took: 1, timed_out: false, _shards: { total: 1, successful: 1, skipped: 0, failed: 0 }, hits: { total: { value: 10000, relation: 'gte' }, hits: [] } };
    const s = shapeSearchResponse({ cluster: 'c', index: 'i', guarded, maxHits: 2, res, observedAt: 't' });
    expect(s.data.total.relation).toBe('gte');
    expect(s.truncated).toBe(true);
    expect(s.warnings.join(' ')).toContain('至少 10000');
  });

  it('shard failures and timeouts are partial; skipped shards are not', () => {
    const base = { took: 3, hits: { total: { value: 1, relation: 'eq' }, hits: [] } };
    const failed = shapeSearchResponse({
      cluster: 'c', index: 'i', guarded, maxHits: 2, observedAt: 't',
      res: { ...base, timed_out: false, _shards: { total: 3, successful: 2, skipped: 0, failed: 1, failures: [{ shard: 0, index: 'demo-orders-archive', reason: { type: 'query_shard_exception', reason: 'No mapping found for [created_at] in order to sort on' } }] } },
    });
    expect(failed.status).toBe('partial');
    expect(failed.data.shard_failures).toEqual([{ index: 'demo-orders-archive', shard: 0, type: 'query_shard_exception', reason: 'No mapping found for [created_at] in order to sort on' }]);
    expect(shapeSearchResponse({ cluster: 'c', index: 'i', guarded, maxHits: 2, observedAt: 't', res: { ...base, timed_out: true, _shards: { total: 1, successful: 1, skipped: 0, failed: 0 } } }).status).toBe('partial');
    const skipped = shapeSearchResponse({ cluster: 'c', index: 'i', guarded, maxHits: 2, observedAt: 't', res: { ...base, timed_out: false, _shards: { total: 3, successful: 3, skipped: 2, failed: 0 } } });
    expect(skipped.status).toBe('success');
    expect(skipped.notes.join(' ')).toContain('can_match');
  });

  it('zero shards searched (wildcard matched no open index) is NOT_FOUND, not an empty success', () => {
    const res = { took: 0, timed_out: false, _shards: { total: 0, successful: 0, skipped: 0, failed: 0 }, hits: { total: { value: 0, relation: 'eq' }, max_score: 0, hits: [] } };
    expect(() => shapeSearchResponse({ cluster: 'c', index: 'closed-only*', guarded, maxHits: 2, res, observedAt: 't' })).toThrow(/没有匹配到任何打开的索引/);
    try {
      shapeSearchResponse({ cluster: 'c', index: 'closed-only*', guarded, maxHits: 2, res, observedAt: 't' });
    } catch (e: any) {
      expect(e.code).toBe('NOT_FOUND');
    }
  });

  it('review: shards without an active copy (red index) are partial although failed=0', () => {
    // live answer of OpenSearch 2.19.3 for a red 2-shard index + demo-orders with allow_partial_search_results=true
    const res = { took: 10, timed_out: false, _shards: { total: 4, successful: 2, skipped: 0, failed: 0 }, hits: { total: { value: 3000, relation: 'eq' }, hits: [] } };
    const s = shapeSearchResponse({ cluster: 'c', index: 'red,demo-orders', guarded, maxHits: 2, res, observedAt: 't' });
    expect(s.status).toBe('partial');
    expect(s.warnings.join(' ')).toContain('2/4 个分片没有可用副本');
  });

  it('cluster red/yellow stays success with a warning', () => {
    const health = { cluster_name: 'x', status: 'red', timed_out: false, number_of_nodes: 1, number_of_data_nodes: 1, active_primary_shards: 1, active_shards: 1, relocating_shards: 0, initializing_shards: 0, unassigned_shards: 2, delayed_unassigned_shards: 0, number_of_pending_tasks: 0, active_shards_percent_as_number: 33.3 };
    const cat = [{ index: 'a', health: 'red', status: 'open' }, { index: '.sys', health: 'green', status: 'open' }, { index: 'c', health: null, status: 'close' }];
    const r = shapeClusterGet('demo-search', { distribution: 'opensearch', number: '2.19.3', cluster_name: 'x', cluster_uuid: 'u', lucene_version: '9' }, health, cat, 't');
    expect(r.data.health.status).toBe('red');
    expect(r.data.indices).toEqual({ total: 3, by_health: { green: 1, yellow: 0, red: 1, unknown: 1 }, closed: 1, dot_prefixed: 1 });
    expect(r.warnings.join(' ')).toContain('red');
    expect(OUTPUT_SCHEMAS['search.cluster.get'].safeParse(r.data).success).toBe(true);
    expect(shapeClusterGet('d', null, { ...health, status: 'green', unassigned_shards: 0 }, [], 't').warnings).toEqual([]);
  });

  it('shapes index details: settings, mapping summary, cumulative stats, shard allocation', () => {
    const props = { a: { type: 'keyword' }, b: { properties: { c: { type: 'long' }, d: { type: 'text', fields: { raw: { type: 'keyword' } } } } } };
    expect(countMappingFields(props)).toBe(4);
    const data = shapeIndexGet({
      cluster: 'c',
      requested: 'alias-1',
      index: 'idx',
      resolvedFromAlias: 'alias-1',
      cat: { index: 'idx', health: 'yellow', status: 'open', uuid: 'U' },
      settings: { idx: { settings: { 'index.number_of_shards': '1', 'index.number_of_replicas': '1', 'index.creation_date': '1792250391250', 'index.version.created': '136408127' } } },
      mapping: { idx: { mappings: { dynamic: 'strict', properties: props } } },
      stats: { _shards: { failed: 0 }, indices: { idx: { primaries: { docs: { count: 400, deleted: 1 }, store: { size_in_bytes: 1000 } }, total: { store: { size_in_bytes: 1000 }, search: { query_total: 7, query_time_in_millis: 3, fetch_total: 2 }, indexing: { index_total: 400, index_time_in_millis: 50, index_failed: 0 }, refresh: { total: 9 } } } } },
      shards: [
        { index: 'idx', shard: '0', prirep: 'r', state: 'UNASSIGNED', docs: null, store: null, node: null, 'unassigned.reason': 'INDEX_CREATED' },
        { index: 'idx', shard: '0', prirep: 'p', state: 'STARTED', docs: '400', store: '1000', node: 'n1' },
      ],
      aliases: { idx: { aliases: { 'alias-1': { is_write_index: true }, 'alias-2': {} } } },
      observedAt: 't',
    });
    expect(data.settings).toMatchObject({ number_of_shards: 1, number_of_replicas: 1, refresh_interval: null, creation_date: '2026-10-17T15:19:51.250Z' });
    expect(data.mapping).toMatchObject({ dynamic: 'strict', field_count: 4, top_level_fields: [{ name: 'a', type: 'keyword' }, { name: 'b', type: 'object' }] });
    expect(data.cumulative_stats).toMatchObject({ basis: 'cumulative_since_shard_start', search_query_total: 7, indexing_index_total: 400, refresh_total: 9 });
    expect(data.shards).toMatchObject({ primaries: 1, replicas_per_primary: 1, copies_total: 2, by_state: { STARTED: 1, UNASSIGNED: 1 }, nodes: ['n1'] });
    expect(data.shards.unassigned[0]).toMatchObject({ shard: 0, prirep: 'r', unassigned_reason: 'INDEX_CREATED' });
    expect(data.aliases).toEqual([{ name: 'alias-1', is_write_index: true }, { name: 'alias-2', is_write_index: null }]);
    expect(OUTPUT_SCHEMAS['search.index.get'].safeParse(data).success).toBe(true);
    expect(shapeShards([]).replicas_per_primary).toBeNull();
  });
});

describe('demo-search manifest', () => {
  const manifest = buildManifest();

  it('is accepted by the core plugin manifest schema', () => {
    const parsed = PluginManifestSchema.safeParse(manifest);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('available capabilities have handlers and schemas; planned ones have neither', () => {
    for (const c of CAPABILITIES) {
      expect(c.name.startsWith('search.')).toBe(true);
      if (c.status === 'available') {
        expect(HANDLERS[c.name], c.name).toBeTypeOf('function');
        expect(OUTPUT_SCHEMAS[c.name], c.name).toBeDefined();
        expect(c.output_schema).toBe(`schemas/${c.name}.v1.json`);
      } else {
        expect(HANDLERS[c.name]).toBeUndefined();
        expect(c.output_schema).toBeUndefined();
      }
      for (const k of Object.keys(c.inputs)) expect(k).toMatch(/^[a-z][a-z0-9_]*$/);
    }
    expect(CAPABILITIES.find((c) => c.name === 'search.snapshot.list')?.status).toBe('planned');
    expect((manifest.compatibility as any).engines[0]).toMatchObject({ engine: 'opensearch', versions: '2.x', verified: ['2.19.3'] });
  });

  it('fulfils the built-in planned search capabilities with the same names and commands', () => {
    const reg = builtinRegistry();
    for (const name of ['search.index.get', 'search.query']) {
      const builtin = reg.get(name);
      expect(builtin?.status).toBe('planned');
      expect(CAPABILITIES.find((c) => c.name === name)?.command).toBe(builtin?.command);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Live: spawn the bundled plugin against demo-search (OpenSearch, localhost:19200)
// ---------------------------------------------------------------------------------------------
const OS_URL = process.env.OPENSEARCH_URL ?? 'http://127.0.0.1:19200';

function runPlugin(capability: string, inputs: Record<string, unknown>, url = OS_URL): Promise<{ stdout: string; code: number | null; json: any }> {
  const request = {
    protocol: 'workctl-plugin/1',
    capability,
    inputs,
    endpoints: { opensearch: { 'demo-search': { url } } },
    defaults: { opensearch: 'demo-search' },
    profile: 'demo',
    env: 'sandbox',
    request_id: `req-it-${Date.now()}`,
    timeout_ms: 20_000,
  };
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', rej);
    child.on('close', (code) => {
      try {
        res({ stdout, code, json: JSON.parse(stdout) });
      } catch {
        rej(new Error(`plugin stdout is not one JSON document: ${stdout.slice(0, 300)} / ${stderr.slice(0, 300)}`));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

describe.skipIf(process.env.WORKCTL_IT !== '1')('demo-search live (WORKCTL_IT=1, demo-search OpenSearch)', () => {
  const dslDir = join(repoRoot, 'demo', 'scenarios', 'search', 'dsl');

  beforeAll(async () => {
    if (!existsSync(entry) || !existsSync(tgz)) execFileSync(process.execPath, [join(pluginDir, 'build.mjs')], { stdio: 'inherit' });
    // seed only when the synthetic index is missing or incomplete (seed is deterministic)
    const r = await fetch(`${OS_URL}/demo-orders/_count`).catch(() => null);
    const count = r && r.ok ? (await r.json()).count : -1;
    const archive = await fetch(`${OS_URL}/demo-orders-archive/_count`).catch(() => null);
    if (count !== 3000 || !archive?.ok) execFileSync(process.execPath, [join(repoRoot, 'demo', 'scenarios', 'search', 'seed.mjs'), '--url', OS_URL], { stdio: 'inherit' });
  }, 120_000);

  it('search.cluster.get reports health, actual version and index counts', async () => {
    const out = await runPlugin('search.cluster.get', { cluster: 'demo-search' });
    expect(out.code).toBe(0);
    expect(out.stdout.trim().split('\n')).toHaveLength(1);
    const r = out.json;
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(r.data.distribution).toBe('opensearch');
    expect(r.data.version).toMatch(/^2\./);
    expect(r.data.health.number_of_nodes).toBe(1);
    expect(r.data.indices.total).toBeGreaterThanOrEqual(2);
    // demo-orders-archive has 1 replica on a single node -> yellow with a warning, still success
    expect(r.data.health.status).toBe('yellow');
    expect(r.meta.warnings.join(' ')).toContain('yellow');
    expect(r.meta.sources[0]).toMatchObject({ system: 'opensearch', adapter: 'opensearch-http', endpoint: 'opensearch/demo-search', version: `opensearch ${r.data.version}` });
    expect(OUTPUT_SCHEMAS['search.cluster.get'].safeParse(r.data).success).toBe(true);
  });

  it('closed index: index get returns settings/mapping as partial (stats not collected); a wildcard over it is NOT_FOUND', async () => {
    const ix = 'it-closed-probe';
    const put = (path: string, method: string, body?: unknown) => fetch(`${OS_URL}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    await put(`/${ix}`, 'DELETE');
    try {
      expect((await put(`/${ix}`, 'PUT', { settings: { number_of_shards: 1, number_of_replicas: 0 }, aliases: { [`${ix}-alias`]: {} }, mappings: { properties: { user: { properties: { name: { type: 'text' } } } } } })).ok).toBe(true);
      expect((await put(`/${ix}/_close`, 'POST')).ok).toBe(true);
      for (const index of [ix, `${ix}-alias`]) {
        const r = (await runPlugin('search.index.get', { cluster: 'demo-search', index })).json;
        expect(r.status, JSON.stringify(r.error)).toBe('partial');
        expect(r.data).toMatchObject({ index: ix, status: 'close', docs: { count: null } });
        expect(r.data.mapping.top_level_fields).toEqual([{ name: 'user', type: 'object' }]);
        expect(r.meta.warnings.join(' ')).toContain('关闭');
        expect(OUTPUT_SCHEMAS['search.index.get'].safeParse(r.data).success).toBe(true);
      }
      const q = (await runPlugin('search.query', { cluster: 'demo-search', index: 'it-closed-pro*', query: '*' })).json;
      expect(q.status).toBe('error');
      expect(q.error.code).toBe('NOT_FOUND');
      const qa = (await runPlugin('search.query', { cluster: 'demo-search', index: `${ix}-alias`, query: '*' })).json;
      expect(qa.error.code).toBe('DATA_UNAVAILABLE');
    } finally {
      await put(`/${ix}`, 'DELETE');
    }
  });

  it('search.index.get resolves a single-index alias and reports mapping/stats/shards', async () => {
    const r = (await runPlugin('search.index.get', { cluster: 'demo-search', index: 'demo-orders-current' })).json;
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(r.data).toMatchObject({ index: 'demo-orders', resolved_from_alias: 'demo-orders-current', health: 'green', docs: { count: 3000 } });
    expect(r.data.mapping.top_level_fields).toEqual(expect.arrayContaining([{ name: 'order_id', type: 'keyword' }, { name: 'customer_id', type: 'long' }, { name: 'amount', type: 'double' }, { name: 'created_at', type: 'date' }, { name: 'note', type: 'text' }]));
    expect(r.data.shards).toMatchObject({ primaries: 2, copies_total: 2, by_state: { STARTED: 2 } });
    expect(r.data.cumulative_stats.basis).toBe('cumulative_since_shard_start');
    expect(r.meta.warnings.join(' ')).toContain('别名');
    expect(OUTPUT_SCHEMAS['search.index.get'].safeParse(r.data).success).toBe(true);

    const arc = (await runPlugin('search.index.get', { cluster: 'demo-search', index: 'demo-orders-archive' })).json;
    expect(arc.data.shards.unassigned).toEqual([expect.objectContaining({ shard: 0, prirep: 'r', state: 'UNASSIGNED' })]);
    const multi = (await runPlugin('search.index.get', { cluster: 'demo-search', index: 'demo-orders-all' })).json;
    expect(multi.error.code).toBe('INVALID_ARGUMENT');
    expect(multi.error.details.resolved_indices).toEqual(['demo-orders', 'demo-orders-archive']);
    const missing = (await runPlugin('search.index.get', { cluster: 'demo-search', index: 'no-such-index' })).json;
    expect(missing.error.code).toBe('NOT_FOUND');
  });

  it('search.query: query_string, DSL with aggs, gte totals, partial shard failures', async () => {
    const q = (await runPlugin('search.query', { cluster: 'demo-search', index: 'demo-orders', query: 'status:paid AND city:shanghai', max_hits: 3 })).json;
    expect(q.status, JSON.stringify(q.error)).toBe('success');
    expect(q.data.total.relation).toBe('eq');
    expect(q.data.returned).toBe(3);
    expect(q.data.hits.every((h: any) => h.source.status === 'paid' && h.source.city === 'shanghai')).toBe(true);
    expect(q.meta.coverage).toMatchObject({ truncated: q.data.total.value > 3, limit: 3 });

    const dsl = (await runPlugin('search.query', { cluster: 'demo-search', index: 'demo-orders', dsl_file: join(dslDir, 'paid_by_city.json'), max_hits: 20 })).json;
    expect(dsl.status, JSON.stringify(dsl.error)).toBe('success');
    expect(dsl.data.returned).toBe(5);
    expect(dsl.data.aggregations.by_city.buckets.length).toBeGreaterThan(0);
    const amounts = dsl.data.hits.map((h: any) => h.source.amount);
    expect([...amounts].sort((a: number, b: number) => b - a)).toEqual(amounts);
    expect(OUTPUT_SCHEMAS['search.query'].safeParse(dsl.data).success).toBe(true);

    const gte = (await runPlugin('search.query', { cluster: 'demo-search', index: 'demo-orders', query: '*:*', max_hits: 1, track_total_hits: 1000 })).json;
    expect(gte.data.total).toEqual({ value: 1000, relation: 'gte' });

    const partial = (await runPlugin('search.query', { cluster: 'demo-search', index: 'demo-orders-all', dsl_file: join(dslDir, 'latest_across_archive.json') })).json;
    expect(partial.status).toBe('partial');
    expect(partial.data.shards.failed).toBe(1);
    expect(partial.data.shard_failures[0]).toMatchObject({ index: 'demo-orders-archive', type: 'query_shard_exception' });
    expect(partial.meta.coverage.complete).toBe(false);
  });

  it('search.query errors: script in DSL, query syntax, unknown index, unreachable cluster', async () => {
    const script = (await runPlugin('search.query', { cluster: 'demo-search', index: 'demo-orders', dsl_file: join(dslDir, 'script_score.json') })).json;
    expect(script.error.code).toBe('INVALID_ARGUMENT');
    expect(script.error.details.forbidden_key).toBe('script_score');
    const syntax = (await runPlugin('search.query', { cluster: 'demo-search', index: 'demo-orders', query: 'status:(paid' })).json;
    expect(syntax.error.code).toBe('INVALID_ARGUMENT');
    expect(syntax.error.message).toContain('Cannot parse');
    const nf = (await runPlugin('search.query', { cluster: 'demo-search', index: 'no-such-index', query: '*:*' })).json;
    expect(nf.error.code).toBe('NOT_FOUND');
    const down = await runPlugin('search.cluster.get', { cluster: 'demo-search' }, 'http://127.0.0.1:1');
    expect(down.code).toBe(0);
    expect(down.json.error.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('installs the packaged tgz through core, replaces the planned built-ins and answers through the engine', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'workctl-demo-search-'));
    const prevHome = process.env.WORKCTL_HOME;
    process.env.WORKCTL_HOME = join(dir, 'home');
    process.env.WORKCTL_IT_OS_PW = 'os-pw-should-not-leak-42';
    try {
      const installed = installPlugin(tgz, builtinRegistry());
      expect(installed.manifest.name).toBe('demo-search');
      const reg = builtinRegistry();
      expect(reg.get('search.query')?.status).toBe('planned');
      expect(loadPlugins(reg).loaded).toContain('demo-search@0.1.0');
      expect(reg.get('search.query')).toMatchObject({ status: 'available', origin: 'plugin:demo-search@0.1.0' });
      expect(reg.get('search.index.get')).toMatchObject({ status: 'available', origin: 'plugin:demo-search@0.1.0' });
      expect(reg.get('search.snapshot.list')?.status).toBe('planned');
      const configPath = join(dir, 'workctl.yaml');
      writeFileSync(
        configPath,
        [
          'current_profile: it',
          'profiles:',
          '  it:',
          '    env: sandbox',
          '    defaults: { opensearch: demo-search }',
          '    endpoints:',
          '      opensearch:',
          `        demo-search: { url: "${OS_URL}" }`,
          // security plugin is disabled in the demo, so the header is ignored by the server; checks the secret never leaks
          `        with-auth: { url: "${OS_URL}", username: workctl_ro, password_ref: "env:WORKCTL_IT_OS_PW" }`,
          '',
        ].join('\n'),
      );
      const env = await invoke(reg, 'search.index.get', { cluster: 'demo-search', index: 'demo-orders' }, { configPath, requestId: 'req-it-search' });
      expect(env.status, JSON.stringify(env.error)).toBe('success');
      expect(env.context).toMatchObject({ request_id: 'req-it-search', adapter: 'opensearch-http', operation: 'read', env: 'sandbox' });
      expect((env.data as any).docs.count).toBe(3000);
      const q = await invoke(reg, 'search.query', { cluster: 'demo-search', index: 'demo-orders', dsl_file: join(dslDir, 'script_score.json') }, { configPath });
      expect(q.error?.code).toBe('INVALID_ARGUMENT');
      const missing = await invoke(reg, 'search.query', { cluster: 'demo-search', index: 'no-such-index', query: '*:*' }, { configPath });
      expect(missing.error?.code).toBe('NOT_FOUND');
      const planned = await invoke(reg, 'search.snapshot.list', { cluster: 'demo-search', repository: 'r' }, { configPath });
      expect(planned.error?.code).toBe('CAPABILITY_PLANNED');
      const auth = await invoke(reg, 'search.cluster.get', { cluster: 'with-auth' }, { configPath });
      expect(auth.status, JSON.stringify(auth.error)).toBe('success');
      expect(JSON.stringify(auth)).not.toContain('os-pw-should-not-leak-42');
    } finally {
      process.env.WORKCTL_HOME = prevHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('packaged tgz has the manifest, entry, schemas, guide and skill at its root', () => {
    const list = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' }).split('\n');
    for (const f of ['workctl-plugin.json', 'dist/plugin.mjs', 'schemas/search.query.v1.json', 'schemas/search.index.get.v1.json', 'schemas/search.cluster.get.v1.json', 'guides/search.md', 'skills/search-operations/SKILL.md', 'README.md']) {
      expect(list).toContain(f);
    }
    expect(JSON.parse(readFileSync(join(pluginDir, 'dist', 'package', 'workctl-plugin.json'), 'utf8')).name).toBe('demo-search');
  });
});

describe('parseDsl error does not echo file content', () => {
  it('a non-JSON file (e.g. /etc/passwd) is rejected without quoting its content', () => {
    let msg = '';
    try {
      parseDsl('root:x:0:0:root:/root:/bin/bash\n');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('不是合法 JSON');
    expect(msg).not.toContain('root:x');
  });
});
