import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { loadConfig, resolveSecretRef } from '../../src/core/config';
import { z } from 'zod';
import { defineCapability } from '../../src/core/registry';
import { tempDir, testRegistry, writeConfig } from './helpers';

describe('config loading', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('honours YAML merge keys (<<: *anchor) in the config and bindings files', async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'workctl.yaml'),
      [
        'current_profile: b',
        'x-base: &base',
        '  env: sandbox',
        '  resources_file: ./bindings.yaml',
        '  endpoints:',
        '    redis:',
        '      r1: {host: 127.0.0.1, port: 1}',
        'profiles:',
        '  b:',
        '    <<: *base',
        '    description: merged',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'bindings.yaml'),
      ['x-svc: &svc', '  type: service', '  env: sandbox', 'resources:', '  - <<: *svc', '    id: s1'].join('\n'),
    );
    const loaded = loadConfig(join(dir, 'workctl.yaml'));
    expect(loaded.config.profiles.b.env).toBe('sandbox');
    expect(Object.keys(loaded.config.profiles.b.endpoints.redis)).toEqual(['r1']);
    expect(loaded.warnings).toEqual([]);
    const env = await invoke(testRegistry(), 'resource.list', {}, { loaded });
    expect((env.data as any).resources.map((r: any) => [r.id, r.type])).toEqual([['s1', 'service']]);
  });

  it('fails when $WORKCTL_CONFIG names a missing file instead of falling back to another config', () => {
    const dir = tempDir();
    writeConfig(dir); // a ./workctl.yaml that must not be picked up silently
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      process.env.WORKCTL_CONFIG = join(dir, 'typo.yaml');
      expect(() => loadConfig()).toThrow(/配置文件不存在/);
      delete process.env.WORKCTL_CONFIG;
      expect(loadConfig().path).toBe(join(dir, 'workctl.yaml'));
    } finally {
      process.chdir(cwd);
    }
  });

  it('reports a config path that is a directory as such', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'conf'));
    expect(() => loadConfig(join(dir, 'conf'))).toThrow(/是目录/);
  });

  it('warns about unknown (misspelled) keys instead of dropping them silently', async () => {
    const dir = tempDir();
    const path = join(dir, 'workctl.yaml');
    writeFileSync(path, YAML.stringify({ current_profle: 'p', profiles: { p: { env: 'sandbox', resource_file: './b.yaml' } } }));
    const loaded = loadConfig(path);
    expect(loaded.warnings?.[0]).toMatch(/current_profle/);
    expect(loaded.warnings?.[0]).toMatch(/profiles\.p\.resource_file/);
    const env = await invoke(testRegistry(), 'auth.status', {}, { loaded });
    expect(env.meta.warnings.join(' ')).toMatch(/resource_file/);
  });

  it('treats an empty env credential reference as unresolved', () => {
    process.env.WORKCTL_TEST_EMPTY = '';
    expect(() => resolveSecretRef('env:WORKCTL_TEST_EMPTY', '/')).toThrow(/为空/);
    process.env.WORKCTL_TEST_EMPTY = 'x';
    expect(resolveSecretRef('env:WORKCTL_TEST_EMPTY', '/')).toBe('x');
  });
});

describe('profile env applies to service-scoped resource views', () => {
  const dir = tempDir();
  writeFileSync(
    join(dir, 'b2.yaml'),
    YAML.stringify({
      resources: [
        { id: 'svc-p', type: 'service', env: 'prod' },
        { id: 'db-p', type: 'mysql.instance', env: 'prod' },
        { id: 'x-p', type: 'mysqlx.thing', env: 'prod' },
      ],
      relations: [
        { from: 'svc-p', to: 'db-p', type: 'depends_on', source: 'binding-file' },
        { from: 'svc-p', to: 'x-p', type: 'depends_on', source: 'binding-file' },
      ],
    }),
  );
  const configPath = writeConfig(dir, { resources_file: './b2.yaml' }); // profile env: sandbox
  const reg = testRegistry();

  it('does not return a prod service under a sandbox profile unless --env asks for it', async () => {
    for (const cap of ['resource.list', 'service.dependency.list']) {
      const env = await invoke(reg, cap, { service: 'svc-p' }, { configPath });
      expect(env.error?.code, cap).toBe('NOT_FOUND');
      const explicit = await invoke(reg, cap, { service: 'svc-p', env: 'prod' }, { configPath });
      expect(explicit.status, cap).toBe('success');
    }
  });

  it('filters --type by type prefix, not by string prefix', async () => {
    const env = await invoke(reg, 'resource.list', { service: 'svc-p', env: 'prod', type: 'mysql' }, { configPath });
    expect((env.data as any).resources.map((r: any) => r.id)).toEqual(['db-p']);
  });
});

