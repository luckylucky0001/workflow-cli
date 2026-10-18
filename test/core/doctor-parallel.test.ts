import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

// every TCP connect hangs until its socket timeout (a firewall that drops SYNs)
vi.mock('node:net', async (orig) => {
  const actual = await orig<typeof import('node:net')>();
  return {
    ...actual,
    connect: () => {
      const sock = new EventEmitter() as EventEmitter & { setTimeout: (ms: number, cb: () => void) => void; destroy: () => void };
      let t: NodeJS.Timeout | undefined;
      sock.setTimeout = (ms, cb) => {
        t = setTimeout(cb, ms);
      };
      sock.destroy = () => clearTimeout(t);
      return sock;
    },
  };
});

const { invoke } = await import('../../src/core/engine');
const { tempDir, testRegistry, writeConfig } = await import('./helpers');

describe('doctor', () => {
  it('checks unreachable endpoints side by side, not N × 2s in sequence', async () => {
    const endpoints: Record<string, Record<string, unknown>> = {};
    for (let n = 0; n < 4; n++) endpoints[`k${n}`] = { e: { host: '10.255.255.1', port: 80 } };
    const configPath = writeConfig(tempDir(), { endpoints });
    const t0 = Date.now();
    const env = await invoke(testRegistry(), 'doctor.run', {}, { configPath, timeoutMs: 5000 });
    expect(env.error).toBeNull();
    const eps = (env.data as any).checks.filter((c: any) => c.area === 'endpoints');
    expect(eps.map((c: any) => c.ok)).toEqual([false, false, false, false]);
    expect(eps.every((c: any) => /不可达: timeout/.test(c.detail))).toBe(true);
    expect(Date.now() - t0).toBeLessThan(4000);
  });
});
