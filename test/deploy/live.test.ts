// Live tests of the deploy domain against the demo environment.
// Jenkins: WORKCTL_IT=1 npx vitest run test/deploy/live.test.ts
//   (needs `docker compose up -d --no-deps jenkins` in demo/environment and demo/scenarios/deploy/seed-jenkins.mjs)
// Kubernetes: WORKCTL_IT=1 WORKCTL_K8S=1 npx vitest run test/deploy/live.test.ts
//   (k3s from demo/environment/k8s/k3s-up.sh; read-only + plan, never executes a rollback)
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { builtinRegistry } from '../../src/domains';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';
const r = builtinRegistry();
const it_ = process.env.WORKCTL_IT === '1';
const jenkinsCfg = resolve('demo/environment/workctl.yaml');
const k8sCfg = resolve('demo/environment/k8s/workctl.k8s.yaml');

describe.skipIf(!it_)('deploy domain (live jenkins)', () => {
  it('lists the seeded deploy builds with explicit times and the Jenkins version', async () => {
    const env = await invoke(r, 'deploy.release.list', { service: 'demo-order', env: 'sandbox', window: '30d' }, { configPath: jenkinsCfg });
    expect(env.status).toBe('success');
    const rel = (env.data as any).releases;
    expect(rel.length).toBeGreaterThanOrEqual(4);
    expect(rel.some((x: any) => x.version === 'v1.4.2-bad' && x.status === 'failed')).toBe(true);
    expect(rel.filter((x: any) => x.current)).toHaveLength(1);
    expect(env.meta.sources[0].version).toMatch(/^2\./);
  });

  it('release get masks the console and status/rollback plan work', async () => {
    const list = await invoke(r, 'deploy.release.list', { service: 'demo-order', window: '30d' }, { configPath: jenkinsCfg });
    const bad = (list.data as any).releases.find((x: any) => x.version === 'v1.4.2-bad');
    const env = await invoke(r, 'deploy.release.get', { service: 'demo-order', id: bad.id }, { configPath: jenkinsCfg });
    expect(env.status).toBe('success');
    expect((env.data as any).jenkins.console.lines.join('\n')).toContain('registry token: ******');
    expect((await invoke(r, 'deploy.status.get', { service: 'demo-order' }, { configPath: jenkinsCfg })).status).toBe('success');
    const plan = await invoke(r, 'deploy.rollback.plan', { service: 'demo-order' }, { configPath: jenkinsCfg });
    expect((plan.data as any).executable).toBe(true);
    expect((plan.data as any).targets[0].target_version).not.toBe((plan.data as any).targets[0].current_version);
    // read-only test: never executes the re-deploy
    expect((await invoke(r, 'operation.cancel', { id: (plan.data as any).id }, { configPath: jenkinsCfg })).status).toBe('success');
  });
});

describe.skipIf(!(it_ && process.env.WORKCTL_K8S === '1'))('deploy domain (live kubernetes)', () => {
  it('lists ReplicaSet revisions of the demo Deployment and its rollout status', async () => {
    const env = await invoke(r, 'deploy.release.list', { service: 'demo-order', env: 'sandbox' }, { configPath: k8sCfg });
    expect(env.status).toBe('success');
    const rel = (env.data as any).releases;
    expect(rel[0].current).toBe(true);
    expect(rel.every((x: any) => x.timestamps === 'derived')).toBe(true);
    expect(env.meta.sources[0].version).toMatch(/^v1\./);
    const st = await invoke(r, 'deploy.status.get', { service: 'demo-order' }, { configPath: k8sCfg });
    expect(['complete', 'progressing', 'failed']).toContain((st.data as any).state);
  });

  it('release get and rollback plan (not executed)', async () => {
    const list = await invoke(r, 'deploy.release.list', { service: 'demo-order' }, { configPath: k8sCfg });
    const prev = (list.data as any).releases[1];
    if (!prev) return;
    const env = await invoke(r, 'deploy.release.get', { service: 'demo-order', id: prev.id }, { configPath: k8sCfg });
    expect((env.data as any).kubernetes.replicaset).toBe(prev.id);
    const plan = await invoke(r, 'deploy.rollback.plan', { service: 'demo-order', to: prev.id }, { configPath: k8sCfg });
    expect((plan.data as any).targets[0].target_release).toBe(prev.id);
    await invoke(r, 'operation.cancel', { id: (plan.data as any).id }, { configPath: k8sCfg });
  });
});
