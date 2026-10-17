import { WorkError, type Result, type Source } from '../../core/output';
import type { Plan, PlanDraft } from '../../core/operations';
import { sleep, type Ctx } from '../../core/runtime';
import {
  enc,
  kubeClient,
  selectorString,
  type KubeClient,
  type KubeContainerSpec,
  type KubeList,
  type KubePod,
  type KubeWorkload,
  type ObjectMeta,
} from '../container/kubernetes';
import { rolloutState } from '../container/k8s-restart';
import { workloadPath } from '../container/k8s-workload';
import { attr, dependencyImpact, imageTag, maskValue, requireAttr, type DeployBinding, type Release } from './model';

/**
 * Kubernetes provider: a release is a ReplicaSet revision of the bound Deployment
 * (what `kubectl rollout history` shows). The API keeps only `revisionHistoryLimit` old
 * ReplicaSets and records no rollout start/finish times: started_at is the ReplicaSet
 * creationTimestamp (derived), finished_at only for the current revision (Progressing
 * condition NewReplicaSetAvailable lastUpdateTime, derived).
 */
export const REVISION = 'deployment.kubernetes.io/revision';
export const REVISION_HISTORY = 'deployment.kubernetes.io/revision-history';
export const CHANGE_CAUSE = 'kubernetes.io/change-cause';
const RESTARTED_AT = 'kubectl.kubernetes.io/restartedAt';
/** Rollback verification polling. Mutable only for tests. */
export const deployRolloutTiming = { pollMs: 2_000, verifyMs: 300_000 };

export interface KubeReplicaSet {
  metadata: ObjectMeta;
  spec: {
    replicas?: number;
    template: { metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> }; spec?: { containers?: (KubeContainerSpec & { env?: { name: string; value?: string; valueFrom?: unknown }[] })[] } & Record<string, unknown> };
  };
  status?: { replicas?: number; readyReplicas?: number; availableReplicas?: number; fullyLabeledReplicas?: number; observedGeneration?: number };
}

type Deployment = KubeWorkload & { spec: KubeWorkload['spec'] & { revisionHistoryLimit?: number } };

export interface K8sDeployView {
  client: KubeClient;
  ns: string;
  name: string;
  deploy: Deployment;
  replicasets: KubeReplicaSet[];
  currentRevision: number | null;
  methods: string[];
  notes: string[];
}

export const rsRevision = (rs: { metadata: ObjectMeta }): number | null => {
  const v = Number(rs.metadata.annotations?.[REVISION]);
  return Number.isFinite(v) && v > 0 ? v : null;
};

export async function loadDeployView(ctx: Ctx, b: DeployBinding): Promise<K8sDeployView> {
  const client = kubeClient(ctx, b.endpointName);
  const ns = attr(b, 'namespace') ?? client.defaultNamespace;
  const name = requireAttr(b, 'deployment');
  const path = workloadPath(ns, 'Deployment', name);
  const r = await client.request<Deployment>('GET', path, { allowStatus: [404] });
  if (r.status === 404) {
    throw new WorkError('NOT_FOUND', `部署绑定 ${b.resource.id} 指定的 Deployment ${ns}/${name} 不存在`, { hint: '检查绑定的 attributes.namespace / attributes.deployment' });
  }
  const deploy = { ...r.body, kind: 'Deployment' };
  const sel = selectorString(deploy.spec.selector);
  if (!sel) throw new WorkError('PRECONDITION_FAILED', `Deployment ${ns}/${name} 的 spec.selector 为空`);
  const rsPath = `/apis/apps/v1/namespaces/${enc(ns)}/replicasets?labelSelector=${enc(sel)}`;
  const list = await client.get<KubeList<KubeReplicaSet>>(rsPath);
  const notes: string[] = [];
  // only ReplicaSets controlled by this Deployment (ownerReferences), not every RS with matching labels
  const owned = (list.items ?? []).filter((rs) => (rs.metadata.ownerReferences ?? []).some((o) => o.controller && o.uid === deploy.metadata.uid));
  const foreign = (list.items ?? []).length - owned.length;
  if (foreign) notes.push(`${foreign} 个 ReplicaSet 匹配选择器但不属于 Deployment ${name}（ownerReferences），已排除`);
  owned.sort((a, c) => (rsRevision(c) ?? 0) - (rsRevision(a) ?? 0));
  const cur = Number(deploy.metadata.annotations?.[REVISION]);
  return {
    client,
    ns,
    name,
    deploy,
    replicasets: owned,
    currentRevision: Number.isFinite(cur) && cur > 0 ? cur : null,
    methods: [`GET ${path}`, `GET /apis/apps/v1/namespaces/${ns}/replicasets?labelSelector=${sel}`],
    notes,
  };
}

