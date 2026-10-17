// Live tests against the demo Nacos (demo-nacos, 127.0.0.1:18848) and Consul (demo-consul,
// 127.0.0.1:18500). WORKCTL_IT=1. Seeds are re-run here (both are idempotent).
import { spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { builtinRegistry } from '../../src/domains';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';
const configPath = 'demo/environment/workctl.yaml';
const live = process.env.WORKCTL_IT === '1';
const by = (items: any[]) => Object.fromEntries(items.map((x) => [x.name, x]));

function seed(script: string): any {
  const out = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 90_000 });
  expect(out.status, out.stderr).toBe(0);
  return JSON.parse(out.stdout);
}

describe.skipIf(!live)('config providers (live, demo-nacos)', () => {
  const r = builtinRegistry();
  let s: { version: string; steps: { label: string; history_id: number }[] };
  const hid = (label: string) => s.steps.find((x) => x.label.startsWith(label))!.history_id;

  beforeAll(() => {
    s = seed('demo/scenarios/config/seed-nacos.mjs');
  }, 120_000);

  it('config get via binding demo-payment → nacos; properties keys; secrets masked', async () => {
    const env = await invoke(r, 'config.get', { service: 'demo-payment' }, { configPath });
    expect(env.status).toBe('success');
    const d = env.data as any;
    expect(d).toMatchObject({ provider: 'nacos', endpoint: 'nacos/demo-nacos', prefix: 'sandbox/DEFAULT_GROUP/demo-payment.properties' });
    expect(d.nacos).toMatchObject({ exists: true, type: 'properties', parsed: true, latest_history_id: hid('v3') });
    const it = by(d.items);
    expect(it['order.timeout_ms'].value).toBe(1500);
    expect(it['db.password']).toMatchObject({ value: '***', value_bytes: null });
    expect(it['callback.token'].masked).toBe(true);
    expect(JSON.stringify(env)).not.toContain('synthetic-');
    expect(env.meta.sources[0]).toMatchObject({ system: 'nacos', version: '2.4.3' });
  });

  it('config diff between real history ids (v1 → v3) and --key previous version', async () => {
    const env = await invoke(r, 'config.diff', { service: 'demo-payment', from_rev: hid('v1'), to_rev: String(hid('v3')) }, { configPath });
    expect(env.status).toBe('success');
    expect((env.data as any).summary).toEqual({ added: 2, removed: 1, changed: 3, unchanged: 2, rewritten_same_value: 0 });
    const k = await invoke(r, 'config.diff', { service: 'demo-payment', key: 'order.timeout_ms' }, { configPath });
    expect((k.data as any).changes[0]).toMatchObject({ change: 'changed', old: { value: 800 }, new: { value: 1500 } });
    const old = await invoke(r, 'config.diff', { service: 'demo-payment', from_rev: 0 }, { configPath });
    expect(old.error?.code).toBe('DATA_UNAVAILABLE');
  });

  it('discovery list: persistent instances with server-side health, one disabled', async () => {
    const env = await invoke(r, 'discovery.list', { service: 'demo-payment' }, { configPath });
    expect(env.status).toBe('success');
    const d = env.data as any;
    expect(d.summary).toMatchObject({ registered: 3, healthy: 2, unhealthy: 1, service_registered: true });
    expect(d.instances.find((x: any) => x.port === 9)).toMatchObject({ healthy: false, nacos: { ephemeral: false } });
    expect(d.instances.filter((x: any) => x.nacos.enabled === false)).toHaveLength(1);
  });
});

describe.skipIf(!live)('config providers (live, demo-consul)', () => {
  const r = builtinRegistry();
  let s: { version: string; keys: { key: string; create_index: number; modify_index: number }[] };

  beforeAll(() => {
    s = seed('demo/scenarios/config/seed-consul.mjs');
  }, 60_000);

  it('config get via binding demo-inventory → consul; ModifyIndex; masking', async () => {
    const env = await invoke(r, 'config.get', { service: 'demo-inventory' }, { configPath });
    expect(env.status).toBe('success');
    const d = env.data as any;
    expect(d).toMatchObject({ provider: 'consul', prefix: 'config/sandbox/demo-inventory/', count: 6 });
    const it = by(d.items);
    const seeded = s.keys.find((k) => k.key.endsWith('cache.ttl_seconds'))!;
    expect(it['cache.ttl_seconds']).toMatchObject({ value: 30, create_revision: seeded.create_index, mod_revision: seeded.modify_index });
    expect(it['db.password']).toMatchObject({ value: '***', value_bytes: null });
    expect(it['upstream.order'].value.api_key).toBe('***');
    expect(JSON.stringify(env)).not.toContain('synthetic-');
    expect(env.meta.sources[0]).toMatchObject({ system: 'consul', version: s.version });
  });

  it('config diff: no history → DATA_UNAVAILABLE with indexes, never invented values', async () => {
    const k = await invoke(r, 'config.diff', { service: 'demo-inventory', key: 'cache.ttl_seconds' }, { configPath });
    expect(k.error?.code).toBe('DATA_UNAVAILABLE');
    expect(k.error?.details).toMatchObject({ modify_index: s.keys.find((x) => x.key.endsWith('cache.ttl_seconds'))!.modify_index });
    const f = await invoke(r, 'config.diff', { service: 'demo-inventory', from_rev: s.keys[0].create_index }, { configPath });
    expect(f.error?.code).toBe('DATA_UNAVAILABLE');
  });

  it('discovery list: passing / critical / warning checks', async () => {
    const env = await invoke(r, 'discovery.list', { service: 'demo-inventory' }, { configPath });
    const d = env.data as any;
    expect(d.summary).toMatchObject({ registered: 3, healthy: 2, unhealthy: 1, service_registered: true });
    expect(Object.fromEntries(d.instances.map((x: any) => [x.instance_id, x.consul.status]))).toEqual({ 'inventory-1': 'passing', 'inventory-2': 'critical', 'inventory-3': 'warning' });
  });

  it('auth status --probe reports nacos and consul versions', async () => {
    const env = await invoke(r, 'auth.status', { probe: true }, { configPath });
    const eps = (env.data as any).endpoints;
    expect(eps.find((e: any) => e.kind === 'nacos').probe).toMatchObject({ ok: true, version: '2.4.3' });
    expect(eps.find((e: any) => e.kind === 'consul').probe).toMatchObject({ ok: true, version: s.version });
  });
});
