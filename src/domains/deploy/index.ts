import { z } from 'zod';
import { PlanSchema } from '../../core/operations';
import { source, WorkError, type Result } from '../../core/output';
import { defineCapability, defineDomain, type Executor, type Planner } from '../../core/registry';
import type { Ctx } from '../../core/runtime';
import { K8S_ADAPTER, kubeClient } from '../container/kubernetes';
import { CONSOLE_TAIL_DEFAULT, JENKINS_ADAPTER, jenkinsClient, jenkinsProbe, jenkinsReleaseGet, jenkinsReleaseList, jenkinsRollbackExecutor, jenkinsStatusGet, planJenkinsRollback } from './jenkins';
import { k8sReleaseGet, k8sReleaseList, k8sRollbackExecutor, k8sStatusGet, planK8sRollback } from './k8s';
import { deployBindingFor, ReleaseSchema, resolveEnv, TargetSchema } from './model';

const GUIDE = 'docs/guides/deploy.md';
const ADAPTERS = `${K8S_ADAPTER} | ${JENKINS_ADAPTER}`;
const AUTH = 'kubernetes-bearer | jenkins-basic';
export const ROLLBACK_KIND = 'deploy.rollback';
const PREREQ = [
  '资源绑定中有 type: deploy.target 的资源：attributes.service=<服务>，endpoint {kind: kubernetes|jenkins}',
  'Kubernetes：attributes.namespace + attributes.deployment；身份需要 get/list deployments、replicasets、pods（回滚执行另需 patch deployments）',
  'Jenkins：attributes.job（文件夹写 folder/job）；profile endpoints.jenkins.<name>（url、user、token_ref 或 password_ref），身份需要 Overall/Read + Job/Read（回滚执行另需 Job/Build）',
];
const PROVIDER_NOTE = 'provider 由资源绑定的 deploy.target 决定（kubernetes 或 jenkins），两者输出同一 schema；Argo CD / Spinnaker / 内部发布平台尚未接入';

const serviceInputs = {
  service: { type: 'string' as const, required: true, description: '服务 ID（资源绑定中 deploy.target 的 attributes.service）' },
  env: { type: 'string' as const, description: '环境；默认取 profile 的 env' },
};

function binding(ctx: Ctx, i: Record<string, any>) {
  return deployBindingFor(ctx, i.service, resolveEnv(ctx, i.env));
}

const releaseList = defineCapability({
  name: 'deploy.release.list',
  command: 'deploy release list',
  domain: 'deploy',
  summary: '列出服务最近的发布/rollout（新→旧）：版本/镜像、修订、开始/结束时间、状态、触发人/原因',
  description: 'Kubernetes：Deployment 保留的 ReplicaSet 修订（kubectl rollout history）；Jenkins：部署 job 的构建。同一输出 schema。',
  inputs: {
    ...serviceInputs,
    window: { type: 'duration', default: '7d', description: '只看该时间窗口内开始的发布（Kubernetes 当前修订总是包含）' },
    limit: { type: 'int', default: 20, description: '最多返回条数' },
  },
  output: z.object({ service: z.string(), env: z.string().nullable(), target: TargetSchema, releases: z.array(ReleaseSchema), retained: z.number().describe('provider 当前保留的发布总数（不受窗口限制）') }),
  adapter: ADAPTERS,
  operation: 'read',
  auth_provider: AUTH,
  guide: GUIDE,
  prerequisites: PREREQ,
  notes: [
    PROVIDER_NOTE,
    'Kubernetes：只保留 revisionHistoryLimit 个旧 ReplicaSet；started_at 为 ReplicaSet creationTimestamp（derived），没有精确的 rollout 完成时间；被替代修订的 status 为 unknown（API 不保存当时结果）；回滚会复用旧 ReplicaSet 并给它新的修订号',
    'Jenkins：构建 timestamp/duration 为 explicit；只保留构建丢弃策略允许的构建（策略从 config.xml 读取，需要 Job/ExtendedRead）；current 为最近一次成功构建，不代表目标环境实际运行版本',
  ],
  examples: ['workctl deploy release list --service demo-order --env sandbox --window 7d'],
  handler: async (ctx, i): Promise<Result> => {
    const b = binding(ctx, i);
    if (i.limit < 1) throw new WorkError('INVALID_ARGUMENT', '--limit 须 ≥ 1');
    return b.provider === 'kubernetes' ? k8sReleaseList(ctx, b, i.window, i.limit) : jenkinsReleaseList(ctx, b, i.window, i.limit);
  },
});

