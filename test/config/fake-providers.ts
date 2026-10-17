// Minimal fake Nacos 2.x Open API and Consul HTTP API servers for unit tests. Wire formats follow the
// real servers as observed on nacos-server 2.4.3 / consul 1.20.6 (see demo/scenarios/config).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

abstract class FakeHttp {
  server!: Server;
  url = '';
  calls: { method: string; path: string; query: URLSearchParams; headers: IncomingMessage['headers'] }[] = [];
  /** never answer (timeout tests) */
  hang = false;

  abstract handle(method: string, path: string, q: URLSearchParams, body: URLSearchParams, req: IncomingMessage): { status: number; body: unknown; headers?: Record<string, string> };

  async start(): Promise<string> {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const u = new URL(req.url ?? '/', 'http://x');
        this.calls.push({ method: req.method ?? 'GET', path: u.pathname, query: u.searchParams, headers: req.headers });
        if (this.hang) return;
        const out = this.handle(req.method ?? 'GET', u.pathname, u.searchParams, new URLSearchParams(Buffer.concat(chunks).toString('utf8')), req);
        res.writeHead(out.status, { 'content-type': typeof out.body === 'string' ? 'text/plain' : 'application/json', ...(out.headers ?? {}) });
        res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  stop(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((r) => this.server.close(() => r()));
  }
}

// ---------------------------------------------------------------------------
// Nacos
// ---------------------------------------------------------------------------
interface NacosHist {
  id: number;
  op: 'I' | 'U' | 'D';
  content: string; // I: inserted content; U/D: content BEFORE the change (pre-image), like Nacos
  tenant: string;
  group: string;
  dataId: string;
}

export class FakeNacos extends FakeHttp {
  configs = new Map<string, { content: string; type: string }>();
  history: NacosHist[] = [];
  nid = 100;
  oldestKept = 0;
  auth: { users: Record<string, string>; deny?: string[] } | null = null;
  tokens = new Set<string>();
  services = new Map<string, Record<string, unknown>[]>();
  fail: number | null = null;

  private k(t: string, g: string, d: string) {
    return `${t}|${g}|${d}`;
  }

  publish(dataId: string, content: string, type = 'properties', tenant = 'sandbox', group = 'DEFAULT_GROUP'): number {
    const key = this.k(tenant, group, dataId);
    const prev = this.configs.get(key);
    this.nid += 1;
    this.history.push({ id: this.nid, op: prev ? 'U' : 'I', content: prev ? prev.content : content, tenant, group, dataId });
    this.configs.set(key, { content, type });
    return this.nid;
  }

  remove(dataId: string, tenant = 'sandbox', group = 'DEFAULT_GROUP'): number {
    const key = this.k(tenant, group, dataId);
    const prev = this.configs.get(key)!;
    this.nid += 1;
    this.history.push({ id: this.nid, op: 'D', content: prev.content, tenant, group, dataId });
    this.configs.delete(key);
    return this.nid;
  }

