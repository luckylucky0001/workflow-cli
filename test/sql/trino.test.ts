/** Trino engine of sql query submit/get/cancel: fake coordinator (unit) + demo-trino (WORKCTL_IT=1). */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config';
import { invoke } from '../../src/core/engine';
import { Ctx } from '../../src/core/runtime';
import { Registry } from '../../src/core/registry';
import sql, { checkReadOnlySql } from '../../src/domains/sql';
import { classifyTrinoError, parseTrinoDataSize, parseTrinoDuration, recordKeys } from '../../src/domains/sql/trino';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';
const r = new Registry();
r.addDomain(sql);

// ---------------------------------------------------------------------------
// guard
// ---------------------------------------------------------------------------

describe('read-only SQL guard (trino)', () => {
  it.each([
    'SELECT * FROM hive.default.orders',
    'SELECT * FROM iceberg.sales.orders o JOIN delta.dim.customer c ON o.cust = c.id',
    "SELECT replace(comment, 'a', 'b') AS c FROM tpch.tiny.orders",
    'SELECT * FROM TABLE(sequence(start => 1, stop => 3))',
    'WITH a AS (SELECT 1 AS x) SELECT x FROM a;',
    "SELECT 'CALL system.runtime.kill_query' AS s",
  ])('accepts %s', (q) => {
    expect(checkReadOnlySql(q, 'trino').ok).toBe(true);
  });

  it.each([
    ["EXECUTE IMMEDIATE 'SELECT 1'", /首个关键字为 EXECUTE/],
    ['PREPARE p FROM SELECT 1', /首个关键字为 PREPARE/],
    ['SET SESSION query_max_run_time = \'1h\'', /首个关键字为 SET/],
    ['RESET SESSION query_max_run_time', /首个关键字为 RESET/],
    ["CALL system.runtime.kill_query(query_id => 'x')", /首个关键字为 CALL/],
    ['CREATE TABLE memory.default.t AS SELECT 1 AS x', /首个关键字为 CREATE/],
    ['INSERT INTO memory.default.t SELECT 1', /首个关键字为 INSERT/],
    ['START TRANSACTION', /首个关键字为 START/],
    ['EXPLAIN ANALYZE SELECT 1', /首个关键字为 EXPLAIN/],
    ['SELECT 1; SELECT 2', /单条/],
    ['WITH FUNCTION meaning() RETURNS bigint RETURN 42 SELECT meaning()', /FUNCTION/],
    ["SELECT * FROM TABLE(pg.system.query(query => 'DELETE FROM accounts'))", /表函数 pg\.system\.query/],
    ["SELECT * FROM TABLE ( es.system.raw_query(schema => 'x', index => 'y', query => '{}'))", /raw_query/],
  ])('rejects %s', (q, re) => {
    const g = checkReadOnlySql(q, 'trino');
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toMatch(re);
  });

  it('keeps the spark guard unchanged (hive.* is a file source there)', () => {
    expect(checkReadOnlySql('SELECT * FROM hive.default.orders').ok).toBe(false);
    expect(checkReadOnlySql("SELECT replace(a, 'x', 'y') FROM v").ok).toBe(false);
  });
});

describe('trino helpers', () => {
  it('maps error classes', () => {
    expect(classifyTrinoError({ errorName: 'SYNTAX_ERROR', errorType: 'USER_ERROR' })).toBe('INVALID_ARGUMENT');
    expect(classifyTrinoError({ errorName: 'COLUMN_NOT_FOUND', errorType: 'USER_ERROR' })).toBe('INVALID_ARGUMENT');
    expect(classifyTrinoError({ errorName: 'TABLE_NOT_FOUND', errorType: 'USER_ERROR' })).toBe('NOT_FOUND');
    expect(classifyTrinoError({ errorName: 'PERMISSION_DENIED', errorType: 'USER_ERROR' })).toBe('PERMISSION_DENIED');
    expect(classifyTrinoError({ errorName: 'EXCEEDED_GLOBAL_MEMORY_LIMIT', errorType: 'INSUFFICIENT_RESOURCES' })).toBe('UPSTREAM_UNAVAILABLE');
    expect(classifyTrinoError({ errorName: 'GENERIC_INTERNAL_ERROR', errorType: 'INTERNAL_ERROR' })).toBe('UPSTREAM_UNAVAILABLE');
    expect(classifyTrinoError({ errorName: 'EXCEEDED_TIME_LIMIT', errorType: 'INSUFFICIENT_RESOURCES' })).toBe('TIMEOUT');
  });
  it('parses airlift durations / data sizes and disambiguates duplicate columns', () => {
    expect(parseTrinoDuration('5.89s')).toBe(5890);
    expect(parseTrinoDuration('2.52ms')).toBe(2.52);
    expect(parseTrinoDuration('1.00m')).toBe(60_000);
    expect(parseTrinoDataSize('8040B')).toBe(8040);
    expect(parseTrinoDataSize('1.5kB')).toBe(1536);
    expect(parseTrinoDataSize('nope')).toBeNull();
    expect(recordKeys(['x', 'y', 'x'])).toEqual(['x', 'y', 'x#2']);
  });
});

