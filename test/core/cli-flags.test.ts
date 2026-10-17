// Regression: a capability input named like a global option (sql query submit --output <dir>)
// was swallowed by the global -o/--output <format> option and rejected by its choices.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { buildProgram, rewriteShadowedFlags } from '../../src/cli/main';
import { defineCapability, defineDomain, Registry } from '../../src/core/registry';
import coreDomain from '../../src/domains/core';
import { tempDir, writeConfig } from './helpers';

function registry(): Registry {
  const r = new Registry();
  r.addDomain(coreDomain);
  r.addDomain(
    defineDomain({
      name: 'cf',
      title: 'cf',
      summary: 'cf',
      pillar: 'supporting',
      guide: 'docs/x.md',
      capabilities: [
        defineCapability({
          name: 'cf.run',
          command: 'cf run',
          summary: 'run',
          domain: 'cf',
          inputs: { output: { type: 'string', description: 'result dir' }, cols: { type: 'list', description: 'cols' } },
          output: z.object({ output: z.string().nullable(), cols: z.array(z.string()).nullable() }),
          adapter: 'cf',
          operation: 'read',
          auth_provider: 'none',
          guide: 'docs/x.md',
          handler: async (_ctx, i) => ({ data: { output: i.output ?? null, cols: i.cols ?? null } }),
        }),
      ],
    }),
  );
  return r;
}

async function run(args: string[]): Promise<any> {
  const reg = registry();
  const configPath = writeConfig(tempDir());
  const argv = rewriteShadowedFlags(['node', 'workctl', '--config', configPath, ...args], reg);
  let out = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    out += String(chunk);
    return true;
  });
  try {
    await buildProgram(reg, [], true).parseAsync(argv);
  } finally {
    spy.mockRestore();
  }
  return JSON.parse(out);
}

afterEach(() => {
  process.exitCode = 0;
});

describe('CLI flags', () => {
  it('passes --output after the subcommand to the capability input', async () => {
    const env = await run(['--json', 'cf', 'run', '--output', '/tmp/result-dir']);
    expect(env.status).toBe('success');
    expect(env.data.output).toBe('/tmp/result-dir');
    const env2 = await run(['-o', 'json', 'cf', 'run', '--output=/tmp/r2']);
    expect(env2.data.output).toBe('/tmp/r2');
  });

  it('keeps the global format option before the subcommand', async () => {
    const env = await run(['--output', 'json', 'cf', 'run']);
    expect(env.data.output).toBeNull();
  });

  it('splits comma-separated list flags given once (e.g. --columns a,b)', async () => {
    const env = await run(['--json', 'cf', 'run', '--cols', 'a,b', '--cols', 'c']);
    expect(env.data.cols).toEqual(['a', 'b', 'c']);
  });
});
