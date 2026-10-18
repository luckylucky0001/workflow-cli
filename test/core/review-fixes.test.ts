// Regression tests for the core cross-review fixes (engine, plan store, MCP, plugins, config).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { invoke } from '../../src/core/engine';
import { loadConfig } from '../../src/core/config';
import { PlanStore } from '../../src/core/operations';
import { ResourceStore } from '../../src/core/resources';
import { installPlugin, loadPlugins, pluginEnv } from '../../src/core/plugins';
import { defineCapability, defineDomain, Registry } from '../../src/core/registry';
import coreDomain from '../../src/domains/core';
import { handleMcpMessage } from '../../src/mcp/server';
import { tempDir, testRegistry, writeConfig } from './helpers';

let executorRuns = 0;
let sideEffects = 0;

const reviewDomain = defineDomain({
  name: 'rv',
  title: 'review',
  summary: 'review fixtures',
  pillar: 'supporting',
  guide: 'docs/x.md',
  capabilities: [
    defineCapability({
      name: 'rv.write',
      command: 'rv write',
      summary: 'side effect',
      domain: 'rv',
      output: z.object({ n: z.number() }),
      adapter: 'rv',
      operation: 'execute',
      auth_provider: 'none',
      guide: 'docs/x.md',
      handler: async () => ({ data: { n: ++sideEffects } }),
    }),
    defineCapability({
      name: 'rv.compose',
      command: 'rv compose',
      summary: 'read capability that composes an execute capability',
      domain: 'rv',
      output: z.object({ inner_status: z.string(), inner_code: z.string().nullable() }),
      adapter: 'rv',
      operation: 'read',
      auth_provider: 'none',
      guide: 'docs/x.md',
      handler: async (ctx) => {
        const inner = await ctx.call('rv.write', {});
        return { data: { inner_status: inner.status, inner_code: inner.error?.code ?? null } };
      },
    }),
    defineCapability({
      name: 'rv.inputs',
      command: 'rv inputs',
      summary: 'input parsing',
      domain: 'rv',
      inputs: {
        items: { type: 'list', description: 'l' },
        n: { type: 'int', description: 'n' },
        x: { type: 'number', description: 'x' },
        f: { type: 'file', description: 'f' },
      },
      output: z.object({}).passthrough(),
      adapter: 'rv',
      operation: 'read',
      auth_provider: 'none',
      guide: 'docs/x.md',
      handler: async (_ctx, i) => ({ data: i }),
    }),
    defineCapability({
      name: 'rv.late_reject',
      command: 'rv late-reject',
      summary: 'rejects after the budget',
      domain: 'rv',
      output: z.object({}),
      adapter: 'rv',
      operation: 'read',
      auth_provider: 'none',
      guide: 'docs/x.md',
      handler: () => new Promise((_, rej) => setTimeout(() => rej(new Error('late failure')), 80)),
    }),
    defineCapability({
      name: 'rv.slow_write',
      command: 'rv slow-write',
      summary: 'slow execute',
      domain: 'rv',
      output: z.object({}),
      adapter: 'rv',
      operation: 'execute',
      auth_provider: 'none',
      guide: 'docs/x.md',
      handler: () => new Promise((r) => setTimeout(() => r({ data: {} }), 300)),
    }),
  ],
  planners: [
    {
      kind: 'rv.slow',
      summary: 'slow op',
      plan: async (_ctx, params) => ({
        kind: 'rv.slow',
        title: 'slow',
        params,
        targets: [{ id: 'x' }],
        impact: {},
        preconditions: [{ check: 'ok', ok: true }],
        steps: [{ name: 's', detail: 'd' }],
        idempotent: false,
        cancellable: false,
        ...(params.ttl ? { ttlMs: Number(params.ttl) } : {}),
      }),
    },
  ],
  executors: {
    'rv.slow': async () => {
      executorRuns++;
      await new Promise((r) => setTimeout(r, 200));
      return { ok: true };
    },
  },
});