  handle(method: string, path: string, q: URLSearchParams, body: URLSearchParams): { status: number; body: unknown } {
    if (this.fail) return { status: this.fail, body: 'caused: synthetic server error;' };
    if (path === '/nacos/v1/console/server/state') return { status: 200, body: { version: '2.4.3', startup_mode: 'standalone', auth_enabled: String(!!this.auth), config_retention_days: '30' } };
    if (path === '/nacos/v1/auth/login' && method === 'POST') {
      const u = body.get('username') ?? '';
      if (!this.auth || this.auth.users[u] !== body.get('password')) return { status: 403, body: 'unknown user!' };
      const t = `tok-${u}`;
      this.tokens.add(t);
      return { status: 200, body: { accessToken: t, tokenTtl: 18000, globalAdmin: false, username: u } };
    }
    if (this.auth) {
      const t = q.get('accessToken');
      if (!t) return { status: 403, body: 'user not found!' };
      if (!this.tokens.has(t)) return { status: 403, body: 'token invalid!' };
      if (this.auth.deny?.some((ns) => ns === (q.get('tenant') ?? q.get('namespaceId')))) return { status: 403, body: 'authorization failed!' };
    }
    const tenant = q.get('tenant') ?? q.get('namespaceId') ?? '';
    const group = q.get('group') ?? '';
    const dataId = q.get('dataId') ?? '';
    if (path === '/nacos/v1/cs/configs') {
      const c = this.configs.get(this.k(tenant, group, dataId));
      if (!c) return { status: 200, body: '' };
      return { status: 200, body: { id: '1085585522723713024', dataId, group, tenant, content: c.content, md5: 'm', type: c.type, modifyTime: 1792252998042 } };
    }
    const mine = this.history.filter((h) => h.tenant === tenant && h.group === group && h.dataId === dataId && h.id >= this.oldestKept);
    if (path === '/nacos/v2/cs/history/list') {
      const pageNo = Number(q.get('pageNo') ?? 1);
      const size = Number(q.get('pageSize') ?? 100);
      const desc = [...mine].sort((a, b) => b.id - a.id);
      const items = desc.slice((pageNo - 1) * size, pageNo * size).map((h) => ({ id: String(h.id), dataId, group, tenant, content: null, opType: `${h.op}         `, srcUser: null, lastModifiedTime: '2026-10-18T00:00:00.000+08:00' }));
      return { status: 200, body: { code: 0, message: 'success', data: { totalCount: desc.length, pageNumber: pageNo, pagesAvailable: Math.max(1, Math.ceil(desc.length / size)), pageItems: items } } };
    }
    if (path === '/nacos/v2/cs/history') {
      const h = mine.find((x) => x.id === Number(q.get('nid')));
      return { status: 200, body: { code: 0, message: 'success', data: h ? { id: String(h.id), content: h.content, opType: h.op } : null } };
    }
    if (path === '/nacos/v1/ns/service') {
      const name = q.get('serviceName')!;
      if (!this.services.has(name)) return { status: 400, body: `caused: service not found, namespace: ${tenant}, serviceName: DEFAULT_GROUP@@${name};` };
      return { status: 200, body: { namespaceId: tenant, groupName: 'DEFAULT_GROUP', name, clusters: [{ name: 'DEFAULT', healthChecker: { type: 'TCP' } }] } };
    }
    if (path === '/nacos/v1/ns/catalog/instances') return { status: 200, body: { list: this.services.get(q.get('serviceName')!) ?? [], count: 0 } };
    if (path === '/nacos/v1/ns/instance/list') return { status: 200, body: { hosts: (this.services.get(q.get('serviceName')!) ?? []).filter((h) => h.enabled !== false) } };
    return { status: 404, body: { status: 404, error: 'Not Found', path } };
  }
}

// ---------------------------------------------------------------------------
// Consul
// ---------------------------------------------------------------------------
export class FakeConsul extends FakeHttp {
  index = 10;
  kv = new Map<string, { value: string; create: number; modify: number }>();
  token: string | null = null;
  denyKv = false;
  health = new Map<string, unknown[]>();
  catalog: Record<string, string[]> = { consul: [] };
  fail: number | null = null;

  put(key: string, value: string): number {
    this.index += 1;
    const prev = this.kv.get(key);
    this.kv.set(key, { value, create: prev?.create ?? this.index, modify: this.index });
    return this.index;
  }

