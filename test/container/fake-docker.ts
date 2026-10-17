/**
 * Minimal fake Docker Engine API on a unix socket, for unit tests of the container,
 * network, storage and observability domains. Only the endpoints workctl uses.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FakeContainer {
  Id: string;
  Name: string;
  Labels: Record<string, string>;
  State: string;
  Image?: string;
  StartedAt?: string;
  NanoCpus?: number;
  Memory?: number;
  Ports?: { IP?: string; PrivatePort: number; PublicPort?: number; Type: string }[];
  Health?: string;
  RestartCount?: number;
  OOMKilled?: boolean;
  ExitCode?: number;
  LogDriver?: string;
  Tty?: boolean;
  Created?: string;
  /** Log lines (content without timestamp); ts defaults to now. */
  logs?: { stream: 'stdout' | 'stderr'; line: string; ts?: string }[];
  stats?: Record<string, unknown>;
}

export interface FakeDockerState {
  containers: FakeContainer[];
  events?: Record<string, unknown>[];
  volumes?: { Name: string; Driver: string; Mountpoint: string; Labels?: Record<string, string>; Scope?: string; Size?: number; RefCount?: number }[];
  /** When set, POST /restart leaves the container in this state (simulate a failed restart). */
  restartResultState?: string;
  /** Called after POST /restart has updated the container (e.g. schedule a crash shortly after start). */
  onRestart?: (c: FakeContainer) => void;
}

export function frame(stream: 'stdout' | 'stderr', text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const h = Buffer.alloc(8);
  h[0] = stream === 'stderr' ? 2 : 1;
  h.writeUInt32BE(payload.length, 4);
  return Buffer.concat([h, payload]);
}

function inspectOf(c: FakeContainer) {
  return {
    Id: c.Id,
    Name: `/${c.Name}`,
    Created: c.Created ?? '2026-10-17T10:00:00.000000000Z',
    Image: `sha256:${'a'.repeat(64)}`,
    RestartCount: c.RestartCount ?? 0,
    State: {
      Status: c.State,
      Running: c.State === 'running',
      Paused: false,
      Restarting: false,
      OOMKilled: c.OOMKilled ?? false,
      Dead: false,
      Pid: c.State === 'running' ? 1234 : 0,
      ExitCode: c.ExitCode ?? 0,
      Error: '',
      StartedAt: c.StartedAt ?? '2026-10-17T10:00:01.000000000Z',
      FinishedAt: '0001-01-01T00:00:00Z',
      ...(c.Health ? { Health: { Status: c.Health, FailingStreak: 0, Log: [] } } : {}),
    },
    Config: { Image: c.Image ?? 'demo/image:1', Labels: c.Labels, Tty: c.Tty ?? false, ...(c.Health ? { Healthcheck: { Test: ['CMD', 'true'] } } : {}) },
    HostConfig: {
      NanoCpus: c.NanoCpus ?? 0,
      Memory: c.Memory ?? 0,
      RestartPolicy: { Name: 'no' },
      LogConfig: { Type: c.LogDriver ?? 'json-file', Config: {} },
    },
    NetworkSettings: {
      Ports: Object.fromEntries((c.Ports ?? []).map((p) => [`${p.PrivatePort}/${p.Type}`, p.PublicPort ? [{ HostIp: p.IP ?? '0.0.0.0', HostPort: String(p.PublicPort) }] : null])),
      Networks: { demo_default: { IPAddress: '172.18.0.9', Aliases: [c.Name] } },
    },
    Mounts: [],
  };
}

function labelMatch(c: FakeContainer, filters: Record<string, string[]>): boolean {
  for (const l of filters.label ?? []) {
    const [k, v] = l.split('=');
    if (v === undefined ? !(k in c.Labels) : c.Labels[k] !== v) return false;
  }
  return true;
}