function images(rs: KubeReplicaSet): string[] {
  return (rs.spec.template.spec?.containers ?? []).map((c) => c.image);
}

/** Rollout state of the Deployment as a release status (current revision only). */
export function currentRolloutStatus(d: Deployment): { status: Release['status']; basis: string; finished_at: string | null; state: 'complete' | 'progressing' | 'failed' | 'paused' } {
  const st = rolloutState(d, 'Deployment', 0);
  const prog = d.status?.conditions?.find((c) => c.type === 'Progressing');
  if (d.spec.paused) return { status: 'unknown', basis: `Deployment 已暂停（spec.paused=true）：${st.detail}`, finished_at: null, state: 'paused' };
  if (st.done) {
    const fin = prog?.reason === 'NewReplicaSetAvailable' ? prog.lastUpdateTime ?? null : null;
    return { status: 'succeeded', basis: `Deployment rollout 完成（${st.detail}；Progressing=${prog?.status ?? '?'} ${prog?.reason ?? ''}）`.replace(/ ）/, '）'), finished_at: fin, state: 'complete' };
  }
  if (st.failed) return { status: 'failed', basis: st.detail, finished_at: null, state: 'failed' };
  return { status: 'running', basis: `rollout 进行中：${st.detail}`, finished_at: null, state: 'progressing' };
}

export function releaseFromRs(v: K8sDeployView, rs: KubeReplicaSet): Release {
  const rev = rsRevision(rs);
  const current = rev !== null && rev === v.currentRevision;
  const imgs = images(rs);
  const ann = rs.metadata.annotations ?? {};
  const restartedAt = rs.spec.template.metadata?.annotations?.[RESTARTED_AT];
  // kubernetes.io/change-cause belongs to the Deployment and is copied to every new ReplicaSet: a later
  // rollout that did not update it (e.g. rollout restart) carries the previous text. Detect that case.
  const older = v.replicasets.find((x) => (rsRevision(x) ?? 0) < (rev ?? 0));
  const olderRestart = older?.spec.template.metadata?.annotations?.[RESTARTED_AT];
  let cause = ann[CHANGE_CAUSE] ?? (restartedAt ? `rollout restart（Pod 模板注解 ${RESTARTED_AT}=${restartedAt}）` : null);
  if (ann[CHANGE_CAUSE] && older && older.metadata.annotations?.[CHANGE_CAUSE] === ann[CHANGE_CAUSE] && restartedAt && restartedAt !== olderRestart) {
    cause = `rollout restart（Pod 模板注解 ${RESTARTED_AT}=${restartedAt}）；change-cause「${ann[CHANGE_CAUSE]}」沿用自修订 ${rsRevision(older)}，未随本次 rollout 更新`;
  }
  let status: Release['status'] = 'unknown';
  let basis: string;
  let finished: string | null = null;
  if (current) {
    const c = currentRolloutStatus(v.deploy);
    status = c.status;
    basis = c.basis;
    finished = c.finished_at;
  } else {
    const live = rs.status?.replicas ?? 0;
    basis = `已被当前修订 ${v.currentRevision ?? '?'} 替代；ReplicaSet 不记录当时 rollout 是否成功${live ? `（仍有 ${live} 个副本，替换进行中）` : ''}`;
  }
  const reused = ann[REVISION_HISTORY];
  const started = rs.metadata.creationTimestamp ?? null;
  return {
    id: rs.metadata.name,
    provider: 'kubernetes',
    version: imageTag(imgs[0]),
    images: imgs,
    revision: rev,
    started_at: started,
    finished_at: finished,
    timestamps: 'derived',
    duration_ms: started && finished ? Math.max(0, Date.parse(finished) - Date.parse(started)) : null,
    status,
    status_basis: reused ? `${basis}；该 ReplicaSet 曾是修订 ${reused}（回滚复用），started_at 为首次创建时间` : basis,
    current,
    triggered_by: null,
    cause,
    source_ref: { system: 'kubernetes', kind: 'ReplicaSet', name: `${v.ns}/${rs.metadata.name}`, url: null },
  };
}

