import { describe, expect, it } from 'vitest';
import { isSensitiveConfig, parseInfo, percentile, redactCommand, semanticsOf, snapshotFromInfo, windowDelta } from '../../src/domains/redis/info';

const INFO = [
  '# Server',
  'redis_version:7.4.11',
  'run_id:4f12fb4b345988c18ef04b51dad2022f92fecda3',
  'uptime_in_seconds:1099',
  '',
  '# Stats',
  'total_commands_processed:1000',
  'instantaneous_ops_per_sec:12',
  'keyspace_hits:900',
  'keyspace_misses:100',
  'evicted_keys:0',
  'expired_keys:5',
  'rejected_connections:0',
  '',
  '# Memory',
  'used_memory:1818008',
  'maxmemory_policy:allkeys-lfu',
  'mem_fragmentation_ratio:6.80',
  '',
  '# Commandstats',
  'cmdstat_get:calls=10,usec=20,usec_per_call=2.00,rejected_calls=0,failed_calls=0',
  '',
  '# Keyspace',
  'db0:keys=1291,expires=1291,avg_ttl=111641,subexpiry=0',
].join('\r\n');

describe('INFO parsing and semantics', () => {
  const info = parseInfo(INFO);
  it('parses sections, numbers and composite values', () => {
    expect(info.server.redis_version).toBe('7.4.11');
    expect(info.server.run_id).toBe('4f12fb4b345988c18ef04b51dad2022f92fecda3');
    expect(info.stats.keyspace_hits).toBe(900);
    expect(info.memory.mem_fragmentation_ratio).toBe(6.8);
    expect(info.keyspace.db0).toEqual({ keys: 1291, expires: 1291, avg_ttl: 111641, subexpiry: 0 });
    expect(info.commandstats.cmdstat_get).toMatchObject({ calls: 10, usec: 20 });
  });
  it('labels cumulative vs gauge vs instantaneous', () => {
    expect(semanticsOf('stats', 'keyspace_hits')).toBe('cumulative_since_start');
    expect(semanticsOf('stats', 'total_commands_processed')).toBe('cumulative_since_start');
    expect(semanticsOf('stats', 'instantaneous_ops_per_sec')).toBe('instantaneous_estimate');
    expect(semanticsOf('memory', 'used_memory')).toBe('gauge');
    expect(semanticsOf('memory', 'maxmemory_policy')).toBe('static');
    expect(semanticsOf('server', 'redis_version')).toBe('static');
    expect(semanticsOf('server', 'uptime_in_seconds')).toBe('gauge');
    expect(semanticsOf('commandstats', 'cmdstat_get')).toBe('cumulative_since_start');
  });
});

describe('window deltas', () => {
  const base = parseInfo(INFO);
  const snap = (patch: Record<string, number>, server: Record<string, string | number> = {}, at = 10_000) =>
    snapshotFromInfo({ ...base, server: { ...base.server, ...server }, stats: { ...base.stats, ...patch } }, at);

  it('computes deltas, rates and hit ratio', () => {
    const d = windowDelta(snap({}, {}, 0), snap({ keyspace_hits: 1890, keyspace_misses: 110, total_commands_processed: 3000 }, { uptime_in_seconds: 1109 }, 10_000));
    expect(d.restart_detected).toBe(false);
    expect(d.deltas.keyspace_hits).toBe(990);
    expect(d.rates_per_sec.total_commands_processed).toBe(200);
    expect(d.hit_ratio).toBe(0.99);
  });

  it('hit ratio is null (not 0) when there were no lookups', () => {
    const d = windowDelta(snap({}, {}, 0), snap({}, { uptime_in_seconds: 1109 }, 5000));
    expect(d.hit_ratio).toBeNull();
    expect(d.hit_ratio_note).toContain('null');
  });

  it('detects restart via run_id change or uptime going backwards — no negative deltas', () => {
    const r1 = windowDelta(snap({}, {}, 0), snap({ keyspace_hits: 3 }, { run_id: 'other' }, 5000));
    expect(r1.restart_detected).toBe(true);
    expect(r1.deltas.keyspace_hits).toBeNull();
    const r2 = windowDelta(snap({}, {}, 0), snap({ keyspace_hits: 3 }, { uptime_in_seconds: 2 }, 5000));
    expect(r2.restart_detected).toBe(true);
    expect(Object.values(r2.deltas).every((v) => v === null)).toBe(true);
  });

  it('treats a decreasing counter without restart as reset (CONFIG RESETSTAT)', () => {
    const d = windowDelta(snap({}, {}, 0), snap({ keyspace_hits: 1, keyspace_misses: 0 }, { uptime_in_seconds: 1109 }, 5000));
    expect(d.restart_detected).toBe(false);
    expect(d.reset_counters).toEqual(expect.arrayContaining(['keyspace_hits', 'keyspace_misses']));
    expect(d.deltas.keyspace_hits).toBeNull();
    expect(d.hit_ratio).toBeNull();
  });
});

describe('slowlog argument redaction', () => {
  it('keeps command and key, redacts values', () => {
    expect(redactCommand(['SET', 'demo:order:1', '{"phone":"13800001111"}', 'EX', '300'])).toEqual({ command: 'SET', key: 'demo:order:1', args: ['demo:order:1', '?', '?', '?'], arg_count: 4 });
    expect(redactCommand(['AUTH', 'user', 'secret'])).toEqual({ command: 'AUTH', key: null, args: ['?', '?'], arg_count: 2 });
    expect(redactCommand(['CONFIG', 'SET', 'requirepass', 'x'])).toMatchObject({ command: 'CONFIG SET', key: null, args: ['?', '?'] });
    expect(redactCommand(['MEMORY', 'USAGE', 'k1', 'SAMPLES', '5'])).toMatchObject({ command: 'MEMORY USAGE', key: 'k1', args: ['k1', '?', '?'] });
    expect(redactCommand(['GET', 'x'.repeat(300)]).key!.length).toBeLessThan(140);
  });
  it('flags credential-like config names', () => {
    expect(isSensitiveConfig('requirepass')).toBe(true);
    expect(isSensitiveConfig('masterauth')).toBe(true);
    expect(isSensitiveConfig('tls-key-file-pass')).toBe(true);
    expect(isSensitiveConfig('maxmemory-policy')).toBe(false);
  });
  it('percentiles use nearest-rank', () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(v, 50)).toBe(5);
    expect(percentile(v, 90)).toBe(9);
    expect(percentile(v, 99)).toBe(10);
    expect(percentile([], 50)).toBeNull();
  });
});
