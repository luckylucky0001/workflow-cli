import { z } from 'zod';
import { WorkError } from '../../core/output';
import type { Resource } from '../../core/resources';
import type { Ctx } from '../../core/runtime';

/**
 * Deploy-system object model shared by all providers (one output schema, several providers).
 *
 * Binding: a resource of type `deploy.target` with `attributes.service: <service id>` and an
 * `endpoint: {kind: kubernetes|jenkins, name}` says how that service is released:
 *   kubernetes: attributes.namespace, attributes.deployment
 *   jenkins:    attributes.job (folder/job allowed), optional version_param / service_param / env_param
 * Never matched by name similarity.
 */
export const DEPLOY_TARGET_TYPE = 'deploy.target';
export const PROVIDERS = ['kubernetes', 'jenkins'] as const;
export type DeployProvider = (typeof PROVIDERS)[number];

export const ReleaseStatus = z.enum(['succeeded', 'failed', 'running', 'aborted', 'unknown']);
export type ReleaseStatusT = z.infer<typeof ReleaseStatus>;

export const SourceRefSchema = z.object({
  system: z.string(),
  kind: z.string().describe('如 ReplicaSet、Deployment、jenkins.build'),
  name: z.string(),
  url: z.string().nullable().describe('不含凭据的链接（Jenkins build URL）'),
});

export const ReleaseSchema = z.object({
  id: z.string().describe('Kubernetes: ReplicaSet 名；Jenkins: 构建号'),
  provider: z.enum(PROVIDERS),
  version: z.string().nullable().describe('Kubernetes: 首个容器镜像 tag；Jenkins: 版本参数值'),
  images: z.array(z.string()),
  revision: z.number().nullable().describe('Kubernetes: deployment.kubernetes.io/revision；Jenkins: 构建号'),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  timestamps: z.enum(['explicit', 'derived']).describe('explicit=系统记录的发布开始/结束；derived=由对象创建时间/条件更新时间推得'),
  duration_ms: z.number().nullable(),
  status: ReleaseStatus,
  status_basis: z.string().describe('状态判定依据'),
  current: z.boolean().describe('是否为当前生效的发布'),
  triggered_by: z.string().nullable(),
  cause: z.string().nullable().describe('Kubernetes: kubernetes.io/change-cause 注解；Jenkins: 触发原因'),
  source_ref: SourceRefSchema,
});
export type Release = z.infer<typeof ReleaseSchema>;

export const TargetSchema = z.object({
  binding: z.string().describe('资源绑定中的 deploy.target ID'),
  provider: z.enum(PROVIDERS),
  endpoint: z.string(),
  object: z.string().describe('Kubernetes: Deployment <ns>/<name>；Jenkins: job 路径'),
});

export interface DeployBinding {
  service: string;
  env: string | null;
  resource: Resource;
  provider: DeployProvider;
  endpointName: string;
  attrs: Record<string, unknown>;
  evidence: string;
  ignored: string[];
}

export function resolveEnv(ctx: Ctx, env: unknown): string | null {
  return typeof env === 'string' && env ? env : ctx.env;
}

