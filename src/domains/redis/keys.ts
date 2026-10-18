import { z } from 'zod';
import { WorkError } from '../../core/output';
import { defineCapability } from '../../core/registry';
import type { Ctx } from '../../core/runtime';
import { ADAPTER, AUTH_PROVIDER, GUIDE, maxmemoryPolicy, tryConfigGet, withRedis, type RedisSession } from './client';
import { percentile } from './info';
import { COMMON_PREREQS, INSTANCE } from './server';

// ------------------------------------------------------------------ SCAN sampling (budgeted)

export interface ScanResult {
  keys: string[];
  scan_calls: number;
  duplicates_seen: number;
  /** keys returned by SCAN after max_keys was reached (not sampled). */
  dropped: number;
  cursor_complete: boolean;
  stopped_by: 'cursor_complete' | 'max_keys' | 'max_scan_calls' | 'time_budget';
}

/**
 * Budgeted SCAN loop. SCAN may return a key more than once and COUNT is only a hint, so
 * keys are de-duplicated and the loop stops at max_keys / max_scan_calls / deadline.
 * `cursor_complete` means the cursor returned to 0 — a full iteration, which still is not
 * a consistent snapshot (keys added/removed during the scan may be missed).
 */
export async function scanSample(
  scan: (cursor: string) => Promise<[string, string[]]>,
  opts: { maxKeys: number; maxScanCalls: number; deadline?: number },
): Promise<ScanResult> {
  const seen = new Set<string>();
  let cursor = '0';
  let calls = 0;
  let dup = 0;
  // keys seen after the cap: a repeat of one of these is a duplicate, not another dropped key
  const droppedKeys = new Set<string>();
  let stopped: ScanResult['stopped_by'] = 'cursor_complete';
  do {
    if (calls >= opts.maxScanCalls) {
      stopped = 'max_scan_calls';
      break;
    }
    if (opts.deadline && Date.now() > opts.deadline) {
      stopped = 'time_budget';
      break;
    }
    const [next, batch] = await scan(cursor);
    calls++;
    for (const k of batch) {
      if (seen.has(k) || droppedKeys.has(k)) dup++;
      else if (seen.size < opts.maxKeys) seen.add(k);
      else droppedKeys.add(k);
    }
    cursor = String(next);
    if (seen.size >= opts.maxKeys && cursor !== '0') {
      stopped = 'max_keys';
      break;
    }
  } while (cursor !== '0');
  const dropped = droppedKeys.size;
  const complete = cursor === '0' && stopped === 'cursor_complete' && dropped === 0;
  if (cursor === '0' && dropped > 0) stopped = 'max_keys';
  return { keys: [...seen], scan_calls: calls, duplicates_seen: dup, dropped, cursor_complete: complete, stopped_by: stopped };
}

const ScanSchema = z.object({
  pattern: z.string(),
  scan_count_hint: z.number(),
  scan_calls: z.number(),
  unique_keys: z.number(),
  duplicates_seen: z.number(),
  cursor_complete: z.boolean().describe('游标在预算内回到 0（完整遍历一次，但仍不是一致性快照）'),
  stopped_by: z.enum(['cursor_complete', 'max_keys', 'max_scan_calls', 'time_budget']),
});

const SCAN_INPUTS = {
  instance: INSTANCE,
  pattern: { type: 'string' as const, default: '*', description: 'SCAN MATCH 模式，如 demo:order:*' },
  max_keys: { type: 'int' as const, default: 100, description: '最多采样的不同键数（上限 10000）' },
  max_scan_calls: { type: 'int' as const, default: 50, description: '最多 SCAN 调用次数（预算）' },
  scan_count: { type: 'int' as const, default: 100, description: 'SCAN COUNT 提示值（只是提示，不保证每次返回数量）' },
};

