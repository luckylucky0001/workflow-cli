import { WorkError } from '../../core/output';
import type { Plan, PlanDraft } from '../../core/operations';
import { sleep, type Ctx } from '../../core/runtime';
import { kubeClient, selectorMatchesLabels, selectorString, type KubeWorkload } from './kubernetes';
import { resolveKubeTargets, workloadPath, workloadSummary, type KubeBinding } from './k8s-workload';

export const RESTARTED_AT = 'kubectl.kubernetes.io/restartedAt';
/** Verification polling of the rollout. Mutable only for tests. */
export const rolloutTiming = { pollMs: 2_000, verifyMs: 300_000 };

function dependencyImpact(ctx: Ctx, service: string) {
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

/** Whether the latest spec has been rolled out (kubectl rollout status semantics). */
export function rolloutState(w: KubeWorkload, kind: string, minGeneration: number): { done: boolean; failed: boolean; detail: string } {
  const st = w.status ?? {};
  const want = w.spec.replicas ?? 1;
  const gen = w.metadata.generation ?? 0;
  const prog = st.conditions?.find((c) => c.type === 'Progressing');
  // conditions describe the generation the controller last observed: a ProgressDeadlineExceeded left
  // over from an earlier rollout must not fail the new one before the controller has seen it
  // (kubectl rollout status checks observedGeneration first, then the condition)
  if ((st.observedGeneration ?? 0) < Math.max(gen, minGeneration)) return { done: false, failed: false, detail: `等待控制器观察到 generation ${Math.max(gen, minGeneration)}（observedGeneration=${st.observedGeneration ?? 0}）` };
  if (prog?.reason === 'ProgressDeadlineExceeded') return { done: false, failed: true, detail: `Progressing=False ProgressDeadlineExceeded: ${prog.message ?? ''}`.trim() };
  if (kind === 'Deployment' && w.spec.paused) return { done: false, failed: true, detail: 'Deployment 处于暂停状态（spec.paused=true），控制器不会滚动更新；需先 rollout resume' };
  const updated = st.updatedReplicas ?? 0;
  if (updated < want) return { done: false, failed: false, detail: `${updated}/${want} 个副本已更新` };
  if (kind === 'StatefulSet') {
    if ((st.readyReplicas ?? 0) < want) return { done: false, failed: false, detail: `${st.readyReplicas ?? 0}/${want} 个副本就绪` };
    if (st.updateRevision && st.currentRevision !== st.updateRevision) return { done: false, failed: false, detail: `currentRevision ${st.currentRevision} ≠ updateRevision ${st.updateRevision}` };
    return { done: true, failed: false, detail: `${want}/${want} 个副本已更新并就绪` };
  }
  if ((st.replicas ?? 0) > updated) return { done: false, failed: false, detail: `${(st.replicas ?? 0) - updated} 个旧副本等待终止` };
  if ((st.availableReplicas ?? 0) < updated) return { done: false, failed: false, detail: `${st.availableReplicas ?? 0}/${updated} 个已更新副本可用` };
  return { done: true, failed: false, detail: `${want}/${want} 个副本已更新并可用` };
}

export async function planK8sRestart(ctx: Ctx, b: KubeBinding, service: string, env: string | null): Promise<PlanDraft> {
  const t = await resolveKubeTargets(ctx, b, env);
  const targets = t.workloads.map((w) => {
    const s = workloadSummary(w);
    const st = rolloutState(w, s.kind, 0);
    return {
      provider: 'kubernetes',
      endpoint: b.endpointName,
      kind: s.kind,
      namespace: t.namespace,
      name: s.name,
      uid: s.uid,
      generation: s.generation,
      observed_generation: s.observed_generation,
      replicas: s.replicas,
      ready_replicas: s.ready_replicas,
      updated_replicas: s.updated_replicas,
      available_replicas: s.available_replicas,
      strategy: w.spec.strategy?.type ?? w.spec.updateStrategy?.type ?? null,
      pods: t.pods.filter((p) => selectorMatchesLabels(w.spec.selector, p.metadata.labels)).length,
      workload_selector: s.selector,
      rollout_complete: st.done,
      selector: t.labelSelector,
      selector_kind: 'label',
      matched_by: t.selector.matched_by,
    };
  });
  const unsupported = targets.filter((x) => x.kind === 'StatefulSet' && x.strategy === 'OnDelete');
  // kubectl rollout restart refuses paused Deployments: the template change would not roll out
  const paused = t.workloads.filter((w) => (w.kind ?? 'Deployment') === 'Deployment' && w.spec.paused).map((w) => w.metadata.name);
  const settled = targets.every((x) => {
    const w = t.workloads.find((y) => y.metadata.name === x.name)!;
    return (w.status?.observedGeneration ?? 0) >= (w.metadata.generation ?? 0) && (w.status?.updatedReplicas ?? 0) >= (w.spec.replicas ?? 1);
  });
  const dep = dependencyImpact(ctx, service);
  const allowExecute = !!ctx.profile?.allow_execute;
  const single = targets.some((x) => Number(x.replicas) <= 1);
  return {
    kind: 'container.restart',
    title: `滚动重启服务 ${service}（${env ?? '未指定环境'}）的 ${targets.length} 个 Kubernetes 工作负载`,
    params: { service, env, provider: 'kubernetes', endpoint: b.endpointName, namespace: t.namespace },
    targets,
    impact: {
      service,
      env,
      provider: 'kubernetes',
      namespace: t.namespace,
      workloads: targets.length,
      pods: t.pods.length,
      expected_interruption: `等价于 kubectl rollout restart：修改 Pod 模板注解触发滚动更新，按 maxUnavailable/maxSurge 逐个替换 Pod${single ? '；存在单副本工作负载，替换期间可能短暂不可用' : ''}`,
      dependents_of_service: dep.dependents,
      service_dependencies: dep.dependencies,
      dependency_note: `${dep.note}；被依赖方在 Pod 替换期间可能看到连接重置，服务依赖（数据库/缓存）的连接会重建`,
      cache_note: '每个 Pod 是新进程：进程内状态（缓存、连接池）丢失并按启动配置恢复；Pod IP 会变化',
      side_effect: `在 spec.template.metadata.annotations 写入 ${RESTARTED_AT}，Deployment 会产生新的 ReplicaSet/修订版本`,
    },
    preconditions: [
      { check: 'workloads_found', ok: targets.length > 0, detail: `selector ${t.labelSelector} 对应 ${targets.length} 个工作负载、${t.pods.length} 个 Pod` },
      { check: 'profile_allow_execute', ok: allowExecute, detail: allowExecute ? `profile ${ctx.profileName} 允许执行` : `profile ${ctx.profileName} 未开启 allow_execute` },
      { check: 'kubernetes_reachable', ok: true, detail: `${t.client.endpointId} 可访问（计划生成时）` },
      { check: 'no_rollout_in_progress', ok: settled, detail: settled ? '计划生成时没有进行中的 rollout' : '存在尚未完成的 rollout（observedGeneration 落后或更新副本不足），先等待或排查' },
      ...(unsupported.length ? [{ check: 'rolling_update_strategy', ok: false, detail: `${unsupported.map((x) => x.name).join(', ')} 使用 OnDelete 更新策略，rollout restart 不会替换 Pod` }] : []),
      ...(paused.length ? [{ check: 'deployment_not_paused', ok: false, detail: `${paused.join(', ')} 处于暂停状态（spec.paused=true），重启注解不会触发滚动更新；先 kubectl rollout resume` }] : []),
    ],
    steps: [
      ...targets.map((x) => ({
        name: `rollout restart ${x.kind.toLowerCase()}/${x.name}`,
        detail: `PATCH ${workloadPath(t.namespace, x.kind as 'Deployment', x.name)}（strategic merge patch：spec.template.metadata.annotations.${RESTARTED_AT}=<执行时间>）`,
      })),
      {
        name: 'verify',
        detail: `轮询 GET 工作负载直到 observedGeneration ≥ 新 generation、updatedReplicas = replicas、旧副本已终止且 availableReplicas（StatefulSet 为 readyReplicas）= replicas；Progressing=ProgressDeadlineExceeded 视为失败（最多 ${rolloutTiming.verifyMs / 1000}s，且不超过调用的 --timeout）`,
      },
    ],
    rollback: '不适用：重启只改注解，没有可回滚的配置变化（rollout undo 会回到上一个模板并再次替换 Pod）。失败时用 container event list / container workload get 查看原因',
    idempotent: false,
    cancellable: false,
    ttlMs: 30 * 60_000,
  };
}

interface RolloutOutcome {
  kind: string;
  namespace: string;
  name: string;
  restarted_at: string;
  generation_before: number | null;
  generation_after: number | null;
  status: ReturnType<typeof workloadSummary>;
  verified: boolean;
  duration_ms: number;
  detail: string;
}

export async function k8sRestartExecutor(ctx: Ctx, plan: Plan, report: (note: string) => void): Promise<unknown> {
  const service = String(plan.params.service ?? '');
  const client = kubeClient(ctx, String(plan.params.endpoint ?? '') || undefined);
  const outcomes: RolloutOutcome[] = [];
  // re-check every target before patching any: a drifted second target must not be found
  // only after the first one was already restarted
  const checked: { t: Record<string, unknown>; kind: 'Deployment' | 'StatefulSet'; ns: string; name: string; path: string; before: KubeWorkload }[] = [];
  for (const t of plan.targets) {
    const kind = String(t.kind) as 'Deployment' | 'StatefulSet';
    const ns = String(t.namespace);
    const name = String(t.name);
    const path = workloadPath(ns, kind, name);
    const before = await client.get<KubeWorkload>(path);
    // the object must be the one the plan resolved: same uid (not deleted/recreated), same selector
    if (t.uid && before.metadata.uid !== t.uid) {
      throw new WorkError('PRECONDITION_FAILED', `${kind} ${ns}/${name} 的 uid 已变化（对象被删除重建），拒绝执行`, { details: { planned_uid: t.uid, current_uid: before.metadata.uid } });
    }
    if (t.workload_selector !== undefined && selectorString(before.spec.selector) !== String(t.workload_selector)) {
      throw new WorkError('PRECONDITION_FAILED', `${kind} ${ns}/${name} 的 spec.selector 已变化（${t.workload_selector} → ${selectorString(before.spec.selector)}），拒绝执行`);
    }
    if (kind === 'Deployment' && before.spec.paused) {
      throw new WorkError('PRECONDITION_FAILED', `${kind} ${ns}/${name} 处于暂停状态（spec.paused=true），重启注解不会触发滚动更新，拒绝执行`, { hint: '先 kubectl rollout resume，再重新生成计划' });
    }
    if (typeof t.generation === 'number' && (before.metadata.generation ?? 0) !== t.generation) {
      // the spec changed since planning (another rollout / deploy): the plan preview no longer describes what would roll out
      throw new WorkError('PRECONDITION_FAILED', `${kind} ${ns}/${name} 的 generation 自计划生成后已变化（${t.generation} → ${before.metadata.generation ?? 0}），可能有新的发布正在进行，拒绝执行`, {
        hint: '确认当前 rollout（workctl deploy status get）后重新生成计划',
        details: { planned_generation: t.generation, current_generation: before.metadata.generation ?? null },
      });
    }
    checked.push({ t, kind, ns, name, path, before });
  }
  for (const { kind, ns, name, path, before } of checked) {
    const restartedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const t0 = Date.now();
    report(`rollout restart ${kind.toLowerCase()}/${name} (namespace ${ns})`);
    const patched = await client.request<KubeWorkload>('PATCH', path, {
      body: { spec: { template: { metadata: { annotations: { [RESTARTED_AT]: restartedAt } } } } },
      contentType: 'application/strategic-merge-patch+json',
    });
    const genBefore = before.metadata.generation ?? 0;
    const genAfter = patched.body.metadata?.generation ?? genBefore + 1;
    if (patched.body.metadata?.generation !== undefined && genAfter <= genBefore) {
      // the PATCH did not change the pod template (e.g. same restartedAt value): no rollout was
      // triggered, so the current (old) rollout status must not be reported as this restart
      throw new WorkError('CONFLICT', `${kind} ${ns}/${name} 的 generation 未变化（${genBefore}），重启注解没有触发新的滚动更新`, {
        hint: '稍后重新生成计划并执行；不要把当前状态当作重启结果',
        details: { generation_before: genBefore, generation_after: genAfter, restarted_at: restartedAt },
      });
    }
    const deadline = Date.now() + Math.min(rolloutTiming.verifyMs, Math.max(0, ctx.remainingMs() - 1_000));
    let cur = patched.body;
    let st = rolloutState(cur, kind, genAfter);
    for (;;) {
      if (st.done || st.failed || Date.now() >= deadline) break;
      await sleep(rolloutTiming.pollMs, ctx.signal);
      cur = await client.get<KubeWorkload>(path);
      st = rolloutState(cur, kind, genAfter);
    }
    const outcome: RolloutOutcome = {
      kind,
      namespace: ns,
      name,
      restarted_at: restartedAt,
      generation_before: before.metadata.generation ?? null,
      generation_after: genAfter,
      status: workloadSummary({ ...cur, kind }),
      verified: st.done,
      duration_ms: Date.now() - t0,
      detail: st.done ? `rollout 完成：${st.detail}` : st.failed ? `rollout 失败：${st.detail}` : `在 ${Math.round((deadline - t0) / 1000)}s 内 rollout 未完成：${st.detail}`,
    };
    outcomes.push(outcome);
    report(`${kind.toLowerCase()}/${name}: ${outcome.detail}`);
    if (!st.done) {
      const hint = `workctl container event list --service ${service} --window 15m；workctl container workload get --service ${service}`;
      if (st.failed) throw new WorkError('UPSTREAM_UNAVAILABLE', `${kind} ${ns}/${name} rollout 失败（${st.detail}）`, { hint, details: { outcomes } });
      throw new WorkError('TIMEOUT', `${kind} ${ns}/${name} rollout 在时间预算内未完成；注解已写入，rollout 可能仍在进行`, {
        hint: `不要直接重试（会再次触发滚动更新）；${hint}`,
        details: { outcomes },
      });
    }
  }
  const v = await client.version().catch(() => undefined);
  return {
    service,
    provider: 'kubernetes',
    restarted: outcomes,
    verified_all: outcomes.every((o) => o.verified),
    kubernetes_version: v?.gitVersion ?? null,
    note: '校验依据为工作负载 rollout 状态（observedGeneration、updatedReplicas、availableReplicas/readyReplicas）；业务可用性请再探测',
  };
}
