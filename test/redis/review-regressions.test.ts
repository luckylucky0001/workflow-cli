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
