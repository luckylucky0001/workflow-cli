// Regressions for contract defects found by scripts/contract-fuzz.mjs (black-box CLI/MCP fuzzing).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommanderError } from 'commander';
import { buildProgram, commanderErrorExit, wantsJsonOutput } from '../../src/cli/main';
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

describe('OS limits on path inputs', () => {
  it('maps ENAMETOOLONG from a handler to INVALID_ARGUMENT without echoing the path', async () => {
    const { Registry, defineCapability } = await import('../../src/core/registry');
    const { z } = await import('zod');
    const { lstatSync } = await import('node:fs');
    const reg = new Registry();
    reg.addCapability(
      defineCapability({
        name: 'fs.stat',
        command: 'fs stat',
        summary: 'stat',
        domain: 'fs',
        inputs: { path: { type: 'string', required: true, description: 'p' } },
        output: z.object({}),
        adapter: 'fs',
        operation: 'read',
        auth_provider: 'none',
        guide: 'docs/x.md',
        handler: async (_ctx, i) => {
          lstatSync(i.path);
          return { data: {} };
        },
      }),
    );
    const env = await invoke(reg, 'fs.stat', { path: 'x'.repeat(10_000) }, { configPath: writeConfig(tempDir()) });
    expect(env.error?.code).toBe('INVALID_ARGUMENT');
    expect(env.error?.message).not.toContain('xxxxxxxx');
  });
});

