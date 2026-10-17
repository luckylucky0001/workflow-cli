import { basicAuth, httpError, rawRequest, safeUrl } from '../../core/http';
import { source, WorkError, type Result, type Source } from '../../core/output';
import type { Plan, PlanDraft } from '../../core/operations';
import { sleep, type Ctx } from '../../core/runtime';
import { attr, dependencyImpact, isSecretName, maskSecrets, requireAttr, type DeployBinding, type Release } from './model';

/**
 * Jenkins provider: a release is a build of the bound deploy job (freestyle or pipeline).
 * Endpoint kind `jenkins`: url, user, password_ref | token_ref. Version from the X-Jenkins header.
 * Binding attributes: job (folder/job allowed), version_param (default VERSION), optional
 * service_param / env_param to filter a job shared by several services or environments.
 */
export const JENKINS_ADAPTER = 'jenkins-rest';
export const JENKINS_AUTH = 'jenkins-basic';
const BUILD_TREE = 'number,url,result,building,timestamp,duration,estimatedDuration,actions[parameters[name,value],causes[shortDescription,userId,userName]]';
export const CONSOLE_TAIL_DEFAULT = 30;
/** Rollback (re-deploy) build polling. Mutable only for tests. */
export const jenkinsRollbackTiming = { pollMs: 1_500, verifyMs: 300_000 };

export interface JenkinsBuild {
  number: number;
  url?: string;
  result?: string | null;
  building?: boolean;
  timestamp?: number;
  duration?: number;
  estimatedDuration?: number;
  displayName?: string;
  description?: string | null;
  builtOn?: string;
  actions?: ({ _class?: string; parameters?: { name: string; value?: unknown }[]; causes?: { shortDescription?: string; userId?: string | null; userName?: string | null }[] } | null)[];
}

export class JenkinsClient {
  version: string | null = null;
  constructor(
    readonly endpointId: string,
    readonly baseUrl: string,
    private readonly authHeader: string | undefined,
    private readonly ctx: Ctx | null,
  ) {}

  async request(path: string, opts: { method?: string; allowStatus?: number[]; headers?: Record<string, string> } = {}): Promise<{ status: number; text: string; headers: Record<string, string | string[] | undefined> }> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'workctl', ...(opts.headers ?? {}) };
    if (this.authHeader) headers.authorization = this.authHeader;
    let res;
    try {
      res = await rawRequest(url, { method: opts.method ?? 'GET', headers, ...(opts.method === 'POST' ? { body: '' } : {}), timeoutMs: this.ctx?.remainingMs() ?? 30_000 });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new WorkError('TIMEOUT', `Jenkins 调用超时 (${this.endpointId})`, { hint: '增大 --timeout' });
      throw new WorkError('UPSTREAM_UNAVAILABLE', `Jenkins 不可达 (${err?.code ?? err?.message ?? 'unknown'}, ${this.endpointId})`, { hint: '确认 url 与 Jenkins 状态', details: { code: err?.code ?? null } });
    }
    const v = res.headers['x-jenkins'];
    if (typeof v === 'string') this.version = v;
    if (res.status >= 400 && !(opts.allowStatus ?? []).includes(res.status)) {
      const we = httpError(url, res.status, res.text.slice(0, 300));
      const hint =
        res.status === 401 ? '检查 user 与 password_ref / token_ref（建议使用 API token）'
        : res.status === 403 ? '该身份缺少 Overall/Read 或 Job/Read 权限（或匿名访问被拒绝）'
        : res.status === 404 ? '检查绑定的 attributes.job（文件夹写成 folder/job）或构建号'
        : '查看 Jenkins 日志';
      throw new WorkError(we.code, we.message.replace('目标系统', 'Jenkins'), { hint, details: { status: res.status, endpoint: this.endpointId } });
    }
    return { status: res.status, text: res.text, headers: res.headers };
  }

  async json<T>(path: string): Promise<T> {
    const r = await this.request(path);
    try {
      return JSON.parse(r.text) as T;
    } catch {
      throw new WorkError('UPSTREAM_UNAVAILABLE', `Jenkins 返回的不是 JSON (${path.split('?')[0]})`, { hint: 'url 是否指向 Jenkins 根路径（含 context path）' });
    }
  }

  source(method: string, relation: Source['relation'] = 'explicit'): Source {
    return source('jenkins', JENKINS_ADAPTER, { endpoint: this.endpointId, method, relation, ...(this.version ? { version: this.version } : {}) });
  }
}