async function runScan(ctx: Ctx, s: RedisSession, i: Record<string, any>): Promise<{ scan: ScanResult; meta: z.infer<typeof ScanSchema>; maxKeys: number }> {
  const maxKeys = Math.max(1, Math.min(Number(i.max_keys), 10_000));
  const maxCalls = Math.max(1, Math.min(Number(i.max_scan_calls), 10_000));
  const count = Math.max(1, Math.min(Number(i.scan_count), 10_000));
  const pattern = String(i.pattern ?? '*');
  const scan = await scanSample((cursor) => s.cmd<[string, string[]]>('SCAN', cursor, 'MATCH', pattern, 'COUNT', count), {
    maxKeys,
    maxScanCalls: maxCalls,
    deadline: Date.now() + Math.max(500, ctx.remainingMs() - 3000),
  });
  return {
    scan,
    maxKeys,
    meta: {
      pattern,
      scan_count_hint: count,
      scan_calls: scan.scan_calls,
      unique_keys: scan.keys.length,
      duplicates_seen: scan.duplicates_seen,
      cursor_complete: scan.cursor_complete,
      stopped_by: scan.stopped_by,
    },
  };
}

/** Pipeline one or more commands per key, in chunks; returns per-key [err, value][] lists. */
async function perKey(s: RedisSession, keys: string[], build: (key: string) => (string | number)[][], chunk = 200): Promise<Array<Array<[Error | null, unknown]>>> {
  const out: Array<Array<[Error | null, unknown]>> = [];
  for (let k = 0; k < keys.length; k += chunk) {
    const part = keys.slice(k, k + chunk);
    const p = s.client.pipeline();
    let per = 0;
    for (const key of part) {
      const cmds = build(key);
      per = cmds.length;
      for (const [name, ...args] of cmds) p.call(String(name), args as (string | number)[]);
    }
    let res: Array<[Error | null, unknown]>;
    try {
      res = ((await p.exec()) ?? []) as Array<[Error | null, unknown]>;
    } catch (e) {
      throw s.fail(e);
    }
    for (let j = 0; j < part.length; j++) out.push(res.slice(j * per, j * per + per));
  }
  return out;
}

function firstNoPerm(rows: Array<Array<[Error | null, unknown]>>): Error | null {
  for (const r of rows) for (const [e] of r) if (e && /^NOPERM/.test(e.message)) return e;
  return null;
}

// ------------------------------------------------------------------ key sample

