// Regressions for contract defects found by scripts/contract-fuzz.mjs (black-box CLI/MCP fuzzing).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProgram, wantsJsonOutput } from '../../src/cli/main';
import { invoke } from '../../src/core/engine';
import { MAX_TIMEOUT_MS } from '../../src/core/runtime';
import { tempDir, testRegistry, writeConfig } from './helpers';

async function cli(args: string[]): Promise<{ out: string; exitCode: number | undefined }> {
  const reg = testRegistry();
  const configPath = writeConfig(tempDir());
  let out = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    out += String(chunk);
    return true;
  });
  try {
    await buildProgram(reg, [], true).parseAsync(['node', 'workctl', '--config', configPath, ...args]);
  } finally {
    spy.mockRestore();
  }
  return { out, exitCode: process.exitCode as number | undefined };
}

afterEach(() => {
  process.exitCode = 0;
});

describe('envelope context', () => {
  it('an empty --request-id falls back to a generated id', async () => {
    const { out } = await cli(['--json', '--request-id', '', 'fake', 'echo', '--text', 'x']);
    expect(JSON.parse(out).context.request_id).toMatch(/^req-/);
  });

  it('treats the attached short form -ojson as a JSON request for usage errors', () => {
    expect(wantsJsonOutput(['node', 'workctl', '-ojson', 'capability', 'get'])).toBe(true);
    expect(wantsJsonOutput(['node', 'workctl', '-o', 'yaml', 'capability', 'get'])).toBe(false);
  });
});

describe('time budget (--timeout)', () => {
  it('rejects a budget that overflows Node timers instead of timing out at once', async () => {
    const warn = vi.spyOn(process, 'emitWarning');
    try {
      const { out, exitCode } = await cli(['--json', '--timeout', '30d', 'fake', 'echo', '--text', 'x']);
      const env = JSON.parse(out);
      expect(env.status).toBe('error');
      expect(env.error.code).toBe('INVALID_ARGUMENT');
      expect(exitCode).toBe(2);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('rejects a zero budget as INVALID_ARGUMENT, not TIMEOUT', async () => {
    const { out, exitCode } = await cli(['--json', '--timeout', '0', 'fake', 'echo', '--text', 'x']);
    expect(JSON.parse(out).error.code).toBe('INVALID_ARGUMENT');
    expect(exitCode).toBe(2);
  });

  it('accepts the largest timer-safe budget', async () => {
    const env = await invoke(testRegistry(), 'fake.echo', { text: 'x' }, { configPath: writeConfig(tempDir()), timeoutMs: MAX_TIMEOUT_MS });
    expect(env.status).toBe('success');
  });

  it('programmatic callers get INVALID_ARGUMENT for a non-finite budget', async () => {
    const env = await invoke(testRegistry(), 'fake.echo', { text: 'x' }, { configPath: writeConfig(tempDir()), timeoutMs: Number.NaN });
    expect(env.error?.code).toBe('INVALID_ARGUMENT');
  });

  it('mcp serve with an unparsable --timeout is a usage error envelope, not an uncaught exception', async () => {
    const { out, exitCode } = await cli(['--json', '--timeout', 'abc', 'mcp', 'serve']);
    const env = JSON.parse(out);
    expect(env.capability).toBe('mcp.serve');
    expect(env.error.code).toBe('INVALID_ARGUMENT');
    expect(exitCode).toBe(2);
  });
});