// ---------------------------------------------------------------------------
// fake coordinator
// ---------------------------------------------------------------------------

interface FakeQuery {
  id: string;
  sql: string;
  token: number;
  cancelled: boolean;
  deleted: string[];
}

const stats = (state: string, extra: Record<string, unknown> = {}) => ({
  state,
  queued: state === 'QUEUED',
  scheduled: state !== 'QUEUED',
  nodes: 1,
  totalSplits: 4,
  queuedSplits: 0,
  runningSplits: 0,
  completedSplits: state === 'FINISHED' ? 4 : 1,
  cpuTimeMillis: 12,
  wallTimeMillis: 30,
  queuedTimeMillis: 2,
  elapsedTimeMillis: 40,
  processedRows: 30,
  processedBytes: 900,
  physicalInputBytes: 0,
  peakMemoryBytes: 2048,
  spilledBytes: 0,
  ...extra,
});

class FakeTrino {
  server!: Server;
  url = '';
  queries = new Map<string, FakeQuery>();
  requests: Array<{ method: string; path: string; headers: IncomingMessage['headers']; body: string }> = [];
  seq = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        this.requests.push({ method: req.method!, path: req.url!, headers: req.headers, body });
        const out = this.route(req.method!, req.url!, body);
        res.writeHead(out.status, { 'content-type': 'application/json' });
        res.end(out.body === undefined ? '' : JSON.stringify(out.body));
      });
    });
    await new Promise<void>((ok) => this.server.listen(0, '127.0.0.1', () => ok()));
    const a = this.server.address() as { port: number };
    this.url = `http://127.0.0.1:${a.port}`;
  }

  /** nextUri as Trino builds it from the Host header; uses a foreign host to prove workctl re-bases it. */
  next(q: FakeQuery, kind: 'queued' | 'executing'): string {
    return `http://trino-internal.invalid:8080/v1/statement/${kind}/${q.id}/yslug/${++q.token}`;
  }

  page(q: FakeQuery): { status: number; body?: unknown } {
    const s = q.sql;
    const base = { id: q.id, infoUri: `http://trino-internal.invalid:8080/ui/query.html?${q.id}` };
    const cols = [{ name: 'n', type: 'integer' }, { name: 'name', type: 'varchar' }, { name: 'n', type: 'integer' }];
    const t = q.token;
    if (q.cancelled) return { status: 410 };
    if (t === 1) return { status: 200, body: { ...base, nextUri: this.next(q, 'queued'), stats: stats('QUEUED') } };
    if (s.includes('syntax')) return { status: 200, body: { ...base, stats: stats('FAILED'), error: { message: "line 1:8: mismatched input 'FROM'", errorCode: 1, errorName: 'SYNTAX_ERROR', errorType: 'USER_ERROR', errorLocation: { lineNumber: 1, columnNumber: 8 } } } };
    if (s.includes('denied')) return { status: 200, body: { ...base, stats: stats('FAILED'), error: { message: 'Access Denied: Cannot select from table secret', errorCode: 4, errorName: 'PERMISSION_DENIED', errorType: 'USER_ERROR' } } };
    if (s.includes('resources')) {
      if (t === 2) return { status: 200, body: { ...base, nextUri: this.next(q, 'executing'), columns: cols, stats: stats('RUNNING') } };
      return { status: 200, body: { ...base, columns: cols, stats: stats('FAILED'), error: { message: 'Query exceeded per-node memory limit', errorCode: 131079, errorName: 'EXCEEDED_LOCAL_MEMORY_LIMIT', errorType: 'INSUFFICIENT_RESOURCES' } } };
    }
    if (s.includes('slow')) return { status: 200, body: { ...base, nextUri: this.next(q, 'executing'), columns: cols, stats: stats('RUNNING') } };
    if (s.includes('gone')) {
      if (t === 2) return { status: 200, body: { ...base, nextUri: this.next(q, 'executing'), stats: stats('RUNNING') } };
      return { status: 410 };
    }
    // paging: 30 rows over three data pages, then FINISHED without nextUri
    if (t === 2) return { status: 200, body: { ...base, nextUri: this.next(q, 'executing'), columns: cols, stats: stats('RUNNING') } };
    if (t >= 3 && t <= 5) {
      const data = Array.from({ length: 10 }, (_, i) => [(t - 3) * 10 + i, `row-${(t - 3) * 10 + i}`, -1]);
      return { status: 200, body: { ...base, nextUri: this.next(q, 'executing'), columns: cols, data, stats: stats(t === 5 ? 'FINISHING' : 'RUNNING') } };
    }
    return { status: 200, body: { ...base, columns: cols, stats: stats('FINISHED', { progressPercentage: 100 }) } };
  }

  route(method: string, path: string, body: string): { status: number; body?: unknown } {
    if (method === 'GET' && path === '/v1/info') return { status: 200, body: { nodeVersion: { version: '476-fake' }, environment: 'test', coordinator: true, starting: false, uptime: '1.00m' } };
    if (method === 'POST' && path === '/v1/statement') {
      const q: FakeQuery = { id: `20261017_000000_${String(++this.seq).padStart(5, '0')}_fake`, sql: body, token: 1, cancelled: false, deleted: [] };
      this.queries.set(q.id, q);
      return this.page(q);
    }
    const m = /^\/v1\/statement\/(queued|executing)\/([^/]+)\/[^/]+\/(\d+)$/.exec(path);
    if (m) {
      const q = this.queries.get(m[2]);
      if (!q) return { status: 404 };
      if (method === 'DELETE') {
        q.cancelled = true;
        q.deleted.push(path);
        return { status: 204 };
      }
      if (Number(m[3]) !== q.token) return { status: 410 };
      q.token = Number(m[3]);
      return this.page(q);
    }
    const qi = /^\/v1\/query\/([^/]+)$/.exec(path);
    if (qi) {
      const q = this.queries.get(decodeURIComponent(qi[1]));
      if (!q || q.sql.includes('gone')) return { status: 404 };
      if (method === 'DELETE') {
        q.cancelled = true;
        return { status: 204 };
      }
      const qs = { createTime: '2026-10-17T00:00:00.000Z', executionStartTime: '2026-10-17T00:00:00.100Z', endTime: q.cancelled ? '2026-10-17T00:00:02.000Z' : undefined, elapsedTime: '2.00s', queuedTime: '1.00ms', totalCpuTime: '1.50s', processedInputPositions: 1000, processedInputDataSize: '1kB', physicalInputDataSize: '0B', peakUserMemoryReservation: '2kB', spilledDataSize: '0B', completedDrivers: 2, totalDrivers: 4, progressPercentage: 50 };
      if (q.cancelled) return { status: 200, body: { queryId: q.id, state: 'FAILED', errorCode: { code: 3, name: 'USER_CANCELED', type: 'USER_ERROR' }, failureInfo: { type: 'io.trino.spi.TrinoException', message: 'Query was canceled' }, queryStats: qs } };
      return { status: 200, body: { queryId: q.id, state: 'RUNNING', queryStats: { ...qs, endTime: q.sql.includes('slow') ? undefined : qs.endTime ?? '2026-10-17T00:00:01.000Z' } } };
    }
    return { status: 404 };
  }
}