const KubeDetail = z.object({
  namespace: z.string(),
  deployment: z.string(),
  replicaset: z.string(),
  uid: z.string().nullable(),
  revision: z.number().nullable(),
  revision_history: z.array(z.number()).describe('deployment.kubernetes.io/revision-history：该 ReplicaSet 曾用过的修订号（回滚复用）'),
  pod_template_hash: z.string().nullable(),
  change_cause: z.string().nullable(),
  created_at: z.string().nullable(),
  replicas: z.object({ desired: z.number(), current: z.number(), ready: z.number(), available: z.number() }),
  containers: z.array(z.object({ name: z.string(), image: z.string(), env: z.array(z.object({ name: z.string(), value: z.string() })) })),
  diff_vs_current: z
    .object({ against_revision: z.number().nullable(), images: z.array(z.object({ container: z.string(), this_release: z.string(), current: z.string() })), env_changed: z.array(z.string()) })
    .nullable(),
});

const JenkinsDetail = z.object({
  job: z.string(),
  number: z.number(),
  result: z.string().nullable(),
  building: z.boolean(),
  estimated_duration_ms: z.number().nullable(),
  built_on: z.string().nullable(),
  parameters: z.record(z.string(), z.string()).describe('构建参数；名称像凭据的值已遮蔽'),
  causes: z.array(z.object({ description: z.string().nullable(), user_id: z.string().nullable() })),
  console: z.object({ lines: z.array(z.string()), total_lines: z.number(), truncated: z.boolean(), masked: z.boolean() }),
});

const releaseGet = defineCapability({
  name: 'deploy.release.get',
  command: 'deploy release get',
  domain: 'deploy',
  summary: '查看一次发布的详情：Kubernetes 修订的镜像/变更原因/副本数/与当前差异；Jenkins 构建参数/结果/耗时/原因/控制台日志末尾（遮蔽）',
  inputs: {
    ...serviceInputs,
    id: { type: 'string', required: true, description: '发布 ID：Kubernetes 为 ReplicaSet 名或修订号；Jenkins 为构建号' },
    tail: { type: 'int', default: CONSOLE_TAIL_DEFAULT, description: 'Jenkins 控制台日志返回的末尾行数' },
  },
  output: z.object({
    service: z.string(),
    env: z.string().nullable(),
    target: TargetSchema,
    release: ReleaseSchema,
    kubernetes: KubeDetail.optional(),
    jenkins: JenkinsDetail.optional(),
  }),
  adapter: ADAPTERS,
  operation: 'read',
  auth_provider: AUTH,
  guide: GUIDE,
  prerequisites: PREREQ,
  notes: [PROVIDER_NOTE, '发布 ID 不在保留范围内时返回 NOT_FOUND（Kubernetes 已按 revisionHistoryLimit 清理 / Jenkins 已按构建丢弃策略清理）', '环境变量/构建参数中名称像凭据的值、控制台日志中的 password/token/secret=… 均遮蔽'],
  examples: ['workctl deploy release get --service demo-order --env sandbox --id 3', 'workctl deploy release get --service demo-order --id demo-order-7b48cf7b44'],
  handler: async (ctx, i): Promise<Result> => {
    const b = binding(ctx, i);
    if (i.tail < 0 || i.tail > 1000) throw new WorkError('INVALID_ARGUMENT', '--tail 须在 0..1000');
    return b.provider === 'kubernetes' ? k8sReleaseGet(ctx, b, i.id) : jenkinsReleaseGet(ctx, b, i.id, i.tail);
  },
});

