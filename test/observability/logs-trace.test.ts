import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { Registry } from '../../src/core/registry';
import container from '../../src/domains/container';
import observability from '../../src/domains/observability';
import { BoundedCollector, FrameDemuxer, LineSplitter, matches, MAX_LINE_CHARS, MAX_LOG_TEXT, parseLogLine, tsKey, type LogEntry } from '../../src/domains/observability/logs';
import { buildTrace, spanFromFields, type SpanRecord } from '../../src/domains/observability/trace';
import { frame, startFakeDocker, writeTestConfig } from '../container/fake-docker';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';

describe('docker log stream demultiplexing (pure)', () => {
  it('reassembles frames split across chunks and keeps streams apart', () => {
    const got: string[] = [];
    const lines = { stdout: new LineSplitter((l) => got.push(`out:${l}`)), stderr: new LineSplitter((l) => got.push(`err:${l}`)) };
    const d = new FrameDemuxer((s, p) => lines[s].push(p.toString('utf8')));
    const all = Buffer.concat([frame('stdout', 'a 1\n'), frame('stderr', 'boom\n'), frame('stdout', 'b 2\n'), frame('stdout', 'tail')]);
    for (let i = 0; i < all.length; i += 3) d.push(all.subarray(i, i + 3));
    lines.stdout.flush();
    expect(got).toEqual(['out:a 1', 'err:boom', 'out:b 2', 'out:tail']);
    expect(d.pending).toBe(0);
  });

  it('handles a payload whose size bytes are > 0x7f (binary-safe)', () => {
    const big = 'x'.repeat(200) + '\n';
    const got: string[] = [];
    const sp = new LineSplitter((l) => got.push(l));
    const d = new FrameDemuxer((_s, p) => sp.push(p.toString('utf8')));
    d.push(frame('stdout', big));
    expect(got[0]).toHaveLength(200);
  });
});

describe('line splitter memory bound', () => {
  it('a newline-free stream does not grow without bound: the line is cut, following lines still arrive', () => {
    const got: string[] = [];
    const sp = new LineSplitter((l) => got.push(l));
    const chunk = Buffer.from('y'.repeat(256 * 1024));
    for (let i = 0; i < 16; i++) sp.push(chunk); // 4 MiB without a newline
    sp.push('yyy\nnext line\n');
    sp.flush();
    expect(got).toHaveLength(2);
    expect(got[0].length).toBe(MAX_LINE_CHARS);
    expect(got[1]).toBe('next line');
    expect(sp.oversized).toBe(1);
  });
});

