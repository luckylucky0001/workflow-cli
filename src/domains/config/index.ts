import { WorkError, type Result, type Source } from '../../core/output';
import { defineCapability, defineDomain } from '../../core/registry';
import type { Ctx } from '../../core/runtime';
import { b64, ETCD_ADAPTER, ETCD_AUTH, etcdClient, int, prefixRangeEnd, unb64, type EtcdClient, type EtcdKv, type RangeResponse } from './etcd';
import { checkRelKey, checkSegment, decodeValue, normPrefix, parseRev, toItem } from './values';
import { CONSUL_ADAPTER, CONSUL_AUTH, consulConfigDiff, consulConfigGet, consulDiscoveryList, consulProbe } from './consul';
import { NACOS_ADAPTER, NACOS_AUTH, nacosConfigDiff, nacosConfigGet, nacosDiscoveryList, nacosProbe } from './nacos';
import { PLANNED_PROVIDERS, resolveConfigProvider } from './provider';
import { ConfigDiffOutput, ConfigGetOutput, DiscoveryOutput, MASK_NOTE, MAX_KEYS, side, type Change, type Instance } from './schema';

const GUIDE = 'docs/guides/infrastructure.md';
const SKILL = 'skills/infra-operations/SKILL.md';
const ADAPTER = `${ETCD_ADAPTER}|${NACOS_ADAPTER}|${CONSUL_ADAPTER}`;
const AUTH = `${ETCD_AUTH} | ${NACOS_AUTH} | ${CONSUL_AUTH}`;
const PROVIDER_NOTE = 'provider 由端点类型决定（etcd | nacos | consul）：--endpoint [<类型>/]<名称> > 资源绑定（服务 attributes.config_center 或服务指向 config.center 资源的关系，取该资源的 endpoint）> profile defaults.config（<类型>[/<名称>]）> 默认 etcd 端点（或唯一的配置中心端点）；data.provider / provider_selected_by 写明实际选择';
const PLANNED_NOTE = `规划中的 provider（绑定或 --endpoint 指向时返回 CAPABILITY_PLANNED，不做模拟）：${Object.keys(PLANNED_PROVIDERS).join(' / ')}`;

const endpointInput = { type: 'string' as const, description: '配置中心端点：<类型>/<名称> 或名称（etcd / nacos / consul）；默认按资源绑定或 profile 默认选择' };

function configPrefix(client: EtcdClient, env: string, service: string): string {
  return `${normPrefix(client.endpoint.str('config_prefix', '/config/'))}${checkSegment('--env', env)}/${checkSegment('--service', service)}/`;
}

function resolveEnvInput(ctx: Ctx, v: unknown): string {
  const env = v ? String(v) : ctx.env;
  if (!env) throw new WorkError('INVALID_ARGUMENT', '缺少 --env，且 profile 未设置 env');
  return env;
}

/** Range over a prefix (or one key) at a revision; `limit` keys at most. */
async function readRange(client: EtcdClient, prefix: string, relKey: string | null, revision: number | undefined, limit: number): Promise<RangeResponse> {
  if (relKey) return client.range({ key: b64(prefix + relKey), revision });
  return client.range({ key: b64(prefix), range_end: b64(prefixRangeEnd(Buffer.from(prefix, 'utf8'))), revision, limit, sort_order: 'ASCEND', sort_target: 'KEY' });
}

/**
 * etcd does not report the compaction point on a failed range; find the earliest readable revision
 * by bisection between a revision known to be compacted and one known to be readable.
 */
export async function findCompactRevision(client: EtcdClient, key: string, compacted: number, readable: number): Promise<number | null> {
  let lo = compacted + 1;
  let hi = readable;
  for (let guard = 0; lo < hi && guard < 64; guard++) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      await client.range({ key: b64(key), revision: mid, count_only: true });
      hi = mid;
    } catch (e) {
      if (e instanceof WorkError && e.code === 'DATA_UNAVAILABLE') lo = mid + 1;
      else return null;
    }
  }
  return lo <= readable ? lo : null;
}

