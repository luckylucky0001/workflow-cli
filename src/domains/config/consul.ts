// Consul provider (HTTP API v1): KV under a prefix for `config get`, health/catalog for `discovery list`.
// Consul KV keeps NO history: `config diff` never reconstructs old values (DATA_UNAVAILABLE with facts).
import { safeUrl } from '../../core/http';
import { source, WorkError, type Result, type Source } from '../../core/output';
import type { Ctx, Endpoint } from '../../core/runtime';
import { header, send, type HttpResult, type ProviderChoice } from './provider';
import { MAX_KEYS, type Instance, type Item } from './schema';
import { checkRelKey, checkSegment, decodeValue } from './values';

export const CONSUL_ADAPTER = 'consul-http-api';
export const CONSUL_AUTH = 'consul-acl-token';

export function mapConsulError(status: number, body: string, where: string): WorkError {
  const msg = body.replace(/\s+/g, ' ').slice(0, 300);
  const details = { http_status: status, consul_message: msg };
  if (status === 401 || (status === 403 && /ACL not found|token not found|anonymous token/i.test(body))) {
    return new WorkError('UNAUTHENTICATED', `Consul ACL token 无效或缺失: ${msg} (${where})`, { details, hint: '在端点配置 token_ref（file:/env:），以 X-Consul-Token 头发送' });
  }
  if (status === 403) return new WorkError('PERMISSION_DENIED', `Consul 拒绝访问（token 的 ACL 策略不允许）: ${msg} (${where})`, { details, hint: '需要 key_prefix "<prefix>" { policy = "read" }、service_prefix "" { policy = "read" }、node_prefix "" { policy = "read" }' });
  if (status === 400) return new WorkError('INVALID_ARGUMENT', `Consul 拒绝请求参数: ${msg} (${where})`, { details });
  return new WorkError('UPSTREAM_UNAVAILABLE', `Consul 返回 HTTP ${status}: ${msg} (${where})`, { details });
}

export class ConsulClient {
  readonly url: string;
  private versionCache: string | null | undefined;

  constructor(
    private readonly ctx: Ctx,
    readonly endpoint: Endpoint,
  ) {
    this.url = endpoint.require('url').replace(/\/+$/, '');
  }

  get id(): string {
    return this.endpoint.id;
  }

  get hasToken(): boolean {
    return this.endpoint.secret('token') !== undefined;
  }

  /** GET with optional ACL token and datacenter; 404 → null (absent key / unknown service is a fact, not an error). */
  async get(path: string, params: Record<string, string> = {}): Promise<HttpResult | null> {
    const headers: Record<string, string> = {};
    const token = this.endpoint.secret('token');
    if (token) headers['x-consul-token'] = token;
    const dc = this.endpoint.str('datacenter');
    const qs = new URLSearchParams({ ...params, ...(dc ? { dc } : {}) }).toString();
    const r = await send(this.ctx, 'Consul', this.id, `${this.url}${path}${qs ? `?${qs}` : ''}`, { headers }, '确认 Consul agent 已启动、url 指向 HTTP 端口（演示环境 127.0.0.1:18500）');
    if (r.status === 404) return null;
    if (r.status >= 400) throw mapConsulError(r.status, r.text, `${safeUrl(this.url)}${path}`);
    return r;
  }

  async agentSelf(): Promise<{ Config?: { Version?: string; Datacenter?: string; NodeName?: string }; DebugConfig?: { ACLsEnabled?: boolean; ACL?: { Enabled?: boolean } } }> {
    const r = await this.get('/v1/agent/self');
    return r?.json ?? {};
  }

  /** Agent version for provenance; null when /v1/agent/self is not readable (e.g. no agent:read), never guessed. */
  async version(): Promise<string | null> {
    if (this.versionCache !== undefined) return this.versionCache;
    try {
      this.versionCache = (await this.agentSelf()).Config?.Version ?? null;
    } catch {
      this.versionCache = null;
    }
    return this.versionCache;
  }

