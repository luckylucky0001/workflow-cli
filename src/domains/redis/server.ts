import { z } from 'zod';
import { WorkError, type Source } from '../../core/output';
import { defineCapability, type InputSpec } from '../../core/registry';
import { sleep } from '../../core/runtime';
import { ADAPTER, AUTH_PROVIDER, GUIDE, bindingFor, infoSections, tryConfigGet, withRedis } from './client';
import { isSensitiveConfig, parseInfo, redactCommand, semanticsOf, snapshotFromInfo, windowDelta, WINDOW_COUNTERS, type InfoSections } from './info';

export const INSTANCE: InputSpec = { type: 'string', description: 'Redis 端点名（profile 中 endpoints.redis 的键；缺省取 defaults.redis）' };
export const COMMON_PREREQS = ['profile 中配置 endpoints.redis.<name>（host/port，可选 username/password_ref/db）', '账号需允许 INFO（ACL +info）'];

const INFO_SECTIONS = ['server', 'clients', 'memory', 'persistence', 'stats', 'replication', 'cpu', 'modules', 'commandstats', 'errorstats', 'latencystats', 'cluster', 'keyspace', 'all', 'default', 'everything'];

function g(info: InfoSections, section: string, key: string): string | number | null {
  const v = info[section]?.[key];
  return v === undefined || typeof v === 'object' ? null : v;
}
function n(info: InfoSections, section: string, key: string): number | null {
  const v = g(info, section, key);
  return typeof v === 'number' ? v : v === null ? null : Number.isFinite(Number(v)) ? Number(v) : null;
}

const BindingSchema = z
  .object({ id: z.string(), type: z.string(), env: z.string().nullable(), owner: z.string().nullable(), labels: z.record(z.string(), z.string()), attributes: z.record(z.string(), z.unknown()) })
  .nullable()
  .describe('平台元数据（资源绑定文件），不是引擎查询结果');

