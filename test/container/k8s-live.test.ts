// Live tests against a real Kubernetes cluster (e.g. k3s from demo/environment/k8s/k3s-up.sh).
// Run with: WORKCTL_IT=1 WORKCTL_K8S=1 WORKCTL_K8S_KUBECONFIG=demo/environment/.runtime/k8s/kubeconfig.yaml npx vitest run test/container/k8s-live.test.ts
// Optional: WORKCTL_K8S_CONTEXT (kubeconfig context), WORKCTL_K8S_NAMESPACE (default workctl-demo),
// WORKCTL_K8S_EXECUTE=1 to really run a rollout restart of the demo Deployment.
// Not run in CI / in this repository's container (no privileged containers available): never claim these as verified.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { builtinRegistry } from '../../src/domains';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';
const enabled = process.env.WORKCTL_IT === '1' && process.env.WORKCTL_K8S === '1' && !!process.env.WORKCTL_K8S_KUBECONFIG;
const ns = process.env.WORKCTL_K8S_NAMESPACE ?? 'workctl-demo';

function liveConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), 'workctl-k8s-live-'));
  writeFileSync(
    join(dir, 'bindings.yaml'),
    `schema_version: "1.0"
resources:
  - { id: demo-order, type: service, env: sandbox }
  - id: demo-order-k8s
    type: container.workload
    env: sandbox
    endpoint: { kind: kubernetes, name: live }
    labels: { app: demo-order }
    attributes: { namespace: ${ns} }
relations:
  - { from: demo-order, to: demo-order-k8s, type: runs_on, source: binding-file }
`,
  );
  const endpoint: Record<string, unknown> = { kubeconfig: resolve(process.env.WORKCTL_K8S_KUBECONFIG!), namespace: ns };
  if (process.env.WORKCTL_K8S_CONTEXT) endpoint.context = process.env.WORKCTL_K8S_CONTEXT;
  const cfg = {
    schema_version: '1.0',
    current_profile: 'live',
    profiles: { live: { env: 'sandbox', allow_execute: process.env.WORKCTL_K8S_EXECUTE === '1', resources_file: './bindings.yaml', state_dir: './state', endpoints: { kubernetes: { live: endpoint } } } },
  };
  const p = join(dir, 'workctl.yaml');
  writeFileSync(p, JSON.stringify(cfg));
  return p;
}

describe.skipIf(!enabled)('container domain (live kubernetes)', () => {
  const r = builtinRegistry();
  const configPath = enabled ? liveConfig() : '';

  it('auth status --probe reaches the API server and reports its version', async () => {
    const env = await invoke(r, 'auth.status', { probe: true }, { configPath });
    expect(env.status).toBe('success');
    const ep = (env.data as any).endpoints.find((e: any) => e.kind === 'kubernetes');
    expect(ep.probe.ok).toBe(true);
    expect(ep.probe.version).toMatch(/^v1\./);
  });

  it('workload get finds the demo Deployment pods by label selector', async () => {
    const env = await invoke(r, 'container.workload.get', { service: 'demo-order' }, { configPath });
    expect(env.status).toBe('success');
    expect(env.meta.warnings).toEqual([]);
    const d = env.data as any;
    expect(d.provider).toBe('kubernetes');
    expect(d.containers.length).toBeGreaterThan(0);
    expect(d.kubernetes.workloads[0].name).toBe('demo-order');
    expect(env.meta.sources[0].version).toMatch(/^v1\./);
  });

  it('event list, stats and capacity summary return valid envelopes (metrics may be COLLECTION_DISABLED)', async () => {
    for (const [cap, inputs] of [
      ['container.event.list', { service: 'demo-order', window: '30m' }],
      ['container.stats.get', { service: 'demo-order' }],
      ['container.capacity.summary', { env: 'sandbox', provider: 'kubernetes' }],
    ] as const) {
      const env = await invoke(r, cap, inputs, { configPath });
      if (env.status === 'error') expect(env.error?.code, cap).toBe('COLLECTION_DISABLED');
      expect(env.meta.warnings.filter((w) => w.includes('schema')), cap).toEqual([]);
    }
  });

  it('restart plan resolves the Deployment (plan only unless WORKCTL_K8S_EXECUTE=1)', async () => {
    const env = await invoke(r, 'container.workload.restart_plan', { service: 'demo-order' }, { configPath });
    expect(env.status).toBe('success');
    const plan = env.data as any;
    expect(plan.targets[0]).toMatchObject({ kind: 'Deployment', name: 'demo-order' });
    expect(plan.idempotent).toBe(false);
    if (process.env.WORKCTL_K8S_EXECUTE !== '1') return;
    const done = await invoke(r, 'operation.execute', { id: plan.id, confirm: plan.id }, { configPath, timeoutMs: 300_000 });
    expect(done.status).toBe('success');
    expect((done.data as any).result.verified_all).toBe(true);
  }, 320_000);
});
