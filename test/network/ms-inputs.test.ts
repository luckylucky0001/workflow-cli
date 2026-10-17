// Regression (contract fuzz): negative/zero/overflowing millisecond inputs reached net/timer APIs —
// `--timeout-ms -1` returned INTERNAL ("msecs out of range") and left a socket open for ~85s after
// the envelope; 0 disabled the connect timeout; > 2^31-1 fired at once (false ETIMEDOUT).
import { describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { Registry } from '../../src/core/registry';
import network from '../../src/domains/network';
import { tempDir, writeConfig } from '../core/helpers';

const r = new Registry();
r.addDomain(network);
const configPath = writeConfig(tempDir());

describe('network millisecond inputs', () => {
  for (const [cap, base] of [
    ['network.connectivity.check', { target: '127.0.0.1:1', count: 1 }],
    ['network.backend.list', { service: 'svc-a' }],
  ] as const) {
    for (const bad of [-1, 0, 3_000_000_000]) {
      it(`${cap} --timeout-ms ${bad} is INVALID_ARGUMENT`, async () => {
        const t0 = Date.now();
        const env = await invoke(r, cap, { ...base, timeout_ms: bad }, { configPath, timeoutMs: 5000 });
        expect(env.error?.code).toBe('INVALID_ARGUMENT');
        expect(env.error?.message).toContain('--timeout-ms');
        expect(Date.now() - t0).toBeLessThan(2000);
      });
    }
  }

  it('connectivity check rejects a negative --interval-ms and accepts 0', async () => {
    const bad = await invoke(r, 'network.connectivity.check', { target: '127.0.0.1:1', count: 2, interval_ms: -1 }, { configPath });
    expect(bad.error?.code).toBe('INVALID_ARGUMENT');
    const ok = await invoke(r, 'network.connectivity.check', { target: '127.0.0.1:1', count: 2, interval_ms: 0, timeout_ms: 500 }, { configPath });
    expect(ok.status).toBe('success');
    expect((ok.data as any).summary.sent).toBe(2);
  });
});
