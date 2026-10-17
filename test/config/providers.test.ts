import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { Registry } from '../../src/core/registry';
import configDomain from '../../src/domains/config';
import { mapConsulError } from '../../src/domains/config/consul';
import { docFormat, mapNacosError, parseDoc, parseProperties } from '../../src/domains/config/nacos';
import { FakeConsul, FakeNacos, writeProviderConfig } from './fake-providers';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';

function registry(): Registry {
  const r = new Registry();
  r.addDomain(configDomain);
  return r;
}
const r = registry();
const call = (cap: string, inputs: Record<string, unknown>, configPath: string) => invoke(r, cap, inputs, { configPath });
const by = (items: any[]) => Object.fromEntries(items.map((x) => [x.name, x]));

describe('Nacos document parsing (pure)', () => {
  it('parses java properties: comments, separators, continuations, escapes', () => {
    expect(parseProperties('# c\n! c2\na=1\nb : two\nc three\nd=x\\\n   y\ne=\\u4e2d\\t\n\n  f=  spaced')).toEqual([
      ['a', '1'],
      ['b', 'two'],
      ['c', 'three'],
      ['d', 'xy'],
      ['e', '中\t'],
      ['f', 'spaced'],
    ]);
  });

  it('flattens yaml/json into dotted keys, keeps big ints exact, falls back to one value', () => {
    const y = parseDoc('db:\n  password: p\n  pool: 8\nids: [7587898288280331665, 2]\nempty: {}\n', 'yaml', 'a.yaml');
    expect(Object.fromEntries(y.raw)).toEqual({ 'db.password': 'p', 'db.pool': '8', 'ids[0]': '7587898288280331665', 'ids[1]': '2', empty: '{}' });
    expect(parseDoc('{"a":{"b":true}}', 'json', 'a.json').raw.get('a.b')).toBe('true');
    const bad = parseDoc('a: [unclosed', 'yaml', 'a.yaml');
    expect(bad).toMatchObject({ parsed: false });
    expect(bad.parse_error).toMatch(/yaml 解析失败/);
    expect([...bad.raw.keys()]).toEqual(['a.yaml']);
    expect(parseDoc('<x/>', 'text', 'a.xml')).toMatchObject({ parsed: false, parse_error: null });
    expect(docFormat(null, 'svc.yml')).toBe('yaml');
    expect(docFormat('html', 'svc.properties')).toBe('text');
  });

  it('maps HTTP errors to stable codes', () => {
    expect(mapNacosError(403, 'user not found!', 'x').code).toBe('UNAUTHENTICATED');
    expect(mapNacosError(403, 'token expired!', 'x').code).toBe('UNAUTHENTICATED');
    expect(mapNacosError(403, 'authorization failed!', 'x').code).toBe('PERMISSION_DENIED');
    expect(mapNacosError(500, 'caused: x', 'x').code).toBe('UPSTREAM_UNAVAILABLE');
    expect(mapNacosError(400, 'bad', 'x').code).toBe('INVALID_ARGUMENT');
    expect(mapConsulError(403, 'ACL not found', 'x').code).toBe('UNAUTHENTICATED');
    expect(mapConsulError(403, 'Permission denied: token lacks key:read', 'x').code).toBe('PERMISSION_DENIED');
    expect(mapConsulError(500, 'No cluster leader', 'x').code).toBe('UPSTREAM_UNAVAILABLE');
  });
});