async function k8sSources(v: K8sDeployView, methods: string[]): Promise<Source[]> {
  return Promise.all(methods.map((m) => v.client.source(m, 'explicit')));
}

function coverageNotes(v: K8sDeployView): string[] {
  const limit = v.deploy.spec.revisionHistoryLimit ?? 10;
  return [
    `Kubernetes 只保留 revisionHistoryLimit=${limit} 个旧 ReplicaSet（当前保留 ${v.replicasets.length} 个修订）；更早的发布不可见`,
    'started_at 为 ReplicaSet creationTimestamp（derived）；Kubernetes 不记录 rollout 完成时间，finished_at 仅对当前修订按 Progressing=NewReplicaSetAvailable 的 lastUpdateTime 推得',
    '被替代修订的状态为 unknown：ReplicaSet 不保存当时 rollout 的结果；triggered_by 不可得（API 不记录操作人，见审计日志）',
    ...v.notes,
  ];
}

export function findRelease(v: K8sDeployView, id: string): KubeReplicaSet | undefined {
  const s = id.replace(/^rev(ision)?[:-]?/i, '');
  if (/^\d+$/.test(s)) return v.replicasets.find((rs) => rsRevision(rs) === Number(s));
  return v.replicasets.find((rs) => rs.metadata.name === id);
}

export async function k8sReleaseList(ctx: Ctx, b: DeployBinding, windowMs: number, limit: number): Promise<Result> {
  const v = await loadDeployView(ctx, b);
  const since = Date.now() - windowMs;
  const all = v.replicasets.map((rs) => releaseFromRs(v, rs));
  // A ReplicaSet reused by a rollback keeps its first creationTimestamp, so started_at is not when that
  // revision went live. It went live after every lower revision was created: use the newest creation
  // time among revisions ≤ its own as the lower bound of its rollout time (replicasets: newest first).
  const rolledOutAfter = all.map((_, i) => Math.max(...all.slice(i).map((x) => (x.started_at ? Date.parse(x.started_at) : 0))));
  const inWindow = all.filter((r, i) => r.current || rolledOutAfter[i] >= since);
  const releases = inWindow.slice(0, limit);
  // excluded reused revisions whose rollout may still fall inside the window: it happened before the
  // nearest newer non-reused revision was created (or now), and that bound is inside the window
  const reused = (i: number) => !!v.replicasets[i].metadata.annotations?.[REVISION_HISTORY];
  const rolledOutBefore = (i: number) => {
    for (let k = i - 1; k >= 0; k--) if (!reused(k) && all[k].started_at) return Date.parse(all[k].started_at!);
    return Date.now();
  };
  const unsure = all.filter((r, i) => !inWindow.includes(r) && reused(i) && rolledOutBefore(i) >= since);
  return {
    data: { service: b.service, env: b.env, target: target(b, v), releases, retained: all.length },
    sources: await k8sSources(v, v.methods).then((s) => [...s.slice(0, 1), { ...s[1], relation: 'derived' as const }]),
    coverage: {
      complete: releases.length === inWindow.length && !unsure.length,
      scope: `Deployment ${v.ns}/${v.name} 保留的 ReplicaSet 修订（窗口内或当前生效）`,
      limit,
      truncated: releases.length < inWindow.length,
      window: { start: new Date(since).toISOString(), end: new Date().toISOString() },
      notes: [
        ...coverageNotes(v),
        '回滚复用的 ReplicaSet 按“晚于所有更低修订的创建时间”推得 rollout 时间下界，用于窗口判定',
        ...(unsure.length ? [`修订 ${unsure.map((r) => r.revision).join(', ')}（回滚复用）的 rollout 时间只能推得一个跨越窗口起点的范围，可能在窗口内，未列出；加大 --window 可见`] : []),
      ],
    },
    warnings: b.ignored.length ? [`服务 ${b.service} 还有其他部署绑定 ${b.ignored.join(', ')}，本次只查询 ${b.resource.id}`] : [],
  };
}

