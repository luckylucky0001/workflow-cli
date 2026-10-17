import { WorkError } from '../../core/output';
import type { Ctx } from '../../core/runtime';
import { filtersParam, type ContainerSummary, type DockerClient } from './docker';

export const SERVICE_LABEL = 'workctl.service';
export const RESOURCE_LABEL = 'workctl.resource';
export const ENV_LABEL = 'workctl.env';

export interface Selector {
  /** `label`: Docker label filter; `name`: exact container name from an explicit binding attribute. */
  kind: 'label' | 'name';
  /** `key=value`; for kind=name this is `name=<container name>`. */
  label: string;
  origin: 'binding-file' | 'label-convention';
  evidence: string;
  /** Human-readable description of the selector that produced the result, e.g. `label workctl.resource=demo-mysql`. */
  matched_by: string;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * Candidate selectors for a service/resource, using only real metadata (never name similarity):
 *  explicit (binding file): `attributes.container_label`, labels of a `runs_on` container.workload,
 *  `attributes.container` (exact container name);
 *  conventions (only when no explicit selector exists): `workctl.service=<id>`, then `workctl.resource=<id>`.
 */
export function candidateSelectors(ctx: Ctx, service: string): { explicit: Selector[]; conventions: Selector[] } {
  if (!/^[A-Za-z0-9._-]+$/.test(service)) throw new WorkError('INVALID_ARGUMENT', `服务名不合法: ${service}`);
  let store;
  try {
    store = ctx.resources();
  } catch {
    store = undefined;
  }
  const res = store?.get(service);
  const explicit: Selector[] = [];
  const attr = res?.attributes?.container_label;
  if (typeof attr === 'string' && attr.includes('=')) {
    explicit.push({ kind: 'label', label: attr, origin: 'binding-file', evidence: `bindings: ${service}.attributes.container_label=${attr}`, matched_by: `label ${attr}（binding attribute container_label）` });
  }
  if (store && res) {
    for (const rel of store.relationsOf(service, 'downstream')) {
      if (rel.type !== 'runs_on') continue;
      const w = store.get(rel.to);
      if (w?.type === 'container.workload') {
        const [k, v] = Object.entries(w.labels ?? {})[0] ?? [];
        if (k && v) explicit.push({ kind: 'label', label: `${k}=${v}`, origin: 'binding-file', evidence: `bindings: ${service} runs_on ${w.id} (labels ${k}=${v})`, matched_by: `label ${k}=${v}（runs_on ${w.id}）` });
      }
    }
  }
  const cname = res?.attributes?.container;
  if (typeof cname === 'string' && NAME_RE.test(cname)) {
    explicit.push({ kind: 'name', label: `name=${cname}`, origin: 'binding-file', evidence: `bindings: ${service}.attributes.container=${cname}（精确容器名）`, matched_by: `binding attribute container=${cname}` });
  }
  const conventions: Selector[] = [
    { kind: 'label', label: `${SERVICE_LABEL}=${service}`, origin: 'label-convention', evidence: `容器标签约定 ${SERVICE_LABEL}=${service}（资源绑定中无该服务的容器选择器）`, matched_by: `label ${SERVICE_LABEL}=${service}` },
    { kind: 'label', label: `${RESOURCE_LABEL}=${service}`, origin: 'label-convention', evidence: `容器标签约定 ${RESOURCE_LABEL}=${service}（资源绑定中无该资源的容器选择器）`, matched_by: `label ${RESOURCE_LABEL}=${service}` },
  ];
  return { explicit, conventions };
}

/** First candidate selector (kept for callers that only need the primary selector). */
export function serviceSelector(ctx: Ctx, service: string): Selector {
  const c = candidateSelectors(ctx, service);
  return c.explicit[0] ?? c.conventions[0];
}

/** Whether a container (labels + name) satisfies a selector; used to re-check targets before acting. */
export function selectorMatches(sel: Pick<Selector, 'kind' | 'label'>, c: { labels: Record<string, string> | null | undefined; name: string }): boolean {
  const i = sel.label.indexOf('=');
  const k = sel.label.slice(0, i);
  const v = sel.label.slice(i + 1);
  if (sel.kind === 'name') return c.name.replace(/^\//, '') === v;
  return (c.labels ?? {})[k] === v;
}

export interface ServiceContainers {
  selector: Selector;
  /** Selectors tried in order with the number of containers each matched (before the env filter). */
  tried: { matched_by: string; containers: number }[];
  env: string | null;
  containers: ContainerSummary[];
  /** Matched the selector but carry a different workctl.env label. */
  excluded_by_env: { name: string; env: string }[];
  /** Matched the selector but have no workctl.env label (kept, flagged). */
  missing_env_label: string[];
}

async function queryContainers(docker: DockerClient, sel: Selector): Promise<ContainerSummary[]> {
  if (sel.kind === 'label') {
    return docker.getJson<ContainerSummary[]>(`/containers/json?all=1&filters=${filtersParam({ label: [sel.label] })}`);
  }
  // Docker's name filter is a substring/regex match: narrow server-side, then require the exact name.
  const name = sel.label.slice('name='.length);
  const list = await docker.getJson<ContainerSummary[]>(`/containers/json?all=1&filters=${filtersParam({ name: [name] })}`);
  return list.filter((c) => (c.Names ?? []).some((n) => n.replace(/^\//, '') === name));
}

export async function listServiceContainers(ctx: Ctx, docker: DockerClient, service: string, env: string | null): Promise<ServiceContainers> {
  const { explicit, conventions } = candidateSelectors(ctx, service);
  // explicit binding selectors first; label conventions after them (deduplicated). Never name similarity.
  const candidates = [...explicit, ...conventions.filter((c) => !explicit.some((e) => e.kind === c.kind && e.label === c.label))];
  const tried: ServiceContainers['tried'] = [];
  let selector = candidates[0];
  let list: ContainerSummary[] = [];
  for (const sel of candidates) {
    const found = await queryContainers(docker, sel);
    tried.push({ matched_by: sel.matched_by, containers: found.length });
    if (found.length) {
      selector = sel;
      list = found;
      break;
    }
  }
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
  return { selector, tried, env, containers, excluded_by_env: excluded, missing_env_label: missing };
}

export function selectionNotes(sc: ServiceContainers): string[] {
  const notes = [`容器选择器: ${sc.selector.matched_by}（${sc.selector.evidence}）`];
  if (sc.tried.length > 1) notes.push(`依次尝试: ${sc.tried.map((t) => `${t.matched_by} → ${t.containers} 个`).join('；')}`);
  if (sc.env) notes.push(`环境过滤: ${ENV_LABEL}=${sc.env}（无该标签的容器保留并标注）`);
  if (sc.excluded_by_env.length) notes.push(`因 ${ENV_LABEL} 不同被排除: ${sc.excluded_by_env.map((e) => `${e.name}(${e.env})`).join(', ')}`);
  if (sc.missing_env_label.length) notes.push(`缺少 ${ENV_LABEL} 标签: ${sc.missing_env_label.join(', ')}`);
  return notes;
}

/** Resolve --env: explicit input, else the profile's env. */
export function resolveEnv(ctx: Ctx, env: unknown): string | null {
  return typeof env === 'string' && env ? env : ctx.env;
}
