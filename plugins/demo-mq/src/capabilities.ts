import { AssignerProtocol, ConfigResourceTypes, type Admin } from 'kafkajs';
import { summarizeTopic, summarizeTotals, parseOffset, type PartitionOffsets, type TopicLag } from './lag';
import { KAFKA_INTERNAL_TOPICS, makeSource, mapKafkaError, observeCluster, requireTopicName, resolveEndpoint, withAdmin } from './kafka';
import { PluginError, type HandlerResult, type PluginRequest, type Source } from './protocol';
import type { ConsumerLagData, TopicGetData, TopicListData } from './schemas';

export type Handler = (req: PluginRequest, inputs: Record<string, unknown>, timeoutMs: number) => Promise<HandlerResult>;

function requireString(v: unknown, flag: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new PluginError('INVALID_ARGUMENT', `缺少必填参数 ${flag}`);
  return v.trim();
}

function asBool(v: unknown, dflt = false): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return dflt;
}

function asInt(v: unknown, dflt: number, min: number, max: number, flag: string): number {
  if (v === undefined || v === null || v === '') return dflt;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new PluginError('INVALID_ARGUMENT', `${flag} 必须是 ${min}..${max} 之间的整数`);
  return n;
}

function isUnknownTopic(e: unknown): boolean {
  let cur: any = e;
  for (let i = 0; cur && i < 6; i++) {
    if (cur.type === 'UNKNOWN_TOPIC_OR_PARTITION') return true;
    cur = cur.cause ?? cur.originalError;
  }
  return false;
}

async function knownGroups(admin: Admin): Promise<string[]> {
  try {
    const { groups } = await admin.listGroups();
    return groups.map((g) => g.groupId).sort().slice(0, 50);
  } catch {
    return [];
  }
}

interface EndOffsets {
  byPartition: Map<number, { end: number | null; logStart: number | null }>;
}

