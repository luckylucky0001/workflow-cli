import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { tempDir, testRegistry } from './helpers';

describe('doctor with a config file that fails to load', () => {
  const broken = () => {
    const path = join(tempDir(), 'workctl.yaml');
    // the unterminated flow map is on line 3; the secret-looking line must never be echoed
    writeFileSync(path, 'current_profile: p\nsecret_hint: hunter2-should-not-leak\nprofiles: { p: [\n');
    return path;
  };

  it('reports the parse problem as a failed check instead of rejecting the call', async () => {
    const configPath = broken();
    const env = await invoke(testRegistry(), 'doctor.run', { skip_network: true }, { configPath });
    expect(env.error).toBeNull();
    const d = env.data as any;
    expect(d.healthy).toBe(false);
    const parse = d.checks.find((c: any) => c.area === 'config' && c.item === 'parse');
    expect(parse.ok).toBe(false);
    expect(parse.detail).toContain(configPath);
    expect(parse.detail).toMatch(/line \d+, column \d+/);
    expect(JSON.stringify(env)).not.toContain('hunter2');
    // the checks it can still do are reported
    expect(d.checks.some((c: any) => c.area === 'registry')).toBe(true);
    expect(env.meta.coverage?.complete).toBe(false);
  });

  it('reports a structurally invalid config as a failed check', async () => {
    const path = join(tempDir(), 'workctl.yaml');
    writeFileSync(path, 'profiles: 42\n');
    const env = await invoke(testRegistry(), 'doctor.run', { skip_network: true }, { configPath: path });
    expect(env.error).toBeNull();
    expect((env.data as any).checks.find((c: any) => c.item === 'parse')?.ok).toBe(false);
  });

  it('other capabilities still reject the config with INVALID_ARGUMENT', async () => {
    const configPath = broken();
    const env = await invoke(testRegistry(), 'capability.list', {}, { configPath });
    expect(env.error?.code).toBe('INVALID_ARGUMENT');
    expect(JSON.stringify(env)).not.toContain('hunter2');
  });
});
