import { request as httpRequest } from 'node:http';
import { httpJson, rawRequest, safeUrl } from '../../core/http';
import { source, WorkError, type Source } from '../../core/output';
import type { Ctx } from '../../core/runtime';

/**
 * Docker Engine API client shared by the container, storage, network and
 * observability domains. Talks to the daemon over the unix socket (endpoint
 * `docker.<name>.socket`) or over plain HTTP (`docker.<name>.url`).
 */
export const DOCKER_ADAPTER = 'docker-engine-api';

export interface DockerVersion {
  Version: string;
  ApiVersion: string;
  Os?: string;
  Arch?: string;
  KernelVersion?: string;
}

export class DockerClient {
  private versionPromise?: Promise<DockerVersion>;

  constructor(
    readonly endpointId: string,
    readonly socketPath: string | undefined,
    readonly baseUrl: string,
    private readonly ctx: Ctx | null,
  ) {}

  url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  async get<T = unknown>(path: string, opts: { allowStatus?: number[]; timeoutMs?: number } = {}): Promise<{ status: number; body: T; text: string }> {
    try {
      const r = await httpJson<T>(this.ctx, this.url(path), { socketPath: this.socketPath, allowStatus: opts.allowStatus, timeoutMs: opts.timeoutMs });
      return { status: r.status, body: r.body, text: r.text };
    } catch (e) {
      throw mapDockerError(e, this);
    }
  }

  async getJson<T = unknown>(path: string): Promise<T> {
    const r = await this.get<T>(path);
    if (typeof r.body === 'string') {
      try {
        return JSON.parse(r.body) as T;
      } catch {
        throw new WorkError('UPSTREAM_UNAVAILABLE', `Docker 返回了非 JSON 响应 (${path.split('?')[0]})`);
      }
    }
    return r.body;
  }

  async post(path: string, opts: { timeoutMs?: number; allowStatus?: number[] } = {}): Promise<{ status: number; text: string }> {
    try {
      const r = await httpJson(this.ctx, this.url(path), { method: 'POST', socketPath: this.socketPath, timeoutMs: opts.timeoutMs, allowStatus: opts.allowStatus });
      return { status: r.status, text: r.text };
    } catch (e) {
      throw mapDockerError(e, this);
    }
  }

  /** Binary-safe GET (used for multiplexed log streams). */
  async getBuffer(path: string, timeoutMs?: number): Promise<{ status: number; buffer: Buffer; headers: Record<string, unknown> }> {
    try {
      const r = await rawRequest(this.url(path), {
        method: 'GET',
        headers: {},
        socketPath: this.socketPath,
        timeoutMs: timeoutMs ?? this.ctx?.remainingMs() ?? 30_000,
      });
      return { status: r.status, buffer: r.buffer, headers: r.headers };
    } catch (e) {
      throw mapDockerError(e, this);
    }
  }

  /**
   * Streaming GET: calls onChunk for every chunk as it arrives so large log
   * windows can be filtered without buffering the whole response.
   */
  stream(path: string, onChunk: (b: Buffer) => void, timeoutMs?: number): Promise<{ status: number; errorBody?: string }> {
    const u = new URL(this.url(path));
    const budget = timeoutMs ?? this.ctx?.remainingMs() ?? 30_000;
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          method: 'GET',
          ...(this.socketPath ? { socketPath: this.socketPath } : { hostname: u.hostname, port: u.port || 80 }),
          path: `${u.pathname}${u.search}`,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 400) {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve({ status, errorBody: Buffer.concat(chunks).toString('utf8') }));
            return;
          }
          res.on('data', (c: Buffer) => {
            try {
              onChunk(c);
            } catch (err) {
              req.destroy(err as Error);
            }
          });
          res.on('end', () => resolve({ status }));
          res.on('error', reject);
        },
      );
      req.setTimeout(budget, () => req.destroy(Object.assign(new Error(`timeout after ${budget}ms`), { name: 'TimeoutError' })));
      req.on('error', (e) => reject(mapDockerError(e, this)));
      req.end();
    });
  }

  version(): Promise<DockerVersion> {
    this.versionPromise ??= this.getJson<DockerVersion>('/version');
    return this.versionPromise;
  }

  /** Provenance record for a Docker API call; `version` is the daemon's actual version. */
  async source(method: string, relation: Source['relation'] = 'explicit'): Promise<Source> {
    let version: string | undefined;
    try {
      const v = await this.version();
      version = `${v.Version} (API ${v.ApiVersion})`;
    } catch {
      version = undefined;
    }
    return source('docker', DOCKER_ADAPTER, { endpoint: this.endpointId, method, relation, ...(version ? { version } : {}) });
  }
}

const clients = new WeakMap<Ctx, DockerClient>();

