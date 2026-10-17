import { z } from 'zod';
import { secretRefStatus } from '../../core/config';
import { source, WorkError } from '../../core/output';
import { PlanSchema } from '../../core/operations';
import { defineCapability, defineDomain, describeCapability, type CapabilityDef } from '../../core/registry';
import type { Ctx } from '../../core/runtime';
import { RelationSchema, ResourceSchema } from '../../core/resources';

const GUIDE = 'docs/capability-catalog.md';

/** Endpoint kind each domain talks to; used by auth status and access check. */
export const DOMAIN_ENDPOINT_KINDS: Record<string, string[]> = {
  mysql: ['mysql'],
  redis: ['redis'],
  offline: ['airflow'],
  compute: ['spark', 'airflow'],
  sql: ['spark'],
  data: ['catalog'],
  container: ['docker'],
  network: ['docker'],
  storage: ['docker'],
  observability: ['prometheus', 'docker'],
  mq: ['kafka'],
};

export const ENDPOINT_AUTH_PROVIDERS: Record<string, string> = {
  mysql: 'database-profile',
  redis: 'redis-profile',
  airflow: 'airflow-basic',
  spark: 'none (local history server)',
  docker: 'docker-socket',
  prometheus: 'none',
  catalog: 'filesystem',
  kafka: 'kafka-profile',
};

const CapabilitySummary = z.object({
  name: z.string(),
  command: z.string(),
  summary: z.string(),
  domain: z.string(),
  status: z.enum(['available', 'requires_auth', 'planned']),
  operation: z.string(),
  adapter: z.string(),
  capability_version: z.string(),
  origin: z.string(),
});

const capabilityList = defineCapability({
  name: 'capability.list',
  command: 'capability list',
  summary: '列出能力目录（已支持、需授权、待接入），支持按领域/状态/操作类型过滤',
  domain: 'core',
  inputs: {
    domain: { type: 'string', description: '领域，如 mysql、redis、offline、mq' },
    status: { type: 'enum', enum: ['available', 'requires_auth', 'planned'], description: '能力状态' },
    operation: { type: 'enum', enum: ['read', 'diagnose', 'plan', 'execute'], description: '操作类型' },
    query: { type: 'string', description: '按名称/命令/摘要关键词搜索' },
  },
  output: z.object({
    capabilities: z.array(CapabilitySummary),
    domains: z.array(z.object({ name: z.string(), title: z.string(), pillar: z.string(), summary: z.string(), guide: z.string(), skill: z.string().nullable(), available: z.number(), planned: z.number(), origin: z.string() })),
  }),
  adapter: 'registry',
  operation: 'read',
  auth_provider: 'none',
  guide: GUIDE,
  examples: ['workctl --json capability list --domain mysql', 'workctl capability list --status planned'],
  handler: async (ctx, i) => {
    const caps = ctx.registry.list({ domain: i.domain, status: i.status, operation: i.operation, query: i.query });
    const domains = [...ctx.registry.domains.values()]
      .filter((d) => !i.domain || d.name === i.domain || caps.some((c) => c.domain === d.name))
      .map((d) => {
        const all = ctx.registry.list({ domain: d.name });
        return {
          name: d.name,
          title: d.title,
          pillar: d.pillar,
          summary: d.summary,
          guide: d.guide,
          skill: d.skill ?? null,
          available: all.filter((c) => c.status !== 'planned').length,
          planned: all.filter((c) => c.status === 'planned').length,
          origin: all[0]?.origin ?? 'builtin',
        };
      })
      .filter((d) => d.available + d.planned > 0);
    return {
      data: {
        capabilities: caps.map((c) => ({
          name: c.name,
          command: c.command,
          summary: c.summary,
          domain: c.domain,
          status: c.status,
          operation: c.operation,
          adapter: c.adapter,
          capability_version: c.capability_version,
          origin: c.origin ?? 'builtin',
        })),
        domains,
      },
      sources: [source('workctl', 'registry', { method: 'builtin + installed plugins', relation: 'explicit' })],
      coverage: { complete: true, scope: '内置能力与已安装插件' },
    };
  },
});