function target(b: DeployBinding, v: K8sDeployView) {
  return { binding: b.resource.id, provider: 'kubernetes' as const, endpoint: b.endpointName, object: `Deployment ${v.ns}/${v.name}` };
}

type RsContainer = NonNullable<NonNullable<KubeReplicaSet['spec']['template']['spec']>['containers']>[number];

function envView(c: RsContainer) {
  return (c.env ?? []).map((e) => ({ name: e.name, value: e.valueFrom ? '(valueFrom)' : maskValue(e.name, e.value ?? '') }));
}

/** Unmasked env values for comparison only (never output): a changed secret must still show up in env_changed. */
function envRaw(c: RsContainer | undefined): Map<string, string> {
  return new Map((c?.env ?? []).map((e) => [e.name, e.valueFrom ? `valueFrom:${JSON.stringify(e.valueFrom)}` : e.value ?? '']));
}

export async function k8sReleaseGet(ctx: Ctx, b: DeployBinding, id: string): Promise<Result> {
  const v = await loadDeployView(ctx, b);
  const rs = findRelease(v, id);
  if (!rs) {
    throw new WorkError('NOT_FOUND', `Deployment ${v.ns}/${v.name} 没有保留发布 ${id}`, {
      hint: `保留的修订: ${v.replicasets.map((x) => `${rsRevision(x)}=${x.metadata.name}`).join(', ') || '(无)'}；超出 revisionHistoryLimit 的 ReplicaSet 已被清理`,
    });
  }
  const release = releaseFromRs(v, rs);
  const cur = v.replicasets.find((x) => rsRevision(x) === v.currentRevision);
  const containers = (rs.spec.template.spec?.containers ?? []).map((c) => ({ name: c.name, image: c.image, env: envView(c) }));
  const curContainers = (cur?.spec.template.spec?.containers ?? []).map((c) => ({ name: c.name, image: c.image, env: envView(c) }));
  const diff = cur && cur !== rs
    ? {
        against_revision: v.currentRevision,
        images: containers.flatMap((c) => {
          const o = curContainers.find((x) => x.name === c.name);
          return o && o.image !== c.image ? [{ container: c.name, this_release: c.image, current: o.image }] : [];
        }),
        env_changed: (rs.spec.template.spec?.containers ?? []).flatMap((c) => {
          const o = (cur.spec.template.spec?.containers ?? []).find((x) => x.name === c.name);
          if (!o) return [];
          // compare raw values (masked values hide a changed secret); only names are output
          const a = envRaw(c);
          const z = envRaw(o);
          const names = new Set([...a.keys(), ...z.keys()]);
          return [...names].filter((n) => a.get(n) !== z.get(n)).map((n) => `${c.name}:${n}`);
        }),
      }
    : null;
  const ann = rs.metadata.annotations ?? {};
  return {
    data: {
      service: b.service,
      env: b.env,
      target: target(b, v),
      release,
      kubernetes: {
        namespace: v.ns,
        deployment: v.name,
        replicaset: rs.metadata.name,
        uid: rs.metadata.uid ?? null,
        revision: rsRevision(rs),
        revision_history: ann[REVISION_HISTORY] ? ann[REVISION_HISTORY].split(',').map(Number) : [],
        pod_template_hash: rs.metadata.labels?.['pod-template-hash'] ?? null,
        change_cause: ann[CHANGE_CAUSE] ?? null,
        created_at: rs.metadata.creationTimestamp ?? null,
        replicas: { desired: rs.spec.replicas ?? 0, current: rs.status?.replicas ?? 0, ready: rs.status?.readyReplicas ?? 0, available: rs.status?.availableReplicas ?? 0 },
        containers,
        diff_vs_current: diff,
      },
    },
    sources: await k8sSources(v, v.methods),
    coverage: { complete: true, scope: `ReplicaSet ${v.ns}/${rs.metadata.name}`, notes: ['环境变量中名称像凭据的值与 valueFrom 引用不显示', ...coverageNotes(v).slice(1, 2)] },
  };
}