export function jenkinsClient(ctx: Ctx, name?: string): JenkinsClient {
  const ep = ctx.endpoint('jenkins', name);
  const url = ep.require('url').replace(/\/$/, '');
  if (!/^https?:\/\//.test(url)) throw new WorkError('INVALID_ARGUMENT', `端点 ${ep.id} 的 url 必须是 http(s) URL`);
  const user = ep.str('user');
  const secret = ep.secret('token') ?? ep.secret('password');
  if (!user || !secret) ctx.warn(`端点 ${ep.id} 未配置 user + token_ref/password_ref，以匿名身份访问 Jenkins`);
  return new JenkinsClient(`${ep.id} (${safeUrl(url)})`, url, user && secret ? basicAuth(user, secret) : undefined, ctx);
}

export function jobPath(job: string): string {
  return job.split('/').filter(Boolean).map((s) => `/job/${encodeURIComponent(s)}`).join('');
}

function params(b: JenkinsBuild): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of b.actions ?? []) for (const p of a?.parameters ?? []) out[p.name] = p.value === undefined || p.value === null ? '' : String(p.value);
  return out;
}

function causes(b: JenkinsBuild) {
  return (b.actions ?? []).flatMap((a) => a?.causes ?? []);
}

export function buildStatus(b: JenkinsBuild): Release['status'] {
  if (b.building) return 'running';
  switch (b.result) {
    case 'SUCCESS':
      return 'succeeded';
    case 'FAILURE':
    case 'UNSTABLE':
      return 'failed';
    case 'ABORTED':
      return 'aborted';
    default:
      return 'unknown';
  }
}

interface JobCfg {
  job: string;
  versionParam: string;
  serviceParam?: string;
  envParam?: string;
}

function jobCfg(b: DeployBinding): JobCfg {
  return { job: requireAttr(b, 'job'), versionParam: attr(b, 'version_param') ?? 'VERSION', serviceParam: attr(b, 'service_param'), envParam: attr(b, 'env_param') };
}

/** Whether a build deploys this service/env (when the binding names the parameters). */
export function buildMatches(b: JenkinsBuild, cfg: JobCfg, service: string, env: string | null): boolean {
  const p = params(b);
  if (cfg.serviceParam && cfg.serviceParam in p && p[cfg.serviceParam] !== service) return false;
  if (cfg.envParam && env && cfg.envParam in p && p[cfg.envParam] !== env) return false;
  return true;
}

export function releaseFromBuild(b: JenkinsBuild, cfg: JobCfg, currentNumber: number | null): Release {
  const p = params(b);
  const cs = causes(b);
  const status = buildStatus(b);
  const started = typeof b.timestamp === 'number' ? new Date(b.timestamp).toISOString() : null;
  const finished = !b.building && typeof b.timestamp === 'number' && typeof b.duration === 'number' ? new Date(b.timestamp + b.duration).toISOString() : null;
  const current = b.number === currentNumber;
  return {
    id: String(b.number),
    provider: 'jenkins',
    version: p[cfg.versionParam] ?? null,
    images: [],
    revision: b.number,
    started_at: started,
    finished_at: finished,
    timestamps: 'explicit',
    duration_ms: b.building ? null : b.duration ?? null,
    status,
    status_basis: b.building ? 'Jenkins 构建进行中（building=true）' : `Jenkins 构建结果 ${b.result ?? '(无)'}${current ? '；最近一次成功的部署构建，视为当前版本（Jenkins 不观测目标环境实际运行的版本）' : ''}`,
    current,
    triggered_by: cs.find((c) => c.userId)?.userId ?? cs[0]?.shortDescription ?? null,
    cause: cs.map((c) => c.shortDescription).filter(Boolean).join('; ') || null,
    source_ref: { system: 'jenkins', kind: 'jenkins.build', name: `${cfg.job}#${b.number}`, url: b.url ? safeUrl(b.url) : null },
  };
}

interface JobView {
  client: JenkinsClient;
  cfg: JobCfg;
  builds: JenkinsBuild[];
  matching: JenkinsBuild[];
  currentNumber: number | null;
  numToKeep: number | null;
  method: string;
}

