import { readFileSync } from 'node:fs';
import { ConfigResourceTypes, Kafka, logLevel, type Admin, type KafkaConfig, type SASLOptions } from 'kafkajs';
import { z } from 'zod';
import { PluginError, type PluginRequest, type Source } from './protocol';

export const SYSTEM = 'kafka';
export const ADAPTER = 'kafka-admin';

/**
 * Endpoint config for kind `kafka` (profile.endpoints.kafka.<name>).
 * Credential references (`sasl_password_ref`) are resolved by core and arrive as `sasl_password`.
 */
export const KafkaEndpointSchema = z.object({
  brokers: z.union([z.array(z.string().min(1)).min(1), z.string().min(1).transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))]),
  client_id: z.string().optional(),
  ssl: z.boolean().optional(),
  ssl_ca_file: z.string().optional(),
  ssl_reject_unauthorized: z.boolean().optional(),
  sasl_mechanism: z.enum(['plain', 'scram-sha-256', 'scram-sha-512']).optional(),
  sasl_username: z.string().optional(),
  sasl_password: z.string().optional(),
  connection_timeout_ms: z.number().int().positive().optional(),
});
export type KafkaEndpoint = z.infer<typeof KafkaEndpointSchema>;

export interface ResolvedEndpoint {
  name: string;
  config: KafkaEndpoint;
  /** endpoint label without credentials, used in meta.sources */
  label: string;
}

export function resolveEndpoint(req: PluginRequest, cluster: unknown): ResolvedEndpoint {
  const configured = req.endpoints.kafka ?? {};
  const name = typeof cluster === 'string' && cluster ? cluster : req.defaults.kafka;
  if (!name) {
    throw new PluginError('INVALID_ARGUMENT', '缺少 --cluster，且 profile 未设置 defaults.kafka', {
      hint: '指定 --cluster <endpoint 名>',
      details: { configured_clusters: Object.keys(configured) },
    });
  }
  const raw = configured[name];
  if (!raw) {
    throw new PluginError('NOT_CONFIGURED', `当前 profile 未配置 Kafka 集群 ${name}`, {
      hint: '在 profile.endpoints.kafka 下添加该集群（brokers、client_id，凭据用 *_ref 引用）',
      details: { cluster: name, configured_clusters: Object.keys(configured) },
    });
  }
  const parsed = KafkaEndpointSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PluginError('NOT_CONFIGURED', `Kafka 集群 ${name} 的端点配置不完整`, {
      hint: '至少需要 brokers: [host:port]',
      details: { cluster: name, issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
    });
  }
  if (parsed.data.sasl_mechanism && (!parsed.data.sasl_username || !parsed.data.sasl_password)) {
    throw new PluginError('UNAUTHENTICATED', `Kafka 集群 ${name} 配置了 SASL，但缺少用户名或密码引用`, {
      hint: '配置 sasl_username 与 sasl_password_ref（env:NAME 或 file:PATH）',
      details: { cluster: name },
    });
  }
  return { name, config: parsed.data, label: `kafka/${name}` };
}

function stderrLogCreator(level: logLevel) {
  return ({ namespace, label, log }: { namespace: string; label: string; log: { message: string } }) => {
    if (level === logLevel.NOTHING) return;
    process.stderr.write(`[kafkajs ${label}] ${namespace}: ${log.message}\n`);
  };
}

export function createAdmin(ep: ResolvedEndpoint, timeoutMs: number): { kafka: Kafka; admin: Admin } {
  const c = ep.config;
  const cfg: KafkaConfig = {
    brokers: c.brokers as string[],
    clientId: c.client_id ?? 'workctl',
    connectionTimeout: Math.min(c.connection_timeout_ms ?? 3000, Math.max(500, timeoutMs)),
    requestTimeout: Math.min(30_000, Math.max(1000, timeoutMs)),
    enforceRequestTimeout: true,
    retry: { retries: 2, initialRetryTime: 200, maxRetryTime: Math.min(5000, Math.max(500, Math.floor(timeoutMs / 3))) },
    // kafkajs logs to stdout by default; stdout is reserved for the protocol response.
    logLevel: process.env.WORKCTL_DEBUG === '1' ? logLevel.WARN : logLevel.NOTHING,
    logCreator: stderrLogCreator as unknown as KafkaConfig['logCreator'],
  };
  if (c.ssl || c.ssl_ca_file) {
    cfg.ssl = {
      rejectUnauthorized: c.ssl_reject_unauthorized ?? true,
      ...(c.ssl_ca_file ? { ca: [readFileSync(c.ssl_ca_file, 'utf8')] } : {}),
    };
  }
  if (c.sasl_mechanism) {
    cfg.sasl = { mechanism: c.sasl_mechanism, username: c.sasl_username!, password: c.sasl_password! } as SASLOptions;
  }
  const kafka = new Kafka(cfg);
  return { kafka, admin: kafka.admin({ retry: cfg.retry }) };
}

