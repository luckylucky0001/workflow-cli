import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { Registry } from '../../src/core/registry';
import { builtinRegistry } from '../../src/domains';
import configDomain from '../../src/domains/config';
import { mapEtcdError, prefixRangeEnd } from '../../src/domains/config/etcd';
import { decodeValue, isSecretName, parseRev } from '../../src/domains/config/values';
import { FakeEtcd, writeEtcdConfig } from './fake-etcd';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';

function registry(): Registry {
  const r = new Registry();
  r.addDomain(configDomain);
  return r;
}

const P = '/config/sandbox/demo-order/';
const S = '/services/demo-order/';
const BIG_LEASE = '7587898288280331665'; // > 2^53: must survive as a string

describe('config domain definition', () => {
  it('registers config get / config diff / discovery list with full metadata, replacing the planned entries', () => {
    const r = registry();
    const caps = r.list({ domain: 'config' });
    expect(caps.map((c) => c.command).sort()).toEqual(['config diff', 'config get', 'discovery list']);
    for (const c of caps) {
      expect(c.status).toBe('available');
      expect(c.adapter).toBe('etcd-v3-gateway|nacos-open-api|consul-http-api');
      expect(c.auth_provider).toBe('etcd-profile | nacos-token | consul-acl-token');
      expect(c.operation).toBe('read');
      expect(c.examples?.length).toBeGreaterThan(0);
      expect(c.notes?.length).toBeGreaterThan(0);
      expect(() => r.outputJsonSchema(c)).not.toThrow();
    }
    expect(r.probes.has('etcd')).toBe(true);
    expect(r.probes.has('nacos')).toBe(true);
    expect(r.probes.has('consul')).toBe(true);
    const all = builtinRegistry();
    expect(all.get('config.get')!.status).toBe('available');
    expect(all.domains.get('config')!.title).toBe('配置与服务发现');
    expect(all.list({ status: 'planned' }).some((c) => c.domain === 'config')).toBe(false);
  });
});