describe('log line parsing and filtering (pure)', () => {
  it('parses JSON lines, keeps non-JSON raw', () => {
    const e = parseLogLine('2026-10-17T12:00:00.123456789Z {"ts":"x","level":"ERROR","msg":"db down","trace_id":"t1","span_id":"s1","kind":"access","route":"/a"}', 'c', 'stdout');
    expect(e).toMatchObject({ ts: '2026-10-17T12:00:00.123456789Z', level: 'error', msg: 'db down', trace_id: 't1', kind: 'access', raw: null });
    expect(e.fields).toEqual({ route: '/a', app_ts: 'x' });
    const raw = parseLogLine('2026-10-17T12:00:00Z plain text {not json', 'c', 'stderr');
    expect(raw.raw).toBe('plain text {not json');
    expect(raw.level).toBeNull();
    expect(parseLogLine('2026-10-17T12:00:00Z {"level":50,"msg":"pino"}', 'c', 'stdout').level).toBe('error');
  });

  it('applies min level, trace id and span filters and counts what was excluded', () => {
    const stats = { lines: 0, unparsed: 0, spans_skipped: 0, unparsed_excluded_by_level: 0 };
    const err = parseLogLine('2026-10-17T12:00:00Z {"level":"error","msg":"x","trace_id":"abc"}', 'c', 'stdout');
    const info = parseLogLine('2026-10-17T12:00:00Z {"level":"info","msg":"y"}', 'c', 'stdout');
    const span = parseLogLine('2026-10-17T12:00:00Z {"level":"debug","kind":"span","msg":"span"}', 'c', 'stdout');
    const raw = parseLogLine('2026-10-17T12:00:00Z Traceback', 'c', 'stderr');
    expect(matches(err, '', { minLevel: 'warn' }, stats)).toBe(true);
    expect(matches(info, '', { minLevel: 'warn' }, stats)).toBe(false);
    expect(matches(span, '', {}, stats)).toBe(false);
    expect(matches(raw, '', { minLevel: 'error' }, stats)).toBe(false);
    expect(matches(err, '', { traceId: 'zzz' }, stats)).toBe(false);
    expect(stats).toMatchObject({ spans_skipped: 1, unparsed_excluded_by_level: 1 });
  });

  it('keeps the newest or oldest N and sorts timestamps with variable precision', () => {
    const mk = (ts: string) => ({ ts }) as LogEntry;
    const newest = new BoundedCollector(2, 'newest');
    ['2026-10-17T12:00:01.5Z', '2026-10-17T12:00:01.25Z', '2026-10-17T12:00:03Z', '2026-10-17T12:00:02Z'].forEach((t) => newest.add(mk(t)));
    expect(newest.entries().map((e) => e.ts)).toEqual(['2026-10-17T12:00:02Z', '2026-10-17T12:00:03Z']);
    expect(newest.matched).toBe(4);
    const oldest = new BoundedCollector(2, 'oldest');
    ['2026-10-17T12:00:01.5Z', '2026-10-17T12:00:01.25Z', '2026-10-17T12:00:03Z'].forEach((t) => oldest.add(mk(t)));
    expect(oldest.entries().map((e) => e.ts)).toEqual(['2026-10-17T12:00:01.25Z', '2026-10-17T12:00:01.5Z']);
    expect(tsKey('2026-10-17T12:00:01.5Z') > tsKey('2026-10-17T12:00:01.25Z')).toBe(true);
  });
});

describe('trace reconstruction (pure)', () => {
  const sp = (id: string, parent: string | null, name: string, start: string, d: number, status = 'ok'): SpanRecord => ({
    trace_id: 't',
    span_id: id,
    parent_span_id: parent,
    name,
    service: 'svc',
    container: 'c',
    start,
    duration_ms: d,
    status,
    attributes: {},
  });

  it('builds the tree, computes self time from the union of children and the breakdown', () => {
    const v = buildTrace(
      't',
      [
        sp('r', 'ext', 'http.request', '2026-10-17T12:00:00.000Z', 100),
        sp('a', 'r', 'redis.get', '2026-10-17T12:00:00.001Z', 2),
        sp('b', 'r', 'mysql.pool.acquire', '2026-10-17T12:00:00.003Z', 40),
        sp('c', 'r', 'mysql.query', '2026-10-17T12:00:00.043Z', 50, 'error'),
        sp('c', 'r', 'mysql.query', '2026-10-17T12:00:00.043Z', 50, 'error'),
      ],
      [{ ts: 'x', level: 'error', msg: 'mysql query failed', span_id: 'c', container: 'c', fields: {} }],
    );
    expect(v.span_count).toBe(4);
    expect(v.duration_ms).toBe(100);
    expect(v.external_parent).toBe('ext');
    expect(v.spans.map((s) => [s.name, s.depth])).toEqual([
      ['http.request', 0],
      ['redis.get', 1],
      ['mysql.pool.acquire', 1],
      ['mysql.query', 1],
    ]);
    expect(v.spans[0].self_ms).toBe(8);
    expect(v.breakdown[0]).toMatchObject({ name: 'mysql.query', self_ms: 50, pct_of_trace: 50 });
    expect(v.error_spans).toBe(1);
    expect(v.spans[3].logs[0].msg).toBe('mysql query failed');
  });

  it('marks multiple roots when parents are missing', () => {
    const v = buildTrace('t', [sp('a', 'missing1', 'x', '2026-10-17T12:00:00.000Z', 5), sp('b', 'missing2', 'y', '2026-10-17T12:00:00.010Z', 5)], []);
    expect(v.roots).toHaveLength(2);
    expect(v.spans.every((s) => s.orphan)).toBe(true);
    expect(spanFromFields({ trace_id: 't', span_id: 's', name: 'n', start: 'bad' }, 'c')).toBeNull();
  });
});

