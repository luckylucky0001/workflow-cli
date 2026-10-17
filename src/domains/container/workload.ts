import { WorkError } from '../../core/output';
import type { Ctx } from '../../core/runtime';
import { filtersParam, type ContainerSummary, type DockerClient } from './docker';

export const SERVICE_LABEL = 'workctl.service';
export const ENV_LABEL = 'workctl.env';

export interface Selector {
  /** Docker label filter, e.g. `workctl.service=demo-order`. */
  label: string;
  origin: 'binding-file' | 'label-convention';
  evidence: string;
}

/**
 * How containers of a service are found. Only real metadata is used: the service
 * binding's `container_label` attribute, the labels of a container.workload it
 * runs_on, or the `workctl.service=<service>` label convention. Never names.
 */
export function serviceSelector(ctx: Ctx, service: string): Selector {
  if (!/^[A-Za-z0-9._-]+$/.test(service)) throw new WorkError('INVALID_ARGUMENT', `服务名不合法: ${service}`);
  let store;
  try {
    store = ctx.resources();
  } catch {
    store = undefined;
  }
  const res = store?.get(service);
  const attr = res?.attributes?.container_label;
  if (typeof attr === 'string' && attr.includes('=')) {
    return { label: attr, origin: 'binding-file', evidence: `bindings: ${service}.attributes.container_label=${attr}` };
  }
  if (store && res) {
    for (const rel of store.relationsOf(service, 'downstream')) {
      if (rel.type !== 'runs_on') continue;
      const w = store.get(rel.to);
      if (w?.type === 'container.workload') {
        const [k, v] = Object.entries(w.labels ?? {})[0] ?? [];
        if (k && v) return { label: `${k}=${v}`, origin: 'binding-file', evidence: `bindings: ${service} runs_on ${w.id} (labels ${k}=${v})` };
      }
    }
  }
  return { label: `${SERVICE_LABEL}=${service}`, origin: 'label-convention', evidence: `容器标签约定 ${SERVICE_LABEL}=${service}（资源绑定中无该服务的容器选择器）` };
}

export interface ServiceContainers {
  selector: Selector;
  env: string | null;
  containers: ContainerSummary[];
  /** Matched the selector but carry a different workctl.env label. */
  excluded_by_env: { name: string; env: string }[];
  /** Matched the selector but have no workctl.env label (kept, flagged). */
  missing_env_label: string[];
}

export async function listServiceContainers(ctx: Ctx, docker: DockerClient, service: string, env: string | null): Promise<ServiceContainers> {
  const selector = serviceSelector(ctx, service);
  const list = await docker.getJson<ContainerSummary[]>(`/containers/json?all=1&filters=${filtersParam({ label: [selector.label] })}`);
  const containers: ContainerSummary[] = [];
  const excluded: { name: string; env: string }[] = [];
  const missing: string[] = [];
  for (const c of list) {
    const cEnv = c.Labels?.[ENV_LABEL];
    const name = (c.Names?.[0] ?? c.Id).replace(/^\//, '');
    if (env && cEnv && cEnv !== env) {
      excluded.push({ name, env: cEnv });
      continue;
    }
    if (env && !cEnv) missing.push(name);
    containers.push(c);
  }
  containers.sort((a, b) => (a.Names?.[0] ?? '').localeCompare(b.Names?.[0] ?? ''));
  return { selector, env, containers, excluded_by_env: excluded, missing_env_label: missing };
}

export function selectionNotes(sc: ServiceContainers): string[] {
  const notes = [`容器选择器: label ${sc.selector.label}（${sc.selector.evidence}）`];
  if (sc.env) notes.push(`环境过滤: ${ENV_LABEL}=${sc.env}（无该标签的容器保留并标注）`);
  if (sc.excluded_by_env.length) notes.push(`因 ${ENV_LABEL} 不同被排除: ${sc.excluded_by_env.map((e) => `${e.name}(${e.env})`).join(', ')}`);
  if (sc.missing_env_label.length) notes.push(`缺少 ${ENV_LABEL} 标签: ${sc.missing_env_label.join(', ')}`);
  return notes;
}

/** Resolve --env: explicit input, else the profile's env. */
export function resolveEnv(ctx: Ctx, env: unknown): string | null {
  return typeof env === 'string' && env ? env : ctx.env;
}
