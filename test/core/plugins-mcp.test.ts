import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { installPlugin, listInstalled, loadPlugins, removePlugin } from '../../src/core/plugins';
import { handleMcpMessage } from '../../src/mcp/server';
import { tempDir, testRegistry, writeConfig } from './helpers';

function buildFakePlugin(dir: string, backend = 'live'): string {
  const root = join(dir, 'pkg');
  mkdirSync(join(root, 'dist'), { recursive: true });
  mkdirSync(join(root, 'guides'), { recursive: true });
  mkdirSync(join(root, 'schemas'), { recursive: true });
  writeFileSync(join(root, 'guides', 'q.md'), '# q');
  writeFileSync(join(root, 'schemas', 'q.lag.v1.json'), JSON.stringify({ type: 'object' }));
  writeFileSync(
    join(root, 'workctl-plugin.json'),
    JSON.stringify({
      plugin_api: 'workctl-plugin/1',
      name: 'fake-q',
      version: '0.1.0',
      backend_mode: backend,
      entry: 'dist/plugin.mjs',
      domain: { name: 'q', title: 'Q', summary: 'queue', pillar: 'middleware', guide: 'guides/q.md' },
      endpoint_kinds: ['qbroker'],
      capabilities: [
        { name: 'q.lag', command: 'q lag', summary: 'lag', inputs: { group: { type: 'string', required: true, description: 'g' } }, output_schema: 'schemas/q.lag.v1.json', adapter: 'q-admin', operation: 'read', auth_provider: 'q-profile', capability_version: '1.0.0', guide: 'guides/q.md' },
        { name: 'q.other', command: 'q other', summary: 'other', adapter: 'q', operation: 'read', auth_provider: 'q', capability_version: '1.0.0', guide: 'guides/q.md', status: 'planned' },
      ],
    }),
  );
  writeFileSync(
    join(root, 'dist', 'plugin.mjs'),
    `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);
     if(r.inputs.group==='missing'){process.stdout.write(JSON.stringify({status:'error',error:{code:'NOT_FOUND',message:'no group'},meta:{sources:[],warnings:[]}}));return;}
     process.stdout.write(JSON.stringify({status:'success',data:{group:r.inputs.group,endpoint:r.endpoints,request:r.request_id},error:null,meta:{sources:[{system:'q',adapter:'q-admin',observed_at:new Date().toISOString()}],coverage:{complete:true},warnings:[]}}));});`,
  );
  const tgz = join(dir, 'fake-q.tgz');
  expect(spawnSync('tar', ['-czf', tgz, '-C', root, '.']).status).toBe(0);
  return tgz;
}