const capabilityGet = defineCapability({
  name: 'capability.get',
  command: 'capability get',
  summary: '查看单个能力的定义：参数、输出 Schema、操作类型、认证方式、版本和指南',
  domain: 'core',
  inputs: { name: { type: 'string', required: true, description: '能力名，如 mysql.table.get' } },
  output: z.object({ definition: z.record(z.string(), z.unknown()), output_json_schema: z.record(z.string(), z.unknown()).nullable(), domain_guide: z.string().nullable(), skill: z.string().nullable() }),
  adapter: 'registry',
  operation: 'read',
  auth_provider: 'none',
  guide: GUIDE,
  examples: ['workctl capability get --name mysql.table.get'],
  handler: async (ctx, i) => {
    const c = ctx.registry.get(i.name);
    if (!c) throw new WorkError('NOT_FOUND', `能力不存在: ${i.name}`, { hint: '用 workctl capability list --query <关键词> 查找' });
    const d = ctx.registry.domains.get(c.domain);
    return {
      data: { definition: describeCapability(c), output_json_schema: ctx.registry.outputJsonSchema(c) ?? null, domain_guide: d?.guide ?? null, skill: d?.skill ?? null },
      sources: [source('workctl', 'registry', { relation: 'explicit' })],
    };
  },
});

function requireBindings(ctx: Ctx) {
  const store = ctx.resources();
  if (!store.configured) {
    throw new WorkError('NOT_CONFIGURED', `profile ${ctx.profileName ?? '(无)'} 未配置 resources_file`, { hint: '在 profile 中设置 resources_file，或接入资产目录适配器' });
  }
  return store;
}

const bindingSource = (ctx: Ctx) => source('resource-bindings', 'binding-file', { endpoint: ctx.resources().path ?? undefined, relation: 'explicit' });

const resourceList = defineCapability({
  name: 'resource.list',
  command: 'resource list',
  summary: '检索已绑定资源；指定 --service 时返回该服务及其依赖资源',
  domain: 'core',
  inputs: {
    service: { type: 'string', description: '服务 ID，如 demo-order' },
    env: { type: 'string', description: '环境，如 sandbox' },
    type: { type: 'string', description: '资源类型前缀，如 mysql、offline.workflow' },
  },
  output: z.object({ resources: z.array(ResourceSchema), relations: z.array(RelationSchema) }),
  adapter: 'binding-file',
  operation: 'read',
  auth_provider: 'none',
  guide: 'docs/resource-model.md',
  examples: ['workctl --json resource list --service demo-order --env sandbox'],
  handler: async (ctx, i) => {
    const store = requireBindings(ctx);
    const env = i.env ?? ctx.env ?? undefined;
    if (i.service) {
      const svc = store.require(i.service);
      if (i.env && svc.env && svc.env !== i.env) throw new WorkError('NOT_FOUND', `${i.service} 不在环境 ${i.env}`);
      const closure = store.closure(svc.id);
      const ids = new Set([svc.id, ...closure.map((c) => c.relation.to)]);
      const resources = store.resources.filter((r) => ids.has(r.id) && (!i.type || r.type.startsWith(i.type)));
      return {
        data: { resources, relations: closure.map((c) => c.relation) },
        sources: [bindingSource(ctx)],
        coverage: { complete: true, scope: `绑定文件中从 ${svc.id} 可达的资源`, notes: closure.some((c) => !c.resource) ? ['部分关系指向未登记的资源'] : undefined },
      };
    }
    const resources = store.list({ type: i.type, env });
    return { data: { resources, relations: [] }, sources: [bindingSource(ctx)], coverage: { complete: true, scope: '绑定文件' } };
  },
});

const resourceGet = defineCapability({
  name: 'resource.get',
  command: 'resource get',
  summary: '查看单个资源及其上下游关系（含关系来源与依据）',
  domain: 'core',
  inputs: { id: { type: 'string', required: true, description: '资源 ID' } },
  output: z.object({ resource: ResourceSchema, upstream: z.array(RelationSchema), downstream: z.array(RelationSchema) }),
  adapter: 'binding-file',
  operation: 'read',
  auth_provider: 'none',
  guide: 'docs/resource-model.md',
  handler: async (ctx, i) => {
    const store = requireBindings(ctx);
    const r = store.require(i.id);
    return {
      data: { resource: r, upstream: store.relationsOf(r.id, 'upstream'), downstream: store.relationsOf(r.id, 'downstream') },
      sources: [bindingSource(ctx)],
    };
  },
});

