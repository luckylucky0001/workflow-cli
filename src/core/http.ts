import { request as httpRequest } from 'node:http';
import { WorkError } from './output';
import type { Ctx } from './runtime';

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Unix socket path (Docker Engine API). */
  socketPath?: string;
  /** Treat these statuses as non-errors and return them to the caller. */
  allowStatus?: number[];
  timeoutMs?: number;
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: T;
  text: string;
}

/**
 * Shared HTTP client: time budget from ctx, uniform mapping of status codes to
 * stable error codes. Adapters add system-specific interpretation on top.
 */
export async function httpJson<T = unknown>(ctx: Ctx | null, url: string, opts: HttpOptions = {}): Promise<HttpResponse<T>> {
  const timeoutMs = opts.timeoutMs ?? ctx?.remainingMs() ?? 30_000;
  const headers: Record<string, string> = { accept: 'application/json', ...(opts.headers ?? {}) };
  let payload: string | undefined;
  if (opts.body !== undefined) {
    payload = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    headers['content-type'] ??= 'application/json';
  }
  const res = await rawRequest(url, { method: opts.method ?? 'GET', headers, body: payload, socketPath: opts.socketPath, timeoutMs });
  let body: unknown = res.text;
  if (res.text && /json/.test(String(res.headers['content-type'] ?? '')) ) {
    try {
      body = JSON.parse(res.text);
    } catch {
      body = res.text;
    }
  }
  const out: HttpResponse<T> = { status: res.status, headers: res.headers, body: body as T, text: res.text };
  if (res.status >= 400 && !(opts.allowStatus ?? []).includes(res.status)) {
    throw httpError(url, res.status, body);
  }
  return out;
}

export function httpError(url: string, status: number, body: unknown): WorkError {
  const detail = typeof body === 'string' ? body.slice(0, 500) : body;
  const where = safeUrl(url);
  if (status === 401) return new WorkError('UNAUTHENTICATED', `认证失败 (${where})`, { details: { status, body: detail } });
  if (status === 403) return new WorkError('PERMISSION_DENIED', `目标系统拒绝访问 (${where})`, { details: { status, body: detail } });
  if (status === 404) return new WorkError('NOT_FOUND', `目标对象不存在 (${where})`, { details: { status, body: detail } });
  if (status === 409) return new WorkError('CONFLICT', `目标系统报告状态冲突 (${where})`, { details: { status, body: detail } });
  if (status === 400 || status === 422) return new WorkError('INVALID_ARGUMENT', `目标系统拒绝请求参数 (${where})`, { details: { status, body: detail } });
  return new WorkError('UPSTREAM_UNAVAILABLE', `目标系统返回 HTTP ${status} (${where})`, { details: { status, body: detail } });
}

/** Strip credentials and query string for provenance/error messages. */
export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split('?')[0];
  }
}

export function rawRequest(
  url: string,
  o: { method: string; headers: Record<string, string>; body?: string | Buffer; socketPath?: string; timeoutMs: number },
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string; buffer: Buffer }> {
  // node:http for socket support (Docker) and to avoid global proxy settings for local endpoints.
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol === 'https:') {
      fetch(url, { method: o.method, headers: o.headers, body: typeof o.body === "string" || o.body === undefined ? o.body : new Uint8Array(o.body), signal: AbortSignal.timeout(o.timeoutMs) })
        .then(async (r) => {
          const buffer = Buffer.from(await r.arrayBuffer());
          resolve({ status: r.status, headers: Object.fromEntries(r.headers.entries()), text: buffer.toString('utf8'), buffer });
        })
        .catch(reject);
      return;
    }
    const req = httpRequest(
      {
        method: o.method,
        headers: o.body ? { ...o.headers, 'content-length': String(Buffer.byteLength(o.body)) } : o.headers,
        ...(o.socketPath ? { socketPath: o.socketPath, path: `${u.pathname}${u.search}` } : { hostname: u.hostname, port: u.port || 80, path: `${u.pathname}${u.search}` }),
        ...(u.username ? { auth: `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}` } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text: buffer.toString('utf8'), buffer });
        });
        res.on('error', reject);
      },
    );
    req.setTimeout(o.timeoutMs, () => req.destroy(Object.assign(new Error(`timeout after ${o.timeoutMs}ms`), { name: 'TimeoutError' })));
    req.on('error', reject);
    if (o.body) req.write(o.body);
    req.end();
  });
}

export function basicAuth(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}
