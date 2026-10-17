import { z } from 'zod';

/** zod schemas of each capability's `data`; build.mjs turns them into schemas/*.json via z.toJSONSchema. */

const PartitionLag = z.object({
  partition: z.number().int(),
  committed_offset: z.number().int().nullable().describe('消费组已提交位点（下一条待消费消息的位点）；无已提交位点时为 null'),
  end_offset: z.number().int().nullable().describe('分区结束位点（ListOffsets latest，read_committed 隔离级别，非事务写入时等于高水位）'),
  log_start_offset: z.number().int().nullable().describe('日志起始位点（更早的消息已被 retention/compaction 清理）'),
  lag: z.number().int().nullable().describe('end_offset - committed_offset，单位为位点数；无法计算时为 null'),
  state: z.enum(['ok', 'no_committed_offset', 'committed_before_log_start', 'committed_ahead_of_end', 'end_offset_unavailable']),
  explanation: z.string().optional().describe('state 不是 ok 时的解释'),
  assigned_member: z.string().nullable().describe('当前分配到该分区的成员 client_id；组内无成员时为 null'),
});

const TopicLag = z.object({
  topic: z.string(),
  partitions: z.array(PartitionLag),
  total_lag: z.number().int().describe('该 topic 下可计算 lag 的分区之和'),
  partitions_with_commit: z.number().int(),
  partitions_without_commit: z.number().int(),
});

const Member = z.object({
  member_id: z.string(),
  client_id: z.string(),
  client_host: z.string(),
  assignments: z.array(z.object({ topic: z.string(), partitions: z.array(z.number().int()) })),
});

export const ConsumerLagData = z.object({
  cluster: z.string().describe('endpoint 名（profile.endpoints.kafka 下的键）'),
  cluster_id: z.string().nullable(),
  group: z.string(),
  group_state: z.string().describe('DescribeGroups 返回的组状态：Stable / Empty / PreparingRebalance / CompletingRebalance / Dead'),
  protocol_type: z.string().nullable(),
  assignment_strategy: z.string().nullable(),
  member_count: z.number().int(),
  members: z.array(Member),
  topic_filter: z.string().nullable(),
  topics: z.array(TopicLag),
  totals: z.object({
    topics: z.number().int(),
    partitions: z.number().int(),
    partitions_with_commit: z.number().int(),
    partitions_without_commit: z.number().int(),
    partitions_lag_unknown: z.number().int(),
    total_lag: z.number().int(),
    max_partition_lag: z.object({ topic: z.string(), partition: z.number().int(), lag: z.number().int() }).nullable(),
  }),
  lag_unit: z.literal('offsets'),
  lag_basis: z.literal('offset_difference').describe('lag 基于位点差，不是时间延迟'),
  end_offset_isolation: z.literal('read_committed'),
  observed_at: z.string().describe('位点读取完成时间（ISO 8601）；lag 是该时刻的快照'),
});
export type ConsumerLagData = z.infer<typeof ConsumerLagData>;

const ConfigValue = z.object({
  value: z.string().nullable().describe('敏感配置不输出取值'),
  source: z.string().describe('topic / broker-dynamic / broker-static / default 等'),
  is_default: z.boolean(),
  sensitive: z.boolean(),
});

export const TopicGetData = z.object({
  cluster: z.string(),
  cluster_id: z.string().nullable(),
  topic: z.string(),
  internal: z.boolean(),
  partition_count: z.number().int(),
  replication_factor: z.number().int().nullable().describe('取各分区副本数的最大值'),
  partitions: z.array(
    z.object({
      partition: z.number().int(),
      leader: z.number().int().nullable().describe('leader broker id；-1/无 leader 时为 null'),
      replicas: z.array(z.number().int()),
      isr: z.array(z.number().int()),
      offline_replicas: z.array(z.number().int()),
      under_replicated: z.boolean().describe('ISR 数量少于副本数'),
      log_start_offset: z.number().int().nullable(),
      end_offset: z.number().int().nullable(),
      offset_span: z.number().int().nullable().describe('end_offset - log_start_offset；compaction/事务控制记录下不等于消息条数'),
    }),
  ),
  configs: z.record(z.string(), ConfigValue),
  totals: z.object({
    under_replicated_partitions: z.number().int(),
    offline_partitions: z.number().int(),
    offset_span: z.number().int(),
  }),
  observed_at: z.string(),
});
export type TopicGetData = z.infer<typeof TopicGetData>;

export const TopicListData = z.object({
  cluster: z.string(),
  cluster_id: z.string().nullable(),
  include_internal: z.boolean(),
  topics: z.array(z.object({ name: z.string(), partitions: z.number().int().nullable(), internal: z.boolean() })),
  count: z.number().int().describe('本次返回的 topic 数'),
  total_matched: z.number().int().describe('过滤后（截断前）的 topic 数'),
  internal_excluded: z.number().int(),
  observed_at: z.string(),
});
export type TopicListData = z.infer<typeof TopicListData>;

export const OUTPUT_SCHEMAS: Record<string, z.ZodType> = {
  'mq.consumer.lag': ConsumerLagData,
  'mq.topic.get': TopicGetData,
  'mq.topic.list': TopicListData,
};

/** JSON Schema of every capability's `data` (used by build.mjs). */
export function outputJsonSchemas(): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(OUTPUT_SCHEMAS).map(([name, schema]) => [
      name,
      z.toJSONSchema(schema, { unrepresentable: 'any', io: 'output' }) as Record<string, unknown>,
    ]),
  );
}