export async function k8sStatusGet(ctx: Ctx, b: DeployBinding): Promise<Result> {
  const v = await loadDeployView(ctx, b);
  const d = v.deploy;
  const c = currentRolloutStatus(d);
  const curRs = v.replicasets.find((x) => rsRevision(x) === v.currentRevision);
  const sel = selectorString(d.spec.selector);
  const podsPath = `/api/v1/namespaces/${enc(v.ns)}/pods?labelSelector=${enc(sel)}`;
  const pods = (await v.client.get<KubeList<KubePod>>(podsPath)).items ?? [];
  const rsByHash = new Map(v.replicasets.map((rs) => [rs.metadata.labels?.['pod-template-hash'] ?? '', rs]));
  const podView = pods
    .map((p) => {
      const rs = rsByHash.get(p.metadata.labels?.['pod-template-hash'] ?? '');
      const waiting = (p.status.containerStatuses ?? []).map((s) => s.state?.waiting?.reason).filter(Boolean) as string[];
      return {
        name: p.metadata.name,
        revision: rs ? rsRevision(rs) : null,
        phase: p.status.phase ?? null,
        ready: p.status.conditions?.find((x) => x.type === 'Ready')?.status === 'True',
        waiting_reasons: waiting,
        restarts: (p.status.containerStatuses ?? []).reduce((a, s) => a + (s.restartCount ?? 0), 0),
        terminating: !!p.metadata.deletionTimestamp,
      };
    })
    .filter((p) => p.revision !== null)
    .sort((a, c2) => a.name.localeCompare(c2.name));
  return {
    data: {
      service: b.service,
      env: b.env,
      target: target(b, v),
      provider: 'kubernetes',
      state: c.state,
      detail: c.basis,
      current_release: curRs ? releaseFromRs(v, curRs) : null,
      in_progress: c.state === 'progressing',
      kubernetes: {
        generation: d.metadata.generation ?? null,
        observed_generation: d.status?.observedGeneration ?? null,
        paused: !!d.spec.paused,
        progress_deadline_seconds: d.spec.progressDeadlineSeconds ?? null,
        replicas: {
          desired: d.spec.replicas ?? 1,
          current: d.status?.replicas ?? 0,
          updated: d.status?.updatedReplicas ?? 0,
          ready: d.status?.readyReplicas ?? 0,
          available: d.status?.availableReplicas ?? 0,
          unavailable: d.status?.unavailableReplicas ?? 0,
        },
        conditions: (d.status?.conditions ?? []).map((x) => ({ type: x.type, status: x.status, reason: x.reason ?? null, message: x.message ?? null, last_update: x.lastUpdateTime ?? null })),
        pods: podView,
      },
      jenkins: null,
    },
    sources: [...(await k8sSources(v, v.methods)), await v.client.source(`GET /api/v1/namespaces/${v.ns}/pods?labelSelector=${sel}`)],
    coverage: { complete: true, scope: `Deployment ${v.ns}/${v.name} 当前 rollout 状态（kubectl rollout status 语义）`, notes: v.notes },
  };
}

