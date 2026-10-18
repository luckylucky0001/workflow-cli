// Output schemas shared by every config provider (etcd / Nacos / Consul): one schema per capability,
// provider-specific facts in optional fields.
import { z } from 'zod';
import { MASK } from './values';

export const MAX_KEYS = 1000;
export const PROVIDER_KINDS = ['etcd', 'nacos', 'consul'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];
export const ProviderSchema = z.enum(PROVIDER_KINDS).describe('实际使用的 provider（由端点类型决定）');

export const RevisionSpace = z
  .enum(['etcd-cluster-revision', 'consul-raft-index', 'nacos-history-id'])
  .describe('修订号的含义：etcd 集群全局修订；Consul raft 索引（CreateIndex/ModifyIndex/X-Consul-Index）；Nacos 配置历史记录 ID（nid）');

export const MASK_NOTE = `键名或 JSON 字段名匹配敏感模式（password/passwd/pwd/secret/token/key/dsn/credential 等，按名称判断）的值以 "${MASK}" 替代；其他字符串值中内嵌的凭据（URL userinfo 密码如 mysql://u:${MASK}@h、token=/password=/secret= 参数、Authorization 头）就地替换，其余文本保留，masked=true，masked_paths 标出位置；有任何遮蔽时 value_bytes=null（不暴露长度）`;

export const ValueFields = {
  value: z.unknown().describe('JSON 可解析时为解析后的值，否则为文本；超出 ±2^53 的整数不做有损转换（单值为文本，JSON 内为数字字符串）；binary_base64 时为 base64；被遮蔽时为 "***"'),
  value_format: z.enum(['json', 'text', 'binary_base64', 'empty']),
  value_bytes: z.number().nullable().describe('原始值字节数；整个值或其中任一字段被遮蔽时为 null，避免泄露密钥长度'),
  masked: z.boolean(),
  masked_paths: z.array(z.string()).describe('被遮蔽的位置："$" 为整个值，"$.a.b" 为 JSON 字段'),
};

export const ItemSchema = z.object({
  key: z.string().describe('provider 内的完整定位：etcd / Consul 为完整键；Nacos 为 <namespace>/<group>/<dataId>#<name>'),
  name: z.string().describe('服务前缀（或 Nacos 配置文档）下的相对键名'),
  ...ValueFields,
  create_revision: z.number().nullable().describe('etcd create_revision；Consul CreateIndex；Nacos 没有键级修订，为 null'),
  mod_revision: z.number().nullable().describe('etcd mod_revision；Consul ModifyIndex；Nacos 为 null（文档级历史见 nacos.latest_history_id）'),
  version: z.number().nullable().describe('etcd：该键自创建以来的修改次数（删除后重建从 1 开始）；Consul / Nacos 不提供，为 null'),
  lease: z.string().nullable().describe('etcd 租约 ID（十进制字符串）；null 表示无租约（Consul / Nacos 恒为 null）'),
  consul: z.object({ flags: z.number(), lock_index: z.number(), session: z.string().nullable() }).optional().describe('Consul KV 元数据'),
});
export type Item = z.infer<typeof ItemSchema>;

export const NacosDocSchema = z
  .object({
    namespace: z.string().describe('命名空间 ID（tenant）；空串为 public'),
    group: z.string(),
    data_id: z.string(),
    exists: z.boolean().describe('配置文档是否存在（不存在时 items 为空）'),
    type: z.string().nullable().describe('Nacos 记录的配置类型（properties/yaml/json/text/xml/html）；未记录为 null'),
    content_format: z.enum(['properties', 'yaml', 'json', 'text']).describe('workctl 实际使用的解析方式'),
    parsed: z.boolean().describe('false 表示整个文档作为一个值返回（类型不可拆分或解析失败）'),
    parse_error: z.string().nullable(),
    md5: z.string().nullable().describe('Nacos 记录的内容 md5；文档含遮蔽值时为 null（md5 与其余明文可校验被遮蔽的值）'),
    content_bytes: z.number().nullable().describe('文档字节数；文档含遮蔽值时为 null'),
    last_modified: z.string().nullable(),
    latest_history_id: z.number().nullable().describe('最近一条配置历史记录 ID（config diff 的修订空间）；历史为空或无权限读取时为 null'),
  })
  .optional();

export const ConfigGetOutput = z.object({
  endpoint: z.string(),
  provider: ProviderSchema,
  provider_selected_by: z.string().describe('provider/端点的选择依据（--endpoint、资源绑定或 profile 默认）'),
  service: z.string(),
  env: z.string(),
  prefix: z.string().describe('etcd / Consul：读取的键前缀 <config_prefix><env>/<service>/；Nacos：<namespace>/<group>/<dataId>'),
  key: z.string().nullable(),
  revision_space: RevisionSpace,
  observed_revision: z.number().nullable().describe('读取时刻的修订：etcd 集群修订；Consul X-Consul-Index；Nacos 无全局修订，为 null'),
  count: z.number().describe('前缀（或文档）下的键总数（可能大于返回数）'),
  truncated: z.boolean(),
  items: z.array(ItemSchema),
  nacos: NacosDocSchema,
});

export const SideSchema = z
  .object({ ...ValueFields, mod_revision: z.number().nullable(), version: z.number().nullable(), create_revision: z.number().nullable() })
  .nullable();
export type Side = z.infer<typeof SideSchema>;

export function side(it: Item | undefined): Side {
  if (!it) return null;
  const { value, value_format, value_bytes, masked, masked_paths, mod_revision, version, create_revision } = it;
  return { value, value_format, value_bytes, masked, masked_paths, mod_revision, version, create_revision };
}

