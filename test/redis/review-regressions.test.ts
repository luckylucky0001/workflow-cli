import { describe, expect, it } from 'vitest';
import { redactCommand } from '../../src/domains/redis/info';

describe('review: slowlog redaction of script calls', () => {
  it('EVAL keeps no script source; the first key is reported as the key', () => {
    const r = redactCommand(['EVAL', "return redis.call('SET','k','secret-value')", '1', 'user:1', 'secret-arg']);
    expect(r.key).toBe('user:1');
    expect(JSON.stringify(r)).not.toContain('secret');
    expect(r.args).toEqual(['?', '1', 'user:1', '?']);
  });
  it('EVALSHA / FCALL without keys report key=null', () => {
    expect(redactCommand(['EVALSHA', 'abc123', '0', 'arg']).key).toBeNull();
    expect(redactCommand(['FCALL', 'myfn', '0']).key).toBeNull();
  });
  it('MIGRATE keeps no arguments (AUTH password lives in the tail)', () => {
    const r = redactCommand(['MIGRATE', '10.0.0.1', '6379', '', '0', '5000', 'AUTH', 'pw', 'KEYS', 'k1']);
    expect(JSON.stringify(r)).not.toContain('pw');
    expect(r.args.every((a) => a === '?')).toBe(true);
  });
});

// ---------------------------------------------------------------- capabilities against a fake RESP server

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { invoke } from '../../src/core/engine';
import { Registry } from '../../src/core/registry';
import redisDomain from '../../src/domains/redis';
import { fakeRedis, type Reply } from './fake-resp';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';

describe('review: slowlog and stream values against a fake Redis', () => {
  let srv: Awaited<ReturnType<typeof fakeRedis>>;
  let configPath: string;
  let mode: { maxLen: string; configDenied: boolean } = { maxLen: '128', configDenied: false };
  const big = 'v'.repeat(5000);
  beforeAll(async () => {
    srv = await fakeRedis((args): Reply => {
      const [c, a1, a2] = args.map((x) => x.toUpperCase());
      if (c === 'CONFIG' && a1 === 'GET') {
        if (mode.configDenied) return new Error("NOPERM User default has no permissions to run the 'config|get' command");
        return a2 === 'SLOWLOG-*' ? ['slowlog-log-slower-than', '1000', 'slowlog-max-len', mode.maxLen] : [];
      }
      if (c === 'SLOWLOG' && a1 === 'GET') return [];
      if (c === 'SLOWLOG' && a1 === 'LEN') return 0;
      if (c === 'INFO') return '# Server\r\nredis_version:7.4.0\r\n# Memory\r\nmaxmemory_policy:allkeys-lru\r\n';
      if (c === 'TYPE') return { simple: 'stream' };
      if (c === 'PTTL') return -1;
      if (c === 'OBJECT') return 'stream';
      if (c === 'MEMORY') return 6000;
      if (c === 'XLEN') return 1;
      if (c === 'XRANGE') return [['1-0', ['payload', big]]];
      return new Error(`ERR unknown command '${args[0]}'`);
    });
    const dir = mkdtempSync(join(tmpdir(), 'workctl-redis-review-'));
    configPath = join(dir, 'workctl.yaml');
    writeFileSync(configPath, ['current_profile: t', 'profiles:', '  t:', '    env: test', '    endpoints:', '      redis:', '        fake:', '          host: 127.0.0.1', `          port: ${srv.port}`].join('\n'));
  });
  afterAll(async () => srv.close());
  const call = (cap: string, inputs: Record<string, unknown>) => {
    const r = new Registry();
    r.addDomain(redisDomain);
    return invoke(r, cap, inputs, { configPath, timeoutMs: 5000 });
  };

  it('slowlog-max-len=0 → COLLECTION_DISABLED (an empty log would otherwise read as "no slow commands")', async () => {
    mode = { maxLen: '0', configDenied: false };
    const env = await call('redis.slowlog.list', {});
    expect(env.error?.code).toBe('COLLECTION_DISABLED');
  });

  it('CONFIG denied + empty slowlog does not claim the slowlog is enabled', async () => {
    mode = { maxLen: '128', configDenied: true };
    const env = await call('redis.slowlog.list', {});
    expect(env.status).toBe('success');
    expect(env.meta.warnings).toEqual([]);
    expect(env.meta.coverage?.complete).toBe(false);
    expect(env.meta.coverage?.notes?.[0]).toMatch(/不能确认/);
    expect(env.meta.coverage?.notes?.join('')).not.toContain('已开启');
  });

  it('stream values from key inspect --include-value are clipped like other collections', async () => {
    const env = await call('redis.key.inspect', { key: 's', include_value: true });
    expect(env.meta.warnings).toEqual([]);
    const v = (env.data as any).value;
    expect(v.kind).toBe('stream');
    expect(v.data[0].id).toBe('1-0');
    expect(v.data[0].fields[1].length).toBeLessThan(1100);
  });
});

