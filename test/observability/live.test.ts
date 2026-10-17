// Live tests against the demo environment; needs some traffic (demo/scenarios/latency/loadgen.mjs). WORKCTL_IT=1.
import { describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { Registry } from '../../src/core/registry';
import container from '../../src/domains/container';
import observability from '../../src/domains/observability';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';
const configPath = 'demo/environment/workctl.yaml';

describe.skipIf(process.env.WORKCTL_IT !== '1')('observability domain (live prometheus + docker logs)', () => {
  const r = new Registry();
  r.addDomain(container);
  r.addDomain(observability);

  it('metric query resolves the catalog and reports the Prometheus version', async () => {
    const env = await invoke(r, 'observability.metric.query', { resource: 'demo-order', metric: 'request_rate', window: '15m' }, { configPath });
    expect(env.status).toBe('success');
    expect(env.meta.warnings).toEqual([]);
    expect(env.meta.sources[0].version).toMatch(/^\d+\.\d+/);
  });

  it('log query → trace get round trip', async () => {
    const logs = await invoke(r, 'observability.log.query', { service: 'demo-order', window: '30m', contains: 'request completed', limit: 5 }, { configPath });
    expect(logs.status).not.toBe('error');
    expect(logs.meta.warnings).toEqual([]);
    const traceId = (logs.data as any).entries.find((e: any) => e.trace_id)?.trace_id;
    if (!traceId) return; // no traffic in the window
    const trace = await invoke(r, 'observability.trace.get', { id: traceId, window: '30m' }, { configPath });
    expect(trace.status).toBe('success');
    expect(trace.meta.warnings).toEqual([]);
    expect((trace.data as any).spans[0].name).toBe('http.request');
  });
});
