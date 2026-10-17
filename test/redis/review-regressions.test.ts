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
