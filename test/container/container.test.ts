import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { Registry } from '../../src/core/registry';
import container, { eventHorizon, parseEventStream, capacityFlags } from '../../src/domains/container';
import { parseStats } from '../../src/domains/container/stats';
import { startFakeDocker, writeTestConfig, type FakeDockerState } from './fake-docker';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';

const stats = {
  read: '2026-10-17T12:00:01.000000000Z',
  preread: '2026-10-17T12:00:00.000000000Z',
  pids_stats: { current: 11 },
  cpu_stats: { cpu_usage: { total_usage: 2_500_000_000 }, system_cpu_usage: 104_000_000_000, online_cpus: 4 },
  precpu_stats: { cpu_usage: { total_usage: 2_000_000_000 }, system_cpu_usage: 100_000_000_000, online_cpus: 4 },
  memory_stats: { usage: 120 * 1024 * 1024, limit: 256 * 1024 * 1024, stats: { inactive_file: 20 * 1024 * 1024 } },
  networks: { eth0: { rx_bytes: 1000, tx_bytes: 2000 }, eth1: { rx_bytes: 1, tx_bytes: 2 } },
  blkio_stats: { io_service_bytes_recursive: [{ op: 'read', value: 10 }, { op: 'write', value: 20 }, { op: 'Read', value: 5 }] },
};

describe('parseStats (pure)', () => {
  it('computes CPU from precpu→cpu deltas and working-set memory like docker stats', () => {
    const p = parseStats(stats, 0.5, 256 * 1024 * 1024);
    // (0.5e9 / 4e9) * 4 cpus = 0.5 cores
    expect(p.cpu).toEqual({ cores_used: 0.5, percent: 50, online_cpus: 4, percent_of_limit: 100 });
    expect(p.memory?.working_set_bytes).toBe(100 * 1024 * 1024);
    expect(p.memory?.limit_source).toBe('container');
    expect(p.memory?.percent_of_limit).toBeCloseTo(39.06, 1);
    expect(p.network).toEqual({ rx_bytes: 1001, tx_bytes: 2002, rx_errors: 0, tx_errors: 0 });
    expect(p.block_io).toEqual({ read_bytes: 15, write_bytes: 20 });
    expect(p.sample_interval_ms).toBe(1000);
  });

  it('does not invent CPU usage without a previous sample, and labels host-bounded memory', () => {
    const p = parseStats({ ...stats, precpu_stats: {} }, null, 0);
    expect(p.cpu).toBeNull();
    expect(p.notes.join()).toContain('precpu_stats');
    expect(p.memory?.limit_source).toBe('host');
    const reset = parseStats({ ...stats, precpu_stats: { ...stats.precpu_stats, cpu_usage: { total_usage: 9e12 } } }, null, 0);
    expect(reset.cpu).toBeNull();
  });
});

describe('docker events helpers (pure)', () => {
  it('parses jsonl and detects a full daemon ring buffer', () => {
    const base = Date.parse('2026-10-17T12:00:00Z');
    const lines = Array.from({ length: 256 }, (_, k) => JSON.stringify({ Type: 'container', Action: 'exec_die', Actor: { ID: 'x', Attributes: {} }, time: (base + k * 1000) / 1000, timeNano: (base + k * 1000) * 1e6 }));
    const evs = parseEventStream(lines.join('\n') + '\n{partial');
    expect(evs).toHaveLength(256);
    const h = eventHorizon(evs, base - 3_600_000);
    expect(h.buffer_full).toBe(true);
    expect(h.visible_since).toBe('2026-10-17T12:00:00.000Z');
    expect(eventHorizon(evs.slice(0, 10), base - 1000).buffer_full).toBe(false);
  });

  it('flags capacity risks', () => {
    expect(capacityFlags({ limits: { cpus: null, memory_bytes: 1 }, usage: { cpu_cores: 1, cpu_percent_of_limit: null, memory_working_set_bytes: 1, memory_percent_of_limit: 95, pids: 1 }, oom_killed: true, restart_count: 2 })).toEqual([
      'no_cpu_limit',
      'memory_above_80pct_of_limit',
      'oom_killed_last_exit',
      'auto_restarted',
    ]);
  });
});

