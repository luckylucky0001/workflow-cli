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
  /** Response body cap in bytes (default DEFAULT_MAX_RESPONSE_BYTES); see `overflow`. */
  maxBytes?: number;
  /**
   * What to do when the body exceeds `maxBytes`: `error` (default) aborts the read with
   * DATA_UNAVAILABLE; `tail` keeps only the last `maxBytes` bytes (log reads) and sets `truncated`.
   */
  overflow?: 'error' | 'tail';
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: T;
  text: string;
  /** overflow=tail only: the body was larger than maxBytes and only its tail was kept. */
  truncated?: boolean;
  /** Bytes received from the wire (≥ text length when truncated). */
  bytes?: number;
}

/** Default cap on a response body held in memory (16 MiB). */
export const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export function responseTooLarge(url: string, maxBytes: number, contentLength?: number): WorkError {
  return new WorkError('DATA_UNAVAILABLE', `目标系统响应超过 ${maxBytes} 字节上限，已中止读取 (${safeUrl(url)})`, {
    hint: '缩小查询范围（更短的时间窗口、更小的 limit、更具体的过滤条件）后重试',
    details: { reason: 'response_too_large', max_bytes: maxBytes, ...(contentLength !== undefined ? { content_length: contentLength } : {}) },
  });
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
  const res = await rawRequest(url, { method: opts.method ?? 'GET', headers, body: payload, socketPath: opts.socketPath, timeoutMs, maxBytes: opts.maxBytes, overflow: opts.overflow });
  let body: unknown = res.text;
  if (res.text && /json/.test(String(res.headers['content-type'] ?? '')) ) {
    try {
      body = JSON.parse(res.text);
    } catch {
      body = res.text;
    }
  }
  const out: HttpResponse<T> = { status: res.status, headers: res.headers, body: body as T, text: res.text, bytes: res.bytes, ...(res.truncated ? { truncated: true } : {}) };
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

/**
 * Accumulates a response body with a byte cap: `error` rejects once the cap is passed, `tail`
 * keeps only the last `max` bytes (memory stays bounded either way).
 */
class BodySink {
  private chunks: Buffer[] = [];
  private held = 0;
  bytes = 0;
  truncated = false;
  constructor(
    private readonly max: number,
    private readonly overflow: 'error' | 'tail',
  ) {}
  /** false = cap exceeded in error mode: stop reading. */
  push(c: Buffer): boolean {
    this.bytes += c.length;
    if (this.overflow === 'error' && this.bytes > this.max) return false;
    this.chunks.push(c);
    this.held += c.length;
    while (this.overflow === 'tail' && this.held > this.max) {
      this.truncated = true;
      const extra = this.held - this.max;
      const head = this.chunks[0];
      if (head.length <= extra) {
        this.chunks.shift();
        this.held -= head.length;
      } else {
        this.chunks[0] = head.subarray(extra);
        this.held -= extra;
      }
    }
    return true;
  }
  buffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  buffer: Buffer;
  /** Bytes received; > buffer.length when overflow=tail dropped the head. */
  bytes: number;
  truncated: boolean;
}

export function rawRequest(
  url: string,
  o: { method: string; headers: Record<string, string>; body?: string | Buffer; socketPath?: string; timeoutMs: number; maxBytes?: number; overflow?: 'error' | 'tail' },
): Promise<RawResponse> {
  const max = o.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const overflow = o.overflow ?? 'error';
  const sink = new BodySink(max, overflow);
  const done = (status: number, headers: RawResponse['headers']): RawResponse => {
    const buffer = sink.buffer();
    return { status, headers, text: buffer.toString('utf8'), buffer, bytes: sink.bytes, truncated: sink.truncated };
  };
  const declared = (v: unknown): number | undefined => {
    const n = Number(Array.isArray(v) ? v[0] : v);
    return v !== undefined && v !== null && v !== '' && Number.isFinite(n) ? n : undefined;
  };
  // node:http for socket support (Docker) and to avoid global proxy settings for local endpoints.
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol === 'https:') {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(Object.assign(new Error(`timeout after ${o.timeoutMs}ms`), { name: 'TimeoutError' })), o.timeoutMs);
      fetch(url, { method: o.method, headers: o.headers, body: typeof o.body === "string" || o.body === undefined ? o.body : new Uint8Array(o.body), signal: ac.signal })
        .then(async (r) => {
          const headers = Object.fromEntries(r.headers.entries());
          const cl = declared(headers['content-length']);
          if (overflow === 'error' && cl !== undefined && cl > max) {
            ac.abort();
            throw responseTooLarge(url, max, cl);
          }
          if (r.body) {
            const reader = r.body.getReader();
            for (;;) {
              const { done: end, value } = await reader.read();
              if (end) break;
              if (!sink.push(Buffer.from(value))) {
                await reader.cancel().catch(() => undefined);
                throw responseTooLarge(url, max);
              }
            }
          }
          resolve(done(r.status, headers));
        })
        .catch((e) => reject(e?.name === 'AbortError' && ac.signal.reason instanceof Error ? ac.signal.reason : e))
        .finally(() => clearTimeout(timer));
      return;
    }
    const req = httpRequest(
      {
        method: o.method,
        headers: o.body ? { ...o.headers, 'content-length': String(Buffer.byteLength(o.body)) } : o.headers,
        ...(o.socketPath ? { socketPath: o.socketPath, path: `${u.pathname}${u.search}` } : { hostname: u.hostname.replace(/^\[(.*)\]$/, '$1'), port: u.port || 80, path: `${u.pathname}${u.search}` }),
        ...(u.username ? { auth: `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}` } : {}),
      },
      (res) => {
        const cl = declared(res.headers['content-length']);
        if (overflow === 'error' && cl !== undefined && cl > max) {
          req.destroy();
          reject(responseTooLarge(url, max, cl));
          return;
        }
        res.on('data', (c: Buffer) => {
          if (!sink.push(c)) {
            req.destroy();
            reject(responseTooLarge(url, max));
          }
        });
        res.on('end', () => resolve(done(res.statusCode ?? 0, res.headers)));
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