  async source(method: string, relation: Source['relation'] = 'explicit'): Promise<Source> {
    const version = await this.version();
    return source('consul', CONSUL_ADAPTER, { endpoint: `${this.id} (${safeUrl(this.url).replace(/\/$/, '')})`, method, relation, ...(version ? { version } : {}) });
  }
}

export function consulClient(ctx: Ctx, name?: string): ConsulClient {
  return new ConsulClient(ctx, ctx.endpoint('consul', name));
}

interface ConsulKv {
  Key: string;
  Value: string | null;
  CreateIndex: number;
  ModifyIndex: number;
  LockIndex: number;
  Flags: number;
  Session?: string;
}

/** KV keys never start with '/'; the configured prefix is normalised to `a/b/`. */
function kvPrefix(client: ConsulClient, env: string, service: string): string {
  let p = client.endpoint.str('config_prefix', 'config/').replace(/^\/+/, '');
  if (p && !p.endsWith('/')) p += '/';
  return `${p}${checkSegment('--env', env)}/${checkSegment('--service', service)}/`;
}

const kvPath = (key: string) => `/v1/kv/${key.split('/').map(encodeURIComponent).join('/')}`;

function toItem(kv: ConsulKv, prefix: string): Item {
  const name = kv.Key.startsWith(prefix) ? kv.Key.slice(prefix.length) : kv.Key;
  return {
    key: kv.Key,
    name,
    ...decodeValue(Buffer.from(kv.Value ?? '', 'base64'), name),
    create_revision: kv.CreateIndex,
    mod_revision: kv.ModifyIndex,
    version: null,
    lease: null,
    consul: { flags: kv.Flags ?? 0, lock_index: kv.LockIndex ?? 0, session: kv.Session ?? null },
  };
}

async function readKv(client: ConsulClient, prefix: string, relKey: string | null): Promise<{ kvs: ConsulKv[]; index: number | null }> {
  const r = await client.get(kvPath(relKey ? prefix + relKey : prefix), relKey ? {} : { recurse: 'true' });
  const idx = r ? Number(header(r.headers, 'x-consul-index')) : NaN;
  // directory placeholder keys ("a/b/") carry no config value
  const kvs = ((r?.json ?? []) as ConsulKv[]).filter((kv) => !kv.Key.endsWith('/')).sort((a, b) => (a.Key < b.Key ? -1 : a.Key > b.Key ? 1 : 0));
  return { kvs, index: Number.isFinite(idx) ? idx : null };
}

export async function consulConfigGet(ctx: Ctx, i: Record<string, any>, p: ProviderChoice, env: string): Promise<Result> {
  const client = consulClient(ctx, p.name);
  const service = String(i.service);
  const prefix = kvPrefix(client, env, service);
  const relKey = i.key ? checkRelKey(String(i.key)) : null;
  const limit = Number(i.limit);
  if (limit < 1 || limit > MAX_KEYS) throw new WorkError('INVALID_ARGUMENT', `--limit 取值 1-${MAX_KEYS}`);
  const r = await readKv(client, prefix, relKey);
  let items = r.kvs.map((kv) => toItem(kv, prefix));
  if (relKey && !items.length) {
    const near = await readKv(client, prefix, null).catch(() => ({ kvs: [] as ConsulKv[], index: null }));
    const names = near.kvs.slice(0, 20).map((kv) => kv.Key.slice(prefix.length));
    throw new WorkError('NOT_FOUND', `配置项不存在: ${prefix}${relKey}`, {
      hint: names.length ? `该前缀下的键（前 20 个）: ${names.join(', ')}` : `前缀 ${prefix} 下没有任何键；检查 --service / --env`,
      details: { observed_revision: near.index },
    });
  }
  const count = items.length;
  const truncated = !relKey && count > limit;
  if (truncated) items = items.slice(0, limit);
  const notes: string[] = [];
  if (!count) notes.push(`前缀 ${prefix} 下没有配置项（Consul 返回 404）；不同环境/服务的键前缀不同，检查 --env / --service`);
  const masked = items.filter((x) => x.masked).length;
  if (masked) notes.push(`${masked} 个配置项的值或字段已遮蔽（按名称匹配敏感模式）`);
  if (truncated) notes.push(`前缀下共 ${count} 个键，只返回按键名排序的前 ${items.length} 个`);
  if (relKey) notes.push('单键读取时 observed_revision（X-Consul-Index）即该键的 ModifyIndex');
  notes.push('Consul KV 不保留历史：mod_revision 为 ModifyIndex（最后修改时的 raft 索引），version 不提供（null）；旧值不可回溯');
  return {
    status: truncated ? 'partial' : 'success',
    data: {
      endpoint: client.id,
      provider: 'consul',
      provider_selected_by: p.origin,
      service,
      env,
      prefix,
      key: relKey,
      revision_space: 'consul-raft-index',
      observed_revision: r.index,
      count,
      truncated,
      items,
    },
    sources: [await client.source(relKey ? `GET /v1/kv/${prefix}${relKey}` : `GET /v1/kv/${prefix}?recurse`)],
    coverage: { complete: !truncated, truncated, limit: relKey ? undefined : limit, scope: `Consul ${client.id} KV 前缀 ${prefix}${r.index !== null ? `，索引 ${r.index}` : ''}`, notes },
  };
}