export const instanceGet = defineCapability({
  name: 'redis.instance.get',
  command: 'redis instance get',
  summary: '查看 Redis 实例概况：版本、角色、连接数、内存与淘汰策略、持久化状态，并附平台绑定元数据',
  domain: 'redis',
  inputs: { instance: INSTANCE },
  output: z.object({
    instance: z.string(),
    binding: BindingSchema,
    server: z.object({ redis_version: z.string().nullable(), redis_mode: z.string().nullable(), run_id: z.string().nullable(), uptime_s: z.number().nullable(), started_at: z.string().nullable(), tcp_port: z.number().nullable() }),
    replication: z.object({ role: z.string().nullable(), connected_slaves: z.number().nullable(), master_host: z.string().nullable(), master_link_status: z.string().nullable() }),
    clients: z.object({ connected_clients: z.number().nullable(), blocked_clients: z.number().nullable(), maxclients: z.number().nullable() }),
    memory: z.object({
      used_memory: z.number().nullable(),
      used_memory_human: z.string().nullable(),
      used_memory_peak: z.number().nullable(),
      maxmemory: z.number().nullable(),
      maxmemory_human: z.string().nullable(),
      maxmemory_policy: z.string().nullable(),
      usage_ratio: z.number().nullable().describe('used_memory/maxmemory；maxmemory=0（不限）时为 null'),
      mem_fragmentation_ratio: z.number().nullable(),
    }),
    persistence: z.object({
      loading: z.boolean().nullable(),
      rdb_last_bgsave_status: z.string().nullable(),
      rdb_last_save_at: z.string().nullable(),
      rdb_changes_since_last_save: z.number().nullable(),
      aof_enabled: z.boolean().nullable(),
      aof_last_write_status: z.string().nullable(),
    }),
    keyspace: z.record(z.string(), z.record(z.string(), z.union([z.string(), z.number()]))),
  }),
  adapter: ADAPTER,
  operation: 'read',
  auth_provider: AUTH_PROVIDER,
  guide: GUIDE,
  prerequisites: COMMON_PREREQS,
  notes: ['binding 来自资源绑定文件（平台元数据），其余来自 INFO 实时查询；connected_clients 等为瞬时值，命中率等窗口指标用 redis stats sample'],
  examples: ['workctl redis instance get --instance demo-redis'],
  handler: async (ctx, i) =>
    withRedis(ctx, i.instance, async (s) => {
      const info = await infoSections(s, ['server', 'replication', 'persistence', 'clients', 'memory', 'keyspace']);
      const { binding, source: bsrc } = bindingFor(ctx, 'redis', s.ep.name);
      const uptime = n(info, 'server', 'uptime_in_seconds');
      const maxmem = n(info, 'memory', 'maxmemory');
      const used = n(info, 'memory', 'used_memory');
      const lastSave = n(info, 'persistence', 'rdb_last_save_time');
      const sources: Source[] = [await s.src('INFO server replication persistence clients memory keyspace')];
      if (bsrc) sources.push(bsrc);
      const str = (sec: string, k: string) => {
        const v = g(info, sec, k);
        return v === null ? null : String(v);
      };
      return {
        data: {
          instance: s.ep.name,
          binding,
          server: {
            redis_version: str('server', 'redis_version'),
            redis_mode: str('server', 'redis_mode'),
            run_id: str('server', 'run_id'),
            uptime_s: uptime,
            started_at: uptime !== null ? new Date(Date.now() - uptime * 1000).toISOString() : null,
            tcp_port: n(info, 'server', 'tcp_port'),
          },
          replication: {
            role: str('replication', 'role'),
            connected_slaves: n(info, 'replication', 'connected_slaves'),
            master_host: str('replication', 'master_host'),
            master_link_status: str('replication', 'master_link_status'),
          },
          clients: { connected_clients: n(info, 'clients', 'connected_clients'), blocked_clients: n(info, 'clients', 'blocked_clients'), maxclients: n(info, 'clients', 'maxclients') },
          memory: {
            used_memory: used,
            used_memory_human: str('memory', 'used_memory_human'),
            used_memory_peak: n(info, 'memory', 'used_memory_peak'),
            maxmemory: maxmem,
            maxmemory_human: str('memory', 'maxmemory_human'),
            maxmemory_policy: str('memory', 'maxmemory_policy'),
            usage_ratio: maxmem && used !== null ? Math.round((used / maxmem) * 10000) / 10000 : null,
            mem_fragmentation_ratio: n(info, 'memory', 'mem_fragmentation_ratio'),
          },
          persistence: {
            loading: n(info, 'persistence', 'loading') === null ? null : n(info, 'persistence', 'loading') === 1,
            rdb_last_bgsave_status: str('persistence', 'rdb_last_bgsave_status'),
            rdb_last_save_at: lastSave ? new Date(lastSave * 1000).toISOString() : null,
            rdb_changes_since_last_save: n(info, 'persistence', 'rdb_changes_since_last_save'),
            aof_enabled: n(info, 'persistence', 'aof_enabled') === null ? null : n(info, 'persistence', 'aof_enabled') === 1,
            aof_last_write_status: str('persistence', 'aof_last_write_status'),
          },
          keyspace: Object.fromEntries(Object.entries(info.keyspace ?? {}).filter(([, v]) => typeof v === 'object')) as Record<string, Record<string, string | number>>,
        },
        sources,
        coverage: { complete: true, notes: binding ? [] : ['资源绑定中没有该端点的平台元数据（binding=null）'] },
      };
    }),
});

export const infoGet = defineCapability({
  name: 'redis.info.get',
  command: 'redis info get',
  summary: '读取并解析 INFO 指定分区，逐项标注累计值/瞬时值/静态值',
  domain: 'redis',
  inputs: {
    instance: INSTANCE,
    section: { type: 'enum', enum: INFO_SECTIONS, default: 'default', description: 'INFO 分区；all/everything 返回全部' },
  },
  output: z.object({
    instance: z.string(),
    section: z.string(),
    sections: z.record(z.string(), z.record(z.string(), z.unknown())),
    semantics: z.record(z.string(), z.record(z.string(), z.enum(['cumulative_since_start', 'gauge', 'instantaneous_estimate', 'static', 'timestamp']))),
  }),
  adapter: ADAPTER,
  operation: 'read',
  auth_provider: AUTH_PROVIDER,
  guide: GUIDE,
  prerequisites: COMMON_PREREQS,
  notes: [
    'cumulative_since_start：自启动（或 CONFIG RESETSTAT）以来的累计值，不是窗口值；窗口差分用 redis stats sample',
    'instantaneous_estimate：服务端对最近约 1.6 秒的抽样估算，不是精确窗口值',
  ],
  examples: ['workctl redis info get --instance demo-redis --section stats'],
  handler: async (ctx, i) =>
    withRedis(ctx, i.instance, async (s) => {
      const info = parseInfo(String(await s.cmd('INFO', String(i.section))));
      const semantics: Record<string, Record<string, ReturnType<typeof semanticsOf>>> = {};
      for (const [sec, kv] of Object.entries(info)) {
        semantics[sec] = Object.fromEntries(Object.keys(kv).map((k) => [k, semanticsOf(sec, k)]));
      }
      return {
        data: { instance: s.ep.name, section: String(i.section), sections: info, semantics },
        sources: [await s.src(`INFO ${i.section}`)],
        coverage: { complete: true },
      };
    }),
});

