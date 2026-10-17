import { defineCapability, defineDomain } from '../../core/registry';
import { ADAPTER, AUTH_PROVIDER, GUIDE, isRedisOriginError, mapRedisError, withRedis } from './client';
import { parseInfo } from './info';
import { keyHot, keyInspect, keySample } from './keys';
import { configGet, infoGet, instanceGet, slowlogList, statsSample } from './server';

/** In the catalog but not callable yet (no handler → status planned). */
const planned = (name: string, summary: string) =>
  defineCapability({ name, command: name.replace(/\./g, ' '), summary, domain: 'redis', adapter: ADAPTER, operation: 'read', auth_provider: AUTH_PROVIDER, guide: GUIDE, status: 'planned' });

/**
 * Redis domain (adapter redis-client / ioredis). Read-only diagnostics: INFO, window
 * sampling, slow log, budgeted SCAN sampling, single-key inspection, LFU hot keys.
 * See docs/guides/redis.md.
 */
export default defineDomain({
  name: 'redis',
  title: 'Redis',
  summary: 'Redis 实例概况、INFO、窗口统计采样、慢日志、键采样/大键/热键、单键检查与配置读取',
  pillar: 'middleware',
  guide: GUIDE,
  skill: 'skills/redis-operations/SKILL.md',
  capabilities: [
    instanceGet,
    infoGet,
    statsSample,
    slowlogList,
    keyInspect,
    keySample,
    keyHot,
    configGet,
    planned('redis.latency.get', '读取 LATENCY LATEST / HISTORY 事件延迟（需开启 latency-monitor-threshold）'),
    planned('redis.cluster.get', '查看 Redis Cluster 节点、槽位分布与故障转移状态'),
  ],
  probes: {
    redis: async (ctx, name) =>
      withRedis(ctx, name, async (s) => {
        const pong = String(await s.cmd('PING'));
        let identity = 'default';
        let detail = `PING → ${pong}`;
        try {
          identity = String(await s.cmd('ACL', 'WHOAMI'));
        } catch (e) {
          detail += `; ACL WHOAMI 不可用 (${e instanceof Error ? e.message : String(e)})`;
        }
        let privileges: string[] | undefined;
        try {
          const u = (await s.cmd<unknown[]>('ACL', 'GETUSER', identity)) ?? [];
          for (let k = 0; k + 1 < u.length; k += 2) {
            if (String(u[k]) === 'commands') privileges = [`commands: ${String(u[k + 1])}`];
            if (String(u[k]) === 'keys' && privileges) privileges.push(`keys: ${String(u[k + 1])}`);
          }
        } catch {
          privileges = undefined;
        }
        const info = parseInfo(String(await s.cmd('INFO', 'server')));
        return {
          ok: pong === 'PONG',
          identity,
          version: info.server?.redis_version !== undefined ? String(info.server.redis_version) : undefined,
          detail,
          ...(privileges ? { privileges } : {}),
        };
      }),
  },
  mapError: (e) => (isRedisOriginError(e) ? mapRedisError(e) : undefined),
});
