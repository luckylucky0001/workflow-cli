import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { Registry } from '../../src/core/registry';
import observability from '../../src/domains/observability';
import { renderQuery, summarize } from '../../src/domains/observability/prometheus';
import { writeTestConfig } from '../container/fake-docker';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';

describe('prometheus helpers (pure)', () => {
  it('summarises values and turns NaN into null', () => {
    const { points, summary } = summarize([
      [1700000000, '0.5'],
      [1700000015, 'NaN'],
      [1700000030, '1.5'],
    ]);
    expect(points[1]).toEqual(['2023-11-14T22:13:35.000Z', null]);
    expect(summary).toMatchObject({ points: 3, nan_points: 1, min: 0.5, max: 1.5, avg: 1, last: 1.5 });
    expect(summarize([]).summary.avg).toBeNull();
  });

  it('counts Prometheus +Inf/-Inf separately from NaN (histogram_quantile above the largest bucket)', () => {
    const { points, summary } = summarize([
      [1700000000, '0.2'],
      [1700000015, '+Inf'],
      [1700000030, '-Inf'],
      [1700000045, 'NaN'],
    ]);
    expect(points[1][1]).toBeNull();
    expect(summary).toMatchObject({ points: 4, nan_points: 1, inf_points: 2, min: 0.2, max: 0.2, last: 0.2 });
  });

  it('renders $service and rejects label-breaking resource ids', () => {
    expect(renderQuery('x{service="$service"}', 'demo-order')).toBe('x{service="demo-order"}');
    expect(() => renderQuery('x{service="$service"}', 'a"}or vector(1)')).toThrow(/不允许/);
  });
});

describe('metric query / list against a fake Prometheus', () => {
  let server: Server;
  let configPath: string;
  let mode: 'data' | 'empty' | 'bad' | 'many' = 'data';
  const seen: string[] = [];
  const r = new Registry();
  r.addDomain(observability);

  beforeAll(async () => {
    server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://p');
      seen.push(`${u.pathname}?${u.searchParams.get('query') ?? ''}`);
      res.setHeader('content-type', 'application/json');
      if (u.pathname === '/api/v1/status/buildinfo') return res.end(JSON.stringify({ status: 'success', data: { version: '3.5.0-fake' } }));
      if (u.pathname === '/api/v1/query_range') {
        if (mode === 'bad') {
          res.statusCode = 400;
          return res.end(JSON.stringify({ status: 'error', errorType: 'bad_data', error: 'parse error at char 3' }));
        }
        const start = Number(u.searchParams.get('start'));
        if (mode === 'many') {
          // broad PromQL passthrough: 500 sparse series (each one point short of the window)
          const many = Array.from({ length: 500 }, (_, k) => ({ metric: { __name__: 'm', i: String(k) }, values: [[start, '1']] }));
          return res.end(JSON.stringify({ status: 'success', data: { resultType: 'matrix', result: many } }));
        }
        const result = mode === 'empty' ? [] : [{ metric: { service: 'demo-order' }, values: [[start, '0.01'], [start + 15, 'NaN'], [start + 30, '0.03']] }];
        return res.end(JSON.stringify({ status: 'success', data: { resultType: 'matrix', result } }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const port = (server.address() as AddressInfo).port;
    configPath = writeTestConfig(mkdtempSync(join(tmpdir(), 'workctl-prom-')), { promUrl: `http://127.0.0.1:${port}` });
  });
  afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

  it('resolves --metric through the catalog and summarises the series', async () => {
    mode = 'data';
    const env = await invoke(r, 'observability.metric.query', { resource: 'demo-order', metric: 'request_latency', window: '15m', step: '15s' }, { configPath });
    expect(env.status).toBe('success');
    expect(env.meta.warnings).toEqual([]);
    const d = env.data as any;
    expect(d.promql).toContain('service="demo-order"');
    expect(d.unit).toBe('seconds');
    expect(d.series[0].summary).toMatchObject({ min: 0.01, max: 0.03, nan_points: 1 });
    expect(env.meta.coverage?.window).toBeDefined();
    expect(env.meta.sources[0].version).toBe('3.5.0-fake');
  });

  it('empty matrix is success with empty=true and a note, not an error', async () => {
    mode = 'empty';
    const env = await invoke(r, 'observability.metric.query', { resource: 'demo-order', metric: 'request_latency' }, { configPath });
    expect(env.status).toBe('success');
    expect((env.data as any).empty).toBe(true);
    expect(env.meta.coverage?.notes?.join()).toContain('no samples in window');
  });

  it('maps bad PromQL to INVALID_ARGUMENT and an unknown metric to a catalog hint', async () => {
    mode = 'bad';
    const env = await invoke(r, 'observability.metric.query', { promql: 'sum(' }, { configPath });
    expect(env.error?.code).toBe('INVALID_ARGUMENT');
    expect(env.error?.message).toContain('bad_data');
    const unknown = await invoke(r, 'observability.metric.query', { resource: 'demo-order', metric: 'nope' }, { configPath });
    expect(unknown.error?.code).toBe('INVALID_ARGUMENT');
    expect(unknown.error?.hint).toContain('request_latency');
  });

  // Regression: a broad --promql returned every series (and one note per series) with
  // coverage.complete=true — unbounded output, truncation not reported.
  it('caps the series count and per-series notes, and reports the truncation in coverage', async () => {
    mode = 'many';
    const env = await invoke(r, 'observability.metric.query', { promql: '{__name__=~".+"}', window: '15m', step: '15s' }, { configPath });
    expect(env.status).toBe('success');
    expect((env.data as any).series).toHaveLength(200);
    expect(env.meta.coverage).toMatchObject({ complete: false, truncated: true, limit: 200 });
    const notes = env.meta.coverage?.notes ?? [];
    expect(notes.join()).toContain('返回 500 条序列，只输出前 200 条');
    expect(notes.length).toBeLessThan(30);
  });

  it('Prometheus down is UPSTREAM_UNAVAILABLE (distinct from empty)', async () => {
    const p = writeTestConfig(mkdtempSync(join(tmpdir(), 'workctl-prom-down-')), { promUrl: 'http://127.0.0.1:1' });
    const env = await invoke(r, 'observability.metric.query', { resource: 'demo-order', metric: 'request_latency' }, { configPath: p });
    expect(env.error?.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('metric list renders the catalog for a resource', async () => {
    const env = await invoke(r, 'observability.metric.list', { resource: 'demo-order' }, { configPath });
    expect(env.meta.warnings).toEqual([]);
    expect((env.data as any).metrics[0]).toMatchObject({ name: 'request_latency', unit: 'seconds' });
  });
});