describe('plugins', () => {
  const dir = tempDir();
  const prevHome = process.env.WORKCTL_HOME;
  beforeAll(() => {
    process.env.WORKCTL_HOME = join(dir, 'home');
    process.env.FAKE_Q_TOKEN = 'tok-123';
  });
  afterAll(() => {
    process.env.WORKCTL_HOME = prevHome;
  });

  it('installs, loads and executes a plugin through the same engine', async () => {
    const tgz = buildFakePlugin(dir);
    const reg = testRegistry();
    const res = installPlugin(tgz, reg);
    expect(res.plugin.name).toBe('fake-q');
    expect(listInstalled()).toHaveLength(1);

    const reg2 = testRegistry();
    expect(loadPlugins(reg2).loaded).toEqual(['fake-q@0.1.0']);
    expect(reg2.get('q.lag')?.origin).toBe('plugin:fake-q@0.1.0');
    expect(reg2.get('q.other')?.status).toBe('planned');

    const configPath = writeConfig(dir, { endpoints: { qbroker: { main: { brokers: ['x:1'], token_ref: 'env:FAKE_Q_TOKEN' } } } });
    const env = await invoke(reg2, 'q.lag', { group: 'g1' }, { configPath, requestId: 'req-test' });
    expect(env.status).toBe('success');
    expect((env.data as any).group).toBe('g1');
    // credential resolved by core and passed only through stdin
    expect((env.data as any).endpoint.qbroker.main.token).toBe('tok-123');
    expect(env.context.request_id).toBe('req-test');
    const err = await invoke(reg2, 'q.lag', { group: 'missing' }, { configPath });
    expect(err.error?.code).toBe('NOT_FOUND');
    const cat = await invoke(reg2, 'capability.list', { domain: 'q' }, { configPath });
    expect((cat.data as any).capabilities.map((c: any) => `${c.name}:${c.status}`)).toEqual(['q.lag:available', 'q.other:planned']);
    removePlugin('fake-q');
    expect(listInstalled()).toHaveLength(0);
  });

  it('labels non-live plugin backends', async () => {
    const d2 = tempDir();
    const reg = testRegistry();
    installPlugin(buildFakePlugin(d2, 'recorded'), reg);
    const reg2 = testRegistry();
    loadPlugins(reg2);
    const env = await invoke(reg2, 'q.lag', { group: 'g' }, { configPath: writeConfig(d2) });
    expect(env.meta.warnings[0]).toContain('recorded');
    removePlugin('fake-q');
  });

  it('rejects plugins that collide with capabilities from other sources', () => {
    const d4 = tempDir();
    const reg = testRegistry();
    // 'fake' domain is built in; a plugin claiming it must be rejected
    const tgz = buildFakePlugin(d4);
    spawnSync('sh', ['-c', `cd ${d4}/pkg && sed -i 's/"name":"q"/"name":"fake"/; s/"q\\.lag"/"fake.lag"/; s/"q\\.other"/"fake.other"/' workctl-plugin.json && tar -czf ${tgz} .`]);
    expect(() => installPlugin(tgz, reg)).toThrow(/fake/);
  });

  it('allows reinstalling a loaded plugin', () => {
    const d3 = tempDir();
    const tgz = buildFakePlugin(d3);
    const reg = testRegistry();
    installPlugin(tgz, reg);
    loadPlugins(reg);
    // reinstall/upgrade while the plugin is loaded in the running registry (as in the CLI)
    expect(() => installPlugin(tgz, reg)).not.toThrow();
    expect(reg.get('q.lag')?.output_schema_path).toContain('schemas/q.lag.v1.json');
    removePlugin('fake-q');
  });
});

describe('mcp', () => {
  const dir = tempDir();
  const configPath = writeConfig(dir, { allow_execute: true });
  const reg = testRegistry();
  const o = { allowExecute: false, configPath, timeoutMs: 5000 };

  it('initializes and lists tools derived from capabilities', async () => {
    const init = await handleMcpMessage(reg, o, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    expect(init.result.serverInfo.name).toBe('workctl');
    const list = await handleMcpMessage(reg, o, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = list.result.tools.map((t: any) => t.name);
    expect(names).toContain('fake_echo');
    expect(names).toContain('capability_list');
    expect(names).not.toContain('fake_write'); // execute hidden by default
    expect(names).not.toContain('search_query'); // planned never exposed
    const echo = list.result.tools.find((t: any) => t.name === 'fake_echo');
    expect(echo.inputSchema.required).toEqual(['text']);
    expect(echo.annotations.readOnlyHint).toBe(true);
  });

  it('calls tools through the shared engine', async () => {
    const res = await handleMcpMessage(reg, o, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fake_echo', arguments: { text: 'x' } } });
    expect(res.result.isError).toBe(false);
    expect(res.result.structuredContent.data.text).toBe('x');
    const bad = await handleMcpMessage(reg, o, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'fake_write', arguments: {} } });
    expect(bad.error.code).toBe(-32602);
    const allowed = await handleMcpMessage(reg, { ...o, allowExecute: true }, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'fake_write', arguments: {} } });
    expect(allowed.result.structuredContent.data.done).toBe(true);
    expect(await handleMcpMessage(reg, o, { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });
});