async function readEndOffsets(admin: Admin, topic: string): Promise<EndOffsets | null> {
  try {
    const rows = await admin.fetchTopicOffsets(topic);
    return { byPartition: new Map(rows.map((r) => [r.partition, { end: parseOffset(r.high), logStart: parseOffset(r.low) }])) };
  } catch (e) {
    if (isUnknownTopic(e)) return null;
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// mq.consumer.lag
// ---------------------------------------------------------------------------------------------
export const consumerLag: Handler = async (req, inputs, timeoutMs) => {
  const ep = resolveEndpoint(req, inputs.cluster);
  const group = requireString(inputs.group, '--group');
  const topicFilter = inputs.topic !== undefined && inputs.topic !== null && inputs.topic !== '' ? requireTopicName(inputs.topic) : null;
  const ctx = { cluster: ep.name, group, topic: topicFilter ?? undefined };
  try {
    return await withAdmin(ep, timeoutMs, async (admin) => {
      const warnings: string[] = [];
      const info = await observeCluster(admin, warnings);
      const desc = (await admin.describeGroups([group])).groups.find((g) => g.groupId === group);
      const groupObservedAt = new Date().toISOString();
      const committedAll = await admin.fetchOffsets({ groupId: group });
      const state = desc?.state ?? 'Dead';

      if (state === 'Dead' && committedAll.length === 0) {
        throw new PluginError('NOT_FOUND', `消费组不存在: ${group}`, {
          hint: 'Kafka 对不存在的组返回 Dead 状态且无已提交位点；检查组名或在 details.known_groups 中选择',
          details: { cluster: ep.name, group, group_state: state, known_groups: await knownGroups(admin) },
        });
      }

      // members and their current assignment (only meaningful for protocol type "consumer")
      const assignedTo = new Map<string, string>();
      const assignedTopics = new Set<string>();
      const members: ConsumerLagData['members'] = (desc?.members ?? []).map((m) => {
        const assignments: Array<{ topic: string; partitions: number[] }> = [];
        if (desc?.protocolType === 'consumer' && m.memberAssignment?.length) {
          try {
            const decoded = AssignerProtocol.MemberAssignment.decode(m.memberAssignment);
            for (const [topic, parts] of Object.entries(decoded?.assignment ?? {})) {
              assignments.push({ topic, partitions: [...parts].sort((a, b) => a - b) });
              assignedTopics.add(topic);
              for (const p of parts) assignedTo.set(`${topic}:${p}`, m.clientId);
            }
          } catch {
            warnings.push(`无法解码成员 ${m.clientId} 的分区分配（非标准 assignor），assigned_member 留空`);
          }
        }
        return { member_id: m.memberId, client_id: m.clientId, client_host: m.clientHost, assignments };
      });

      const topics = topicFilter
        ? [topicFilter]
        : [...new Set([...committedAll.map((t) => t.topic), ...assignedTopics])].sort();

      if (topicFilter) {
        // fail early with NOT_FOUND when the requested topic does not exist
        const ends = await readEndOffsets(admin, topicFilter);
        if (!ends) {
          throw new PluginError('NOT_FOUND', `topic 不存在: ${topicFilter}`, { hint: `用 workctl mq topic list --cluster ${ep.name} 查看已有 topic`, details: { cluster: ep.name, topic: topicFilter } });
        }
      }

      // committed offsets per topic, including partitions without a commit (-1)
      const committedByTopic = new Map<string, Map<number, number | null>>();
      const missingTopics: string[] = [];
      for (const topic of topics) {
        try {
          const rows = await admin.fetchOffsets({ groupId: group, topics: [topic] });
          const parts = rows.find((r) => r.topic === topic)?.partitions ?? [];
          committedByTopic.set(topic, new Map(parts.map((p) => [p.partition, parseOffset(p.offset)])));
        } catch (e) {
          if (!isUnknownTopic(e)) throw e;
          // topic deleted while the group still holds offsets for it
          const parts = committedAll.find((r) => r.topic === topic)?.partitions ?? [];
          committedByTopic.set(topic, new Map(parts.map((p) => [p.partition, parseOffset(p.offset)])));
          missingTopics.push(topic);
        }
      }
      const committedObservedAt = new Date().toISOString();

      const topicLags: TopicLag[] = [];
      for (const topic of topics) {
        const committed = committedByTopic.get(topic) ?? new Map<number, number | null>();
        const ends = missingTopics.includes(topic) ? null : await readEndOffsets(admin, topic);
        if (!ends && !missingTopics.includes(topic)) missingTopics.push(topic);
        const partitionIds = new Set<number>([...committed.keys(), ...(ends ? ends.byPartition.keys() : [])]);
        const rows: PartitionOffsets[] = [...partitionIds].map((partition) => ({
          partition,
          committed: committed.get(partition) ?? null,
          end: ends?.byPartition.get(partition)?.end ?? null,
          logStart: ends?.byPartition.get(partition)?.logStart ?? null,
          assignedTo: assignedTo.get(`${topic}:${partition}`) ?? null,
        }));
        topicLags.push(summarizeTopic(topic, rows));
      }
      const observedAt = new Date().toISOString();
      const totals = summarizeTotals(topicLags);

      if (missingTopics.length) warnings.push(`topic 已不存在但消费组仍保留其位点: ${missingTopics.join(', ')}；这些分区的 lag 未计算`);
      if (totals.partitions_without_commit > 0) {
        warnings.push(`${totals.partitions_without_commit} 个分区没有已提交位点，lag 为 null，未计入 total_lag（见各分区 explanation）`);
      }
      if (topicFilter && (committedByTopic.get(topicFilter)?.size ?? 0) > 0 && [...committedByTopic.get(topicFilter)!.values()].every((v) => v === null)) {
        warnings.push(`消费组 ${group} 在 topic ${topicFilter} 上没有任何已提交位点（可能从未消费或未订阅该 topic）`);
      }
      if (!topics.length) warnings.push(`消费组 ${group} 当前没有已提交位点，也没有分配到任何分区`);
      if (state === 'PreparingRebalance' || state === 'CompletingRebalance') warnings.push('消费组正在 rebalance，成员分配与提交位点可能随时变化');
      if (desc?.protocolType && desc.protocolType !== 'consumer') {
        warnings.push(`该组协议类型为 ${desc.protocolType}（非普通 consumer 组），分配信息未解码，位点语义以该框架为准`);
      }

      const data: ConsumerLagData = {
        cluster: ep.name,
        cluster_id: info.cluster_id,
        group,
        group_state: state,
        protocol_type: desc?.protocolType || null,
        assignment_strategy: desc?.protocol || null,
        member_count: members.length,
        members,
        topic_filter: topicFilter,
        topics: topicLags,
        totals,
        lag_unit: 'offsets',
        lag_basis: 'offset_difference',
        end_offset_isolation: 'read_committed',
        observed_at: observedAt,
      };
      const partial = missingTopics.length > 0;
      const sources: Source[] = [
        makeSource(ep, info, `DescribeGroups(${group})`, 'explicit', groupObservedAt),
        makeSource(ep, info, `OffsetFetch(group=${group})`, 'explicit', committedObservedAt),
        makeSource(ep, info, 'ListOffsets(latest+earliest, read_committed)', 'explicit', observedAt),
        makeSource(ep, info, 'lag = end_offset - committed_offset', 'derived', observedAt),
      ];
      return {
        status: partial ? 'partial' : 'success',
        data,
        sources,
        coverage: {
          complete: !partial,
          scope: topicFilter ? `消费组 ${group} 在 topic ${topicFilter} 的全部分区` : `消费组 ${group} 有已提交位点或当前被分配的全部 topic 分区`,
          notes: [
            'lag 是位点差（end_offset - committed_offset），不是时间延迟；同样的 lag 在不同生产速率下意味着不同的追赶时间',
            '已提交位点与结束位点分两次请求读取，不是原子快照；lag 是 observed_at 时刻的近似值',
            '结束位点按 read_committed 读取（LSO），无未完成事务时等于高水位',
            'Kafka 消费组 lag 与 RabbitMQ 队列深度（ready/unacked）语义不同，不要相互换算或归一化',
          ],
        },
        warnings,
      };
    });
  } catch (e) {
    throw mapKafkaError(e, ctx);
  }
};

// ---------------------------------------------------------------------------------------------
// mq.topic.get
// ---------------------------------------------------------------------------------------------
const TOPIC_CONFIG_NAMES = ['retention.ms', 'retention.bytes', 'cleanup.policy', 'min.insync.replicas', 'max.message.bytes', 'segment.bytes'];

const CONFIG_SOURCE: Record<number, string> = {
  0: 'unknown',
  1: 'topic',
  2: 'broker-dynamic',
  3: 'broker-dynamic-default',
  4: 'broker-static',
  5: 'default',
  6: 'broker-logger',
};

export const topicGet: Handler = async (req, inputs, timeoutMs) => {
  const ep = resolveEndpoint(req, inputs.cluster);
  const topic = requireTopicName(inputs.topic);
  const ctx = { cluster: ep.name, topic };
  try {
    return await withAdmin(ep, timeoutMs, async (admin) => {
      const warnings: string[] = [];
      const info = await observeCluster(admin, warnings);
      const meta = await admin.fetchTopicMetadata({ topics: [topic] });
      const metaAt = new Date().toISOString();
      const tm = meta.topics.find((t) => t.name === topic);
      if (!tm) throw new PluginError('NOT_FOUND', `topic 不存在: ${topic}`, { hint: `用 workctl mq topic list --cluster ${ep.name} 查看已有 topic`, details: { cluster: ep.name, topic } });
      const ends = await readEndOffsets(admin, topic);
      const offsetsAt = new Date().toISOString();

      let configs: TopicGetData['configs'] = {};
      let configsOk = true;
      try {
        const res = await admin.describeConfigs({
          includeSynonyms: false,
          resources: [{ type: ConfigResourceTypes.TOPIC, name: topic, configNames: TOPIC_CONFIG_NAMES }],
        });
        const entries = [...(res.resources[0]?.configEntries ?? [])].sort((a, b) => TOPIC_CONFIG_NAMES.indexOf(a.configName) - TOPIC_CONFIG_NAMES.indexOf(b.configName));
        for (const e of entries) {
          const src = (e as { configSource?: number }).configSource;
          configs[e.configName] = {
            value: e.isSensitive ? null : e.configValue,
            source: src !== undefined ? (CONFIG_SOURCE[src] ?? `unknown(${src})`) : e.isDefault ? 'default' : 'unknown',
            is_default: e.isDefault,
            sensitive: e.isSensitive,
          };
        }
      } catch (e) {
        const mapped = mapKafkaError(e, ctx);
        if (mapped.code !== 'PERMISSION_DENIED') throw e;
        configsOk = false;
        configs = {};
        warnings.push('无 DescribeConfigs 权限，configs 未返回（分区与位点信息完整）');
      }

      const partitions: TopicGetData['partitions'] = tm.partitions
        .map((p) => {
          const replicas = [...(p.replicas ?? [])];
          const isr = [...(p.isr ?? [])];
          const off = ends?.byPartition.get(p.partitionId);
          const end = off?.end ?? null;
          const logStart = off?.logStart ?? null;
          return {
            partition: p.partitionId,
            leader: p.leader !== undefined && p.leader >= 0 ? p.leader : null,
            replicas,
            isr,
            offline_replicas: [...(p.offlineReplicas ?? [])],
            under_replicated: isr.length < replicas.length,
            log_start_offset: logStart,
            end_offset: end,
            offset_span: end !== null && logStart !== null ? end - logStart : null,
          };
        })
        .sort((a, b) => a.partition - b.partition);

      const data: TopicGetData = {
        cluster: ep.name,
        cluster_id: info.cluster_id,
        topic,
        internal: KAFKA_INTERNAL_TOPICS.has(topic),
        partition_count: partitions.length,
        replication_factor: partitions.length ? Math.max(...partitions.map((p) => p.replicas.length)) : null,
        partitions,
        configs,
        totals: {
          under_replicated_partitions: partitions.filter((p) => p.under_replicated).length,
          offline_partitions: partitions.filter((p) => p.leader === null).length,
          offset_span: partitions.reduce((s, p) => s + (p.offset_span ?? 0), 0),
        },
        observed_at: offsetsAt,
      };
      const sources: Source[] = [
        makeSource(ep, info, `Metadata(topic=${topic})`, 'explicit', metaAt),
        makeSource(ep, info, 'ListOffsets(latest+earliest, read_committed)', 'explicit', offsetsAt),
      ];
      if (configsOk) sources.push(makeSource(ep, info, `DescribeConfigs(topic=${topic}; ${TOPIC_CONFIG_NAMES.join(',')})`, 'explicit'));
      return {
        status: configsOk ? 'success' : 'partial',
        data,
        sources,
        coverage: {
          complete: configsOk,
          scope: `topic ${topic} 的全部分区；配置仅含 ${TOPIC_CONFIG_NAMES.join('、')}`,
          notes: [
            'offset_span = end_offset - log_start_offset，是位点跨度；compaction、事务控制记录会使其不等于消息条数',
            'config source=topic 表示 topic 级覆盖，default/broker-* 表示继承自 broker',
          ],
        },
        warnings,
      };
    });
  } catch (e) {
    throw mapKafkaError(e, ctx);
  }
};

// ---------------------------------------------------------------------------------------------
// mq.topic.list
// ---------------------------------------------------------------------------------------------
export const topicList: Handler = async (req, inputs, timeoutMs) => {
  const ep = resolveEndpoint(req, inputs.cluster);
  const includeInternal = asBool(inputs.include_internal, false);
  const limit = asInt(inputs.limit, 500, 1, 10_000, '--limit');
  try {
    return await withAdmin(ep, timeoutMs, async (admin) => {
      const warnings: string[] = [];
      const info = await observeCluster(admin, warnings);
      const all = (await admin.listTopics()).sort();
      const listedAt = new Date().toISOString();
      const matched = all.filter((t) => includeInternal || !KAFKA_INTERNAL_TOPICS.has(t));
      const page = matched.slice(0, limit);
      const truncated = matched.length > page.length;
      const meta = page.length ? await admin.fetchTopicMetadata({ topics: page }) : { topics: [] };
      const partitionsByTopic = new Map(meta.topics.map((t) => [t.name, t.partitions.length]));
      const data: TopicListData = {
        cluster: ep.name,
        cluster_id: info.cluster_id,
        include_internal: includeInternal,
        topics: page.map((name) => ({ name, partitions: partitionsByTopic.get(name) ?? null, internal: KAFKA_INTERNAL_TOPICS.has(name) })),
        count: page.length,
        total_matched: matched.length,
        internal_excluded: all.length - matched.length,
        observed_at: listedAt,
      };
      if (truncated) warnings.push(`topic 数 ${matched.length} 超过 --limit ${limit}，结果已截断`);
      return {
        status: truncated ? 'partial' : 'success',
        data,
        sources: [makeSource(ep, info, 'Metadata(all topics)', 'explicit', listedAt)],
        coverage: {
          complete: !truncated,
          scope: includeInternal ? '集群内全部 topic' : '集群内全部非内部 topic',
          truncated,
          limit,
          notes: [
            `internal 判定依据 Kafka 内置的内部 topic 名单（${[...KAFKA_INTERNAL_TOPICS].join('、')}）；kafkajs admin 不暴露 Metadata 的 isInternal 标志`,
            '结果只代表当前账号在 Metadata 中可见（具备 Describe 权限）的 topic',
          ],
        },
        warnings,
      };
    });
  } catch (e) {
    throw mapKafkaError(e, { cluster: ep.name });
  }
};

export const HANDLERS: Record<string, Handler> = {
  'mq.consumer.lag': consumerLag,
  'mq.topic.get': topicGet,
  'mq.topic.list': topicList,
};