const HistoryRef = z
  .object({ id: z.number(), op_type: z.string().nullable().describe('I 新建 / U 修改 / D 删除'), modified_at: z.string().nullable(), src_user: z.string().nullable() })
  .nullable();

export const ChangeSchema = z.object({
  name: z.string(),
  key: z.string(),
  change: z.enum(['added', 'removed', 'changed']),
  masked: z.boolean().describe('任一侧的值被遮蔽；遮蔽时 changed 仍按原始内容判断'),
  old: SideSchema,
  new: SideSchema,
});
export type Change = z.infer<typeof ChangeSchema>;

export const DiffSummary = z.object({
  added: z.number(),
  removed: z.number(),
  changed: z.number(),
  unchanged: z.number(),
  rewritten_same_value: z.number().describe('值相同但在区间内被重新写入（etcd：mod_revision 变化；Nacos：键级不可知，恒为 0）'),
});

export const ConfigDiffOutput = z.object({
  endpoint: z.string(),
  provider: ProviderSchema,
  provider_selected_by: z.string(),
  service: z.string(),
  env: z.string(),
  prefix: z.string(),
  key: z.string().nullable(),
  revision_space: RevisionSpace,
  mode: z.enum(['revisions', 'previous_version']),
  from_revision: z.number().describe('起点（etcd 集群修订；Nacos 历史 ID，表示“该次变更生效后”的状态；0 表示文档创建前）'),
  to_revision: z.number(),
  current_revision: z.number(),
  changes: z.array(ChangeSchema),
  summary: DiffSummary,
  nacos: z
    .object({
      namespace: z.string(),
      group: z.string(),
      data_id: z.string(),
      from_history: HistoryRef,
      to_history: HistoryRef,
      history_records: z.number().describe('本次读取到的历史记录数（受保留期限制）'),
      oldest_history_id: z.number().nullable(),
    })
    .optional(),
});

export const InstanceSchema = z.object({
  instance_id: z.string().describe('etcd：<discovery_prefix><service>/ 之后的键名；Consul：Service.ID；Nacos：instanceId'),
  key: z.string(),
  payload: z.unknown().describe('注册内容（etcd JSON；Consul Service.Meta + Tags；Nacos metadata；敏感字段遮蔽）；无法解析时为 null'),
  payload_error: z.string().nullable(),
  address: z.string().nullable(),
  port: z.number().nullable(),
  version: z.string().nullable(),
  env: z.string().nullable(),
  healthy: z.boolean().nullable().describe('etcd：实例自报的 healthy 字段；Consul：健康检查聚合（critical → false）；Nacos：服务端健康状态；缺失为 null'),
  health_basis: z.enum(['self_reported', 'registry_checks', 'registry_health']).optional().describe('healthy 的依据'),
  registered_at: z.string().nullable(),
  create_revision: z.number().nullable(),
  mod_revision: z.number().nullable(),
  lease: z
    .object({
      id: z.string(),
      granted_ttl_s: z.number().nullable(),
      remaining_ttl_s: z.number().nullable().describe('剩余 TTL（秒）；-1 表示租约已过期/不存在'),
      error: z.string().nullable(),
    })
    .nullable()
    .describe('etcd 租约；null 表示注册未绑定租约（Consul / Nacos 恒为 null，见各自字段）'),
  consul: z
    .object({
      node: z.string().nullable(),
      status: z.enum(['passing', 'warning', 'critical']).describe('该实例全部检查（含节点级检查）的最差状态'),
      tags: z.array(z.string()),
      checks: z.array(z.object({ check_id: z.string(), name: z.string(), status: z.string(), service_level: z.boolean(), output: z.string() })),
    })
    .optional(),
  nacos: z
    .object({
      cluster: z.string().nullable(),
      weight: z.number().nullable(),
      enabled: z.boolean().nullable(),
      ephemeral: z.boolean().nullable().describe('true：临时实例（客户端心跳/连接维持，停止后自动摘除）；false：持久实例（服务端主动探测，不会自动删除）'),
    })
    .optional(),
});
export type Instance = z.infer<typeof InstanceSchema>;

export const DiscoveryOutput = z.object({
  endpoint: z.string(),
  provider: ProviderSchema,
  provider_selected_by: z.string(),
  service: z.string(),
  env: z.string().nullable(),
  prefix: z.string().describe('etcd：注册键前缀；Consul：/v1/health/service/<service>；Nacos：<namespace>/<group>@@<service>'),
  observed_revision: z.number().nullable().describe('etcd 集群修订；Consul X-Consul-Index；Nacos 为 null'),
  instances: z.array(InstanceSchema),
  summary: z.object({
    registered: z.number().describe('注册总数（过滤前）'),
    returned: z.number(),
    healthy: z.number().describe('健康实例数；Nacos 不计 enabled=false（已下线）的实例（见 disabled）'),
    unhealthy: z.number(),
    health_unknown: z.number(),
    without_lease: z.number().describe('etcd：没有租约的注册数；Consul / Nacos 为 0（不适用）'),
    disabled: z.number().optional().describe('Nacos：enabled=false（已下线、不接收流量）的实例数；它们不计入 healthy，--healthy-only 时排除'),
    excluded: z.object({ env_mismatch: z.number(), env_missing: z.number(), not_healthy: z.number(), disabled: z.number().optional().describe('Nacos：--healthy-only 排除的 enabled=false 实例') }),
    service_registered: z.boolean().nullable().optional().describe('Consul / Nacos：服务名是否在注册中心目录中（区分“未注册”与“0 个实例”）；无法判断为 null'),
  }),
});