  handle(method: string, path: string, q: URLSearchParams, _b: URLSearchParams, req: IncomingMessage): { status: number; body: unknown; headers?: Record<string, string> } {
    if (this.fail) return { status: this.fail, body: 'No cluster leader' };
    if (this.token !== null) {
      const t = req.headers['x-consul-token'];
      if (t !== this.token) return { status: 403, body: 'ACL not found' };
    }
    const h = { 'x-consul-index': String(this.index) };
    if (path === '/v1/agent/self') return { status: 200, body: { Config: { Version: '1.20.6', Datacenter: 'dc1', NodeName: 'n1' }, DebugConfig: { ACLsEnabled: this.token !== null } } };
    if (path === '/v1/status/leader') return { status: 200, body: '"127.0.0.1:8300"' };
    if (path.startsWith('/v1/kv/')) {
      if (this.denyKv) return { status: 403, body: 'Permission denied: token with AccessorID lacks permission "key:read"' };
      const key = decodeURIComponent(path.slice('/v1/kv/'.length));
      const rows = [...this.kv.entries()].filter(([k]) => (q.has('recurse') ? k.startsWith(key) : k === key)).sort(([a], [b]) => (a < b ? -1 : 1));
      if (!rows.length) return { status: 404, body: '', headers: h };
      const idx = q.has('recurse') ? this.index : rows[0][1].modify;
      return { status: 200, headers: { 'x-consul-index': String(idx) }, body: rows.map(([k, v]) => ({ Key: k, Value: v.value === '' ? null : Buffer.from(v.value).toString('base64'), CreateIndex: v.create, ModifyIndex: v.modify, LockIndex: 0, Flags: 0 })) };
    }
    if (path.startsWith('/v1/health/service/')) return { status: 200, headers: h, body: this.health.get(decodeURIComponent(path.slice('/v1/health/service/'.length))) ?? [] };
    if (path === '/v1/catalog/services') return { status: 200, headers: h, body: this.catalog };
    return { status: 404, body: 'not found' };
  }
}

/** Profile with nacos + consul (+ optional etcd) endpoints and a bindings file. */
export function writeProviderConfig(o: { nacos?: string; consul?: string; etcd?: string; nacosExtra?: Record<string, unknown>; consulExtra?: Record<string, unknown>; secret?: string; defaults?: Record<string, string>; apollo?: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), 'workctl-cfgp-'));
  if (o.secret !== undefined) writeFileSync(join(dir, 'secret'), o.secret);
  const endpoints: Record<string, unknown> = {};
  if (o.nacos) endpoints.nacos = { n1: { url: o.nacos, namespace: '${env}', group: 'DEFAULT_GROUP', data_id: '${service}.properties', ...o.nacosExtra } };
  if (o.consul) endpoints.consul = { c1: { url: o.consul, config_prefix: 'config/', ...o.consulExtra } };
  if (o.etcd) endpoints.etcd = { e1: { url: o.etcd } };
  if (o.apollo) endpoints.apollo = { a1: { url: 'http://127.0.0.1:1' } };
  writeFileSync(
    join(dir, 'bindings.yaml'),
    JSON.stringify({
      resources: [
        { id: 'center-nacos', type: 'config.center', env: 'sandbox', endpoint: { kind: 'nacos', name: 'n1' } },
        { id: 'center-consul', type: 'config.center', env: 'sandbox', endpoint: { kind: 'consul', name: 'c1' } },
        { id: 'center-apollo', type: 'config.center', env: 'sandbox', endpoint: { kind: 'apollo', name: 'a1' } },
        { id: 'pay', type: 'service', env: 'sandbox', attributes: { config_center: 'center-nacos' } },
        { id: 'inv', type: 'service', env: 'sandbox' },
        { id: 'legacy', type: 'service', env: 'sandbox', attributes: { config_center: 'center-apollo' } },
      ],
      relations: [{ from: 'inv', to: 'center-consul', type: 'reads_from', source: 'binding-file' }],
    }),
  );
  const cfg = {
    schema_version: '1.0',
    current_profile: 't',
    profiles: { t: { env: 'sandbox', allow_execute: false, state_dir: './state', resources_file: './bindings.yaml', defaults: o.defaults ?? {}, endpoints } },
  };
  const p = join(dir, 'workctl.yaml');
  writeFileSync(p, JSON.stringify(cfg));
  return p;
}