async function loadJob(ctx: Ctx, b: DeployBinding, fetch = 100): Promise<JobView> {
  const client = jenkinsClient(ctx, b.endpointName);
  const cfg = jobCfg(b);
  const tree = `builds[${BUILD_TREE}]{0,${fetch}}`;
  const path = `${jobPath(cfg.job)}/api/json?tree=${encodeURIComponent(tree)}`;
  const job = await client.json<{ builds?: JenkinsBuild[] }>(path);
  const builds = (job.builds ?? []).sort((a, c) => c.number - a.number);
  const matching = builds.filter((x) => buildMatches(x, cfg, b.service, b.env));
  const cur = matching.find((x) => !x.building && x.result === 'SUCCESS');
  // the build discarder is not exported over the JSON API; config.xml needs Job/ExtendedRead (optional)
  const xml = await client.request(`${jobPath(cfg.job)}/config.xml`, { allowStatus: [401, 403, 404] }).catch(() => null);
  const m = xml && xml.status === 200 ? /<numToKeep>(-?\d+)<\/numToKeep>/.exec(xml.text) : null;
  const keep = m ? Number(m[1]) : undefined;
  return { client, cfg, builds, matching, currentNumber: cur?.number ?? null, numToKeep: keep !== undefined && keep >= 0 ? keep : null, method: `GET ${jobPath(cfg.job)}/api/json?tree=builds[...]{0,${fetch}}` };
}

function target(b: DeployBinding, v: JobView) {
  return { binding: b.resource.id, provider: 'jenkins' as const, endpoint: b.endpointName, object: `job ${v.cfg.job}` };
}

function jobNotes(v: JobView, b: DeployBinding): string[] {
  return [
    v.numToKeep !== null ? `Jenkins job 构建丢弃策略只保留最近 ${v.numToKeep} 个构建；更早的发布不可见` : 'Jenkins 只保留 job 构建丢弃策略允许的构建（未能读取 config.xml 中的策略，需要 Job/ExtendedRead）；API 最多返回 100 个构建',
    `时间来自构建 timestamp/duration（explicit）；version 为构建参数 ${v.cfg.versionParam}`,
    v.cfg.serviceParam || v.cfg.envParam
      ? `按构建参数过滤：${[v.cfg.serviceParam ? `${v.cfg.serviceParam}=${b.service}` : '', v.cfg.envParam && b.env ? `${v.cfg.envParam}=${b.env}` : ''].filter(Boolean).join(', ')}（${v.builds.length - v.matching.length} 个构建属于其他服务/环境，已排除）`
      : '绑定未声明 service_param/env_param：job 的全部构建都视为该服务的发布',
    'current=最近一次成功的部署构建；Jenkins 不观测目标环境实际运行的版本，需要与容器/工作负载的镜像核对',
  ];
}

export async function jenkinsReleaseList(ctx: Ctx, b: DeployBinding, windowMs: number, limit: number): Promise<Result> {
  const v = await loadJob(ctx, b);
  const since = Date.now() - windowMs;
  const inWindow = v.matching.filter((x) => (x.timestamp ?? 0) >= since).map((x) => releaseFromBuild(x, v.cfg, v.currentNumber));
  const releases = inWindow.slice(0, limit);
  return {
    data: { service: b.service, env: b.env, target: target(b, v), releases, retained: v.matching.length },
    sources: [v.client.source(v.method)],
    coverage: {
      complete: releases.length === inWindow.length,
      scope: `Jenkins job ${v.cfg.job} 保留的构建（窗口内）`,
      limit,
      truncated: releases.length < inWindow.length,
      window: { start: new Date(since).toISOString(), end: new Date().toISOString() },
      notes: jobNotes(v, b),
    },
  };
}

