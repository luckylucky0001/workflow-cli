import { connect } from 'node:net';
import { request as httpRequest } from 'node:http';
import { WorkError } from '../../core/output';

export interface TcpSample {
  seq: number;
  ok: boolean;
  connect_ms: number | null;
  remote_address: string | null;
  error_code: string | null;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** One TCP connect attempt; measures time to an established connection. */
export function tcpConnect(host: string, port: number, timeoutMs: number, seq = 1): Promise<TcpSample> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const sock = connect({ host, port });
    let done = false;
    const finish = (s: TcpSample) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(s);
    };
    sock.setTimeout(timeoutMs, () => finish({ seq, ok: false, connect_ms: null, remote_address: null, error_code: 'ETIMEDOUT' }));
    sock.once('connect', () => finish({ seq, ok: true, connect_ms: r1(performance.now() - t0), remote_address: sock.remoteAddress ?? null, error_code: null }));
    sock.once('error', (e: NodeJS.ErrnoException) => finish({ seq, ok: false, connect_ms: null, remote_address: null, error_code: e.code ?? e.message }));
  });
}

export interface HttpProbe {
  kind: 'http';
  url: string;
  ok: boolean;
  status_code: number | null;
  latency_ms: number | null;
  body_excerpt: string | null;
  error_code: string | null;
  at: string;
}

/** HTTP GET probe without proxies (local/internal targets), body excerpt capped. */
export function httpProbe(url: string, timeoutMs: number): Promise<HttpProbe> {
  const at = new Date().toISOString();
  return new Promise((resolve) => {
    const t0 = performance.now();
    const u = new URL(url);
    // URL keeps IPv6 literals bracketed ([::1]); node:http would resolve "[::1]" as a name (ENOTFOUND)
    const req = httpRequest({ hostname: u.hostname.replace(/^\[(.*)\]$/, '$1'), port: u.port || 80, path: `${u.pathname}${u.search}`, method: 'GET', headers: { 'user-agent': 'workctl-probe' } }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        if (size < 2048) chunks.push(c);
        size += c.length;
      });
      res.on('end', () => {
        const code = res.statusCode ?? 0;
        resolve({
          kind: 'http',
          url,
          ok: code >= 200 && code < 300,
          status_code: code,
          latency_ms: r1(performance.now() - t0),
          body_excerpt: Buffer.concat(chunks).toString('utf8').slice(0, 200),
          error_code: null,
          at,
        });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (e: NodeJS.ErrnoException) =>
      resolve({ kind: 'http', url, ok: false, status_code: null, latency_ms: null, body_excerpt: null, error_code: e.code ?? e.message, at }),
    );
    req.end();
  });
}

/** Parses `host:port`, `[v6]:port`. */
export function parseTarget(target: string): { host: string; port: number } {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(target) ?? /^([^:\s]+):(\d+)$/.exec(target);
  if (!m) throw new WorkError('INVALID_ARGUMENT', `目标格式应为 host:port: ${target}`, { hint: '如 127.0.0.1:13306、demo-mysql.internal:3306、[::1]:6379' });
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new WorkError('INVALID_ARGUMENT', `端口不合法: ${m[2]}`);
  return { host: m[1], port };
}

export function latencySummary(samples: { ok: boolean; connect_ms: number | null }[]) {
  const ok = samples.filter((s) => s.ok && s.connect_ms !== null).map((s) => s.connect_ms as number);
  return {
    sent: samples.length,
    succeeded: ok.length,
    failed: samples.length - ok.length,
    loss_pct: samples.length ? r1(((samples.length - ok.length) / samples.length) * 100) : 0,
    min_ms: ok.length ? Math.min(...ok) : null,
    avg_ms: ok.length ? r1(ok.reduce((a, b) => a + b, 0) / ok.length) : null,
    max_ms: ok.length ? Math.max(...ok) : null,
  };
}