export const statsSample = defineCapability({
  name: 'redis.stats.sample',
  command: 'redis stats sample',
  summary: '在同一连接上两次采样 INFO，计算窗口内命中率、命令数、淘汰/过期等增量与速率（处理重启与计数器重置）',
  domain: 'redis',
  inputs: {
    instance: INSTANCE,
    duration: { type: 'duration', default: '10s', description: '采样窗口（须小于 --timeout，默认 30s）' },
  },
  output: z.object({
    instance: z.string(),
    window: z.object({ start: z.string(), end: z.string(), duration_ms: z.number() }),
    restart_detected: z.boolean(),
    reset_counters: z.array(z.string()),
    deltas: z.record(z.string(), z.number().nullable()),
    rates_per_sec: z.record(z.string(), z.number().nullable()),
    hit_ratio: z.number().nullable(),
    hit_ratio_note: z.string(),
    gauges_at_end: z.object({
      used_memory: z.number().nullable(),
      maxmemory: z.number().nullable(),
      connected_clients: z.number().nullable(),
      mem_fragmentation_ratio: z.number().nullable(),
      instantaneous_ops_per_sec: z.number().nullable(),
    }),
    self_commands_in_window: z.number().describe('窗口内 workctl 自身发出的命令数（已计入 total_commands_processed）'),
  }),
  adapter: ADAPTER,
  operation: 'diagnose',
  auth_provider: AUTH_PROVIDER,
  guide: GUIDE,
  prerequisites: COMMON_PREREQS,
  notes: [
    '窗口值 = 第二次 INFO − 第一次 INFO；命令会等待整个窗口，窗口须小于 --timeout',
    'run_id 变化或 uptime 回退视为重启：增量为 null 且结果标记 partial；计数器回退（CONFIG RESETSTAT）同样处理，绝不输出负数',
    'hit_ratio = hits/(hits+misses)；窗口内没有键查找时为 null（不是 0）',
    'total_commands_processed 包含 workctl 自身的 1 条 INFO 命令',
  ],
  examples: ['workctl redis stats sample --instance demo-redis --duration 10s', 'workctl --timeout 60s redis stats sample --instance demo-redis --duration 30s'],
  handler: async (ctx, i) => {
    const ms = Number(i.duration);
    if (ms <= 0) throw new WorkError('INVALID_ARGUMENT', '--duration 必须大于 0', { hint: '累计值请用 redis info get --section stats' });
    const budget = ctx.remainingMs();
    if (ms + 2000 > budget) {
      throw new WorkError('INVALID_ARGUMENT', `采样窗口 ${Math.round(ms / 1000)}s 超过剩余时间预算 ${Math.floor(budget / 1000)}s`, {
        hint: `增大 --timeout（如 --timeout ${Math.ceil((ms + 10_000) / 1000)}s）或缩小 --duration`,
      });
    }
    return withRedis(ctx, i.instance, async (s) => {
      const t0 = Date.now();
      const a = await infoSections(s, ['server', 'stats', 'memory', 'clients']);
      await sleep(ms, ctx.signal);
      let t1 = Date.now();
      let reconnected = false;
      let b: InfoSections;
      try {
        b = await infoSections(s, ['server', 'stats', 'memory', 'clients']);
      } catch (e) {
        // The connection may have been dropped by a restart/failover inside the window: take the
        // second sample on a fresh connection; run_id/uptime then tell whether it restarted.
        if (!(e instanceof WorkError && e.code === 'UPSTREAM_UNAVAILABLE')) throw e;
        reconnected = true;
        b = await withRedis(ctx, i.instance, async (s2) => infoSections(s2, ['server', 'stats', 'memory', 'clients']));
        t1 = Date.now();
      }
      const d = windowDelta(snapshotFromInfo(a, t0), snapshotFromInfo(b, t1));
      const partial = d.restart_detected || d.reset_counters.length > 0 || reconnected;
      const notes: string[] = [];
      if (reconnected) notes.push('窗口内连接中断，第二次采样使用了新连接（可能发生重启或故障切换）');
      if (d.restart_detected) notes.push('窗口内检测到重启（run_id 变化或 uptime 回退），计数器增量不可用（null）');
      if (d.reset_counters.length) notes.push(`计数器回退（可能执行了 CONFIG RESETSTAT）: ${d.reset_counters.join(', ')}，对应增量为 null`);
      notes.push(d.hit_ratio_note, 'total_commands_processed 增量包含 workctl 自身的 1 条 INFO 命令');
      return {
        status: partial ? 'partial' : 'success',
        data: {
          instance: s.ep.name,
          window: { start: new Date(t0).toISOString(), end: new Date(t1).toISOString(), duration_ms: d.duration_ms },
          restart_detected: d.restart_detected,
          reset_counters: d.reset_counters,
          deltas: d.deltas,
          rates_per_sec: d.rates_per_sec,
          hit_ratio: d.hit_ratio,
          hit_ratio_note: d.hit_ratio_note,
          gauges_at_end: {
            used_memory: n(b, 'memory', 'used_memory'),
            maxmemory: n(b, 'memory', 'maxmemory'),
            connected_clients: n(b, 'clients', 'connected_clients'),
            mem_fragmentation_ratio: n(b, 'memory', 'mem_fragmentation_ratio'),
            instantaneous_ops_per_sec: n(b, 'stats', 'instantaneous_ops_per_sec'),
          },
          self_commands_in_window: 1,
        },
        sources: [await s.src(`INFO stats ×2 (Δ ${WINDOW_COUNTERS.join(', ')})`, 'derived')],
        coverage: { complete: !partial, window: { start: new Date(t0).toISOString(), end: new Date(t1).toISOString() }, notes },
      };
    });
  },
});

