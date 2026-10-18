import { mkdtempSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { Registry } from '../../src/core/registry';
import network from '../../src/domains/network';
import { httpProbe, latencySummary, parseTarget, tcpConnect } from '../../src/domains/network/probe';
import { rawRequest } from '../../src/core/http';
import { startFakeDocker, writeTestConfig } from '../container/fake-docker';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';

describe('probe helpers (pure / loopback)', () => {
  it('parses host:port targets', () => {
    expect(parseTarget('127.0.0.1:13306')).toEqual({ host: '127.0.0.1', port: 13306 });
    expect(parseTarget('[::1]:6379')).toEqual({ host: '::1', port: 6379 });
    expect(() => parseTarget('nohost')).toThrow(/host:port/);
    expect(() => parseTarget('h:99999')).toThrow(/端口/);
  });

  it('summarises samples without inventing latency for failures', () => {
    expect(latencySummary([{ ok: true, connect_ms: 1 }, { ok: false, connect_ms: null }, { ok: true, connect_ms: 3 }])).toEqual({
      sent: 3,
      succeeded: 2,
      failed: 1,
      loss_pct: 33.3,
      min_ms: 1,
      avg_ms: 2,
      max_ms: 3,
    });
  });

  it('measures a real TCP connect and reports refused ports', async () => {
    const srv = createTcpServer((s) => s.end());
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
    const port = (srv.address() as AddressInfo).port;
    const ok = await tcpConnect('127.0.0.1', port, 1000);
    expect(ok.ok).toBe(true);
    expect(ok.connect_ms).not.toBeNull();
    srv.close();
    const refused = await tcpConnect('127.0.0.1', 1, 1000);
    expect(refused).toMatchObject({ ok: false, error_code: 'ECONNREFUSED', connect_ms: null });
  });
});

describe('network capabilities', () => {
  let http: Server;
  let httpPort: number;
  let fake: Awaited<ReturnType<typeof startFakeDocker>>;
  let configPath: string;
  const r = new Registry();
  r.addDomain(network);

  beforeAll(async () => {
    http = createHttpServer((req, res) => {
      res.writeHead(req.url === '/healthz' ? 200 : 404, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
    });
    await new Promise<void>((ok) => http.listen(0, '127.0.0.1', ok));
    httpPort = (http.address() as AddressInfo).port;
    fake = await startFakeDocker({
      containers: [
        {
          Id: 'e1'.padEnd(64, '0'),
          Name: 'demo-order',
          Labels: { 'workctl.service': 'demo-order', 'workctl.env': 'sandbox' },
          State: 'running',
          Ports: [
            { IP: '0.0.0.0', PrivatePort: 8080, PublicPort: httpPort, Type: 'tcp' },
            { PrivatePort: 9000, Type: 'tcp' },
          ],
        },
      ],
    });
    configPath = writeTestConfig(fake.dir, { socketPath: fake.socketPath });
  });
  afterAll(async () => {
    await fake.close();
    await new Promise<void>((ok) => http.close(() => ok()));
  });

  it('backend list merges binding + published ports and probes each (real probe)', async () => {
    const env = await invoke(r, 'network.backend.list', { service: 'demo-order' }, { configPath });
    expect(env.status).toBe('success');
    expect(env.meta.warnings).toEqual([]);
    const d = env.data as any;
    // binding says 18081 (nothing listens in the test), docker publishes httpPort
    const byPort = Object.fromEntries(d.backends.map((b: any) => [b.port, b]));
    expect(byPort[httpPort].probe).toMatchObject({ kind: 'http', ok: true, status_code: 200 });
    expect(byPort[httpPort].origins[0].origin).toBe('docker-published-port');
    expect(byPort[18081].origins[0].origin).toBe('binding-file');
    expect(env.meta.sources.some((s) => s.relation === 'sampled')).toBe(true);
  });

  it('backend list degrades to partial (binding backends only) when Docker is unreachable', async () => {
    const p = writeTestConfig(mkdtempSync(join(tmpdir(), 'workctl-net-nodocker-')), { socketPath: '/nonexistent/docker.sock' });
    const env = await invoke(r, 'network.backend.list', { service: 'demo-order', timeout_ms: 300 }, { configPath: p });
    expect(env.status).toBe('partial');
    const d = env.data as any;
    expect(d.backends.map((b: any) => b.origins[0].origin)).toEqual(['binding-file']);
    expect(env.meta.coverage?.notes?.join()).toContain('Docker 不可用');
  });

  it('connectivity check reports samples and reachability', async () => {
    const env = await invoke(r, 'network.connectivity.check', { target: `127.0.0.1:${httpPort}`, count: 2, interval_ms: 10 }, { configPath });
    expect(env.meta.warnings).toEqual([]);
    const d = env.data as any;
    expect(d.reachable).toBe(true);
    expect(d.samples).toHaveLength(2);
    const bad = await invoke(r, 'network.connectivity.check', { target: 'nohost' }, { configPath });
    expect(bad.error?.code).toBe('INVALID_ARGUMENT');
  });

  it('dns get resolves localhost through getaddrinfo', async () => {
    const env = await invoke(r, 'network.dns.get', { name: 'localhost' }, { configPath });
    expect(env.meta.warnings).toEqual([]);
    const d = env.data as any;
    expect(d.resolver).toBe('system');
    expect(d.lookup.status).toBe('ok');
    expect(d.resolved).toBe(true);
  });
});

describe('IPv6 literal URLs', () => {
  // new URL() keeps the brackets in hostname; passing "[::1]" to node:http makes it a DNS name (ENOTFOUND)
  it('http probe connects to the address, not a DNS lookup of "[::1]"', async () => {
    const p = await httpProbe('http://[::1]:9/health', 1000);
    expect(p.ok).toBe(false);
    expect(p.error_code).not.toBe('ENOTFOUND');
  });
  it('shared HTTP client does the same', async () => {
    const err = await rawRequest('http://[::1]:9/x', { method: 'GET', headers: {}, timeoutMs: 1000 }).catch((e) => e);
    expect(err?.code).not.toBe('ENOTFOUND');
  });
});
