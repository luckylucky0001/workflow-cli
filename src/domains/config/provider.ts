// Provider selection for the config domain: the endpoint KIND (etcd | nacos | consul) selects the
// provider. Which endpoint applies is decided by --endpoint, then the service's resource binding
// (a relation to a `config.center` resource that names an endpoint), then profile defaults.
import { rawRequest, safeUrl } from '../../core/http';
import { WorkError } from '../../core/output';
import type { Resource } from '../../core/resources';
import type { Ctx } from '../../core/runtime';
import { PROVIDER_KINDS, type ProviderKind } from './schema';

/** Catalogued but not implemented: selecting one of these is reported as CAPABILITY_PLANNED, never emulated. */
export const PLANNED_PROVIDERS: Record<string, string> = {
  apollo: 'Apollo（Open API：/openapi/v1/envs/{env}/apps/{appId}/clusters/{cluster}/namespaces/{ns}，发布历史 /releases）',
  zookeeper: 'ZooKeeper（znode 树读取 + 临时节点注册；需要原生协议客户端）',
};

export interface ProviderChoice {
  kind: ProviderKind;
  name: string;
  origin: string;
}

function checkKind(kind: string, where: string): ProviderKind {
  if ((PROVIDER_KINDS as readonly string[]).includes(kind)) return kind as ProviderKind;
  if (PLANNED_PROVIDERS[kind]) {
    throw new WorkError('CAPABILITY_PLANNED', `${where}: 配置中心 provider ${kind} 尚未接入`, {
      hint: `规划中：${PLANNED_PROVIDERS[kind]}；当前支持 ${PROVIDER_KINDS.join(' / ')}`,
      details: { provider: kind },
    });
  }
  throw new WorkError('INVALID_ARGUMENT', `${where}: ${kind} 不是配置中心端点类型`, { hint: `可选: ${PROVIDER_KINDS.join(', ')}` });
}

/** Config-center resources the service is bound to (relation from the service to a `config.center` resource with an endpoint). */
function boundCenters(ctx: Ctx, service: string, env: string | null): { res: Resource; via: string }[] {
  let store;
  try {
    store = ctx.resources();
  } catch {
    return [];
  }
  const out: { res: Resource; via: string }[] = [];
  const attr = store.get(service)?.attributes?.config_center;
  if (typeof attr === 'string' && attr) {
    const r = store.get(attr);
    if (!r || r.type !== 'config.center' || !r.endpoint) {
      throw new WorkError('NOT_CONFIGURED', `资源绑定 ${service}.attributes.config_center=${attr} 不是带 endpoint 的 config.center 资源`, { hint: '在 bindings 中定义该 config.center 资源并声明 endpoint {kind, name}' });
    }
    out.push({ res: r, via: `bindings: ${service}.attributes.config_center=${attr}（endpoint ${r.endpoint.kind}/${r.endpoint.name}）` });
  }
  for (const rel of store.relationsOf(service, 'downstream')) {
    const r = store.get(rel.to);
    if (!r || r.type !== 'config.center' || !r.endpoint) continue;
    if (env && r.env && r.env !== env) continue;
    if (out.some((x) => x.res.id === r.id)) continue;
    out.push({ res: r, via: `bindings: ${service} ${rel.type} ${r.id}（endpoint ${r.endpoint.kind}/${r.endpoint.name}）` });
  }
  return out;
}