const statusGet = defineCapability({
  name: 'deploy.status.get',
  command: 'deploy status get',
  domain: 'deploy',
  summary: '查看服务当前的发布状态：Kubernetes rollout 条件与副本数；Jenkins 是否有部署构建在运行/排队',
  inputs: serviceInputs,
  output: z.object({
    service: z.string(),
    env: z.string().nullable(),
    target: TargetSchema,
    provider: z.enum(['kubernetes', 'jenkins']),
    state: z.enum(['complete', 'progressing', 'failed', 'paused', 'queued', 'aborted', 'unknown']),
    detail: z.string(),
    current_release: ReleaseSchema.nullable(),
    in_progress: z.boolean(),
    kubernetes: z
      .object({
        generation: z.number().nullable(),
        observed_generation: z.number().nullable(),
        paused: z.boolean(),
        progress_deadline_seconds: z.number().nullable(),
        replicas: z.object({ desired: z.number(), current: z.number(), updated: z.number(), ready: z.number(), available: z.number(), unavailable: z.number() }),
        conditions: z.array(z.object({ type: z.string(), status: z.string(), reason: z.string().nullable(), message: z.string().nullable(), last_update: z.string().nullable() })),
        pods: z.array(z.object({ name: z.string(), revision: z.number().nullable(), phase: z.string().nullable(), ready: z.boolean(), waiting_reasons: z.array(z.string()), restarts: z.number(), terminating: z.boolean() })),
      })
      .nullable(),
    jenkins: z
      .object({
        job: z.string(),
        running: z.array(ReleaseSchema),
        queued: z.array(z.object({ queue_id: z.number(), why: z.string().nullable(), in_queue_since: z.string().nullable(), blocked: z.boolean(), stuck: z.boolean() })),
        last_build: ReleaseSchema.nullable(),
      })
      .nullable(),
  }),
  adapter: ADAPTERS,
  operation: 'read',
  auth_provider: AUTH,
  guide: GUIDE,
  prerequisites: PREREQ,
  notes: [
    PROVIDER_NOTE,
    'Kubernetes：state 按 kubectl rollout status 语义（observedGeneration、updated/available 副本、Progressing=ProgressDeadlineExceeded → failed、spec.paused → paused）；pods 列出各修订 Pod 的就绪与等待原因（如 ImagePullBackOff）',
    'Jenkins：progressing=有构建在运行，queued=队列中有该 job 的构建，否则按最近一次构建结果给出 complete/failed/aborted',
  ],
  examples: ['workctl deploy status get --service demo-order --env sandbox'],
  handler: async (ctx, i): Promise<Result> => {
    const b = binding(ctx, i);
    return b.provider === 'kubernetes' ? k8sStatusGet(ctx, b) : jenkinsStatusGet(ctx, b);
  },
});

async function planRollback(ctx: Ctx, params: Record<string, string>) {
  if (!params.service) throw new WorkError('INVALID_ARGUMENT', '缺少参数 service', { hint: '--param service=demo-order' });
  const env = resolveEnv(ctx, params.env);
  if (params.env && ctx.env && params.env !== ctx.env) throw new WorkError('PRECONDITION_FAILED', `参数 env=${params.env} 与当前 profile 环境 ${ctx.env} 不一致`);
  const b = deployBindingFor(ctx, params.service, env);
  return b.provider === 'kubernetes' ? planK8sRollback(ctx, b, params.to || undefined) : planJenkinsRollback(ctx, b, params.to || undefined);
}

const rollbackPlanner: Planner = { kind: ROLLBACK_KIND, summary: '回滚服务的发布到保留的某个历史版本', plan: planRollback };

const rollbackExecutor: Executor = async (ctx, plan, report) => {
  if (plan.params.provider === 'kubernetes') return k8sRollbackExecutor(ctx, plan, report);
  if (plan.params.provider === 'jenkins') return jenkinsRollbackExecutor(ctx, plan, report);
  throw new WorkError('UNSUPPORTED', `provider ${String(plan.params.provider)} 的回滚执行未接入，计划只能作为人工操作参考`);
};