const DependencyItem = z.object({
  resource_id: z.string(),
  type: z.string().nullable(),
  relation: z.string(),
  via: z.string(),
  depth: z.number(),
  source: z.string(),
  evidence: z.string().nullable(),
  registered: z.boolean(),
  endpoint: z.object({ kind: z.string(), name: z.string() }).nullable(),
});

const serviceDependencyList = defineCapability({
  name: 'service.dependency.list',
  command: 'service dependency list',
  summary: '列出服务的依赖资源（直接与传递）及依赖它的对象，每条关系带来源与依据',
  domain: 'core',
  inputs: {
    service: { type: 'string', required: true, description: '服务 ID' },
    env: { type: 'string', description: '环境' },
    depth: { type: 'int', default: 2, description: '传递依赖深度' },
  },
  output: z.object({ service: z.string(), env: z.string().nullable(), dependencies: z.array(DependencyItem), dependents: z.array(DependencyItem) }),
  adapter: 'binding-file',
  operation: 'read',
  auth_provider: 'none',
  guide: 'docs/resource-model.md',
  notes: ['关系只来自绑定文件/服务配置等明确来源；不会根据名称相似性推断依赖'],
  examples: ['workctl --json service dependency list --service demo-order --env sandbox'],
  handler: async (ctx, i) => {
    const store = requireBindings(ctx);
    const svc = store.require(i.service);
    if (i.env && svc.env && svc.env !== i.env) throw new WorkError('NOT_FOUND', `${i.service} 不在环境 ${i.env}`);
    const item = (id: string, rel: z.infer<typeof RelationSchema>, depth: number, via: string) => {
      const r = store.get(id);
      return { resource_id: id, type: r?.type ?? null, relation: rel.type, via, depth, source: rel.source, evidence: rel.evidence ?? null, registered: !!r, endpoint: r?.endpoint ?? null };
    };
    const dependencies = store.closure(svc.id, i.depth).map((c) => item(c.relation.to, c.relation, c.depth, c.relation.from));
    const dependents = store.relationsOf(svc.id, 'upstream').map((rel) => item(rel.from, rel, 1, svc.id));
    return {
      data: { service: svc.id, env: svc.env ?? null, dependencies, dependents },
      sources: [bindingSource(ctx)],
      coverage: { complete: true, scope: `绑定文件，深度 ${i.depth}`, notes: ['运行时调用关系可用 trace get / log query 交叉验证'] },
    };
  },
});

const authStatus = defineCapability({
  name: 'auth.status',
  command: 'auth status',
  summary: '查看当前 profile 的身份配置：各端点的认证方式、凭据引用是否可解析；--probe 时实际连接校验身份',
  domain: 'core',
  inputs: { probe: { type: 'bool', default: false, description: '实际连接目标系统校验身份与权限' } },
  output: z.object({
    profile: z.string().nullable(),
    env: z.string().nullable(),
    config_path: z.string().nullable(),
    allow_execute: z.boolean(),
    endpoints: z.array(z.object({
      kind: z.string(),
      name: z.string(),
      auth_provider: z.string(),
      credential_refs: z.array(z.object({ key: z.string(), ref_type: z.string(), resolvable: z.boolean(), reason: z.string().optional() })),
      probe: z.object({ ok: z.boolean(), identity: z.string().optional(), version: z.string().optional(), detail: z.string().optional(), privileges: z.array(z.string()).optional() }).nullable(),
    })),
  }),
  adapter: 'profile',
  operation: 'read',
  auth_provider: 'none',
  guide: 'docs/quickstart.md',
  notes: ['只显示凭据引用类型与可解析性，不输出凭据值', '实际授权仍由目标系统校验'],
  handler: async (ctx, i) => {
    const p = ctx.requireProfile();
    const endpoints = [];
    for (const [kind, named] of Object.entries(p.endpoints)) {
      for (const [name, cfg] of Object.entries(named)) {
        const refs = Object.entries(cfg)
          .filter(([k]) => k.endsWith('_ref'))
          .map(([k, v]) => ({ key: k, ...secretRefStatus(String(v), ctx.loaded.baseDir) }));
        let probe = null;
        if (i.probe && ctx.registry.probes.has(kind)) {
          try {
            probe = await ctx.registry.probes.get(kind)!(ctx, name);
          } catch (e) {
            probe = { ok: false, detail: e instanceof Error ? e.message : String(e) };
          }
        }
        endpoints.push({ kind, name, auth_provider: ENDPOINT_AUTH_PROVIDERS[kind] ?? 'plugin-defined', credential_refs: refs, probe });
      }
    }
    return {
      data: { profile: ctx.profileName, env: ctx.env, config_path: ctx.loaded.path, allow_execute: p.allow_execute, endpoints },
      sources: [source('workctl', 'profile', { endpoint: ctx.loaded.path ?? undefined, relation: 'explicit' })],
      coverage: { complete: true, notes: i.probe ? [] : ['未执行实际连接；加 --probe 校验身份'] },
    };
  },
});