// ---------------------------------------------------------------------------
// rollback plan / executor (kubectl rollout undo semantics)
// ---------------------------------------------------------------------------
export async function planK8sRollback(ctx: Ctx, b: DeployBinding, to: string | undefined): Promise<PlanDraft> {
  const v = await loadDeployView(ctx, b);
  const d = v.deploy;
  const cur = v.replicasets.find((x) => rsRevision(x) === v.currentRevision);
  const tgt = to ? findRelease(v, to) : v.replicasets.find((x) => (rsRevision(x) ?? 0) < (v.currentRevision ?? 0));
  const st = rolloutState(d, 'Deployment', 0);
  const settled = (d.status?.observedGeneration ?? 0) >= (d.metadata.generation ?? 0) && !(!st.done && !st.failed);
  const sameTemplate = !!tgt && !!cur && tgt.metadata.name === cur.metadata.name;
  const allowExecute = !!ctx.profile?.allow_execute;
  const dep = dependencyImpact(ctx, b.service);
  const curImages = cur ? images(cur) : (d.spec.template.spec?.containers ?? []).map((c) => c.image);
  const tgtImages = tgt ? images(tgt) : [];
  const retained = v.replicasets.map((x) => `${rsRevision(x)}=${x.metadata.name}`).join(', ');
  return {
    kind: 'deploy.rollback',
    title: `回滚服务 ${b.service}（${b.env ?? '未指定环境'}）的 Deployment ${v.ns}/${v.name} 到修订 ${tgt ? rsRevision(tgt) : to ?? '(无可用上一修订)'}`,
    params: { service: b.service, env: b.env, provider: 'kubernetes', endpoint: b.endpointName, namespace: v.ns, deployment: v.name, to: to ?? null },
    targets: [
      {
        provider: 'kubernetes',
        kind: 'Deployment',
        namespace: v.ns,
        name: v.name,
        uid: d.metadata.uid ?? null,
        generation: d.metadata.generation ?? null,
        current_revision: v.currentRevision,
        current_replicaset: cur?.metadata.name ?? null,
        current_images: curImages,
        target_release: tgt?.metadata.name ?? null,
        target_revision: tgt ? rsRevision(tgt) : null,
        target_replicaset_uid: tgt?.metadata.uid ?? null,
        target_images: tgtImages,
        target_change_cause: tgt?.metadata.annotations?.[CHANGE_CAUSE] ?? null,
        replicas: d.spec.replicas ?? 1,
      },
    ],
    impact: {
      service: b.service,
      env: b.env,
      provider: 'kubernetes',
      namespace: v.ns,
      deployment: v.name,
      image_change: curImages.join(',') === tgtImages.join(',') ? `镜像不变（${curImages.join(', ')}），只回滚 Pod 模板其他字段（环境变量、注解、探针等）` : `${curImages.join(', ')} → ${tgtImages.join(', ') || '?'}`,
      expected_interruption: `等价于 kubectl rollout undo --to-revision：Pod 模板替换为目标 ReplicaSet 的模板，按 ${JSON.stringify((d.spec.strategy as Record<string, unknown> | undefined) ?? {})} 滚动替换 ${d.spec.replicas ?? 1} 个 Pod`,
      dependents_of_service: dep.dependents,
      service_dependencies: dep.dependencies,
      dependency_note: `${dep.note}；被依赖方在 Pod 替换期间可能看到连接重置`,
      side_effect: `目标 ReplicaSet 成为新的修订号（revision 递增，原修订号从历史中消失），并写入 ${CHANGE_CAUSE} 注解；配置中心/数据库结构不随之回滚`,
    },
    preconditions: [
      { check: 'target_release_retained', ok: !!tgt, detail: tgt ? `目标 ReplicaSet ${v.ns}/${tgt.metadata.name}（修订 ${rsRevision(tgt)}）仍保留` : `${to ? `发布 ${to}` : '上一修订'} 不在保留的 ReplicaSet 中（保留: ${retained || '无'}；revisionHistoryLimit=${d.spec.revisionHistoryLimit ?? 10}）` },
      { check: 'target_differs_from_current', ok: !!tgt && !sameTemplate, detail: sameTemplate ? `目标就是当前修订 ${v.currentRevision}` : tgt ? `当前修订 ${v.currentRevision} → 目标修订 ${rsRevision(tgt)}` : '无目标' },
      { check: 'deployment_not_paused', ok: !d.spec.paused, detail: d.spec.paused ? 'Deployment 处于暂停状态（spec.paused=true），模板变更不会滚动' : '未暂停' },
      { check: 'no_rollout_in_progress', ok: settled, detail: !settled ? `存在进行中的 rollout（${st.detail}）；先确认是否要中断它` : st.failed ? `当前修订的 rollout 已失败（${st.detail}），没有进行中的 rollout` : `计划生成时没有进行中的 rollout（${st.detail}）` },
      { check: 'profile_allow_execute', ok: allowExecute, detail: allowExecute ? `profile ${ctx.profileName} 允许执行` : `profile ${ctx.profileName} 未开启 allow_execute` },
      { check: 'kubernetes_reachable', ok: true, detail: `${v.client.endpointId} 可访问（计划生成时）` },
    ],
    steps: [
      { name: 'recheck', detail: `GET Deployment 与目标 ReplicaSet：uid 与计划一致、当前修订仍为 ${v.currentRevision}（否则拒绝执行）` },
      { name: 'patch template', detail: `PATCH ${workloadPath(v.ns, 'Deployment', v.name)}（JSON patch：test uid，replace /spec/template 为目标 ReplicaSet 模板（去掉 pod-template-hash 标签），写 ${CHANGE_CAUSE}）` },
      { name: 'verify', detail: `轮询 Deployment 直到 observedGeneration ≥ 新 generation、updatedReplicas=availableReplicas=replicas；ProgressDeadlineExceeded 视为失败（最多 ${deployRolloutTiming.verifyMs / 1000}s，且不超过 --timeout）` },
    ],
    rollback: `再次回滚：workctl deploy rollback plan --service ${b.service} --to ${cur?.metadata.name ?? '<当前 ReplicaSet>'}（回滚后原当前修订会成为旧修订）`,
    idempotent: false,
    cancellable: false,
    ttlMs: 30 * 60_000,
  };
}