const rollbackPlan = defineCapability({
  name: 'deploy.rollback.plan',
  command: 'deploy rollback plan',
  domain: 'deploy',
  summary: '为回滚发布生成计划：目标版本、当前与目标镜像/版本、依赖影响、前置条件（目标仍保留等）与步骤（不执行）',
  inputs: { ...serviceInputs, to: { type: 'string', description: '目标发布 ID（Kubernetes ReplicaSet 名或修订号；Jenkins 构建号）；缺省为上一修订 / 上一个不同版本的成功构建' } },
  output: PlanSchema,
  adapter: ADAPTERS,
  operation: 'plan',
  auth_provider: AUTH,
  guide: GUIDE,
  prerequisites: PREREQ,
  idempotent: true,
  cancellable: false,
  notes: [
    '计划预览不是执行成功的证据；执行用 workctl operation execute --id <plan> --confirm <plan>（需要 profile allow_execute）',
    `等价于 workctl operation plan --action ${ROLLBACK_KIND} --param service=<service> [--param to=<id>]`,
    'Kubernetes：执行等价于 kubectl rollout undo --to-revision（JSON patch 把 Pod 模板替换为目标 ReplicaSet 的模板），执行前复核 uid 与当前修订，轮询 rollout 直到完成或超时；需要 patch deployments 权限',
    'Jenkins：执行即用目标构建的参数（凭据类参数除外）重新触发部署 job（buildWithParameters，密码认证时附带 crumb），轮询队列与构建直到结束，结果 SUCCESS 才算成功；执行前复核当前成功构建未变、没有进行中的部署；需要 Job/Build 权限。目标构建含凭据类参数时前置条件 parameters_replayable 不满足',
    '回滚只回滚 Pod 模板 / 部署版本；配置中心、数据库结构等不随之回滚',
  ],
  examples: ['workctl deploy rollback plan --service demo-order --env sandbox', 'workctl deploy rollback plan --service demo-order --to 3'],
  handler: async (ctx, i): Promise<Result> => {
    const draft = await planRollback(ctx, { service: i.service, ...(i.env ? { env: i.env } : {}), ...(i.to ? { to: i.to } : {}) });
    const k8s = draft.params.provider === 'kubernetes';
    const plan = ctx.plans().create(draft, { profile: ctx.profileName, env: ctx.env, executable: true });
    const providerSource = k8s
      ? await kubeClient(ctx, String(draft.params.endpoint)).source(`GET /apis/apps/v1/namespaces/${String(draft.params.namespace)}/deployments/${String(draft.params.deployment)} + replicasets`)
      : jenkinsClient(ctx, String(draft.params.endpoint)).source(`GET /job/${String(draft.params.job)}/api/json`);
    const failed = plan.preconditions.filter((p) => !p.ok).map((p) => p.check);
    return {
      data: plan,
      sources: [providerSource, source('workctl', 'plan-store', { endpoint: ctx.plans().dir, relation: 'derived' })],
      coverage: {
        complete: true,
        scope: '计划生成时解析出的目标',
        notes: [failed.length ? `前置条件未满足（${failed.join(', ')}），该计划不能执行` : `执行: workctl operation execute --id ${plan.id} --confirm ${plan.id}`],
      },
    };
  },
});

function planned(name: string, command: string, summary: string, adapter: string) {
  return defineCapability({ name, command, summary, domain: 'deploy', adapter, operation: 'read', auth_provider: 'tbd', guide: GUIDE, status: 'planned' });
}

export default defineDomain({
  name: 'deploy',
  title: '部署系统',
  summary: '发布/rollout 历史、发布详情、当前发布状态与回滚计划（Kubernetes Deployment 修订、Jenkins 部署 job；按资源绑定选择 provider）',
  pillar: 'infrastructure',
  guide: GUIDE,
  skill: 'skills/deploy-operations/SKILL.md',
  capabilities: [
    releaseList,
    releaseGet,
    statusGet,
    rollbackPlan,
    planned('deploy.app.sync_status', 'deploy app sync-status', '查看 Argo CD Application 的同步/健康状态与目标修订', 'argocd (待接入)'),
    planned('deploy.app.history', 'deploy app history', '查看 Argo CD Application 的同步历史（修订、时间、发起人）', 'argocd (待接入)'),
    planned('deploy.pipeline.execution.list', 'deploy pipeline execution list', '列出 Spinnaker / 内部发布平台的流水线执行与阶段状态', 'spinnaker | internal-release-platform (待接入)'),
  ],
  planners: [rollbackPlanner],
  executors: { [ROLLBACK_KIND]: rollbackExecutor },
  probes: { jenkins: jenkinsProbe },
});