describe('log query and trace get against a fake Docker Engine', () => {
  const TRACE = 'ab'.repeat(16);
  const now = Date.now();
  const iso = (dt: number) => new Date(now - dt).toISOString();
  const span = (id: string, parent: string | null, name: string, dt: number, d: number) =>
    JSON.stringify({ ts: iso(dt), level: 'debug', service: 'demo-order', msg: 'span', kind: 'span', name, trace_id: TRACE, span_id: id, parent_span_id: parent, start: iso(dt), duration_ms: d, status: 'ok', attributes: {} });
  let fake: Awaited<ReturnType<typeof startFakeDocker>>;
  let configPath: string;
  const r = new Registry();
  r.addDomain(container);
  r.addDomain(observability);

  beforeAll(async () => {
    fake = await startFakeDocker({
      containers: [
        {
          Id: 'd1'.padEnd(64, '0'),
          Name: 'demo-order',
          Labels: { 'workctl.service': 'demo-order', 'workctl.env': 'sandbox' },
          State: 'running',
          logs: [
            { stream: 'stdout', line: JSON.stringify({ level: 'info', msg: 'service started' }) },
            { stream: 'stdout', line: span('s2', 's1', 'mysql.query', 5000, 120) },
            { stream: 'stdout', line: JSON.stringify({ level: 'error', msg: 'mysql query timeout', trace_id: TRACE, span_id: 's2' }) },
            { stream: 'stdout', line: span('s1', null, 'http.request', 5001, 130) },
            { stream: 'stderr', line: 'node: warning raw line' },
            { stream: 'stdout', line: JSON.stringify({ level: 'info', msg: 'request completed', trace_id: TRACE, span_id: 's1', status: 504 }) },
          ],
        },
        { Id: 'd2'.padEnd(64, '0'), Name: 'other', Labels: { 'workctl.service': 'other' }, State: 'running', LogDriver: 'none' },
      ],
    });
    configPath = writeTestConfig(fake.dir, { socketPath: fake.socketPath });
  });
  afterAll(async () => fake.close());

  it('log query returns parsed entries newest-first with coverage', async () => {
    const env = await invoke(r, 'observability.log.query', { service: 'demo-order', window: '15m' }, { configPath });
    expect(env.status).toBe('success');
    expect(env.meta.warnings).toEqual([]);
    const d = env.data as any;
    expect(d.stats).toMatchObject({ lines_scanned: 6, spans_skipped: 2, unparsed_lines: 1, matched: 4 });
    expect(d.entries[0].msg).toBe('request completed');
    expect(d.entries.find((e: any) => e.raw)?.stream).toBe('stderr');
    expect(env.meta.coverage?.window).toBeDefined();
    expect(env.meta.coverage?.truncated).toBe(false);
  });

  it('log query --level error --limit 1 marks truncation only when more matched', async () => {
    const env = await invoke(r, 'observability.log.query', { service: 'demo-order', level: 'error', limit: 1 }, { configPath });
    const d = env.data as any;
    expect(d.entries.map((e: any) => e.msg)).toEqual(['mysql query timeout']);
    expect(env.meta.coverage?.truncated).toBe(false);
    expect(d.stats.unparsed_excluded_by_level).toBe(1);
  });

  it('log query on a container without readable logs is COLLECTION_DISABLED', async () => {
    const env = await invoke(r, 'observability.log.query', { service: 'other', env: 'any' }, { configPath });
    expect(env.error?.code).toBe('COLLECTION_DISABLED');
  });

  it('trace get rebuilds the span tree from logs (derived)', async () => {
    const env = await invoke(r, 'observability.trace.get', { id: TRACE, service: 'demo-order' }, { configPath });
    expect(env.status).toBe('success');
    expect(env.meta.warnings).toEqual([]);
    const d = env.data as any;
    expect(d.span_count).toBe(2);
    expect(d.spans[0].name).toBe('http.request');
    expect(d.spans[1].logs[0].msg).toBe('mysql query timeout');
    expect(env.meta.sources[0].relation).toBe('derived');
  });

  it('log query / trace get / container event list reject a 0s window', async () => {
    for (const [cap, args] of [
      ['observability.log.query', { service: 'demo-order', window: '0s' }],
      ['observability.trace.get', { id: TRACE, service: 'demo-order', window: '0s' }],
      ['container.event.list', { service: 'demo-order', window: '0s' }],
    ] as const) {
      const env = await invoke(r, cap, args, { configPath });
      expect(env.error?.code, cap).toBe('INVALID_ARGUMENT');
    }
  });

  it('trace get for an unknown id is NOT_FOUND with a window hint', async () => {
    const env = await invoke(r, 'observability.trace.get', { id: 'cd'.repeat(16), service: 'demo-order' }, { configPath });
    expect(env.error?.code).toBe('NOT_FOUND');
    expect(env.error?.hint).toContain('--window');
  });
});