export async function withAdmin<T>(ep: ResolvedEndpoint, timeoutMs: number, fn: (admin: Admin) => Promise<T>): Promise<T> {
  const { admin } = createAdmin(ep, timeoutMs);
  try {
    await admin.connect();
    return await fn(admin);
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
}

export interface ClusterInfo {
  cluster_id: string | null;
  brokers: number;
  /** inter.broker.protocol.version reported by DescribeConfigs, e.g. 3.9-IV0 */
  protocol_version: string | null;
}

/** Cluster id and the broker protocol level. Kafka's wire protocol does not expose the software version. */
export async function observeCluster(admin: Admin, warnings: string[]): Promise<ClusterInfo> {
  const cluster = await admin.describeCluster();
  const brokerId = cluster.controller ?? cluster.brokers[0]?.nodeId;
  let protocolVersion: string | null = null;
  if (brokerId !== undefined && brokerId !== null) {
    try {
      const res = await admin.describeConfigs({
        includeSynonyms: false,
        resources: [{ type: ConfigResourceTypes.BROKER, name: String(brokerId), configNames: ['inter.broker.protocol.version'] }],
      });
      protocolVersion = res.resources[0]?.configEntries.find((e) => e.configName === 'inter.broker.protocol.version')?.configValue ?? null;
    } catch (e) {
      warnings.push(`未能读取 broker 协议版本（DescribeConfigs: ${(e as Error).message}），sources.version 留空`);
    }
  }
  return { cluster_id: cluster.clusterId ?? null, brokers: cluster.brokers.length, protocol_version: protocolVersion };
}

export function makeSource(ep: ResolvedEndpoint, info: ClusterInfo | null, method: string, relation: Source['relation'] = 'explicit', observedAt = new Date().toISOString()): Source {
  return {
    system: SYSTEM,
    adapter: ADAPTER,
    endpoint: ep.label,
    method,
    observed_at: observedAt,
    ...(info?.protocol_version ? { version: `inter.broker.protocol.version=${info.protocol_version}` } : {}),
    relation,
  };
}

const AUTHZ_TYPES = new Set(['TOPIC_AUTHORIZATION_FAILED', 'GROUP_AUTHORIZATION_FAILED', 'CLUSTER_AUTHORIZATION_FAILED', 'TRANSACTIONAL_ID_AUTHORIZATION_FAILED']);
const UNAVAILABLE_TYPES = new Set([
  'COORDINATOR_NOT_AVAILABLE',
  'COORDINATOR_LOAD_IN_PROGRESS',
  'NOT_COORDINATOR',
  'LEADER_NOT_AVAILABLE',
  'NOT_LEADER_FOR_PARTITION',
  'BROKER_NOT_AVAILABLE',
  'REPLICA_NOT_AVAILABLE',
  'NETWORK_EXCEPTION',
  'NOT_CONTROLLER',
  'KAFKA_STORAGE_ERROR',
]);

/** Walk kafkajs' error wrappers (KafkaJSNumberOfRetriesExceeded, KafkaJSNonRetriableError ...). */
function errorChain(e: unknown): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = [];
  let cur: any = e;
  for (let i = 0; cur && i < 8; i++) {
    out.push(cur);
    cur = cur.cause ?? cur.originalError;
    if (cur && out.includes(cur)) break;
  }
  return out;
}

