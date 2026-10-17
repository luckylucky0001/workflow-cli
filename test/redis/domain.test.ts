import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { Registry } from '../../src/core/registry';
import redisDomain from '../../src/domains/redis';
import { isRedisOriginError, mapRedisError } from '../../src/domains/redis/client';
import { scanSample } from '../../src/domains/redis/keys';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';

function registry(): Registry {
  const r = new Registry();
  r.addDomain(redisDomain);
  return r;
}

describe('redis domain definition', () => {
  const r = registry();
  it('registers the designed commands with full metadata', () => {
    const caps = r.list({ domain: 'redis' }).filter((c) => c.status === 'available');
    expect(caps.map((c) => c.command).sort()).toEqual(
      ['redis config get', 'redis info get', 'redis instance get', 'redis key hot', 'redis key inspect', 'redis key sample', 'redis slowlog list', 'redis stats sample'].sort(),
    );
    for (const c of caps) {
      expect(c.output).toBeDefined();
      expect(c.adapter).toBe('redis-client');
      expect(c.auth_provider).toBe('redis-profile');
      expect(c.guide).toBe('docs/guides/redis.md');
      expect(c.summary).toMatch(/[一-龥]/);
      expect(c.examples?.length).toBeGreaterThan(0);
      expect(c.notes?.length).toBeGreaterThan(0);
      expect(() => r.outputJsonSchema(c)).not.toThrow();
    }
    expect(r.probes.has('redis')).toBe(true);
  });
  it('keeps semantic caveats in the catalog', () => {
    expect(r.get('redis.slowlog.list')!.notes!.join('')).toContain('不含网络');
    expect(r.get('redis.key.hot')!.notes!.join('')).toContain('不是 QPS');
    expect(r.get('redis.key.sample')!.notes!.join('')).toContain('不是一致性全量快照');
  });
});

describe('redis error mapping', () => {
  const reply = (msg: string) => Object.assign(new Error(msg), { name: 'ReplyError' });
  it.each([
    ["NOPERM User demo has no permissions to run the 'config|get' command", 'PERMISSION_DENIED'],
    ['NOAUTH Authentication required.', 'UNAUTHENTICATED'],
    ['WRONGPASS invalid username-password pair or user is disabled.', 'UNAUTHENTICATED'],
    ["ERR unknown command 'CONFIG', with args beginning with: ", 'UNSUPPORTED'],
    ['LOADING Redis is loading the dataset in memory', 'UPSTREAM_UNAVAILABLE'],
    ['WRONGTYPE Operation against a key holding the wrong kind of value', 'INVALID_ARGUMENT'],
  ])('%s → %s', (msg, code) => {
    expect(mapRedisError(reply(msg))?.code).toBe(code);
  });
  it('domain-wide mapper only claims ioredis errors', () => {
    expect(isRedisOriginError(reply('NOPERM x'))).toBe(true);
    expect(isRedisOriginError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))).toBe(false);
  });
});

describe('budgeted SCAN sampling', () => {
  // fake keyspace: cursor walk with a duplicate (SCAN may return a key twice)
  const pages: Record<string, [string, string[]]> = {
    '0': ['7', ['a', 'b', 'c']],
    '7': ['3', ['c', 'd']],
    '3': ['0', ['e']],
  };
  const scan = async (cursor: string) => pages[cursor];

  it('dedupes and reports a complete iteration when the cursor returns to 0', async () => {
    const r = await scanSample(scan, { maxKeys: 100, maxScanCalls: 10 });
    expect(r.keys).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(r.duplicates_seen).toBe(1);
    expect(r.scan_calls).toBe(3);
    expect(r.cursor_complete).toBe(true);
    expect(r.stopped_by).toBe('cursor_complete');
  });
  it('stops at the max_scan_calls budget (incomplete)', async () => {
    const r = await scanSample(scan, { maxKeys: 100, maxScanCalls: 2 });
    expect(r.cursor_complete).toBe(false);
    expect(r.stopped_by).toBe('max_scan_calls');
  });
  it('stops at max_keys (incomplete)', async () => {
    const r = await scanSample(scan, { maxKeys: 2, maxScanCalls: 10 });
    expect(r.keys).toHaveLength(2);
    expect(r.cursor_complete).toBe(false);
    expect(r.stopped_by).toBe('max_keys');
  });
  it('a full walk that had to drop keys is not complete', async () => {
    const r = await scanSample(async () => ['0', ['a', 'b', 'c']], { maxKeys: 2, maxScanCalls: 10 });
    expect(r.dropped).toBe(1);
    expect(r.cursor_complete).toBe(false);
  });
});

describe('redis capabilities without a live server', () => {
  let configPath: string;
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'workctl-redis-'));
    configPath = join(dir, 'workctl.yaml');
    writeFileSync(configPath, ['current_profile: t', 'profiles:', '  t:', '    endpoints:', '      redis:', '        down: { host: 127.0.0.1, port: 1 }'].join('\n'));
  });
  it('unreachable instance → UPSTREAM_UNAVAILABLE', async () => {
    const env = await invoke(registry(), 'redis.instance.get', {}, { configPath });
    expect(env.status).toBe('error');
    expect(env.error?.code).toBe('UPSTREAM_UNAVAILABLE');
  });
  it('stats sample longer than the time budget is refused before connecting', async () => {
    const env = await invoke(registry(), 'redis.stats.sample', { duration: '40s' }, { configPath, timeoutMs: 30_000 });
    expect(env.error?.code).toBe('INVALID_ARGUMENT');
    expect(env.error?.hint).toContain('--timeout');
  });
});
