/**
 * Live integration tests against the demo Redis (demo/environment, `./up.sh redis`).
 * Run with: WORKCTL_IT=1 npx vitest run test/redis
 * Writes only keys under workctl:it:<run>:* (with TTL) and a temporary ACL user.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import type { Envelope } from '../../src/core/output';
import { Registry } from '../../src/core/registry';
import redisDomain from '../../src/domains/redis';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';
const CONFIG = resolve(__dirname, '../../demo/environment/workctl.yaml');
const RUN = `workctl:it:${Date.now().toString(36)}`;
const r = new Registry();
r.addDomain(redisDomain);
const call = (cap: string, inputs: Record<string, unknown>, configPath = CONFIG) => invoke(r, cap, inputs, { configPath });
const ok = (env: Envelope) => {
  expect(env.error, JSON.stringify(env.error)).toBeNull();
  expect(env.meta.warnings).toEqual([]);
  expect(env.meta.sources.length).toBeGreaterThan(0);
  return env.data as any;
};

describe.skipIf(process.env.WORKCTL_IT !== '1')('redis live (demo-redis)', () => {
  let client: Redis;
  beforeAll(async () => {
    client = new Redis({ host: '127.0.0.1', port: 16379 });
    await client.set(`${RUN}:str`, 'x'.repeat(3000), 'EX', 600);
    await client.set(`${RUN}:noexp`, 'v');
    await client.expire(`${RUN}:noexp`, 600);
    await client.persist(`${RUN}:noexp`);
    await client.rpush(`${RUN}:list`, ...Array.from({ length: 50 }, (_, k) => `item-${k}`));
    await client.expire(`${RUN}:list`, 600);
    await client.hset(`${RUN}:hash`, { a: '1', b: '2' });
    await client.expire(`${RUN}:hash`, 600);
    for (let k = 0; k < 300; k++) await client.get(`${RUN}:str`);
  });
  afterAll(async () => {
    await client.del(`${RUN}:str`, `${RUN}:noexp`, `${RUN}:list`, `${RUN}:hash`);
    await client.call('ACL', 'DELUSER', 'workctl_it_limited').catch(() => undefined);
    client.disconnect();
  });

  it('instance get: engine facts + binding', async () => {
    const d = ok(await call('redis.instance.get', {}));
    expect(d.server.redis_version).toMatch(/^7\.4\./);
    expect(d.memory.maxmemory_policy).toBe('allkeys-lfu');
    expect(d.memory.maxmemory).toBe(64 * 1024 * 1024);
    expect(d.binding.id).toBe('demo-redis');
  });

  it('info get labels semantics', async () => {
    const d = ok(await call('redis.info.get', { section: 'stats' }));
    expect(d.semantics.stats.keyspace_hits).toBe('cumulative_since_start');
    expect(d.semantics.stats.instantaneous_ops_per_sec).toBe('instantaneous_estimate');
  });

  it('stats sample computes window deltas', async () => {
    const env = await call('redis.stats.sample', { duration: '1s' });
    const d = ok(env);
    expect(d.window.duration_ms).toBeGreaterThanOrEqual(900);
    expect(d.restart_detected).toBe(false);
    expect(d.deltas.total_commands_processed).toBeGreaterThanOrEqual(1);
    expect(env.meta.coverage?.window).toBeDefined();
  });

  it('key inspect: TTL, encoding, memory, LFU, capped value', async () => {
    const s = ok(await call('redis.key.inspect', { key: `${RUN}:str`, include_value: true }));
    expect(s.type).toBe('string');
    expect(s.ttl_ms).toBeGreaterThan(0);
    expect(s.length).toBe(3000);
    expect(s.memory_bytes).toBeGreaterThan(3000);
    expect(s.lfu_counter).toBeGreaterThan(5);
    expect(s.value.truncated).toBe(true);
    expect(s.value.data.length).toBe(1024);
    const n = ok(await call('redis.key.inspect', { key: `${RUN}:noexp` }));
    expect(n.ttl_ms).toBeNull();
    const l = ok(await call('redis.key.inspect', { key: `${RUN}:list`, include_value: true }));
    expect(l.value).toMatchObject({ kind: 'list', returned: 20, truncated: true });
    expect((await call('redis.key.inspect', { key: `${RUN}:missing` })).error?.code).toBe('NOT_FOUND');
  });

  it('key sample: budgeted SCAN with coverage', async () => {
    const env = await call('redis.key.sample', { pattern: `${RUN}:*`, max_keys: 100, max_scan_calls: 5000, scan_count: 1000 });
    const d = ok(env);
    expect(d.scan.unique_keys).toBe(4);
    expect(d.scan.cursor_complete).toBe(true);
    expect(env.meta.coverage).toMatchObject({ complete: true, sampled: true });
    expect(d.type_counts).toMatchObject({ string: 2, list: 1, hash: 1 });
    expect(d.top_keys[0].key).toBe(`${RUN}:str`);
    const partial = await call('redis.key.sample', { pattern: '*', max_keys: 5, max_scan_calls: 1 });
    expect(partial.meta.coverage?.complete).toBe(false);
  });

  it('key hot uses OBJECT FREQ under LFU', async () => {
    const d = ok(await call('redis.key.hot', { pattern: `${RUN}:*`, max_keys: 100, max_scan_calls: 5000, scan_count: 1000, top: 2 }));
    expect(d.maxmemory_policy).toBe('allkeys-lfu');
    expect(d.hot_keys[0].key).toBe(`${RUN}:str`);
  });

  it('slowlog and config (redacted)', async () => {
    const s = ok(await call('redis.slowlog.list', { limit: 5 }));
    expect(s.config).toMatchObject({ slower_than_us: 1000, max_len: 256, config_readable: true });
    const c = ok(await call('redis.config.get', { pattern: 'requirepass' }));
    expect(c.parameters.requirepass).toBe('<redacted>');
    expect(c.redacted).toEqual(['requirepass']);
  });

  it('ACL NOPERM → PERMISSION_DENIED; wrong password → UNAUTHENTICATED', async () => {
    await client.call('ACL', 'SETUSER', 'workctl_it_limited', 'reset', 'on', '>it-limited-pw', '~*', '+@read', '+info', '+ping', '-config');
    process.env.WORKCTL_IT_REDIS_PW = 'it-limited-pw';
    process.env.WORKCTL_IT_REDIS_BAD = 'wrong';
    const dir = mkdtempSync(join(tmpdir(), 'workctl-redis-it-'));
    const cfg = (pwEnv: string) => {
      const p = join(dir, `${pwEnv}.yaml`);
      writeFileSync(p, ['current_profile: t', 'profiles:', '  t:', '    endpoints:', '      redis:', `        limited: { host: 127.0.0.1, port: 16379, username: workctl_it_limited, password_ref: "env:${pwEnv}" }`].join('\n'));
      return p;
    };
    const denied = await call('redis.config.get', { pattern: 'maxmemory' }, cfg('WORKCTL_IT_REDIS_PW'));
    expect(denied.error?.code).toBe('PERMISSION_DENIED');
    // slowlog degrades gracefully when CONFIG is denied but SLOWLOG is not (here SLOWLOG is denied too)
    const unauth = await call('redis.instance.get', {}, cfg('WORKCTL_IT_REDIS_BAD'));
    expect(unauth.error?.code, JSON.stringify(unauth.error)).toBe('UNAUTHENTICATED');
    expect(JSON.stringify(unauth)).not.toContain('it-limited-pw');
  });
});