describe('auth status / access check probes', () => {
  const dir = tempDir();
  const configPath = writeConfig(dir, {
    endpoints: { slowkind: { s1: { host: '127.0.0.1', port: 1 } }, fastkind: { f1: { host: '127.0.0.1', port: 1 } } },
  });

  it('a hanging endpoint probe does not time out the whole report', async () => {
    const reg = testRegistry();
    reg.probes.set('slowkind', () => new Promise(() => undefined));
    reg.probes.set('fastkind', async () => ({ ok: true, identity: 'me' }));
    const env = await invoke(reg, 'auth.status', { probe: true }, { configPath, timeoutMs: 1500 });
    expect(env.error).toBeNull();
    expect(env.status).toBe('partial');
    const eps = (env.data as any).endpoints;
    expect(eps.find((e: any) => e.kind === 'fastkind').probe).toMatchObject({ ok: true, identity: 'me' });
    expect(eps.find((e: any) => e.kind === 'slowkind').probe.ok).toBe(false);
    expect(env.meta.coverage?.complete).toBe(false);
  });

  it('access check reflects the entry point execute guard and domain allow-list', async () => {
    const reg = testRegistry();
    const cfg = writeConfig(tempDir(), { allow_execute: true });
    const viaMcp = await invoke(reg, 'access.check', { capability: 'fake.write', probe: false }, { configPath: cfg, allowExecute: false });
    expect((viaMcp.data as any).verdict).toBe('denied');
    expect((viaMcp.data as any).checks.find((c: any) => c.check === 'entry_execute').ok).toBe(false);
    const terminal = await invoke(reg, 'access.check', { capability: 'fake.write', probe: false }, { configPath: cfg });
    expect((terminal.data as any).verdict).toBe('allowed');
    const otherDomain = await invoke(reg, 'access.check', { capability: 'fake.echo', probe: false }, { configPath: cfg, allowedDomains: ['mysql'] });
    expect((otherDomain.data as any).verdict).toBe('denied');
  });
});

describe('capability list', () => {
  it('reports an unknown domain as NOT_FOUND instead of an empty catalog', async () => {
    const configPath = writeConfig(tempDir());
    const reg = testRegistry();
    const env = await invoke(reg, 'capability.list', { domain: 'nosuch' }, { configPath });
    expect(env.error?.code).toBe('NOT_FOUND');
    const known = await invoke(reg, 'capability.list', { domain: 'fake' }, { configPath });
    expect((known.data as any).capabilities.length).toBeGreaterThan(0);
  });
});


describe('composed calls (ctx.call)', () => {
  it('leave the caller time to report a sub-call timeout instead of timing out together', async () => {
    const reg = testRegistry();
    reg.addCapability(
      defineCapability({
        name: 'fake.compose',
        command: 'fake compose',
        summary: 'compose',
        domain: 'fake',
        output: z.object({ sub: z.string(), rid: z.string() }),
        adapter: 'fake',
        operation: 'read',
        auth_provider: 'none',
        guide: 'docs/x.md',
        handler: async (ctx) => {
          const sub = await ctx.call('fake.slow', {});
          return { status: 'partial', data: { sub: sub.error?.code ?? 'ok', rid: sub.context.request_id } };
        },
      }),
    );
    const configPath = writeConfig(tempDir());
    const env = await invoke(reg, 'fake.compose', {}, { configPath, timeoutMs: 1500, requestId: 'req-parent' });
    expect(env.error).toBeNull();
    expect(env.data).toEqual({ sub: 'TIMEOUT', rid: 'req-parent' });
  });
});

describe('relative paths in config', () => {
  it('resolve a docker socket relative to the config file, not the working directory', async () => {
    const { dockerClient } = await import('../../src/domains/container/docker');
    const { Ctx } = await import('../../src/core/runtime');
    const dir = tempDir();
    const configPath = writeConfig(dir, { endpoints: { docker: { local: { socket: './run/docker.sock' } } } });
    const ctx = new Ctx({ registry: testRegistry(), loaded: loadConfig(configPath), profileName: 'test', requestId: 'r', timeoutMs: 1000 });
    expect(dockerClient(ctx).socketPath).toBe(join(dir, 'run', 'docker.sock'));
  });
});