// ---------------------------------------------------------------------------
// config get
// ---------------------------------------------------------------------------
const configGet = defineCapability({
  name: 'config.get',
  command: 'config get',
  domain: 'config',
  summary: '读取配置中心（etcd v3 / Nacos / Consul KV）中某服务某环境的配置项：当前值、修订号与元数据（敏感项遮蔽）',
  inputs: {
    service: { type: 'string', required: true, description: '服务 ID，如 demo-order' },
    env: { type: 'string', description: '环境；默认取 profile 的 env' },
    key: { type: 'string', description: '只读取一个配置项（服务前缀下的相对键名，如 cache.ttl_seconds）' },
    limit: { type: 'int', default: 200, description: `最多返回的键数（1-${MAX_KEYS}）` },
    endpoint: endpointInput,
  },
  output: ConfigGetOutput,
  adapter: ADAPTER,
  operation: 'read',
  auth_provider: AUTH,
  guide: GUIDE,
  prerequisites: [
    'profile 配置 endpoints.etcd（url，可选 config_prefix / username + password_ref）、endpoints.nacos（url，可选 namespace / group / data_id 模板、username + password_ref）或 endpoints.consul（url，可选 config_prefix / datacenter / token_ref）',
    '身份对该前缀（Nacos：命名空间）有读权限（开启认证/ACL 时）',
  ],
  notes: [
    '读的是 etcd 当前已提交的值（线性一致读），observed_revision 是读取时刻的集群修订，不代表应用已加载该值',
    MASK_NOTE,
    '值为 JSON（对象/数组/数字/布尔）时返回解析后的值；非 UTF-8 字节以 base64 返回（value_format=binary_base64）',
    'mod_revision 是最后一次修改的集群修订；可作为 config diff --from-rev 的输入',
    PROVIDER_NOTE,
    'Nacos：读取 <namespace>/<group>/<dataId> 整个配置文档，properties / yaml / json 拆分为键（嵌套键以 . 和 [i] 展平；类型为 text 时按 dataId 扩展名判断），其他类型时整个文档作为一个值，解析失败时整个文档作为一个值并整体遮蔽；没有键级修订（null）',
    'Consul：读取 KV 前缀 <config_prefix><env>/<service>/（?recurse），create/mod_revision 为 CreateIndex/ModifyIndex，observed_revision 为 X-Consul-Index；version 不提供',
    '键列表被截断（超过 --limit）时 status=partial、coverage.complete=false',
    PLANNED_NOTE,
  ],
  examples: [
    'workctl config get --service demo-order --env sandbox',
    'workctl config get --service demo-order --key cache.ttl_seconds',
    'workctl config get --service demo-payment --env sandbox',
    'workctl config get --service demo-inventory --endpoint consul/demo-consul',
  ],
  handler: async (ctx, i): Promise<Result> => {
    const env = resolveEnvInput(ctx, i.env);
    const p = resolveConfigProvider(ctx, String(i.service), env, i.endpoint);
    if (p.kind === 'nacos') return nacosConfigGet(ctx, i, p, env);
    if (p.kind === 'consul') return consulConfigGet(ctx, i, p, env);
    const client = etcdClient(ctx, p.name);
    const prefix = configPrefix(client, env, String(i.service));
    const relKey = i.key ? checkRelKey(String(i.key)) : null;
    const limit = Number(i.limit);
    if (limit < 1 || limit > MAX_KEYS) throw new WorkError('INVALID_ARGUMENT', `--limit 取值 1-${MAX_KEYS}`);
    const r = await readRange(client, prefix, relKey, undefined, limit);
    const items = (r.kvs ?? []).map((kv) => toItem(kv, prefix));
    const observed = int(r.header?.revision);
    if (relKey && !items.length) {
      const near = await readRange(client, prefix, null, observed, 20).catch(() => ({ kvs: [] as EtcdKv[] }));
      const names = (near.kvs ?? []).map((kv) => unb64(kv.key).toString('utf8').slice(prefix.length));
      throw new WorkError('NOT_FOUND', `配置项不存在: ${prefix}${relKey}（修订 ${observed}）`, {
        hint: names.length ? `该前缀下的键（前 20 个）: ${names.join(', ')}` : `前缀 ${prefix} 下没有任何键；检查 --service / --env`,
        details: { observed_revision: observed },
      });
    }
    const count = relKey ? items.length : int(r.count);
    const truncated = !!r.more || count > items.length;
    const masked = items.filter((x) => x.masked).length;
    const notes: string[] = [];
    if (!items.length) notes.push(`前缀 ${prefix} 下没有配置项（修订 ${observed}）；不同环境/服务的键前缀不同，检查 --env / --service`);
    if (masked) notes.push(`${masked} 个配置项的值或字段已遮蔽（按名称匹配敏感模式，或值中内嵌的 URL 密码 / token= 等凭据）`);
    if (truncated) notes.push(`前缀下共 ${count} 个键，只返回按键名排序的前 ${items.length} 个`);
    if (client.authNote) notes.push(client.authNote);
    return {
      status: truncated ? 'partial' : 'success',
      data: { endpoint: client.id, provider: 'etcd', provider_selected_by: p.origin, service: String(i.service), env, prefix, key: relKey, revision_space: 'etcd-cluster-revision', observed_revision: observed, count, truncated, items },
      sources: [await client.source(relKey ? `POST /v3/kv/range key=${prefix}${relKey}` : `POST /v3/kv/range prefix=${prefix}`)],
      coverage: { complete: !truncated, truncated, limit: relKey ? undefined : limit, scope: `etcd ${client.id} 键前缀 ${prefix}，修订 ${observed}`, notes },
    };
  },
});