describe('etcd helpers (pure)', () => {
  it('computes prefix range_end like etcd (increment last byte < 0xff, truncate)', () => {
    expect(prefixRangeEnd(Buffer.from('/config/')).toString()).toBe('/config0');
    expect([...prefixRangeEnd(Buffer.from([0x61, 0xff, 0xff]))]).toEqual([0x62]);
    expect([...prefixRangeEnd(Buffer.from([0xff]))]).toEqual([0]);
  });

  it('recognises secret-like names by segment, not by value', () => {
    for (const n of ['db.password', 'DB_PASSWORD', 'client.api_token', 'apiKey', 'oauth.client_secret', 'tls.private_key', 'mysql.dsn', 'cache.key']) expect(isSecretName(n), n).toBe(true);
    for (const n of ['cache.ttl_seconds', 'cache.mode', 'db.pool_size', 'feature.flags', 'monkey.count']) expect(isSecretName(n), n).toBe(false);
  });

  it('CJK secret names are masked; a JSON "__proto__" member is kept (and masked), not dropped', () => {
    for (const n of ['数据库.密码', 'redis.口令', 'jwt.密钥', 'api.访问令牌', 'oss.凭证']) expect(isSecretName(n), n).toBe(true);
    for (const n of ['缓存.过期秒数', '数据库.连接池']) expect(isSecretName(n), n).toBe(false);
    expect(decodeValue(Buffer.from('hunter2'), '数据库.密码')).toMatchObject({ value: '***', masked: true });
    const d = decodeValue(Buffer.from('[{"__proto__":{"token":"t1","ttl":5}}]'), 'conf.json');
    expect(JSON.stringify(d.value)).toBe('[{"__proto__":{"token":"***","ttl":5}}]');
    expect(d.masked_paths).toEqual(['$[0].__proto__.token']);
  });

  it('decodes JSON / text / binary values and masks secrets (whole value or JSON fields)', () => {
    expect(decodeValue(Buffer.from('300'), 'cache.ttl_seconds')).toMatchObject({ value: 300, value_format: 'json', masked: false });
    expect(decodeValue(Buffer.from('read-through'), 'cache.mode')).toMatchObject({ value: 'read-through', value_format: 'text' });
    expect(decodeValue(Buffer.from('缓存-中文'), 'cache.label')).toMatchObject({ value: '缓存-中文', value_format: 'text', value_bytes: 13 });
    expect(decodeValue(Buffer.from([0xff, 0xfe, 0x00]), 'blob')).toMatchObject({ value: '//4A', value_format: 'binary_base64' });
    expect(decodeValue(Buffer.from(''), 'x')).toMatchObject({ value: '', value_format: 'empty' });
    expect(decodeValue(Buffer.from('s3cr3t'), 'db.password')).toEqual({ value: '***', value_format: 'text', value_bytes: null, masked: true, masked_paths: ['$'] });
    const nested = decodeValue(Buffer.from(JSON.stringify({ url: 'http://x', auth: { token: 'abc', user: 'u' }, list: [{ password: 'p' }] })), 'upstream.payment');
    expect(nested.value).toEqual({ url: 'http://x', auth: { token: '***', user: 'u' }, list: [{ password: '***' }] });
    expect(nested.masked_paths).toEqual(['$.auth.token', '$.list[0].password']);
    expect(JSON.stringify(nested)).not.toContain('abc');
  });

  it('masks every scalar below a secret-named JSON object/array field (regression: nested leak)', () => {
    const d = decodeValue(Buffer.from(JSON.stringify({ url: 'http://x', credentials: { user: 'u', pass: 'LEAK-1' }, api_keys: ['LEAK-2', null], secrets: [{ v: 'LEAK-3' }] })), 'upstream.auth');
    expect(d.value).toEqual({ url: 'http://x', credentials: { user: '***', pass: '***' }, api_keys: ['***', null], secrets: [{ v: '***' }] });
    expect(d.masked_paths).toEqual(['$.credentials.user', '$.credentials.pass', '$.api_keys[0]', '$.secrets[0].v']);
    expect(JSON.stringify(d)).not.toContain('LEAK');
  });

  it('never rounds integers beyond 2^53 (regression: 7587898288280331665 shown as ...331000)', () => {
    expect(decodeValue(Buffer.from('7587898288280331665'), 'snowflake.id')).toMatchObject({ value: '7587898288280331665', value_format: 'text' });
    expect(decodeValue(Buffer.from('1e400'), 'x')).toMatchObject({ value: '1e400', value_format: 'text' });
    expect(decodeValue(Buffer.from('9007199254740991'), 'x')).toMatchObject({ value: 9007199254740991, value_format: 'json' });
    const nested = decodeValue(Buffer.from('{"id": 7587898288280331665, "s": "12345678901234567890", "f": 0.12345678901234567890, "token": 12345678901234567890}'), 'x');
    expect(nested.value).toEqual({ id: '7587898288280331665', s: '12345678901234567890', f: 0.12345678901234568, token: '***' });
    expect(nested.masked_paths).toEqual(['$.token']);
  });

  it('parses revisions strictly', () => {
    expect(parseRev('--to-rev', 'current')).toBe('current');
    expect(parseRev('--to-rev', '12')).toBe(12);
    for (const bad of ['0', '-1', '1.5', 'abc', '']) expect(() => parseRev('--to-rev', bad)).toThrow(/正整数/);
  });

  it('maps gateway errors to stable codes', () => {
    const m = (status: number, code: number, message: string) => mapEtcdError(status, { error: message, code, message }, 'x').code;
    expect(m(400, 11, 'etcdserver: mvcc: required revision has been compacted')).toBe('DATA_UNAVAILABLE');
    expect(m(400, 11, 'etcdserver: mvcc: required revision is a future revision')).toBe('INVALID_ARGUMENT');
    expect(m(401, 16, 'etcdserver: invalid auth token')).toBe('UNAUTHENTICATED');
    expect(m(400, 3, 'etcdserver: user name is empty')).toBe('UNAUTHENTICATED');
    expect(m(400, 3, 'etcdserver: authentication failed, invalid user ID or password')).toBe('UNAUTHENTICATED');
    expect(m(403, 7, 'etcdserver: permission denied')).toBe('PERMISSION_DENIED');
    expect(m(400, 3, 'invalid character')).toBe('INVALID_ARGUMENT');
    expect(m(503, 14, 'etcdserver: no leader')).toBe('UPSTREAM_UNAVAILABLE');
  });
});

