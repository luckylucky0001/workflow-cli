import { WorkError } from '../../core/output';
import type { Plan, PlanDraft } from '../../core/operations';
import type { Executor, Planner } from '../../core/registry';
import { sleep, type Ctx } from '../../core/runtime';
import { containerName, dockerClient, dockerTime, shortId, type ContainerInspect } from './docker';
import { listServiceContainers, resolveEnv, selectorMatches } from './workload';
import { kubeBindingFor } from './k8s-workload';
import { k8sRestartExecutor, planK8sRestart } from './k8s-restart';

export const RESTART_KIND = 'container.restart';
const STOP_TIMEOUT_S = 10;
const VERIFY_BUDGET_MS = 60_000;
/**
 * After the container first looks healthy it must stay up (same StartedAt, still running)
 * for this long; otherwise a process that crashes right after start would be reported as
 * recovered. Mutable only for tests.
 */
export const restartTiming = { stableMs: 3_000, pollMs: 500, verifyMs: VERIFY_BUDGET_MS };

export async function planRestart(ctx: Ctx, params: Record<string, string>): Promise<PlanDraft> {
  const service = params.service;
  if (!service) throw new WorkError('INVALID_ARGUMENT', '缺少参数 service', { hint: '--param service=demo-order' });
  const env = resolveEnv(ctx, params.env);
  if (params.env && ctx.env && params.env !== ctx.env) {
    throw new WorkError('PRECONDITION_FAILED', `参数 env=${params.env} 与当前 profile 环境 ${ctx.env} 不一致`);
  }
  // provider chosen by the resource bindings: Kubernetes only when the service is bound to a kubernetes endpoint
  const kb = kubeBindingFor(ctx, service, env);
  if (kb) return planK8sRestart(ctx, kb, service, env);
  const docker = dockerClient(ctx);
  const sc = await listServiceContainers(ctx, docker, service, env);
  const targets: Record<string, unknown>[] = [];
  let anyHealthcheck = false;
  for (const c of sc.containers) {
    const i = await docker.getJson<ContainerInspect>(`/containers/${c.Id}/json`);
    const hasHc = !!i.Config?.Healthcheck?.Test?.length && i.Config.Healthcheck.Test[0] !== 'NONE';
    anyHealthcheck ||= hasHc;
    targets.push({
      container_id: i.Id,
      name: containerName(i),
      image: i.Config.Image,
      state: i.State.Status,
      health: i.State.Health?.Status ?? 'none',
      started_at: dockerTime(i.State.StartedAt),
      restart_policy: i.HostConfig.RestartPolicy?.Name || null,
      selector: sc.selector.label,
      selector_kind: sc.selector.kind,
      matched_by: sc.selector.matched_by,
    });
  }
  let dependents: Record<string, unknown>[] = [];
  let dependencies: Record<string, unknown>[] = [];
  let bindingsNote = '资源绑定未配置，无法给出依赖影响';
  try {
    const store = ctx.resources();
    if (store.configured) {
      dependents = store.relationsOf(service, 'upstream').map((r) => ({ resource: r.from, relation: r.type, source: r.source, evidence: r.evidence ?? null }));
      dependencies = store.relationsOf(service, 'downstream').map((r) => ({ resource: r.to, relation: r.type, source: r.source, evidence: r.evidence ?? null }));
      bindingsNote = `来自资源绑定 ${store.path}`;
    }
  } catch (e) {
    bindingsNote = `资源绑定读取失败: ${e instanceof Error ? e.message : String(e)}`;
  }
  const running = targets.filter((t) => t.state === 'running').length;
  const allowExecute = !!ctx.profile?.allow_execute;
  return {
    kind: RESTART_KIND,
    title: `重启服务 ${service}（${env ?? '未指定环境'}）的 ${targets.length} 个容器`,
    params: { service, env },
    targets,
    impact: {
      service,
      env,
      containers: targets.length,
      running_containers: running,
      expected_interruption: `每个容器停止最多 ${STOP_TIMEOUT_S}s（SIGTERM 后超时 SIGKILL）+ 启动时间；单副本服务在此期间不可用`,
      dependents_of_service: dependents,
      service_dependencies: dependencies,
      dependency_note: `${bindingsNote}；被依赖方在重启期间会看到连接失败，服务依赖（数据库/缓存）的连接会重建`,
      healthcheck_configured: anyHealthcheck,
      cache_note: '进程内状态（如缓存模式、连接池）会丢失并按启动配置恢复',
    },
    preconditions: [
      { check: 'containers_found', ok: targets.length > 0, detail: `selector ${sc.selector.label} 匹配 ${targets.length} 个容器` },
      { check: 'profile_allow_execute', ok: allowExecute, detail: allowExecute ? `profile ${ctx.profileName} 允许执行` : `profile ${ctx.profileName} 未开启 allow_execute` },
      { check: 'docker_reachable', ok: true, detail: `${docker.endpointId} 可访问（计划生成时）` },
    ],
    steps: [
      ...targets.map((t) => ({
        name: `restart ${t.name}`,
        detail: `POST /containers/${shortId(String(t.container_id))}/restart?t=${STOP_TIMEOUT_S}`,
      })),
      {
        name: 'verify',
        detail: `轮询 /containers/{id}/json 直到 State.Running=true 且 StartedAt 晚于重启前${anyHealthcheck ? '、健康状态为 healthy' : ''}，并在同一 StartedAt 下持续 ${restartTiming.stableMs / 1000}s（最多 ${VERIFY_BUDGET_MS / 1000}s）`,
      },
    ],
    rollback: '不适用：重启不可回滚。失败时用 container event list / log query 查看原因，必要时人工介入',
    idempotent: true,
    cancellable: false,
    ttlMs: 30 * 60_000,
  };
}

