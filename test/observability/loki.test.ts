import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { invoke } from '../../src/core/engine';
import { loadConfig } from '../../src/core/config';
import { Registry } from '../../src/core/registry';
import { Ctx } from '../../src/core/runtime';
import { pagedQuery } from '../../src/domains/observability/loki';
import container from '../../src/domains/container';
import observability from '../../src/domains/observability';
import { parseLogLine } from '../../src/domains/observability/logs';
import {
  buildLogQuery,
  buildStatQueries,
  isoToNs,
  levelRegex,
  logqlString,
  normaliseLevel,
  nsToIso,
  parseLokiDuration,
  renderSelector,
} from '../../src/domains/observability/loki';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';

// ---------------------------------------------------------------------------
// pure: LogQL building, escaping, time conversion
// ---------------------------------------------------------------------------
describe('Loki query building (pure)', () => {
  it('renders the label mapping as a stream selector (template or map) and validates values', () => {
    expect(renderSelector('{service="$service", env="$env"}', 'demo-order', 'sandbox')).toBe('{service="demo-order", env="sandbox"}');
    expect(renderSelector({ app: '$service', namespace: '$env' }, 'demo-order', 'prod')).toBe('{app="demo-order", namespace="prod"}');
    expect(renderSelector(undefined, 'demo-order', null)).toBe('{service="demo-order"}');
    expect(() => renderSelector('{service="$service", env="$env"}', 'demo-order', null)).toThrow(/\$env/);
    expect(() => renderSelector('{service="$service"}', 'demo"} or {x="', 'sandbox')).toThrow(/不允许/);
    expect(() => renderSelector('service=$service', 'demo-order', null)).toThrow(/流选择器/);
    expect(() => renderSelector({ 'bad-label': '$service' }, 'demo-order', null)).toThrow(/标签名/);
  });

  it('escapes line-filter strings as Go string literals', () => {
    expect(logqlString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(logqlString('line1\nline2\ttab')).toBe('"line1\\nline2\\ttab"');
    expect(logqlString('back`tick {x="y"}')).toBe('"back`tick {x=\\"y\\"}"');
    const q = buildLogQuery('{service="s"}', { contains: 'say "hi"', traceId: 'ab'.repeat(16), includeSpans: true });
    expect(q).toBe(`{service="s"} |= "${'ab'.repeat(16)}" |= "say \\"hi\\""`);
  });

  it('adds one json stage for --level and the span exclusion; level regex follows the shared ranking', () => {
    const q = buildLogQuery('{service="s"}', { minLevel: 'error', includeSpans: false });
    expect(q).toBe('{service="s"} | json workctl_level="level", workctl_kind="kind" | workctl_level=~"(?i)(error|err|fatal|critical|panic|50|60)" | workctl_kind!="span"');
    expect(buildLogQuery('{service="s"}', { includeSpans: true })).toBe('{service="s"}');
    const warn = levelRegex('warn');
    expect(warn).toContain('warning');
    expect(warn).toContain('|40|');
    expect(warn).not.toMatch(/\binfo\b|\|30\|/);
    const stats = buildStatQueries('{service="s"}', { includeSpans: false }, 900);
    expect(stats.scanned).toBe('sum by (container, container_id) (count_over_time({service="s"}[900s]))');
    expect(stats.matched).toContain('| drop __error__, __error_details__[900s]');
    expect(stats.unparsed).toContain('__error__="JSONParserErr"');
    expect(normaliseLevel('50')).toBe('error');
    expect(normaliseLevel('WARN')).toBe('warn');
    expect(normaliseLevel(undefined)).toBe('unknown');
  });

  it('converts between ISO and nanoseconds; Docker-style fixed 9-digit fraction', () => {
    expect(isoToNs('2026-10-17T00:00:01.250Z')).toBe(1792195201250000000n);
    expect(nsToIso('1792195201250000000')).toBe('2026-10-17T00:00:01.250000000Z');
    expect(nsToIso(1792195201000000007n)).toBe('2026-10-17T00:00:01.000000007Z');
    expect(parseLokiDuration('72h')).toBe(259_200_000);
    expect(parseLokiDuration('1h30m')).toBe(5_400_000);
    expect(parseLokiDuration('1w')).toBe(604_800_000);
    expect(parseLokiDuration('0s')).toBe(0);
    expect(parseLokiDuration('abc')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fake Loki: a tiny evaluator for exactly the LogQL shapes workctl sends
// ---------------------------------------------------------------------------
interface FakeLine {
  ns: bigint;
  line: string;
  labels: Record<string, string>;
}

function parseSelector(q: string): Record<string, string> {
  const m = /^\{([^}]*)\}/.exec(q.trim());
  const out: Record<string, string> = {};
  for (const p of (m?.[1] ?? '').matchAll(/(\w+)="([^"]*)"/g)) out[p[1]] = p[2];
  return out;
}

function lineFilters(q: string): string[] {
  return [...q.matchAll(/\|= ("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1]) as string);
}

function json(line: string): Record<string, unknown> | null {
  try {
    const o = JSON.parse(line);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

function evaluate(lines: FakeLine[], q: string): FakeLine[] {
  const sel = parseSelector(q);
  const filters = lineFilters(q);
  const lvl = /workctl_level=~"\(\?i\)\(([^)]*)\)"/.exec(q)?.[1]?.split('|');
  return lines.filter((l) => {
    if (!Object.entries(sel).every(([k, v]) => l.labels[k] === v)) return false;
    if (!filters.every((f) => l.line.includes(f))) return false;
    const o = json(l.line);
    if (q.includes('workctl_kind!="span"') && o?.kind === 'span') return false;
    if (q.includes('workctl_kind="span"') && o?.kind !== 'span') return false;
    if (q.includes('__error__="JSONParserErr"') && o) return false;
    if (lvl && !(o && lvl.includes(String(o.level).toLowerCase()))) return false;
    return true;
  });
}

interface FakeLoki {
  url: string;
  requests: { path: string; params: URLSearchParams; headers: IncomingMessage['headers'] }[];
  lines: FakeLine[];
  close(): Promise<void>;
}

async function startFakeLoki(lines: FakeLine[]): Promise<FakeLoki> {
  const requests: FakeLoki['requests'] = [];
  const send = (res: ServerResponse, status: number, body: unknown, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    requests.push({ path: u.pathname, params: u.searchParams, headers: req.headers });
    const tenant = req.headers['x-scope-orgid'];
    if (tenant === 'forbidden') return send(res, 403, 'forbidden', 'text/plain');
    if (tenant === 'needs-auth' && !req.headers.authorization) return send(res, 401, 'no credentials', 'text/plain');
    switch (u.pathname) {
      case '/loki/api/v1/status/buildinfo':
        return send(res, 200, { version: '3.5.5', revision: 'fake' });
      case '/ready':
        return send(res, 200, 'ready\n', 'text/plain');
      case '/config':
        return send(res, 200, YAML.stringify({ limits_config: { retention_period: '72h', max_query_lookback: '0s' } }), 'text/plain; charset=utf-8');
      case '/loki/api/v1/query_range': {
        const q = u.searchParams.get('query') ?? '';
        if (q.includes('BADQUERY')) return send(res, 400, 'parse error at line 1, col 20: syntax error: unexpected IDENTIFIER', 'text/plain');
        const start = BigInt(u.searchParams.get('start')!);
        const end = BigInt(u.searchParams.get('end')!);
        const limit = Number(u.searchParams.get('limit'));
        const dir = u.searchParams.get('direction');
        let hits = evaluate(lines, q).filter((l) => l.ns >= start && l.ns < end);
        hits.sort((a, b) => (a.ns < b.ns ? -1 : a.ns > b.ns ? 1 : 0));
        if (dir === 'backward') hits.reverse();
        hits = hits.slice(0, limit);
        const streams = new Map<string, { stream: Record<string, string>; values: [string, string][] }>();
        for (const h of hits) {
          const k = JSON.stringify(h.labels);
          if (!streams.has(k)) streams.set(k, { stream: h.labels, values: [] });
          streams.get(k)!.values.push([h.ns.toString(), h.line]);
        }
        return send(res, 200, { status: 'success', data: { resultType: 'streams', result: [...streams.values()] } });
      }
      case '/loki/api/v1/query': {
        const q = u.searchParams.get('query') ?? '';
        const time = BigInt(u.searchParams.get('time')!);
        const range = BigInt(/\[(\d+)s\]\)\)$/.exec(q)?.[1] ?? '0') * 1_000_000_000n;
        const inner = /count_over_time\((.*)\[\d+s\]\)\)$/.exec(q)?.[1] ?? '';
        const hits = evaluate(lines, inner).filter((l) => l.ns > time - range && l.ns <= time);
        const by = /^sum by \(([^)]*)\)/.exec(q)?.[1]?.split(',').map((s) => s.trim()) ?? [];
        const groups = new Map<string, { metric: Record<string, string>; n: number }>();
        for (const h of hits) {
          const o = json(h.line);
          const metric: Record<string, string> = {};
          for (const k of by) {
            const v = k === 'workctl_level' ? (o?.level === undefined ? undefined : String(o.level)) : h.labels[k];
            if (v !== undefined) metric[k] = v;
          }
          const key = JSON.stringify(metric);
          const g = groups.get(key) ?? { metric, n: 0 };
          g.n++;
          groups.set(key, g);
        }
        const result = [...groups.values()].map((g) => ({ metric: g.metric, value: [Number(time / 1_000_000n) / 1000, String(g.n)] }));
        return send(res, 200, { status: 'success', data: { resultType: 'vector', result } });
      }
      case '/loki/api/v1/series': {
        const sel = parseSelector(u.searchParams.get('match[]') ?? '');
        const seen = new Map<string, Record<string, string>>();
        for (const l of lines) if (Object.entries(sel).every(([k, v]) => l.labels[k] === v)) seen.set(JSON.stringify(l.labels), l.labels);
        return send(res, 200, { status: 'success', data: [...seen.values()] });
      }
      default:
        return send(res, 404, '404 page not found', 'text/plain');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, requests, lines, close: () => new Promise((r) => server.close(() => r())) };
}

function writeConfig(dir: string, url: string, extra: { defaultsLogs?: string; bindingAttrs?: string; endpointExtra?: Record<string, unknown> } = {}): string {
  writeFileSync(
    join(dir, 'bindings.yaml'),
    `schema_version: "1.0"
resources:
  - id: demo-order
    type: service
    env: sandbox
    attributes: { container_label: "workctl.service=demo-order"${extra.bindingAttrs ? `, ${extra.bindingAttrs}` : ''} }
relations: []
`,
  );
  const cfg = {
    schema_version: '1.0',
    current_profile: 't',
    profiles: {
      t: {
        env: 'sandbox',
        resources_file: './bindings.yaml',
        state_dir: './state',
        defaults: extra.defaultsLogs ? { logs: extra.defaultsLogs } : {},
        endpoints: {
          // unreachable docker socket: proves the Loki path never touches Docker
          docker: { local: { socket: join(dir, 'no-docker.sock') } },
          loki: { l: { url, labels: '{service="$service", env="$env"}', push_interval: '1s', ...(extra.endpointExtra ?? {}) } },
        },
      },
    },
  };
  const p = join(dir, `workctl-${Math.random().toString(36).slice(2)}.yaml`);
  writeFileSync(p, YAML.stringify(cfg));
  return p;
}

describe('log query / trace get against a fake Loki', () => {
  const TRACE = 'cd'.repeat(16);
  const now = Date.now();
  const ns = (agoMs: number, extra = 0) => BigInt(now - agoMs) * 1_000_000n + BigInt(extra);
  const iso = (agoMs: number) => new Date(now - agoMs).toISOString();
  const order = { service: 'demo-order', env: 'sandbox', container: 'demo-order', container_id: 'f'.repeat(64) };
  const span = (id: string, parent: string | null, name: string, ago: number, d: number) =>
    JSON.stringify({ ts: iso(ago), level: 'debug', service: 'demo-order', msg: 'span', kind: 'span', name, trace_id: TRACE, span_id: id, parent_span_id: parent, start: iso(ago), duration_ms: d, status: 'ok', attributes: {} });
  const lines: FakeLine[] = [
    { ns: ns(60_000), labels: { ...order, stream: 'stdout' }, line: JSON.stringify({ level: 'info', msg: 'service started' }) },
    { ns: ns(5_000), labels: { ...order, stream: 'stdout' }, line: span('s2', 's1', 'mysql.query', 5000, 120) },
    { ns: ns(4_900), labels: { ...order, stream: 'stdout' }, line: JSON.stringify({ level: 'error', msg: 'mysql query timeout', trace_id: TRACE, span_id: 's2' }) },
    { ns: ns(4_800), labels: { ...order, stream: 'stdout' }, line: span('s1', null, 'http.request', 5001, 130) },
    { ns: ns(4_700), labels: { ...order, stream: 'stderr' }, line: 'node: warning raw line "quoted"' },
    { ns: ns(4_600), labels: { ...order, stream: 'stdout' }, line: JSON.stringify({ level: 50, msg: 'pino error', trace_id: TRACE }) },
    { ns: ns(4_500), labels: { ...order, stream: 'stdout' }, line: JSON.stringify({ level: 'info', msg: 'request completed', trace_id: TRACE, span_id: 's1', status: 504 }) },
    // older container of the same service (recreated): Loki still has it
    { ns: ns(30 * 60_000), labels: { ...order, container_id: 'e'.repeat(64), stream: 'stdout' }, line: JSON.stringify({ level: 'info', msg: 'old container' }) },
    { ns: ns(10_000), labels: { service: 'other', env: 'sandbox', container: 'other', stream: 'stdout' }, line: JSON.stringify({ level: 'error', msg: 'not mine' }) },
  ];
  let fake: FakeLoki;
  let dir: string;
  let cfg: string;
  const r = new Registry();
  r.addDomain(container);
  r.addDomain(observability);

  beforeAll(async () => {
    fake = await startFakeLoki(lines);
    dir = mkdtempSync(join(tmpdir(), 'workctl-loki-'));
    cfg = writeConfig(dir, fake.url, { defaultsLogs: 'loki' });
  });
  afterAll(async () => fake.close());

  const lastQueryRange = () => [...fake.requests].reverse().find((q) => q.path === '/loki/api/v1/query_range')!;

  it('returns the Docker entry shape newest-first, with window stats from count_over_time', async () => {
    const env = await invoke(r, 'observability.log.query', { service: 'demo-order', window: '15m' }, { configPath: cfg });
    expect(env.status).toBe('success');
    expect(env.meta.warnings).toEqual([]);
    const d = env.data as any;
    expect(d.entries.map((e: any) => e.msg ?? e.raw)).toEqual(['request completed', 'pino error', 'node: warning raw line "quoted"', 'mysql query timeout', 'service started']);
    // same parser as the Docker path: `<ts> <line>` → entry
    const raw = d.entries[2];
    expect(raw).toEqual(parseLogLine(`${nsToIso(ns(4_700))} node: warning raw line "quoted"`, 'demo-order', 'stderr'));
    expect(raw.ts).toMatch(/\.\d{9}Z$/);
    expect(d.entries[1].level).toBe('error'); // pino numeric level
    expect(d.stats).toEqual({ lines_scanned: 7, matched: 5, returned: 5, unparsed_lines: 1, spans_skipped: 2, unparsed_excluded_by_level: 0, by_level: { info: 2, error: 2, unknown: 1 } });
    expect(d.matched_by).toContain('{service="demo-order", env="sandbox"}');
    expect(d.containers).toHaveLength(1);
    expect(d.containers[0]).toMatchObject({ name: 'demo-order', id: 'ffffffffffff', lines_scanned: 7, matched: 5, created_at: '', log_driver: null });
    const qr = lastQueryRange();
    expect(qr.params.get('direction')).toBe('backward');
    expect(qr.params.get('limit')).toBe('201');
    expect(BigInt(qr.params.get('end')!) - BigInt(qr.params.get('start')!)).toBe(900_000_000_000n);
    expect(env.meta.sources[0]).toMatchObject({ system: 'loki', adapter: 'loki-http-api', version: '3.5.5', relation: 'explicit' });
    expect(env.meta.coverage).toMatchObject({ complete: true, truncated: false, limit: 200 });
    expect(env.meta.coverage?.notes?.join('\n')).toMatch(/shipper/);
  });

  it('order=oldest queries forward and returns ascending; the older container appears as its own stream', async () => {
    const env = await invoke(r, 'observability.log.query', { service: 'demo-order', window: '1h', order: 'oldest', limit: 2 }, { configPath: cfg });
    const d = env.data as any;
    expect(lastQueryRange().params.get('direction')).toBe('forward');
    expect(d.entries.map((e: any) => e.msg)).toEqual(['old container', 'service started']);
    expect(d.containers.map((c: any) => c.id)).toEqual(['eeeeeeeeeeee', 'ffffffffffff']);
    expect(env.meta.coverage?.notes?.join('\n')).toMatch(/多个 container_id/);
  });

  it('marks truncation from the limit+1 probe and takes matched/by_level from the stats query', async () => {
    const env = await invoke(r, 'observability.log.query', { service: 'demo-order', level: 'error', limit: 1 }, { configPath: cfg });
    expect(env.status).toBe('success');
    const d = env.data as any;
    expect(d.entries.map((e: any) => e.msg)).toEqual(['pino error']);
    expect(lastQueryRange().params.get('query')).toContain('workctl_level=~"(?i)(error|err|fatal|critical|panic|50|60)"');
    expect(d.stats).toMatchObject({ matched: 2, returned: 1, unparsed_excluded_by_level: 1, by_level: { error: 2 } });
    expect(env.meta.coverage).toMatchObject({ complete: false, truncated: true, limit: 1 });
    expect(env.meta.coverage?.notes).toContain('匹配 2 条，只返回 1 条（--limit）');
  });

  it('--trace-id / --contains become escaped line filters; --include-spans keeps span records', async () => {
    const env = await invoke(r, 'observability.log.query', { service: 'demo-order', trace_id: TRACE, contains: 'raw line "quoted"', include_spans: true }, { configPath: cfg });
    expect((env.data as any).entries).toHaveLength(0);
    expect(lastQueryRange().params.get('query')).toBe(`{service="demo-order", env="sandbox"} |= "${TRACE}" |= "raw line \\"quoted\\""`);
    const spans = await invoke(r, 'observability.log.query', { service: 'demo-order', trace_id: TRACE, include_spans: true }, { configPath: cfg });
    expect((spans.data as any).entries.filter((e: any) => e.kind === 'span')).toHaveLength(2);
    expect((spans.data as any).stats.spans_skipped).toBe(0);
  });

  it('trace get rebuilds the same span tree from Loki lines (derived)', async () => {
    const env = await invoke(r, 'observability.trace.get', { id: TRACE, service: 'demo-order', window: '1h' }, { configPath: cfg });
    expect(env.status).toBe('success');
    expect(env.meta.warnings).toEqual([]);
    const d = env.data as any;
    expect(d.span_count).toBe(2);
    expect(d.roots).toEqual(['s1']);
    expect(d.spans[1].logs[0].msg).toBe('mysql query timeout');
    expect(d.scanned).toEqual([{ service: 'demo-order', containers: ['demo-order'], lines_scanned: 8 }]);
    expect(env.meta.sources[0]).toMatchObject({ system: 'loki', relation: 'derived' });
    expect(lastQueryRange().params.get('query')).toBe(`{service="demo-order", env="sandbox"} |= "${TRACE}"`);
  });

  it('distinguishes an unknown stream (NOT_FOUND) from an empty window (success, empty)', async () => {
    const nf = await invoke(r, 'observability.log.query', { service: 'nosuch', window: '15m' }, { configPath: cfg });
    expect(nf.error?.code).toBe('NOT_FOUND');
    const other = await invoke(r, 'observability.log.query', { service: 'other', window: '1s' }, { configPath: cfg });
    expect(other.status).toBe('success');
    expect((other.data as any).entries).toEqual([]);
    expect(other.meta.coverage?.notes?.join('\n')).toMatch(/窗口内没有日志行/);
  });

  it('reports a window older than Loki retention (from /config) in coverage notes', async () => {
    const env = await invoke(r, 'observability.log.query', { service: 'demo-order', window: '4d' }, { configPath: cfg });
    expect(env.meta.coverage?.notes?.join('\n')).toMatch(/保留期.*3d/);
  });

  it('maps HTTP errors: 400 → INVALID_ARGUMENT, 401, 403, connection refused → UPSTREAM_UNAVAILABLE', async () => {
    const bad = writeConfig(dir, fake.url, { defaultsLogs: 'loki', endpointExtra: { labels: '{service="$service", x="BADQUERY"}' } });
    const e400 = await invoke(r, 'observability.log.query', { service: 'demo-order' }, { configPath: bad });
    expect(e400.error?.code).toBe('INVALID_ARGUMENT');
    expect(e400.error?.message).toMatch(/parse error/);
    const e401 = await invoke(r, 'observability.log.query', { service: 'demo-order' }, { configPath: writeConfig(dir, fake.url, { defaultsLogs: 'loki', endpointExtra: { tenant: 'needs-auth' } }) });
    expect(e401.error?.code).toBe('UNAUTHENTICATED');
    const e403 = await invoke(r, 'observability.log.query', { service: 'demo-order' }, { configPath: writeConfig(dir, fake.url, { defaultsLogs: 'loki', endpointExtra: { tenant: 'forbidden' } }) });
    expect(e403.error?.code).toBe('PERMISSION_DENIED');
    process.env.WORKCTL_TEST_LOKI_PW = 'pw';
    const authed = await invoke(r, 'observability.log.query', { service: 'demo-order' }, {
      configPath: writeConfig(dir, fake.url, { defaultsLogs: 'loki', endpointExtra: { tenant: 'needs-auth', username: 'u', password_ref: 'env:WORKCTL_TEST_LOKI_PW' } }),
    });
    expect(authed.status).toBe('success');
    expect(lastQueryRange().headers.authorization).toBe(`Basic ${Buffer.from('u:pw').toString('base64')}`);
    expect(lastQueryRange().headers['x-scope-orgid']).toBe('needs-auth');
    const down = await invoke(r, 'observability.log.query', { service: 'demo-order' }, { configPath: writeConfig(dir, 'http://127.0.0.1:9', { defaultsLogs: 'loki' }) });
    expect(down.error?.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(down.error?.retryable).toBe(true);
  });

  it('provider selection: binding attribute log_provider overrides profile defaults; docker stays the default', async () => {
    // profile default docker (unset) but the binding says loki → Loki is used, Docker never contacted
    const viaBinding = writeConfig(dir, fake.url, { bindingAttrs: 'log_provider: loki' });
    const env = await invoke(r, 'observability.log.query', { service: 'demo-order' }, { configPath: viaBinding });
    expect(env.status).toBe('success');
    expect(env.meta.coverage?.notes?.[0]).toMatch(/attributes\.log_provider=loki/);
    // no provider configured → Docker path (socket missing → upstream error, not Loki)
    const dockerDefault = await invoke(r, 'observability.log.query', { service: 'demo-order' }, { configPath: writeConfig(dir, fake.url) });
    expect(dockerDefault.error?.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(dockerDefault.error?.message).not.toMatch(/Loki/);
    const invalid = await invoke(r, 'observability.log.query', { service: 'demo-order' }, { configPath: writeConfig(dir, fake.url, { defaultsLogs: 'elastic' }) });
    expect(invalid.error?.code).toBe('NOT_CONFIGURED');
  });

  it('auth status probe: buildinfo version and /ready', async () => {
    const probe = r.probes.get('loki')!;
    const loaded = loadConfig(cfg);
    const ctx = new Ctx({ registry: r, loaded, profileName: 't', requestId: 't', timeoutMs: 5000 });
    expect(await probe(ctx, 'l')).toMatchObject({ ok: true, version: '3.5.5', detail: '/ready: ready' });
  });
});

describe('Loki pagination (review regression)', () => {
  // in-memory Loki: one stream, query_range semantics (start inclusive, end exclusive, limit, direction)
  const fakeLoki = (nss: bigint[]) => {
    const calls: { start: bigint; end: bigint; limit: number }[] = [];
    const client = {
      async queryRange(_q: string, start: bigint, end: bigint, limit: number, direction: 'backward' | 'forward') {
        calls.push({ start, end, limit });
        // stable line content per entry (index in the fixture), so re-returned lines are true duplicates
        const hits = nss
          .map((n, id) => ({ n, id }))
          .filter(({ n }) => n >= start && n < end)
          .sort((a, b) => (a.n === b.n ? a.id - b.id : (a.n < b.n) === (direction === 'forward') ? -1 : 1))
          .slice(0, limit);
        return [{ stream: { container: 'c', stream: 'stdout' }, values: hits.map(({ n, id }) => [n.toString(), `{"level":"info","msg":"m${id}"}`] as [string, string]) }];
      },
    };
    return { client: client as unknown as Parameters<typeof pagedQuery>[0], calls };
  };

  it('a short follow-up page is not swallowed by the re-returned boundary line (no false "same timestamp" stop)', async () => {
    const base = 1_700_000_000_000_000_000n;
    const nss = Array.from({ length: 10 }, (_, i) => base + BigInt(i + 1) * 1_000_000n);
    const { client } = fakeLoki(nss);
    // the client-side filter drops one line of the first page (entry 8)
    const r = await pagedQuery(client, '{x="y"}', { startNs: nss[0], endNs: nss[9] + 1n }, 'backward', 5, (e) => e.msg !== 'm8');
    expect(r.matched).toHaveLength(5);
    expect(r.stoppedAtSameTimestamp).toBe(false);
    expect(r.matched.map((e) => e.ts)).toEqual([...r.matched.map((e) => e.ts)].sort().reverse());
  });

  it('stops (bounded pages) when more lines share one timestamp than a page can hold', async () => {
    const same = Array.from({ length: 30 }, () => 1_700_000_000_000_000_000n);
    const { client, calls } = fakeLoki(same);
    const r = await pagedQuery(client, '{x="y"}', { startNs: 0n, endNs: same[0] + 1n }, 'backward', 100, () => true, { pageSize: 10, maxPages: 5 });
    expect(r.stoppedAtSameTimestamp).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(5);
  });
});