describe('config / discovery against a fake etcd gateway', () => {
  const fake = new FakeEtcd();
  const r = registry();
  let configPath: string;
  const revs: Record<string, number> = {};

  beforeAll(async () => {
    configPath = writeEtcdConfig(await fake.start());
    fake.put(`${P}cache.ttl_seconds`, '300');
    fake.put(`${P}cache.mode`, 'read-through');
    fake.put(`${P}db.password`, 'synthetic-pw-1');
    fake.put(`${P}feature.legacy_mode`, 'on');
    revs.v1 = fake.put(`${P}feature.flags`, JSON.stringify({ new_checkout: false }));
    fake.put(`${P}cache.ttl_seconds`, '60');
    fake.del(`${P}feature.legacy_mode`);
    fake.put(`${P}db.password`, 'synthetic-pw-2');
    fake.put(`${P}cache.mode`, 'read-through'); // same value rewrite
    fake.put(`${P}label`, '订单服务');
    revs.v2 = fake.put(`${P}feature.flags`, JSON.stringify({ new_checkout: true }));
    fake.put('/config/sandbox/demo-order-other/x', 'not mine'); // sibling prefix must not leak in
    fake.grant(BIG_LEASE, 600, 540);
    fake.put(`${S}order-1`, JSON.stringify({ address: '10.0.0.1', port: 8080, version: '1.0', healthy: true, env: 'sandbox', registered_at: '2026-10-17T00:00:00Z' }), BIG_LEASE);
    fake.put(`${S}order-2`, JSON.stringify({ address: '10.0.0.2', port: 8080, version: '1.0', healthy: false, env: 'sandbox' }), BIG_LEASE);
    fake.put(`${S}order-3`, JSON.stringify({ address: '10.0.0.3', port: 8080, healthy: true, env: 'prod' }));
    fake.put(`${S}order-4`, 'not-json');
    fake.put(`${S}order-5`, JSON.stringify({ address: '10.0.0.5', port: 8080, healthy: true }), '99');
    revs.end = fake.rev;
  });
  afterAll(() => fake.stop());

  const call = (cap: string, inputs: Record<string, unknown>, path = configPath) => invoke(r, cap, inputs, { configPath: path });

  it('config get: base64 keys/values decoded, JSON parsed, secrets masked, prefix boundary respected', async () => {
    const env = await call('config.get', { service: 'demo-order' });
    expect(env.status).toBe('success');
    expect(env.meta.warnings).toEqual([]);
    const d = env.data as any;
    expect(d.prefix).toBe(P);
    expect(d.observed_revision).toBe(revs.end);
    expect(d.items.map((x: any) => x.name)).toEqual(['cache.mode', 'cache.ttl_seconds', 'db.password', 'feature.flags', 'label']);
    const by = Object.fromEntries(d.items.map((x: any) => [x.name, x]));
    expect(by['cache.ttl_seconds']).toMatchObject({ value: 60, value_format: 'json', version: 2, lease: null });
    expect(by['feature.flags'].value).toEqual({ new_checkout: true });
    expect(by.label.value).toBe('订单服务');
    expect(by['db.password']).toMatchObject({ value: '***', masked: true, version: 2 });
    expect(JSON.stringify(env)).not.toContain('synthetic-pw');
    expect(env.meta.coverage!.notes!.join('')).toContain('遮蔽');
    expect(env.meta.sources[0]).toMatchObject({ system: 'etcd', adapter: 'etcd-v3-gateway', version: '3.5.99-fake' });
  });

  it('config get: single key, missing key (NOT_FOUND with nearby keys), empty prefix (success + note), truncation', async () => {
    const one = await call('config.get', { service: 'demo-order', key: 'cache.mode' });
    expect((one.data as any).items).toHaveLength(1);
    const miss = await call('config.get', { service: 'demo-order', key: 'nope' });
    expect(miss.error).toMatchObject({ code: 'NOT_FOUND' });
    expect(miss.error!.hint).toContain('cache.mode');
    const empty = await call('config.get', { service: 'ghost' });
    expect(empty.status).toBe('success');
    expect((empty.data as any).items).toEqual([]);
    expect(empty.meta.coverage).toMatchObject({ complete: true });
    expect(empty.meta.coverage!.notes!.join('')).toContain('没有配置项');
    const cut = await call('config.get', { service: 'demo-order', limit: 2 });
    expect(cut.status).toBe('partial');
    expect(cut.data).toMatchObject({ truncated: true, count: 5 });
    expect(cut.meta.coverage).toMatchObject({ complete: false, truncated: true });
    const bad = await call('config.get', { service: '../etc' });
    expect(bad.error!.code).toBe('INVALID_ARGUMENT');
    const badKey = await call('config.get', { service: 'demo-order', key: '../x' });
    expect(badKey.error!.code).toBe('INVALID_ARGUMENT');
  });

  it('config diff between two revisions: added / removed / changed, masked, same-value rewrites', async () => {
    const env = await call('config.diff', { service: 'demo-order', from_rev: revs.v1, to_rev: String(revs.v2) });
    expect(env.status).toBe('success');
    expect(env.meta.warnings).toEqual([]);
    const d = env.data as any;
    expect(d).toMatchObject({ mode: 'revisions', from_revision: revs.v1, to_revision: revs.v2 });
    const by = Object.fromEntries(d.changes.map((c: any) => [c.name, c]));
    expect(by['cache.ttl_seconds']).toMatchObject({ change: 'changed', old: { value: 300 }, new: { value: 60 } });
    expect(by['feature.legacy_mode']).toMatchObject({ change: 'removed', new: null, old: { value: 'on' } });
    expect(by.label).toMatchObject({ change: 'added', old: null });
    expect(by['db.password']).toMatchObject({ change: 'changed', masked: true, old: { value: '***' }, new: { value: '***' } });
    expect(by['cache.mode']).toBeUndefined();
    expect(d.summary).toMatchObject({ added: 1, removed: 1, changed: 3, unchanged: 1, rewritten_same_value: 1 });
    expect(JSON.stringify(env)).not.toContain('synthetic-pw');
  });

  it('config diff --key without --from-rev compares with the previous version (mod_revision-1)', async () => {
    const env = await call('config.diff', { service: 'demo-order', key: 'cache.ttl_seconds' });
    const d = env.data as any;
    expect(d.mode).toBe('previous_version');
    expect(d.changes).toEqual([expect.objectContaining({ change: 'changed', old: expect.objectContaining({ value: 300, version: 1 }), new: expect.objectContaining({ value: 60, version: 2 }) })]);
    expect(d.from_revision).toBe(d.changes[0].new.mod_revision - 1);
    const first = await call('config.diff', { service: 'demo-order', key: 'label' });
    expect((first.data as any).changes[0].change).toBe('added');
    expect(first.meta.coverage!.notes!.join('')).toContain('version=1');
    const none = await call('config.diff', { service: 'demo-order' });
    expect(none.error!.code).toBe('INVALID_ARGUMENT');
  });

  it('config diff: future revision / malformed revision → INVALID_ARGUMENT', async () => {
    const fut = await call('config.diff', { service: 'demo-order', from_rev: revs.end + 100 });
    expect(fut.error).toMatchObject({ code: 'INVALID_ARGUMENT', details: { current_revision: revs.end } });
    expect((await call('config.diff', { service: 'demo-order', from_rev: 'abc' })).error!.code).toBe('INVALID_ARGUMENT');
    expect((await call('config.diff', { service: 'demo-order', from_rev: 2, to_rev: 'x' })).error!.code).toBe('INVALID_ARGUMENT');
    expect((await call('config.diff', { service: 'demo-order', from_rev: 5, to_rev: '3' })).error!.code).toBe('INVALID_ARGUMENT');
  });

  it('config diff: compacted from-rev → DATA_UNAVAILABLE with the earliest readable revision', async () => {
    fake.compact(revs.v1 + 2);
    try {
      const env = await call('config.diff', { service: 'demo-order', from_rev: revs.v1 });
      expect(env.status).toBe('error');
      expect(env.error).toMatchObject({ code: 'DATA_UNAVAILABLE', details: { requested_revision: revs.v1, compact_revision: revs.v1 + 2, current_revision: revs.end } });
      expect(env.error!.hint).toContain(String(revs.v1 + 2));
      const ok = await call('config.diff', { service: 'demo-order', from_rev: revs.v1 + 2 });
      expect(ok.status).toBe('success');
    } finally {
      fake.compact(0);
    }
  });

  it('discovery list: payload parsed, lease id kept as string, remaining TTL, leaseless registrations flagged', async () => {
    const env = await call('discovery.list', { service: 'demo-order' });
    expect(env.status).toBe('success');
    expect(env.meta.warnings).toEqual([]);
    const d = env.data as any;
    const by = Object.fromEntries(d.instances.map((x: any) => [x.instance_id, x]));
    expect(by['order-1']).toMatchObject({ address: '10.0.0.1', port: 8080, healthy: true, env: 'sandbox', registered_at: '2026-10-17T00:00:00Z' });
    expect(by['order-1'].lease.id).toBe(BIG_LEASE);
    expect(by['order-1'].lease.granted_ttl_s).toBe(600);
    expect(by['order-1'].lease.remaining_ttl_s).toBeGreaterThan(500);
    expect(by['order-1'].lease.remaining_ttl_s).toBeLessThanOrEqual(540);
    expect(by['order-3'].lease).toBeNull();
    expect(by['order-4']).toMatchObject({ payload: null, healthy: null });
    expect(by['order-4'].payload_error).toContain('不是 JSON');
    expect(by['order-5'].lease).toMatchObject({ id: '99', remaining_ttl_s: -1 });
    expect(d.summary).toMatchObject({ registered: 5, returned: 5, healthy: 3, unhealthy: 1, health_unknown: 1, without_lease: 2 });
    const notes = env.meta.coverage!.notes!.join('\n');
    expect(notes).toContain('不会因实例下线而自动过期');
    expect(notes).toContain('TTL=-1');
    expect(fake.calls.filter((c) => c === '/v3/lease/timetolive').length).toBeGreaterThanOrEqual(2);
    expect(env.meta.sources.map((s) => s.relation)).toEqual(['explicit', 'sampled']);
  });

  it('discovery list: --env and --healthy-only filters are reported, empty service is success', async () => {
    const env = await call('discovery.list', { service: 'demo-order', env: 'sandbox', healthy_only: true });
    const d = env.data as any;
    expect(d.instances.map((x: any) => x.instance_id)).toEqual(['order-1']);
    expect(d.summary.excluded).toEqual({ env_mismatch: 1, env_missing: 2, not_healthy: 1 });
    const empty = await call('discovery.list', { service: 'ghost' });
    expect(empty.status).toBe('success');
    expect((empty.data as any).instances).toEqual([]);
    expect(empty.meta.coverage!.notes!.join('')).toContain('没有注册');
  });

  it('probe reports version, leader and db size', async () => {
    const reg = new Registry();
    reg.addDomain(configDomain);
    const probe = reg.probes.get('etcd')!;
    const { loadConfig } = await import('../../src/core/config');
    const { Ctx } = await import('../../src/core/runtime');
    const ctx = new Ctx({ registry: reg, loaded: loadConfig(configPath), profileName: 't', requestId: 'r', timeoutMs: 5000 });
    const res = await probe(ctx, 'e1');
    expect(res).toMatchObject({ ok: true, identity: 'anonymous', version: '3.5.99-fake' });
    expect(res.detail).toContain('24576');
    expect(res.detail).toContain('认证未开启');
  });
  it('regression: a URL password inside a non-secret key (db.url) is masked in get/diff; diff still detects a password-only change', async () => {
    const before = fake.put('/config/sandbox/urls/db.url', 'jdbc:mysql://app:LEAK-1@db:3306/order');
    fake.put('/config/sandbox/urls/db.url', 'jdbc:mysql://app:LEAK-2@db:3306/order');
    const g = await call('config.get', { service: 'urls' });
    expect((g.data as any).items[0]).toMatchObject({ value: 'jdbc:mysql://app:***@db:3306/order', masked: true, masked_paths: ['$'], value_bytes: null });
    const d = await call('config.diff', { service: 'urls', from_rev: before });
    expect((d.data as any).changes).toMatchObject([{ name: 'db.url', change: 'changed', masked: true, old: { value: 'jdbc:mysql://app:***@db:3306/order', value_bytes: null } }]);
    expect(JSON.stringify([g, d])).not.toContain('LEAK');
  });
});