export const slowlogList = defineCapability({
  name: 'redis.slowlog.list',
  command: 'redis slowlog list',
  summary: '读取 Redis 慢日志（SLOWLOG GET），参数脱敏，只保留命令与键名',
  domain: 'redis',
  inputs: { instance: INSTANCE, limit: { type: 'int', default: 10, description: '最多返回条数（最新在前）' } },
  output: z.object({
    instance: z.string(),
    config: z.object({ slower_than_us: z.number().nullable(), max_len: z.number().nullable(), config_readable: z.boolean() }),
    retained_entries: z.number().nullable().describe('SLOWLOG LEN：当前保留的条数'),
    entries: z.array(
      z.object({
        id: z.number(),
        timestamp: z.string(),
        duration_us: z.number(),
        command: z.string(),
        key: z.string().nullable(),
        args: z.array(z.string()).describe('除键名外的参数替换为 ?'),
        arg_count: z.number(),
        client_addr: z.string().nullable(),
        client_name: z.string().nullable(),
      }),
    ),
  }),
  adapter: ADAPTER,
  operation: 'read',
  auth_provider: AUTH_PROVIDER,
  guide: GUIDE,
  prerequisites: [...COMMON_PREREQS, 'ACL +slowlog；读取阈值需要 +config|get（无权限时阈值显示为 unknown）'],
  notes: [
    '慢日志只含命令执行时间，不含网络往返、排队等待与 I/O；客户端看到的延迟可能远大于 duration_us',
    '只保留最近 slowlog-max-len 条，更早的已被覆盖；slowlog-log-slower-than 为负数时表示关闭',
    '参数中只保留命令（含子命令）与键名，其余值替换为 ?',
  ],
  examples: ['workctl redis slowlog list --instance demo-redis --limit 10'],
  handler: async (ctx, i) =>
    withRedis(ctx, i.instance, async (s) => {
      const limit = Math.max(1, Math.min(Number(i.limit), 1000));
      const cfg = await tryConfigGet(s, 'slowlog-*');
      const slower = cfg.values?.['slowlog-log-slower-than'];
      const maxLen = cfg.values?.['slowlog-max-len'];
      if (slower !== undefined && Number(slower) < 0) {
        throw new WorkError('COLLECTION_DISABLED', `实例 ${s.ep.name} 的慢日志已关闭 (slowlog-log-slower-than=${slower})`, {
          hint: 'CONFIG SET slowlog-log-slower-than 10000（单位微秒，需管理员权限）；关闭时无法判断是否有慢命令',
        });
      }
      const raw = (await s.cmd<unknown[]>('SLOWLOG', 'GET', limit)) ?? [];
      const len = Number(await s.cmd('SLOWLOG', 'LEN'));
      const entries = raw.map((e) => {
        const x = e as unknown[];
        const args = ((x[3] as unknown[]) ?? []).map((a) => String(a));
        const r = redactCommand(args);
        return {
          id: Number(x[0]),
          timestamp: new Date(Number(x[1]) * 1000).toISOString(),
          duration_us: Number(x[2]),
          command: r.command,
          key: r.key,
          args: r.args,
          arg_count: r.arg_count,
          client_addr: x[4] !== undefined && x[4] !== '' ? String(x[4]) : null,
          client_name: x[5] !== undefined && x[5] !== '' ? String(x[5]) : null,
        };
      });
      const notes = [
        '只含命令执行时间，不含网络/排队/I/O',
        cfg.values ? `阈值 slowlog-log-slower-than=${slower}us，保留上限 slowlog-max-len=${maxLen}` : `无法读取慢日志配置（${cfg.reason}），阈值与保留上限 unknown`,
      ];
      if (!entries.length) notes.unshift('慢日志当前为空（已开启）');
      return {
        data: {
          instance: s.ep.name,
          config: { slower_than_us: slower !== undefined ? Number(slower) : null, max_len: maxLen !== undefined ? Number(maxLen) : null, config_readable: cfg.values !== null },
          retained_entries: Number.isFinite(len) ? len : null,
          entries,
        },
        sources: [await s.src('SLOWLOG GET / SLOWLOG LEN / CONFIG GET slowlog-*')],
        coverage: {
          complete: Number.isFinite(len) && len <= limit,
          truncated: Number.isFinite(len) && len > limit,
          limit,
          notes,
        },
      };
    }),
});