describe('long log lines are capped (Docker provider)', () => {
  const TRACE = 'ef'.repeat(16);
  const now = Date.now();
  const iso = (dt: number) => new Date(now - dt).toISOString();
  const big = 'x'.repeat(MAX_LOG_TEXT * 3);
  let fake: Awaited<ReturnType<typeof startFakeDocker>>;
  let configPath: string;
  const r = new Registry();
  r.addDomain(container);
  r.addDomain(observability);
  beforeAll(async () => {
    fake = await startFakeDocker({
      containers: [
        {
          Id: 'd3'.padEnd(64, '0'),
          Name: 'demo-long',
          Labels: { 'workctl.service': 'demo-long', 'workctl.env': 'sandbox' },
          State: 'running',
          logs: [
            { stream: 'stdout', line: JSON.stringify({ level: 'error', msg: big, stack: big, trace_id: TRACE, span_id: 's1' }) },
            { stream: 'stderr', line: big },
            { stream: 'stdout', line: JSON.stringify({ level: 'debug', msg: 'span', kind: 'span', name: 'h', trace_id: TRACE, span_id: 's1', parent_span_id: null, start: iso(1000), duration_ms: 5, status: 'ok', attributes: { sql: big } }) },
            { stream: 'stdout', line: JSON.stringify({ level: 'info', msg: 'short' }) },
          ],
        },
      ],
    });
    configPath = writeTestConfig(fake.dir, { socketPath: fake.socketPath });
  });
  afterAll(async () => fake.close());

  it('parseLogLine caps msg, raw and nested string fields and flags the entry', () => {
    const j = parseLogLine(`2026-10-17T12:00:00Z ${JSON.stringify({ msg: big, a: { b: [big] } })}`, 'c', 'stdout');
    expect(j.truncated).toBe(true);
    expect(j.msg!.length).toBeLessThan(MAX_LOG_TEXT + 64);
    expect(((j.fields as any).a.b[0] as string).length).toBeLessThan(MAX_LOG_TEXT + 64);
    const raw = parseLogLine(`2026-10-17T12:00:00Z ${big}`, 'c', 'stdout');
    expect(raw.truncated).toBe(true);
    expect(raw.raw).toMatch(/截断，原长 24576 字符/);
    expect(parseLogLine('2026-10-17T12:00:00Z short', 'c', 'stdout').truncated).toBe(false);
  });

  it('--trace-id still matches a raw line whose trace id lies beyond the cap', () => {
    const line = `2026-10-17T12:00:00Z ${big} trace=${TRACE}`;
    const st = { lines: 0, unparsed: 0, spans_skipped: 0, unparsed_excluded_by_level: 0 };
    expect(matches(parseLogLine(line, 'c', 'stdout'), line, { traceId: TRACE }, st)).toBe(true);
  });

  it('log query returns capped entries with truncated flags and a coverage note', async () => {
    const env = await invoke(r, 'observability.log.query', { service: 'demo-long', window: '15m' }, { configPath });
    expect(env.status).toBe('success');
    const d = env.data as any;
    expect(d.entries).toHaveLength(3);
    expect(d.entries.map((e: any) => e.truncated)).toEqual([false, true, true]);
    expect(JSON.stringify(d).length).toBeLessThan(MAX_LOG_TEXT * 6);
    expect(env.meta.coverage?.notes?.join('\n')).toMatch(/2 条日志含超过 8192 字符的文本/);
  });

  it('trace get caps span attributes / log text and says so', async () => {
    const env = await invoke(r, 'observability.trace.get', { id: TRACE, service: 'demo-long' }, { configPath });
    expect(env.status).toBe('success');
    const d = env.data as any;
    expect((d.spans[0].attributes.sql as string).length).toBeLessThan(MAX_LOG_TEXT + 64);
    expect(env.meta.coverage?.notes?.join('\n')).toMatch(/2 条 span\/日志记录含超过 8192 字符的文本/);
  });
});