export const restartPlanner: Planner = {
  kind: RESTART_KIND,
  summary: '重启服务的全部容器（Docker restart，逐个执行并校验恢复运行；Kubernetes 绑定时为 rollout restart 并校验 rollout 完成）',
  plan: planRestart,
};

interface RestartOutcome {
  container_id: string;
  name: string;
  before: { state: string; started_at: string | null };
  after: { state: string; started_at: string | null; health: string };
  verified: boolean;
  duration_ms: number;
  detail: string;
}

export const restartExecutor: Executor = async (ctx: Ctx, plan: Plan, report) => {
  if (plan.params.provider === 'kubernetes') return k8sRestartExecutor(ctx, plan, report);
  const docker = dockerClient(ctx);
  const service = String(plan.params.service ?? '');
  const outcomes: RestartOutcome[] = [];
  // re-check every target before restarting any: a drifted later target must not be found only
  // after earlier containers were already restarted
  for (const t of plan.targets) {
    const id = String(t.container_id);
    const cur = await docker.getJson<ContainerInspect>(`/containers/${id}/json`);
    const label = cur.Config?.Labels?.['workctl.service'];
    const selector = String(t.selector ?? '');
    const kind = t.selector_kind === 'name' ? 'name' : 'label';
    if (selector.includes('=') && !selectorMatches({ kind, label: selector }, { labels: cur.Config?.Labels, name: containerName(cur) })) {
      throw new WorkError('PRECONDITION_FAILED', `容器 ${containerName(cur)} 已不再匹配选择器 ${selector}，拒绝执行（未重启任何容器）`, { details: { label } });
    }
  }
  for (const t of plan.targets) {
    const id = String(t.container_id);
    const before = await docker.getJson<ContainerInspect>(`/containers/${id}/json`);
    const t0 = Date.now();
    report(`restart ${containerName(before)} (${shortId(id)})`);
    await docker.post(`/containers/${id}/restart?t=${STOP_TIMEOUT_S}`, { timeoutMs: (STOP_TIMEOUT_S + 30) * 1000 });
    const deadline = Date.now() + restartTiming.verifyMs;
    let after = await docker.getJson<ContainerInspect>(`/containers/${id}/json`);
    const beforeStart = Date.parse(before.State.StartedAt) || 0;
    const hasHc = !!after.Config?.Healthcheck?.Test?.length && after.Config.Healthcheck.Test[0] !== 'NONE';
    // with a healthcheck only `healthy` counts; `unhealthy` is a failed restart, not a recovered one
    const ok = (i: ContainerInspect) =>
      i.State.Running && !i.State.Restarting && (Date.parse(i.State.StartedAt) || 0) > beforeStart && (!hasHc || i.State.Health?.Status === 'healthy');
    let verified = false;
    let stableSince: { startedAt: string; at: number } | null = null;
    for (;;) {
      if (ok(after)) {
        // same process instance (StartedAt unchanged) must stay up for the stabilisation window
        if (!stableSince || stableSince.startedAt !== after.State.StartedAt) stableSince = { startedAt: after.State.StartedAt, at: Date.now() };
        if (Date.now() - stableSince.at >= restartTiming.stableMs) {
          verified = true;
          break;
        }
      } else stableSince = null;
      if (Date.now() >= deadline) break;
      await sleep(restartTiming.pollMs, ctx.signal);
      after = await docker.getJson<ContainerInspect>(`/containers/${id}/json`);
    }
    const outcome: RestartOutcome = {
      container_id: id,
      name: containerName(after),
      before: { state: before.State.Status, started_at: dockerTime(before.State.StartedAt) },
      after: { state: after.State.Status, started_at: dockerTime(after.State.StartedAt), health: after.State.Health?.Status ?? 'none' },
      verified,
      duration_ms: Date.now() - t0,
      detail: verified
        ? `已重新运行并稳定 ${restartTiming.stableMs / 1000}s${hasHc ? `，健康状态 ${after.State.Health?.Status}` : '（未配置健康检查，仅校验进程持续运行）'}`
        : `在 ${restartTiming.verifyMs / 1000}s 内未确认恢复：state=${after.State.Status} exit=${after.State.ExitCode}${hasHc ? ` health=${after.State.Health?.Status ?? 'none'}` : ''} restart_count=${after.RestartCount}`,
    };
    outcomes.push(outcome);
    report(`${outcome.name}: ${outcome.detail}`);
    if (!verified) {
      throw new WorkError('UPSTREAM_UNAVAILABLE', `容器 ${outcome.name} 重启后未恢复运行`, {
        hint: `workctl container event list --service ${service} --window 15m；workctl log query --service ${service} --window 15m --level error`,
        details: { outcomes },
      });
    }
  }
  const v = await docker.version().catch(() => undefined);
  return {
    service,
    restarted: outcomes,
    verified_all: outcomes.every((o) => o.verified),
    docker_version: v?.Version ?? null,
    note: '校验依据为 Docker inspect（进程运行、启动时间更新、健康检查状态）；业务可用性请再用 network backend list 探测',
  };
};
