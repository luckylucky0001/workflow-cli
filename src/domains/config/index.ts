import { z } from 'zod';
import { WorkError, type Result, type Source } from '../../core/output';
import { defineCapability, defineDomain } from '../../core/registry';
import type { Ctx } from '../../core/runtime';
import { b64, ETCD_ADAPTER, ETCD_AUTH, etcdClient, int, prefixRangeEnd, unb64, type EtcdClient, type EtcdKv, type RangeResponse } from './etcd';
import { checkRelKey, checkSegment, decodeValue, MASK, normPrefix, parseRev, toItem, type ConfigItem } from './values';

const GUIDE = 'docs/guides/infrastructure.md';
const SKILL = 'skills/infra-operations/SKILL.md';
const MAX_KEYS = 1000;

const MASK_NOTE = `键名或 JSON 字段名匹配敏感模式（password/passwd/pwd/secret/token/key/dsn/credential 等，按名称判断，不看值）的值以 "${MASK}" 替代，masked=true，masked_paths 标出位置`;

const ValueFields = {
  value: z.unknown().describe('JSON 可解析时为解析后的值，否则为文本；超出 ±2^53 的整数不做有损转换（单值为文本，JSON 内为数字字符串）；binary_base64 时为 base64；被遮蔽时为 "***"'),
  value_format: z.enum(['json', 'text', 'binary_base64', 'empty']),
  value_bytes: z.number().describe('原始值字节数（遮蔽前）'),
  masked: z.boolean(),
  masked_paths: z.array(z.string()).describe('被遮蔽的位置："$" 为整个值，"$.a.b" 为 JSON 字段'),
};

const ItemSchema = z.object({
  key: z.string().describe('etcd 完整键'),
  name: z.string().describe('服务前缀下的相对键名'),
  ...ValueFields,
  create_revision: z.number(),
  mod_revision: z.number(),
  version: z.number().describe('该键自创建以来的修改次数（删除后重建从 1 开始）'),
  lease: z.string().nullable().describe('绑定的租约 ID（十进制字符串）；null 表示无租约'),
});

const endpointInput = { type: 'string' as const, description: 'etcd 端点名（默认取 profile defaults.etcd）' };

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
  summary: '读取配置中心（etcd v3）中某服务某环境的配置项：当前值、修订号、版本与租约（敏感项遮蔽）',
  inputs: {
    service: { type: 'string', required: true, description: '服务 ID，如 demo-order' },
    env: { type: 'string', description: '环境；默认取 profile 的 env' },
    key: { type: 'string', description: '只读取一个配置项（服务前缀下的相对键名，如 cache.ttl_seconds）' },
    limit: { type: 'int', default: 200, description: `最多返回的键数（1-${MAX_KEYS}）` },
    endpoint: endpointInput,
  },
  output: z.object({
    endpoint: z.string(),
    service: z.string(),
    env: z.string(),
    prefix: z.string().describe('读取的 etcd 键前缀：<config_prefix><env>/<service>/'),
    key: z.string().nullable(),
    observed_revision: z.number().describe('响应头中的 etcd 集群当前修订（读取时刻）'),
    count: z.number().describe('前缀下的键总数（etcd count，可能大于返回数）'),
    truncated: z.boolean(),
    items: z.array(ItemSchema),
  }),
  adapter: ETCD_ADAPTER,
  operation: 'read',
  auth_provider: ETCD_AUTH,
  guide: GUIDE,
  prerequisites: ['profile 配置 endpoints.etcd（url，可选 config_prefix / username + password_ref）', '身份对该前缀有 read 权限（开启认证时）'],
  notes: [
    '读的是 etcd 当前已提交的值（线性一致读），observed_revision 是读取时刻的集群修订，不代表应用已加载该值',
    MASK_NOTE,
    '值为 JSON（对象/数组/数字/布尔）时返回解析后的值；非 UTF-8 字节以 base64 返回（value_format=binary_base64）',
    'mod_revision 是最后一次修改的集群修订；可作为 config diff --from-rev 的输入',
    'Nacos / Apollo / Consul KV 是规划中的 provider',
  ],
  examples: ['workctl config get --service demo-order --env sandbox', 'workctl config get --service demo-order --key cache.ttl_seconds'],
  handler: async (ctx, i): Promise<Result> => {
    const client = etcdClient(ctx, i.endpoint);
    const env = resolveEnvInput(ctx, i.env);
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
    if (masked) notes.push(`${masked} 个配置项的值或字段已遮蔽（按名称匹配敏感模式）`);
    if (truncated) notes.push(`前缀下共 ${count} 个键，只返回按键名排序的前 ${items.length} 个`);
    if (client.authNote) notes.push(client.authNote);
    return {
      data: { endpoint: client.id, service: String(i.service), env, prefix, key: relKey, observed_revision: observed, count, truncated, items },
      sources: [await client.source(relKey ? `POST /v3/kv/range key=${prefix}${relKey}` : `POST /v3/kv/range prefix=${prefix}`)],
      coverage: { complete: !truncated, truncated, limit: relKey ? undefined : limit, scope: `etcd ${client.id} 键前缀 ${prefix}，修订 ${observed}`, notes },
    };
  },
});

