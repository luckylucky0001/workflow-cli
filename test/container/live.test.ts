// Live tests against the demo environment (demo/environment/up.sh). Run with WORKCTL_IT=1.
import { describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { Registry } from '../../src/core/registry';
import container from '../../src/domains/container';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';
const configPath = 'demo/environment/workctl.yaml';

describe.skipIf(process.env.WORKCTL_IT !== '1')('container domain (live docker)', () => {
  const r = new Registry();
  r.addDomain(container);

  it('workload get finds demo-order by label with real limits and version', async () => {
    const env = await invoke(r, 'container.workload.get', { service: 'demo-order' }, { configPath });
    expect(env.status).toBe('success');
    expect(env.meta.warnings).toEqual([]);
    const d = env.data as any;
    expect(d.containers[0].name).toBe('demo-order');
    expect(d.containers[0].limits.cpus).toBe(0.5);
    expect(env.meta.sources[0].version).toMatch(/API/);
  });

  it('event list, stats and capacity summary return valid envelopes', async () => {
    for (const [cap, inputs] of [
      ['container.event.list', { service: 'demo-order', window: '30m' }],
      ['container.stats.get', { service: 'demo-order' }],
      ['container.capacity.summary', { env: 'sandbox' }],
    ] as const) {
      const env = await invoke(r, cap, inputs, { configPath });
      expect(env.status, cap).not.toBe('error');
      expect(env.meta.warnings, cap).toEqual([]);
    }
  });

  it('restart plan resolves the real container (plan only, not executed)', async () => {
    const env = await invoke(r, 'container.workload.restart_plan', { service: 'demo-order' }, { configPath });
    expect(env.status).toBe('success');
    expect((env.data as any).targets[0].name).toBe('demo-order');
  });
});