export async function startFakeDocker(state: FakeDockerState): Promise<{ socketPath: string; dir: string; calls: string[]; close: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'workctl-fake-docker-'));
  const socketPath = join(dir, 'docker.sock');
  const calls: string[] = [];
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://docker');
    calls.push(`${req.method} ${u.pathname}${u.search}`);
    const json = (code: number, body: unknown, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const find = (id: string) => state.containers.find((c) => c.Id === id || c.Id.startsWith(id) || c.Name === id);
    let m: RegExpExecArray | null;
    if (u.pathname === '/version') return json(200, { Version: '99.0.0-fake', ApiVersion: '1.99', Os: 'linux', Arch: 'amd64' });
    if (u.pathname === '/info') return json(200, { NCPU: 4, MemTotal: 8 * 1024 ** 3, ServerVersion: '99.0.0-fake', Name: 'fakehost', CgroupVersion: '2' });
    if (u.pathname === '/containers/json') {
      const filters = JSON.parse(u.searchParams.get('filters') ?? '{}') as Record<string, string[]>;
      const list = state.containers
        .filter((c) => labelMatch(c, filters))
        .filter((c) => !filters.volume || (state.volumes ?? []).some((v) => filters.volume.includes(v.Name) && c.Labels['uses.volume'] === v.Name))
        .map((c) => ({ Id: c.Id, Names: [`/${c.Name}`], Image: c.Image ?? 'demo/image:1', ImageID: 'sha256:abc', Created: 0, State: c.State, Status: c.State, Labels: c.Labels, Ports: c.Ports ?? [] }));
      return json(200, list);
    }
    if ((m = /^\/containers\/([^/]+)\/json$/.exec(u.pathname))) {
      const c = find(m[1]);
      return c ? json(200, inspectOf(c)) : json(404, { message: `No such container: ${m[1]}` });
    }
    if ((m = /^\/containers\/([^/]+)\/stats$/.exec(u.pathname))) {
      const c = find(m[1]);
      return c ? json(200, c.stats ?? {}) : json(404, { message: 'No such container' });
    }
    if ((m = /^\/containers\/([^/]+)\/restart$/.exec(u.pathname)) && req.method === 'POST') {
      const c = find(m[1]);
      if (!c) return json(404, { message: 'No such container' });
      c.State = state.restartResultState ?? 'running';
      c.StartedAt = new Date().toISOString();
      state.onRestart?.(c);
      res.writeHead(204);
      return res.end();
    }
    if ((m = /^\/containers\/([^/]+)\/logs$/.exec(u.pathname))) {
      const c = find(m[1]);
      if (!c) return json(404, { message: 'No such container' });
      if (c.LogDriver === 'none') return json(501, { message: 'configured logging driver does not support reading' });
      res.writeHead(200, { 'content-type': c.Tty ? 'application/vnd.docker.raw-stream' : 'application/vnd.docker.multiplexed-stream' });
      const now = new Date().toISOString();
      // write frame by frame, deliberately splitting one frame across two writes
      for (const l of c.logs ?? []) {
        const text = `${l.ts ?? now} ${l.line}\n`;
        const buf = c.Tty ? Buffer.from(text) : frame(l.stream, text);
        const cut = Math.min(5, buf.length);
        res.write(buf.subarray(0, cut));
        res.write(buf.subarray(cut));
      }
      return res.end();
    }
    if (u.pathname === '/events') {
      return json(200, (state.events ?? []).map((e) => JSON.stringify(e)).join('\n') + '\n', 'application/jsonl');
    }
    if (u.pathname === '/volumes') return json(200, { Volumes: state.volumes ?? [] });
    if ((m = /^\/volumes\/([^/]+)$/.exec(u.pathname))) {
      const v = (state.volumes ?? []).find((x) => x.Name === decodeURIComponent(m![1]));
      return v
        ? json(200, { Name: v.Name, Driver: v.Driver, Mountpoint: v.Mountpoint, Labels: v.Labels ?? null, Scope: v.Scope ?? 'local', Options: null, CreatedAt: '2026-10-17T10:00:00Z' })
        : json(404, { message: `get ${m[1]}: no such volume` });
    }
    if (u.pathname === '/system/df') {
      return json(200, { Volumes: (state.volumes ?? []).map((v) => ({ Name: v.Name, UsageData: { Size: v.Size ?? -1, RefCount: v.RefCount ?? -1 } })) });
    }
    json(404, { message: `fake docker: unknown path ${u.pathname}` });
  });
  await new Promise<void>((r) => server.listen(socketPath, r));
  return {
    socketPath,
    dir,
    calls,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Writes a workctl config + bindings into `dir` and returns the config path. */
export function writeTestConfig(dir: string, opts: { socketPath?: string; promUrl?: string; allowExecute?: boolean; metrics?: Record<string, unknown> } = {}): string {
  const bindings = `schema_version: "1.0"
resources:
  - id: demo-order
    type: service
    env: sandbox
    attributes: { http_port: ${opts.promUrl ? 1 : 18081}, health_path: /healthz, container_label: "workctl.service=demo-order" }
  - id: demo-mysql
    type: mysql.instance
    env: sandbox
relations:
  - { from: demo-order, to: demo-mysql, type: depends_on, source: service-config, evidence: "env MYSQL_HOST" }
  - { from: demo-prometheus, to: demo-order, type: consumes, source: binding-file }
`;
  writeFileSync(join(dir, 'bindings.yaml'), bindings);
  const metrics = opts.metrics ?? {
    request_latency: { description: 'p95', query: 'histogram_quantile(0.95, sum by (le) (rate(x_bucket{service="$service"}[1m])))', unit: 'seconds' },
  };
  const cfg = {
    schema_version: '1.0',
    current_profile: 't',
    profiles: {
      t: {
        env: 'sandbox',
        allow_execute: opts.allowExecute ?? true,
        resources_file: './bindings.yaml',
        state_dir: './state',
        endpoints: {
          ...(opts.socketPath ? { docker: { local: { socket: opts.socketPath } } } : {}),
          ...(opts.promUrl ? { prometheus: { p: { url: opts.promUrl, metrics } } } : {}),
        },
      },
    },
  };
  const path = join(dir, 'workctl.yaml');
  writeFileSync(path, JSON.stringify(cfg));
  return path;
}