describe('review regressions (logs / trace)', () => {
  it('decodes a multi-byte UTF-8 character split across TTY chunks and across frames', () => {
    const got: string[] = [];
    const sp = new LineSplitter((l) => got.push(l));
    const bytes = Buffer.from('2026-10-17T12:00:00Z 订单超时\n', 'utf8');
    const cut = bytes.indexOf(Buffer.from('单', 'utf8')) + 1; // inside the 3-byte character
    sp.push(bytes.subarray(0, cut));
    sp.push(bytes.subarray(cut));
    sp.flush();
    expect(got).toEqual(['2026-10-17T12:00:00Z 订单超时']);

    const out: string[] = [];
    const lines = new LineSplitter((l) => out.push(l));
    const d = new FrameDemuxer((_s, p) => lines.push(p));
    const payload = Buffer.from('缓存命中率下降\n', 'utf8');
    const head = (n: number) => {
      const h = Buffer.alloc(8);
      h[0] = 1;
      h.writeUInt32BE(n, 4);
      return h;
    };
    // one log line split across two frames in the middle of a character
    d.push(Buffer.concat([head(4), payload.subarray(0, 4), head(payload.length - 4), payload.subarray(4)]));
    lines.flush();
    expect(out).toEqual(['缓存命中率下降']);
  });

  it('keeps the globally newest/oldest entries when containers arrive one after another', () => {
    const mk = (ts: string, container: string) => ({ ts, container }) as LogEntry;
    // container A (newer logs) is scanned first, then container B (older logs)
    const a = ['12:00:10', '12:00:11', '12:00:12', '12:00:13', '12:00:14'].map((t) => mk(`2026-10-17T${t}Z`, 'a'));
    const b = ['12:00:01', '12:00:02', '12:00:03', '12:00:04', '12:00:05'].map((t) => mk(`2026-10-17T${t}Z`, 'b'));
    const newest = new BoundedCollector(2, 'newest');
    [...a, ...b].forEach((e) => newest.add(e));
    expect(newest.entries().map((e) => e.ts)).toEqual(['2026-10-17T12:00:13Z', '2026-10-17T12:00:14Z']);
    const oldest = new BoundedCollector(2, 'oldest');
    [...a, ...b].forEach((e) => oldest.add(e));
    expect(oldest.entries().map((e) => e.ts)).toEqual(['2026-10-17T12:00:01Z', '2026-10-17T12:00:02Z']);
  });

  const span = (id: string, parent: string | null, start: string, d: number): SpanRecord => ({
    trace_id: 't', span_id: id, parent_span_id: parent, name: id, service: 's', container: 'c', start, duration_ms: d, status: 'ok', attributes: {},
  });

  it('does not drop spans whose parents form a cycle (or that are their own parent)', () => {
    const v = buildTrace('t', [
      span('root', null, '2026-10-17T12:00:00.000Z', 100),
      span('a', 'b', '2026-10-17T12:00:00.010Z', 10),
      span('b', 'a', '2026-10-17T12:00:00.020Z', 5),
      span('self', 'self', '2026-10-17T12:00:00.030Z', 3),
    ], []);
    expect(v.span_count).toBe(4);
    expect(v.spans.map((s) => s.span_id).sort()).toEqual(['a', 'b', 'root', 'self']);
    expect(v.cyclic_parents).toEqual(['a', 'self']);
    expect(v.external_parent).toBeNull();
  });

  it('rejects span records with an unparseable start or negative duration instead of crashing', () => {
    expect(spanFromFields({ trace_id: 't', span_id: 's', name: 'n', start: 'not-a-time', duration_ms: 5 }, 'c')).toBeNull();
    expect(spanFromFields({ trace_id: 't', span_id: 's', name: 'n', start: '2026-10-17T12:00:00Z', duration_ms: -1 }, 'c')).toBeNull();
    expect(spanFromFields({ trace_id: 't', span_id: 's', name: 'n', start: '2026-10-17T12:00:00Z', duration_ms: 5 }, 'c')).not.toBeNull();
  });
});

