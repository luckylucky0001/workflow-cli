import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config';
import { invoke } from '../../src/core/engine';
import type { Envelope } from '../../src/core/output';
import type { Plan } from '../../src/core/operations';
import { Registry } from '../../src/core/registry';
import { Ctx } from '../../src/core/runtime';
import { builtinRegistry } from '../../src/domains';
import container from '../../src/domains/container';
import { rolloutTiming } from '../../src/domains/container/k8s-restart';
import { parseGoDuration } from '../../src/domains/container/k8s-workload';
import { parseForbidden, parseQuantity, selectorString } from '../../src/domains/container/kubernetes';
import { deployment, event, node, pod, podMetric, SA_USER, startFakeK8s, TOKEN, writeK8sConfig, type FakeK8sState } from './fake-k8s';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';

describe('kubernetes helpers (pure)', () => {
  it('parses resource quantities, Go durations and RBAC denials', () => {
    expect(parseQuantity('500m')).toBe(0.5);
    expect(parseQuantity('250000000n')).toBe(0.25);
    expect(parseQuantity('2')).toBe(2);
    expect(parseQuantity('256Mi')).toBe(268435456);
    expect(parseQuantity('1Gi')).toBe(1073741824);
    expect(parseQuantity('129M')).toBe(129e6);
    expect(parseQuantity('8048288Ki')).toBe(8048288 * 1024);
    expect(parseQuantity('bogus')).toBeNull();
    expect(parseGoDuration('15.012s')).toBe(15012);
    expect(parseGoDuration('1m0.5s')).toBe(60500);
    expect(selectorString({ matchLabels: { app: 'a' }, matchExpressions: [{ key: 'tier', operator: 'In', values: ['web', 'api'] }, { key: 'canary', operator: 'DoesNotExist' }] })).toBe(
      'app=a,tier in (web,api),!canary',
    );
    expect(parseForbidden(`deployments.apps "x" is forbidden: User "${SA_USER}" cannot patch resource "deployments" in API group "apps" in the namespace "demo"`)).toEqual({
      user: SA_USER,
      verb: 'patch',
      resource: 'deployments',
      group: 'apps',
      namespace: 'demo',
    });
  });
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------
const ORDER_LABELS = { app: 'demo-order' };
const RS = 'demo-order-7c9d8f6b5';
function freshState(): FakeK8sState {
  const order = deployment({ name: 'demo-order', labels: ORDER_LABELS, replicas: 2 });
  const pay = deployment({ name: 'demo-pay', labels: { app: 'demo-pay', tier: 'api' }, replicas: 1, limits: { memory: '128Mi' }, requests: {} });
  pay.status.availableReplicas = 0;
  pay.status.readyReplicas = 0;
  const p1 = pod({
    name: `${RS}-x2k4q`,
    labels: { ...ORDER_LABELS, 'pod-template-hash': '7c9d8f6b5', 'workctl.env': 'sandbox' },
    rs: RS,
    restartCount: 2,
    lastTerminated: { exitCode: 137, reason: 'OOMKilled', startedAt: '2026-10-17T11:00:00Z', finishedAt: '2026-10-17T11:19:58Z', containerID: 'containerd://old' },
  });
  const p2 = pod({ name: `${RS}-m8n3z`, labels: { ...ORDER_LABELS, 'pod-template-hash': '7c9d8f6b5', 'workctl.env': 'sandbox' }, rs: RS, node: 'k3s-node-2' });
  const prod = pod({ name: 'demo-order-prod-6b7c8d9e0-aaaaa', labels: { ...ORDER_LABELS, 'workctl.env': 'prod' }, rs: 'demo-order-prod-6b7c8d9e0' });
  const lookalike = pod({ name: 'demo-order-like-name-0', labels: { app: 'something-else' } });
  const payPod = pod({
    name: 'demo-pay-5d4c7b9f8-q1w2e',
    labels: { app: 'demo-pay', tier: 'api', 'pod-template-hash': '5d4c7b9f8' },
    rs: 'demo-pay-5d4c7b9f8',
    restartCount: 5,
    waiting: { reason: 'CrashLoopBackOff', message: 'back-off 5m0s restarting failed container=nginx pod=demo-pay-5d4c7b9f8-q1w2e_demo(...)' },
    limits: { memory: '128Mi' },
    requests: {},
    ready: false,
  });
  const rsObj = { kind: 'ReplicaSet', apiVersion: 'apps/v1', metadata: { name: RS, namespace: 'demo', uid: p1.metadata.ownerReferences[0].uid, resourceVersion: '1' } };
  const oldPod = { kind: 'Pod', apiVersion: 'v1', metadata: { name: 'demo-order-5b6c7d8e9-old00', namespace: 'demo', uid: 'p-old', resourceVersion: '1' } };
  return {
    deployments: [order, pay],
    pods: [p1, p2, prod, lookalike, payPod],
    events: [
      event({ involved: order, reason: 'ScalingReplicaSet', message: `Scaled up replica set ${RS} to 2`, secondsAgo: 600 }),
      event({ involved: rsObj, reason: 'SuccessfulCreate', message: `Created pod: ${RS}-m8n3z`, secondsAgo: 590 }),
      event({ involved: p1, reason: 'BackOff', message: 'Back-off restarting failed container nginx in pod', type: 'Warning', secondsAgo: 120, count: 4, firstSecondsAgo: 1500 }),
      event({ involved: p1, reason: 'Started', message: 'Started container nginx', secondsAgo: 100 }),
      event({ involved: oldPod, reason: 'Killing', message: 'Stopping container nginx', secondsAgo: 300 }),
      event({ involved: lookalike, reason: 'Started', message: 'Started container nginx', secondsAgo: 50 }),
      event({ involved: p2, reason: 'Pulled', message: 'Container image "nginx:1.27-alpine" already present on machine', secondsAgo: 7200 }),
      event({ involved: payPod, reason: 'BackOff', message: 'Back-off restarting failed container nginx', type: 'Warning', secondsAgo: 30, count: 12 }),
    ],
    podMetrics: [podMetric(p1, '250000000n', '200Mi'), podMetric(p2, '5m', '32Mi'), podMetric(prod, '1m', '10Mi'), podMetric(lookalike, '1m', '1Mi')],
    nodes: [node('k3s-node-1'), node('k3s-node-2')],
    forbidden: new Set(),
    statefulsets: [],
    rollout: { mode: 'complete' },
  };
}

function noSchemaWarnings(env: Envelope) {
  expect(env.meta.warnings.filter((w) => w.includes('schema'))).toEqual([]);
}

describe('container domain against a fake Kubernetes API (v1.31 shapes)', () => {
  let state: FakeK8sState;
  let fake: Awaited<ReturnType<typeof startFakeK8s>>;
  let configPath: string;
  const r = new Registry();
  r.addDomain(container);
  const savedTiming = { ...rolloutTiming };

  beforeAll(async () => {
    state = freshState();
    fake = await startFakeK8s(state);
    configPath = writeK8sConfig(fake.dir, { server: fake.url });
    Object.assign(rolloutTiming, { pollMs: 50, verifyMs: 1_500 });
  });
  afterAll(async () => {
    Object.assign(rolloutTiming, savedTiming);
    await fake.close();
  });
  afterEach(() => {
    // restore mutable fixtures between tests
    const s = freshState();
    Object.assign(state, s);
  });

  it('workload get selects pods by the binding label selector (never by name) and maps pod/container state', async () => {
    const env = await invoke(r, 'container.workload.get', { service: 'demo-order', env: 'sandbox' }, { configPath });
    expect(env.status).toBe('success');
    expect(env.meta.warnings).toEqual([]);
    const d = env.data as any;
    expect(d.provider).toBe('kubernetes');
    expect(d.selector).toMatchObject({ kind: 'label', label: 'app=demo-order', origin: 'binding-file' });
    expect(d.selector.matched_by).toContain('binding demo-order-k8s.labels');
    expect(d.selector.evidence).toContain('runs_on demo-order-k8s');
    // the look-alike pod and the prod pod are not included
    expect(d.containers.map((c: any) => c.name)).toEqual([`${RS}-m8n3z/nginx`, `${RS}-x2k4q/nginx`]);
    const c = d.containers.find((x: any) => x.name.includes('x2k4q'));
    expect(c).toMatchObject({ state: 'running', health: 'healthy', restart_count: 2, oom_killed: true, exit_code: 137, restart_policy: 'Always', image: 'nginx:1.27-alpine' });
    expect(c.limits).toMatchObject({ cpus: 0.5, memory_bytes: 268435456 });
    expect(c.kubernetes).toMatchObject({ namespace: 'demo', node: 'k3s-node-1', phase: 'Running', pod_ready: true, owner: `ReplicaSet/${RS}`, requests: { cpus: 0.1, memory_bytes: 67108864 } });
    expect(c.kubernetes.last_termination).toMatchObject({ reason: 'OOMKilled', exit_code: 137 });
    expect(c.ports[0]).toMatchObject({ container_port: 80, protocol: 'tcp', host_port: null });
    expect(c.mounts.find((m: any) => m.name === 'html')).toMatchObject({ type: 'configMap', source: 'demo-order-html', rw: false });
    expect(d.summary).toEqual({ total: 2, running: 2, unhealthy: 0, oom_killed: 1, restarted: 1 });
    expect(d.kubernetes.workloads.map((w: any) => w.name)).toEqual(['demo-order']);
    expect(env.meta.coverage?.notes?.join()).toContain('demo-order-prod-6b7c8d9e0-aaaaa(prod)');
    expect(env.meta.coverage?.notes?.join()).toContain('不按名称相似度');
    const src = env.meta.sources[0];
    expect(src).toMatchObject({ system: 'kubernetes', adapter: 'kubernetes-api', version: 'v1.31.4+k3s1' });
    expect(src.method).toMatch(/^GET \/apis\/apps\/v1\/namespaces\/demo\/deployments/);
    expect(env.meta.sources.some((s) => s.method === 'GET /api/v1/namespaces/demo/pods?labelSelector=app=demo-order')).toBe(true);
    expect(env.meta.sources.some((s) => s.adapter === 'resource-bindings' && s.relation === 'explicit')).toBe(true);
    expect(fake.calls.some((x) => x.includes('labelSelector=app%3Ddemo-order'))).toBe(true);
  });

  it('workload get via attributes.deployment uses the Deployment spec.selector and reports CrashLoopBackOff', async () => {
    const env = await invoke(r, 'container.workload.get', { service: 'demo-pay' }, { configPath });
    expect(env.status).toBe('success');
    noSchemaWarnings(env);
    const d = env.data as any;
    expect(d.selector.label).toBe('app=demo-pay,tier=api');
    expect(d.selector.matched_by).toContain('Deployment demo/demo-pay 的 spec.selector');
    expect(d.containers).toHaveLength(1);
    expect(d.containers[0]).toMatchObject({ state: 'restarting', health: 'unhealthy', restart_count: 5, oom_killed: false });
    expect(d.containers[0].limits).toMatchObject({ cpus: null, memory_bytes: 134217728 });
    expect(d.containers[0].kubernetes.state_reason).toBe('CrashLoopBackOff');
    expect(d.summary.unhealthy).toBe(1);
  });

  it('a binding to a missing Deployment is an empty success with a warning, not a guess', async () => {
    const env = await invoke(r, 'container.workload.get', { service: 'demo-ghost' }, { configPath });
    expect(env.status).toBe('success');
    expect((env.data as any).containers).toEqual([]);
    expect(env.meta.warnings.join()).toContain('demo/demo-ghost 不存在');
  });

  it('services without a kubernetes binding stay on the Docker provider', async () => {
    const env = await invoke(r, 'container.workload.get', { service: 'demo-mysql' }, { configPath });
    expect(env.status).toBe('error');
    expect(env.error?.code).toBe('NOT_CONFIGURED');
    expect(env.error?.message).toContain('docker');
  });

  it('event list returns the service objects’ events in the window and states the event-ttl coverage', async () => {
    const env = await invoke(r, 'container.event.list', { service: 'demo-order', window: '1h' }, { configPath });
    expect(env.status).toBe('success');
    expect(env.meta.warnings).toEqual([]);
    const d = env.data as any;
    expect(d.events.map((e: any) => `${e.type}:${e.action}`)).toEqual(['deployment:ScalingReplicaSet', 'replicaset:SuccessfulCreate', 'pod:BackOff', 'pod:Started']);
    const backoff = d.events.find((e: any) => e.action === 'BackOff');
    expect(backoff.attributes).toMatchObject({ event_type: 'Warning', count: '4', namespace: 'demo', reporting_component: 'kubelet' });
    expect(backoff.container_name).toBe(`${RS}-x2k4q`);
    expect(d.counts_by_action).toMatchObject({ BackOff: 1, Started: 1 });
    expect(d.retention).toEqual({ kind: 'kubernetes-event-ttl', ttl: '1h', configured: false });
    expect(d.daemon_buffer_full).toBe(false);
    expect(env.meta.coverage?.complete).toBe(true);
    const notes = env.meta.coverage?.notes?.join() ?? '';
    expect(notes).toContain('event-ttl');
    expect(notes).toContain('旧 Pod 的事件不按名称推断归属');
    expect(notes).toContain('1 条相关事件的时间不在窗口内');
    expect(env.meta.sources.some((s) => s.method?.startsWith('GET /api/v1/namespaces/demo/events'))).toBe(true);
  });

  it('event list with a window longer than the event TTL is marked incomplete', async () => {
    const env = await invoke(r, 'container.event.list', { service: 'demo-order', window: '6h' }, { configPath });
    expect(env.status).toBe('success');
    noSchemaWarnings(env);
    expect(env.meta.coverage).toMatchObject({ complete: false, truncated: true });
    const d = env.data as any;
    expect(Date.parse(d.visible_since)).toBeGreaterThan(Date.parse(d.window.start));
    expect(env.meta.coverage?.notes?.join()).toContain('超过事件保留时间 1h');
  });

  it('stats get is a metrics-server snapshot with limits from the pod spec', async () => {
    const env = await invoke(r, 'container.stats.get', { service: 'demo-order' }, { configPath });
    expect(env.status).toBe('success');
    expect(env.meta.warnings).toEqual([]);
    const d = env.data as any;
    expect(d.kind).toBe('snapshot');
    expect(d.provider).toBe('kubernetes');
    expect(d.matched_by).toContain('app=demo-order');
    const s = d.containers.find((c: any) => c.name.includes('x2k4q')).stats;
    expect(s.cpu).toEqual({ cores_used: 0.25, percent: 25, online_cpus: 4, percent_of_limit: 50 });
    expect(s.memory).toMatchObject({ working_set_bytes: 200 * 1024 * 1024, limit_bytes: 268435456, limit_source: 'container' });
    expect(s.memory.percent_of_limit).toBeCloseTo(78.13, 1);
    expect(s.sample_interval_ms).toBe(15012);
    expect(s.pids).toBeNull();
    expect(s.network).toBeNull();
    expect(env.meta.coverage?.window).toBeUndefined();
    expect(env.meta.coverage?.scope).toContain('snapshot');
    expect(env.meta.sources.find((x) => x.method?.includes('metrics.k8s.io'))?.relation).toBe('sampled');
  });

  it('stats get without the metrics.k8s.io API is COLLECTION_DISABLED, not zero usage', async () => {
    state.podMetrics = null;
    const env = await invoke(r, 'container.stats.get', { service: 'demo-order' }, { configPath });
    expect(env.status).toBe('error');
    expect(env.error?.code).toBe('COLLECTION_DISABLED');
    expect(env.error?.hint).toContain('metrics-server');
  });

  it('capacity summary (auto → kubernetes) compares requests/limits with metrics and node allocatable', async () => {
    const env = await invoke(r, 'container.capacity.summary', { env: 'sandbox' }, { configPath });
    expect(env.status).toBe('success');
    expect(env.meta.warnings).toEqual([]);
    const d = env.data as any;
    expect(d.host).toMatchObject({ ncpu: 8, docker_version: 'containerd://1.7.23-k3s2', provider: 'kubernetes' });
    expect(d.host.kubernetes).toMatchObject({ server_version: 'v1.31.4+k3s1', nodes: 2, namespaces: ['demo'], capacity_known: true });
    // prod-labelled pod excluded; look-alike pod is in the namespace and counted (namespace scope)
    expect(d.totals.containers).toBe(4);
    expect(d.totals.cpu_request_sum).toBe(0.3);
    const pay = d.containers.find((c: any) => c.name.startsWith('demo-pay'));
    expect(pay.flags).toEqual(expect.arrayContaining(['no_cpu_limit', 'auto_restarted', 'no_cpu_request', 'no_memory_request']));
    const oom = d.containers.find((c: any) => c.name.includes('x2k4q'));
    expect(oom.flags).toContain('oom_killed_last_exit');
    expect(oom.usage.cpu_cores).toBe(0.25);
    expect(env.meta.coverage?.notes?.join()).toContain('demo-order-prod-6b7c8d9e0-aaaaa');
  });

  it('capacity summary without metrics-server or node access is partial and says why', async () => {
    state.podMetrics = null;
    state.forbidden = new Set(['list nodes']);
    const env = await invoke(r, 'container.capacity.summary', { env: 'sandbox', provider: 'kubernetes' }, { configPath });
    expect(env.status).toBe('partial');
    noSchemaWarnings(env);
    const d = env.data as any;
    expect(d.containers.every((c: any) => c.usage === null)).toBe(true);
    expect(d.host.kubernetes.capacity_known).toBe(false);
    expect(d.host.ncpu).toBe(0);
    const notes = env.meta.coverage?.notes?.join() ?? '';
    expect(notes).toContain('COLLECTION_DISABLED');
    expect(notes).toContain('list nodes');
    expect(env.meta.coverage?.complete).toBe(false);
  });

  it('maps RBAC 403 to PERMISSION_DENIED with the verb and resource from the Status message', async () => {
    state.forbidden = new Set(['list pods']);
    const env = await invoke(r, 'container.workload.get', { service: 'demo-order' }, { configPath });
    expect(env.status).toBe('error');
    expect(env.error?.code).toBe('PERMISSION_DENIED');
    expect(env.error?.message).toContain('list pods');
    expect((env.error?.details as any).rbac).toMatchObject({ verb: 'list', resource: 'pods', namespace: 'demo', user: SA_USER });
    expect(env.error?.hint).toContain('Role');
  });

  it('maps 401 to UNAUTHENTICATED and an unreachable server to UPSTREAM_UNAVAILABLE', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'workctl-k8s-badtoken-'));
    const bad = writeK8sConfig(dir, { server: fake.url, token: 'wrong' });
    const e1 = await invoke(r, 'container.workload.get', { service: 'demo-order' }, { configPath: bad });
    expect(e1.error?.code).toBe('UNAUTHENTICATED');
    const dir2 = mkdtempSync(join(tmpdir(), 'workctl-k8s-down-'));
    const down = writeK8sConfig(dir2, { server: 'http://127.0.0.1:1' });
    const e2 = await invoke(r, 'container.workload.get', { service: 'demo-order' }, { configPath: down });
    expect(e2.error?.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(e2.error?.message).toContain('ECONNREFUSED');
  });

  it('reads server and token for the chosen context from a kubeconfig', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'workctl-k8s-kubeconfig-'));
    writeFileSync(
      join(dir, 'kubeconfig.yaml'),
      `apiVersion: v1
kind: Config
current-context: other
clusters:
  - name: k3s
    cluster: { server: ${fake.url} }
  - name: other
    cluster: { server: http://127.0.0.1:1 }
users:
  - name: workctl
    user: { token: ${TOKEN} }
contexts:
  - name: k3s
    context: { cluster: k3s, user: workctl, namespace: demo }
  - name: other
    context: { cluster: other, user: workctl }
`,
    );
    const p = writeK8sConfig(dir, { server: fake.url, endpoint: { kubeconfig: './kubeconfig.yaml', context: 'k3s' } });
    const env = await invoke(r, 'container.workload.get', { service: 'demo-order' }, { configPath: p });
    expect(env.status).toBe('success');
    expect(env.meta.sources[0].endpoint).toContain('context k3s');
    expect((env.data as any).containers).toHaveLength(2);
  });

  async function planAndRun(service = 'demo-order') {
    const env = await invoke(r, 'container.workload.restart_plan', { service }, { configPath });
    expect(env.status).toBe('success');
    const plan = env.data as Plan;
    const ctx = new Ctx({ registry: r, loaded: loadConfig(configPath), profileName: 't', requestId: 'req-test', timeoutMs: 20_000 });
    return { plan, run: () => r.executors.get('container.restart')!(ctx, plan, () => undefined) as Promise<any> };
  }

  it('restart plan targets the Deployment (rollout restart), is not idempotent and does not patch anything', async () => {
    const env = await invoke(r, 'container.workload.restart_plan', { service: 'demo-order' }, { configPath });
    expect(env.status).toBe('success');
    expect(env.meta.warnings).toEqual([]);
    const plan = env.data as any;
    expect(plan.kind).toBe('container.restart');
    expect(plan.idempotent).toBe(false);
    expect(plan.params).toMatchObject({ provider: 'kubernetes', endpoint: 'k3s', namespace: 'demo' });
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]).toMatchObject({ kind: 'Deployment', name: 'demo-order', namespace: 'demo', replicas: 2, pods: 2, selector: 'app=demo-order', workload_selector: 'app=demo-order' });
    expect(plan.preconditions.every((p: any) => p.ok)).toBe(true);
    expect(plan.steps[0].detail).toContain('PATCH /apis/apps/v1/namespaces/demo/deployments/demo-order');
    expect(plan.impact.service_dependencies[0].resource).toBe('demo-order-k8s');
    expect(env.meta.sources[0]).toMatchObject({ system: 'kubernetes', adapter: 'kubernetes-api' });
    expect(fake.calls.some((c) => c.startsWith('PATCH'))).toBe(false);
  });

  it('restart execute patches restartedAt and verifies the rollout completed', async () => {
    const { run } = await planAndRun();
    const before = fake.bodies.length;
    const res = await run();
    expect(res.verified_all).toBe(true);
    expect(res.provider).toBe('kubernetes');
    expect(res.restarted[0]).toMatchObject({ kind: 'Deployment', name: 'demo-order', generation_before: 3, generation_after: 4, verified: true });
    expect(res.restarted[0].status).toMatchObject({ observed_generation: 4, updated_replicas: 2, available_replicas: 2 });
    const patch = fake.bodies[before];
    expect(Object.keys(patch.spec.template.metadata.annotations)).toEqual(['kubectl.kubernetes.io/restartedAt']);
    expect(patch.spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt']).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });

  it('restart execute reports a rollout that does not finish as TIMEOUT (not success)', async () => {
    state.rollout = { mode: 'stuck', afterMs: 50 };
    const { run } = await planAndRun();
    const err = await run().catch((e) => e);
    expect(err.code).toBe('TIMEOUT');
    expect(err.message).toContain('rollout');
    expect(err.details.outcomes[0].verified).toBe(false);
    expect(err.hint).toContain('不要直接重试');
  });

  it('restart execute reports ProgressDeadlineExceeded as a failed rollout', async () => {
    state.rollout = { mode: 'deadline', afterMs: 50 };
    const { run } = await planAndRun();
    const err = await run().catch((e) => e);
    expect(err.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(err.message).toContain('ProgressDeadlineExceeded');
  });

  it('restart execute without patch permission is PERMISSION_DENIED naming patch deployments', async () => {
    state.forbidden = new Set(['patch deployments']);
    const { run } = await planAndRun();
    const err = await run().catch((e) => e);
    expect(err.code).toBe('PERMISSION_DENIED');
    expect(err.message).toContain('patch deployments.apps');
  });

  it('restart execute refuses when the Deployment was recreated since planning', async () => {
    const { run } = await planAndRun();
    state.deployments[0].metadata.uid = 'recreated-uid';
    const patches = fake.calls.filter((c) => c.startsWith('PATCH')).length;
    const err = await run().catch((e) => e);
    expect(err.code).toBe('PRECONDITION_FAILED');
    expect(err.message).toContain('uid');
    expect(fake.calls.filter((c) => c.startsWith('PATCH')).length).toBe(patches);
  });

  it('restart plan with an in-progress rollout has a failed precondition', async () => {
    state.deployments[0].status.observedGeneration = 2;
    const env = await invoke(r, 'container.workload.restart_plan', { service: 'demo-order' }, { configPath });
    const plan = env.data as any;
    expect(plan.preconditions.find((p: any) => p.check === 'no_rollout_in_progress').ok).toBe(false);
  });

  it('end to end through the core: auth status --probe, operation plan and operation execute', async () => {
    const reg = builtinRegistry();
    const auth = await invoke(reg, 'auth.status', { probe: true }, { configPath });
    expect(auth.status).toBe('success');
    noSchemaWarnings(auth);
    const ep = (auth.data as any).endpoints.find((e: any) => e.kind === 'kubernetes');
    expect(ep.probe).toMatchObject({ ok: true, version: 'v1.31.4+k3s1', identity: expect.stringContaining(SA_USER) });
    expect(ep.probe.privileges.join(' | ')).toContain('get,list,patch deployments [apps]');
    expect(ep.credential_refs[0]).toMatchObject({ key: 'token_ref', ref_type: 'file', resolvable: true });
    const planned = await invoke(reg, 'operation.plan', { action: 'container.restart', param: ['service=demo-order'] }, { configPath });
    expect(planned.status).toBe('success');
    noSchemaWarnings(planned);
    const id = (planned.data as any).id;
    const done = await invoke(reg, 'operation.execute', { id, confirm: id }, { configPath, timeoutMs: 20_000 });
    expect(done.status).toBe('success');
    noSchemaWarnings(done);
    expect((done.data as any).status).toBe('succeeded');
    expect((done.data as any).result.verified_all).toBe(true);
  });

  // ---- review regressions -------------------------------------------------------------------
  it('a stale ProgressDeadlineExceeded from an earlier rollout does not fail the new one before it is observed', async () => {
    const { rolloutState } = await import('../../src/domains/container/k8s-restart');
    const w = state.deployments[0] as any;
    w.metadata.generation = 4;
    w.status.observedGeneration = 3; // controller has not seen the restart yet
    w.status.conditions = w.status.conditions.map((c: any) => (c.type === 'Progressing' ? { ...c, status: 'False', reason: 'ProgressDeadlineExceeded' } : c));
    expect(rolloutState(w, 'Deployment', 4)).toMatchObject({ done: false, failed: false });
    w.status.observedGeneration = 4;
    expect(rolloutState(w, 'Deployment', 4)).toMatchObject({ done: false, failed: true });
  });

  it('a paused Deployment: failed plan precondition, executor refuses without patching', async () => {
    state.deployments[0].spec.paused = true;
    const env = await invoke(r, 'container.workload.restart_plan', { service: 'demo-order' }, { configPath });
    const plan = env.data as Plan;
    expect(plan.preconditions.find((p) => p.check === 'deployment_not_paused')?.ok).toBe(false);
    const ctx = new Ctx({ registry: r, loaded: loadConfig(configPath), profileName: 't', requestId: 'req-test', timeoutMs: 20_000 });
    const patches = fake.calls.filter((c) => c.startsWith('PATCH')).length;
    const err = await (r.executors.get('container.restart')!(ctx, plan, () => undefined) as Promise<any>).catch((e) => e);
    expect(err.code).toBe('PRECONDITION_FAILED');
    expect(fake.calls.filter((c) => c.startsWith('PATCH')).length).toBe(patches);
  });

  it('a PATCH that does not bump the generation is not reported as a completed restart', async () => {
    state.patchNoop = true;
    const { run } = await planAndRun();
    const err = await run().catch((e) => e);
    expect(err.code).toBe('CONFLICT');
    expect(err.message).toContain('generation');
  });

  it('pods matching a Deployment selector but owned by another controller (or none) are excluded', async () => {
    const pay = state.deployments.find((d: any) => d.metadata.name === 'demo-pay')!;
    const rsUid = state.pods.find((p: any) => p.metadata.name.startsWith('demo-pay-'))!.metadata.ownerReferences[0].uid;
    state.replicasets = [
      { kind: 'ReplicaSet', apiVersion: 'apps/v1', metadata: { name: 'demo-pay-5d4c7b9f8', namespace: 'demo', uid: rsUid, labels: { app: 'demo-pay', tier: 'api' }, ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name: 'demo-pay', uid: pay.metadata.uid, controller: true }] } },
    ];
    state.pods.push(pod({ name: 'debug-copy-of-pay', labels: { app: 'demo-pay', tier: 'api' } })); // bare pod, same labels
    const env = await invoke(r, 'container.workload.get', { service: 'demo-pay' }, { configPath });
    noSchemaWarnings(env);
    const d = env.data as any;
    expect(d.containers.map((c: any) => c.kubernetes.pod)).toEqual(['demo-pay-5d4c7b9f8-q1w2e']);
    expect(env.meta.coverage?.notes?.join()).toContain('debug-copy-of-pay');
  });

  it('binding label values cannot inject selector syntax', async () => {
    expect(() => selectorString({ matchLabels: { app: 'demo-order,workctl.env!=prod' } })).toThrow(/不合法/);
    expect(() => selectorString({ matchLabels: { 'bad key': 'x' } })).toThrow(/不合法/);
    expect(selectorString({ matchLabels: { 'app.kubernetes.io/name': 'demo-order', empty: '' } })).toBe('app.kubernetes.io/name=demo-order,empty=');
    const bindings = readFileSync(join(fake.dir, 'bindings.yaml'), 'utf8');
    writeFileSync(join(fake.dir, 'bindings.yaml'), bindings.replace('labels: { app: demo-order }', 'labels: { app: "demo-order,tier notin (x)" }'));
    try {
      const env = await invoke(r, 'container.workload.get', { service: 'demo-order' }, { configPath });
      expect(env.error?.code).toBe('INVALID_ARGUMENT');
      expect(fake.calls.some((c) => c.includes('notin'))).toBe(false);
    } finally {
      writeFileSync(join(fake.dir, 'bindings.yaml'), bindings);
    }
  });

  it('a kubeconfig parse error does not echo file content (tokens, keys)', async () => {
    const { loadKubeconfig } = await import('../../src/domains/container/kubernetes');
    const kc = join(fake.dir, 'broken-kubeconfig.yaml');
    writeFileSync(kc, 'users:\n- name: a\n  user:\n    token: [SUPERSECRETTOKEN\n'); // parser error points at the token line
    const err = (() => {
      try {
        loadKubeconfig(kc);
      } catch (e) {
        return e as any;
      }
    })();
    expect(err.code).toBe('INVALID_ARGUMENT');
    expect(JSON.stringify({ m: err.message, d: err.details, h: err.hint })).not.toContain('SUPERSECRET');
  });
});

function haveOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!haveOpenssl())('kubernetes provider over TLS (self-signed API server certificate)', () => {
  let fake: Awaited<ReturnType<typeof startFakeK8s>>;
  let dir: string;
  const r = new Registry();
  r.addDomain(container);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'workctl-k8s-tls-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=k3s-fake', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(dir, 'tls.key'), '-out', join(dir, 'ca.crt')], { stdio: 'ignore' });
    fake = await startFakeK8s(freshState(), { key: readFileSync(join(dir, 'tls.key')), cert: readFileSync(join(dir, 'ca.crt')) });
  });
  afterAll(async () => fake?.close());

  it('verifies the server with ca_file, refuses an unknown CA and only skips verification when configured', async () => {
    const ok = writeK8sConfig(dir, { server: fake.url, endpoint: { server: fake.url, token_ref: 'file:k8s-token', ca_file: './ca.crt', namespace: 'demo' } });
    const env = await invoke(r, 'container.workload.get', { service: 'demo-order' }, { configPath: ok });
    expect(env.status).toBe('success');
    expect((env.data as any).containers).toHaveLength(2);

    const d2 = mkdtempSync(join(tmpdir(), 'workctl-k8s-tls-noca-'));
    const noCa = writeK8sConfig(d2, { server: fake.url });
    const bad = await invoke(r, 'container.workload.get', { service: 'demo-order' }, { configPath: noCa });
    expect(bad.error?.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(bad.error?.message).toContain('TLS');

    const d3 = mkdtempSync(join(tmpdir(), 'workctl-k8s-tls-insecure-'));
    const insecure = writeK8sConfig(d3, { server: fake.url, endpoint: { server: fake.url, token_ref: 'file:k8s-token', insecure_skip_tls_verify: true, namespace: 'demo' } });
    const env3 = await invoke(r, 'container.workload.get', { service: 'demo-order' }, { configPath: insecure });
    expect(env3.status).toBe('success');
    expect(env3.meta.warnings.join()).toContain('insecure_skip_tls_verify');
  });

  it('accepts certificate-authority-data from a kubeconfig', async () => {
    const d = mkdtempSync(join(tmpdir(), 'workctl-k8s-tls-kc-'));
    const ca = readFileSync(join(dir, 'ca.crt')).toString('base64');
    writeFileSync(
      join(d, 'kubeconfig.yaml'),
      `apiVersion: v1\nkind: Config\ncurrent-context: k3s\nclusters:\n  - name: k3s\n    cluster: { server: ${fake.url}, certificate-authority-data: ${ca} }\nusers:\n  - name: u\n    user: { token: ${TOKEN} }\ncontexts:\n  - name: k3s\n    context: { cluster: k3s, user: u, namespace: demo }\n`,
    );
    const p = writeK8sConfig(d, { server: fake.url, endpoint: { kubeconfig: './kubeconfig.yaml' } });
    const env = await invoke(r, 'container.workload.get', { service: 'demo-order' }, { configPath: p });
    expect(env.status).toBe('success');
  });
});