/**
 * Consul KV has no MVCC history: the only facts are the current values and their Create/ModifyIndex.
 * A diff against an earlier index is reported as DATA_UNAVAILABLE carrying exactly those facts.
 */
export async function consulConfigDiff(ctx: Ctx, i: Record<string, any>, p: ProviderChoice, env: string, toArg: number | 'current'): Promise<Result> {
  const client = consulClient(ctx, p.name);
  const service = String(i.service);
  const prefix = kvPrefix(client, env, service);
  const relKey = i.key ? checkRelKey(String(i.key)) : null;
  if (i.from_rev !== undefined && (!Number.isSafeInteger(i.from_rev) || i.from_rev < 1)) throw new WorkError('INVALID_ARGUMENT', `--from-rev 须为正整数: ${i.from_rev}`);
  if (i.from_rev === undefined && !relKey) throw new WorkError('INVALID_ARGUMENT', '须指定 --from-rev，或用 --key 与该键的上一版本比较', { hint: '注意：Consul KV 不保留历史，两种方式都无法给出旧值' });
  const r = await readKv(client, prefix, relKey);
  const current = r.index;
  const hint = 'Consul KV 不保留历史版本；当前值用 workctl config get 查看。需要变更历史请在写入侧留痕（如 git2consul / consul-template 的版本库、审计日志），或改用 etcd / Nacos provider';
  if (relKey && i.from_rev === undefined) {
    const kv = r.kvs[0];
    if (!kv) throw new WorkError('NOT_FOUND', `配置项不存在: ${prefix}${relKey}`, { hint: '键已删除或从未写入；Consul 不保留删除记录' });
    throw new WorkError('DATA_UNAVAILABLE', `Consul KV 不保留历史，无法给出 ${prefix}${relKey} 的上一版本`, {
      hint,
      details: { provider: 'consul', key: kv.Key, create_index: kv.CreateIndex, modify_index: kv.ModifyIndex, observed_index: current, changed_since_creation: kv.ModifyIndex !== kv.CreateIndex },
    });
  }
  const fromRev = i.from_rev as number;
  const toRev = toArg === 'current' ? current : toArg;
  if (toArg !== 'current' && current !== null && toArg !== current) {
    throw new WorkError('DATA_UNAVAILABLE', `Consul KV 只能读当前状态（索引 ${current}），不能读取索引 ${toArg} 时的快照`, { hint, details: { requested_revision: toArg, current_index: current } });
  }
  if (current !== null && fromRev > current) throw new WorkError('INVALID_ARGUMENT', `--from-rev ${fromRev} 大于 Consul 当前索引 ${current}`, { details: { requested_revision: fromRev, current_revision: current } });
  const changedSince = r.kvs.filter((kv) => kv.ModifyIndex > fromRev).map((kv) => ({ key: kv.Key, create_index: kv.CreateIndex, modify_index: kv.ModifyIndex, created_after: kv.CreateIndex > fromRev }));
  if (fromRev === toRev) {
    return {
      data: { endpoint: client.id, provider: 'consul', provider_selected_by: p.origin, service, env, prefix, key: relKey, revision_space: 'consul-raft-index', mode: 'revisions', from_revision: fromRev, to_revision: fromRev, current_revision: current ?? fromRev, changes: [], summary: { added: 0, removed: 0, changed: 0, unchanged: r.kvs.length, rewritten_same_value: 0 } },
      sources: [await client.source(`GET /v1/kv/${prefix}?recurse`)],
      coverage: { complete: true, scope: `Consul ${client.id} KV 前缀 ${prefix}，索引 ${fromRev}`, notes: ['起止索引相同（即当前索引），差异必然为空'] },
    };
  }
  throw new WorkError('DATA_UNAVAILABLE', `Consul KV 不保留历史，无法重建索引 ${fromRev} 时的值；已知事实见 details.changed_since（ModifyIndex > ${fromRev} 的键，旧值不可知），删除的键无法发现`, {
    hint,
    details: { provider: 'consul', from_revision: fromRev, current_index: current, keys_now: r.kvs.length, changed_since: changedSince.slice(0, 100), unchanged_since: r.kvs.length - changedSince.length },
  });
}

