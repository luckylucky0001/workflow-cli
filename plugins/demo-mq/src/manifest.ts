/**
 * Source of truth for workctl-plugin.json (build.mjs serialises this object).
 * Capability names here must match HANDLERS (available) and OUTPUT_SCHEMAS.
 */

type InputType = 'string' | 'int' | 'number' | 'bool' | 'duration' | 'enum' | 'file' | 'list';

export interface ManifestInput {
  type: InputType;
  description: string;
  required?: boolean;
  default?: string | number | boolean | string[];
  enum?: string[];
}

export interface ManifestCapability {
  name: string;
  command: string;
  summary: string;
  description?: string;
  inputs: Record<string, ManifestInput>;
  output_schema?: string;
  adapter: string;
  operation: 'read' | 'diagnose' | 'plan' | 'execute';
  auth_provider: string;
  capability_version: string;
  guide: string;
  status: 'available' | 'planned';
  notes?: string[];
  examples?: string[];
  prerequisites?: string[];
}

export const PLUGIN_NAME = 'demo-mq';
export const PLUGIN_VERSION = '0.1.0';
/** Broker versions this plugin was actually run against (observed in demo-kafka's startup log "Kafka version: 3.9.1"). */
export const VERIFIED_KAFKA_VERSIONS = ['3.9.1'];

const cluster: ManifestInput = { type: 'string', required: true, description: 'Kafka 集群（profile.endpoints.kafka 下的 endpoint 名，如 demo-mq）' };

export const CAPABILITIES: ManifestCapability[] = [
  {
    name: 'mq.consumer.lag',
    command: 'mq consumer lag',
    summary: '查看 Kafka 消费组各分区的已提交位点、结束位点与 lag（位点差）',
    description:
      '读取消费组状态与成员（DescribeGroups）、已提交位点（OffsetFetch）和分区结束位点（ListOffsets），按分区计算 lag = end_offset - committed_offset 并汇总。没有已提交位点的分区 lag 为 null 并给出解释。',
    inputs: {
      cluster,
      group: { type: 'string', required: true, description: '消费组 ID（group.id）' },
      topic: { type: 'string', description: '只看该 topic（默认：该组有已提交位点或当前被分配的全部 topic）' },
    },
    output_schema: 'schemas/mq.consumer.lag.v1.json',
    adapter: 'kafka-admin',
    operation: 'read',
    auth_provider: 'kafka-profile',
    capability_version: '1.0.0',
    guide: 'guides/mq.md',
    status: 'available',
    notes: [
      'lag 是位点差，不是时间延迟；结合生产速率才能估计追赶时间',
      '结果是 observed_at 时刻的快照；已提交位点与结束位点分两次读取，不是原子快照',
      '已提交位点为 -1 的分区表示“无已提交位点”，lag 为 null，不计入 total_lag',
      'Kafka 消费组 lag 与 RabbitMQ 队列深度语义不同，不做归一化',
      '不存在的消费组（Kafka 返回 Dead 且无位点）返回 NOT_FOUND，details.known_groups 列出已有组',
    ],
    examples: ['workctl mq consumer lag --cluster demo-mq --group demo-consumer', 'workctl mq consumer lag --cluster demo-mq --group demo-consumer --topic demo.order.events --json'],
  },
  {
    name: 'mq.topic.get',
    command: 'mq topic get',
    summary: '查看 Kafka topic 的分区（leader/副本/ISR）、关键配置与高低水位',
    inputs: {
      cluster,
      topic: { type: 'string', required: true, description: 'topic 名' },
    },
    output_schema: 'schemas/mq.topic.get.v1.json',
    adapter: 'kafka-admin',
    operation: 'read',
    auth_provider: 'kafka-profile',
    capability_version: '1.0.0',
    guide: 'guides/mq.md',
    status: 'available',
    notes: [
      '配置只返回 retention.ms、retention.bytes、cleanup.policy、min.insync.replicas、max.message.bytes、segment.bytes，并标注来源（topic 覆盖 / 继承 broker / 默认值）',
      'offset_span 是位点跨度，compaction 与事务控制记录会使其不等于消息条数',
      '无 DescribeConfigs 权限时返回 partial：分区与位点完整、configs 为空',
    ],
    examples: ['workctl mq topic get --cluster demo-mq --topic demo.order.events'],
  },
  {
    name: 'mq.topic.list',
    command: 'mq topic list',
    summary: '列出 Kafka 集群的 topic 及分区数（默认不含内部 topic）',
    inputs: {
      cluster,
      include_internal: { type: 'bool', default: false, description: '包含 __consumer_offsets 等 Kafka 内部 topic' },
      limit: { type: 'int', default: 500, description: '最多返回的 topic 数（1-10000），超过时结果为 partial' },
    },
    output_schema: 'schemas/mq.topic.list.v1.json',
    adapter: 'kafka-admin',
    operation: 'read',
    auth_provider: 'kafka-profile',
    capability_version: '1.0.0',
    guide: 'guides/mq.md',
    status: 'available',
    notes: ['只列出当前账号在 Metadata 中可见的 topic', '内部 topic 按 Kafka 内置名单判定（__consumer_offsets、__transaction_state、__share_group_state）'],
    examples: ['workctl mq topic list --cluster demo-mq', 'workctl mq topic list --cluster demo-mq --include-internal'],
  },
  {
    name: 'mq.queue.get',
    command: 'mq queue get',
    summary: '查看 RabbitMQ 队列深度（ready / unacked）与消费者数（待接入）',
    inputs: {
      cluster: { type: 'string', required: true, description: 'RabbitMQ 集群（endpoint 名）' },
      vhost: { type: 'string', default: '/', description: 'virtual host' },
      queue: { type: 'string', required: true, description: '队列名' },
    },
    adapter: 'rabbitmq-management',
    operation: 'read',
    auth_provider: 'rabbitmq-profile',
    capability_version: '1.0.0',
    guide: 'guides/mq.md',
    status: 'planned',
    notes: [
      '规划通过 RabbitMQ Management HTTP API 读取 messages_ready / messages_unacknowledged / consumers',
      '队列深度是 broker 上待投递/未确认的消息数，与 Kafka 的位点 lag 语义不同，不做归一化',
    ],
  },
];

export function buildManifest(): Record<string, unknown> {
  return {
    plugin_api: 'workctl-plugin/1',
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    description: '演示插件：通过插件机制接入 Kafka 消息队列（消费组 lag、topic 详情与列表），RabbitMQ 队列能力列为待接入',
    backend_mode: 'live',
    entry: 'dist/plugin.mjs',
    domain: {
      name: 'mq',
      title: '消息队列',
      summary: 'Kafka 消费组 lag、topic 分区与配置；以插件形式接入，RabbitMQ 待接入',
      pillar: 'middleware',
      guide: 'guides/mq.md',
      skill: 'skills/mq-operations',
    },
    endpoint_kinds: ['kafka'],
    compatibility: {
      workctl: '>=0.1.0',
      engines: [{ engine: 'kafka', versions: '3.x', verified: VERIFIED_KAFKA_VERSIONS }],
      client: 'kafkajs 2.2.4（bundled）',
    },
    capabilities: CAPABILITIES,
  };
}