// ---------------------------------------------------------------------------
// config diff
// ---------------------------------------------------------------------------
const Side = z.object({ ...ValueFields, mod_revision: z.number(), version: z.number(), create_revision: z.number() }).nullable();

function side(it: ConfigItem | undefined): z.infer<typeof Side> {
  if (!it) return null;
  const { value, value_format, value_bytes, masked, masked_paths, mod_revision, version, create_revision } = it;
  return { value, value_format, value_bytes, masked, masked_paths, mod_revision, version, create_revision };
}

const configDiff = defineCapability({
  name: 'config.diff',
  command: 'config diff',
  domain: 'config',
  summary: '比较配置项在两个 etcd 修订之间的差异（新增/删除/修改，敏感值遮蔽）；不给 --from-rev 时与 --key 的上一版本比较',
  inputs: {
    service: { type: 'string', required: true, description: '服务 ID' },
    env: { type: 'string', description: '环境；默认取 profile 的 env' },
    key: { type: 'string', description: '只比较一个配置项（相对键名）' },
    from_rev: { type: 'int', description: '起始修订（集群修订号）；省略时须给 --key，取该键上一版本（mod_revision-1）' },
    to_rev: { type: 'string', default: 'current', description: '结束修订：正整数或 current' },
    endpoint: endpointInput,
  },
  output: z.object({
    endpoint: z.string(),
    service: z.string(),
    env: z.string(),
    prefix: z.string(),
    key: z.string().nullable(),
    mode: z.enum(['revisions', 'previous_version']),
    from_revision: z.number(),
    to_revision: z.number(),
    current_revision: z.number(),
    changes: z.array(z.object({
      name: z.string(),
      key: z.string(),
      change: z.enum(['added', 'removed', 'changed']),
      masked: z.boolean().describe('任一侧的值被遮蔽；遮蔽时 changed 仍按原始字节判断'),
      old: Side,
      new: Side,
    })),
    summary: z.object({ added: z.number(), removed: z.number(), changed: z.number(), unchanged: z.number(), rewritten_same_value: z.number().describe('值相同但在区间内被重新写入（mod_revision 变化）') }),
  }),
  adapter: ETCD_ADAPTER,
  operation: 'read',
  auth_provider: ETCD_AUTH,
  guide: GUIDE,
  prerequisites: ['profile 配置 endpoints.etcd', '起始修订不早于最近一次压缩（compaction）'],
  notes: [
    '修订号是 etcd 集群级的全局修订（任意键写入都会递增），不是单个配置项的版本号',
    '只比较两个修订时刻的快照：区间内改了又改回的值显示为未变化（计入 rewritten_same_value），中间值不可见',
    '历史只保留到最近一次压缩：早于压缩点的修订返回 DATA_UNAVAILABLE，details.compact_revision 为最早可读修订（二分探测得出）',
    '修订大于当前集群修订返回 INVALID_ARGUMENT；比较只读，不会触发压缩',
    MASK_NOTE,
  ],
  examples: [
    'workctl config diff --service demo-order --env sandbox --from-rev 2',
    'workctl config diff --service demo-order --key cache.ttl_seconds',
  ],
  handler: async (ctx, i): Promise<Result> => {
    const client = etcdClient(ctx, i.endpoint);
    const env = resolveEnvInput(ctx, i.env);
    const prefix = configPrefix(client, env, String(i.service));
    const relKey = i.key ? checkRelKey(String(i.key)) : null;
    const toArg = parseRev('--to-rev', i.to_rev ?? 'current');
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
    const changes = [];
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
      data: { endpoint: client.id, service: String(i.service), env, prefix, key: relKey, mode, from_revision: fromRev, to_revision: toRev, current_revision: current, changes, summary },
      sources,
      coverage: { complete: !truncated, truncated, scope: `etcd ${client.id} ${relKey ? `键 ${prefix}${relKey}` : `前缀 ${prefix}`}，修订 ${fromRev} → ${toRev}`, notes },
    };
  },
});

