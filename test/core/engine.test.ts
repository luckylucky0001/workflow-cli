import { describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { EnvelopeSchema, exitCodeFor } from '../../src/core/output';
import { tempDir, testRegistry, writeConfig } from './helpers';

describe('engine', () => {
  const dir = tempDir();
  const configPath = writeConfig(dir);
  const reg = testRegistry();

  it('returns a valid success envelope with parsed inputs', async () => {
    const env = await invoke(reg, 'fake.echo', { text: 'hi', window: '15m' }, { configPath });
    expect(EnvelopeSchema.parse(env)).toBeTruthy();
    expect(env.status).toBe('success');
    expect(env.data).toEqual({ text: 'hi', window_ms: 900_000 });
    expect(env.context.profile).toBe('test');
    expect(env.context.env).toBe('sandbox');
    expect(env.meta.sources[0].system).toBe('fake');
  });

  it('reports missing and malformed inputs as INVALID_ARGUMENT', async () => {
    const env = await invoke(reg, 'fake.echo', { window: 'soon', n: 'x' }, { configPath });
    expect(env.status).toBe('error');
    expect(env.error?.code).toBe('INVALID_ARGUMENT');
    expect(env.error?.message).toContain('--text');
    expect(env.error?.message).toContain('--window');
    expect(exitCodeFor(env)).toBe(2);
  });

  it('maps connection errors and timeouts to stable codes', async () => {
    const refused = await invoke(reg, 'fake.refused', {}, { configPath });
    expect(refused.error?.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(refused.error?.retryable).toBe(true);
    const slow = await invoke(reg, 'fake.slow', {}, { configPath, timeoutMs: 50 });
    expect(slow.error?.code).toBe('TIMEOUT');
  });

  it('distinguishes collection disabled from empty results', async () => {
    const env = await invoke(reg, 'fake.collect', {}, { configPath });
    expect(env.error?.code).toBe('COLLECTION_DISABLED');
    expect(exitCodeFor(env)).toBe(7);
  });

  it('refuses execute operations unless the profile allows them', async () => {
    const denied = await invoke(reg, 'fake.write', {}, { configPath });
    expect(denied.error?.code).toBe('PRECONDITION_FAILED');
    const d2 = tempDir();
    const allowed = await invoke(reg, 'fake.write', {}, { configPath: writeConfig(d2, { allow_execute: true }) });
    expect(allowed.status).toBe('success');
    const mcp = await invoke(reg, 'fake.write', {}, { configPath: writeConfig(d2, { allow_execute: true }), allowExecute: false });
    expect(mcp.error?.code).toBe('PRECONDITION_FAILED');
  });

  it('never exposes planned capabilities as callable', async () => {
    const env = await invoke(reg, 'search.query', {}, { configPath });
    expect(env.error?.code).toBe('CAPABILITY_PLANNED');
    expect(exitCodeFor(env)).toBe(8);
  });

  it('rejects inline credentials in config', async () => {
    const d = tempDir();
    const p = writeConfig(d, { endpoints: { mysql: { x: { password: 'plain' } } } });
    const env = await invoke(reg, 'fake.echo', { text: 'a' }, { configPath: p });
    expect(env.error?.code).toBe('INVALID_ARGUMENT');
    expect(env.error?.hint).toContain('password_ref');
  });
});