const accessCheck = defineCapability({
  name: 'access.check',
  command: 'access check',
  summary: '检查调用某能力的前置条件：能力状态、执行授权、端点配置、凭据可解析、目标系统身份与权限',
  domain: 'core',
  inputs: {
    capability: { type: 'string', required: true, description: '能力名，如 mysql.query.execute' },
    target: { type: 'string', description: '端点名，如 demo-mysql；缺省使用 profile 默认端点' },
    probe: { type: 'bool', default: true, description: '是否实际连接目标系统' },
  },
  output: z.object({
    capability: z.string(),
    operation: z.string(),
    verdict: z.enum(['allowed', 'denied', 'unknown']),
    checks: z.array(z.object({ check: z.string(), ok: z.boolean().nullable(), detail: z.string() })),
  }),
  adapter: 'profile',
  operation: 'read',
  auth_provider: 'none',
  guide: 'docs/quickstart.md',
  notes: ['verdict=allowed 只说明 workctl 侧前置条件满足；最终授权由目标系统在调用时校验'],
  handler: async (ctx, i) => {
    const c = ctx.registry.get(i.capability);
    if (!c) throw new WorkError('NOT_FOUND', `能力不存在: ${i.capability}`);
    const checks: { check: string; ok: boolean | null; detail: string }[] = [];
    checks.push({ check: 'capability_status', ok: c.status !== 'planned', detail: c.status === 'planned' ? '能力待接入，不可调用' : `状态 ${c.status}` });
    const p = ctx.profile;
    checks.push({ check: 'profile', ok: !!p, detail: p ? `profile ${ctx.profileName} (env ${p.env})` : '没有可用 profile' });
    if (c.operation === 'execute') {
      checks.push({ check: 'execute_permission', ok: !!p?.allow_execute, detail: p?.allow_execute ? 'profile 允许执行类操作' : 'profile 未开启 allow_execute' });
    }
    const kinds = DOMAIN_ENDPOINT_KINDS[c.domain] ?? [];
    for (const kind of kinds) {
      if (!p) break;
      if (!ctx.hasEndpoint(kind)) {
        checks.push({ check: `endpoint:${kind}`, ok: kinds.length > 1 ? null : false, detail: `未配置 ${kind} 端点` });
        continue;
      }
      let name: string;
      try {
        name = ctx.endpoint(kind, i.target && ctx.hasEndpoint(kind, i.target) ? i.target : undefined).name;
      } catch (e) {
        checks.push({ check: `endpoint:${kind}`, ok: false, detail: e instanceof Error ? e.message : String(e) });
        continue;
      }
      checks.push({ check: `endpoint:${kind}`, ok: true, detail: `${kind}/${name}` });
      const cfg = p.endpoints[kind][name];
      for (const [k, v] of Object.entries(cfg).filter(([k]) => k.endsWith('_ref'))) {
        const st = secretRefStatus(String(v), ctx.loaded.baseDir);
        checks.push({ check: `credential:${kind}/${name}.${k}`, ok: st.resolvable, detail: st.resolvable ? `${st.ref_type} 引用可解析` : st.reason ?? '不可解析' });
      }
      const probe = ctx.registry.probes.get(kind);
      if (i.probe && probe) {
        try {
          const r = await probe(ctx, name);
          checks.push({ check: `identity:${kind}/${name}`, ok: r.ok, detail: [r.identity && `身份 ${r.identity}`, r.version && `版本 ${r.version}`, r.detail].filter(Boolean).join('；') || (r.ok ? '连接成功' : '连接失败') });
          if (r.privileges?.length) checks.push({ check: `privileges:${kind}/${name}`, ok: null, detail: r.privileges.join(' | ').slice(0, 800) });
        } catch (e) {
          checks.push({ check: `identity:${kind}/${name}`, ok: false, detail: e instanceof Error ? e.message : String(e) });
        }
      }
    }
    const failed = checks.some((x) => x.ok === false);
    const unknown = checks.some((x) => x.ok === null);
    return {
      data: { capability: c.name, operation: c.operation, verdict: failed ? 'denied' : unknown ? 'unknown' : 'allowed', checks },
      sources: [source('workctl', 'profile', { relation: 'derived' })],
    };
  },
});