export function resolveConfigProvider(ctx: Ctx, service: string | null, env: string | null, endpointArg?: unknown): ProviderChoice {
  const p = ctx.requireProfile();
  if (endpointArg !== undefined && endpointArg !== null && endpointArg !== '') {
    const s = String(endpointArg);
    if (s.includes('/')) {
      const [k, ...rest] = s.split('/');
      const kind = checkKind(k, '--endpoint');
      const name = rest.join('/');
      if (!p.endpoints[kind]?.[name]) throw new WorkError('NOT_FOUND', `profile ${ctx.profileName} 中没有 ${kind} 端点 ${name}`, { hint: `可用: ${ctx.endpointNames(kind).join(', ') || '(无)'}` });
      return { kind, name, origin: `--endpoint ${kind}/${name}` };
    }
    const hits = PROVIDER_KINDS.filter((k) => p.endpoints[k]?.[s]);
    if (hits.length === 1) return { kind: hits[0], name: s, origin: `--endpoint ${s}（${hits[0]} 端点）` };
    if (hits.length > 1) throw new WorkError('INVALID_ARGUMENT', `--endpoint ${s} 同时是 ${hits.join(' / ')} 端点`, { hint: `写成 <类型>/<名称>，如 ${hits[0]}/${s}` });
    const planned = Object.keys(PLANNED_PROVIDERS).find((k) => p.endpoints[k]?.[s]);
    if (planned) checkKind(planned, `--endpoint ${s}`);
    const all = PROVIDER_KINDS.flatMap((k) => ctx.endpointNames(k).map((n) => `${k}/${n}`));
    throw new WorkError('NOT_FOUND', `profile ${ctx.profileName} 中没有名为 ${s} 的配置中心端点`, { hint: all.length ? `可用: ${all.join(', ')}` : '在 endpoints.etcd / nacos / consul 下配置端点' });
  }
  if (service) {
    const centers = boundCenters(ctx, service, env);
    if (centers.length) {
      const [{ res, via }] = centers;
      const kind = checkKind(res.endpoint!.kind, `bindings: ${res.id}.endpoint.kind`);
      if (!p.endpoints[kind]?.[res.endpoint!.name]) {
        throw new WorkError('NOT_CONFIGURED', `资源绑定 ${res.id} 指向 ${kind} 端点 ${res.endpoint!.name}，但 profile ${ctx.profileName} 未配置该端点`, { hint: `在 profiles.${ctx.profileName}.endpoints.${kind} 中添加 ${res.endpoint!.name}` });
      }
      const extra = centers.length > 1 ? `；另有 ${centers.slice(1).map((c) => c.res.id).join(', ')} 未使用` : '';
      return { kind, name: res.endpoint!.name, origin: via + extra };
    }
  }
  const d = p.defaults.config;
  if (d) {
    const [k, name] = String(d).split('/');
    const kind = checkKind(k, `profiles.${ctx.profileName}.defaults.config`);
    const ep = ctx.endpoint(kind, name || undefined);
    return { kind, name: ep.name, origin: `profiles.${ctx.profileName}.defaults.config=${d}` };
  }
  const configured = PROVIDER_KINDS.filter((k) => ctx.hasEndpoint(k));
  // etcd stays the default provider when configured (backwards compatible)
  const kind = configured.includes('etcd') ? 'etcd' : configured.length === 1 ? configured[0] : null;
  if (!kind) {
    throw new WorkError('NOT_CONFIGURED', configured.length ? `profile 配置了多种配置中心（${configured.join(', ')}），无法确定使用哪一个` : `profile ${ctx.profileName} 未配置配置中心端点（etcd / nacos / consul）`, {
      hint: '用 --endpoint <类型>/<名称> 指定，或在资源绑定中把服务关联到 config.center 资源，或设置 profile defaults.config',
    });
  }
  const ep = ctx.endpoint(kind);
  return { kind, name: ep.name, origin: `profile 默认 ${kind} 端点 ${ep.name}${service ? `（服务 ${service} 未绑定配置中心）` : ''}` };
}

// ---------------------------------------------------------------------------
// shared HTTP plumbing for the Nacos / Consul clients
// ---------------------------------------------------------------------------
const NET_CODES = ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE'];

export interface HttpResult {
  status: number;
  json: any;
  text: string;
  headers: Record<string, string | string[] | undefined>;
}

export async function send(
  ctx: Ctx,
  system: string,
  endpointId: string,
  url: string,
  o: { method?: string; headers?: Record<string, string>; body?: string },
  hint: string,
): Promise<HttpResult> {
  let res;
  try {
    res = await rawRequest(url, { method: o.method ?? 'GET', headers: { accept: 'application/json', ...(o.headers ?? {}) }, body: o.body, timeoutMs: Math.min(ctx.remainingMs(), 15_000) });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const code = err.code ?? (err.cause as NodeJS.ErrnoException | undefined)?.code;
    if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new WorkError('TIMEOUT', `${system} 请求超时 (${safeUrl(url)})`);
    if (code && NET_CODES.includes(code)) throw new WorkError('UPSTREAM_UNAVAILABLE', `${system} 不可达 (${code}, ${endpointId})`, { details: { endpoint: safeUrl(url) }, hint });
    throw e;
  }
  let json: any = null;
  try {
    json = res.text ? JSON.parse(res.text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text: res.text, headers: res.headers };
}

export function header(h: HttpResult['headers'], name: string): string | undefined {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** Fill `${service}` / `${env}` in an endpoint template. */
export function fill(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\$\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}