// Regression: trace get reported coverage.complete=true / success when one of the service's
// containers could not be read (span could be missing), and NOT_FOUND ("no such trace") when
// no container log was readable at all.
describe('trace get with unreadable container logs', () => {
  const TRACE = 'ef'.repeat(16);
  const at = new Date(Date.now() - 1000).toISOString();
  const span = JSON.stringify({ ts: at, level: 'debug', msg: 'span', kind: 'span', name: 'http.request', trace_id: TRACE, span_id: 's1', parent_span_id: null, start: at, duration_ms: 5, status: 'ok', attributes: {} });
  let fake: Awaited<ReturnType<typeof startFakeDocker>>;
  let configPath: string;
  const r = new Registry();
  r.addDomain(container);
  r.addDomain(observability);
  beforeAll(async () => {
    fake = await startFakeDocker({
      containers: [
        { Id: 'e1'.padEnd(64, '0'), Name: 'svc-a-1', Labels: { 'workctl.service': 'svc-a', 'workctl.env': 'sandbox' }, State: 'running', logs: [{ stream: 'stdout', line: span }] },
        { Id: 'e2'.padEnd(64, '0'), Name: 'svc-a-2', Labels: { 'workctl.service': 'svc-a', 'workctl.env': 'sandbox' }, State: 'running', LogDriver: 'none' },
        { Id: 'e3'.padEnd(64, '0'), Name: 'svc-b-1', Labels: { 'workctl.service': 'svc-b', 'workctl.env': 'sandbox' }, State: 'running', LogDriver: 'none' },
      ],
    });
    configPath = writeTestConfig(fake.dir, { socketPath: fake.socketPath });
  });
  afterAll(async () => fake.close());

  it('is partial with complete=false when some container logs were not readable', async () => {
    const env = await invoke(r, 'observability.trace.get', { id: TRACE, service: 'svc-a' }, { configPath });
    expect(env.status).toBe('partial');
    expect(env.meta.coverage?.complete).toBe(false);
    expect(env.meta.coverage?.notes?.join(' ')).toContain('svc-a-2');
    expect((env.data as any).span_count).toBe(1);
  });

  it('is COLLECTION_DISABLED, not NOT_FOUND, when no container log could be read', async () => {
    const env = await invoke(r, 'observability.trace.get', { id: TRACE, service: 'svc-b' }, { configPath });
    expect(env.error?.code).toBe('COLLECTION_DISABLED');
  });
});