describe('container domain against a fake Docker Engine', () => {
  const state: FakeDockerState = {
    containers: [
      {
        Id: 'c1'.padEnd(64, '0'),
        Name: 'demo-order',
        Labels: { 'workctl.service': 'demo-order', 'workctl.env': 'sandbox' },
        State: 'running',
        NanoCpus: 500_000_000,
        Memory: 256 * 1024 * 1024,
        Ports: [{ IP: '0.0.0.0', PrivatePort: 8080, PublicPort: 18081, Type: 'tcp' }],
        RestartCount: 1,
        stats,
      },
      { Id: 'c2'.padEnd(64, '0'), Name: 'demo-order-prod', Labels: { 'workctl.service': 'demo-order', 'workctl.env': 'prod' }, State: 'running' },
      { Id: 'c3'.padEnd(64, '0'), Name: 'demo-order-like-name', Labels: { 'workctl.env': 'sandbox' }, State: 'exited', ExitCode: 137, OOMKilled: true },
    ],
    events: [
      { Type: 'container', Action: 'die', Actor: { ID: 'c1'.padEnd(64, '0'), Attributes: { name: 'demo-order', image: 'x', exitCode: '137', 'workctl.service': 'demo-order', 'workctl.env': 'sandbox' } }, time: Math.floor(Date.now() / 1000) - 60 },
      { Type: 'container', Action: 'start', Actor: { ID: 'c1'.padEnd(64, '0'), Attributes: { name: 'demo-order', image: 'x', 'workctl.service': 'demo-order', 'workctl.env': 'sandbox' } }, time: Math.floor(Date.now() / 1000) - 59 },
      { Type: 'container', Action: 'exec_create: true', Actor: { ID: 'c1'.padEnd(64, '0'), Attributes: { name: 'demo-order', 'workctl.service': 'demo-order' } }, time: Math.floor(Date.now() / 1000) - 30 },
      { Type: 'container', Action: 'die', Actor: { ID: 'c3'.padEnd(64, '0'), Attributes: { name: 'demo-order-like-name', 'workctl.env': 'sandbox' } }, time: Math.floor(Date.now() / 1000) - 10 },
    ],
  };
  let fake: Awaited<ReturnType<typeof startFakeDocker>>;
  let configPath: string;
  const r = new Registry();
  r.addDomain(container);

  beforeAll(async () => {
    fake = await startFakeDocker(state);
    configPath = writeTestConfig(fake.dir, { socketPath: fake.socketPath });
  });
  afterAll(async () => fake.close());

  it('workload get resolves containers by label (never by name) and filters env', async () => {
    const env = await invoke(r, 'container.workload.get', { service: 'demo-order', env: 'sandbox' }, { configPath });
    expect(env.status).toBe('success');
    expect(env.meta.warnings).toEqual([]);
    const d = env.data as any;
    expect(d.containers.map((c: any) => c.name)).toEqual(['demo-order']);
    expect(d.selector.origin).toBe('binding-file');
    expect(d.containers[0].limits).toMatchObject({ cpus: 0.5, memory_bytes: 268435456 });
    expect(d.containers[0].ports[0]).toMatchObject({ container_port: 8080, host_port: 18081 });
    expect(env.meta.coverage?.notes?.join()).toContain('demo-order-prod(prod)');
    expect(env.meta.sources[0].version).toBe('99.0.0-fake (API 1.99)');
  });

  it('workload get for an unknown service is an empty success, not an error', async () => {
    const env = await invoke(r, 'container.workload.get', { service: 'nope' }, { configPath });
    expect(env.status).toBe('success');
    expect((env.data as any).containers).toEqual([]);
    expect(env.meta.warnings.join()).toContain('workctl.service=nope');
  });

  it('event list filters by label locally, hides exec events and reports the window', async () => {
    const env = await invoke(r, 'container.event.list', { service: 'demo-order', window: '1h' }, { configPath });
    expect(env.status).toBe('success');
    expect(env.meta.warnings).toEqual([]);
    const d = env.data as any;
    expect(d.events.map((e: any) => e.action)).toEqual(['die', 'start']);
    expect(d.events[0].exit_code).toBe(137);
    expect(d.daemon_buffer_full).toBe(false);
    expect(env.meta.coverage?.window).toBeDefined();
    expect(env.meta.coverage?.notes?.join()).toContain('exec_');
  });

  it('stats get is labelled as a snapshot', async () => {
    const env = await invoke(r, 'container.stats.get', { service: 'demo-order' }, { configPath });
    expect(env.meta.warnings).toEqual([]);
    const d = env.data as any;
    expect(d.kind).toBe('snapshot');
    expect(d.containers[0].stats.cpu.cores_used).toBe(0.5);
    expect(env.meta.coverage?.window).toBeUndefined();
    expect(env.meta.coverage?.scope).toContain('snapshot');
  });

  it('capacity summary aggregates limits vs usage per env', async () => {
    const env = await invoke(r, 'container.capacity.summary', { env: 'sandbox' }, { configPath });
    expect(env.meta.warnings).toEqual([]);
    const d = env.data as any;
    expect(d.totals.containers).toBe(2);
    expect(d.totals.cpu_limit_sum).toBe(0.5);
    expect(d.totals.memory_unlimited).toBe(1);
    const exited = d.containers.find((c: any) => c.name === 'demo-order-like-name');
    expect(exited.usage).toBeNull();
    expect(exited.flags).toContain('oom_killed_last_exit');
  });

  it('restart plan → execute verifies the container came back', async () => {
    const env = await invoke(r, 'container.workload.restart_plan', { service: 'demo-order' }, { configPath });
    expect(env.status).toBe('success');
    expect(env.meta.warnings).toEqual([]);
    const plan = env.data as any;
    expect(plan.kind).toBe('container.restart');
    expect(plan.targets).toHaveLength(1);
    expect(plan.impact.dependents_of_service[0].resource).toBe('demo-prometheus');
    expect(plan.preconditions.every((p: any) => p.ok)).toBe(true);
    expect(fake.calls.some((c) => c.includes('/restart'))).toBe(false);
    const exec = r.executors.get('container.restart')!;
    const { loadConfig } = await import('../../src/core/config');
    const { Ctx } = await import('../../src/core/runtime');
    const ctx = new Ctx({ registry: r, loaded: loadConfig(configPath), profileName: 't', requestId: 'req-test', timeoutMs: 20_000 });
    const notes: string[] = [];
    const result = (await exec(ctx, plan, (n) => notes.push(n))) as any;
    expect(result.verified_all).toBe(true);
    expect(result.restarted[0].after.state).toBe('running');
    expect(fake.calls.filter((c) => c.startsWith('POST') && c.includes('/restart?t=10'))).toHaveLength(1);
    expect(notes.length).toBeGreaterThan(0);
  });

  it('restart plan without matching containers has a failed precondition', async () => {
    const env = await invoke(r, 'container.workload.restart_plan', { service: 'ghost' }, { configPath });
    const plan = env.data as any;
    expect(plan.preconditions.find((p: any) => p.check === 'containers_found').ok).toBe(false);
  });

  it('maps a missing Docker socket to UPSTREAM_UNAVAILABLE', async () => {
    const p = writeTestConfig(mkdtempSync(join(tmpdir(), 'workctl-nosock-')), { socketPath: '/nonexistent/docker.sock' });
    const env = await invoke(r, 'container.workload.get', { service: 'demo-order' }, { configPath: p });
    expect(env.status).toBe('error');
    expect(env.error?.code).toBe('UPSTREAM_UNAVAILABLE');
  });
});