// ---------------------------------------------------------------------------
// config diff
// ---------------------------------------------------------------------------
const configDiff = defineCapability({
  name: 'config.diff',
  command: 'config diff',
  domain: 'config',
  summary: '比较配置项在两个修订之间的差异（etcd 集群修订 / Nacos 配置历史 ID；新增/删除/修改，敏感值遮蔽）；不给 --from-rev 时与 --key 的上一版本比较；Consul KV 无历史',
  inputs: {
    service: { type: 'string', required: true, description: '服务 ID' },
    env: { type: 'string', description: '环境；默认取 profile 的 env' },
    key: { type: 'string', description: '只比较一个配置项（相对键名）' },
    from_rev: { type: 'int', description: '起始修订（etcd 集群修订号；Nacos 配置历史 ID）；省略时须给 --key，取该键上一版本' },
    to_rev: { type: 'string', default: 'current', description: '结束修订：正整数或 current' },
    endpoint: endpointInput,
  },
  output: ConfigDiffOutput,
  adapter: ADAPTER,
  operation: 'read',
  auth_provider: AUTH,
  guide: GUIDE,
  prerequisites: ['profile 配置 etcd / nacos 端点（Consul KV 不保留历史，只能报告 DATA_UNAVAILABLE 与已知索引）', 'etcd：起始修订不早于最近一次压缩；Nacos：起始历史 ID 在保留期内（默认 30 天）'],
  notes: [
    '修订号是 etcd 集群级的全局修订（任意键写入都会递增），不是单个配置项的版本号',
    '只比较两个修订时刻的快照：区间内改了又改回的值显示为未变化（计入 rewritten_same_value），中间值不可见',
    '历史只保留到最近一次压缩：早于压缩点的修订返回 DATA_UNAVAILABLE，details.compact_revision 为最早可读修订（二分探测得出）',
    '修订大于当前集群修订返回 INVALID_ARGUMENT；比较只读，不会触发压缩',
    MASK_NOTE,
    PROVIDER_NOTE,
    'Nacos：修订空间为配置历史 ID（revision_space=nacos-history-id，全局递增 nid）；历史记录保存变更前的内容（前像），workctl 据此重建“该 ID 生效后”的文档再按键比较；早于最早保留记录 → DATA_UNAVAILABLE（details.oldest_history_id / retention_days）',
    'Consul：KV 不保留历史，不重建任何旧值：--key 模式返回 DATA_UNAVAILABLE（details 带 create_index / modify_index），--from-rev 模式返回 DATA_UNAVAILABLE（details.changed_since 列出 ModifyIndex 更大的键）；删除的键无法发现',
  ],
  examples: [
    'workctl config diff --service demo-order --env sandbox --from-rev 2',
    'workctl config diff --service demo-order --key cache.ttl_seconds',
    'workctl config diff --service demo-payment --key order.timeout_ms',
  ],
  handler: async (ctx, i): Promise<Result> => {
    const env = resolveEnvInput(ctx, i.env);
    const p = resolveConfigProvider(ctx, String(i.service), env, i.endpoint);
    const toArg = parseRev('--to-rev', i.to_rev ?? 'current');
    if (p.kind === 'nacos') return nacosConfigDiff(ctx, i, p, env, toArg);
    if (p.kind === 'consul') return consulConfigDiff(ctx, i, p, env, toArg);
    const client = etcdClient(ctx, p.name);
    const prefix = configPrefix(client, env, String(i.service));
    const relKey = i.key ? checkRelKey(String(i.key)) : null;
    if (i.from_rev !== undefined && (!Number.isSafeInteger(i.from_rev) || i.from_rev < 1)) throw new WorkError('INVALID_ARGUMENT', `--from-rev 须为正整数: ${i.from_rev}`);
    if (i.from_rev === undefined && !relKey) {
      throw new WorkError('INVALID_ARGUMENT', '须指定 --from-rev，或用 --key 与该键的上一版本比较', { hint: '先用 workctl config get 查看各键的 mod_revision' });
    }
    // current snapshot first: gives the cluster revision to validate the requested range against
    const now = await client.range({ key: b64(prefix), range_end: b64(prefixRangeEnd(Buffer.from(prefix, 'utf8'))), count_only: true });
    const current = int(now.header?.revision);
    const toRev = toArg === 'current' ? current : toArg;
    const future = (label: string, rev: number) =>
      new WorkError('INVALID_ARGUMENT', `${label} ${rev} 大于 etcd 当前修订 ${current}`, { details: { requested_revision: rev, current_revision: current } });
    if (toRev > current) throw future('--to-rev', toRev);
    if (typeof i.from_rev === 'number' && i.from_rev > current) throw future('--from-rev', i.from_rev);

    const sources: Source[] = [];
    const compacted = async (rev: number, e: unknown): Promise<never> => {
      if (e instanceof WorkError && e.code === 'DATA_UNAVAILABLE') {
        const compact = await findCompactRevision(client, prefix, rev, current).catch(() => null);
        throw new WorkError('DATA_UNAVAILABLE', `修订 ${rev} 已被压缩（compaction），etcd 不再保留该修订的历史`, {
          details: { requested_revision: rev, compact_revision: compact, current_revision: current, ...(e.details ?? {}) },
          hint: compact ? `最早可读修订为 ${compact}；用 --from-rev ${compact} 或更大的值` : '用更晚的 --from-rev 重试',
        });
      }
      throw e;
    };
    const snapshot = async (rev: number): Promise<RangeResponse> => {
      try {
        return await readRange(client, prefix, relKey, rev, MAX_KEYS);
      } catch (e) {
        return compacted(rev, e);
      }
    };

    const toSnap = await snapshot(toRev);
    const toItems = (toSnap.kvs ?? []).map((kv) => toItem(kv, prefix));
    let fromRev: number;
    let mode: 'revisions' | 'previous_version' = 'revisions';
    const notes: string[] = [];
    if (i.from_rev === undefined) {
      mode = 'previous_version';
      const cur = toItems[0];
      if (!cur) {
        throw new WorkError('NOT_FOUND', `配置项在修订 ${toRev} 不存在: ${prefix}${relKey}`, { hint: '键已删除或从未写入；用 --from-rev 指定比较起点', details: { to_revision: toRev } });
      }
      fromRev = cur.mod_revision - 1;
      if (cur.version === 1) notes.push(`该键在修订 ${cur.mod_revision} 创建（version=1），没有更早版本；与创建前的状态比较`);
      if (fromRev < 1) fromRev = 1;
    } else fromRev = i.from_rev;
    if (fromRev > toRev) throw new WorkError('INVALID_ARGUMENT', `--from-rev ${fromRev} 大于 --to-rev ${toRev}`);
    const fromSnap = await snapshot(fromRev);
    const fromItems = (fromSnap.kvs ?? []).map((kv) => toItem(kv, prefix));
    sources.push(await client.source(`POST /v3/kv/range ${relKey ? `key=${prefix}${relKey}` : `prefix=${prefix}`} revision=${fromRev} / revision=${toRev}`));

    const truncated = !!fromSnap.more || !!toSnap.more;
    const rawOf = (kvs: EtcdKv[] | undefined) => new Map((kvs ?? []).map((kv) => [unb64(kv.key).toString('utf8'), kv.value ?? '']));
    const fromRaw = rawOf(fromSnap.kvs);
    const toRaw = rawOf(toSnap.kvs);
    const fromMap = new Map(fromItems.map((x) => [x.key, x]));
    const toMap = new Map(toItems.map((x) => [x.key, x]));
    // a truncated snapshot only covers keys up to its last returned key; keys past that are not compared (else false added/removed)
    const bounds = [fromSnap, toSnap].filter((s) => s.more && s.kvs?.length).map((s) => unb64(s.kvs![s.kvs!.length - 1].key));
    const keys = [...new Set([...fromMap.keys(), ...toMap.keys()])].filter((k) => bounds.every((b) => Buffer.compare(Buffer.from(k, 'utf8'), b) <= 0)).sort();
    const changes: Change[] = [];
    const summary = { added: 0, removed: 0, changed: 0, unchanged: 0, rewritten_same_value: 0 };
    for (const k of keys) {
      const a = fromMap.get(k);
      const b = toMap.get(k);
      const masked = !!(a?.masked || b?.masked);
      if (a && b) {
        if (fromRaw.get(k) === toRaw.get(k)) {
          summary.unchanged++;
          if (a.mod_revision !== b.mod_revision) summary.rewritten_same_value++;
          continue;
        }
        summary.changed++;
        changes.push({ name: b.name, key: k, change: 'changed' as const, masked, old: side(a), new: side(b) });
      } else if (b) {
        summary.added++;
        changes.push({ name: b.name, key: k, change: 'added' as const, masked, old: null, new: side(b) });
      } else if (a) {
        summary.removed++;
        changes.push({ name: a.name, key: k, change: 'removed' as const, masked, old: side(a), new: null });
      }
    }
    if (fromRev === toRev) notes.push('起止修订相同，差异必然为空');
    if (changes.some((c) => c.masked)) notes.push('部分差异项的值已遮蔽（***），changed 依据原始字节判断');
    if (truncated) notes.push(`某一侧快照超过 ${MAX_KEYS} 个键，只比较了前 ${MAX_KEYS} 个（按键名）`);
    notes.push('只比较两个修订的快照；区间内的中间值不可见。历史只保留到最近一次压缩');
    if (client.authNote) notes.push(client.authNote);
    return {
      status: truncated ? 'partial' : 'success',
      data: { endpoint: client.id, provider: 'etcd', provider_selected_by: p.origin, service: String(i.service), env, prefix, key: relKey, revision_space: 'etcd-cluster-revision', mode, from_revision: fromRev, to_revision: toRev, current_revision: current, changes, summary },
      sources,
      coverage: { complete: !truncated, truncated, scope: `etcd ${client.id} ${relKey ? `键 ${prefix}${relKey}` : `前缀 ${prefix}`}，修订 ${fromRev} → ${toRev}`, notes },
    };
  },
});