export const configGet = defineCapability({
  name: 'redis.config.get',
  command: 'redis config get',
  summary: '读取 Redis 配置项（CONFIG GET），口令类配置自动隐藏',
  domain: 'redis',
  inputs: { instance: INSTANCE, pattern: { type: 'string', required: true, description: '配置名或通配模式，如 maxmemory*、slowlog-*' } },
  output: z.object({ instance: z.string(), pattern: z.string(), parameters: z.record(z.string(), z.string()), redacted: z.array(z.string()) }),
  adapter: ADAPTER,
  operation: 'read',
  auth_provider: AUTH_PROVIDER,
  guide: GUIDE,
  prerequisites: [...COMMON_PREREQS, 'ACL +config|get；托管 Redis 可能禁用 CONFIG'],
  notes: ['requirepass、masterauth 等口令类配置只显示为 <redacted>', 'ACL 拒绝（NOPERM）返回 PERMISSION_DENIED；命令被禁用/重命名返回 UNSUPPORTED'],
  examples: ['workctl redis config get --instance demo-redis --pattern "maxmemory*"'],
  handler: async (ctx, i) =>
    withRedis(ctx, i.instance, async (s) => {
      const arr = (await s.cmd<string[]>('CONFIG', 'GET', String(i.pattern))) ?? [];
      const parameters: Record<string, string> = {};
      const redacted: string[] = [];
      for (let k = 0; k + 1 < arr.length; k += 2) {
        const name = String(arr[k]);
        if (isSensitiveConfig(name)) {
          parameters[name] = '<redacted>';
          redacted.push(name);
        } else parameters[name] = String(arr[k + 1]);
      }
      return {
        data: { instance: s.ep.name, pattern: String(i.pattern), parameters, redacted },
        sources: [await s.src(`CONFIG GET ${i.pattern}`)],
        coverage: { complete: true, notes: Object.keys(parameters).length ? [] : [`没有匹配 ${i.pattern} 的配置项`] },
      };
    }),
});
