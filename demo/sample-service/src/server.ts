/**
 * demo-order: sample online service for the workctl demo environment.
 *
 * - GET  /healthz                 liveness + dependency client state
 * - GET  /orders/:id              cache-aside (Redis key demo:order:<id>) over `SELECT * FROM orders WHERE id=?`
 * - GET  /customers/:id/orders    cache-aside (demo:customer:<id>:recent) over a query on the
 *                                 un-indexed orders.customer_id column (full scan, intentionally slow)
 * - GET  /metrics                 Prometheus text exposition (hand-rolled, no client library)
 * - GET  /admin/cache-mode        current cache mode
 * - POST /admin/cache-mode        {mode: normal|bypass, ttl_seconds?} fault injection for the demo
 *
 * Logs: one JSON object per line on stdout. Request records (kind=access), span records
 * (kind=span, enough to rebuild a trace from logs) and error records (level=error).
 * All data is synthetic.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import Redis from 'ioredis';

const SERVICE = process.env.SERVICE_NAME ?? 'demo-order';
const VERSION = process.env.SERVICE_VERSION ?? '1.0.0';
const PORT = Number(process.env.PORT ?? 8080);
const DB_TIMEOUT_MS = Number(process.env.DB_QUERY_TIMEOUT_MS ?? 5000);
const REDIS_TIMEOUT_MS = Number(process.env.REDIS_COMMAND_TIMEOUT_MS ?? 300);

let cacheMode: 'normal' | 'bypass' = process.env.CACHE_MODE === 'bypass' ? 'bypass' : 'normal';
let cacheTtl = Number(process.env.CACHE_TTL_SECONDS ?? 300);
const startedAt = Date.now();

// ---------------------------------------------------------------------------
// logging & spans
// ---------------------------------------------------------------------------
type Level = 'debug' | 'info' | 'warn' | 'error';

function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level, service: SERVICE, msg, ...fields })}\n`);
}

const hex = (bytes: number): string => randomBytes(bytes).toString('hex');

interface TraceCtx {
  trace_id: string;
  span_id: string;
}

class Span {
  readonly span_id = hex(8);
  readonly start = Date.now();
  readonly t0 = process.hrtime.bigint();
  status: 'ok' | 'error' = 'ok';
  constructor(
    readonly name: string,
    readonly trace_id: string,
    readonly parent_span_id: string | null,
    readonly attributes: Record<string, unknown> = {},
  ) {}

  get ctx(): TraceCtx {
    return { trace_id: this.trace_id, span_id: this.span_id };
  }

  child(name: string, attributes: Record<string, unknown> = {}): Span {
    return new Span(name, this.trace_id, this.span_id, attributes);
  }

  /** Ends the span and writes its span record; returns the duration in ms. */
  end(extra: Record<string, unknown> = {}): number {
    const durationMs = Number(process.hrtime.bigint() - this.t0) / 1e6;
    Object.assign(this.attributes, extra);
    log(this.status === 'error' ? 'warn' : 'debug', 'span', {
      kind: 'span',
      name: this.name,
      trace_id: this.trace_id,
      span_id: this.span_id,
      parent_span_id: this.parent_span_id,
      start: new Date(this.start).toISOString(),
      duration_ms: round(durationMs),
      status: this.status,
      attributes: this.attributes,
    });
    return durationMs;
  }
}

const round = (n: number, d = 3): number => Math.round(n * 10 ** d) / 10 ** d;