export async function k8sRollbackExecutor(ctx: Ctx, plan: Plan, report: (note: string) => void): Promise<unknown> {
  const t = plan.targets[0] ?? {};
  const client = kubeClient(ctx, String(plan.params.endpoint ?? '') || undefined);
  const ns = String(t.namespace);
  const name = String(t.name);
  const path = workloadPath(ns, 'Deployment', name);
  const before = await client.get<Deployment>(path);
  if (t.uid && before.metadata.uid !== t.uid) {
    throw new WorkError('PRECONDITION_FAILED', `Deployment ${ns}/${name} 的 uid 已变化（对象被删除重建），拒绝执行`, { details: { planned_uid: t.uid, current_uid: before.metadata.uid } });
  }
  const curRev = Number(before.metadata.annotations?.[REVISION]);
  if (t.current_revision !== null && t.current_revision !== undefined && curRev !== Number(t.current_revision)) {
    throw new WorkError('CONFLICT', `Deployment ${ns}/${name} 的当前修订已从 ${t.current_revision} 变为 ${curRev}（计划生成后有新的发布/回滚），拒绝执行`, { hint: '重新生成回滚计划' });
  }
  if (before.spec.paused) throw new WorkError('PRECONDITION_FAILED', `Deployment ${ns}/${name} 处于暂停状态，拒绝执行`);
  const rsName = String(t.target_release ?? '');
  if (!rsName) throw new WorkError('PRECONDITION_FAILED', '计划没有目标 ReplicaSet');
  const rsRes = await client.request<KubeReplicaSet>('GET', `/apis/apps/v1/namespaces/${enc(ns)}/replicasets/${enc(rsName)}`, { allowStatus: [404] });
  if (rsRes.status === 404) throw new WorkError('PRECONDITION_FAILED', `目标 ReplicaSet ${ns}/${rsName} 已不存在（可能已按 revisionHistoryLimit 清理），拒绝执行`);
  const rs = rsRes.body;
  if (t.target_replicaset_uid && rs.metadata.uid !== t.target_replicaset_uid) throw new WorkError('PRECONDITION_FAILED', `目标 ReplicaSet ${ns}/${rsName} 的 uid 已变化，拒绝执行`);
  if (!(rs.metadata.ownerReferences ?? []).some((o) => o.controller && o.uid === before.metadata.uid)) {
    throw new WorkError('PRECONDITION_FAILED', `ReplicaSet ${ns}/${rsName} 不受 Deployment ${name} 控制，拒绝执行`);
  }
  const template = JSON.parse(JSON.stringify(rs.spec.template)) as KubeReplicaSet['spec']['template'];
  if (template.metadata?.labels) delete template.metadata.labels['pod-template-hash'];
  const cause = `workctl deploy rollback to revision ${rsRevision(rs) ?? '?'} (${rsName}, plan ${plan.id})`;
  const t0 = Date.now();
  report(`rollback deployment/${name} → ReplicaSet ${rsName}（修订 ${rsRevision(rs)}）`);
  const revAnn = before.metadata.annotations?.[REVISION];
  const patched = await client.request<Deployment>('PATCH', path, {
    body: [
      { op: 'test', path: '/metadata/uid', value: before.metadata.uid },
      // conditional patch: a rollout / spec change landing between the recheck above and this PATCH bumps
      // generation (and later the revision annotation); the failed test rejects the whole patch (422)
      ...(before.metadata.generation !== undefined ? [{ op: 'test', path: '/metadata/generation', value: before.metadata.generation }] : []),
      ...(revAnn !== undefined ? [{ op: 'test', path: `/metadata/annotations/${REVISION.replace('/', '~1')}`, value: revAnn }] : []),
      { op: 'replace', path: '/spec/template', value: template },
      // JSON pointer: '/' in the annotation key is escaped as ~1; without annotations the map itself is added
      before.metadata.annotations
        ? { op: 'add', path: `/metadata/annotations/${CHANGE_CAUSE.replace('/', '~1')}`, value: cause }
        : { op: 'add', path: '/metadata/annotations', value: { [CHANGE_CAUSE]: cause } },
    ],
    contentType: 'application/json-patch+json',
    allowStatus: [409, 422],
  });
  const genBefore = before.metadata.generation ?? 0;
  if (patched.status === 409 || patched.status === 422) {
    // kube-apiserver answers a failed JSON-patch test with a generic 422 Invalid: re-read to tell a
    // concurrent change (CONFLICT) from a genuinely rejected patch
    const now = await client.get<Deployment>(path).catch(() => null);
    const nowRev = now?.metadata.annotations?.[REVISION];
    const status = (patched.body as unknown as { message?: string } | null)?.message ?? null;
    if (!now || now.metadata.uid !== before.metadata.uid || now.metadata.generation !== before.metadata.generation || nowRev !== revAnn) {
      throw new WorkError('CONFLICT', `Deployment ${ns}/${name} 在复核与 PATCH 之间被修改（generation ${genBefore} → ${now?.metadata.generation ?? '?'}，修订 ${revAnn ?? '?'} → ${nowRev ?? '?'}），回滚未写入`, {
        hint: '查看 workctl deploy status get 后重新生成回滚计划（workctl deploy rollback plan）',
        details: { http_status: patched.status, planned_generation: genBefore, current_generation: now?.metadata.generation ?? null, planned_revision: revAnn ?? null, current_revision: nowRev ?? null },
      });
    }
    throw new WorkError('INVALID_ARGUMENT', `Kubernetes 拒绝回滚 PATCH（HTTP ${patched.status}${status ? `: ${status}` : ''}），回滚未写入`, { details: { http_status: patched.status, message: status } });
  }
  const genAfter = patched.body.metadata?.generation ?? genBefore + 1;
  if (patched.body.metadata?.generation !== undefined && genAfter <= genBefore) {
    throw new WorkError('CONFLICT', `Deployment ${ns}/${name} 的 generation 未变化（${genBefore}）：目标模板与当前模板相同，没有触发回滚`, { details: { generation: genBefore } });
  }
  const deadline = Date.now() + Math.min(deployRolloutTiming.verifyMs, Math.max(0, ctx.remainingMs() - 1_000));
  let cur = patched.body;
  let st = rolloutState(cur, 'Deployment', genAfter);
  for (;;) {
    if (st.done || st.failed || Date.now() >= deadline) break;
    await sleep(deployRolloutTiming.pollMs, ctx.signal);
    cur = await client.get<Deployment>(path);
    st = rolloutState(cur, 'Deployment', genAfter);
  }
  const outcome = {
    deployment: `${ns}/${name}`,
    from_revision: curRev,
    to_replicaset: rsName,
    new_revision: Number(cur.metadata.annotations?.[REVISION]) || null,
    images: (cur.spec.template.spec?.containers ?? []).map((c) => c.image),
    generation_before: genBefore,
    generation_after: genAfter,
    verified: st.done,
    detail: st.done ? `rollout 完成：${st.detail}` : st.failed ? `rollout 失败：${st.detail}` : `时间预算内未完成：${st.detail}`,
    duration_ms: Date.now() - t0,
  };
  report(outcome.detail);
  if (!st.done) {
    const hint = `workctl deploy status get --service ${String(plan.params.service)}；不要直接重试（模板已写入）`;
    if (st.failed) throw new WorkError('UPSTREAM_UNAVAILABLE', `回滚 rollout 失败（${st.detail}）`, { hint, details: { outcome } });
    throw new WorkError('TIMEOUT', `回滚 rollout 在时间预算内未完成；模板已写入，rollout 可能仍在进行`, { hint, details: { outcome } });
  }
  const ver = await client.version().catch(() => undefined);
  return { service: plan.params.service, provider: 'kubernetes', rollback: outcome, kubernetes_version: ver?.gitVersion ?? null, note: '校验依据为 Deployment rollout 状态；业务可用性请再探测' };
}