export async function jenkinsReleaseGet(ctx: Ctx, b: DeployBinding, id: string, tail: number): Promise<Result> {
  const client = jenkinsClient(ctx, b.endpointName);
  const cfg = jobCfg(b);
  const n = id.replace(/^#/, '');
  if (!/^\d+$/.test(n)) throw new WorkError('INVALID_ARGUMENT', `Jenkins 发布 ID 应为构建号: ${id}`);
  const path = `${jobPath(cfg.job)}/${n}/api/json?tree=${encodeURIComponent(`${BUILD_TREE},displayName,description,builtOn`)}`;
  const r = await client.request(path, { allowStatus: [404] });
  if (r.status === 404) {
    throw new WorkError('NOT_FOUND', `Jenkins job ${cfg.job} 没有构建 #${n}`, { hint: '构建可能已被构建丢弃策略清理；用 workctl deploy release list 查看保留的发布' });
  }
  const build = JSON.parse(r.text) as JenkinsBuild;
  if (!buildMatches(build, cfg, b.service, b.env)) {
    throw new WorkError('NOT_FOUND', `构建 #${n} 不是服务 ${b.service}${b.env ? `/${b.env}` : ''} 的发布（构建参数不匹配）`, { details: { parameters: maskParams(params(build)) } });
  }
  // current = newest successful matching build (needs the job's build list)
  const v = await loadJob(ctx, b, 50);
  const release = releaseFromBuild(build, cfg, v.currentNumber);
  const cr = await client.request(`${jobPath(cfg.job)}/${n}/consoleText`, { allowStatus: [404] });
  const lines = cr.status === 200 ? cr.text.replace(/\r/g, '').split('\n') : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const shown = lines.slice(-tail).map(maskSecrets);
  return {
    data: {
      service: b.service,
      env: b.env,
      target: { binding: b.resource.id, provider: 'jenkins', endpoint: b.endpointName, object: `job ${cfg.job}` },
      release,
      jenkins: {
        job: cfg.job,
        number: build.number,
        result: build.result ?? null,
        building: !!build.building,
        estimated_duration_ms: build.estimatedDuration ?? null,
        built_on: build.builtOn || null,
        parameters: maskParams(params(build)),
        causes: causes(build).map((c) => ({ description: c.shortDescription ?? null, user_id: c.userId ?? null })),
        console: { lines: shown, total_lines: lines.length, truncated: lines.length > shown.length, masked: true },
      },
    },
    sources: [client.source(`GET ${jobPath(cfg.job)}/${n}/api/json`), client.source(`GET ${jobPath(cfg.job)}/${n}/consoleText`), client.source(v.method, 'derived')],
    coverage: {
      complete: !build.building,
      scope: `Jenkins 构建 ${cfg.job}#${n}`,
      notes: [`控制台日志只返回最后 ${tail} 行，凭据样式的值（password/token/secret=…、Bearer、URL 中的用户名密码）已遮蔽`, ...(build.building ? ['构建仍在进行，日志与结果未定'] : [])],
    },
  };
}

function maskParams(p: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, isSecretName(k) ? '******' : v]));
}

interface QueueItem {
  id: number;
  why?: string | null;
  inQueueSince?: number;
  blocked?: boolean;
  stuck?: boolean;
  params?: string;
  task?: { name?: string; url?: string };
}

