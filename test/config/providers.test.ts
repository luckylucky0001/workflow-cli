import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { Registry } from '../../src/core/registry';
import configDomain from '../../src/domains/config';
import { mapConsulError } from '../../src/domains/config/consul';
import { docFormat, mapNacosError, parseDoc, parseProperties } from '../../src/domains/config/nacos';
import { decodeValue, isSecretName } from '../../src/domains/config/values';
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

  it('regression: a continuation backslash on the last line (no final newline) is dropped, as java.util.Properties does', () => {
    expect(parseProperties('a=b\\')).toEqual([['a', 'b']]);
    expect(parseProperties('a=b\\\\')).toEqual([['a', 'b\\']]); // escaped backslash stays
    expect(parseProperties('x=1\na=b\\\n')).toEqual([['x', '1'], ['a', 'b']]);
  });

  it('regression: credentials embedded in values of non-secret names (connection URLs, token= params) are masked in place', () => {
    for (const [raw, shown] of [
      ['jdbc:mysql://app:LEAK1@db:3306/pay?useSSL=false', 'jdbc:mysql://app:***@db:3306/pay?useSSL=false'],
      ['postgres://u:LEAK2@h/db', 'postgres://u:***@h/db'],
      ['redis://:LEAK3@h:6379/0', 'redis://:***@h:6379/0'],
      ['jdbc:postgresql://h/db?user=a&password=LEAK4', 'jdbc:postgresql://h/db?user=a&password=***'],
    ]) {
      expect(decodeValue(Buffer.from(raw), 'db.url')).toEqual({ value: shown, value_format: 'text', value_bytes: null, masked: true, masked_paths: ['$'] });
    }
    expect(decodeValue(Buffer.from('{"url":"mysql://a:LEAK@h/d","n":1}'), 'upstream')).toMatchObject({ value: { url: 'mysql://a:***@h/d', n: 1 }, value_bytes: null, masked_paths: ['$.url'] });
    // no password in the userinfo: nothing to mask
    expect(decodeValue(Buffer.from('https://user@h/x'), 'u')).toMatchObject({ value: 'https://user@h/x', masked: false, value_bytes: 16 });
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
    // regression: YAML merge keys resolve like Spring/SnakeYAML (not a literal "<<" path segment)
    expect(Object.fromEntries(parseDoc('base: &b\n  pool: 4\n  user: u\nother:\n  <<: *b\n  pool: 8\n', 'yaml', 'a.yaml').raw)).toEqual({ 'base.pool': '4', 'base.user': 'u', 'other.pool': '8', 'other.user': 'u' });
    expect(docFormat('html', 'svc.properties')).toBe('text');
    // regression: "text" is Nacos' default type for typeless publishes — the extension decides then
    expect(docFormat('text', 'svc.properties')).toBe('properties');
    expect(docFormat('text', 'svc.yaml')).toBe('yaml');
    expect(docFormat('text', 'svc')).toBe('text');
  });

  it('regression: bare numbers keep their spelling ("1.10" is a version, not 1.1); list indices do not hide secret names', () => {
    const v = (s: string) => decodeValue(Buffer.from(s), 'x');
    expect(v('1.10')).toMatchObject({ value: '1.10', value_format: 'text' });
    expect(v('1e3')).toMatchObject({ value: '1e3', value_format: 'text' });
    expect(v('-0')).toMatchObject({ value: '-0', value_format: 'text' });
    expect(v('1500')).toMatchObject({ value: 1500, value_format: 'json' });
    expect(v('0.25')).toMatchObject({ value: 0.25, value_format: 'json' });
    expect(['credentials[0]', 'dsn[1]', 'db.credential[2].user'].every(isSecretName)).toBe(true);
    expect(isSecretName('hosts[0]')).toBe(false);
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
    // 10.0.0.3 is healthy but enabled=false (offline): not counted as healthy
    expect(d.summary).toMatchObject({ registered: 3, returned: 3, healthy: 1, unhealthy: 1, health_unknown: 0, disabled: 1, service_registered: true });
    expect(d.instances[1]).toMatchObject({ address: '10.0.0.2', healthy: false, health_basis: 'registry_health', nacos: { ephemeral: true, enabled: true }, payload: { token: '***' } });
    expect(d.instances[2].nacos).toMatchObject({ enabled: false, weight: 0.5 });
    expect(JSON.stringify(env)).not.toContain('LEAK');
    const f = await call('discovery.list', { service: 'pay', env: 'sandbox', healthy_only: true }, cfg);
    expect((f.data as any).summary).toMatchObject({ returned: 1, excluded: { env_mismatch: 1, not_healthy: 1 } });
    const none = await call('discovery.list', { service: 'ghost', endpoint: 'n1' }, cfg);
    expect(none.status).toBe('success');
    expect((none.data as any).summary).toMatchObject({ registered: 0, service_registered: false });
  });

  it('regression: username + password_ref against an auth-disabled Nacos (2.4.x login → HTTP 500 "User x not found") is ignored with a note', async () => {
    const env = await call('config.get', { service: 'pay' }, writeProviderConfig({ nacos: fake.url, nacosExtra: { username: 'ro', password_ref: 'file:secret' }, secret: 'pw-1' }));
    expect(env.status).toBe('success');
    expect(env.meta.coverage?.notes?.join('\n')).toMatch(/未开启鉴权，已忽略端点配置的 username（ro）/);
    // with auth on, the same 500 body is a failed login, never UPSTREAM_UNAVAILABLE
    expect(mapNacosError(401, 'caused: User ro not found;', 'x').code).toBe('UNAUTHENTICATED');
  });

  it('regression: a structured document that fails to parse (multi-document YAML) is masked whole, and md5 is withheld when values are masked', async () => {
    fake.publish('multi.yaml', 'a: 1\n---\ndb:\n  password: synthetic-multi\n', 'yaml');
    const env = await call('config.get', { service: 'multi', endpoint: 'n1' }, writeProviderConfig({ nacos: `${fake.url}/nacos`, nacosExtra: { data_id: '${service}.yaml' } }));
    expect(env.status).toBe('success');
    const d = env.data as any;
    expect(d.nacos).toMatchObject({ parsed: false, content_bytes: null });
    expect(d.nacos.parse_error).toMatch(/multiple documents/);
    expect(d.items).toEqual([expect.objectContaining({ name: 'multi.yaml', value: '***', masked: true, value_bytes: null })]);
    expect(JSON.stringify(env)).not.toContain('synthetic-multi');
    const pay = await call('config.get', { service: 'pay' }, cfg);
    expect((pay.data as any).nacos).toMatchObject({ md5: null, content_bytes: null });
    const plain = await call('config.get', { service: 'other', endpoint: 'n1' }, cfg);
    expect((plain.data as any).nacos).toMatchObject({ md5: 'm', content_bytes: 4 });
  });

  it('regression: a .properties document published without a type (Nacos records "text") is split and masked, not returned whole', async () => {
    fake.publish('typeless.properties', 'a=1\ndb.password=synthetic-typeless\n', 'text');
    const env = await call('config.get', { service: 'typeless', endpoint: 'n1' }, cfg);
    const d = env.data as any;
    expect(d.nacos).toMatchObject({ type: 'text', content_format: 'properties', parsed: true });
    expect(by(d.items)).toMatchObject({ a: { value: 1 }, 'db.password': { value: '***', masked: true } });
    expect(JSON.stringify(env)).not.toContain('synthetic-');
  });

  it('regression: list items flattened below a secret-like name (credentials[0], dsn[1]) are masked', async () => {
    fake.publish('lists.yaml', 'credentials:\n  - synthetic-cred-a\n  - user: u\n    note: synthetic-cred-b\ndsn: [x, synthetic-dsn]\nhosts: [h1]\n', 'yaml');
    const env = await call('config.get', { service: 'lists', endpoint: 'n1' }, writeProviderConfig({ nacos: `${fake.url}/nacos`, nacosExtra: { data_id: '${service}.yaml' } }));
    const it = by((env.data as any).items);
    expect(it['credentials[0]']).toMatchObject({ value: '***', masked: true, value_bytes: null });
    expect(it['credentials[1].note']).toMatchObject({ value: '***', masked: true });
    expect(it['dsn[1]']).toMatchObject({ value: '***', masked: true });
    expect(it['hosts[0]']).toMatchObject({ value: 'h1', masked: false });
    expect(JSON.stringify(env)).not.toContain('synthetic-');
  });

  it('regression: unreadable history is reported, not left as an unexplained latest_history_id=null', async () => {
    fake.denyHistory = true;
    try {
      const env = await call('config.get', { service: 'pay' }, cfg);
      expect(env.status).toBe('success');
      expect((env.data as any).nacos.latest_history_id).toBeNull();
      expect(env.meta.coverage?.notes?.join('\n')).toMatch(/配置历史不可读（PERMISSION_DENIED/);
    } finally {
      fake.denyHistory = false;
    }
  });

  it('regression: --from-rev after the config\'s latest change (ids are global) with --to-rev current is an empty diff, not INVALID_ARGUMENT', async () => {
    const later = fake.publish('unrelated.properties', 'z=1\n');
    const env = await call('config.diff', { service: 'pay', from_rev: later }, cfg);
    expect(env.status).toBe('success');
    expect(env.data as any).toMatchObject({ from_revision: later, to_revision: later, current_revision: ids.v3, changes: [], summary: { unchanged: 4 } });
  });

  it('regression: a --from-rev older than the 500 history records read is reported as truncation, not as retention', async () => {
    const first = fake.publish('hist.properties', 'n=0\n');
    for (let n = 1; n <= 501; n++) fake.publish('hist.properties', `n=${n}\n`);
    const env = await call('config.diff', { service: 'hist', endpoint: 'n1', from_rev: first }, cfg);
    expect(env.error?.code).toBe('DATA_UNAVAILABLE');
    expect(env.error?.details).toMatchObject({ history_truncated: true });
    expect(env.error?.hint).toMatch(/超过 500 条/);
    const recent = await call('config.diff', { service: 'hist', endpoint: 'n1', from_rev: fake.nid - 1 }, cfg);
    expect(recent.status).toBe('partial');
    expect((recent.data as any).changes[0]).toMatchObject({ name: 'n', old: { value: 500 }, new: { value: 501 } });
  });

  it('regression: --healthy-only excludes enabled=false (offline) instances and says so', async () => {
    const f = await call('discovery.list', { service: 'pay', healthy_only: true }, cfg);
    const d = f.data as any;
    expect(d.instances.map((x: any) => x.address)).toEqual(['10.0.0.1']);
    expect(d.summary).toMatchObject({ returned: 1, healthy: 1, excluded: { not_healthy: 1, disabled: 1 } });
    expect(f.meta.coverage?.notes?.join('\n')).toMatch(/enabled=false/);
  });

  it('regression: --key over > 500 history records reports the read cap, not "unchanged within retention"', async () => {
    fake.publish('hist2.properties', 'k=old\nn=0\n');
    fake.publish('hist2.properties', 'k=new\nn=1\n');
    for (let n = 2; n <= 503; n++) fake.publish('hist2.properties', `k=new\nn=${n}\n`);
    const env = await call('config.diff', { service: 'hist2', endpoint: 'n1', key: 'k' }, cfg);
    expect(env.error?.code).toBe('DATA_UNAVAILABLE');
    expect(env.error?.details).toMatchObject({ history_truncated: true });
    expect(env.error?.message).toMatch(/500/);
    expect(env.error?.message).not.toMatch(/^保留期内/);
  });

  it('regression: a URL password inside a non-secret key is masked in get/diff; diff still sees a change of the hidden password', async () => {
    fake.publish('urls.properties', 'db.url=jdbc:mysql://app:LEAK-A@db:3306/pay\ncache.url=redis://:LEAK-R@r:6379\n');
    const v2 = fake.publish('urls.properties', 'db.url=jdbc:mysql://app:LEAK-B@db:3306/pay\ncache.url=redis://:LEAK-R@r:6379\n');
    const g = await call('config.get', { service: 'urls', endpoint: 'n1' }, cfg);
    expect(by((g.data as any).items)['db.url']).toMatchObject({ value: 'jdbc:mysql://app:***@db:3306/pay', masked: true, masked_paths: ['$'], value_bytes: null });
    expect(JSON.stringify(g)).not.toContain('LEAK');
    const d = await call('config.diff', { service: 'urls', endpoint: 'n1', from_rev: v2 - 1 }, cfg);
    expect((d.data as any).summary).toMatchObject({ changed: 1, unchanged: 1 });
    expect((d.data as any).changes[0]).toMatchObject({ name: 'db.url', masked: true, old: { value: 'jdbc:mysql://app:***@db:3306/pay', value_bytes: null }, new: { value: 'jdbc:mysql://app:***@db:3306/pay' } });
    expect(JSON.stringify(d)).not.toContain('LEAK');
  });

  it('regression: a cluster with more instances than one catalog page is reported as partial, not complete', async () => {
    fake.services.set('big', Array.from({ length: 1001 }, (_, n) => ({ instanceId: `i-${String(n).padStart(4, '0')}`, ip: '10.1.0.1', port: n, healthy: true, enabled: true, ephemeral: true, clusterName: 'DEFAULT', metadata: {} })));
    const env = await call('discovery.list', { service: 'big', endpoint: 'n1' }, cfg);
    expect(env.status).toBe('partial');
    expect(env.meta.coverage).toMatchObject({ complete: false, truncated: true });
    expect((env.data as any).summary).toMatchObject({ registered: 1001, returned: 1000 });
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

  it('regression: a JSON value with a masked field has value_bytes=null (raw size minus the shown fields = secret length)', async () => {
    const env = await call('config.get', { service: 'inv', key: 'upstream.order' }, cfg);
    expect((env.data as any).items[0]).toMatchObject({ value: { url: 'http://x', api_key: '***' }, masked: true, masked_paths: ['$.api_key'], value_bytes: null });
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

  it('regression: X-Consul-Index of a single key is its ModifyIndex, not the store index: --from-rev after it is an empty diff, not INVALID_ARGUMENT', async () => {
    const keyMod = idx.v1 + 1; // cache.ttl_seconds; db.password was written after it
    const env = await call('config.diff', { service: 'inv', key: 'cache.ttl_seconds', from_rev: keyMod + 1 }, cfg);
    expect(env.status).toBe('success');
    expect(env.data as any).toMatchObject({ from_revision: keyMod + 1, current_revision: keyMod, changes: [], summary: { unchanged: 1 } });
    // an explicit --to-rev at/after the last write is the current state as well
    expect((await call('config.diff', { service: 'inv', key: 'cache.ttl_seconds', from_rev: keyMod, to_rev: String(fake.index) }, cfg)).status).toBe('success');
    expect((await call('config.diff', { service: 'inv', key: 'cache.ttl_seconds', from_rev: keyMod - 1, to_rev: String(keyMod - 1) }, cfg)).error?.code).toBe('DATA_UNAVAILABLE');
    // beyond the KV store index is still rejected
    expect((await call('config.diff', { service: 'inv', key: 'cache.ttl_seconds', from_rev: fake.index + 1 }, cfg)).error?.code).toBe('INVALID_ARGUMENT');
  });

  it('regression: results filtered by ACLs (X-Consul-Results-Filtered-By-ACLs) are partial, not complete', async () => {
    fake.aclFiltered = true;
    try {
      const g = await call('config.get', { service: 'inv' }, cfg);
      expect(g.status).toBe('partial');
      expect(g.meta.coverage?.complete).toBe(false);
      const d = await call('discovery.list', { service: 'inv' }, cfg);
      expect(d.status).toBe('partial');
      expect(d.meta.coverage?.notes?.join('\n')).toMatch(/ACL/);
      // absence in a filtered catalog is unknown, not "not registered"
      const ghost = await call('discovery.list', { service: 'ghost', endpoint: 'c1' }, cfg);
      expect((ghost.data as any).summary.service_registered).toBeNull();
    } finally {
      fake.aclFiltered = false;
    }
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

  it('regression: credentials in health-check output (URL userinfo, ?token=, Authorization) are masked', async () => {
    const out = (o: string) => ({ CheckID: 'http', Name: 'http', Status: 'critical', ServiceID: 'leaky-1', Output: o });
    fake.health.set('leaky', [
      { Node: { Node: 'n1', Address: '10.0.1.1' }, Service: { ID: 'leaky-1', Service: 'leaky', Port: 1 }, Checks: [out('HTTP GET http://admin:LEAK-PW@10.0.1.1:8080/health?token=LEAK-TOK&x=1: 503'), out('Authorization: Bearer LEAK-BEARER-0123456789'), out('TCP connect 10.0.1.1:1: Success')] },
    ]);
    const env = await call('discovery.list', { service: 'leaky', endpoint: 'c1' }, cfg);
    const checks = (env.data as any).instances[0].consul.checks.map((c: any) => c.output);
    expect(checks).toEqual(['HTTP GET http://admin:***@10.0.1.1:8080/health?token=***&x=1: 503', 'Authorization: Bearer ***', 'TCP connect 10.0.1.1:1: Success']);
    expect(JSON.stringify(env)).not.toContain('LEAK');
    expect(env.meta.coverage?.notes?.join('\n')).toMatch(/健康检查输出/);
  });

  it('regression: a connection URL under a non-secret key is masked in place (rest of the URL kept)', async () => {
    fake.put('config/sandbox/urls/db.url', 'postgres://u:LEAK-PG@h:5432/db');
    const env = await call('config.get', { service: 'urls', endpoint: 'c1' }, cfg);
    expect((env.data as any).items[0]).toMatchObject({ name: 'db.url', value: 'postgres://u:***@h:5432/db', masked: true, value_bytes: null });
    expect(JSON.stringify(env)).not.toContain('LEAK');
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