export const keySample = defineCapability({
  name: 'redis.key.sample',
  command: 'redis key sample',
  summary: '按模式有预算地 SCAN 采样键，统计类型与内存占用分布（p50/p90/p99/max）和最大键候选',
  domain: 'redis',
  inputs: SCAN_INPUTS,
  output: z.object({
    instance: z.string(),
    db: z.number(),
    keys_in_db: z.number().nullable().describe('DBSIZE（全库键数，含不匹配模式的键）'),
    scan: ScanSchema,
    sampled_keys: z.number(),
    vanished_keys: z.number().describe('SCAN 返回后、读取类型前已不存在的键'),
    type_counts: z.record(z.string(), z.number()),
    memory_bytes: z.object({ p50: z.number().nullable(), p90: z.number().nullable(), p99: z.number().nullable(), max: z.number().nullable(), mean: z.number().nullable(), sum_sampled: z.number() }),
    top_keys: z.array(z.object({ key: z.string(), type: z.string(), memory_bytes: z.number().nullable() })),
  }),
  adapter: ADAPTER,
  operation: 'diagnose',
  auth_provider: AUTH_PROVIDER,
  guide: GUIDE,
  prerequisites: [...COMMON_PREREQS, 'ACL +scan +type +memory|usage +dbsize，且对匹配的键有读权限'],
  notes: [
    '这是采样，不是一致性全量快照：SCAN 可能重复返回键（已去重）、COUNT 只是提示，遍历期间增删的键可能遗漏',
    'MEMORY USAGE 使用 SAMPLES 5 估算集合类型，是近似值；内存大小不是访问热度（热度用 redis key hot）',
    'coverage.complete=true 仅表示游标在预算内回到 0',
  ],
  examples: ['workctl redis key sample --instance demo-redis --pattern "demo:*" --max-keys 200'],
  handler: async (ctx, i) =>
    withRedis(ctx, i.instance, async (s) => {
      const { scan, meta, maxKeys } = await runScan(ctx, s, i);
      const rows = await perKey(s, scan.keys, (k) => [['TYPE', k], ['MEMORY', 'USAGE', k, 'SAMPLES', 5]]);
      const denied = firstNoPerm(rows);
      if (denied) throw s.fail(denied);
      const typeCounts: Record<string, number> = {};
      const sized: { key: string; type: string; memory_bytes: number | null }[] = [];
      let vanished = 0;
      rows.forEach((r, idx) => {
        const type = r[0]?.[0] ? 'error' : String(r[0]?.[1] ?? 'none');
        if (type === 'none') {
          vanished++;
          return;
        }
        typeCounts[type] = (typeCounts[type] ?? 0) + 1;
        const mem = r[1]?.[0] ? null : r[1]?.[1] === null ? null : Number(r[1]?.[1]);
        sized.push({ key: scan.keys[idx], type, memory_bytes: mem });
      });
      const sizes = sized.map((x) => x.memory_bytes).filter((x): x is number => typeof x === 'number').sort((a, b) => a - b);
      const sum = sizes.reduce((a, b) => a + b, 0);
      let dbsize: number | null = null;
      try {
        dbsize = Number(await s.cmd('DBSIZE'));
      } catch {
        dbsize = null;
      }
      const notes = [
        `采样: SCAN ${meta.scan_calls} 次，去重后 ${meta.unique_keys} 个键，重复返回 ${meta.duplicates_seen} 次，停止原因 ${meta.stopped_by}`,
        meta.cursor_complete ? '游标已回到 0（完整遍历一次，但不是一致性快照）' : '游标未回到 0：只覆盖了部分键空间，分布仅代表样本',
        'MEMORY USAGE 为近似值（SAMPLES 5）',
      ];
      if (vanished) notes.push(`${vanished} 个键在 SCAN 后已过期/删除/被淘汰`);
      return {
        data: {
          instance: s.ep.name,
          db: s.ep.num('db', 0) ?? 0,
          keys_in_db: Number.isFinite(dbsize) ? dbsize : null,
          scan: meta,
          sampled_keys: sized.length,
          vanished_keys: vanished,
          type_counts: typeCounts,
          memory_bytes: {
            p50: percentile(sizes, 50),
            p90: percentile(sizes, 90),
            p99: percentile(sizes, 99),
            max: sizes.length ? sizes[sizes.length - 1] : null,
            mean: sizes.length ? Math.round(sum / sizes.length) : null,
            sum_sampled: sum,
          },
          top_keys: [...sized].sort((a, b) => (b.memory_bytes ?? -1) - (a.memory_bytes ?? -1)).slice(0, 10),
        },
        sources: [await s.src(`SCAN MATCH ${meta.pattern} COUNT ${meta.scan_count_hint} + TYPE + MEMORY USAGE SAMPLES 5`, 'sampled')],
        coverage: { complete: meta.cursor_complete, sampled: true, scope: `pattern ${meta.pattern}`, limit: maxKeys, truncated: !meta.cursor_complete, notes },
      };
    }),
});

// ------------------------------------------------------------------ key hot (LFU)