describe('config / discovery edge cases (regressions)', () => {
  const fake = new FakeEtcd();
  const r = registry();
  let configPath: string;
  const BULK = '/config/sandbox/bulk/';
  let fromRev = 0;
  beforeAll(async () => {
    configPath = writeEtcdConfig(await fake.start());
    for (let n = 0; n <= 1000; n++) fake.put(`${BULK}k${String(n).padStart(4, '0')}`, String(n));
    fromRev = fake.rev;
    fake.del(`${BULK}k0000`);
    for (let n = 0; n <= 1000; n++) fake.put(`/services/bulk/i-${String(n).padStart(4, '0')}`, '{}');
    fake.put('/services/tokenizer/tokenizer-1', JSON.stringify({ address: '10.0.0.7', port: 9000, healthy: true, password: 'LEAK' }));
  });
  afterAll(() => fake.stop());
  const call = (cap: string, inputs: Record<string, unknown>) => invoke(r, cap, inputs, { configPath });

  it('config diff with a truncated snapshot does not report keys past the truncation point as added/removed', async () => {
    const env = await call('config.diff', { service: 'bulk', from_rev: fromRev });
    expect(env.status).toBe('partial');
    expect((env.data as any).changes.map((c: any) => [c.name, c.change])).toEqual([['k0000', 'removed']]);
    expect(env.meta.coverage).toMatchObject({ complete: false, truncated: true });
  });

  it('discovery list: registered counts all keys under the prefix even when truncated', async () => {
    const env = await call('discovery.list', { service: 'bulk' });
    expect(env.status).toBe('partial');
    expect((env.data as any).summary).toMatchObject({ registered: 1001, returned: 1000 });
  });

  it('discovery list: an instance id that looks secret-like (tokenizer-1) is still parsed; payload fields still masked', async () => {
    const env = await call('discovery.list', { service: 'tokenizer' });
    expect((env.data as any).instances[0]).toMatchObject({ address: '10.0.0.7', port: 9000, healthy: true, payload_error: null, payload: { password: '***' } });
    expect(JSON.stringify(env)).not.toContain('LEAK');
  });
});