const operationPlan = defineCapability({
  name: 'operation.plan',
  command: 'operation plan',
  summary: '为受控操作生成计划：解析实际目标、影响范围、前置条件和步骤（不执行）',
  domain: 'core',
  inputs: {
    action: { type: 'string', required: true, description: '操作类型，如 container.restart、mysql.index.create、offline.backfill' },
    param: { type: 'list', description: '参数 key=value，可重复或逗号分隔，如 --param service=demo-order --param env=sandbox' },
  },
  output: PlanSchema,
  adapter: 'plan-store',
  operation: 'plan',
  auth_provider: 'none',
  guide: 'docs/guides/operations.md',
  notes: ['计划预览不是执行成功的证据；执行需通过 operation execute 并满足授权条件'],
  examples: ['workctl --json operation plan --action container.restart --param service=demo-order --param env=sandbox'],
  handler: async (ctx, i) => {
    const planner = ctx.registry.planners.get(i.action);
    if (!planner) {
      throw new WorkError('NOT_FOUND', `没有操作类型 ${i.action} 的计划器`, { hint: `可用: ${[...ctx.registry.planners.keys()].join(', ') || '(无)'}` });
    }
    const params: Record<string, string> = {};
    for (const kv of (i.param as string[] | undefined) ?? []) {
      const idx = kv.indexOf('=');
      if (idx <= 0) throw new WorkError('INVALID_ARGUMENT', `参数格式应为 key=value: ${kv}`);
      params[kv.slice(0, idx).trim()] = kv.slice(idx + 1).trim();
    }
    const draft = await planner.plan(ctx, params);
    const plan = ctx.plans().create(draft, { profile: ctx.profileName, env: ctx.env, executable: ctx.registry.executors.has(draft.kind) });
    return { data: plan, sources: [source('workctl', 'plan-store', { endpoint: ctx.plans().dir, relation: 'derived' })] };
  },
});

const operationGet = defineCapability({
  name: 'operation.get',
  command: 'operation get',
  summary: '查看操作计划或执行任务的状态、历史和结果',
  domain: 'core',
  inputs: { id: { type: 'string', required: true, description: '计划/任务 ID（op-...）' } },
  output: PlanSchema,
  adapter: 'plan-store',
  operation: 'read',
  auth_provider: 'none',
  guide: 'docs/guides/operations.md',
  handler: async (ctx, i) => ({ data: ctx.plans().get(i.id), sources: [source('workctl', 'plan-store', { relation: 'explicit' })] }),
});

const operationList = defineCapability({
  name: 'operation.list',
  command: 'operation list',
  summary: '列出当前 profile 下的操作计划与执行任务',
  domain: 'core',
  inputs: {
    kind: { type: 'string', description: '操作类型' },
    status: { type: 'enum', enum: ['planned', 'running', 'succeeded', 'failed', 'cancelled', 'expired'], description: '状态' },
  },
  output: z.object({ operations: z.array(PlanSchema.pick({ id: true, kind: true, title: true, status: true, created_at: true, expires_at: true, executable: true })) }),
  adapter: 'plan-store',
  operation: 'read',
  auth_provider: 'none',
  guide: 'docs/guides/operations.md',
  handler: async (ctx, i) => ({
    data: { operations: ctx.plans().list({ kind: i.kind, status: i.status }).map(({ id, kind, title, status, created_at, expires_at, executable }) => ({ id, kind, title, status, created_at, expires_at, executable })) },
    sources: [source('workctl', 'plan-store', { relation: 'explicit' })],
    coverage: { complete: true, scope: `profile ${ctx.profileName} 的本地计划存储` },
  }),
});