describe('Nacos provider against a fake Open API', () => {
  const fake = new FakeNacos();
  let cfg: string;
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    cfg = writeProviderConfig({ nacos: `${await fake.start()}/nacos`, nacosExtra: { context_path: '/nacos' } });
    ids.v1 = fake.publish('pay.properties', 'timeout=800\ndb.password=synthetic-1\nlegacy=on\n');
    fake.publish('other.properties', 'x=1\n'); // another config's history id in between (global nid)
    ids.v2 = fake.publish('pay.properties', 'timeout=1500\ndb.password=synthetic-1\nrisk.max=5000\n');
    ids.v3 = fake.publish('pay.properties', 'timeout=1500\ndb.password=synthetic-2\nrisk.max=5000\ncallback.token=synthetic-tok\n');
    fake.publish('doc.yaml', 'a:\n  b: 1\n  secret_key: s\n', 'yaml');
    fake.publish('page.properties', 'not = used', 'html');
    fake.services.set('pay', [
      { instanceId: '10.0.0.1#80#DEFAULT#DEFAULT_GROUP@@pay', ip: '10.0.0.1', port: 80, weight: 1, healthy: true, enabled: true, ephemeral: false, clusterName: 'DEFAULT', metadata: { version: '1.0', env: 'sandbox' } },
      { instanceId: '10.0.0.2#80#DEFAULT#DEFAULT_GROUP@@pay', ip: '10.0.0.2', port: 80, weight: 1, healthy: false, enabled: true, ephemeral: true, clusterName: 'DEFAULT', metadata: { env: 'sandbox', token: 'LEAK' } },
      { instanceId: '10.0.0.3#80#DEFAULT#DEFAULT_GROUP@@pay', ip: '10.0.0.3', port: 80, weight: 0.5, healthy: true, enabled: false, ephemeral: false, clusterName: 'DEFAULT', metadata: { env: 'prod' } },
    ]);
  });
  afterAll(() => fake.stop());

  it('config get: provider chosen by the service binding; properties split into keys; secrets masked without length', async () => {
    const env = await call('config.get', { service: 'pay' }, cfg);
    expect(env.status).toBe('success');
    const d = env.data as any;
    expect(d).toMatchObject({ provider: 'nacos', endpoint: 'nacos/n1', prefix: 'sandbox/DEFAULT_GROUP/pay.properties', revision_space: 'nacos-history-id', observed_revision: null, count: 4 });
    expect(d.provider_selected_by).toMatch(/pay\.attributes\.config_center=center-nacos/);
    expect(d.nacos).toMatchObject({ exists: true, content_format: 'properties', parsed: true, latest_history_id: ids.v3 });
    const it = by(d.items);
    expect(it.timeout).toMatchObject({ value: 1500, value_format: 'json', mod_revision: null, version: null });
    expect(it['db.password']).toMatchObject({ value: '***', masked: true, value_bytes: null });
    expect(it['callback.token']).toMatchObject({ value: '***', masked: true });
    expect(JSON.stringify(env)).not.toContain('synthetic-');
    expect(env.meta.sources[0]).toMatchObject({ system: 'nacos', adapter: 'nacos-open-api', version: '2.4.3' });
  });

  it('config get: yaml flattened; non-splittable type returned whole; missing document is empty, --key missing is NOT_FOUND; truncation → partial', async () => {
    const y = await call('config.get', { service: 'doc', endpoint: 'nacos/n1' }, writeProviderConfig({ nacos: `${fake.url}/nacos`, nacosExtra: { data_id: '${service}.yaml' } }));
    expect(by((y.data as any).items)).toMatchObject({ 'a.b': { value: 1 }, 'a.secret_key': { value: '***', masked: true } });
    const h = await call('config.get', { service: 'page', endpoint: 'n1' }, cfg);
    expect((h.data as any).nacos).toMatchObject({ type: 'html', parsed: false });
    expect((h.data as any).items.map((x: any) => x.name)).toEqual(['page.properties']);
    const none = await call('config.get', { service: 'nosuch', endpoint: 'n1' }, cfg);
    expect(none.status).toBe('success');
    expect((none.data as any)).toMatchObject({ count: 0, nacos: { exists: false } });
    const miss = await call('config.get', { service: 'pay', key: 'nope' }, cfg);
    expect(miss.error?.code).toBe('NOT_FOUND');
    expect(miss.error?.hint).toMatch(/timeout/);
    const t = await call('config.get', { service: 'pay', limit: 2 }, cfg);
    expect(t.status).toBe('partial');
    expect(t.meta.coverage).toMatchObject({ complete: false, truncated: true });
  });

  it('config diff between history ids reconstructs documents from pre-image records', async () => {
    const env = await call('config.diff', { service: 'pay', from_rev: ids.v1, to_rev: String(ids.v3) }, cfg);
    expect(env.status).toBe('success');
    const d = env.data as any;
    expect(d).toMatchObject({ provider: 'nacos', revision_space: 'nacos-history-id', from_revision: ids.v1, to_revision: ids.v3, current_revision: ids.v3 });
    expect(d.summary).toEqual({ added: 2, removed: 1, changed: 2, unchanged: 0, rewritten_same_value: 0 });
    const c = by(d.changes);
    expect(c.timeout).toMatchObject({ change: 'changed', old: { value: 800 }, new: { value: 1500 } });
    expect(c['db.password']).toMatchObject({ change: 'changed', masked: true, old: { value: '***', value_bytes: null }, new: { value: '***' } });
    expect(c.legacy.change).toBe('removed');
    expect(JSON.stringify(env)).not.toContain('synthetic-');
    // a global id that belongs to another config: state after the last change of THIS config ≤ that id
    const mid = await call('config.diff', { service: 'pay', from_rev: ids.v1 + 1, to_rev: String(ids.v2) }, cfg);
    expect((mid.data as any).summary.changed).toBe(1);
  });

  it('config diff --key compares with the key\'s previous value; beyond retention → DATA_UNAVAILABLE', async () => {
    const env = await call('config.diff', { service: 'pay', key: 'db.password' }, cfg);
    expect(env.status).toBe('success');
    expect((env.data as any)).toMatchObject({ mode: 'previous_version', from_revision: ids.v3 - 1, changes: [{ name: 'db.password', change: 'changed', masked: true }] });
    const added = await call('config.diff', { service: 'pay', key: 'risk.max' }, cfg);
    expect((added.data as any).changes[0]).toMatchObject({ change: 'added', new: { value: 5000 } });
    fake.oldestKept = ids.v2;
    try {
      const old = await call('config.diff', { service: 'pay', from_rev: ids.v1 }, cfg);
      expect(old.error?.code).toBe('DATA_UNAVAILABLE');
      expect(old.error?.details).toMatchObject({ oldest_history_id: ids.v2, retention_days: 30 });
      // a U record carries its pre-image: the change at v2 is still visible although v1 is gone
      expect(((await call('config.diff', { service: 'pay', key: 'timeout' }, cfg)).data as any).changes[0]).toMatchObject({ old: { value: 800 }, new: { value: 1500 } });
      fake.oldestKept = ids.v3;
      const unchanged = await call('config.diff', { service: 'pay', key: 'timeout' }, cfg);
      expect(unchanged.error?.code).toBe('DATA_UNAVAILABLE');
    } finally {
      fake.oldestKept = 0;
    }
    const noArgs = await call('config.diff', { service: 'pay' }, cfg);
    expect(noArgs.error?.code).toBe('INVALID_ARGUMENT');
  });

  it('discovery list: server-side health, enabled/ephemeral/weight, metadata masked; unknown service → not registered', async () => {
    const env = await call('discovery.list', { service: 'pay' }, cfg);
    expect(env.status).toBe('success');
    const d = env.data as any;
    expect(d.summary).toMatchObject({ registered: 3, returned: 3, healthy: 2, unhealthy: 1, service_registered: true });
    expect(d.instances[1]).toMatchObject({ address: '10.0.0.2', healthy: false, health_basis: 'registry_health', nacos: { ephemeral: true, enabled: true }, payload: { token: '***' } });
    expect(d.instances[2].nacos).toMatchObject({ enabled: false, weight: 0.5 });
    expect(JSON.stringify(env)).not.toContain('LEAK');
    const f = await call('discovery.list', { service: 'pay', env: 'sandbox', healthy_only: true }, cfg);
    expect((f.data as any).summary).toMatchObject({ returned: 1, excluded: { env_mismatch: 1, not_healthy: 1 } });
    const none = await call('discovery.list', { service: 'ghost', endpoint: 'n1' }, cfg);
    expect(none.status).toBe('success');
    expect((none.data as any).summary).toMatchObject({ registered: 0, service_registered: false });
  });

  it('auth: login with username + password_ref sends accessToken; failures map to UNAUTHENTICATED / PERMISSION_DENIED', async () => {
    fake.auth = { users: { ro: 'pw-1' }, deny: ['secret-ns'] };
    try {
      const ok = await call('config.get', { service: 'pay' }, writeProviderConfig({ nacos: fake.url, nacosExtra: { username: 'ro', password_ref: 'file:secret' }, secret: 'pw-1' }));
      expect(ok.status).toBe('success');
      expect(fake.calls.some((c) => c.path === '/nacos/v1/cs/configs' && c.query.get('accessToken') === 'tok-ro')).toBe(true);
      const anon = await call('config.get', { service: 'pay' }, writeProviderConfig({ nacos: fake.url }));
      expect(anon.error?.code).toBe('UNAUTHENTICATED');
      const wrong = await call('config.get', { service: 'pay' }, writeProviderConfig({ nacos: fake.url, nacosExtra: { username: 'ro', password_ref: 'file:secret' }, secret: 'nope' }));
      expect(wrong.error?.code).toBe('UNAUTHENTICATED');
      expect(JSON.stringify(wrong)).not.toContain('nope');
      const denied = await call('config.get', { service: 'pay' }, writeProviderConfig({ nacos: fake.url, nacosExtra: { username: 'ro', password_ref: 'file:secret', namespace: 'secret-ns' }, secret: 'pw-1' }));
      expect(denied.error?.code).toBe('PERMISSION_DENIED');
    } finally {
      fake.auth = null;
    }
    fake.fail = 503;
    try {
      expect((await call('config.get', { service: 'pay' }, cfg)).error?.code).toBe('UPSTREAM_UNAVAILABLE');
    } finally {
      fake.fail = null;
    }
  });
});