export const keyHot = defineCapability({
  name: 'redis.key.hot',
  command: 'redis key hot',
  summary: '在 LFU 淘汰策略下按 OBJECT FREQ 找访问频度最高的键（对数计数器，不是 QPS）',
  domain: 'redis',
  inputs: { ...SCAN_INPUTS, top: { type: 'int', default: 10, description: '返回前 N 个' } },
  output: z.object({
    instance: z.string(),
    maxmemory_policy: z.string(),
    lfu: z.object({ log_factor: z.number().nullable(), decay_time_min: z.number().nullable() }),
    scan: ScanSchema,
    hot_keys: z.array(z.object({ key: z.string(), lfu_counter: z.number() })),
    counter_distribution: z.object({ p50: z.number().nullable(), p90: z.number().nullable(), max: z.number().nullable() }),
  }),
  adapter: ADAPTER,
  operation: 'diagnose',
  auth_provider: AUTH_PROVIDER,
  guide: GUIDE,
  prerequisites: [...COMMON_PREREQS, 'maxmemory-policy 为 allkeys-lfu 或 volatile-lfu；ACL +scan +object|freq'],
  notes: [
    'OBJECT FREQ 是 0–255 的对数概率计数器（受 lfu-log-factor 影响），随时间衰减（lfu-decay-time），不是 QPS，也不能跨实例比较',
    '非 LFU 策略时返回 COLLECTION_DISABLED（Redis 没有在跟踪访问频度）',
    '热度与内存大小是不同维度：大键用 redis key sample',
    '基于 SCAN 采样，可能遗漏热键',
  ],
  examples: ['workctl redis key hot --instance demo-redis --pattern "demo:*" --max-keys 500'],
  handler: async (ctx, i) =>
    withRedis(ctx, i.instance, async (s) => {
      const policy = await maxmemoryPolicy(s);
      if (!policy || !policy.endsWith('-lfu')) {
        throw new WorkError('COLLECTION_DISABLED', `maxmemory-policy=${policy ?? 'unknown'}，Redis 未跟踪 LFU 访问频度，无法用 OBJECT FREQ 识别热键`, {
          hint: '可改用 allkeys-lfu/volatile-lfu 策略（影响淘汰行为，需评估），或在应用侧/代理层统计键访问；不要用 MEMORY USAGE 代替热度',
          details: { maxmemory_policy: policy },
        });
      }
      const { scan, meta } = await runScan(ctx, s, i);
      const rows = await perKey(s, scan.keys, (k) => [['OBJECT', 'FREQ', k]]);
      const denied = firstNoPerm(rows);
      if (denied) throw s.fail(denied);
      const freq: { key: string; lfu_counter: number }[] = [];
      rows.forEach((r, idx) => {
        if (!r[0]?.[0] && r[0]?.[1] !== null && r[0]?.[1] !== undefined) freq.push({ key: scan.keys[idx], lfu_counter: Number(r[0][1]) });
      });
      const sorted = freq.map((f) => f.lfu_counter).sort((a, b) => a - b);
      const cfg = await tryConfigGet(s, 'lfu-*');
      const top = Math.max(1, Math.min(Number(i.top), 100));
      return {
        data: {
          instance: s.ep.name,
          maxmemory_policy: policy,
          lfu: {
            log_factor: cfg.values?.['lfu-log-factor'] !== undefined ? Number(cfg.values['lfu-log-factor']) : null,
            decay_time_min: cfg.values?.['lfu-decay-time'] !== undefined ? Number(cfg.values['lfu-decay-time']) : null,
          },
          scan: meta,
          hot_keys: [...freq].sort((a, b) => b.lfu_counter - a.lfu_counter).slice(0, top),
          counter_distribution: { p50: percentile(sorted, 50), p90: percentile(sorted, 90), max: sorted.length ? sorted[sorted.length - 1] : null },
        },
        sources: [await s.src(`SCAN MATCH ${meta.pattern} + OBJECT FREQ`, 'sampled')],
        coverage: {
          complete: meta.cursor_complete,
          sampled: true,
          scope: `pattern ${meta.pattern}`,
          notes: [
            'lfu_counter 是对数概率计数器（0–255），不是 QPS；新写入的键初始值为 5',
            ...(cfg.values ? [] : [`无法读取 lfu-* 配置（${cfg.reason}）`]),
            `采样: SCAN ${meta.scan_calls} 次，去重后 ${meta.unique_keys} 个键，停止原因 ${meta.stopped_by}`,
          ],
        },
      };
    }),
});

// ------------------------------------------------------------------ key inspect

const VALUE_STRING_MAX = 1024;
const VALUE_ITEMS_MAX = 20;

function decode(v: unknown): { text: string; encoding: 'utf8' | 'base64' } {
  const buf = Buffer.isBuffer(v) ? v : Buffer.from(String(v ?? ''), 'utf8');
  const text = buf.toString('utf8');
  if (!text.includes('�')) return { text, encoding: 'utf8' };
  return { text: buf.toString('base64'), encoding: 'base64' };
}