describe('etcd auth and connectivity errors', () => {
  const fake = new FakeEtcd();
  const r = registry();
  let url: string;
  beforeAll(async () => {
    url = await fake.start();
    fake.auth = { users: { reader: 'pw-ok' }, denyPrefix: { reader: '/services/' } };
    fake.put(`${P}cache.mode`, 'x');
  });
  afterAll(() => fake.stop());

  it('authenticates with username + password_ref and sends the token', async () => {
    const env = await invoke(r, 'config.get', { service: 'demo-order' }, { configPath: writeEtcdConfig(url, { username: 'reader', password_ref: 'file:etcd_pw' }, 'pw-ok') });
    expect(env.status).toBe('success');
    expect(JSON.stringify(env)).not.toContain('pw-ok');
  });

  it('no credentials on an auth-enabled cluster → UNAUTHENTICATED; wrong password → UNAUTHENTICATED', async () => {
    expect((await invoke(r, 'config.get', { service: 'demo-order' }, { configPath: writeEtcdConfig(url) })).error!.code).toBe('UNAUTHENTICATED');
    const bad = await invoke(r, 'config.get', { service: 'demo-order' }, { configPath: writeEtcdConfig(url, { username: 'reader', password_ref: 'file:etcd_pw' }, 'wrong') });
    expect(bad.error!.code).toBe('UNAUTHENTICATED');
    expect(JSON.stringify(bad)).not.toContain('wrong');
  });

  it('role without permission on the prefix → PERMISSION_DENIED', async () => {
    const env = await invoke(r, 'discovery.list', { service: 'demo-order' }, { configPath: writeEtcdConfig(url, { username: 'reader', password_ref: 'file:etcd_pw' }, 'pw-ok') });
    expect(env.error!.code).toBe('PERMISSION_DENIED');
  });

  it('connection refused → UPSTREAM_UNAVAILABLE', async () => {
    const env = await invoke(r, 'config.get', { service: 'demo-order' }, { configPath: writeEtcdConfig('http://127.0.0.1:1') });
    expect(env.error).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', retryable: true });
  });

  it('missing endpoint → NOT_CONFIGURED', async () => {
    const p = writeEtcdConfig(url);
    const { readFileSync, writeFileSync } = await import('node:fs');
    const cfg = JSON.parse(readFileSync(p, 'utf8'));
    cfg.profiles.t.endpoints = {};
    cfg.profiles.t.defaults = {};
    writeFileSync(p, JSON.stringify(cfg));
    expect((await invoke(r, 'config.get', { service: 'demo-order' }, { configPath: p })).error!.code).toBe('NOT_CONFIGURED');
  });
});

describe('maskCredentialText: xml/html documents', () => {
  it('masks secret-named elements and quoted attributes by the key-name rule, leaves other text alone', async () => {
    const { maskCredentialText } = await import('../../src/domains/config/values');
    const doc = maskCredentialText('<c><db.url>jdbc:mysql://h/db</db.url><db.password>S3cr3t!</db.password><api-key a="1">abc</api-key><name>tokenizer</name><x token=\'tk\' user="app"/></c>');
    expect(doc.masked).toBe(true);
    expect(doc.text).not.toMatch(/S3cr3t|>abc<|'tk'/);
    expect(doc.text).toContain('<db.password>***</db.password>');
    expect(doc.text).toContain('<db.url>jdbc:mysql://h/db</db.url>');
    expect(doc.text).toContain('<name>tokenizer</name>');
    expect(doc.text).toContain('user="app"');
    expect(maskCredentialText('<name>tokenizer</name>').masked).toBe(false);
  });
});