export function dockerClient(ctx: Ctx, name?: string): DockerClient {
  const cached = clients.get(ctx);
  if (cached && !name) return cached;
  const ep = ctx.endpoint('docker', name);
  // relative to the config file (as doctor checks it), not to the caller's working directory
  const socket = ep.path('socket');
  const url = ep.str('url');
  if (!socket && !url) {
    throw new WorkError('NOT_CONFIGURED', `端点 ${ep.id} 需要配置 socket（如 /var/run/docker.sock）或 url`);
  }
  const client = socket
    ? new DockerClient(`${ep.id} (unix:${socket})`, socket, 'http://docker.local', ctx)
    : new DockerClient(`${ep.id} (${safeUrl(url!)})`, undefined, url!.replace(/\/$/, ''), ctx);
  if (!name) clients.set(ctx, client);
  return client;
}

export function mapDockerError(e: unknown, c: Pick<DockerClient, 'endpointId'>): WorkError {
  if (e instanceof WorkError) {
    if (e.code === 'NOT_FOUND' || e.code === 'INVALID_ARGUMENT' || e.code === 'CONFLICT') {
      const body = e.details?.body as { message?: string } | string | undefined;
      const msg = typeof body === 'object' && body?.message ? body.message : undefined;
      if (msg) return new WorkError(e.code, `Docker: ${msg}`, { details: e.details });
    }
    return e;
  }
  const err = e as NodeJS.ErrnoException;
  const code = err?.code;
  if (code === 'ENOENT' || code === 'ECONNREFUSED') {
    return new WorkError('UPSTREAM_UNAVAILABLE', `Docker 守护进程不可达 (${code}, ${c.endpointId})`, {
      hint: '确认 Docker 已启动、socket 路径正确（endpoints.docker.<name>.socket）',
    });
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new WorkError('PERMISSION_DENIED', `无权访问 Docker socket (${c.endpointId})`, {
      hint: '当前用户需要 docker 组权限或使用只读代理；workctl 不会提权',
    });
  }
  if (err?.name === 'TimeoutError') return new WorkError('TIMEOUT', `Docker API 调用超时 (${c.endpointId})`, { hint: '增大 --timeout 或缩小窗口' });
  return new WorkError('UPSTREAM_UNAVAILABLE', `Docker API 调用失败: ${err?.message ?? String(e)}`, { details: { code } });
}

export function filtersParam(filters: Record<string, string[]>): string {
  return encodeURIComponent(JSON.stringify(filters));
}

// ---------------------------------------------------------------------------
// Docker API shapes (only the fields we read)
// ---------------------------------------------------------------------------
export interface ContainerSummary {
  Id: string;
  Names: string[];
  Image: string;
  ImageID: string;
  Created: number;
  State: string;
  Status: string;
  Labels: Record<string, string> | null;
  Ports: { IP?: string; PrivatePort: number; PublicPort?: number; Type: string }[];
}

export interface ContainerInspect {
  Id: string;
  Name: string;
  Created: string;
  Image: string;
  RestartCount: number;
  State: {
    Status: string;
    Running: boolean;
    Paused: boolean;
    Restarting: boolean;
    OOMKilled: boolean;
    Dead: boolean;
    Pid: number;
    ExitCode: number;
    Error: string;
    StartedAt: string;
    FinishedAt: string;
    Health?: { Status: string; FailingStreak: number; Log?: { Start: string; End: string; ExitCode: number; Output: string }[] };
  };
  Config: { Image: string; Labels: Record<string, string> | null; Tty: boolean; Healthcheck?: { Test?: string[] } };
  HostConfig: {
    NanoCpus?: number;
    CpuQuota?: number;
    CpuPeriod?: number;
    CpuShares?: number;
    Memory?: number;
    MemoryReservation?: number;
    PidsLimit?: number | null;
    RestartPolicy?: { Name: string; MaximumRetryCount?: number };
    LogConfig?: { Type: string; Config?: Record<string, string> };
  };
  NetworkSettings: {
    Ports?: Record<string, { HostIp: string; HostPort: string }[] | null>;
    Networks?: Record<string, { IPAddress?: string; Aliases?: string[] | null }>;
  };
  Mounts?: { Type: string; Name?: string; Source: string; Destination: string; RW: boolean }[];
}

export const ZERO_TIME = '0001-01-01T00:00:00Z';

export function dockerTime(t: string | undefined | null): string | null {
  if (!t || t.startsWith('0001-01-01')) return null;
  return t;
}

export function shortId(id: string): string {
  return id.replace(/^sha256:/, '').slice(0, 12);
}

export function containerName(c: { Names?: string[]; Name?: string }): string {
  const n = c.Name ?? c.Names?.[0] ?? '';
  return n.replace(/^\//, '');
}

/** CPU limit in cores from NanoCpus or CpuQuota/CpuPeriod; null = unlimited. */
export function cpuLimit(h: ContainerInspect['HostConfig']): number | null {
  if (h.NanoCpus && h.NanoCpus > 0) return h.NanoCpus / 1e9;
  if (h.CpuQuota && h.CpuQuota > 0) return h.CpuQuota / (h.CpuPeriod && h.CpuPeriod > 0 ? h.CpuPeriod : 100_000);
  return null;
}