export async function jenkinsStatusGet(ctx: Ctx, b: DeployBinding): Promise<Result> {
  const v = await loadJob(ctx, b, 30);
  const q = await v.client.json<{ items?: QueueItem[] }>(`/queue/api/json?tree=${encodeURIComponent('items[id,why,inQueueSince,blocked,stuck,params,task[name,url]]')}`);
  const jobName = v.cfg.job.split('/').filter(Boolean).pop();
  const queued = (q.items ?? []).filter((it) => {
    if (it.task?.name !== jobName) return false;
    const p = Object.fromEntries((it.params ?? '').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    if (v.cfg.serviceParam && v.cfg.serviceParam in p && p[v.cfg.serviceParam] !== b.service) return false;
    if (v.cfg.envParam && b.env && v.cfg.envParam in p && p[v.cfg.envParam] !== b.env) return false;
    return true;
  });
  const running = v.matching.filter((x) => x.building);
  const last = v.matching.find((x) => !x.building);
  const cur = v.matching.find((x) => x.number === v.currentNumber);
  const lastStatus = last ? buildStatus(last) : 'unknown';
  const state = running.length ? 'progressing' : queued.length ? 'queued' : lastStatus === 'succeeded' ? 'complete' : lastStatus === 'failed' ? 'failed' : lastStatus === 'aborted' ? 'aborted' : 'unknown';
  const detail = running.length
    ? `${running.length} 个部署构建进行中（#${running.map((x) => x.number).join(', #')}）`
    : queued.length
      ? `${queued.length} 个部署构建排队中：${queued.map((x) => x.why ?? '').join('; ')}`
      : last
        ? `没有进行中的部署；最近一次构建 #${last.number} 结果 ${last.result}`
        : '该服务没有保留的部署构建';
  return {
    data: {
      service: b.service,
      env: b.env,
      target: target(b, v),
      provider: 'jenkins',
      state,
      detail,
      current_release: cur ? releaseFromBuild(cur, v.cfg, v.currentNumber) : null,
      in_progress: running.length > 0 || queued.length > 0,
      kubernetes: null,
      jenkins: {
        job: v.cfg.job,
        running: running.map((x) => releaseFromBuild(x, v.cfg, v.currentNumber)),
        queued: queued.map((it) => ({ queue_id: it.id, why: it.why ?? null, in_queue_since: it.inQueueSince ? new Date(it.inQueueSince).toISOString() : null, blocked: !!it.blocked, stuck: !!it.stuck })),
        last_build: last ? releaseFromBuild(last, v.cfg, v.currentNumber) : null,
      },
    },
    sources: [v.client.source(v.method), v.client.source('GET /queue/api/json')],
    coverage: { complete: true, scope: `Jenkins job ${v.cfg.job} 的构建与队列`, notes: jobNotes(v, b).slice(2) },
  };
}

export async function planJenkinsRollback(ctx: Ctx, b: DeployBinding, to: string | undefined): Promise<PlanDraft> {
  const v = await loadJob(ctx, b);
  const cur = v.matching.find((x) => x.number === v.currentNumber);
  const curRel = cur ? releaseFromBuild(cur, v.cfg, v.currentNumber) : null;
  const n = to?.replace(/^#/, '');
  const tgt = n
    ? v.matching.find((x) => String(x.number) === n)
    : v.matching.find((x) => !x.building && x.result === 'SUCCESS' && x.number !== v.currentNumber && releaseFromBuild(x, v.cfg, null).version !== curRel?.version);
  const tgtRel = tgt ? releaseFromBuild(tgt, v.cfg, v.currentNumber) : null;
  const running = v.matching.filter((x) => x.building);
  const dep = dependencyImpact(ctx, b.service);
  const allowExecute = !!ctx.profile?.allow_execute;
  // PasswordParameterValue has no value over the API: such builds cannot be replayed as-is
  const secretParams = tgt ? (tgt.actions ?? []).flatMap((a) => a?.parameters ?? []).filter((x) => x.value === undefined || isSecretName(x.name)).map((x) => x.name) : [];
  const replay = tgt ? Object.fromEntries(Object.entries(params(tgt)).filter(([k]) => !secretParams.includes(k))) : {};
  return {
    kind: 'deploy.rollback',
    title: `回滚服务 ${b.service}（${b.env ?? '未指定环境'}）到 Jenkins 构建 #${tgt?.number ?? n ?? '?'}${tgtRel?.version ? `（${tgtRel.version}）` : ''}`,
    params: { service: b.service, env: b.env, provider: 'jenkins', endpoint: b.endpointName, job: v.cfg.job, to: to ?? null, version_param: v.cfg.versionParam, service_param: v.cfg.serviceParam ?? null, env_param: v.cfg.envParam ?? null, replay_parameters: replay },
    targets: [
      {
        provider: 'jenkins',
        job: v.cfg.job,
        current_build: cur?.number ?? null,
        current_version: curRel?.version ?? null,
        target_build: tgt?.number ?? null,
        target_version: tgtRel?.version ?? null,
        target_result: tgt?.result ?? null,
        target_parameters: tgt ? maskParams(params(tgt)) : null,
      },
    ],
    impact: {
      service: b.service,
      env: b.env,
      provider: 'jenkins',
      version_change: `${curRel?.version ?? '?'} → ${tgtRel?.version ?? '?'}`,
      expected_interruption: '由部署 job 自身的发布流程决定（workctl 不了解 job 内部步骤）；执行即用目标构建的参数重新触发部署 job（Jenkins 中产生新构建）',
      dependents_of_service: dep.dependents,
      service_dependencies: dep.dependencies,
      dependency_note: dep.note,
    },
    preconditions: [
      { check: 'target_release_retained', ok: !!tgt, detail: tgt ? `构建 #${tgt.number} 仍保留` : `${n ? `构建 #${n}` : '上一个不同版本的成功构建'} 不在保留的构建中` },
      { check: 'target_succeeded', ok: tgt?.result === 'SUCCESS', detail: tgt ? `目标构建结果 ${tgt.result ?? '(进行中)'}` : '无目标' },
      { check: 'target_differs_from_current', ok: !!tgtRel && tgtRel.version !== curRel?.version, detail: tgtRel ? `当前 ${curRel?.version ?? '?'}（#${cur?.number ?? '?'}）→ 目标 ${tgtRel.version}` : '无目标' },
      { check: 'no_deploy_in_progress', ok: running.length === 0, detail: running.length ? `构建 #${running.map((x) => x.number).join(', #')} 进行中` : '没有进行中的部署构建' },
      {
        check: 'parameters_replayable',
        ok: secretParams.length === 0,
        detail: secretParams.length ? `目标构建含凭据类参数 ${secretParams.join(', ')}，API 不返回其值，无法原样重放；在 Jenkins 中手工触发` : `目标构建参数可原样重放: ${Object.keys(replay).join(', ') || '(无)'}`,
      },
      { check: 'profile_allow_execute', ok: allowExecute, detail: allowExecute ? `profile ${ctx.profileName} 允许执行` : `profile ${ctx.profileName} 未开启 allow_execute` },
    ],
    steps: [
      { name: 'recheck', detail: `执行前重读 job：当前成功构建仍为 #${cur?.number ?? '?'}、没有进行中的部署构建（否则拒绝执行）` },
      { name: 'trigger deploy job', detail: `POST ${jobPath(v.cfg.job)}/buildWithParameters（参数取自构建 #${tgt?.number ?? '?'}: ${Object.entries(replay).map(([k, x]) => `${k}=${x}`).join('&')}；需要 Job/Build 权限，密码认证时附带 crumb）` },
      { name: 'verify', detail: `轮询队列项直到分配构建号，再轮询构建直到结束；结果 SUCCESS 才算成功（最多 ${jenkinsRollbackTiming.verifyMs / 1000}s，且不超过 --timeout）。部署 job 的成功不等于服务健康：再用 container workload get / 指标核对` },
    ],
    rollback: `再生成回滚计划 --to ${cur?.number ?? '<当前构建号>'}，用当前版本 ${curRel?.version ?? '?'} 再次触发部署 job`,
    idempotent: false,
    cancellable: false,
    ttlMs: 30 * 60_000,
  };
}

export async function jenkinsProbe(ctx: Ctx, name: string) {
  const client = jenkinsClient(ctx, name);
  const me = await client.json<{ id?: string; fullName?: string }>('/me/api/json?tree=id,fullName');
  const root = await client.json<{ jobs?: unknown[]; numExecutors?: number }>(`/api/json?tree=${encodeURIComponent('numExecutors,jobs[name]')}`);
  return {
    ok: true,
    identity: me.id ?? undefined,
    version: client.version ?? undefined,
    detail: `可见 job ${root.jobs?.length ?? 0} 个；内置节点执行器 ${root.numExecutors ?? '?'} 个`,
  };
}

/** Crumb (CSRF) for POST; crumbs are bound to the web session, so the session cookie is returned too. */
async function crumbHeaders(client: JenkinsClient): Promise<Record<string, string>> {
  const r = await client.request('/crumbIssuer/api/json', { allowStatus: [404] });
  if (r.status === 404) return {}; // CSRF protection disabled
  const c = JSON.parse(r.text) as { crumb: string; crumbRequestField: string };
  const sc = r.headers['set-cookie'];
  const cookie = (Array.isArray(sc) ? sc : sc ? [sc] : []).map((x) => x.split(';')[0]).join('; ');
  return { [c.crumbRequestField]: c.crumb, ...(cookie ? { cookie } : {}) };
}

/** Re-deploy the target build's version: buildWithParameters with its (non-secret) parameters, then wait for the build. */
export async function jenkinsRollbackExecutor(ctx: Ctx, plan: Plan, report: (note: string) => void): Promise<unknown> {
  const t = plan.targets[0] ?? {};
  const service = String(plan.params.service);
  const env = (plan.params.env as string | null) ?? null;
  const client = jenkinsClient(ctx, String(plan.params.endpoint));
  const job = String(plan.params.job);
  const replay = (plan.params.replay_parameters ?? {}) as Record<string, string>;
  const cfg: JobCfg = { job, versionParam: String(plan.params.version_param ?? 'VERSION'), serviceParam: (plan.params.service_param as string | undefined) || undefined, envParam: (plan.params.env_param as string | undefined) || undefined };
  // recheck: nothing deployed or running since the plan was made
  const job0 = await client.json<{ builds?: JenkinsBuild[] }>(`${jobPath(job)}/api/json?tree=${encodeURIComponent(`builds[${BUILD_TREE}]{0,30}`)}`);
  const matching = (job0.builds ?? []).filter((x) => buildMatches(x, cfg, service, env));
  const running = matching.filter((x) => x.building);
  if (running.length) throw new WorkError('CONFLICT', `部署 job ${job} 有进行中的构建 #${running.map((x) => x.number).join(', #')}，拒绝执行`, { hint: '等待构建结束后重新生成计划' });
  const curNow = matching.sort((a, c) => c.number - a.number).find((x) => x.result === 'SUCCESS');
  if (t.current_build !== null && t.current_build !== undefined && curNow && curNow.number !== Number(t.current_build)) {
    throw new WorkError('CONFLICT', `当前成功部署构建已从 #${t.current_build} 变为 #${curNow.number}（计划生成后有新的发布），拒绝执行`, { hint: '重新生成回滚计划' });
  }
  const q = new URLSearchParams(replay).toString();
  const headers = { ...(await crumbHeaders(client)), 'content-length': '0' };
  report(`trigger ${job} buildWithParameters ${q}`);
  const t0 = Date.now();
  const res = await client.request(`${jobPath(job)}/buildWithParameters?${q}`, { method: 'POST', headers });
  const loc = res.headers.location;
  const qm = /\/queue\/item\/(\d+)/.exec(String(Array.isArray(loc) ? loc[0] : loc ?? ''));
  if (!qm) throw new WorkError('UPSTREAM_UNAVAILABLE', `Jenkins 未返回队列项（HTTP ${res.status}），无法确认构建已触发`, { hint: `在 Jenkins 中查看 job ${job}；不要直接重试` });
  const deadline = Date.now() + Math.min(jenkinsRollbackTiming.verifyMs, Math.max(0, ctx.remainingMs() - 1_000));
  let number: number | null = null;
  while (number === null) {
    const item = await client.json<{ cancelled?: boolean; why?: string | null; executable?: { number: number } | null }>(`/queue/item/${qm[1]}/api/json`);
    if (item.cancelled) throw new WorkError('UPSTREAM_UNAVAILABLE', `Jenkins 队列项 ${qm[1]} 被取消`, { details: { queue_id: Number(qm[1]) } });
    if (item.executable?.number) number = item.executable.number;
    else {
      if (Date.now() >= deadline) throw new WorkError('TIMEOUT', `构建仍在排队（${item.why ?? ''}）；已触发，可能稍后执行`, { hint: `workctl deploy status get --service ${service}；不要直接重试`, details: { queue_id: Number(qm[1]) } });
      await sleep(jenkinsRollbackTiming.pollMs, ctx.signal);
    }
  }
  report(`queue item ${qm[1]} → build #${number}`);
  let b: JenkinsBuild;
  for (;;) {
    b = await client.json<JenkinsBuild>(`${jobPath(job)}/${number}/api/json?tree=${encodeURIComponent(BUILD_TREE)}`);
    if (!b.building && b.result) break;
    if (Date.now() >= deadline) throw new WorkError('TIMEOUT', `回滚构建 #${number} 在时间预算内未结束`, { hint: `workctl deploy release get --service ${service} --id ${number}；不要直接重试`, details: { build: number } });
    await sleep(jenkinsRollbackTiming.pollMs, ctx.signal);
  }
  const outcome = { job, build: number, url: b.url ? safeUrl(b.url) : null, result: b.result ?? null, version: replay[cfg.versionParam] ?? null, parameters: replay, duration_ms: Date.now() - t0, verified: b.result === 'SUCCESS' };
  report(`build #${number} ${b.result}`);
  if (b.result !== 'SUCCESS') {
    throw new WorkError('UPSTREAM_UNAVAILABLE', `回滚构建 #${number} 结果 ${b.result}`, { hint: `workctl deploy release get --service ${service} --id ${number} 查看控制台日志`, details: { outcome } });
  }
  return { service, provider: 'jenkins', rollback: outcome, jenkins_version: client.version, note: '校验依据为部署 job 构建结果 SUCCESS；服务实际版本与健康请用 container workload get / 指标核对' };
}