export const keyInspect = defineCapability({
  name: 'redis.key.inspect',
  command: 'redis key inspect',
  summary: '查看单个键的类型、TTL、编码、近似内存、长度与 LFU 计数；可选读取截断后的值',
  domain: 'redis',
  inputs: {
    instance: INSTANCE,
    key: { type: 'string', required: true, description: '键名' },
    include_value: { type: 'bool', default: false, description: '读取值（字符串 ≤1KB，集合前 20 个元素）；会更新该键的 LFU/LRU 访问信息' },
  },
  output: z.object({
    instance: z.string(),
    key: z.string(),
    type: z.string(),
    ttl_ms: z.number().nullable().describe('剩余 TTL（毫秒）；null 表示没有过期时间'),
    expires_at: z.string().nullable(),
    encoding: z.string().nullable(),
    memory_bytes: z.number().nullable().describe('MEMORY USAGE SAMPLES 5，近似值'),
    length: z.number().nullable().describe('STRLEN/LLEN/HLEN/SCARD/ZCARD/XLEN'),
    lfu_counter: z.number().nullable(),
    lfu_note: z.string(),
    value: z
      .object({
        kind: z.enum(['string', 'list', 'hash', 'set', 'zset', 'stream']),
        encoding: z.enum(['utf8', 'base64', 'mixed']),
        data: z.unknown(),
        returned: z.number(),
        truncated: z.boolean(),
      })
      .nullable(),
  }),
  adapter: ADAPTER,
  operation: 'read',
  auth_provider: AUTH_PROVIDER,
  guide: GUIDE,
  prerequisites: [...COMMON_PREREQS, 'ACL +type +pttl +object +memory|usage 与对应长度命令；--include-value 需要读命令权限'],
  notes: [
    '键不存在返回 NOT_FOUND（PTTL=-2）；PTTL=-1 表示没有过期时间（ttl_ms=null）',
    'MEMORY USAGE 为近似值（SAMPLES 5）；内存大小不是访问热度',
    'lfu_counter 仅在 maxmemory-policy 为 *-lfu 时有意义，否则为 null 并说明原因',
    '--include-value 会读取值（计入 keyspace_hits，并更新 LFU/LRU），值可能含业务数据，按需开启',
  ],
  examples: ['workctl redis key inspect --instance demo-redis --key demo:order:1', 'workctl redis key inspect --instance demo-redis --key demo:customer:1:recent --include-value'],
  handler: async (ctx, i) =>
    withRedis(ctx, i.instance, async (s) => {
      const key = String(i.key);
      const [[e1, type], [e2, pttl], [e3, enc], [e4, mem]] = ((await (async () => {
        const p = s.client.pipeline();
        p.call('TYPE', [key]);
        p.call('PTTL', [key]);
        p.call('OBJECT', ['ENCODING', key]);
        p.call('MEMORY', ['USAGE', key, 'SAMPLES', 5]);
        try {
          return await p.exec();
        } catch (e) {
          throw s.fail(e);
        }
      })()) ?? []) as Array<[Error | null, unknown]>;
      for (const e of [e1, e2]) if (e) throw s.fail(e);
      if (e3) {
        // an ACL-denied OBJECT ENCODING must not read as "no encoding"
        if (!/^NOPERM/.test(e3.message)) throw s.fail(e3);
        ctx.warn(`OBJECT ENCODING 被 ACL 拒绝，encoding 为 null: ${e3.message}`);
      }
      if (e4) {
        if (!/^NOPERM/.test(e4.message)) throw s.fail(e4);
        ctx.warn(`MEMORY USAGE 被 ACL 拒绝，memory_bytes 为 null: ${e4.message}`);
      }
      if (type === 'none' || Number(pttl) === -2) {
        throw new WorkError('NOT_FOUND', `键不存在: ${key}`, { hint: '键可能已过期、被删除或被淘汰；用 redis key sample --pattern 查看现有键' });
      }
      const t = String(type);
      const lenCmd: Record<string, string> = { string: 'STRLEN', list: 'LLEN', hash: 'HLEN', set: 'SCARD', zset: 'ZCARD', stream: 'XLEN' };
      const length = lenCmd[t] ? Number(await s.cmd(lenCmd[t], key)) : null;
      const policy = await maxmemoryPolicy(s);
      let lfu: number | null = null;
      let lfuNote: string;
      if (policy && policy.endsWith('-lfu')) {
        try {
          lfu = Number(await s.cmd('OBJECT', 'FREQ', key));
          lfuNote = `maxmemory-policy=${policy}：OBJECT FREQ 为对数计数器（0–255），不是 QPS`;
        } catch (e) {
          if (!(e instanceof WorkError && e.code === 'PERMISSION_DENIED')) throw e;
          lfuNote = `OBJECT FREQ 被 ACL 拒绝（null）: ${e.message}`;
        }
      } else lfuNote = `maxmemory-policy=${policy ?? 'unknown'}，Redis 未跟踪 LFU 频度（null）`;

      let value: { kind: string; encoding?: 'utf8' | 'base64' | 'mixed'; data: unknown; returned: number; truncated: boolean } | null = null;
      if (i.include_value) {
        const kinds = new Set<string>();
        const conv = (v: unknown) => {
          const d = decode(v);
          kinds.add(d.encoding);
          return d.text;
        };
        if (t === 'string') {
          const raw = await s.client.callBuffer('GETRANGE', [key, 0, VALUE_STRING_MAX - 1]);
          value = { kind: 'string', data: conv(raw), returned: Math.min(length ?? 0, VALUE_STRING_MAX), truncated: (length ?? 0) > VALUE_STRING_MAX };
        } else if (t === 'list') {
          const raw = (await s.client.callBuffer('LRANGE', [key, 0, VALUE_ITEMS_MAX - 1])) as unknown[];
          value = { kind: 'list', data: raw.map((x) => clip(conv(x))), returned: raw.length, truncated: (length ?? 0) > raw.length };
        } else if (t === 'hash') {
          const [, flat] = (await s.client.callBuffer('HSCAN', [key, 0, 'COUNT', VALUE_ITEMS_MAX])) as [unknown, unknown[]];
          const pairs: Record<string, string> = {};
          for (let k = 0; k + 1 < flat.length && Object.keys(pairs).length < VALUE_ITEMS_MAX; k += 2) pairs[conv(flat[k])] = clip(conv(flat[k + 1]));
          value = { kind: 'hash', data: pairs, returned: Object.keys(pairs).length, truncated: (length ?? 0) > Object.keys(pairs).length };
        } else if (t === 'set') {
          const [, members] = (await s.client.callBuffer('SSCAN', [key, 0, 'COUNT', VALUE_ITEMS_MAX])) as [unknown, unknown[]];
          const arr = members.slice(0, VALUE_ITEMS_MAX).map((x) => clip(conv(x)));
          value = { kind: 'set', data: arr, returned: arr.length, truncated: (length ?? 0) > arr.length };
        } else if (t === 'zset') {
          const flat = (await s.client.callBuffer('ZRANGE', [key, 0, VALUE_ITEMS_MAX - 1, 'WITHSCORES'])) as unknown[];
          const arr: { member: string; score: number }[] = [];
          for (let k = 0; k + 1 < flat.length; k += 2) arr.push({ member: clip(conv(flat[k])), score: Number(String(flat[k + 1])) });
          value = { kind: 'zset', data: arr, returned: arr.length, truncated: (length ?? 0) > arr.length };
        } else if (t === 'stream') {
          const raw = ((await s.client.callBuffer('XRANGE', [key, '-', '+', 'COUNT', VALUE_ITEMS_MAX])) ?? []) as unknown[];
          // field values are clipped like other collection members (entries can hold large payloads)
          const entries = raw.map((e) => {
            const [id, fields] = e as [unknown, unknown[]];
            return { id: String(id), fields: (fields ?? []).map((f) => clip(conv(f))) };
          });
          value = { kind: 'stream', data: entries, returned: entries.length, truncated: (length ?? 0) > entries.length };
        }
        if (value) value.encoding = kinds.size > 1 ? 'mixed' : ((kinds.values().next().value as 'utf8' | 'base64' | undefined) ?? 'utf8');
      }
      const ttl = Number(pttl);
      return {
        data: {
          instance: s.ep.name,
          key,
          type: t,
          ttl_ms: ttl >= 0 ? ttl : null,
          expires_at: ttl >= 0 ? new Date(Date.now() + ttl).toISOString() : null,
          encoding: enc === null || enc === undefined ? null : String(enc),
          memory_bytes: e4 || mem === null || mem === undefined ? null : Number(mem),
          length,
          lfu_counter: lfu,
          lfu_note: lfuNote,
          value,
        },
        sources: [await s.src(`TYPE / PTTL / OBJECT ENCODING / MEMORY USAGE SAMPLES 5${lenCmd[t] ? ` / ${lenCmd[t]}` : ''}${lfu !== null ? ' / OBJECT FREQ' : ''}${i.include_value ? ' / value read' : ''}`)],
        coverage: {
          complete: !value?.truncated,
          truncated: !!value?.truncated,
          notes: [
            'memory_bytes 为 MEMORY USAGE 近似值',
            ...(value?.truncated ? [`值已截断（字符串前 ${VALUE_STRING_MAX} 字节 / 集合前 ${VALUE_ITEMS_MAX} 个元素）`] : []),
            ...(i.include_value ? ['读取值会计入 keyspace_hits 并更新该键的 LFU/LRU 信息'] : []),
          ],
        },
      };
    }),
});

function clip(s: string, max = VALUE_STRING_MAX): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