// ---------------------------------------------------------------------------
// discovery list
// ---------------------------------------------------------------------------
const discoveryList = defineCapability({
  name: 'discovery.list',
  command: 'discovery list',
  domain: 'config',
  summary: '从服务注册中心（etcd v3 前缀注册 / Nacos 命名服务 / Consul 目录与健康检查）列出某服务的实例：地址、版本、健康与注册元数据',
  inputs: {
    service: { type: 'string', required: true, description: '服务 ID，如 demo-order' },
    env: { type: 'string', description: '按注册内容中的 env 字段过滤（不给则不过滤）' },
    healthy_only: { type: 'bool', default: false, description: '只返回自报 healthy=true 的实例' },
    endpoint: endpointInput,
  },
  output: DiscoveryOutput,
  adapter: ADAPTER,
  operation: 'read',
  auth_provider: AUTH,
  guide: GUIDE,
  prerequisites: ['etcd：endpoints.etcd（可选 discovery_prefix），实例以 <discovery_prefix><service>/<instance-id> → JSON 注册', 'Nacos：endpoints.nacos（可选 discovery_namespace / discovery_group）', 'Consul：endpoints.consul（token 需 service/node read）'],
  notes: [
    'healthy 来自实例写入的注册内容（自报），不是 workctl 的探测结果；要验证可达性用 network connectivity check',
    '带租约的注册在实例停止续约后按 TTL 自动删除；没有租约的注册永不过期，实例下线后可能残留',
    'remaining_ttl_s 为本次 /v3/lease/timetolive 的读数（采样），续约后会重置',
    PROVIDER_NOTE,
    'Nacos：GET /v1/ns/service + /v1/ns/catalog/instances（含 enabled=false 实例），healthy 为服务端健康状态，nacos 字段给出 cluster / weight / enabled / ephemeral；enabled=false（已下线）不计入 summary.healthy（见 summary.disabled），--healthy-only 时排除；--env 按 metadata.env 过滤',
    'Consul：GET /v1/health/service/<svc>，healthy 由检查聚合（任一 critical → false，warning 计为 healthy），consul 字段给出各检查（检查输出中的 URL 密码 / token= / Authorization 等凭据先遮蔽再截断到 300 字符）；服务不在 /v1/catalog/services 时 summary.service_registered=false',
    `Eureka / Kubernetes Endpoints / ${PLANNED_NOTE}`,
  ],
  examples: ['workctl discovery list --service demo-order', 'workctl discovery list --service demo-order --env sandbox --healthy-only', 'workctl discovery list --service demo-payment', 'workctl discovery list --service demo-inventory'],
  handler: async (ctx, i): Promise<Result> => {
    const p = resolveConfigProvider(ctx, String(i.service), i.env ? String(i.env) : ctx.env, i.endpoint);
    if (p.kind === 'nacos') return nacosDiscoveryList(ctx, i, p);
    if (p.kind === 'consul') return consulDiscoveryList(ctx, i, p);
    const client = etcdClient(ctx, p.name);
    const service = checkSegment('--service', String(i.service));
    const env = i.env ? checkSegment('--env', String(i.env)) : null;
    const prefix = `${normPrefix(client.endpoint.str('discovery_prefix', '/services/'))}${service}/`;
    const r = await client.range({ key: b64(prefix), range_end: b64(prefixRangeEnd(Buffer.from(prefix, 'utf8'))), limit: MAX_KEYS, sort_order: 'ASCEND', sort_target: 'KEY' });
    const observed = int(r.header?.revision);
    const sources: Source[] = [await client.source(`POST /v3/kv/range prefix=${prefix}`)];
    const excluded = { env_mismatch: 0, env_missing: 0, not_healthy: 0 };
    const leaseCache = new Map<string, { granted_ttl_s: number | null; remaining_ttl_s: number | null; error: string | null }>();
    const instances: Instance[] = [];
    let leaseQueried = false;
    for (const kv of r.kvs ?? []) {
      const key = unb64(kv.key).toString('utf8');
      const id = key.slice(prefix.length);
      // instance ids are not config names: mask by JSON field names only (payload is never shown unless it is a JSON object)
      const dv = decodeValue(unb64(kv.value), '');
      const p = dv.value_format === 'json' && dv.value && typeof dv.value === 'object' && !Array.isArray(dv.value) ? (dv.value as Record<string, unknown>) : null;
      const str = (v: unknown) => (v === undefined || v === null ? null : String(v));
      const instEnv = str(p?.env);
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
      const healthy = typeof p?.healthy === 'boolean' ? p.healthy : null;
      if (i.healthy_only && healthy !== true) {
        excluded.not_healthy++;
        continue;
      }
      let lease: Instance['lease'] = null;
      if (kv.lease && kv.lease !== '0') {
        const lid = String(kv.lease);
        if (!leaseCache.has(lid)) {
          leaseQueried = true;
          try {
            const t = await client.timeToLive(lid);
            leaseCache.set(lid, { granted_ttl_s: t.grantedTTL !== undefined ? int(t.grantedTTL) : null, remaining_ttl_s: int(t.TTL), error: null });
          } catch (e) {
            if (e instanceof WorkError && ['UNAUTHENTICATED', 'PERMISSION_DENIED'].includes(e.code)) throw e;
            leaseCache.set(lid, { granted_ttl_s: null, remaining_ttl_s: null, error: e instanceof Error ? e.message : String(e) });
          }
        }
        lease = { id: lid, ...leaseCache.get(lid)! };
      }
      const port = p?.port === undefined || p?.port === null ? null : Number(p.port);
      instances.push({
        instance_id: id,
        key,
        payload: p ?? null,
        payload_error: p ? null : dv.value_format === 'json' ? '注册内容不是 JSON 对象' : `注册内容不是 JSON（${dv.value_format}）`,
        address: str(p?.address),
        port: port !== null && Number.isFinite(port) ? port : null,
        version: str(p?.version),
        env: instEnv,
        healthy,
        health_basis: 'self_reported',
        registered_at: str(p?.registered_at),
        create_revision: int(kv.create_revision),
        mod_revision: int(kv.mod_revision),
        lease,
      });
    }
    if (leaseQueried) sources.push(await client.source('POST /v3/lease/timetolive', 'sampled'));
    const registered = Math.max(int(r.count), r.kvs?.length ?? 0); // etcd count = total under the prefix, even when truncated
    const truncated = !!r.more;
    const notes: string[] = [];
    if (!registered) notes.push(`前缀 ${prefix} 下没有注册（修订 ${observed}）：服务未注册、已全部下线（租约过期）或前缀不同`);
    else if (!instances.length) notes.push(`前缀下有 ${registered} 个注册，过滤后为空`);
    const noLease = instances.filter((x) => !x.lease).length;
    if (noLease) notes.push(`${noLease} 个实例的注册没有租约，不会因实例下线而自动过期`);
    if (instances.some((x) => x.lease?.remaining_ttl_s === -1)) notes.push('有租约 TTL=-1（已过期或已撤销），对应键应已被删除，可能是读取与过期之间的竞态');
    if (excluded.env_missing) notes.push(`${excluded.env_missing} 个注册没有 env 字段，按 --env 过滤时已排除`);
    if (truncated) notes.push(`注册超过 ${MAX_KEYS} 个，只返回前 ${MAX_KEYS} 个`);
    if (client.authNote) notes.push(client.authNote);
    const healthyN = instances.filter((x) => x.healthy === true).length;
    const unhealthyN = instances.filter((x) => x.healthy === false).length;
    return {
      status: truncated ? 'partial' : 'success',
      data: {
        endpoint: client.id,
        provider: 'etcd',
        provider_selected_by: p.origin,
        service,
        env,
        prefix,
        observed_revision: observed,
        instances,
        summary: { registered, returned: instances.length, healthy: healthyN, unhealthy: unhealthyN, health_unknown: instances.length - healthyN - unhealthyN, without_lease: noLease, excluded },
      },
      sources,
      coverage: { complete: !truncated, truncated, scope: `etcd ${client.id} 键前缀 ${prefix}，修订 ${observed}`, notes },
    };
  },
});

