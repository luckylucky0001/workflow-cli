// Live tests against the demo environment. WORKCTL_IT=1.
import { describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { Registry } from '../../src/core/registry';
import network from '../../src/domains/network';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';
const configPath = 'demo/environment/workctl.yaml';

describe.skipIf(process.env.WORKCTL_IT !== '1')('network domain (live)', () => {
  const r = new Registry();
  r.addDomain(network);

  it('backend list probes demo-order /healthz', async () => {
    const env = await invoke(r, 'network.backend.list', { service: 'demo-order' }, { configPath });
    expect(env.meta.warnings).toEqual([]);
    expect((env.data as any).backends[0].probe.kind).toBe('http');
  });

  it('connectivity check reaches demo-mysql published port', async () => {
    const env = await invoke(r, 'network.connectivity.check', { target: '127.0.0.1:13306', count: 2 }, { configPath });
    expect((env.data as any).reachable).toBe(true);
  });
});
