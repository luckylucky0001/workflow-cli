import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import { z } from 'zod';
import { source, WorkError, type Result } from '../../core/output';
import { defineCapability, defineDomain } from '../../core/registry';
import { sleep } from '../../core/runtime';
import { containerName, dockerClient } from '../container/docker';
import { listServiceContainers, resolveEnv, selectionNotes } from '../container/workload';
import { httpProbe, latencySummary, parseTarget, tcpConnect, type TcpSample } from './probe';

const GUIDE = 'docs/guides/infrastructure.md';

// ---------------------------------------------------------------------------
// network dns get
// ---------------------------------------------------------------------------
const QueryResult = z.object({
  status: z.enum(['ok', 'nodata', 'nxdomain', 'error']),
  records: z.array(z.object({ value: z.string(), ttl: z.number().nullable() })),
  error_code: z.string().nullable(),
  duration_ms: z.number(),
});
type QueryResultT = z.infer<typeof QueryResult>;

function dnsStatus(code: string | undefined): QueryResultT['status'] {
  if (code === 'ENODATA') return 'nodata';
  if (code === 'ENOTFOUND') return 'nxdomain';
  return 'error';
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: NodeJS.ErrnoException; ms: number }> {
  const t0 = performance.now();
  try {
    const value = await fn();
    return { value, ms: Math.round((performance.now() - t0) * 10) / 10 };
  } catch (e) {
    return { error: e as NodeJS.ErrnoException, ms: Math.round((performance.now() - t0) * 10) / 10 };
  }
}

const dnsGet = defineCapability({
  name: 'network.dns.get',
  command: 'network dns get',
  domain: 'network',
  summary: '用系统解析器解析域名：getaddrinfo 结果（含 hosts 文件）与 DNS A/AAAA/CNAME 记录',
  inputs: { name: { type: 'string', required: true, description: '要解析的主机名' } },
  output: z.object({
    name: z.string(),
    resolver: z.literal('system'),
    nameservers: z.array(z.string()),
    lookup: z.object({
      status: z.enum(['ok', 'nxdomain', 'error']),
      addresses: z.array(z.object({ address: z.string(), family: z.number() })),
      error_code: z.string().nullable(),
      duration_ms: z.number(),
    }),
    records: z.object({ A: QueryResult, AAAA: QueryResult, CNAME: QueryResult }),
    resolved: z.boolean(),
  }),
  adapter: 'node-dns',
  operation: 'read',
  auth_provider: 'none',
  guide: GUIDE,
  notes: [
    'lookup 走 getaddrinfo（与应用进程一致，含 /etc/hosts）；records 直接询问系统配置的 nameserver',
    '结果反映运行 workctl 的主机视角；容器内/其他网络的解析结果可能不同',
  ],
  examples: ['workctl network dns get --name localhost'],
  handler: async (_ctx, i): Promise<Result> => {
    const name = String(i.name).trim();
    if (!/^[A-Za-z0-9._-]{1,253}$/.test(name)) throw new WorkError('INVALID_ARGUMENT', `主机名不合法: ${name}`);
    const resolver = new dns.Resolver({ timeout: 2000, tries: 2 });
    const nameservers = resolver.getServers();
    const lk = await timed(() => dns.lookup(name, { all: true }));
    const q = async (fn: () => Promise<{ value: string; ttl: number | null }[]>): Promise<QueryResultT> => {
      const r = await timed(fn);
      if (r.error) return { status: dnsStatus(r.error.code), records: [], error_code: r.error.code ?? r.error.message, duration_ms: r.ms };
      return { status: r.value!.length ? 'ok' : 'nodata', records: r.value!, error_code: null, duration_ms: r.ms };
    };
    const [a, aaaa, cname] = await Promise.all([
      q(async () => (await resolver.resolve4(name, { ttl: true })).map((x) => ({ value: x.address, ttl: x.ttl }))),
      q(async () => (await resolver.resolve6(name, { ttl: true })).map((x) => ({ value: x.address, ttl: x.ttl }))),
      q(async () => (await resolver.resolveCname(name)).map((x) => ({ value: x, ttl: null }))),
    ]);
    const lookup = lk.error
      ? { status: (lk.error.code === 'ENOTFOUND' ? 'nxdomain' : 'error') as 'nxdomain' | 'error', addresses: [], error_code: lk.error.code ?? lk.error.message, duration_ms: lk.ms }
      : { status: 'ok' as const, addresses: lk.value!.map((x) => ({ address: x.address, family: x.family })), error_code: null, duration_ms: lk.ms };
    const notes: string[] = [];
    if (lookup.status === 'ok' && a.status !== 'ok' && aaaa.status !== 'ok') notes.push('getaddrinfo 能解析但 DNS 无记录：结果可能来自 /etc/hosts 或本地解析配置');
    const dnsErrors = [a, aaaa, cname].filter((x) => x.status === 'error');
    return {
      status: dnsErrors.length === 3 && lookup.status !== 'ok' ? 'partial' : 'success',
      data: { name, resolver: 'system', nameservers, lookup, records: { A: a, AAAA: aaaa, CNAME: cname }, resolved: lookup.status === 'ok' || a.status === 'ok' || aaaa.status === 'ok' },
      sources: [
        source('dns', 'node-dns', { method: 'getaddrinfo (dns.lookup all=true)', relation: 'explicit', endpoint: 'system resolver' }),
        source('dns', 'node-dns', { method: 'resolve4/resolve6/resolveCname', relation: 'explicit', endpoint: `nameservers ${nameservers.join(',') || '(none)'}` }),
      ],
      coverage: { complete: dnsErrors.length === 0, scope: '运行 workctl 的主机上的系统解析器', notes },
    };
  },
});

