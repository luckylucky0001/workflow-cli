import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config';
import { invoke } from '../../src/core/engine';
import type { Plan } from '../../src/core/operations';
import { Registry } from '../../src/core/registry';
import { Ctx } from '../../src/core/runtime';
import container from '../../src/domains/container';
import { restartTiming } from '../../src/domains/container/restart';
import { startFakeDocker, writeTestConfig, type FakeDockerState } from './fake-docker';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';

const now = Math.floor(Date.now() / 1000);
const state: FakeDockerState = {
  containers: [
    { Id: 'm1'.padEnd(64, '0'), Name: 'demo-mysql', Labels: { 'workctl.resource': 'demo-mysql', 'workctl.env': 'sandbox' }, State: 'running' },
    { Id: 'm2'.padEnd(64, '0'), Name: 'demo-mysql-backup', Labels: { 'workctl.env': 'sandbox' }, State: 'running' },
    { Id: 'r1'.padEnd(64, '0'), Name: 'demo-redis', Labels: { 'workctl.resource': 'demo-redis', 'workctl.env': 'sandbox' }, State: 'running' },
    { Id: 'k1'.padEnd(64, '0'), Name: 'cache-x', Labels: { 'workctl.env': 'sandbox' }, State: 'running' },
    { Id: 'u1'.padEnd(64, '0'), Name: 'svc-unhealthy', Labels: { 'workctl.service': 'svc-unhealthy', 'workctl.env': 'sandbox' }, State: 'running', Health: 'unhealthy' },
    { Id: 'h1'.padEnd(64, '0'), Name: 'svc-healthy', Labels: { 'workctl.service': 'svc-healthy', 'workctl.env': 'sandbox' }, State: 'running', Health: 'healthy' },
    { Id: 'p1'.padEnd(64, '0'), Name: 'svc-pair-1', Labels: { 'workctl.service': 'svc-pair', 'workctl.env': 'sandbox' }, State: 'running' },
    { Id: 'p2'.padEnd(64, '0'), Name: 'svc-pair-2', Labels: { 'workctl.service': 'svc-pair', 'workctl.env': 'sandbox' }, State: 'running' },
    { Id: 'x1'.padEnd(64, '0'), Name: 'svc-crash', Labels: { 'workctl.service': 'svc-crash', 'workctl.env': 'sandbox' }, State: 'running' },
  ],
  events: [
    { Type: 'container', Action: 'start', Actor: { ID: 'm1'.padEnd(64, '0'), Attributes: { name: 'demo-mysql', 'workctl.resource': 'demo-mysql' } }, time: now - 30 },
    { Type: 'container', Action: 'die', Actor: { ID: 'm2'.padEnd(64, '0'), Attributes: { name: 'demo-mysql-backup' } }, time: now - 20 },
  ],
};