function registry(): Registry {
  const r = new Registry();
  r.addDomain(coreDomain);
  r.addDomain(reviewDomain);
  return r;
}

describe('operation execute: plan locking and expiry', () => {
  const dir = tempDir();
  const configPath = writeConfig(dir, { allow_execute: true });
  const reg = registry();
  const call = (cap: string, inputs: Record<string, unknown>) => invoke(reg, cap, inputs, { configPath });

  it('runs a plan exactly once under concurrent execute requests', async () => {
    executorRuns = 0;
    const plan = (await call('operation.plan', { action: 'rv.slow', param: ['a=1'] })).data as any;
    const [a, b] = await Promise.all([
      call('operation.execute', { id: plan.id, confirm: plan.id }),
      call('operation.execute', { id: plan.id, confirm: plan.id }),
    ]);
    const statuses = [a, b].map((e) => (e.status === 'error' ? e.error!.code : (e.data as any).status)).sort();
    expect(statuses).toEqual(['CONFLICT', 'succeeded']);
    expect(executorRuns).toBe(1);
    // the lock is released afterwards: a third attempt sees the terminal state
    expect((await call('operation.execute', { id: plan.id, confirm: plan.id })).error?.code).toBe('CONFLICT');
  });

  it('refuses to execute or cancel a plan locked by another process', async () => {
    executorRuns = 0;
    const plan = (await call('operation.plan', { action: 'rv.slow' })).data as any;
    // another workctl process holds the plan (same lock file in the shared state dir)
    const release = new PlanStore(join(dir, 'state', 'operations')).lock(plan.id);
    const exec = await call('operation.execute', { id: plan.id, confirm: plan.id });
    expect(exec.error?.code).toBe('CONFLICT');
    expect(exec.error?.hint).toContain('.lock');
    expect((await call('operation.cancel', { id: plan.id })).error?.code).toBe('CONFLICT');
    expect(executorRuns).toBe(0);
    expect(((await call('operation.get', { id: plan.id })).data as any).status).toBe('planned');
    release();
    expect(((await call('operation.execute', { id: plan.id, confirm: plan.id })).data as any).status).toBe('succeeded');
    expect(executorRuns).toBe(1);
  });

  it('cancel is refused while an execution holds the plan', async () => {
    const plan = (await call('operation.plan', { action: 'rv.slow' })).data as any;
    const exec = call('operation.execute', { id: plan.id, confirm: plan.id });
    await new Promise((r) => setTimeout(r, 50));
    const cancel = await call('operation.cancel', { id: plan.id });
    expect(cancel.error?.code).toBe('CONFLICT');
    expect(((await exec).data as any).status).toBe('succeeded');
  });

  it('an expired plan is a failed precondition, not a state conflict', async () => {
    const plan = (await call('operation.plan', { action: 'rv.slow', param: ['ttl=1'] })).data as any;
    await new Promise((r) => setTimeout(r, 20));
    const env = await call('operation.execute', { id: plan.id, confirm: plan.id });
    expect(env.error?.code).toBe('PRECONDITION_FAILED');
    expect(env.error?.message).toContain('过期');
  });

  it('a corrupt plan file does not break operation list', async () => {
    const store = new PlanStore(join(dir, 'state', 'operations'));
    writeFileSync(join(store.dir, 'op-20260101-zzzzzz.json'), '{not json');
    const list = await call('operation.list', {});
    expect(list.status).toBe('success');
    expect((list.data as any).operations.length).toBeGreaterThan(0);
  });

  it('operation plan keeps comma-separated values of one --param (e.g. columns=a,b)', async () => {
    const viaCli = await call('operation.plan', { action: 'rv.slow', param: ['columns=user_id,created_at', 'name=idx'] });
    expect(viaCli.error).toBeNull();
    expect((viaCli.data as any).params).toEqual({ columns: 'user_id,created_at', name: 'idx' });
    // the documented comma form of the list input: columns=a,b,name=x
    const single = await call('operation.plan', { action: 'rv.slow', param: 'columns=a,b,name=x' });
    expect((single.data as any).params).toEqual({ columns: 'a,b', name: 'x' });
    expect((await call('operation.plan', { action: 'rv.slow', param: ['oops'] })).error?.code).toBe('INVALID_ARGUMENT');
  });

  it('a plan file copied to another id is refused (lock and writes would target different plans)', async () => {
    executorRuns = 0;
    const plan = (await call('operation.plan', { action: 'rv.slow' })).data as any;
    const store = new PlanStore(join(dir, 'state', 'operations'));
    const copyId = 'op-20260101-aaaaaa';
    writeFileSync(join(store.dir, `${copyId}.json`), readFileSync(join(store.dir, `${plan.id}.json`)));
    const env = await call('operation.execute', { id: copyId, confirm: copyId });
    expect(env.error?.code).toBe('PRECONDITION_FAILED');
    expect(executorRuns).toBe(0);
    expect(((await call('operation.get', { id: plan.id })).data as any).status).toBe('planned');
    expect((await call('operation.get', { id: 'op-20260101-zzzzzz' })).error?.code).toBe('PRECONDITION_FAILED');
  });
});