// ---------------------------------------------------------------------------
// network backend list
// ---------------------------------------------------------------------------
const OriginSchema = z.object({ origin: z.enum(['binding-file', 'docker-published-port']), evidence: z.string() });
const BackendSchema = z.object({
  address: z.string(),
  host: z.string(),
  port: z.number(),
  origins: z.array(OriginSchema),
  container: z.string().nullable(),
  probe: z.object({
    kind: z.enum(['http', 'tcp']),
    target: z.string(),
    ok: z.boolean(),
    status_code: z.number().nullable(),
    latency_ms: z.number().nullable(),
    body_excerpt: z.string().nullable(),
    error_code: z.string().nullable(),
    at: z.string(),
  }),
});

const backendList = defineCapability({
  name: 'network.backend.list',
  command: 'network backend list',
  domain: 'network',
  summary: '列出服务的访问后端（资源绑定 + 容器发布端口）并逐个做健康探测',
  inputs: {
    service: { type: 'string', required: true, description: '服务 ID' },
    env: { type: 'string', description: '环境；默认取 profile 的 env' },
    timeout_ms: { type: 'int', default: 2000, description: '单次探测超时（毫秒）' },
  },
  output: z.object({
    service: z.string(),
    env: z.string().nullable(),
    health_path: z.string().nullable(),
    backends: z.array(BackendSchema),
    summary: z.object({ total: z.number(), healthy: z.number(), unhealthy: z.number() }),
  }),
  adapter: 'docker-engine-api + http-probe',
  operation: 'diagnose',
  auth_provider: 'docker-socket',
  guide: GUIDE,
  prerequisites: ['资源绑定中服务的 http_port / health_path 属性，或带 workctl.service 标签且发布了端口的容器'],
  notes: [
    '探测结果（probe）是 workctl 所在主机此刻的真实请求结果，不代表其他网络位置的可达性',
    '绑定只给端口时按本机 127.0.0.1 探测；Docker 发布到 0.0.0.0/:: 的端口同样按 127.0.0.1 探测',
    '负载均衡器/网关后端（如 Nginx、云 LB）是规划中的 provider',
  ],
  examples: ['workctl network backend list --service demo-order'],
  handler: async (ctx, i): Promise<Result> => {
    const env = resolveEnv(ctx, i.env);
    const timeout = Number(i.timeout_ms);
    const backends = new Map<string, { host: string; port: number; origins: z.infer<typeof OriginSchema>[]; container: string | null }>();
    const add = (host: string, port: number, origin: z.infer<typeof OriginSchema>, container: string | null) => {
      const key = `${host}:${port}`;
      const b = backends.get(key) ?? { host, port, origins: [], container };
      b.origins.push(origin);
      b.container ??= container;
      backends.set(key, b);
    };
    const sources = [];
    const notes: string[] = [];
    let healthPath: string | null = null;
    let store;
    try {
      store = ctx.resources();
    } catch {
      store = undefined;
    }
    const res = store?.get(i.service);
    if (res) {
      const port = Number(res.attributes?.http_port);
      healthPath = typeof res.attributes?.health_path === 'string' ? res.attributes.health_path : null;
      const host = typeof res.attributes?.host === 'string' ? res.attributes.host : '127.0.0.1';
      if (Number.isInteger(port) && port > 0) {
        add(host, port, { origin: 'binding-file', evidence: `bindings: ${i.service}.attributes.http_port=${port}${res.attributes?.host ? '' : '（未给 host，按本机）'}` }, null);
      }
      sources.push(source('workctl', 'resource-bindings', { endpoint: store?.path ?? undefined, method: `resources[${i.service}].attributes`, relation: 'explicit' }));
    } else notes.push(`资源绑定中没有 ${i.service}，只使用容器发布端口`);
    // Docker is one of two backend sources: if it is unreachable, keep the binding
    // backends and report a partial result instead of failing the whole listing.
    let dockerFailure: string | null = null;
    if (ctx.hasEndpoint('docker')) {
      try {
        const docker = dockerClient(ctx);
        const sc = await listServiceContainers(ctx, docker, i.service, env);
        notes.push(...selectionNotes(sc));
        for (const c of sc.containers) {
          for (const p of c.Ports ?? []) {
            if (!p.PublicPort || p.Type !== 'tcp') continue;
            const host = !p.IP || p.IP === '0.0.0.0' || p.IP === '::' ? '127.0.0.1' : p.IP;
            add(host, p.PublicPort, { origin: 'docker-published-port', evidence: `${containerName(c)} ${p.IP ?? ''}:${p.PublicPort}->${p.PrivatePort}/tcp` }, containerName(c));
          }
          if (c.State !== 'running') notes.push(`${containerName(c)} 状态为 ${c.State}，其端口未发布`);
        }
        sources.push(await docker.source(`GET /containers/json?filters={label:${sc.selector.label}}`));
      } catch (e) {
        if (!(e instanceof WorkError) || !['UPSTREAM_UNAVAILABLE', 'PERMISSION_DENIED', 'TIMEOUT'].includes(e.code)) throw e;
        dockerFailure = `${e.code}: ${e.message}`;
        notes.push(`Docker 不可用，未包含容器发布端口（${dockerFailure}）`);
      }
    } else notes.push('profile 未配置 docker 端点，未包含容器发布端口');
    if (!backends.size) {
      if (dockerFailure) throw new WorkError('UPSTREAM_UNAVAILABLE', `无法列出后端: ${dockerFailure}`, { hint: '资源绑定中也没有 http_port' });
      return {
        data: { service: i.service, env, health_path: healthPath, backends: [], summary: { total: 0, healthy: 0, unhealthy: 0 } },
        sources,
        coverage: { complete: true, scope: '资源绑定 + Docker 发布端口', notes },
        warnings: [`没有找到服务 ${i.service} 的后端（绑定无 http_port 且容器未发布端口）`],
      };
    }
    const out: z.infer<typeof BackendSchema>[] = [];
    for (const b of backends.values()) {
      const display = isIP(b.host) === 6 ? `[${b.host}]` : b.host;
      if (healthPath) {
        const p = await httpProbe(`http://${display}:${b.port}${healthPath}`, timeout);
        out.push({ address: `${display}:${b.port}`, host: b.host, port: b.port, origins: b.origins, container: b.container, probe: { kind: 'http', target: p.url, ok: p.ok, status_code: p.status_code, latency_ms: p.latency_ms, body_excerpt: p.body_excerpt, error_code: p.error_code, at: p.at } });
      } else {
        const at = new Date().toISOString();
        const t = await tcpConnect(b.host, b.port, timeout);
        out.push({ address: `${display}:${b.port}`, host: b.host, port: b.port, origins: b.origins, container: b.container, probe: { kind: 'tcp', target: `${display}:${b.port}`, ok: t.ok, status_code: null, latency_ms: t.connect_ms, body_excerpt: null, error_code: t.error_code, at } });
      }
    }
    sources.push(source(healthPath ? 'http-probe' : 'tcp-probe', 'workctl-probe', { method: healthPath ? `GET {backend}${healthPath}` : 'TCP connect', relation: 'sampled' }));
    const healthy = out.filter((b) => b.probe.ok).length;
    return {
      status: dockerFailure ? 'partial' : 'success',
      data: { service: i.service, env, health_path: healthPath, backends: out, summary: { total: out.length, healthy, unhealthy: out.length - healthy } },
      sources,
      coverage: { complete: !dockerFailure, scope: `探测（probe）于 ${new Date().toISOString()} 从 workctl 所在主机发起`, notes },
    };
  },
});

