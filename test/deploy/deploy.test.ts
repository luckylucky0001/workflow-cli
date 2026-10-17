import { readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { dirname, join } from 'node:path';
import YAML from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { builtinRegistry } from '../../src/domains';
import { maskSecrets } from '../../src/domains/deploy/model';
import { deployRolloutTiming } from '../../src/domains/deploy/k8s';
import { jenkinsRollbackTiming } from '../../src/domains/deploy/jenkins';
import { jbuild, k8sDeployFixture, replicaset, startFakeJenkins, startFakeK8sDeploy, writeDeployConfig, type FakeJenkinsState, type FakeK8sDeployState } from './fakes';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';
const r = builtinRegistry();

describe('deploy domain registration', () => {
  it('registers the capabilities, planned adapters, planner/executor and the jenkins probe', () => {
    for (const c of ['deploy.release.list', 'deploy.release.get', 'deploy.status.get', 'deploy.rollback.plan']) expect(r.get(c)?.status).toBe('available');
    for (const c of ['deploy.app.sync_status', 'deploy.app.history', 'deploy.pipeline.execution.list']) expect(r.get(c)?.status).toBe('planned');
    expect(r.planners.has('deploy.rollback')).toBe(true);
    expect(r.executors.has('deploy.rollback')).toBe(true);
    expect(r.probes.has('jenkins')).toBe(true);
    expect(r.domains.get('deploy')?.pillar).toBe('infrastructure');
  });

  it('planned capabilities are not callable', async () => {
    const env = await invoke(r, 'deploy.app.sync_status', {}, { configPath: writeDeployConfig({}) });
    expect(env.error?.code).toBe('CAPABILITY_PLANNED');
  });

  it('masks credentials in console lines', () => {
    expect(maskSecrets('registry token: abc123')).toBe('registry token: ******');
    expect(maskSecrets('PASSWORD=s3cr3t done')).toBe('PASSWORD=****** done');
    expect(maskSecrets('Authorization: Bearer eyJabc.def')).toContain('******');
    expect(maskSecrets('git clone https://bob:pw@git.local/x')).toBe('git clone https://******@git.local/x');
  });
});

describe('deploy domain (jenkins provider, fake server)', () => {
  let server: Server;
  let url: string;
  let configPath: string;
  const state: FakeJenkinsState = {
    builds: [
      jbuild(1, { version: 'v1.4.0', minutesAgo: 50 }),
      jbuild(2, { version: 'v1.4.1', minutesAgo: 40 }),
      jbuild(3, { version: 'v1.4.2-bad', result: 'FAILURE', minutesAgo: 30, user: 'bob', secretParam: true }),
      jbuild(4, { version: 'v9', service: 'other-svc', minutesAgo: 25 }),
      jbuild(5, { version: 'v1.4.1', minutesAgo: 20 }),
      jbuild(6, { version: 'v1.4.3', result: 'ABORTED', minutesAgo: 10 }),
      jbuild(7, { version: 'v1.4.0', env: 'prod', minutesAgo: 5 }),
    ],
    queue: [],
    console: { 3: 'Started by user bob\ndeploying demo-order v1.4.2-bad\nregistry token: abc123\nhealth check failed\nFinished: FAILURE\n' },
    numToKeep: 15,
  };

  beforeAll(async () => {
    const s = await startFakeJenkins(state);
    server = s.server;
    url = s.url;
    configPath = writeDeployConfig({ jenkinsUrl: url });
  });
  afterAll(() => server?.close());

  it('release list: builds of this service/env newest first, statuses, current, explicit times, retention', async () => {
    const env = await invoke(r, 'deploy.release.list', { service: 'demo-order' }, { configPath });
    expect(env.status).toBe('success');
    expect(env.meta.warnings).toEqual([]);
    const d = env.data as any;
    expect(d.target).toMatchObject({ provider: 'jenkins', object: 'job deploy-demo-order', binding: 'demo-order-jenkins' });
    expect(d.releases.map((x: any) => x.id)).toEqual(['6', '5', '3', '2', '1']); // #4 other service, #7 prod excluded
    expect(d.releases.map((x: any) => x.status)).toEqual(['aborted', 'succeeded', 'failed', 'succeeded', 'succeeded']);
    expect(d.releases.find((x: any) => x.current).id).toBe('5');
    expect(d.releases[2]).toMatchObject({ version: 'v1.4.2-bad', triggered_by: 'bob', timestamps: 'explicit', duration_ms: 2017 });
    expect(Date.parse(d.releases[2].finished_at) - Date.parse(d.releases[2].started_at)).toBe(2017);
    expect(env.meta.sources[0]).toMatchObject({ system: 'jenkins', version: '2.541.3', relation: 'explicit' });
    expect(env.meta.coverage?.notes?.join(' ')).toContain('只保留最近 15 个构建');
    expect(env.meta.coverage?.notes?.join(' ')).toContain('2 个构建属于其他服务/环境');
  });

  it('release list: window and limit', async () => {
    const env = await invoke(r, 'deploy.release.list', { service: 'demo-order', window: '15m' }, { configPath });
    expect((env.data as any).releases.map((x: any) => x.id)).toEqual(['6']);
    const lim = await invoke(r, 'deploy.release.list', { service: 'demo-order', limit: 2 }, { configPath });
    expect((lim.data as any).releases).toHaveLength(2);
    expect(lim.meta.coverage).toMatchObject({ truncated: true, complete: false });
  });

  it('release get: parameters (secret masked), causes, masked console tail', async () => {
    const env = await invoke(r, 'deploy.release.get', { service: 'demo-order', id: '3', tail: 3 }, { configPath });
    expect(env.status).toBe('success');
    const j = (env.data as any).jenkins;
    expect(j.parameters).toMatchObject({ VERSION: 'v1.4.2-bad' });
    expect(j.console.lines).toEqual(['registry token: ******', 'health check failed', 'Finished: FAILURE']);
    expect(j.console).toMatchObject({ total_lines: 5, truncated: true, masked: true });
    expect(JSON.stringify(env)).not.toContain('abc123');
    expect((env.data as any).release).toMatchObject({ status: 'failed', current: false });
  });

  it('release get --tail 0 returns no console lines (not the whole log)', async () => {
    const env = await invoke(r, 'deploy.release.get', { service: 'demo-order', id: '3', tail: 0 }, { configPath });
    expect((env.data as any).jenkins.console).toMatchObject({ lines: [], total_lines: 5, truncated: true });
  });

  it('release get: missing build → NOT_FOUND, other service build → NOT_FOUND, bad id → INVALID_ARGUMENT', async () => {
    expect((await invoke(r, 'deploy.release.get', { service: 'demo-order', id: '99' }, { configPath })).error?.code).toBe('NOT_FOUND');
    expect((await invoke(r, 'deploy.release.get', { service: 'demo-order', id: '4' }, { configPath })).error?.code).toBe('NOT_FOUND');
    expect((await invoke(r, 'deploy.release.get', { service: 'demo-order', id: 'x1' }, { configPath })).error?.code).toBe('INVALID_ARGUMENT');
  });

  it('status get: last build result, then running and queued', async () => {
    let env = await invoke(r, 'deploy.status.get', { service: 'demo-order' }, { configPath });
    expect(env.data).toMatchObject({ provider: 'jenkins', state: 'aborted', in_progress: false });
    expect((env.data as any).current_release.id).toBe('5');
    state.builds.push(jbuild(8, { version: 'v1.4.4', building: true, minutesAgo: 1 }));
    env = await invoke(r, 'deploy.status.get', { service: 'demo-order' }, { configPath });
    expect(env.data).toMatchObject({ state: 'progressing', in_progress: true });
    expect((env.data as any).jenkins.running[0]).toMatchObject({ id: '8', status: 'running', finished_at: null });
    state.builds.pop();
    state.queue.push({ id: 41, why: 'Waiting for next available executor', inQueueSince: Date.now() - 5000, params: '\nSERVICE=demo-order\nVERSION=v1.4.5\nENV=sandbox', task: { name: 'deploy-demo-order' } });
    state.queue.push({ id: 42, why: 'x', params: '\nSERVICE=other\nENV=sandbox', task: { name: 'deploy-demo-order' } });
    env = await invoke(r, 'deploy.status.get', { service: 'demo-order' }, { configPath });
    expect(env.data).toMatchObject({ state: 'queued', in_progress: true });
    expect((env.data as any).jenkins.queued.map((q: any) => q.queue_id)).toEqual([41]);
    state.queue = [];
  });

  it('rollback plan → execute: replays the target build parameters (crumb + session cookie) and waits for SUCCESS', async () => {
    jenkinsRollbackTiming.pollMs = 10;
    const env = await invoke(r, 'deploy.rollback.plan', { service: 'demo-order' }, { configPath });
    expect(env.status).toBe('success');
    const plan = env.data as any;
    expect(plan.executable).toBe(true);
    expect(plan.targets[0]).toMatchObject({ current_build: 5, current_version: 'v1.4.1', target_build: 1, target_version: 'v1.4.0' });
    expect(plan.preconditions.every((p: any) => p.ok)).toBe(true);
    const ex = await invoke(r, 'operation.execute', { id: plan.id, confirm: plan.id }, { configPath });
    expect(ex.status).toBe('success');
    expect((ex.data as any).result.rollback).toMatchObject({ build: 8, result: 'SUCCESS', version: 'v1.4.0', verified: true });
    expect(state.posts?.[0]).toMatchObject({ crumb: 'crumb-123', cookie: 'JSESSIONID.abc=node0xyz' });
    expect(state.posts?.[0].query).toContain('VERSION=v1.4.0');
    const list = await invoke(r, 'deploy.release.list', { service: 'demo-order' }, { configPath });
    expect((list.data as any).releases[0]).toMatchObject({ id: '8', current: true, version: 'v1.4.0' });
    // a plan made before that re-deploy is stale: current build changed → CONFLICT
    const bad = await invoke(r, 'deploy.rollback.plan', { service: 'demo-order', to: '3' }, { configPath });
    expect((bad.data as any).preconditions.find((p: any) => p.check === 'target_succeeded').ok).toBe(false);
    expect((await invoke(r, 'operation.execute', { id: (bad.data as any).id, confirm: (bad.data as any).id }, { configPath })).error?.code).toBe('PRECONDITION_FAILED');
    const stale = await invoke(r, 'deploy.rollback.plan', { service: 'demo-order', to: '2' }, { configPath });
    state.builds.push(jbuild(9, { version: 'v1.4.9', minutesAgo: 0 }));
    expect((await invoke(r, 'operation.execute', { id: (stale.data as any).id, confirm: (stale.data as any).id }, { configPath })).error?.code).toBe('CONFLICT');
    state.builds.pop();
  });

  it('rollback of a build with a password parameter is not replayable', async () => {
    state.builds.push(jbuild(10, { version: 'v1.3.0', minutesAgo: 70, secretParam: true }));
    const env = await invoke(r, 'deploy.rollback.plan', { service: 'demo-order', to: '10' }, { configPath });
    expect((env.data as any).preconditions.find((p: any) => p.check === 'parameters_replayable').ok).toBe(false);
    state.builds.pop();
  });

  it('service without deploy binding → NOT_CONFIGURED; wrong password → UNAUTHENTICATED; 403/503 mapped', async () => {
    expect((await invoke(r, 'deploy.release.list', { service: 'demo-mysql' }, { configPath })).error?.code).toBe('NOT_CONFIGURED');
    const badPw = writeDeployConfig({ jenkinsUrl: url, password: 'wrong' });
    const e401 = await invoke(r, 'deploy.release.list', { service: 'demo-order' }, { configPath: badPw });
    expect(e401.error?.code).toBe('UNAUTHENTICATED');
    expect(JSON.stringify(e401)).not.toContain('wrong');
    state.failWith = 403;
    expect((await invoke(r, 'deploy.release.list', { service: 'demo-order' }, { configPath })).error?.code).toBe('PERMISSION_DENIED');
    state.failWith = 503;
    expect((await invoke(r, 'deploy.release.list', { service: 'demo-order' }, { configPath })).error).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', retryable: true });
    state.failWith = undefined;
  });

  it('unreachable Jenkins → UPSTREAM_UNAVAILABLE; auth status probe reports identity and version', async () => {
    const down = writeDeployConfig({ jenkinsUrl: 'http://127.0.0.1:1' });
    expect((await invoke(r, 'deploy.status.get', { service: 'demo-order' }, { configPath: down })).error?.code).toBe('UPSTREAM_UNAVAILABLE');
    const env = await invoke(r, 'auth.status', { probe: true }, { configPath });
    const ep = (env.data as any).endpoints.find((e: any) => e.kind === 'jenkins');
    expect(ep.auth_provider).toBe('jenkins-basic');
    expect(ep.probe).toMatchObject({ ok: true, identity: 'admin', version: '2.541.3' });
  });
});

describe('deploy domain (kubernetes provider, fake API server)', () => {
  let server: Server;
  let state: FakeK8sDeployState;
  let configPath: string;
  const opts = () => ({ configPath, profile: 'staging' });

  beforeAll(async () => {
    state = k8sDeployFixture();
    const s = await startFakeK8sDeploy(state);
    server = s.server;
    configPath = writeDeployConfig({ k8sUrl: s.url });
    deployRolloutTiming.pollMs = 20;
  });
  afterAll(() => server?.close());

  it('release list: owned ReplicaSets by revision, derived times, current succeeded, superseded unknown', async () => {
    const env = await invoke(r, 'deploy.release.list', { service: 'demo-order', window: '7d' }, opts());
    expect(env.status).toBe('success');
    const d = env.data as any;
    expect(d.target).toMatchObject({ provider: 'kubernetes', object: 'Deployment demo/demo-order' });
    expect(d.releases.map((x: any) => x.revision)).toEqual([3, 2]); // rev 1 is 30 days old; zzz belongs to another controller
    expect(d.retained).toBe(3);
    expect(d.releases[0]).toMatchObject({ id: 'demo-order-ccc', current: true, status: 'succeeded', version: '1.4.2', timestamps: 'derived', cause: 'release 1.4.2' });
    expect(d.releases[0].finished_at).not.toBeNull();
    expect(d.releases[1]).toMatchObject({ status: 'unknown', current: false, finished_at: null });
    expect(env.meta.coverage?.notes?.join(' ')).toContain('revisionHistoryLimit=10');
    expect(env.meta.coverage?.notes?.join(' ')).toContain('1 个 ReplicaSet 匹配选择器但不属于');
    expect(env.meta.sources[0]).toMatchObject({ system: 'kubernetes', version: 'v1.31.4+k3s1' });
  });

  it('release get by revision number: images, masked env, diff vs current; unknown id → NOT_FOUND', async () => {
    const env = await invoke(r, 'deploy.release.get', { service: 'demo-order', id: '2' }, opts());
    expect(env.status).toBe('success');
    const k = (env.data as any).kubernetes;
    expect(k).toMatchObject({ replicaset: 'demo-order-bbb', revision: 2, change_cause: 'release 1.4.1', pod_template_hash: 'bbb' });
    expect(k.containers[0].env).toContainEqual({ name: 'DB_PASSWORD', value: '******' });
    expect(k.diff_vs_current.images[0]).toMatchObject({ this_release: 'registry/demo-order:1.4.1', current: 'registry/demo-order:1.4.2' });
    expect(k.diff_vs_current.env_changed).toEqual(['nginx:RELEASE_VERSION']);
    expect(JSON.stringify(env)).not.toContain('hunter2');
    const nf = await invoke(r, 'deploy.release.get', { service: 'demo-order', id: 'demo-order-nope' }, opts());
    expect(nf.error?.code).toBe('NOT_FOUND');
    expect(nf.error?.hint).toContain('3=demo-order-ccc');
  });

  it('status get: failed rollout (ProgressDeadlineExceeded) with pod waiting reasons', async () => {
    const saved = JSON.parse(JSON.stringify(state.deployment.status));
    state.deployment.status.conditions[1] = { type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded', message: 'ReplicaSet "demo-order-ccc" has timed out progressing.' };
    state.deployment.status.updatedReplicas = 1;
    state.pods.push({ metadata: { name: 'demo-order-ccc-x', labels: { app: 'demo-order', 'pod-template-hash': 'ccc' } }, spec: { containers: [] }, status: { phase: 'Pending', containerStatuses: [{ name: 'nginx', ready: false, restartCount: 0, image: 'x', state: { waiting: { reason: 'ImagePullBackOff' } } }] } });
    const env = await invoke(r, 'deploy.status.get', { service: 'demo-order' }, opts());
    expect(env.data).toMatchObject({ provider: 'kubernetes', state: 'failed', in_progress: false });
    expect((env.data as any).current_release.status).toBe('failed');
    expect((env.data as any).kubernetes.pods.find((p: any) => p.name === 'demo-order-ccc-x').waiting_reasons).toEqual(['ImagePullBackOff']);
    state.deployment.status = saved;
    state.pods.pop();
    const ok = await invoke(r, 'deploy.status.get', { service: 'demo-order' }, opts());
    expect(ok.data).toMatchObject({ state: 'complete' });
  });

  it('rollback plan → execute: JSON patch (test uid, template without pod-template-hash, change-cause) and verified rollout', async () => {
    const missing = await invoke(r, 'deploy.rollback.plan', { service: 'demo-order', to: '42' }, opts());
    expect((missing.data as any).preconditions.find((p: any) => p.check === 'target_release_retained').ok).toBe(false);
    const env = await invoke(r, 'deploy.rollback.plan', { service: 'demo-order' }, opts());
    const plan = env.data as any;
    expect(plan).toMatchObject({ kind: 'deploy.rollback', executable: true });
    expect(plan.targets[0]).toMatchObject({ current_revision: 3, target_release: 'demo-order-bbb', target_revision: 2, target_images: ['registry/demo-order:1.4.1'] });
    expect(plan.preconditions.every((p: any) => p.ok)).toBe(true);
    expect(plan.impact.service_dependencies).toEqual([expect.objectContaining({ resource: 'demo-mysql' })]);
    const ex = await invoke(r, 'operation.execute', { id: plan.id, confirm: plan.id }, opts());
    expect(ex.status).toBe('success');
    const res = (ex.data as any).result.rollback;
    expect(res).toMatchObject({ from_revision: 3, to_replicaset: 'demo-order-bbb', new_revision: 4, verified: true, images: ['registry/demo-order:1.4.1'] });
    const patch = state.patches[0];
    expect(patch.contentType).toBe('application/json-patch+json');
    expect(patch.body[0]).toMatchObject({ op: 'test', path: '/metadata/uid' });
    expect(patch.body).toContainEqual({ op: 'test', path: '/metadata/generation', value: 3 });
    expect(patch.body).toContainEqual({ op: 'test', path: '/metadata/annotations/deployment.kubernetes.io~1revision', value: '3' });
    expect(patch.body.find((o: any) => o.op === 'replace').value.metadata.labels['pod-template-hash']).toBeUndefined();
    expect(patch.body[patch.body.length - 1]).toMatchObject({ path: '/metadata/annotations/kubernetes.io~1change-cause' });
    // a plan made before this rollback is stale now: current revision changed → CONFLICT
    const list = await invoke(r, 'deploy.release.list', { service: 'demo-order' }, opts());
    expect((list.data as any).releases[0]).toMatchObject({ id: 'demo-order-bbb', revision: 4, current: true });
    expect((list.data as any).releases[0].status_basis).toContain('回滚复用');
  });

  it('stale plan (current revision changed after planning) → CONFLICT; no allow_execute → refused', async () => {
    const env = await invoke(r, 'deploy.rollback.plan', { service: 'demo-order', to: 'demo-order-ccc' }, opts());
    const plan = env.data as any;
    state.deployment.metadata.annotations['deployment.kubernetes.io/revision'] = '9';
    const ex = await invoke(r, 'operation.execute', { id: plan.id, confirm: plan.id }, opts());
    expect(ex.error?.code).toBe('CONFLICT');
    state.deployment.metadata.annotations['deployment.kubernetes.io/revision'] = '4';
    const ro = writeDeployConfig({ k8sUrl: 'http://127.0.0.1:1', allowExecute: false });
    const p2 = await invoke(r, 'deploy.status.get', { service: 'demo-order' }, { configPath: ro, profile: 'staging' });
    expect(p2.error?.code).toBe('UPSTREAM_UNAVAILABLE');
  });
});

describe('deploy domain (review regressions)', () => {
  it('maskSecrets masks userinfo in any URL scheme, Basic credentials and --password/--token flags', () => {
    expect(maskSecrets('postgres://app:s3cret@db:5432/app')).toBe('postgres://******@db:5432/app');
    expect(maskSecrets('redis://default:pw1@cache:6379')).toBe('redis://******@cache:6379');
    // Basic credentials (base64 of user:password) and --password/--token flags
    expect(maskSecrets('curl -H "Authorization: Basic YWRtaW46cHc=" x')).not.toContain('YWRtaW46cHc=');
    expect(maskSecrets('docker login --password hunter2 reg')).toBe('docker login --password ****** reg');
    expect(maskSecrets('deploy --token abc123 --env sandbox')).toBe('deploy --token ****** --env sandbox');
  });

  it('k8s release get: credentials inside env values masked; a changed secret env still listed in env_changed', async () => {
    const st = k8sDeployFixture();
    const bbb = st.replicasets.find((x) => x.metadata.name === 'demo-order-bbb')!;
    bbb.spec.template.spec.containers[0].env = [
      { name: 'RELEASE_VERSION', value: '1.4.2' },
      { name: 'DB_PASSWORD', value: 'hunter3' },
      { name: 'DATABASE_URL', value: 'postgres://app:s3cret@db:5432/app' },
      { name: 'DB_PWD', value: 'hunter2' },
    ];
    st.replicasets.find((x) => x.metadata.name === 'demo-order-ccc')!.spec.template.spec.containers[0].env.push({ name: 'DATABASE_URL', value: 'postgres://app:s3cret@db:5432/app' });
    const s = await startFakeK8sDeploy(st);
    try {
      const configPath = writeDeployConfig({ k8sUrl: s.url });
      const env = await invoke(r, 'deploy.release.get', { service: 'demo-order', id: '2' }, { configPath, profile: 'staging' });
      expect(env.status).toBe('success');
      const k = (env.data as any).kubernetes;
      expect(k.containers[0].env).toContainEqual({ name: 'DATABASE_URL', value: 'postgres://******@db:5432/app' });
      expect(k.containers[0].env).toContainEqual({ name: 'DB_PWD', value: '******' });
      expect(k.diff_vs_current.env_changed).toEqual(['nginx:DB_PASSWORD', 'nginx:DB_PWD']);
      expect(JSON.stringify(env)).not.toMatch(/s3cret|hunter[23]/);
    } finally {
      s.server.close();
    }
  });

  it('k8s release list: a ReplicaSet reused by a rollback is in the window by its rollout time, not its first creation', async () => {
    const st = k8sDeployFixture();
    const dep = st.deployment;
    // rev 2 (bbb, created 60m ago) was rolled back to as rev 4 after rev 3 (created 10m ago); rev 5 (ddd, 2m ago) is current
    const bbb = st.replicasets.find((x) => x.metadata.name === 'demo-order-bbb')!;
    bbb.metadata.annotations['deployment.kubernetes.io/revision'] = '4';
    bbb.metadata.annotations['deployment.kubernetes.io/revision-history'] = '2';
    st.replicasets.find((x) => x.metadata.name === 'demo-order-ccc')!.spec.replicas = 0;
    st.replicasets.push(replicaset(dep, { hash: 'ddd', revision: 5, image: 'registry/demo-order:1.4.3', replicas: 2, minutesAgo: 2 }));
    dep.metadata.annotations['deployment.kubernetes.io/revision'] = '5';
    const s = await startFakeK8sDeploy(st);
    try {
      const configPath = writeDeployConfig({ k8sUrl: s.url });
      const env = await invoke(r, 'deploy.release.list', { service: 'demo-order', window: '30m' }, { configPath, profile: 'staging' });
      expect(env.status).toBe('success');
      expect((env.data as any).releases.map((x: any) => x.revision)).toEqual([5, 4, 3]);
      expect(env.meta.coverage?.complete).toBe(true);
      // window 5m: rev 4 was live inside the window but its rollout time is only known to be ≥ 10m ago
      const narrow = await invoke(r, 'deploy.release.list', { service: 'demo-order', window: '5m' }, { configPath, profile: 'staging' });
      expect((narrow.data as any).releases.map((x: any) => x.revision)).toEqual([5]);
      expect(narrow.meta.coverage?.complete).toBe(false);
      expect(narrow.meta.coverage?.notes?.join(' ')).toContain('修订 4（回滚复用）');
    } finally {
      s.server.close();
    }
  });

  it('jenkins release list: coverage is incomplete when the build fetch limit cuts into the window; discarder note honest', async () => {
    const builds = [
      ...[1, 2, 3].map((n) => jbuild(n, { version: `v1.${n}`, minutesAgo: 300 - n })),
      ...Array.from({ length: 100 }, (_, i) => jbuild(10 + i, { version: 'x', service: 'busy-svc', minutesAgo: 100 - i })),
    ];
    const s = await startFakeJenkins({ builds, queue: [], console: {}, numToKeep: -1 });
    try {
      const configPath = writeDeployConfig({ jenkinsUrl: s.url });
      const env = await invoke(r, 'deploy.release.list', { service: 'demo-order', window: '7d' }, { configPath });
      expect(env.status).toBe('success');
      expect((env.data as any).releases).toEqual([]);
      expect(env.meta.coverage?.complete).toBe(false);
      expect(env.meta.coverage?.notes?.join(' ')).toContain('窗口内更早的构建未读取');
      // config.xml was read (numToKeep -1 = no count limit): the note must not claim it was unreadable
      expect(env.meta.coverage?.notes?.join(' ')).toContain('未按构建数量限制');
      expect(env.meta.coverage?.notes?.join(' ')).not.toContain('未能读取 config.xml');
    } finally {
      s.server.close();
    }
  });

  it('jenkins status: queue items of a same-named job in another folder are not counted', async () => {
    const s = await startFakeJenkins({
      builds: [jbuild(1, { version: 'v1', minutesAgo: 5 })],
      queue: [{ id: 51, why: 'Waiting', params: '\nSERVICE=demo-order\nENV=sandbox', task: { name: 'deploy-demo-order', url: 'http://jenkins.local/job/team-b/job/deploy-demo-order/' } }],
      console: {},
    });
    try {
      const configPath = writeDeployConfig({ jenkinsUrl: s.url });
      const env = await invoke(r, 'deploy.status.get', { service: 'demo-order' }, { configPath });
      expect(env.data).toMatchObject({ state: 'complete', in_progress: false });
      expect((env.data as any).jenkins.queued).toEqual([]);
    } finally {
      s.server.close();
    }
  });

  it('jenkins: credentials inside parameter values are masked and such builds are not replayable', async () => {
    const b = jbuild(2, { version: 'v1.2', minutesAgo: 20 });
    b.actions[0].parameters.push({ _class: 'hudson.model.StringParameterValue', name: 'ARTIFACT_URL', value: 'https://ci:tok3n@nexus.local/x.tgz' });
    const s = await startFakeJenkins({ builds: [b, jbuild(3, { version: 'v1.3', minutesAgo: 10 })], queue: [], console: {} });
    try {
      const configPath = writeDeployConfig({ jenkinsUrl: s.url });
      const get = await invoke(r, 'deploy.release.get', { service: 'demo-order', id: '2' }, { configPath });
      expect((get.data as any).jenkins.parameters.ARTIFACT_URL).toBe('https://******@nexus.local/x.tgz');
      const plan = await invoke(r, 'deploy.rollback.plan', { service: 'demo-order', to: '2' }, { configPath });
      expect((plan.data as any).preconditions.find((p: any) => p.check === 'parameters_replayable').ok).toBe(false);
      expect(JSON.stringify([get, plan])).not.toContain('tok3n');
    } finally {
      s.server.close();
    }
  });

  it('bindings: an env-specific deploy.target wins over an env-agnostic one listed first', async () => {
    const s = await startFakeJenkins({
      builds: [jbuild(1, { version: 'v1.4.0', minutesAgo: 30 }), jbuild(2, { version: 'v9-prod', env: 'prod', minutesAgo: 5 })],
      queue: [],
      console: {},
    });
    try {
      const configPath = writeDeployConfig({ jenkinsUrl: s.url });
      const dir = dirname(configPath);
      const bind = YAML.parse(readFileSync(join(dir, 'bindings.yaml'), 'utf8'));
      // env-agnostic kubernetes binding listed first
      const k8s = bind.resources.find((x: any) => x.id === 'demo-order-k8s');
      delete k8s.env;
      bind.resources = [k8s, ...bind.resources.filter((x: any) => x !== k8s)];
      writeFileSync(join(dir, 'bindings.yaml'), YAML.stringify(bind));
      const env = await invoke(r, 'deploy.release.list', { service: 'demo-order' }, { configPath });
      expect(env.status).toBe('success');
      expect((env.data as any).target.binding).toBe('demo-order-jenkins');
      // the jenkins provider reports the ignored binding like the kubernetes one does
      expect(env.meta.warnings.join(' ')).toContain('demo-order-k8s');
    } finally {
      s.server.close();
    }
  });
});

describe('deploy domain (review regressions: jenkins executor recheck)', () => {
  it('a new deploy of this service hidden behind 30+ builds of other services still makes the plan stale (CONFLICT)', async () => {
    jenkinsRollbackTiming.pollMs = 10;
    const state: FakeJenkinsState = { builds: [jbuild(1, { version: 'v1.0', minutesAgo: 90 }), jbuild(2, { version: 'v1.1', minutesAgo: 80 })], queue: [], console: {} };
    const s = await startFakeJenkins(state);
    try {
      const configPath = writeDeployConfig({ jenkinsUrl: s.url });
      const plan = (await invoke(r, 'deploy.rollback.plan', { service: 'demo-order', to: '1' }, { configPath })).data as any;
      expect(plan.targets[0]).toMatchObject({ current_build: 2, target_build: 1 });
      // after planning: v1.2 is deployed (#3), then a busy service sharing the job runs 35 builds
      state.builds.push(jbuild(3, { version: 'v1.2', minutesAgo: 60 }));
      for (let n = 4; n < 39; n++) state.builds.push(jbuild(n, { version: 'x', service: 'busy-svc', minutesAgo: 50 - n / 10 }));
      const ex = await invoke(r, 'operation.execute', { id: plan.id, confirm: plan.id }, { configPath });
      expect(ex.error?.code).toBe('CONFLICT');
      expect(state.posts ?? []).toEqual([]);
    } finally {
      s.server.close();
    }
  });
});

describe('deploy domain (review regressions: shared busy jenkins job)', () => {
  it('release get / status get see the current build behind 30-50 newer builds of other services, like release list', async () => {
    const builds = [jbuild(1, { version: 'v1.0', minutesAgo: 120 }), jbuild(2, { version: 'v1.1', minutesAgo: 110 })];
    for (let n = 3; n < 63; n++) builds.push(jbuild(n, { version: 'x', service: 'busy-svc', minutesAgo: 100 - n }));
    const s = await startFakeJenkins({ builds, queue: [], console: {} });
    try {
      const configPath = writeDeployConfig({ jenkinsUrl: s.url });
      const list = await invoke(r, 'deploy.release.list', { service: 'demo-order' }, { configPath });
      expect((list.data as any).releases.find((x: any) => x.current)?.id).toBe('2');
      const get = await invoke(r, 'deploy.release.get', { service: 'demo-order', id: '2' }, { configPath });
      expect((get.data as any).release.current).toBe(true);
      const st = await invoke(r, 'deploy.status.get', { service: 'demo-order' }, { configPath });
      expect(st.data).toMatchObject({ state: 'complete' });
      expect((st.data as any).current_release?.id).toBe('2');
    } finally {
      s.server.close();
    }
  });
});

describe('deploy domain (review regressions: jenkins replay parameters)', () => {
  it('a target build without the ENV parameter is replayed with the bound env, not the job default', async () => {
    const old = jbuild(1, { version: 'v1.0', minutesAgo: 90 });
    old.actions[0].parameters = old.actions[0].parameters.filter((p: any) => p.name !== 'ENV');
    const s = await startFakeJenkins({ builds: [old, jbuild(2, { version: 'v1.1', minutesAgo: 80 })], queue: [], console: {} });
    try {
      const configPath = writeDeployConfig({ jenkinsUrl: s.url });
      const plan = (await invoke(r, 'deploy.rollback.plan', { service: 'demo-order', to: '1' }, { configPath })).data as any;
      expect(plan.params.replay_parameters).toMatchObject({ SERVICE: 'demo-order', VERSION: 'v1.0', ENV: 'sandbox' });
    } finally {
      s.server.close();
    }
  });
});

describe('deploy domain (review regressions: conditional rollback patch)', () => {
  it('a rollout landing between the executor recheck and its PATCH → CONFLICT, template not written', async () => {
    deployRolloutTiming.pollMs = 20;
    const st = k8sDeployFixture();
    const s = await startFakeK8sDeploy(st);
    try {
      const configPath = writeDeployConfig({ k8sUrl: s.url });
      const plan = (await invoke(r, 'deploy.rollback.plan', { service: 'demo-order' }, { configPath, profile: 'staging' })).data as any;
      expect(plan.preconditions.every((p: any) => p.ok)).toBe(true);
      const imageBefore = st.deployment.spec.template.spec.containers[0].image;
      // someone else's rollout: spec changed (generation bumped), controller moved the revision
      st.beforePatch = (dep) => {
        dep.metadata.generation += 1;
        dep.metadata.annotations['deployment.kubernetes.io/revision'] = '5';
        st.beforePatch = undefined;
      };
      const ex = await invoke(r, 'operation.execute', { id: plan.id, confirm: plan.id }, { configPath, profile: 'staging' });
      expect(ex.error?.code).toBe('CONFLICT');
      expect(ex.error?.hint).toContain('重新生成回滚计划');
      expect(st.patches).toHaveLength(1);
      expect(st.deployment.spec.template.spec.containers[0].image).toBe(imageBefore);
      expect(st.deployment.metadata.annotations['kubernetes.io/change-cause']).toBe('release 1.4.2');
      const got = await invoke(r, 'operation.get', { id: plan.id }, { configPath, profile: 'staging' });
      expect((got.data as any).status).toBe('failed');
    } finally {
      s.server.close();
    }
  });
});