describe('service/resource → container selection and restart verification', () => {
  let fake: Awaited<ReturnType<typeof startFakeDocker>>;
  let configPath: string;
  const r = new Registry();
  r.addDomain(container);
  const saved = { ...restartTiming };

  beforeAll(async () => {
    fake = await startFakeDocker(state);
    configPath = writeTestConfig(fake.dir, { socketPath: fake.socketPath });
    // bindings with explicit container names; demo-redis has none (label convention only)
    writeFileSync(
      join(fake.dir, 'bindings.yaml'),
      `schema_version: "1.0"
resources:
  - { id: demo-mysql, type: mysql.instance, env: sandbox, attributes: { engine: mysql, container: demo-mysql } }
  - { id: demo-redis, type: redis.instance, env: sandbox, attributes: { engine: redis } }
  - { id: kv, type: kv.instance, env: sandbox, attributes: { container: cache-x } }
  - { id: ghost-db, type: mysql.instance, env: sandbox, attributes: { container: demo-mysq } }
relations: []
`,
    );
    Object.assign(restartTiming, { stableMs: 300, pollMs: 50, verifyMs: 1500 });
  });
  afterAll(async () => {
    Object.assign(restartTiming, saved);
    await fake.close();
  });
  afterEach(() => {
    state.onRestart = undefined;
  });

  const workload = (service: string) => invoke(r, 'container.workload.get', { service, env: 'sandbox' }, { configPath });

  it('matches middleware containers by the workctl.resource label convention', async () => {
    const env = await workload('demo-redis');
    expect(env.status).toBe('success');
    expect(env.meta.warnings).toEqual([]);
    const d = env.data as any;
    expect(d.containers.map((c: any) => c.name)).toEqual(['demo-redis']);
    expect(d.selector).toMatchObject({ kind: 'label', label: 'workctl.resource=demo-redis', origin: 'label-convention', matched_by: 'label workctl.resource=demo-redis' });
    expect(env.meta.coverage?.notes?.join()).toContain('workctl.service=demo-redis → 0');
  });

  it('matches by the explicit binding attribute `container` with an exact name, never a similar one', async () => {
    const d = (await workload('demo-mysql')).data as any;
    expect(d.containers.map((c: any) => c.name)).toEqual(['demo-mysql']); // demo-mysql-backup is not matched
    expect(d.selector).toMatchObject({ kind: 'name', origin: 'binding-file', matched_by: 'binding attribute container=demo-mysql' });
    expect(((await workload('kv')).data as any).containers.map((c: any) => c.name)).toEqual(['cache-x']);
    const ghost = await workload('ghost-db');
    expect((ghost.data as any).containers).toEqual([]); // 'demo-mysq' must not fuzzy-match demo-mysql
    expect(ghost.meta.warnings.length).toBe(1);
  });

  it('event list and stats report the selector and filter events by exact container name', async () => {
    const ev = (await invoke(r, 'container.event.list', { service: 'demo-mysql', window: '1h' }, { configPath })).data as any;
    expect(ev.events.map((e: any) => e.container_name)).toEqual(['demo-mysql']);
    expect(ev.selector.matched_by).toBe('binding attribute container=demo-mysql');
    const st = await invoke(r, 'container.stats.get', { service: 'demo-redis' }, { configPath });
    expect(st.meta.warnings).toEqual([]);
    expect((st.data as any).matched_by).toBe('label workctl.resource=demo-redis');
  });

  async function planAndRun(service: string) {
    const env = await invoke(r, 'container.workload.restart_plan', { service }, { configPath });
    expect(env.status).toBe('success');
    const plan = env.data as Plan;
    const ctx = new Ctx({ registry: r, loaded: loadConfig(configPath), profileName: 't', requestId: 'req-test', timeoutMs: 20_000 });
    return r.executors.get('container.restart')!(ctx, plan, () => undefined) as Promise<any>;
  }

  it('restart: an unhealthy container after restart is NOT reported as recovered', async () => {
    await expect(planAndRun('svc-unhealthy')).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });

  it('restart: a container that crashes right after starting is NOT reported as recovered', async () => {
    state.onRestart = (c) => {
      setTimeout(() => {
        c.State = 'exited';
        c.ExitCode = 1;
      }, 100);
    };
    await expect(planAndRun('svc-crash')).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });

  it('restart: a drifted later target is refused before any container is restarted', async () => {
    const env = await invoke(r, 'container.workload.restart_plan', { service: 'svc-pair' }, { configPath });
    const plan = env.data as Plan;
    expect(plan.targets).toHaveLength(2);
    const second = state.containers.find((c) => c.Name === 'svc-pair-2')!;
    second.Labels = { 'workctl.service': 'other', 'workctl.env': 'sandbox' };
    const restarted: string[] = [];
    state.onRestart = (c) => void restarted.push(c.Name);
    const ctx = new Ctx({ registry: r, loaded: loadConfig(configPath), profileName: 't', requestId: 'req-test', timeoutMs: 20_000 });
    const err = await (r.executors.get('container.restart')!(ctx, plan, () => undefined) as Promise<any>).catch((e) => e);
    expect(err.code).toBe('PRECONDITION_FAILED');
    expect(restarted).toEqual([]);
  });

  it('restart: healthy containers and name-selected resources verify after staying up', async () => {
    const res = await planAndRun('svc-healthy');
    expect(res.verified_all).toBe(true);
    expect(res.restarted[0].after.health).toBe('healthy');
    const byName = await planAndRun('demo-mysql');
    expect(byName.verified_all).toBe(true);
    expect(byName.restarted[0].name).toBe('demo-mysql');
  });
});