describe('Consul provider against a fake HTTP API', () => {
  const fake = new FakeConsul();
  let cfg: string;
  const P = 'config/sandbox/inv/';
  const idx: Record<string, number> = {};

  beforeAll(async () => {
    cfg = writeProviderConfig({ consul: await fake.start() });
    idx.created = fake.put(`${P}cache.ttl_seconds`, '120');
    fake.put(`${P}db.password`, 'synthetic-consul-1');
    fake.put(`${P}upstream.order`, JSON.stringify({ url: 'http://x', api_key: 'LEAK-KEY' }));
    fake.put(`${P}dir/`, '');
    fake.put('config/sandbox/inv-other/x', 'not mine');
    idx.v1 = fake.index;
    fake.put(`${P}cache.ttl_seconds`, '30');
    fake.put(`${P}db.password`, 'synthetic-consul-2');
    const chk = (status: string, svc = true) => ({ CheckID: `c-${status}`, Name: status, Status: status, ServiceID: svc ? 'x' : '', Output: `${status} output` });
    const node = { Node: 'n1', Address: '10.0.1.1' };
    fake.health.set('inv', [
      { Node: node, Service: { ID: 'inv-1', Service: 'inv', Address: '10.0.1.11', Port: 9081, Tags: ['a'], Meta: { version: '2.1', env: 'sandbox' }, CreateIndex: 5, ModifyIndex: 6 }, Checks: [chk('passing', false), chk('passing')] },
      { Node: node, Service: { ID: 'inv-2', Service: 'inv', Address: '', Port: 9082, Tags: [], Meta: { env: 'sandbox', secret: 'LEAK-META' } }, Checks: [chk('passing', false), chk('critical')] },
      { Node: node, Service: { ID: 'inv-3', Service: 'inv', Address: '10.0.1.13', Port: 9083, Tags: null, Meta: null }, Checks: [chk('warning')] },
    ]);
    fake.catalog = { consul: [], inv: [], empty: [] };
  });
  afterAll(() => fake.stop());

  it('config get: provider chosen by a reads_from relation; base64 decoded; Create/ModifyIndex; masking', async () => {
    const env = await call('config.get', { service: 'inv' }, cfg);
    expect(env.status).toBe('success');
    const d = env.data as any;
    expect(d).toMatchObject({ provider: 'consul', endpoint: 'consul/c1', prefix: P, revision_space: 'consul-raft-index', observed_revision: fake.index, count: 3 });
    expect(d.provider_selected_by).toMatch(/inv reads_from center-consul/);
    const it = by(d.items);
    expect(it['cache.ttl_seconds']).toMatchObject({ value: 30, create_revision: idx.created, mod_revision: idx.v1 + 1, version: null, consul: { flags: 0 } });
    expect(it['db.password']).toMatchObject({ value: '***', value_bytes: null });
    expect(it['upstream.order'].value).toEqual({ url: 'http://x', api_key: '***' });
    expect(JSON.stringify(env)).not.toMatch(/LEAK|synthetic-consul/);
    expect(env.meta.sources[0]).toMatchObject({ system: 'consul', adapter: 'consul-http-api', version: '1.20.6' });
  });

  it('config get: empty prefix is success+empty, missing --key is NOT_FOUND, truncation is partial', async () => {
    const none = await call('config.get', { service: 'ghost', endpoint: 'consul/c1' }, cfg);
    expect(none.status).toBe('success');
    expect((none.data as any).items).toEqual([]);
    expect((await call('config.get', { service: 'inv', key: 'nope' }, cfg)).error?.code).toBe('NOT_FOUND');
    const t = await call('config.get', { service: 'inv', limit: 1 }, cfg);
    expect(t.status).toBe('partial');
    expect(t.meta.coverage?.complete).toBe(false);
  });

  it('config diff never invents history: DATA_UNAVAILABLE with the known indexes', async () => {
    const k = await call('config.diff', { service: 'inv', key: 'db.password' }, cfg);
    expect(k.error?.code).toBe('DATA_UNAVAILABLE');
    expect(k.error?.details).toMatchObject({ provider: 'consul', modify_index: idx.v1 + 2, changed_since_creation: true });
    expect(JSON.stringify(k)).not.toContain('synthetic-consul');
    const f = await call('config.diff', { service: 'inv', from_rev: idx.v1 }, cfg);
    expect(f.error?.code).toBe('DATA_UNAVAILABLE');
    expect((f.error?.details as any).changed_since.map((x: any) => x.key)).toEqual([`${P}cache.ttl_seconds`, `${P}db.password`]);
    const same = await call('config.diff', { service: 'inv', from_rev: fake.index }, cfg);
    expect(same.status).toBe('success');
    expect((same.data as any).changes).toEqual([]);
    expect((await call('config.diff', { service: 'inv', from_rev: fake.index + 100 }, cfg)).error?.code).toBe('INVALID_ARGUMENT');
  });

  it('discovery list: checks aggregated (critical → unhealthy, warning → healthy), Meta masked, not-registered distinguished', async () => {
    const env = await call('discovery.list', { service: 'inv' }, cfg);
    const d = env.data as any;
    expect(d.summary).toMatchObject({ registered: 3, healthy: 2, unhealthy: 1, service_registered: true });
    const m = Object.fromEntries(d.instances.map((x: any) => [x.instance_id, x]));
    expect(m['inv-1']).toMatchObject({ healthy: true, health_basis: 'registry_checks', address: '10.0.1.11', version: '2.1', consul: { status: 'passing' } });
    expect(m['inv-2']).toMatchObject({ healthy: false, address: '10.0.1.1', consul: { status: 'critical' } });
    expect(m['inv-3']).toMatchObject({ healthy: true, consul: { status: 'warning' } });
    expect(JSON.stringify(env)).not.toContain('LEAK');
    expect((await call('discovery.list', { service: 'inv', healthy_only: true, env: 'sandbox' }, cfg)).data).toMatchObject({ summary: { returned: 1, excluded: { env_missing: 1, not_healthy: 1 } } });
    const empty = await call('discovery.list', { service: 'empty', endpoint: 'c1' }, cfg);
    expect((empty.data as any).summary.service_registered).toBe(true);
    const ghost = await call('discovery.list', { service: 'ghost', endpoint: 'c1' }, cfg);
    expect((ghost.data as any).summary).toMatchObject({ registered: 0, service_registered: false });
  });

  it('ACL token via token_ref → X-Consul-Token; bad/missing token UNAUTHENTICATED; key:read missing PERMISSION_DENIED; 5xx / refused UPSTREAM_UNAVAILABLE', async () => {
    fake.token = 'tok-1';
    try {
      const ok = await call('config.get', { service: 'inv' }, writeProviderConfig({ consul: fake.url, consulExtra: { token_ref: 'file:secret' }, secret: 'tok-1' }));
      expect(ok.status).toBe('success');
      expect(fake.calls.at(-1)?.headers['x-consul-token']).toBe('tok-1');
      expect((await call('config.get', { service: 'inv' }, cfg)).error?.code).toBe('UNAUTHENTICATED');
      fake.denyKv = true;
      expect((await call('config.get', { service: 'inv' }, writeProviderConfig({ consul: fake.url, consulExtra: { token_ref: 'file:secret' }, secret: 'tok-1' }))).error?.code).toBe('PERMISSION_DENIED');
    } finally {
      fake.token = null;
      fake.denyKv = false;
    }
    fake.fail = 500;
    try {
      expect((await call('discovery.list', { service: 'inv' }, cfg)).error?.code).toBe('UPSTREAM_UNAVAILABLE');
    } finally {
      fake.fail = null;
    }
    const refused = await call('config.get', { service: 'inv' }, writeProviderConfig({ consul: 'http://127.0.0.1:1' }));
    expect(refused.error?.code).toBe('UPSTREAM_UNAVAILABLE');
    fake.hang = true;
    try {
      const slow = await invoke(r, 'config.get', { service: 'inv' }, { configPath: cfg, timeoutMs: 400 });
      expect(slow.error?.code).toBe('TIMEOUT');
    } finally {
      fake.hang = false;
    }
  });
});