// ---------------------------------------------------------------------------
// network connectivity check
// ---------------------------------------------------------------------------
const connectivityCheck = defineCapability({
  name: 'network.connectivity.check',
  command: 'network connectivity check',
  domain: 'network',
  summary: '从 workctl 所在主机对 host:port 做多次 TCP 建连采样（解析耗时、建连延迟、失败原因）',
  inputs: {
    target: { type: 'string', required: true, description: 'host:port，如 127.0.0.1:13306' },
    count: { type: 'int', default: 3, description: '采样次数（1-20）' },
    timeout_ms: { type: 'int', default: 2000, description: '单次建连超时（毫秒）' },
    interval_ms: { type: 'int', default: 200, description: '采样间隔（毫秒）' },
  },
  output: z.object({
    target: z.string(),
    host: z.string(),
    port: z.number(),
    resolution: z.object({ addresses: z.array(z.string()), duration_ms: z.number().nullable(), error_code: z.string().nullable() }),
    samples: z.array(z.object({ seq: z.number(), ok: z.boolean(), connect_ms: z.number().nullable(), remote_address: z.string().nullable(), error_code: z.string().nullable() })),
    summary: z.object({ sent: z.number(), succeeded: z.number(), failed: z.number(), loss_pct: z.number(), min_ms: z.number().nullable(), avg_ms: z.number().nullable(), max_ms: z.number().nullable() }),
    reachable: z.boolean(),
  }),
  adapter: 'node-net',
  operation: 'diagnose',
  auth_provider: 'none',
  guide: GUIDE,
  notes: ['只验证 TCP 层可建连，不代表应用协议可用或认证通过', '结果是本机视角的采样（sampled）'],
  examples: ['workctl network connectivity check --target 127.0.0.1:13306 --count 3'],
  handler: async (ctx, i): Promise<Result> => {
    const { host, port } = parseTarget(String(i.target));
    const count = Number(i.count);
    if (count < 1 || count > 20) throw new WorkError('INVALID_ARGUMENT', '--count 取值 1-20');
    let addresses: string[] = [];
    let resMs: number | null = null;
    let resErr: string | null = null;
    if (isIP(host)) addresses = [host];
    else {
      const r = await timed(() => dns.lookup(host, { all: true }));
      resMs = r.ms;
      if (r.error) resErr = r.error.code ?? r.error.message;
      else addresses = r.value!.map((x) => x.address);
    }
    const samples: TcpSample[] = [];
    if (!resErr) {
      for (let n = 1; n <= count; n++) {
        samples.push(await tcpConnect(host, port, Number(i.timeout_ms), n));
        if (n < count) await sleep(Number(i.interval_ms), ctx.signal);
      }
    }
    const summary = latencySummary(samples);
    return {
      data: { target: String(i.target), host, port, resolution: { addresses, duration_ms: resMs, error_code: resErr }, samples, summary, reachable: summary.succeeded > 0 },
      sources: [source('tcp', 'node-net', { method: `connect ${host}:${port} ×${count}`, relation: 'sampled' })],
      coverage: { complete: true, sampled: true, scope: 'workctl 所在主机发起的 TCP 建连采样', notes: resErr ? [`域名解析失败（${resErr}），未发起建连`] : [] },
    };
  },
});

const lbPlanned = defineCapability({
  name: 'network.loadbalancer.get',
  command: 'network loadbalancer get',
  domain: 'network',
  summary: '查看负载均衡/网关的监听、后端组与健康状态（规划中：Nginx、云 LB、Ingress）',
  adapter: 'loadbalancer-api (待接入)',
  operation: 'read',
  auth_provider: 'tbd',
  guide: GUIDE,
  status: 'planned',
});

export default defineDomain({
  name: 'network',
  title: '网络',
  summary: 'DNS 解析、服务后端探测与 TCP 连通性采样',
  pillar: 'infrastructure',
  guide: GUIDE,
  skill: 'skills/infra-operations/SKILL.md',
  capabilities: [dnsGet, backendList, connectivityCheck, lbPlanned],
});