/** Map a kafkajs/Node error to a protocol error. Messages never contain credentials (kafkajs does not echo them). */
export function mapKafkaError(e: unknown, ctx: { cluster: string; topic?: string; group?: string }): PluginError {
  if (e instanceof PluginError) return e;
  const chain = errorChain(e);
  const names = chain.map((x) => String(x.name ?? ''));
  const types = chain.map((x) => String(x.type ?? '')).filter(Boolean);
  const codes = chain.map((x) => String(x.code ?? '')).filter(Boolean);
  const top = chain[0] ?? {};
  const message = String(top.message ?? e);
  const details: Record<string, unknown> = { cluster: ctx.cluster, kafka_error: names.find((n) => n.startsWith('KafkaJS')) ?? names[0] ?? null };
  if (types.length) details.kafka_error_type = types[0];

  if (types.includes('ILLEGAL_SASL_STATE') || types.includes('UNSUPPORTED_SASL_MECHANISM')) {
    return new PluginError('UNAUTHENTICATED', `Kafka 集群 ${ctx.cluster} SASL 握手失败（${types.find((t) => t.includes('SASL'))}）`, {
      hint: '确认 brokers 指向的 listener 启用了 SASL，且 sasl_mechanism 与 broker 配置一致',
      details,
    });
  }
  if (types.includes('SASL_AUTHENTICATION_FAILED') || names.includes('KafkaJSSASLAuthenticationError')) {
    return new PluginError('UNAUTHENTICATED', `Kafka 集群 ${ctx.cluster} 认证失败`, { hint: '检查 sasl_mechanism / sasl_username / sasl_password_ref', details });
  }
  if (types.some((t) => AUTHZ_TYPES.has(t))) {
    return new PluginError('PERMISSION_DENIED', `Kafka 拒绝了该操作（${types.find((t) => AUTHZ_TYPES.has(t))}）`, {
      hint: '确认该账号具备 Describe（topic/group/cluster）与 DescribeConfigs 权限',
      details,
    });
  }
  if (types.includes('UNKNOWN_TOPIC_OR_PARTITION')) {
    return new PluginError('NOT_FOUND', `topic 不存在: ${ctx.topic ?? '(未知)'}`, { hint: `用 workctl mq topic list --cluster ${ctx.cluster} 查看已有 topic`, details: { ...details, topic: ctx.topic } });
  }
  if (types.includes('GROUP_ID_NOT_FOUND')) {
    return new PluginError('NOT_FOUND', `消费组不存在: ${ctx.group ?? '(未知)'}`, { details: { ...details, group: ctx.group } });
  }
  if (types.includes('UNSUPPORTED_VERSION') || names.includes('KafkaJSServerDoesNotSupportApiKey')) {
    return new PluginError('UNSUPPORTED', `broker 不支持所需的 Kafka API 版本: ${message}`, { details });
  }
  if (types.includes('REQUEST_TIMED_OUT') || names.includes('KafkaJSRequestTimeoutError')) {
    return new PluginError('TIMEOUT', `Kafka 请求超时: ${message}`, { hint: '增大 --timeout 或检查 broker 负载', details });
  }
  const netCodes = ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE'];
  const netCode = codes.find((c) => netCodes.includes(c));
  if (
    netCode ||
    types.some((t) => UNAVAILABLE_TYPES.has(t)) ||
    names.some((n) => ['KafkaJSConnectionError', 'KafkaJSConnectionClosedError', 'KafkaJSBrokerNotFound', 'KafkaJSNumberOfRetriesExceeded', 'KafkaJSLockTimeout', 'KafkaJSGroupCoordinatorNotFound'].includes(n))
  ) {
    return new PluginError('UPSTREAM_UNAVAILABLE', `Kafka 集群 ${ctx.cluster} 不可达或暂不可用: ${message}`, {
      hint: '检查 brokers 地址、网络连通性与 broker 状态（advertised.listeners 需对本机可达）',
      details: { ...details, ...(netCode ? { errno: netCode } : {}) },
    });
  }
  if (names.some((n) => n.startsWith('KafkaJS'))) {
    return new PluginError('UPSTREAM_UNAVAILABLE', `Kafka 返回错误: ${message}`, { details });
  }
  return new PluginError('INTERNAL', message, { details });
}

/** Kafka's own internal topics (the Metadata isInternal flag is not exposed by the kafkajs admin API). */
export const KAFKA_INTERNAL_TOPICS = new Set(['__consumer_offsets', '__transaction_state', '__share_group_state']);

const TOPIC_RE = /^[a-zA-Z0-9._-]{1,249}$/;
export function requireTopicName(v: unknown, flag = '--topic'): string {
  if (typeof v !== 'string' || !v) throw new PluginError('INVALID_ARGUMENT', `缺少必填参数 ${flag}`);
  if (!TOPIC_RE.test(v) || v === '.' || v === '..') {
    throw new PluginError('INVALID_ARGUMENT', `${flag} 不是合法的 Kafka topic 名: ${v}`, { hint: 'topic 名只能包含字母、数字、. _ -，长度不超过 249' });
  }
  return v;
}