const operationExecute = defineCapability({
  name: 'operation.execute',
  command: 'operation execute',
  summary: '执行已生成的操作计划（需要 allow_execute 和与计划 ID 一致的确认）',
  domain: 'core',
  inputs: {
    id: { type: 'string', required: true, description: '计划 ID' },
    confirm: { type: 'string', required: true, description: '再次输入计划 ID 以确认执行', agent_hidden: true },
  },
  output: PlanSchema,
  adapter: 'plan-store',
  operation: 'execute',
  auth_provider: 'per-plan',
  guide: 'docs/guides/operations.md',
  idempotent: false,
  side_effects: '按计划对目标系统做变更',
  notes: ['只执行状态为 planned 且未过期的计划', '执行前重新校验 profile 与环境与计划一致', '执行结果以执行器返回与 operation get 状态为准'],
  handler: async (ctx, i) => {
    if (i.confirm !== i.id) throw new WorkError('PRECONDITION_FAILED', '--confirm 必须与计划 ID 一致');
    const store = ctx.plans();
    const plan = store.get(i.id);
    if (plan.status !== 'planned') throw new WorkError('CONFLICT', `计划状态为 ${plan.status}，只能执行 planned 状态的计划`);
    if (plan.profile !== ctx.profileName || plan.env !== ctx.env) {
      throw new WorkError('PRECONDITION_FAILED', `计划生成于 profile ${plan.profile}/env ${plan.env}，与当前 ${ctx.profileName}/${ctx.env} 不一致`);
    }
    const failedPre = plan.preconditions.filter((p) => !p.ok);
    if (failedPre.length) throw new WorkError('PRECONDITION_FAILED', `计划存在未满足的前置条件: ${failedPre.map((p) => p.check).join(', ')}`);
    const executor = ctx.registry.executors.get(plan.kind);
    if (!executor) throw new WorkError('UNSUPPORTED', `操作类型 ${plan.kind} 没有执行器，计划只能作为变更方案参考`);
    store.transition(plan.id, 'running', `由 ${ctx.requestId} 开始执行`);
    try {
      const result = await executor(ctx, store.get(plan.id), (note) => {
        const p = store.get(plan.id);
        p.history.push({ at: new Date().toISOString(), status: 'running', note });
        store.save(p);
      });
      const done = store.transition(plan.id, 'succeeded', '执行器返回成功', { result });
      return { data: done, sources: [source('workctl', 'plan-store', { relation: 'explicit' })] };
    } catch (e) {
      const we = e instanceof WorkError ? e : new WorkError('INTERNAL', e instanceof Error ? e.message : String(e));
      store.transition(plan.id, 'failed', we.message, { error: { code: we.code, message: we.message } });
      throw we;
    }
  },
});

const operationCancel = defineCapability({
  name: 'operation.cancel',
  command: 'operation cancel',
  summary: '取消尚未执行的计划',
  domain: 'core',
  inputs: { id: { type: 'string', required: true, description: '计划 ID' } },
  output: PlanSchema,
  adapter: 'plan-store',
  operation: 'plan',
  auth_provider: 'none',
  guide: 'docs/guides/operations.md',
  handler: async (ctx, i) => {
    const p = ctx.plans().get(i.id);
    if (p.status !== 'planned') throw new WorkError('CONFLICT', `计划状态为 ${p.status}，无法取消`);
    return { data: ctx.plans().transition(i.id, 'cancelled', '用户取消'), sources: [source('workctl', 'plan-store', { relation: 'explicit' })] };
  },
});

export const CORE_CAPABILITIES: CapabilityDef[] = [
  capabilityList,
  capabilityGet,
  resourceList,
  resourceGet,
  serviceDependencyList,
  authStatus,
  accessCheck,
  operationPlan,
  operationGet,
  operationList,
  operationExecute,
  operationCancel,
];

export default defineDomain({
  name: 'core',
  title: '核心',
  summary: '能力发现、资源关系、身份与授权检查、操作计划与状态',
  pillar: 'core',
  guide: 'docs/capability-catalog.md',
  skill: 'skills/enterprise-infra',
  capabilities: CORE_CAPABILITIES,
});