interface HealthEntry {
  Node?: { Node?: string; Address?: string };
  Service?: { ID?: string; Service?: string; Address?: string; Port?: number; Tags?: string[] | null; Meta?: Record<string, string> | null; CreateIndex?: number; ModifyIndex?: number };
  Checks?: { CheckID?: string; Name?: string; Status?: string; ServiceID?: string; Output?: string }[];
}

const RANK: Record<string, number> = { passing: 0, warning: 1, critical: 2 };

export async function consulDiscoveryList(ctx: Ctx, i: Record<string, any>, p: ProviderChoice): Promise<Result> {
  const client = consulClient(ctx, p.name);
  const service = checkSegment('--service', String(i.service));
  const env = i.env ? checkSegment('--env', String(i.env)) : null;
  const r = await client.get(`/v1/health/service/${encodeURIComponent(service)}`);
  const index = r ? Number(header(r.headers, 'x-consul-index')) : NaN;
  const entries = (r?.json ?? []) as HealthEntry[];
  const sources: Source[] = [await client.source(`GET /v1/health/service/${service}`)];
  let registeredInCatalog: boolean | null = null;
  if (!entries.length) {
    try {
      const c = await client.get('/v1/catalog/services');
      registeredInCatalog = !!c?.json && Object.prototype.hasOwnProperty.call(c.json, service);
      sources.push(await client.source('GET /v1/catalog/services'));
    } catch (e) {
      if (e instanceof WorkError && e.code === 'UNAUTHENTICATED') throw e;
      registeredInCatalog = null;
    }
  } else registeredInCatalog = true;
  const excluded = { env_mismatch: 0, env_missing: 0, not_healthy: 0 };
  const instances: Instance[] = [];
  for (const e of entries) {
    const s = e.Service ?? {};
    const meta = s.Meta ?? {};
    const instEnv = meta.env === undefined ? null : String(meta.env);
    if (env) {
      if (instEnv === null) {
        excluded.env_missing++;
        continue;
      }
      if (instEnv !== env) {
        excluded.env_mismatch++;
        continue;
      }
    }
    const checks = (e.Checks ?? []).map((c) => ({ check_id: String(c.CheckID ?? ''), name: String(c.Name ?? ''), status: String(c.Status ?? ''), service_level: !!c.ServiceID, output: String(c.Output ?? '').slice(0, 300) }));
    const worst = checks.reduce((w, c) => ((RANK[c.status] ?? 2) > RANK[w] ? ((c.status in RANK ? c.status : 'critical') as 'passing' | 'warning' | 'critical') : w), 'passing' as 'passing' | 'warning' | 'critical');
    const healthy = worst !== 'critical';
    if (i.healthy_only && !healthy) {
      excluded.not_healthy++;
      continue;
    }
    const dv = decodeValue(Buffer.from(JSON.stringify({ meta, tags: s.Tags ?? [] })), '');
    instances.push({
      instance_id: String(s.ID ?? ''),
      key: `${e.Node?.Node ?? '?'}/${s.ID ?? ''}`,
      payload: dv.value,
      payload_error: null,
      address: s.Address || e.Node?.Address || null,
      port: Number.isFinite(Number(s.Port)) ? Number(s.Port) : null,
      version: meta.version === undefined ? null : String(meta.version),
      env: instEnv,
      healthy,
      health_basis: 'registry_checks',
      registered_at: null,
      create_revision: s.CreateIndex ?? null,
      mod_revision: s.ModifyIndex ?? null,
      lease: null,
      consul: { node: e.Node?.Node ?? null, status: worst, tags: s.Tags ?? [], checks },
    });
  }
  instances.sort((a, b) => (a.instance_id < b.instance_id ? -1 : 1));
  const notes: string[] = [];
  if (!entries.length) notes.push(registeredInCatalog === false ? `服务 ${service} 未在 Consul 目录中注册` : registeredInCatalog ? `服务 ${service} 在目录中但没有实例` : `服务 ${service} 没有实例（目录不可读，无法区分未注册与 0 实例）`);
  else if (!instances.length) notes.push(`服务下有 ${entries.length} 个实例，过滤后为空`);
  const warn = instances.filter((x) => x.consul?.status === 'warning').length;
  if (warn) notes.push(`${warn} 个实例存在 warning 检查，计为 healthy（与 Consul DNS 默认一致）；?passing 过滤会排除它们`);
  if (instances.some((x) => !x.consul?.checks.length)) notes.push('没有任何健康检查的实例被 Consul 视为 passing');
  if (excluded.env_missing) notes.push(`${excluded.env_missing} 个实例 Meta 没有 env，按 --env 过滤时已排除`);
  notes.push('healthy 由 Consul 健康检查聚合（含节点级检查，任一 critical → false），不是 workctl 的探测');
  const healthyN = instances.filter((x) => x.healthy === true).length;
  const unhealthyN = instances.filter((x) => x.healthy === false).length;
  return {
    data: {
      endpoint: client.id,
      provider: 'consul',
      provider_selected_by: p.origin,
      service,
      env,
      prefix: `/v1/health/service/${service}`,
      observed_revision: Number.isFinite(index) ? index : null,
      instances,
      summary: { registered: entries.length, returned: instances.length, healthy: healthyN, unhealthy: unhealthyN, health_unknown: instances.length - healthyN - unhealthyN, without_lease: 0, excluded, service_registered: registeredInCatalog },
    },
    sources,
    coverage: { complete: true, scope: `Consul ${client.id} 服务 ${service}${Number.isFinite(index) ? `，索引 ${index}` : ''}`, notes },
  };
}

export async function consulProbe(ctx: Ctx, name: string): Promise<{ ok: boolean; identity?: string; version?: string; detail?: string }> {
  const client = consulClient(ctx, name);
  const self = await client.agentSelf();
  const leader = await client.get('/v1/status/leader');
  const acl = self.DebugConfig?.ACLsEnabled ?? self.DebugConfig?.ACL?.Enabled;
  return {
    ok: true,
    identity: client.hasToken ? 'token (token_ref)' : 'anonymous',
    version: self.Config?.Version,
    detail: [`数据中心 ${self.Config?.Datacenter ?? '未知'}`, `节点 ${self.Config?.NodeName ?? '未知'}`, `leader ${leader?.json || '(无)'}`, acl === undefined ? '' : `ACL ${acl ? '已开启' : '未开启'}`].filter(Boolean).join('；'),
  };
}
