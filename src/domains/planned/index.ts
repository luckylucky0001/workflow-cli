import { defineCapability, defineDomain, type CapabilityDef, type DomainDef } from '../../core/registry';

/**
 * Capabilities that are part of the landscape (design §2) but not yet backed by
 * an adapter. They are listed in the catalog with status `planned` and never
 * become callable commands.
 */
function planned(name: string, command: string, summary: string, domain: string, adapter: string, guide: string): CapabilityDef {
  return defineCapability({
    name,
    command,
    summary,
    domain,
    adapter,
    operation: name.endsWith('.plan') ? 'plan' : 'read',
    auth_provider: 'tbd',
    guide,
    status: 'planned',
  });
}

const PLANNED: CapabilityDef[] = [
  planned('config.get', 'config get', '读取配置中心配置项的当前值摘要', 'config', 'config-center (待接入)', 'docs/guides/infrastructure.md'),
  planned('config.diff', 'config diff', '比较配置项两个版本的差异', 'config', 'config-center (待接入)', 'docs/guides/infrastructure.md'),
  planned('discovery.list', 'discovery list', '从服务注册中心列出服务实例', 'config', 'service-registry (待接入)', 'docs/guides/infrastructure.md'),
  planned('search.index.get', 'search index get', '查看搜索引擎索引的分片、容量和状态', 'search', 'elasticsearch/opensearch (待接入)', 'docs/provider-onboarding.md'),
  planned('search.query', 'search query', '对搜索引擎执行受限查询', 'search', 'elasticsearch/opensearch (待接入)', 'docs/provider-onboarding.md'),
  planned('document.collection.get', 'document collection get', '查看文档数据库集合与索引', 'document', 'document-db (待接入)', 'docs/provider-onboarding.md'),
  planned('kv.query', 'kv query', '对键值服务执行受限查询', 'document', 'kv-service (待接入)', 'docs/provider-onboarding.md'),
  planned('analytics.query.get', 'analytics query get', '查看分析数据库查询的状态与资源使用', 'analytics', 'columnar-engine (待接入)', 'docs/provider-onboarding.md'),
  planned('analytics.table.get', 'analytics table get', '查看分析数据库表结构与分区', 'analytics', 'columnar-engine (待接入)', 'docs/provider-onboarding.md'),
  planned('middleware.operation.plan', 'middleware operation plan', '托管中间件生命周期操作（创建、参数、备份、扩容、迁移）计划', 'middleware', 'managed-middleware-platform (待接入)', 'docs/guides/operations.md'),
];

const domains: DomainDef[] = [
  { name: 'config', title: '配置与服务发现', summary: '配置中心与服务注册（待接入）', pillar: 'infrastructure', guide: 'docs/guides/infrastructure.md', capabilities: [] },
  { name: 'search', title: '搜索引擎', summary: 'Elasticsearch / OpenSearch（待接入）', pillar: 'middleware', guide: 'docs/provider-onboarding.md', capabilities: [] },
  { name: 'document', title: '文档与键值数据库', summary: '文档库、KV 服务（待接入）', pillar: 'middleware', guide: 'docs/provider-onboarding.md', capabilities: [] },
  { name: 'analytics', title: '分析数据库', summary: '列式分析引擎（待接入）', pillar: 'middleware', guide: 'docs/provider-onboarding.md', capabilities: [] },
  { name: 'middleware', title: '中间件生命周期', summary: '托管平台操作入口（待接入）', pillar: 'middleware', guide: 'docs/guides/operations.md', capabilities: [] },
];

/** Registered as one pseudo-domain carrying the planned capabilities plus their domain metadata. */
export const PLANNED_DOMAINS = domains;

export default defineDomain({
  name: 'planned',
  title: '待接入能力',
  summary: '能力全景中尚未接入的能力；只出现在目录中，不可调用',
  pillar: 'core',
  guide: 'docs/capability-catalog.md',
  capabilities: PLANNED,
});