// ---------------------------------------------------------------------------
// discovery list
// ---------------------------------------------------------------------------
const InstanceSchema = z.object({
  instance_id: z.string().describe('<discovery_prefix><service>/ 之后的键名部分'),
  key: z.string(),
  payload: z.unknown().describe('注册内容（JSON 解析后，敏感字段遮蔽）；无法解析为 JSON 时为 null'),
  payload_error: z.string().nullable(),
  address: z.string().nullable(),
  port: z.number().nullable(),
  version: z.string().nullable(),
  env: z.string().nullable(),
  healthy: z.boolean().nullable().describe('实例自报的 healthy 字段；缺失为 null'),
  registered_at: z.string().nullable(),
  create_revision: z.number(),
  mod_revision: z.number(),
  lease: z
    .object({
      id: z.string(),
      granted_ttl_s: z.number().nullable(),
      remaining_ttl_s: z.number().nullable().describe('剩余 TTL（秒）；-1 表示租约已过期/不存在'),
      error: z.string().nullable(),
    })
    .nullable()
    .describe('null 表示注册未绑定租约：不会自动过期'),
});

const discoveryList = defineCapability({
  name: 'discovery.list',
  command: 'discovery list',
  domain: 'config',
  summary: '从服务注册中心（etcd v3 前缀注册）列出某服务的实例：地址、版本、自报健康、租约与剩余 TTL',
  inputs: {
    service: { type: 'string', required: true, description: '服务 ID，如 demo-order' },
    env: { type: 'string', description: '按注册内容中的 env 字段过滤（不给则不过滤）' },
    healthy_only: { type: 'bool', default: false, description: '只返回自报 healthy=true 的实例' },
    endpoint: endpointInput,
  },
  output: z.object({
    endpoint: z.string(),
    service: z.string(),
    env: z.string().nullable(),
    prefix: z.string(),
    observed_revision: z.number(),
    instances: z.array(InstanceSchema),
    summary: z.object({
      registered: z.number().describe('前缀下的注册键总数（过滤前）'),
      returned: z.number(),
      healthy: z.number(),
      unhealthy: z.number(),
      health_unknown: z.number(),
      without_lease: z.number(),
      excluded: z.object({ env_mismatch: z.number(), env_missing: z.number(), not_healthy: z.number() }),
    }),
  }),
  adapter: ETCD_ADAPTER,
  operation: 'read',
  auth_provider: ETCD_AUTH,
  guide: GUIDE,
  prerequisites: ['profile 配置 endpoints.etcd（url，可选 discovery_prefix）', '实例以 <discovery_prefix><service>/<instance-id> → JSON 注册'],
  notes: [
    'healthy 来自实例写入的注册内容（自报），不是 workctl 的探测结果；要验证可达性用 network connectivity check',
    '带租约的注册在实例停止续约后按 TTL 自动删除；没有租约的注册永不过期，实例下线后可能残留',
    'remaining_ttl_s 为本次 /v3/lease/timetolive 的读数（采样），续约后会重置',
    'Nacos / Consul / Eureka / Kubernetes Endpoints 是规划中的 provider',
  ],
  examples: ['workctl discovery list --service demo-order', 'workctl discovery list --service demo-order --env sandbox --healthy-only'],
  handler: async (ctx, i): Promise<Result> => {
    const client = etcdClient(ctx, i.endpoint);
    const service = checkSegment('--service', String(i.service));
    const env = i.env ? checkSegment('--env', String(i.env)) : null;
    const prefix = `${normPrefix(client.endpoint.str('discovery_prefix', '/services/'))}${service}/`;
    const r = await client.range({ key: b64(prefix), range_end: b64(prefixRangeEnd(Buffer.from(prefix, 'utf8'))), limit: MAX_KEYS, sort_order: 'ASCEND', sort_target: 'KEY' });
    const observed = int(r.header?.revision);
    const sources: Source[] = [await client.source(`POST /v3/kv/range prefix=${prefix}`)];
    const excluded = { env_mismatch: 0, env_missing: 0, not_healthy: 0 };
    const leaseCache = new Map<string, { granted_ttl_s: number | null; remaining_ttl_s: number | null; error: string | null }>();
    const instances: z.infer<typeof InstanceSchema>[] = [];
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
      let lease: z.infer<typeof InstanceSchema>['lease'] = null;
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
  summary: '配置中心与服务注册（etcd v3 JSON 网关）：配置读取、修订间差异、注册实例与租约',
  pillar: 'infrastructure',
  guide: GUIDE,
  skill: SKILL,
  capabilities: [configGet, configDiff, discoveryList],
  probes: {
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