describe('sql query --engine trino against a fake coordinator', () => {
  const fake = new FakeTrino();
  let cfgPath = '';
  let dir = '';
  const call = (cap: string, inputs: Record<string, unknown>, timeoutMs = 20_000) => invoke(r, cap, inputs, { configPath: cfgPath, timeoutMs });
  const file = (name: string, text: string) => {
    const p = join(dir, name);
    writeFileSync(p, text);
    return p;
  };

  beforeAll(async () => {
    await fake.start();
    dir = mkdtempSync(join(tmpdir(), 'workctl-trino-'));
    mkdirSync(join(dir, 'secrets'));
    mkdirSync(join(dir, 'spark-queries'));
    writeFileSync(join(dir, 'secrets', 'trino'), 'fake-trino-password');
    cfgPath = join(dir, 'workctl.yaml');
    writeFileSync(
      cfgPath,
      `schema_version: "1.0"
current_profile: t
profiles:
  t:
    env: test
    allow_execute: true
    state_dir: ./state
    endpoints:
      spark:
        s:
          query_state_dir: ./spark-queries
          warehouse_root: ./warehouse
      trino:
        t1:
          url: ${fake.url}
          user: analyst
          password_ref: file:secrets/trino
          catalog: tpch
          schema: tiny
          poll_budget_ms: 3000
          submit_wait_ms: 1000
`,
    );
  });
  afterAll(() => fake.server.close());

  it('refuses a result directory inside a configured warehouse_root (would look like a partition)', async () => {
    const posts = fake.requests.filter((q) => q.method === 'POST').length;
    const sub = await call('sql.query.submit', { engine: 'trino', file: file('wh.sql', 'SELECT 1'), output: join(dir, 'warehouse', 'analytics', 'daily_orders', 'dt=2026-10-18') });
    expect(sub.error?.code).toBe('INVALID_ARGUMENT');
    expect(sub.error?.message).toContain('warehouse_root');
    expect(fake.requests.filter((q) => q.method === 'POST').length).toBe(posts);
  });

  it('submits, pages through nextUri and reports succeeded with preview, stats and a JSON-lines result', async () => {
    const sub = await call('sql.query.submit', { engine: 'trino', file: file('ok.sql', 'SELECT n, name, n FROM t;\n'), catalog: 'memory' });
    expect(sub.status).toBe('success');
    expect(sub.meta.warnings).toEqual([]);
    const d = sub.data as any;
    expect(d).toMatchObject({ engine: 'trino', state: 'submitted', pid: null, engine_query_id: expect.stringMatching(/_fake$/) });
    expect(sub.meta.sources[0]).toMatchObject({ system: 'trino', adapter: 'trino-http', version: '476-fake', method: expect.stringContaining('POST /v1/statement') });
    const post = fake.requests.find((q) => q.method === 'POST')!;
    expect(post.body).toBe('SELECT n, name, n FROM t'); // trailing ';' removed (Trino rejects it)
    expect(post.headers['x-trino-user']).toBe('analyst');
    expect(post.headers['x-trino-catalog']).toBe('memory'); // --catalog overrides the endpoint
    expect(post.headers['x-trino-schema']).toBe('tiny');
    expect(post.headers['x-trino-source']).toBe('workctl');
    expect(post.headers.authorization).toBe(`Basic ${Buffer.from('analyst:fake-trino-password').toString('base64')}`);
    // the foreign host in nextUri was re-based onto the configured coordinator
    expect(fake.requests.some((q) => q.path.startsWith('/v1/statement/'))).toBe(true);

    const got = await call('sql.query.get', { id: d.query_id });
    expect(got.status).toBe('success');
    expect(got.meta.warnings).toEqual([]);
    const v = got.data as any;
    expect(v).toMatchObject({ state: 'succeeded', engine_state: 'FINISHED', row_count: 30, preview_truncated: true, columns: ['n', 'name', 'n'], column_types: ['integer', 'varchar', 'integer'], result_format: 'json-lines', app_id: null, engine_version: '476-fake' });
    expect(v.preview).toHaveLength(20);
    expect(v.preview[0]).toEqual({ n: 0, name: 'row-0', 'n#2': -1 });
    expect(v.stats).toMatchObject({ elapsed_ms: 40, cpu_ms: 12, processed_rows: 30, peak_memory_bytes: 2048, source: 'statement' });
    expect(v.started_at).toBe('2026-10-17T00:00:00.100Z');
    const lines = readFileSync(join(v.result_location, 'part-00000.json'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(30);
    expect(got.meta.coverage).toMatchObject({ complete: false, truncated: true, limit: 20 });
    expect(got.meta.sources.map((s) => s.system)).toEqual(['workctl-state', 'trino']);

    // terminal state: get is served from the state file without contacting Trino
    const before = fake.requests.length;
    const again = await call('sql.query.get', { id: d.query_id, preview_rows: 5 });
    expect((again.data as any).preview).toHaveLength(5);
    expect(fake.requests.length).toBe(before);
    expect((await call('sql.query.cancel', { id: d.query_id })).error?.code).toBe('CONFLICT');
  });

  it('maps parse/analysis failures at submit: SYNTAX_ERROR → INVALID_ARGUMENT, PERMISSION_DENIED', async () => {
    const syn = await call('sql.query.submit', { engine: 'trino', file: file('syn.sql', 'SELECT syntax FROM') });
    expect(syn.error).toMatchObject({ code: 'INVALID_ARGUMENT', details: { error_name: 'SYNTAX_ERROR', error_type: 'USER_ERROR', line: 1, column: 8 } });
    // the failure is recorded: get reports failed with the Trino error
    const got = await call('sql.query.get', { id: (syn.error!.details as any).query_id });
    expect(got.meta.warnings).toEqual([]);
    expect(got.data).toMatchObject({ state: 'failed', engine_state: 'FAILED', error: { type: 'SYNTAX_ERROR', error_type: 'USER_ERROR', code: 'INVALID_ARGUMENT' } });
    const den = await call('sql.query.submit', { engine: 'trino', file: file('den.sql', 'SELECT denied FROM secret') });
    expect(den.error?.code).toBe('PERMISSION_DENIED');
  });

  it('reports a runtime failure as state=failed (business state) with the mapped code', async () => {
    const sub = await call('sql.query.submit', { engine: 'trino', file: file('res.sql', 'SELECT resources FROM big') });
    expect(sub.status).toBe('success');
    const got = await call('sql.query.get', { id: (sub.data as any).query_id });
    expect(got.status).toBe('success');
    expect(got.meta.warnings).toEqual([]);
    expect(got.data).toMatchObject({ state: 'failed', result_location: null, error: { type: 'EXCEEDED_LOCAL_MEMORY_LIMIT', error_type: 'INSUFFICIENT_RESOURCES', code: 'UPSTREAM_UNAVAILABLE' } });
  });

  it('cancels a running query with DELETE nextUri and confirms USER_CANCELED', async () => {
    const sub = await call('sql.query.submit', { engine: 'trino', file: file('slow.sql', 'SELECT slow FROM a CROSS JOIN b') });
    const id = (sub.data as any).query_id;
    const run = await call('sql.query.get', { id });
    expect(run.data).toMatchObject({ state: 'running', engine_state: 'RUNNING', finished_at: null, duration_ms: null, row_count: null, result_location: null });
    expect(run.meta.coverage?.notes?.join()).toMatch(/ABANDONED_QUERY/);
    const c = await call('sql.query.cancel', { id });
    expect(c.status).toBe('success');
    expect(c.meta.warnings).toEqual([]);
    expect(c.data).toMatchObject({ previous_state: 'running', state: 'cancelled', confirmed: true, engine_state: 'FAILED', signal: 'HTTP DELETE (204)' });
    const q = [...fake.queries.values()].find((x) => x.sql.includes('slow'))!;
    expect(q.deleted[0]).toMatch(/^\/v1\/statement\/executing\//);
    const after = await call('sql.query.get', { id });
    expect(after.data).toMatchObject({ state: 'cancelled', error: { type: 'USER_CANCELED' } });
    expect((after.data as any).error.code).toBeUndefined();
    expect((await call('sql.query.cancel', { id })).error?.code).toBe('CONFLICT');
  });

  it('reports lost when nextUri is gone and the coordinator no longer knows the query', async () => {
    const sub = await call('sql.query.submit', { engine: 'trino', file: file('gone.sql', 'SELECT gone FROM t') });
    const got = await call('sql.query.get', { id: (sub.data as any).query_id });
    expect(got.data).toMatchObject({ state: 'lost', state_basis: expect.stringContaining('/v1/query/{id}') });
  });

  it('reports lost for a state file that never got a Trino response', async () => {
    const id = 'q-20261017-dead00';
    const d = join(dir, 'state', 'sql', 'trino', 't1');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `${id}.json`), JSON.stringify({ query_id: id, engine: 'trino', endpoint: 't1', state: 'submitted', submitted_at: '2026-10-17T00:00:00Z', preview: [] }));
    const got = await call('sql.query.get', { id });
    expect(got.meta.warnings).toEqual([]);
    expect(got.data).toMatchObject({ state: 'lost', engine: 'trino', state_basis: expect.stringContaining('POST') });
  });

  it('rejects guarded statements before contacting Trino, and unknown ids', async () => {
    const before = fake.requests.length;
    const env = await call('sql.query.submit', { engine: 'trino', file: file('w.sql', "SELECT * FROM TABLE(system.query(query => 'DROP TABLE x'))") });
    expect(env.error?.code).toBe('INVALID_ARGUMENT');
    expect(fake.requests.length).toBe(before);
    expect((await call('sql.query.get', { id: 'q-20261017-000000' })).error?.code).toBe('NOT_FOUND');
    expect((await call('sql.query.get', { id: 'nope' })).error?.code).toBe('INVALID_ARGUMENT');
  });

  it('probe (auth status --probe) reads /v1/info without printing the password', async () => {
    const ctx = new Ctx({ registry: r, loaded: loadConfig(cfgPath), profileName: 't', requestId: 'req-probe', timeoutMs: 5000 });
    const res = await r.probes.get('trino')!(ctx, 't1');
    expect(res).toMatchObject({ ok: true, version: '476-fake', identity: expect.stringContaining('analyst') });
    expect(JSON.stringify(res)).not.toContain('fake-trino-password');
  });
});

// ---------------------------------------------------------------------------
// live: demo-trino (docker run trinodb/trino, port 18085)
// ---------------------------------------------------------------------------

describe.skipIf(process.env.WORKCTL_IT !== '1')('sql live (demo-trino)', () => {
  const call = (cap: string, inputs: Record<string, unknown>) => invoke(r, cap, inputs, { configPath: 'demo/environment/workctl.yaml', timeoutMs: 30_000 });
  const dir = mkdtempSync(join(tmpdir(), 'workctl-trino-it-'));
  const file = (name: string, text: string) => {
    const p = join(dir, name);
    writeFileSync(p, text);
    return p;
  };

  it('submit → get → succeeded with preview and stats (tpch.tiny)', async () => {
    const sub = await call('sql.query.submit', { engine: 'trino', file: file('ok.sql', 'SELECT orderstatus, count(*) AS orders FROM tpch.tiny.orders GROUP BY orderstatus ORDER BY orderstatus') });
    expect(sub.status).toBe('success');
    expect(sub.meta.warnings).toEqual([]);
    const id = (sub.data as any).query_id;
    let v: any = sub.data;
    for (let i = 0; i < 10 && !['succeeded', 'failed', 'cancelled', 'lost'].includes(v.state); i++) {
      const got = await call('sql.query.get', { id });
      expect(got.meta.warnings).toEqual([]);
      v = got.data;
    }
    expect(v).toMatchObject({ state: 'succeeded', engine_state: 'FINISHED', row_count: 3, columns: ['orderstatus', 'orders'] });
    expect(v.preview.map((p: any) => p.orderstatus)).toEqual(['F', 'O', 'P']);
    expect(v.stats.processed_rows).toBe(15000);
    expect(v.engine_version).toMatch(/^\d+/);
  }, 60_000);

  it('syntax error → INVALID_ARGUMENT; missing table → NOT_FOUND', async () => {
    const syn = await call('sql.query.submit', { engine: 'trino', file: file('syn.sql', 'SELECT orderkey FROM tpch.tiny.orders WHERE') });
    expect(syn.error).toMatchObject({ code: 'INVALID_ARGUMENT', details: { error_name: 'SYNTAX_ERROR' } });
    const nf = await call('sql.query.submit', { engine: 'trino', file: file('nf.sql', 'SELECT * FROM tpch.tiny.no_such_table') });
    expect(nf.error).toMatchObject({ code: 'NOT_FOUND', details: { error_name: 'TABLE_NOT_FOUND' } });
  }, 60_000);

  it('cancels a long cross join on tpch.sf1', async () => {
    const sub = await call('sql.query.submit', { engine: 'trino', file: file('long.sql', 'SELECT count(*) AS n FROM tpch.sf1.lineitem a CROSS JOIN tpch.sf1.orders b') });
    expect(sub.status).toBe('success');
    const id = (sub.data as any).query_id;
    const run = await call('sql.query.get', { id });
    expect((run.data as any).state).toBe('running');
    const c = await call('sql.query.cancel', { id });
    expect(c.meta.warnings).toEqual([]);
    expect(c.data).toMatchObject({ state: 'cancelled', confirmed: true, engine_state: 'FAILED' });
    const after = await call('sql.query.get', { id });
    expect(after.data).toMatchObject({ state: 'cancelled', error: { type: 'USER_CANCELED' } });
  }, 90_000);
});