// ---------------------------------------------------------------- key sample: effective limit and post-cap duplicates

import { scanSample } from '../../src/domains/redis/keys';

describe('review: key sample reports the effective max_keys and post-cap duplicates', () => {
  it('a key returned again by SCAN after the cap is a duplicate, not another dropped key', async () => {
    // the batch that reaches the cap (here the last one) repeats 'c'
    const r = await scanSample(async () => ['0', ['a', 'b', 'c', 'c', 'a']], { maxKeys: 2, maxScanCalls: 10 });
    expect(r.keys).toEqual(['a', 'b']);
    expect(r.dropped).toBe(1);
    expect(r.duplicates_seen).toBe(2);
  });

  let srv: Awaited<ReturnType<typeof fakeRedis>>;
  let configPath: string;
  beforeAll(async () => {
    srv = await fakeRedis((args): Reply => {
      const c = args[0].toUpperCase();
      if (c === 'SCAN') return ['0', ['k1', 'k2']];
      if (c === 'TYPE') return { simple: 'string' };
      if (c === 'MEMORY') return 50;
      if (c === 'DBSIZE') return 2;
      if (c === 'INFO') return '# Server\r\nredis_version:7.4.0\r\n';
      return new Error(`ERR unknown command '${args[0]}'`);
    });
    const dir = mkdtempSync(join(tmpdir(), 'workctl-redis-review2-'));
    configPath = join(dir, 'workctl.yaml');
    writeFileSync(configPath, ['current_profile: t', 'profiles:', '  t:', '    env: test', '    endpoints:', '      redis:', '        fake:', '          host: 127.0.0.1', `          port: ${srv.port}`].join('\n'));
  });
  afterAll(async () => srv.close());

  it('coverage.limit is the clamped max_keys, not the requested value', async () => {
    const r = new Registry();
    r.addDomain(redisDomain);
    const env = await invoke(r, 'redis.key.sample', { max_keys: 50_000 }, { configPath, timeoutMs: 5000 });
    expect(env.status).toBe('success');
    expect(env.meta.coverage?.limit).toBe(10_000);
    const env0 = await invoke(r, 'redis.key.sample', { max_keys: 0 }, { configPath, timeoutMs: 5000 });
    expect(env0.meta.coverage?.limit).toBe(1);
  });
});

describe('review: key inspect when OBJECT ENCODING is denied by ACL', () => {
  let srv: Awaited<ReturnType<typeof fakeRedis>>;
  let configPath: string;
  beforeAll(async () => {
    srv = await fakeRedis((args): Reply => {
      const c = args[0].toUpperCase();
      if (c === 'TYPE') return { simple: 'string' };
      if (c === 'PTTL') return -1;
      if (c === 'OBJECT') return new Error("NOPERM User default has no permissions to run the 'object|encoding' command");
      if (c === 'MEMORY') return 56;
      if (c === 'STRLEN') return 3;
      if (c === 'INFO') return '# Server\r\nredis_version:7.4.0\r\n# Memory\r\nmaxmemory_policy:noeviction\r\n';
      return new Error(`ERR unknown command '${args[0]}'`);
    });
    const dir = mkdtempSync(join(tmpdir(), 'workctl-redis-review3-'));
    configPath = join(dir, 'workctl.yaml');
    writeFileSync(configPath, ['current_profile: t', 'profiles:', '  t:', '    env: test', '    endpoints:', '      redis:', '        fake:', '          host: 127.0.0.1', `          port: ${srv.port}`].join('\n'));
  });
  afterAll(async () => srv.close());
  it('encoding=null is explained by a warning instead of passing silently', async () => {
    const r = new Registry();
    r.addDomain(redisDomain);
    const env = await invoke(r, 'redis.key.inspect', { key: 'k' }, { configPath, timeoutMs: 5000 });
    expect(env.status).toBe('success');
    expect((env.data as any).encoding).toBeNull();
    expect(env.meta.warnings.join('\n')).toMatch(/OBJECT ENCODING.*NOPERM/);
  });
});