/** The deploy.target binding of a service in an env; NOT_CONFIGURED when there is none. */
export function deployBindingFor(ctx: Ctx, service: string, env: string | null): DeployBinding {
  const store = ctx.resources();
  if (!store.configured) {
    throw new WorkError('NOT_CONFIGURED', '当前 profile 未配置 resources_file，无法确定服务的部署系统', { hint: '在资源绑定中为服务添加 deploy.target 资源（见 docs/guides/deploy.md）' });
  }
  const found = store.resources.filter(
    (r) => r.type === DEPLOY_TARGET_TYPE && r.attributes?.service === service && (!r.env || !env || r.env === env) && r.endpoint,
  );
  if (!found.length) {
    const exists = !!store.get(service);
    throw new WorkError('NOT_CONFIGURED', `服务 ${service}${env ? `（env ${env}）` : ''} 没有部署系统绑定`, {
      hint: `${exists ? '' : `资源绑定中也没有服务 ${service}；`}在 ${store.path} 添加 type: ${DEPLOY_TARGET_TYPE}、attributes.service: ${service}、endpoint {kind: kubernetes|jenkins} 的资源`,
      details: { service, env, bindings: store.path },
    });
  }
  // a binding for exactly this env wins over an env-agnostic one, whatever the file order
  found.sort((a, c) => Number(!!env && c.env === env) - Number(!!env && a.env === env));
  const [r, ...rest] = found;
  const kind = r.endpoint!.kind;
  if (!(PROVIDERS as readonly string[]).includes(kind)) {
    throw new WorkError('UNSUPPORTED', `部署系统 ${kind} 尚未接入（绑定 ${r.id}）`, { hint: '已接入: kubernetes、jenkins；Argo CD / Spinnaker / 内部发布平台为 planned' });
  }
  return {
    service,
    env,
    resource: r,
    provider: kind as DeployProvider,
    endpointName: r.endpoint!.name,
    attrs: r.attributes ?? {},
    evidence: `bindings: ${r.id}（${DEPLOY_TARGET_TYPE}, service=${service}, endpoint ${kind}/${r.endpoint!.name}）`,
    ignored: rest.map((x) => x.id),
  };
}

export function attr(b: DeployBinding, key: string): string | undefined {
  const v = b.attrs[key];
  return typeof v === 'string' && v ? v : undefined;
}

export function requireAttr(b: DeployBinding, key: string): string {
  const v = attr(b, key);
  if (!v) throw new WorkError('NOT_CONFIGURED', `部署绑定 ${b.resource.id}（${b.provider}）缺少 attributes.${key}`, { hint: 'docs/guides/deploy.md 列出了各 provider 需要的绑定属性' });
  return v;
}

export function imageTag(image: string | undefined): string | null {
  if (!image) return null;
  const at = image.indexOf('@');
  if (at >= 0) return image.slice(at + 1, at + 20);
  const slash = image.lastIndexOf('/');
  const colon = image.lastIndexOf(':');
  return colon > slash ? image.slice(colon + 1) : 'latest';
}

/** Service dependency impact from the bindings (same shape as container restart plans). */
export function dependencyImpact(ctx: Ctx, service: string) {
  let dependents: Record<string, unknown>[] = [];
  let dependencies: Record<string, unknown>[] = [];
  let note = '资源绑定未配置，无法给出依赖影响';
  try {
    const store = ctx.resources();
    if (store.configured) {
      dependents = store.relationsOf(service, 'upstream').map((r) => ({ resource: r.from, relation: r.type, source: r.source, evidence: r.evidence ?? null }));
      dependencies = store.relationsOf(service, 'downstream').map((r) => ({ resource: r.to, relation: r.type, source: r.source, evidence: r.evidence ?? null }));
      note = `来自资源绑定 ${store.path}`;
    }
  } catch (e) {
    note = `资源绑定读取失败: ${e instanceof Error ? e.message : String(e)}`;
  }
  return { dependents, dependencies, note };
}

/** Mask credentials in free text (console logs, parameters). */
export function maskSecrets(line: string): string {
  return line
    // before the key=value rule, which would mask only the scheme word of "Authorization: Basic <b64>"
    .replace(/(Basic\s+)[A-Za-z0-9+/=]{8,}/g, '$1******')
    .replace(/((?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|authorization)[^\s:=]*\s*[:=]\s*)(\S+)/gi, '$1******')
    // command-line flags: --password hunter2, --token abc
    .replace(/((?:^|\s)--?(?:password|passwd|token|secret|api[_-]?key)[\w-]*\s+)(?!-)(\S+)/gi, '$1******')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, '$1******')
    // userinfo in any URL scheme (https://, postgres://, redis://, amqp://, ...)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1******@');
}

/** A name/value pair for display: secret-looking names fully masked, credentials inside values masked. */
export function maskValue(name: string, value: string): string {
  return isSecretName(name) ? '******' : maskSecrets(value);
}

export function isSecretName(name: string): boolean {
  // pwd as in maskSecrets (DB_PWD); private/access keys and DSNs carry credentials too
  return /password|passwd|pwd|passphrase|token|secret|api[_-]?key|private[_-]?key|access[_-]?key|dsn|credential/i.test(name);
}
