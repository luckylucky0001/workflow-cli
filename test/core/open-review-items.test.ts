// Regression tests for open review items: MCP domain filter vs operation.*, plan file integrity,
// credential masking in application logs, MCP stdin limits/lifecycle, duration schema, lazy plugin refs.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { installPlugin, loadPlugins } from '../../src/core/plugins';
import { maskedNote, parseLogLine } from '../../src/domains/observability/logs';
import { handleMcpMessage, MAX_MCP_LINE_BYTES, serveMcp, toolsFor, type McpOptions } from '../../src/mcp/server';
import { tempDir, testRegistry, writeConfig } from './helpers';

const call = (o: McpOptions, name: string, args: Record<string, unknown>, id = 1) =>
  handleMcpMessage(testRegistry(), o, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

describe('mcp serve --domain bounds operation.*', () => {
  const dir = tempDir();
  const configPath = writeConfig(dir, { allow_execute: true });
  const o = (domains: string[]): McpOptions => ({ allowExecute: true, domains, configPath, timeoutMs: 10_000 });

  it('refuses plans of actions outside the allowed domains', async () => {
    const res = await call(o(['redis']), 'operation_plan', { action: 'fake.restart', param: ['target=a'] });
    expect(res.result.structuredContent.status).toBe('error');
    expect(res.result.structuredContent.error.code).toBe('PERMISSION_DENIED');
    expect(res.result.structuredContent.error.message).toMatch(/fake\.restart.*fake.*redis/);
    const ok = await call(o(['fake']), 'operation_plan', { action: 'fake.restart', param: ['target=a'] });
    expect(ok.result.structuredContent.status).toBe('success');
  });

  it('refuses executing/cancelling a plan of another domain (plan made elsewhere)', async () => {
    const plan = await invoke(testRegistry(), 'operation.plan', { action: 'fake.restart', param: ['target=a'] }, { configPath });
    const id = (plan.data as any).id as string;
    const ex = await call(o(['redis']), 'operation_execute', { id, confirm: id });
    expect(ex.result.structuredContent.error.code).toBe('PERMISSION_DENIED');
    const cancel = await call(o(['redis']), 'operation_cancel', { id });
    expect(cancel.result.structuredContent.error.code).toBe('PERMISSION_DENIED');
    const got = await invoke(testRegistry(), 'operation.get', { id }, { configPath });
    expect((got.data as any).status).toBe('planned');
    const allowed = await call(o(['fake']), 'operation_execute', { id, confirm: id });
    expect(allowed.result.structuredContent.status).toBe('success');
  });

  it('the engine refuses other domains\' capabilities under an allow-list (also via composition)', async () => {
    const env = await invoke(testRegistry(), 'fake.echo', { text: 'x' }, { configPath, allowedDomains: ['redis'] });
    expect(env.error?.code).toBe('PERMISSION_DENIED');
    expect((await invoke(testRegistry(), 'fake.echo', { text: 'x' }, { configPath, allowedDomains: ['fake'] })).status).toBe('success');
  });
});

describe('plan file integrity', () => {
  const dir = tempDir();
  const configPath = writeConfig(dir, { allow_execute: true });
  const planFile = (id: string) => join(dir, 'state', 'operations', `${id}.json`);

  it('detects edited preconditions before execute', async () => {
    const plan = await invoke(testRegistry(), 'operation.plan', { action: 'fake.restart', param: ['target=missing'] }, { configPath });
    const id = (plan.data as any).id as string;
    expect((plan.data as any).digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const doc = JSON.parse(readFileSync(planFile(id), 'utf8'));
    doc.preconditions = doc.preconditions.map((p: any) => ({ ...p, ok: true }));
    writeFileSync(planFile(id), JSON.stringify(doc, null, 2));
    const ex = await invoke(testRegistry(), 'operation.execute', { id, confirm: id }, { configPath });
    expect(ex.error?.code).toBe('PRECONDITION_FAILED');
    expect(ex.error?.message).toMatch(/plan file was modified/);
    expect((await invoke(testRegistry(), 'operation.get', { id }, { configPath })).error?.code).toBe('PRECONDITION_FAILED');
  });

  it('detects edited params/targets/status; a missing digest is not trusted', async () => {
    for (const edit of [(d: any) => (d.params.target = 'b'), (d: any) => (d.targets = [{ id: 'other' }]), (d: any) => (d.status = 'planned', d.history = []), (d: any) => delete d.digest]) {
      const plan = await invoke(testRegistry(), 'operation.plan', { action: 'fake.restart', param: ['target=a'] }, { configPath });
      const id = (plan.data as any).id as string;
      const doc = JSON.parse(readFileSync(planFile(id), 'utf8'));
      edit(doc);
      writeFileSync(planFile(id), JSON.stringify(doc));
      const ex = await invoke(testRegistry(), 'operation.execute', { id, confirm: id }, { configPath });
      expect(ex.error?.code).toBe('PRECONDITION_FAILED');
    }
  });

  it('legitimate status/history updates are re-sealed (execute, then get)', async () => {
    const plan = await invoke(testRegistry(), 'operation.plan', { action: 'fake.restart', param: ['target=a'] }, { configPath });
    const id = (plan.data as any).id as string;
    // a reformatted but unchanged file is still accepted (digest is over canonical JSON)
    writeFileSync(planFile(id), JSON.stringify(JSON.parse(readFileSync(planFile(id), 'utf8'))));
    const ex = await invoke(testRegistry(), 'operation.execute', { id, confirm: id }, { configPath });
    expect(ex.status).toBe('success');
    const got = await invoke(testRegistry(), 'operation.get', { id }, { configPath });
    expect((got.data as any).status).toBe('succeeded');
    expect((got.data as any).history.map((h: any) => h.status)).toEqual(['planned', 'running', 'running', 'succeeded']);
  });
});

describe('credentials in application logs are masked', () => {
  it('masks URL userinfo passwords, Authorization headers and password=/token= params in raw lines', () => {
    const e = parseLogLine('2026-01-01T00:00:00.000Z dial postgres://app:hunter2@db:5432/x Authorization: Bearer abc.def-123 GET /a?token=tk999&page=2 password=pw1', 'c', 'stdout');
    expect(e.raw).toBe('dial postgres://app:***@db:5432/x Authorization: Bearer *** GET /a?token=***&page=2 password=***');
    expect(e.credentials_masked).toBe(true);
    const basic = parseLogLine('2026-01-01T00:00:00.000Z header Authorization: Basic dXNlcjpwYXNz', 'c', 'stderr');
    expect(basic.raw).not.toContain('dXNlcjpwYXNz');
  });

  it('masks JSON msg and fields (secret-named keys, nested URLs) and keeps other content unchanged', () => {
    const line = JSON.stringify({ level: 'info', msg: 'connect redis://:r3dis@cache:6379', password: 'x1', cache_key: 'order:1', token_count: 5, nested: { url: 'https://u:p4ss@h/x' }, trace_id: 't1' });
    const e = parseLogLine(`2026-01-01T00:00:00.000Z ${line}`, 'c', 'stdout');
    expect(e.msg).toBe('connect redis://:***@cache:6379');
    expect(e.fields).toEqual({ password: '***', cache_key: 'order:1', token_count: 5, nested: { url: 'https://u:***@h/x' } });
    expect(e.trace_id).toBe('t1');
    expect(e.credentials_masked).toBe(true);
    expect(JSON.stringify(e)).not.toMatch(/r3dis|x1"|p4ss/);
  });

  it('leaves non-credential lines untouched', () => {
    const text = 'GET /orders?page=2&size=10 200 12ms user=alice key=order:1 https://example.com/a@b';
    const e = parseLogLine(`2026-01-01T00:00:00.000Z ${text}`, 'c', 'stdout');
    expect(e.raw).toBe(text);
    expect(e.credentials_masked).toBe(false);
    expect(maskedNote(3)).toMatch(/^3 条日志含凭据/);
  });
});

describe('mcp stdio: line size limit and initialize lifecycle', () => {
  async function session(lines: (string | Buffer)[]): Promise<any[]> {
    const input = new PassThrough();
    const output = new PassThrough();
    let out = '';
    output.on('data', (d) => (out += d));
    const done = serveMcp(testRegistry(), { allowExecute: false, configPath: writeConfig(tempDir()), timeoutMs: 10_000 }, { input, output });
    for (const l of lines) input.write(l);
    input.end();
    await done;
    return out.trim().split('\n').map((l) => JSON.parse(l));
  }

  it('rejects an oversized line without buffering it and keeps serving', async () => {
    const big = Buffer.alloc(MAX_MCP_LINE_BYTES + 1024, 'a');
    const replies = await session([big.subarray(0, 1_000_000), big.subarray(1_000_000), '\n', JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }) + '\n']);
    expect(replies[0]).toMatchObject({ id: null, error: { code: -32600 } });
    expect(replies[0].error.message).toMatch(/exceeds/);
    expect(replies[1]).toEqual({ jsonrpc: '2.0', id: 7, result: {} });
  });

  it('rejects tools/call and tools/list before initialize; serves them after', async () => {
    const msg = (id: number, method: string, params?: unknown) => JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n';
    const before = await session([msg(1, 'tools/call', { name: 'fake_echo', arguments: { text: 'x' } }), msg(2, 'tools/list'), msg(3, 'ping')]);
    const byId = Object.fromEntries(before.map((r) => [r.id, r]));
    expect(byId[1].error.code).toBe(-32002);
    expect(byId[2].error.code).toBe(-32002);
    expect(byId[3].result).toEqual({});
    const after = await session([msg(1, 'initialize', { protocolVersion: '2025-06-18' }), JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n', msg(2, 'tools/call', { name: 'fake_echo', arguments: { text: 'x' } })]);
    const call2 = after.find((r) => r.id === 2);
    expect(call2.result.structuredContent.status).toBe('success');
  });
});

describe('mcp duration input schema matches the engine', () => {
  it('accepts 0, integers (ms) and spaced unit strings like the engine', async () => {
    const tool = toolsFor(testRegistry(), { allowExecute: false }).find((t) => t.name === 'fake_echo')!;
    const schema = (tool.inputSchema.properties as any).window;
    const intBranch = schema.anyOf.find((b: any) => b.type === 'integer');
    const strBranch = schema.anyOf.find((b: any) => b.type === 'string');
    expect(intBranch.minimum).toBe(0);
    const re = new RegExp(strBranch.pattern);
    for (const v of ['0', '30s', ' 15m ', '1.5h', '500ms']) expect(re.test(v)).toBe(true);
    for (const v of ['', '30', 'abc', '-1s']) expect(re.test(v)).toBe(false);
    const configPath = writeConfig(tempDir());
    for (const v of [0, '0', 1500, ' 15m ']) {
      expect((await invoke(testRegistry(), 'fake.echo', { text: 'x', window: v }, { configPath })).status).toBe('success');
    }
    for (const v of ['30', 'abc']) expect((await invoke(testRegistry(), 'fake.echo', { text: 'x', window: v }, { configPath })).error?.code).toBe('INVALID_ARGUMENT');
  });
});

describe('plugin endpoint refs are resolved only for the endpoint a call uses', () => {
  const dir = tempDir();
  const prevHome = process.env.WORKCTL_HOME;
  beforeAll(() => {
    process.env.WORKCTL_HOME = join(dir, 'home');
    process.env.OPEN_ITEMS_GOOD = 'g00d-secret';
    delete process.env.OPEN_ITEMS_MISSING;
  });
  afterAll(() => {
    process.env.WORKCTL_HOME = prevHome;
    delete process.env.OPEN_ITEMS_GOOD;
  });

  it('a broken ref on another endpoint does not fail the call; on the used endpoint it does', async () => {
    const root = join(dir, 'pkg');
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'guide.md'), '# g');
    writeFileSync(join(root, 'dist', 'p.mjs'), `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);const ep=r.endpoints.qq??{};process.stdout.write(JSON.stringify({status:'success',data:{names:Object.keys(ep),has_password:!!(ep[r.inputs.cluster]??ep[r.defaults.qq]??{}).password},meta:{sources:[],warnings:[]}}));});`);
    writeFileSync(
      join(root, 'workctl-plugin.json'),
      JSON.stringify({
        plugin_api: 'workctl-plugin/1',
        name: 'oip',
        version: '0.1.0',
        backend_mode: 'live',
        entry: 'dist/p.mjs',
        endpoint_kinds: ['qq'],
        domain: { name: 'oip', title: 'O', summary: 's', pillar: 'middleware', guide: 'guide.md' },
        capabilities: [{ name: 'oip.get', command: 'oip get', summary: 'g', adapter: 'x', operation: 'read', auth_provider: 'x', capability_version: '1.0.0', guide: 'guide.md', inputs: { cluster: { type: 'string', description: 'c' } } }],
      }),
    );
    const tgz = join(dir, 'p.tgz');
    expect(spawnSync('tar', ['-czf', tgz, '-C', root, '.']).status).toBe(0);
    installPlugin(tgz, testRegistry());
    const reg = testRegistry();
    expect(loadPlugins(reg).errors).toEqual([]);
    const configPath = writeConfig(tempDir(), {
      defaults: { qq: 'good' },
      endpoints: { qq: { good: { host: 'h1', password_ref: 'env:OPEN_ITEMS_GOOD' }, broken: { host: 'h2', password_ref: 'env:OPEN_ITEMS_MISSING' } } },
    });
    const named = await invoke(reg, 'oip.get', { cluster: 'good' }, { configPath });
    expect(named.status).toBe('success');
    expect(named.data).toEqual({ names: ['good'], has_password: true });
    expect(named.meta.warnings.join('\n')).toMatch(/broken.*OPEN_ITEMS_MISSING/);
    expect(JSON.stringify(named)).not.toContain('g00d-secret');
    const byDefault = await invoke(reg, 'oip.get', {}, { configPath });
    expect(byDefault.status).toBe('success');
    const broken = await invoke(reg, 'oip.get', { cluster: 'broken' }, { configPath });
    expect(broken.error?.code).toBe('UNAUTHENTICATED');
    expect(broken.error?.message).toMatch(/OPEN_ITEMS_MISSING/);
  });
});