describe('engine guards and input parsing', () => {
  const dir = tempDir();
  const configPath = writeConfig(dir, { allow_execute: true });
  const reg = registry();

  it('ctx.call inherits the entry point execute guard (no bypass via composition)', async () => {
    sideEffects = 0;
    const viaMcp = await invoke(reg, 'rv.compose', {}, { configPath, allowExecute: false });
    expect((viaMcp.data as any).inner_code).toBe('PRECONDITION_FAILED');
    expect(sideEffects).toBe(0);
    const viaCli = await invoke(reg, 'rv.compose', {}, { configPath });
    expect((viaCli.data as any).inner_status).toBe('success');
    expect(sideEffects).toBe(1);
  });

  it('a handler that rejects after the time budget yields TIMEOUT and no unhandled rejection', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (e: unknown) => seen.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const env = await invoke(reg, 'rv.late_reject', {}, { configPath, timeoutMs: 20 });
      expect(env.error?.code).toBe('TIMEOUT');
      await new Promise((r) => setTimeout(r, 150));
      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('a timed-out execute operation tells the caller to check the real state', async () => {
    const env = await invoke(reg, 'rv.slow_write', {}, { configPath, timeoutMs: 20 });
    expect(env.error?.code).toBe('TIMEOUT');
    expect(env.error?.hint).toContain('operation get');
  });

  it('list inputs: repeated flags and comma-separated values are equivalent', async () => {
    const env = await invoke(reg, 'rv.inputs', { items: ['a,b', ' c '] }, { configPath });
    expect((env.data as any).items).toEqual(['a', 'b', 'c']);
    const plan = await invoke(reg, 'operation.plan', { action: 'rv.slow', param: ['a=1,b=2'] }, { configPath });
    expect((plan.data as any).params).toEqual({ a: '1', b: '2' });
  });

  it('int/number inputs reject booleans, blanks and junk instead of coercing them', async () => {
    for (const bad of [true, ' ', '12abc', '1.5', [3]]) {
      const env = await invoke(reg, 'rv.inputs', { n: bad }, { configPath });
      expect(env.error?.code, JSON.stringify(bad)).toBe('INVALID_ARGUMENT');
    }
    expect(((await invoke(reg, 'rv.inputs', { n: ' 12 ', x: '-1.5e2' }, { configPath })).data as any)).toMatchObject({ n: 12, x: -150 });
    expect((await invoke(reg, 'rv.inputs', { x: 'abc' }, { configPath })).error?.code).toBe('INVALID_ARGUMENT');
  });

  it('file inputs must be regular files', async () => {
    const env = await invoke(reg, 'rv.inputs', { f: dir }, { configPath });
    expect(env.error?.code).toBe('INVALID_ARGUMENT');
    expect(env.error?.message).toContain('不是普通文件');
  });

  it('relative file inputs reach the handler as absolute paths (plugins run in their own directory)', async () => {
    const file = join(dir, 'q.json');
    writeFileSync(file, '{}');
    const prev = process.cwd();
    process.chdir(dir);
    try {
      const env = await invoke(reg, 'rv.inputs', { f: 'q.json' }, { configPath });
      expect(env.status).toBe('success');
      expect((env.data as any).f).toBe(resolve('q.json'));
      expect(isAbsolute((env.data as any).f)).toBe(true);
    } finally {
      process.chdir(prev);
    }
  });

  it('expands a leading ~/ in file inputs to the home directory (MCP callers have no shell)', async () => {
    const home = join(dir, 'fake-home');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'q.json'), '{}');
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const env = await invoke(reg, 'rv.inputs', { f: '~/q.json' }, { configPath });
      expect(env.status).toBe('success');
      expect((env.data as any).f).toBe(join(home, 'q.json'));
      // only a leading ~/ is expanded; ~user and embedded ~ stay literal
      expect((await invoke(reg, 'rv.inputs', { f: '~nobody/q.json' }, { configPath })).error?.code).toBe('INVALID_ARGUMENT');
    } finally {
      process.env.HOME = prevHome;
    }
  });
});

