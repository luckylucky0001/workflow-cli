// Live: Docker container logs vs a real Loki fed by Promtail, same service, same window. WORKCTL_IT=1.
// Needs demo-order plus `docker compose -f demo/environment/docker-compose.yml up -d loki promtail`.
import { spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config';
import { invoke } from '../../src/core/engine';
import { Registry } from '../../src/core/registry';
import { Ctx } from '../../src/core/runtime';
import container from '../../src/domains/container';
import observability from '../../src/domains/observability';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';
const DOCKER = 'demo/environment/workctl.yaml';
const LOKI = 'demo/environment/workctl.loki.yaml';

describe.skipIf(process.env.WORKCTL_IT !== '1')('log providers live: Docker logs vs Loki (Promtail)', () => {
  const r = new Registry();
  r.addDomain(container);
  r.addDomain(observability);
  const q = (configPath: string, inputs: Record<string, unknown>, cap = 'observability.log.query') => invoke(r, cap, inputs, { configPath, timeoutMs: 60_000 });
  let trafficStart = '';
  let trafficEnd = '';

  beforeAll(async () => {
    trafficStart = new Date().toISOString();
    const lg = spawnSync(process.execPath, ['demo/scenarios/latency/loadgen.mjs', '--rps', '10', '--duration', '5', '--seed', '11'], { encoding: 'utf8', timeout: 60_000 });
    expect(lg.status).toBe(0);
    trafficEnd = new Date().toISOString();
    // wait for ingestion: the newest access log Docker sees must be visible in Loki (push interval ~1s)
    const newest = async (cfg: string) => ((await q(cfg, { service: 'demo-order', window: '2m', contains: 'request completed', limit: 1 })).data as any)?.entries?.[0]?.ts as string | undefined;
    const target = await newest(DOCKER);
    for (let i = 0; i < 40; i++) {
      const got = await newest(LOKI);
      if (target && got && got >= target) break;
      await new Promise((res) => setTimeout(res, 500));
    }
    await new Promise((res) => setTimeout(res, 1500));
  }, 120_000);

  it('auth status probe reads Loki buildinfo and /ready', async () => {
    const ctx = new Ctx({ registry: r, loaded: loadConfig(LOKI), profileName: 'demo', requestId: 't', timeoutMs: 10_000 });
    const p = await r.probes.get('loki')!(ctx, 'demo-loki');
    expect(p.ok).toBe(true);
    expect(p.version).toMatch(/^3\.\d+\.\d+/);
  });

  it('same window: both providers return the same access log entries, schema-valid, same keys', async () => {
    const inputs = { service: 'demo-order', window: '5m', order: 'oldest', contains: 'request completed', limit: 2000 };
    const [d, l] = await Promise.all([q(DOCKER, inputs), q(LOKI, inputs)]);
    for (const env of [d, l]) {
      expect(env.status).toBe('success');
      expect(env.meta.warnings).toEqual([]);
    }
    expect(d.meta.sources[0].system).toBe('docker');
    expect(l.meta.sources[0]).toMatchObject({ system: 'loki', adapter: 'loki-http-api' });
    expect(Object.keys(l.data as object).sort()).toEqual(Object.keys(d.data as object).sort());
    // compare the lines written by this test's traffic (well inside both windows, older than the push interval)
    const pick = (env: any) => new Set<string>(env.data.entries.filter((e: any) => e.ts >= trafficStart && e.ts <= trafficEnd).map((e: any) => `${e.ts}|${e.trace_id}|${e.fields?.path}`));
    const ds = pick(d);
    const ls = pick(l);
    expect(ds.size).toBeGreaterThan(20);
    expect([...ls].sort()).toEqual([...ds].sort());
    // identical entry objects (same parser)
    const de = (d.data as any).entries.find((e: any) => ls.has(`${e.ts}|${e.trace_id}|${e.fields?.path}`));
    const le = (l.data as any).entries.find((e: any) => e.ts === de.ts && e.trace_id === de.trace_id);
    expect(le).toEqual(de);
  });

  it('limit truncation and window stats agree', async () => {
    const inputs = { service: 'demo-order', window: '5m', limit: 5 };
    const [d, l] = await Promise.all([q(DOCKER, inputs), q(LOKI, inputs)]);
    expect(d.meta.coverage?.truncated).toBe(true);
    expect(l.meta.coverage?.truncated).toBe(true);
    const ds = (d.data as any).stats;
    const lsx = (l.data as any).stats;
    expect(lsx.returned).toBe(5);
    // the two "from now" windows differ by milliseconds; allow a couple of edge lines
    expect(Math.abs(lsx.lines_scanned - ds.lines_scanned)).toBeLessThanOrEqual(3);
    expect(Math.abs(lsx.matched - ds.matched)).toBeLessThanOrEqual(3);
    expect(Math.abs(lsx.spans_skipped - ds.spans_skipped)).toBeLessThanOrEqual(3);
  });

  it('trace get rebuilds the same span tree from Loki', async () => {
    const seed = await q(DOCKER, { service: 'demo-order', window: '5m', contains: 'request completed', limit: 1 });
    const id = (seed.data as any).entries[0].trace_id as string;
    const [d, l] = await Promise.all([q(DOCKER, { id, window: '30m' }, 'observability.trace.get'), q(LOKI, { id, window: '30m' }, 'observability.trace.get')]);
    expect(d.status).toBe('success');
    expect(l.status).toBe('success');
    expect(l.meta.warnings).toEqual([]);
    expect(l.meta.sources[0]).toMatchObject({ system: 'loki', relation: 'derived' });
    const shape = (env: any) => env.data.spans.map((s: any) => [s.span_id, s.parent_span_id, s.name, s.depth, s.duration_ms, s.self_ms, s.logs.length]);
    expect(shape(l)).toEqual(shape(d));
    expect((l.data as any).roots).toEqual((d.data as any).roots);
  });

  it('unknown service: Loki NOT_FOUND like Docker', async () => {
    const [d, l] = await Promise.all([q(DOCKER, { service: 'no-such-svc' }), q(LOKI, { service: 'no-such-svc' })]);
    expect(d.error?.code).toBe('NOT_FOUND');
    expect(l.error?.code).toBe('NOT_FOUND');
  });
});