// ---------------------------------------------------------------------------
// metrics (Prometheus text format, hand-rolled)
// ---------------------------------------------------------------------------
const esc = (v: string): string => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const labelStr = (labels: Record<string, string>): string => {
  const parts = Object.entries(labels).map(([k, v]) => `${k}="${esc(v)}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
};

class Counter {
  private readonly values = new Map<string, { labels: Record<string, string>; v: number }>();
  constructor(readonly name: string, readonly help: string) {}
  inc(labels: Record<string, string>, by = 1): void {
    const all = { service: SERVICE, ...labels };
    const k = labelStr(all);
    const cur = this.values.get(k);
    if (cur) cur.v += by;
    else this.values.set(k, { labels: all, v: by });
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, v } of this.values.values()) lines.push(`${this.name}${labelStr(labels)} ${v}`);
    return lines.join('\n');
  }
}

class Histogram {
  private readonly series = new Map<string, { labels: Record<string, string>; counts: number[]; sum: number; count: number }>();
  constructor(readonly name: string, readonly help: string, readonly buckets: number[]) {}
  observe(labels: Record<string, string>, value: number): void {
    const all = { service: SERVICE, ...labels };
    const k = labelStr(all);
    let s = this.series.get(k);
    if (!s) {
      s = { labels: all, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(k, s);
    }
    for (let i = 0; i < this.buckets.length; i++) if (value <= this.buckets[i]) s.counts[i]++;
    s.sum += value;
    s.count++;
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const s of this.series.values()) {
      this.buckets.forEach((b, i) => lines.push(`${this.name}_bucket${labelStr({ ...s.labels, le: String(b) })} ${s.counts[i]}`));
      lines.push(`${this.name}_bucket${labelStr({ ...s.labels, le: '+Inf' })} ${s.count}`);
      lines.push(`${this.name}_sum${labelStr(s.labels)} ${round(s.sum, 6)}`);
      lines.push(`${this.name}_count${labelStr(s.labels)} ${s.count}`);
    }
    return lines.join('\n');
  }
}

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const httpRequests = new Counter('http_requests_total', 'HTTP requests by route and status code');
const httpDuration = new Histogram('http_request_duration_seconds', 'HTTP request latency', LATENCY_BUCKETS);
const cacheRequests = new Counter('cache_requests_total', 'Cache lookups by result (hit|miss|bypass|error)');
const dbQueries = new Counter('db_queries_total', 'Database queries by logical query name and outcome');
const dbDuration = new Histogram('db_query_duration_seconds', 'Database query latency', LATENCY_BUCKETS);

function renderMetrics(): string {
  const mem = process.memoryUsage();
  const gauges = [
    '# HELP cache_mode_info Current cache mode of the service (1 = active mode)',
    '# TYPE cache_mode_info gauge',
    ...(['normal', 'bypass'] as const).map((m) => `cache_mode_info${labelStr({ service: SERVICE, mode: m })} ${cacheMode === m ? 1 : 0}`),
    '# HELP cache_ttl_seconds Configured cache TTL',
    '# TYPE cache_ttl_seconds gauge',
    `cache_ttl_seconds${labelStr({ service: SERVICE })} ${cacheTtl}`,
    '# HELP process_resident_memory_bytes Resident memory size in bytes',
    '# TYPE process_resident_memory_bytes gauge',
    `process_resident_memory_bytes${labelStr({ service: SERVICE })} ${mem.rss}`,
    '# HELP process_start_time_seconds Start time of the process since unix epoch in seconds',
    '# TYPE process_start_time_seconds gauge',
    `process_start_time_seconds${labelStr({ service: SERVICE })} ${Math.floor(startedAt / 1000)}`,
    '# HELP service_build_info Service build information',
    '# TYPE service_build_info gauge',
    `service_build_info${labelStr({ service: SERVICE, version: VERSION })} 1`,
  ];
  return [httpRequests, httpDuration, cacheRequests, dbQueries, dbDuration].map((m) => m.render()).concat(gauges).join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// dependencies
// ---------------------------------------------------------------------------
function mysqlPassword(): string | undefined {
  if (process.env.MYSQL_PASSWORD_FILE) {
    try {
      return readFileSync(process.env.MYSQL_PASSWORD_FILE, 'utf8').trim();
    } catch (e) {
      log('error', 'cannot read MYSQL_PASSWORD_FILE', { err: (e as Error).message });
      return undefined;
    }
  }
  return process.env.MYSQL_PASSWORD;
}

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST ?? '127.0.0.1',
  port: Number(process.env.MYSQL_PORT ?? 3306),
  user: process.env.MYSQL_USER ?? 'demo_app',
  password: mysqlPassword(),
  database: process.env.MYSQL_DATABASE ?? 'demo',
  connectionLimit: Number(process.env.MYSQL_POOL_SIZE ?? 10),
  connectTimeout: 3000,
  decimalNumbers: true,
  dateStrings: true,
  waitForConnections: true,
  queueLimit: 200,
});

const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
  connectTimeout: 2000,
  commandTimeout: REDIS_TIMEOUT_MS,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  retryStrategy: (times) => Math.min(times * 200, 2000),
});
let lastRedisErrorLog = 0;
redis.on('error', (e: Error) => {
  // ioredis emits on every reconnect attempt; rate-limit the log line
  if (Date.now() - lastRedisErrorLog > 5000) {
    lastRedisErrorLog = Date.now();
    log('error', 'redis connection error', { err: e.message, dependency: 'redis' });
  }
});
redis.on('ready', () => log('info', 'redis ready', { dependency: 'redis' }));

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

async function cacheGet(parent: Span, key: string): Promise<string | null | undefined> {
  if (cacheMode === 'bypass') {
    cacheRequests.inc({ result: 'bypass' });
    return undefined;
  }
  const span = parent.child('redis.get', { 'db.system': 'redis', 'db.operation': 'GET', key });
  try {
    const v = await redis.get(key);
    cacheRequests.inc({ result: v === null ? 'miss' : 'hit' });
    span.end({ hit: v !== null });
    return v;
  } catch (e) {
    cacheRequests.inc({ result: 'error' });
    span.status = 'error';
    span.end({ error: (e as Error).message });
    log('error', 'redis get failed, falling back to database', { ...span.ctx, dependency: 'redis', key, err: (e as Error).message });
    return undefined;
  }
}

async function cacheSet(parent: Span, key: string, value: unknown): Promise<void> {
  if (cacheMode === 'bypass') return;
  const span = parent.child('redis.set', { 'db.system': 'redis', 'db.operation': 'SET', key, ttl_seconds: cacheTtl });
  try {
    await redis.set(key, JSON.stringify(value), 'EX', cacheTtl);
    span.end();
  } catch (e) {
    span.status = 'error';
    span.end({ error: (e as Error).message });
    log('error', 'redis set failed', { ...span.ctx, dependency: 'redis', key, err: (e as Error).message });
  }
}

async function dbQuery<T>(parent: Span, queryName: string, sql: string, params: unknown[]): Promise<T[]> {
  const span = parent.child('mysql.query', { 'db.system': 'mysql', 'db.name': 'demo', query: queryName, statement: sql });
  const t0 = process.hrtime.bigint();
  try {
    const [rows] = await pool.query({ sql, timeout: DB_TIMEOUT_MS }, params);
    const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
    dbQueries.inc({ query: queryName, outcome: 'ok' });
    dbDuration.observe({ query: queryName }, seconds);
    span.end({ rows: (rows as unknown[]).length });
    return rows as T[];
  } catch (e) {
    const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
    const err = e as Error & { code?: string };
    dbQueries.inc({ query: queryName, outcome: 'error' });
    dbDuration.observe({ query: queryName }, seconds);
    span.status = 'error';
    span.end({ error: err.message, error_code: err.code });
    const timeout = err.code === 'PROTOCOL_SEQUENCE_TIMEOUT' || /timeout/i.test(err.message);
    log('error', timeout ? 'mysql query timeout' : 'mysql query failed', {
      ...span.ctx,
      dependency: 'mysql',
      query: queryName,
      err: err.message,
      err_code: err.code,
      timeout_ms: DB_TIMEOUT_MS,
    });
    throw new HttpError(timeout ? 504 : 503, timeout ? 'database timeout' : 'database unavailable', err.code);
  }
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------
type Handler = (req: IncomingMessage, span: Span, params: string[]) => Promise<{ status: number; body: unknown; contentType?: string }>;

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, 'id must be a positive integer');
  return id;
}

const getOrder: Handler = async (_req, span, [rawId]) => {
  const id = parseId(rawId);
  const key = `demo:order:${id}`;
  const cached = await cacheGet(span, key);
  if (typeof cached === 'string') return { status: 200, body: { source: 'cache', order: JSON.parse(cached) } };
  const rows = await dbQuery<Record<string, unknown>>(span, 'order_by_id', 'SELECT * FROM orders WHERE id = ?', [id]);
  if (!rows.length) return { status: 404, body: { error: 'order not found', id } };
  await cacheSet(span, key, rows[0]);
  return { status: 200, body: { source: 'database', order: rows[0] } };
};

const getCustomerOrders: Handler = async (_req, span, [rawId]) => {
  const id = parseId(rawId);
  const key = `demo:customer:${id}:recent`;
  const cached = await cacheGet(span, key);
  if (typeof cached === 'string') return { status: 200, body: { source: 'cache', customer_id: id, orders: JSON.parse(cached) } };
  const rows = await dbQuery(
    span,
    'customer_recent_orders',
    'SELECT id, status, amount, created_at FROM orders WHERE customer_id = ? ORDER BY created_at DESC LIMIT 20',
    [id],
  );
  await cacheSet(span, key, rows);
  return { status: 200, body: { source: 'database', customer_id: id, orders: rows } };
};

async function readBody(req: IncomingMessage, max = 16 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new HttpError(413, 'body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const setCacheMode: Handler = async (req, span) => {
  let body: { mode?: string; ttl_seconds?: number };
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
  if (body.mode !== undefined && body.mode !== 'normal' && body.mode !== 'bypass') throw new HttpError(400, 'mode must be normal or bypass');
  if (body.ttl_seconds !== undefined && (!Number.isInteger(body.ttl_seconds) || body.ttl_seconds <= 0)) {
    throw new HttpError(400, 'ttl_seconds must be a positive integer');
  }
  const before = { mode: cacheMode, ttl_seconds: cacheTtl };
  if (body.mode) cacheMode = body.mode as 'normal' | 'bypass';
  if (body.ttl_seconds) cacheTtl = body.ttl_seconds;
  const after = { mode: cacheMode, ttl_seconds: cacheTtl };
  log('warn', 'cache mode changed', { ...span.ctx, before, after, reason: 'admin api (fault injection)' });
  return { status: 200, body: { before, after } };
};

const ROUTES: Array<{ method: string; re: RegExp; route: string; handler: Handler }> = [
  { method: 'GET', re: /^\/healthz$/, route: '/healthz', handler: async () => ({ status: 200, body: { status: 'ok', service: SERVICE, version: VERSION, cache_mode: cacheMode, redis: redis.status, uptime_s: Math.round((Date.now() - startedAt) / 1000) } }) },
  { method: 'GET', re: /^\/metrics$/, route: '/metrics', handler: async () => ({ status: 200, body: renderMetrics(), contentType: 'text/plain; version=0.0.4; charset=utf-8' }) },
  { method: 'GET', re: /^\/orders\/([^/]+)$/, route: '/orders/:id', handler: getOrder },
  { method: 'GET', re: /^\/customers\/([^/]+)\/orders$/, route: '/customers/:id/orders', handler: getCustomerOrders },
  { method: 'GET', re: /^\/admin\/cache-mode$/, route: '/admin/cache-mode', handler: async () => ({ status: 200, body: { mode: cacheMode, ttl_seconds: cacheTtl } }) },
  { method: 'POST', re: /^\/admin\/cache-mode$/, route: '/admin/cache-mode', handler: setCacheMode },
];

/** Untraced, unlogged routes (scrapes and probes would otherwise dominate the logs). */
const QUIET = new Set(['/metrics', '/healthz']);

function incomingTrace(req: IncomingMessage): { trace_id: string; parent: string | null } {
  const tp = String(req.headers.traceparent ?? '');
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(tp);
  return m ? { trace_id: m[1], parent: m[2] } : { trace_id: hex(16), parent: null };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://local');
  let match: RegExpExecArray | null = null;
  const r = ROUTES.find((x) => x.method === req.method && (match = x.re.exec(url.pathname)) !== null);
  const route = r?.route ?? 'unmatched';
  const quiet = QUIET.has(route);
  const { trace_id, parent } = incomingTrace(req);
  const span = new Span('http.request', trace_id, parent, { 'http.method': req.method, 'http.route': route, 'http.target': url.pathname });
  const t0 = process.hrtime.bigint();
  let status = 500;
  let payload: string;
  let contentType = 'application/json';
  try {
    if (!r) throw new HttpError(404, 'no such route');
    const out = await r.handler(req, span, (match as RegExpExecArray | null)?.slice(1) ?? []);
    status = out.status;
    payload = typeof out.body === 'string' ? out.body : JSON.stringify(out.body);
    if (out.contentType) contentType = out.contentType;
  } catch (e) {
    const he = e instanceof HttpError ? e : new HttpError(500, (e as Error).message);
    status = he.status;
    payload = JSON.stringify({ error: he.message, trace_id });
    if (!(e instanceof HttpError)) log('error', 'unhandled error', { ...span.ctx, err: (e as Error).stack });
  }
  const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
  if (route !== 'unmatched') {
    httpRequests.inc({ route, code: String(status) });
    httpDuration.observe({ route }, seconds);
  }
  res.writeHead(status, { 'content-type': contentType, 'x-trace-id': trace_id, traceparent: `00-${trace_id}-${span.span_id}-01` });
  res.end(payload);
  if (quiet) return;
  if (status >= 500) span.status = 'error';
  span.end({ 'http.status_code': status });
  log(status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', 'request completed', {
    kind: 'access',
    method: req.method,
    route,
    path: url.pathname,
    status,
    duration_ms: round(seconds * 1000),
    cache_mode: cacheMode,
    trace_id,
    span_id: span.span_id,
    parent_span_id: parent,
  });
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    log('error', 'request handler crashed', { err: (e as Error).stack });
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
server.keepAliveTimeout = 5000;

server.listen(PORT, () => {
  log('info', 'service started', { port: PORT, version: VERSION, cache_mode: cacheMode, cache_ttl_seconds: cacheTtl, node: process.version });
});

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  log('warn', 'shutting down', { signal });
  server.close();
  server.closeIdleConnections();
  const force = setTimeout(() => process.exit(0), 5000);
  force.unref();
  Promise.allSettled([pool.end(), redis.quit()]).finally(() => {
    log('info', 'shutdown complete', { signal });
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