describe('provider selection', () => {
  it('--endpoint kind/name or unique name; planned providers → CAPABILITY_PLANNED; ambiguous/unknown names rejected', async () => {
    const cfg = writeProviderConfig({ nacos: 'http://127.0.0.1:1', consul: 'http://127.0.0.1:1', apollo: true });
    expect((await call('config.get', { service: 'legacy' }, cfg)).error?.code).toBe('CAPABILITY_PLANNED');
    expect((await call('config.get', { service: 'x', endpoint: 'apollo/a1' }, cfg)).error?.code).toBe('CAPABILITY_PLANNED');
    expect((await call('config.get', { service: 'x', endpoint: 'zookeeper/z1' }, cfg)).error?.code).toBe('CAPABILITY_PLANNED');
    expect((await call('config.get', { service: 'x', endpoint: 'nope' }, cfg)).error?.code).toBe('NOT_FOUND');
    expect((await call('config.get', { service: 'x', endpoint: 'redis/r1' }, cfg)).error?.code).toBe('INVALID_ARGUMENT');
    // unbound service with two config kinds and no defaults → NOT_CONFIGURED
    expect((await call('config.get', { service: 'x' }, cfg)).error?.code).toBe('NOT_CONFIGURED');
    // defaults.config picks the kind
    const d = await call('config.get', { service: 'x' }, writeProviderConfig({ nacos: 'http://127.0.0.1:1', consul: 'http://127.0.0.1:1', defaults: { config: 'consul' } }));
    expect(d.error?.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(d.error?.message).toMatch(/Consul/);
  });
});