describe('config: inline credentials', () => {
  const reg = testRegistry();
  const cases: [string, Record<string, unknown>][] = [
    ['suffixed key', { kafka: { k: { brokers: ['x:1'], sasl_password: 'p' } } }],
    ['client secret', { api: { a: { url: 'http://h', client_secret: 's' } } }],
    ['url userinfo', { prometheus: { p: { url: 'http://admin:hunter2@127.0.0.1:9090' } } }],
    ['nested object', { kafka: { k: { sasl: { mechanism: 'plain', password: 'p' } } } }],
    ['key passphrase (plugin endpoint)', { kafka: { k: { brokers: ['x:1'], ssl_key_passphrase: 'hunter2' } } }],
    ['authorization header (plugin endpoint)', { opensearch: { s: { url: 'http://h', headers: { Authorization: 'Bearer hunter2-abcdef' } } } }],
    ['bearer value under any key', { opensearch: { s: { url: 'http://h', headers: { 'X-Api': 'Bearer hunter2-abcdef' } } } }],
  ];
  for (const [label, endpoints] of cases) {
    it(`rejects ${label}`, async () => {
      const p = writeConfig(tempDir(), { endpoints });
      const env = await invoke(reg, 'fake.echo', { text: 'a' }, { configPath: p });
      expect(env.error?.code).toBe('INVALID_ARGUMENT');
      expect(JSON.stringify(env)).not.toContain('hunter2');
    });
  }
  it('accepts references, plain URLs and non-secret keys', () => {
    const p = writeConfig(tempDir(), { endpoints: { prometheus: { p: { url: 'http://user@127.0.0.1:9090', token_ref: 'env:X', max_tokens: 3, password_ref: 'file:secret.txt' } } } });
    expect(() => loadConfig(p)).not.toThrow();
  });
  it('a YAML syntax error does not quote file content (inline secrets) in the error', async () => {
    const d = tempDir();
    const p = join(d, 'bad.yaml');
    writeFileSync(p, 'profiles:\n  p:\n    endpoints:\n      mysql:\n        m:\n          password: Sup3rSecretValue\n         host: [a\n');
    const env = await invoke(reg, 'fake.echo', { text: 'a' }, { configPath: p });
    expect(env.error?.code).toBe('INVALID_ARGUMENT');
    expect(JSON.stringify(env)).toMatch(/line 7/);
    expect(JSON.stringify(env)).not.toContain('Sup3rSecretValue');
  });
  it('a YAML syntax error in the bindings file is INVALID_ARGUMENT without quoting the file', () => {
    const d = tempDir();
    const b = join(d, 'bindings.yaml');
    writeFileSync(b, 'resources:\n  - id: svc\n    attributes: {note: Sup3rSecretValue\n   x: [\n');
    let err: any;
    try {
      ResourceStore.load(b);
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe('INVALID_ARGUMENT');
    expect(JSON.stringify({ m: err?.message, d: err?.details })).not.toContain('Sup3rSecretValue');
  });
});

describe('mcp json-rpc handling', () => {
  const dir = tempDir();
  const configPath = writeConfig(dir, { allow_execute: true });
  const reg = registry();
  const o = { allowExecute: true, configPath, timeoutMs: 5000 };

  it('never executes or answers a tools/call notification', async () => {
    sideEffects = 0;
    const res = await handleMcpMessage(reg, o, { jsonrpc: '2.0', method: 'tools/call', params: { name: 'rv_write', arguments: {} } });
    expect(res).toBeNull();
    expect(sideEffects).toBe(0);
    expect(await handleMcpMessage(reg, o, { jsonrpc: '2.0', method: 'initialize', params: {} })).toBeNull();
  });

  it('answers requests with id 0 and rejects malformed messages', async () => {
    const ping = await handleMcpMessage(reg, o, { jsonrpc: '2.0', id: 0, method: 'ping' });
    expect(ping).toEqual({ jsonrpc: '2.0', id: 0, result: {} });
    const arr = await handleMcpMessage(reg, o, [{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
    expect(arr.error.code).toBe(-32600);
    expect(arr.id).toBeNull();
    const badId = await handleMcpMessage(reg, o, { jsonrpc: '2.0', id: { x: 1 }, method: 'ping' });
    expect(badId.error.code).toBe(-32600);
    const badArgs = await handleMcpMessage(reg, o, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'rv_inputs', arguments: 'n=1' } });
    expect(badArgs.error.code).toBe(-32602);
    const unknown = await handleMcpMessage(reg, o, { jsonrpc: '2.0', id: 3, method: 'resources/list' });
    expect(unknown.error.code).toBe(-32601);
  });
});

function pluginPackage(dir: string, manifest: Record<string, unknown>, extra?: (root: string) => void): string {
  const root = join(dir, `pkg-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'guide.md'), '# g');
  writeFileSync(
    join(root, 'dist', 'p.mjs'),
    `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(JSON.stringify({status:'success',data:{env:Object.keys(process.env)},meta:{sources:[],warnings:[]}}));});`,
  );
  writeFileSync(
    join(root, 'workctl-plugin.json'),
    JSON.stringify({
      plugin_api: 'workctl-plugin/1',
      name: 'rvp',
      version: '0.1.0',
      backend_mode: 'live',
      entry: 'dist/p.mjs',
      domain: { name: 'rvp', title: 'R', summary: 's', pillar: 'middleware', guide: 'guide.md' },
      capabilities: [{ name: 'rvp.env', command: 'rvp env', summary: 'env', adapter: 'x', operation: 'read', auth_provider: 'x', capability_version: '1.0.0', guide: 'guide.md' }],
      ...manifest,
    }),
  );
  extra?.(root);
  const tgz = join(dir, `${Math.random().toString(36).slice(2)}.tgz`);
  expect(spawnSync('tar', ['-czf', tgz, '-C', root, '.']).status).toBe(0);
  return tgz;
}

describe('plugin install hardening', () => {
  const dir = tempDir();
  const prevHome = process.env.WORKCTL_HOME;
  beforeAll(() => {
    process.env.WORKCTL_HOME = join(dir, 'home');
    process.env.RV_UNRELATED_SECRET = 'should-not-leak';
  });
  afterAll(() => {
    process.env.WORKCTL_HOME = prevHome;
    delete process.env.RV_UNRELATED_SECRET;
  });

  it('rejects a version that would escape the plugins directory (rm -rf outside)', () => {
    const victim = join(dir, 'home', 'victim');
    mkdirSync(victim, { recursive: true });
    const tgz = pluginPackage(dir, { version: '../../victim' });
    expect(() => installPlugin(tgz, testRegistry())).toThrow(/插件清单不合法/);
    expect(existsSync(victim)).toBe(true);
  });

  it('rejects reserved domain names such as the builtin planned pseudo-domain', () => {
    const reg = testRegistry();
    const before = reg.domains.get('planned');
    const tgz = pluginPackage(dir, {
      domain: { name: 'planned', title: 'X', summary: 's', pillar: 'middleware', guide: 'guide.md' },
      capabilities: [{ name: 'planned.x', command: 'planned x', summary: 'x', adapter: 'x', operation: 'read', auth_provider: 'x', capability_version: '1.0.0', guide: 'guide.md' }],
    });
    expect(() => installPlugin(tgz, reg)).toThrow(/保留/);
    expect(reg.domains.get('planned')).toBe(before);
    expect(() => reg.addDomain({ ...before!, title: 'hijack', capabilities: [] }, { fulfillPlanned: true })).toThrow(/duplicate domain planned/);
  });

  it('rejects manifest paths outside the package', () => {
    const tgz = pluginPackage(dir, { entry: '../../../../etc/hostname' });
    expect(() => installPlugin(tgz, testRegistry())).toThrow(/超出插件目录/);
  });

  it('rejects archives with symlinks', () => {
    const tgz = pluginPackage(dir, {}, (root) => symlinkSync('/etc', join(root, 'escape')));
    expect(() => installPlugin(tgz, testRegistry())).toThrow(/不允许的条目/);
  });

  it('rejects a command that collides with an existing capability', () => {
    const tgz = pluginPackage(dir, {
      capabilities: [{ name: 'rvp.echo', command: 'fake echo', summary: 'e', adapter: 'x', operation: 'read', auth_provider: 'x', capability_version: '1.0.0', guide: 'guide.md' }],
    });
    expect(() => installPlugin(tgz, testRegistry())).toThrow(/命令冲突/);
  });

  it('redacts credentials a broken plugin echoes in its raw output', async () => {
    const tgz = pluginPackage(dir, { name: 'rvecho', domain: { name: 'rvecho', title: 'E', summary: 's', pillar: 'middleware', guide: 'guide.md' }, endpoint_kinds: ['qq'], capabilities: [{ name: 'rvecho.dump', command: 'rvecho dump', summary: 'd', adapter: 'x', operation: 'read', auth_provider: 'x', capability_version: '1.0.0', guide: 'guide.md' }] }, (root) =>
      writeFileSync(join(root, 'dist', 'p.mjs'), `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write('DEBUG '+s);});`),
    );
    installPlugin(tgz, testRegistry());
    const reg = testRegistry();
    loadPlugins(reg);
    process.env.RV_Q_PASS = 'pa55-word-xyz';
    const env = await invoke(reg, 'rvecho.dump', {}, { configPath: writeConfig(tempDir(), { endpoints: { qq: { a: { host: 'h', password_ref: 'env:RV_Q_PASS' } } } }) });
    expect(env.error?.code).toBe('INTERNAL');
    expect(JSON.stringify(env)).not.toContain('pa55-word-xyz');
    expect(JSON.stringify(env.error?.details)).toContain('***');
    delete process.env.RV_Q_PASS;
  });

  it('runs plugins with a minimal environment (credentials only via stdin)', async () => {
    installPlugin(pluginPackage(dir, {}), testRegistry());
    const reg = testRegistry();
    expect(loadPlugins(reg).errors).toEqual([]);
    const env = await invoke(reg, 'rvp.env', {}, { configPath: writeConfig(tempDir()) });
    expect(env.status).toBe('success');
    const keys = (env.data as any).env as string[];
    expect(keys).not.toContain('RV_UNRELATED_SECRET');
    expect(keys.every((k) => Object.keys(pluginEnv()).includes(k) || !(k in process.env))).toBe(true);
  });
});

describe('registry: fulfilling planned built-ins is all-or-nothing', () => {
  it('a domain rejected mid-way leaves planned entries, domain metadata and commands untouched', async () => {
    const { builtinRegistry } = await import('../../src/domains');
    const reg = builtinRegistry();
    const before = { search: reg.domains.get('search'), query: reg.get('search.query'), size: reg.capabilities.size };
    const cap = (name: string, command: string) =>
      defineCapability({ name, command, summary: name, domain: 'search', adapter: 'a', operation: 'read', auth_provider: 'a', guide: 'g', origin: 'plugin:p@1', handler: async () => ({ data: null }) });
    // first capability fulfils a planned built-in, the second clashes with an existing command
    const plugin = defineDomain({ name: 'search', title: 'plugin', summary: 's', pillar: 'middleware', guide: 'g', capabilities: [cap('search.query', 'search query'), cap('search.clash', 'capability list')] });
    expect(() => reg.addDomain(plugin, { fulfillPlanned: true })).toThrow(/duplicate command/);
    expect(reg.domains.get('search')).toBe(before.search);
    expect(reg.get('search.query')).toBe(before.query);
    expect(reg.get('search.query')?.status).toBe('planned');
    expect(reg.get('search.clash')).toBeUndefined();
    expect(reg.capabilities.size).toBe(before.size);
    // the same plugin without the clash still fulfils the planned entry
    reg.addDomain({ ...plugin, capabilities: [cap('search.query', 'search query')] }, { fulfillPlanned: true });
    expect(reg.get('search.query')).toMatchObject({ status: 'available', origin: 'plugin:p@1' });
  });
});

describe('doctor: malformed endpoint address', () => {
  it('reports a url that cannot be parsed as a failed check instead of aborting with INTERNAL', async () => {
    const reg = testRegistry();
    const p = writeConfig(tempDir(), { endpoints: { prometheus: { x: { url: '127.0.0.1:9090' } } } });
    const env = await invoke(reg, 'doctor.run', {}, { configPath: p });
    expect(env.status).toBe('success');
    const c = (env.data as any).checks.find((x: any) => x.item === 'prometheus/x');
    expect(c).toMatchObject({ area: 'endpoints', ok: false });
    expect((env.data as any).healthy).toBe(false);
  });
});

describe('access check: unknown --target', () => {
  it('does not silently check the default endpoint when the named target does not exist', async () => {
    const reg = new Registry();
    reg.addDomain(coreDomain);
    reg.addDomain(
      defineDomain({
        name: 'mysql',
        title: 'm',
        summary: 'm',
        pillar: 'middleware',
        guide: 'docs/x.md',
        capabilities: [
          defineCapability({ name: 'mysql.t.get', command: 'mysql t get', summary: 's', domain: 'mysql', output: z.object({}), adapter: 'a', operation: 'read', auth_provider: 'none', guide: 'docs/x.md', handler: async () => ({ data: {} }) }),
        ],
      }),
    );
    const configPath = writeConfig(tempDir());
    const bad = await invoke(reg, 'access.check', { capability: 'mysql.t.get', target: 'prod-mysql', probe: false }, { configPath });
    expect((bad.data as any).verdict).toBe('denied');
    expect((bad.data as any).checks.find((c: any) => c.check === 'target')).toMatchObject({ ok: false });
    const good = await invoke(reg, 'access.check', { capability: 'mysql.t.get', target: 'db-a', probe: false }, { configPath });
    expect((good.data as any).verdict).toBe('allowed');
  });
});