describe('incomplete commands', () => {
  async function parseError(args: string[]): Promise<{ out: string; exit: number }> {
    let out = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      out += String(chunk);
      return true;
    });
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await buildProgram(testRegistry(), [], true).parseAsync(['node', 'workctl', ...args]);
      throw new Error('expected a commander error');
    } catch (e) {
      if (!(e instanceof CommanderError)) throw e;
      const exit = commanderErrorExit(e, wantsJsonOutput(['node', 'workctl', ...args]));
      return { out, exit };
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  }

  it('a group without its subcommand is a usage error (exit 2 + JSON envelope), not a silent exit 0', async () => {
    const { out, exit } = await parseError(['--json', 'fake']);
    expect(exit).toBe(2);
    const env = JSON.parse(out);
    expect(env.status).toBe('error');
    expect(env.error.code).toBe('INVALID_ARGUMENT');
  });

  it('explicit --help stays exit 0', async () => {
    const { exit } = await parseError(['fake', '--help']);
    expect(exit).toBe(0);
  });

  it('a bare `workctl` (no arguments) shows the overview and exits 0, as before', async () => {
    const { main } = await import('../../src/cli/main');
    let out = '';
    let err = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      out += String(chunk);
      return true;
    });
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
      err += String(chunk);
      return true;
    });
    try {
      process.exitCode = 0;
      await main(['node', 'workctl']);
      expect(process.exitCode).toBe(0);
      expect(err).toContain('Usage: workctl');
      expect(out).toBe('');
      // only global options and no command is still an incomplete command
      await main(['node', 'workctl', '--json']);
      expect(process.exitCode).toBe(2);
      expect(JSON.parse(out).error.code).toBe('INVALID_ARGUMENT');
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

describe('core capabilities fill meta.coverage on success', () => {
  it('capability.get, resource.get, access.check, doctor.run and operation plan/get/cancel', async () => {
    const reg = testRegistry();
    const configPath = writeConfig(tempDir());
    const call = (cap: string, inputs: Record<string, unknown>) => invoke(reg, cap, inputs, { configPath });
    const plan = await call('operation.plan', { action: 'fake.restart', param: ['target=a'] });
    const id = (plan.data as any)?.id;
    for (const env of [
      await call('capability.get', { name: 'fake.echo' }),
      await call('resource.get', { id: 'svc-a' }),
      await call('access.check', { capability: 'fake.echo', probe: false }),
      await call('doctor.run', { skip_network: true }),
      plan,
      await call('operation.get', { id }),
      await call('operation.cancel', { id }),
    ]) {
      expect(env.status, `${env.capability}: ${env.error?.message}`).toBe('success');
      expect(env.meta.sources.length, env.capability).toBeGreaterThan(0);
      expect(env.meta.coverage, env.capability).not.toBeNull();
    }
  });
});

describe('error mapping attribution', () => {
  it("another domain's broad mapper does not claim a network error raised by this capability", async () => {
    const { Registry, defineCapability, defineDomain } = await import('../../src/core/registry');
    const { WorkError } = await import('../../src/core/output');
    const { z } = await import('zod');
    const refused = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
    const cap = (domain: string) =>
      defineCapability({
        name: `${domain}.get`,
        command: `${domain} get`,
        summary: 's',
        domain,
        output: z.object({}),
        adapter: domain,
        operation: 'read',
        auth_provider: 'none',
        guide: 'docs/x.md',
        handler: async () => {
          throw refused();
        },
      });
    const reg = new Registry();
    // registered first, claims every errno error (like a driver mapper keyed only on err.code)
    reg.addDomain(defineDomain({ name: 'pgx', title: 'pgx', summary: 's', pillar: 'middleware', guide: 'docs/x.md', capabilities: [cap('pgx')], mapError: (e: any) => (e?.code ? new WorkError('UPSTREAM_UNAVAILABLE', 'PGX 不可达') : undefined) }));
    reg.addDomain(defineDomain({ name: 'sched', title: 'sched', summary: 's', pillar: 'offline', guide: 'docs/x.md', capabilities: [cap('sched')] }));
    const configPath = writeConfig(tempDir());
    const other = await invoke(reg, 'sched.get', {}, { configPath });
    expect(other.error?.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(other.error?.message).not.toContain('PGX');
    // the owning domain still names its own system
    const own = await invoke(reg, 'pgx.get', {}, { configPath });
    expect(own.error?.message).toBe('PGX 不可达');
  });

  it('an error raised by a callee reached through ctx.call keeps the callee domain mapping', async () => {
    const { Registry, defineCapability, defineDomain } = await import('../../src/core/registry');
    const { WorkError } = await import('../../src/core/output');
    const { z } = await import('zod');
    const base = { summary: 's', output: z.object({}), adapter: 'x', operation: 'read' as const, auth_provider: 'none', guide: 'docs/x.md' };
    const reg = new Registry();
    const calleeErr = () => Object.assign(new Error('boom'), { code: 'X_DENIED' });
    reg.addDomain(defineDomain({ name: 'callee', title: 'c', summary: 's', pillar: 'middleware', guide: 'docs/x.md', capabilities: [defineCapability({ ...base, name: 'callee.get', command: 'callee get', domain: 'callee', handler: async () => { throw calleeErr(); } })], mapError: (e: any) => (e?.code === 'X_DENIED' ? new WorkError('PERMISSION_DENIED', 'CALLEE 拒绝') : undefined) }));
    // the caller's own mapper claims every errno-style error; it must not re-label the callee's
    reg.addDomain(defineDomain({ name: 'caller', title: 'c', summary: 's', pillar: 'offline', guide: 'docs/x.md', capabilities: [defineCapability({ ...base, name: 'caller.get', command: 'caller get', domain: 'caller', handler: async (ctx) => {
      const env = await ctx.call('callee.get', {});
      return { data: { callee_code: env.error?.code, callee_message: env.error?.message } };
    } })], mapError: (e: any) => (e?.code ? new WorkError('UPSTREAM_UNAVAILABLE', 'CALLER 不可达') : undefined) }));
    const env = await invoke(reg, 'caller.get', {}, { configPath: writeConfig(tempDir()) });
    expect(env.data).toEqual({ callee_code: 'PERMISSION_DENIED', callee_message: 'CALLEE 拒绝' });
  });
});