export default defineDomain({
  name: 'config',
  title: '配置与服务发现',
  summary: '配置中心与服务注册（etcd v3 JSON 网关 / Nacos Open API / Consul HTTP API，按端点类型选择）：配置读取、修订间差异、注册实例与健康',
  pillar: 'infrastructure',
  guide: GUIDE,
  skill: SKILL,
  capabilities: [configGet, configDiff, discoveryList],
  probes: {
    nacos: nacosProbe,
    consul: consulProbe,
    etcd: async (ctx, name) => {
      const client = etcdClient(ctx, name);
      const v = await client.getVersion();
      const st = await client.post<{ header?: { member_id?: string }; leader?: string; dbSize?: string; dbSizeInUse?: string; version?: string; errors?: string[] }>('/v3/maintenance/status', {});
      let auth = '';
      try {
        const a = await client.post<{ enabled?: boolean }>('/v3/auth/status', {});
        auth = `；认证${a.enabled ? '已开启' : '未开启'}`;
      } catch {
        auth = '';
      }
      const isLeader = st.leader && st.header?.member_id === st.leader;
      return {
        ok: true,
        identity: client.username ?? 'anonymous',
        version: v.etcdserver ?? st.version,
        detail: [
          `leader ${st.leader ?? '(无)'}${isLeader ? '（即本成员）' : ''}`,
          `db ${int(st.dbSize)} 字节（使用中 ${int(st.dbSizeInUse)}）`,
          v.etcdcluster ? `集群版本 ${v.etcdcluster}` : '',
          st.errors?.length ? `告警 ${st.errors.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('；') + auth + (client.authNote ? `；${client.authNote}` : ''),
      };
    },
  },
});
