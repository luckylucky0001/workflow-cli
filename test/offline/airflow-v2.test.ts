/**
 * Airflow 3 (REST API v2) adapter: the same capabilities against a fake v1 server and a fake v2
 * server built from the SAME facts must return the same output contract (same zod schema, same
 * data). Only provenance differs (adapter airflow-rest-v1 / -v2, method /api/v1 / /api/v2, version).
 * The v2 fake is strict where Airflow 3 differs: bearer token from POST /auth/token, logical_date_*
 * filters, JSON-only logs, logical_date required on trigger.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config';
import { invoke } from '../../src/core/engine';
import type { PlanDraft } from '../../src/core/operations';
import { Registry } from '../../src/core/registry';
import { Ctx } from '../../src/core/runtime';
import compute from '../../src/domains/compute';
import offline from '../../src/domains/offline';
import { clearAirflowTokenCache, isoDurationToTimedelta, normalizeV2, structuredLogToText, toV2Method, toV2Route } from '../../src/domains/offline/airflow-v2';
import { backfillExecutor } from '../../src/domains/offline/backfill';
import { fakeServer, tempConfig } from './fake';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';

const DAG_ID = 'demo-daily-orders';
const SRC = 'dag source text';

// ---------------------------------------------------------------- facts, rendered as v1 and as v2
const FACT_RUNS = [
  { id: 'r16', start: '2026-10-15T16:00:00Z', end: '2026-10-16T16:00:00Z', state: 'success' },
  { id: 'r15-inferred', start: '2026-10-14T16:00:00Z', end: '2026-10-15T16:00:00Z', state: 'success' },
  { id: 'r14-failed', start: '2026-10-13T16:00:00Z', end: '2026-10-14T16:00:00Z', state: 'failed' },
];
const FACT_TIS = [
  { task_id: 'wait', state: 'success', try_number: 1, operator: 'PythonSensor', pool: 'default_pool' },
  { task_id: 'agg', state: 'success', try_number: 1, operator: 'BashOperator', pool: 'demo-batch-pool' },
];
const LOG_LINES = [...Array.from({ length: 300 }, (_, i) => `line ${i}`), 'WORKCTL_SPARK_APP_ID=local-1'];
const POOL = { name: 'demo-batch-pool', slots: 2, occupied_slots: 1, running_slots: 1, queued_slots: 1, scheduled_slots: 0, deferred_slots: 0, open_slots: 1, description: 'p', include_deferred: false };
const TASKS_V1 = [
  { task_id: 'wait', operator_name: 'PythonSensor', pool: 'default_pool', downstream_task_ids: ['agg'], class_ref: { class_name: 'PythonSensor', module_path: 'airflow.sensors.python' }, retries: 0, retry_delay: { __type: 'TimeDelta', days: 0, seconds: 300, microseconds: 0 }, retry_exponential_backoff: false, trigger_rule: 'all_success', template_fields: [] },
  { task_id: 'agg', operator_name: 'BashOperator', pool: 'demo-batch-pool', downstream_task_ids: [], class_ref: { class_name: 'BashOperator', module_path: 'airflow.operators.bash' }, retries: 0, execution_timeout: { __type: 'TimeDelta', days: 0, seconds: 1800, microseconds: 0 }, retry_exponential_backoff: false, trigger_rule: 'all_success', template_fields: ['bash_command'] },
];
// Airflow 3 renders retry_exponential_backoff as a number
const TASKS_V2 = TASKS_V1.map((t) => ({ ...t, retry_exponential_backoff: 0.0, task_display_name: t.task_id }));

const DAG_V1 = {
  dag_id: DAG_ID, description: 'd', timezone: 'Asia/Shanghai', schedule_interval: { __type: 'CronExpression', value: '0 0 * * *' }, timetable_description: 'At 00:00',
  start_date: '2026-10-09T16:00:00+00:00', catchup: false, is_paused: false, is_active: true, has_import_errors: false, owners: ['team-data'], tags: [{ name: 'demo' }],
  max_active_runs: 3, max_active_tasks: 16, dag_run_timeout: { __type: 'TimeDelta', days: 0, seconds: 3600, microseconds: 0 },
  params: { fault: { __class: 'airflow.models.param.Param', value: null, description: 'f', schema: { type: ['null', 'string'] } } },
  file_token: 'tok', fileloc: '/x/demo_daily_orders.py', last_parsed_time: '2026-10-17T12:30:00+00:00',
  next_dagrun: '2026-10-16T16:00:00+00:00', next_dagrun_data_interval_start: '2026-10-16T16:00:00+00:00', next_dagrun_data_interval_end: '2026-10-17T16:00:00+00:00', next_dagrun_create_after: '2026-10-17T16:00:00+00:00',
};
const DAG_V2 = {
  dag_id: DAG_ID, dag_display_name: DAG_ID, description: 'd', timezone: 'Asia/Shanghai', timetable_summary: '0 0 * * *', timetable_description: 'At 00:00', timetable_periodic: true,
  start_date: '2026-10-09T16:00:00Z', catchup: false, is_paused: false, is_stale: false, has_import_errors: false, owners: ['team-data'], tags: [{ name: 'demo', dag_id: DAG_ID }],
  max_active_runs: 3, max_active_tasks: 16, dag_run_timeout: 'PT1H',
  params: { fault: { value: null, description: 'f', schema: { type: ['null', 'string'] }, source: null } },
  file_token: 'opaque-v2-token', fileloc: '/x/demo_daily_orders.py', last_parsed_time: '2026-10-17T12:30:00Z',
  next_dagrun_logical_date: '2026-10-16T16:00:00Z', next_dagrun_data_interval_start: '2026-10-16T16:00:00Z', next_dagrun_data_interval_end: '2026-10-17T16:00:00Z', next_dagrun_run_after: '2026-10-17T16:00:00Z',
  latest_dag_version: { version_number: 1 },
};
const runV1 = (r: (typeof FACT_RUNS)[number]) => ({
  dag_run_id: r.id, dag_id: DAG_ID, state: r.state, run_type: 'manual', external_trigger: true, logical_date: r.start, execution_date: r.start,
  data_interval_start: r.start, data_interval_end: r.end, queued_at: '2026-10-17T12:37:10+00:00', start_date: '2026-10-17T12:37:14+00:00',
  end_date: '2026-10-17T12:39:00+00:00', last_scheduling_decision: '2026-10-17T12:39:00+00:00', conf: {}, note: null,
});
const runV2 = (r: (typeof FACT_RUNS)[number]) => ({
  dag_run_id: r.id, dag_id: DAG_ID, state: r.state, run_type: 'manual', triggered_by: 'rest_api', triggering_user_name: 'admin', logical_date: r.start, run_after: '2026-10-17T12:37:10Z',
  data_interval_start: r.start, data_interval_end: r.end, queued_at: '2026-10-17T12:37:10Z', start_date: '2026-10-17T12:37:14Z',
  end_date: '2026-10-17T12:39:00Z', duration: 106, last_scheduling_decision: '2026-10-17T12:39:00Z', conf: {}, note: null, dag_versions: [{ version_number: 1 }],
});
const tiCommon = (t: (typeof FACT_TIS)[number]) => ({
  task_id: t.task_id, dag_id: DAG_ID, dag_run_id: 'r16', state: t.state, try_number: t.try_number, max_tries: 1, operator: t.operator, pool: t.pool, hostname: 'vm',
  queued_when: '2026-10-17T12:37:15Z', start_date: '2026-10-17T12:37:16Z', end_date: '2026-10-17T12:38:16Z', duration: 60, map_index: -1,
});
const tiV1 = (t: (typeof FACT_TIS)[number]) => ({ ...tiCommon(t), execution_date: '2026-10-15T16:00:00+00:00' });
const tiV2 = (t: (typeof FACT_TIS)[number]) => ({ ...tiCommon(t), id: `uuid-${t.task_id}`, logical_date: '2026-10-15T16:00:00Z', run_after: '2026-10-17T12:37:10Z', operator_name: t.operator, task_display_name: t.task_id });

// ---------------------------------------------------------------- fake servers
const JWT = (exp: number, n: number) => `${Buffer.from('{"alg":"HS512"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'admin', exp, n })).toString('base64url')}.sig`;
let v2State = { tokenCalls: 0, valid: '', strictViolations: [] as string[], posts: [] as any[] };

async function v1Server() {
  return fakeServer((req, url) => {
    if (!String(req.headers.authorization ?? '').startsWith('Basic ')) return { status: 401, json: { title: 'Unauthorized' } };
    const p = url.pathname.replace('/api/v1', '');
    if (p === '/version') return { json: { version: '2.10.5' } };
    if (p === `/dags/${DAG_ID}/details` || p === `/dags/${DAG_ID}`) return { json: DAG_V1 };
    if (p === `/dags`) return { json: { dags: [DAG_V1], total_entries: 1 } };
    if (p === `/dags/${DAG_ID}/tasks`) return { json: { tasks: TASKS_V1 } };
    if (p === `/dags/${DAG_ID}/tasks/agg`) return { json: TASKS_V1[1] };
    if (p === '/dagSources/tok') return { text: SRC };
    if (p === `/dags/${DAG_ID}/dagRuns`) {
      if (url.searchParams.get('state')) return { json: { dag_runs: [], total_entries: 0 } };
      return { json: { dag_runs: FACT_RUNS.map(runV1), total_entries: FACT_RUNS.length } };
    }
    const run = /^\/dags\/[^/]+\/dagRuns\/([^/]+)$/.exec(p);
    if (run) {
      const f = FACT_RUNS.find((x) => x.id === decodeURIComponent(run[1]));
      return f ? { json: runV1(f) } : undefined;
    }
    if (p === `/dags/${DAG_ID}/dagRuns/r16/taskInstances`) return { json: { task_instances: FACT_TIS.map(tiV1), total_entries: 2 } };
    if (p === `/dags/${DAG_ID}/dagRuns/r16/taskInstances/agg`) return { json: tiV1(FACT_TIS[1]) };
    if (p === `/dags/${DAG_ID}/dagRuns/r16/taskInstances/agg/xcomEntries/return_value`) return { json: { key: 'return_value', value: 'WORKCTL_SPARK_APP_ID=local-1' } };
    if (p === `/dags/${DAG_ID}/dagRuns/r16/taskInstances/agg/logs/1`) return { text: LOG_LINES.join('\n') + '\n' };
    if (p === '/pools/demo-batch-pool') return { json: POOL };
    return undefined;
  });
}

async function v2Server() {
  return fakeServer((req, url, body) => {
    if (url.pathname === '/auth/token' && req.method === 'POST') {
      v2State.tokenCalls++;
      const b = JSON.parse(body || '{}');
      if (b.username !== 'admin' || b.password !== 'fake-password') return { status: 401, json: { detail: 'Invalid credentials' } };
      v2State.valid = JWT(Math.floor(Date.now() / 1000) + 3600, v2State.tokenCalls);
      return { status: 201, json: { access_token: v2State.valid } };
    }
    if (!url.pathname.startsWith('/api/v2/')) return undefined;
    if (req.headers.authorization !== `Bearer ${v2State.valid}`) return { status: 401, json: { detail: 'Not authenticated' } };
    const p = url.pathname.replace('/api/v2', '');
    const qs = url.searchParams;
    for (const k of qs.keys()) if (/execution_date|only_active/.test(k) || /execution_date/.test(qs.get(k) ?? '')) v2State.strictViolations.push(`${p}?${k}`);
    if (p === '/version') return { json: { version: '3.3.2', git_version: 'x' } };
    if (p === `/dags/${DAG_ID}/details` || p === `/dags/${DAG_ID}`) return { json: DAG_V2 };
    if (p === `/dags`) return { json: { dags: [DAG_V2], total_entries: 1 } };
    if (p === `/dags/${DAG_ID}/tasks`) return { json: { tasks: TASKS_V2, total_entries: 2 } };
    if (p === `/dags/${DAG_ID}/tasks/agg`) return { json: TASKS_V2[1] };
    if (p === `/dagSources/${DAG_ID}`) return { json: { content: SRC, dag_id: DAG_ID, version_number: 1, dag_display_name: DAG_ID } };
    if (p === `/dags/${DAG_ID}/dagRuns` && req.method === 'POST') {
      const b = JSON.parse(body);
      v2State.posts.push({ path: p, body: b });
      if (!('logical_date' in b)) return { status: 422, json: { detail: [{ loc: ['body', 'logical_date'], msg: 'Field required' }] } };
      return { json: { ...runV2({ id: b.dag_run_id, start: b.data_interval_start, end: b.data_interval_end, state: 'queued' }), logical_date: b.logical_date } };
    }
    if (p === `/dags/${DAG_ID}/dagRuns`) {
      if (qs.get('state')) return { json: { dag_runs: [], total_entries: 0 } };
      const gte = qs.get('logical_date_gte');
      const lte = qs.get('logical_date_lte');
      const runs = FACT_RUNS.filter((r) => (!gte || Date.parse(r.start) >= Date.parse(gte)) && (!lte || Date.parse(r.start) <= Date.parse(lte)));
      return { json: { dag_runs: runs.map(runV2), total_entries: runs.length } };
    }
    if (p === `/dags/${DAG_ID}/clearTaskInstances` && req.method === 'POST') {
      const b = JSON.parse(body);
      v2State.posts.push({ path: p, body: b });
      return { json: { task_instances: [tiV2(FACT_TIS[1])], total_entries: 1 } };
    }
    const run = /^\/dags\/[^/]+\/dagRuns\/([^/]+)$/.exec(p);
    if (run) {
      const f = FACT_RUNS.find((x) => x.id === decodeURIComponent(run[1]));
      return f ? { json: runV2(f) } : undefined;
    }
    if (p === `/dags/${DAG_ID}/dagRuns/r16/taskInstances`) return { json: { task_instances: FACT_TIS.map(tiV2), total_entries: 2 } };
    if (p === `/dags/${DAG_ID}/dagRuns/r16/taskInstances/agg`) return { json: tiV2(FACT_TIS[1]) };
    if (p === `/dags/${DAG_ID}/dagRuns/r16/taskInstances/agg/xcomEntries/return_value`) return { json: { key: 'return_value', value: 'WORKCTL_SPARK_APP_ID=local-1', run_id: 'r16' } };
    if (p === `/dags/${DAG_ID}/dagRuns/r16/taskInstances/agg/logs/1`) {
      // Airflow 3 serves logs as JSON / NDJSON only
      if (String(req.headers.accept ?? '').includes('text/plain')) return { status: 406, json: { detail: 'Only application/json or application/x-ndjson is supported' } };
      return {
        json: {
          content: [
            { event: '::group::Log message source details' },
            ...LOG_LINES.map((l, i) => ({ timestamp: `2026-10-17T12:37:${String(i % 60).padStart(2, '0')}Z`, level: 'info', logger: 'airflow.task.hooks.subprocess', event: l })),
          ],
          continuation_token: null,
        },
      };
    }
    if (p === '/pools/demo-batch-pool') return { json: { ...POOL, team_name: null } };
    return undefined;
  });
}

function v2Config(url: string, allowExecute = false): { path: string; dir: string } {
  const c = tempConfig({ airflowUrl: url, allowExecute });
  writeFileSync(c.path, readFileSync(c.path, 'utf8').replace('api_version: v1', 'api_version: v2'));
  return c;
}

let s1: Awaited<ReturnType<typeof fakeServer>>;
let s2: Awaited<ReturnType<typeof fakeServer>>;
let c1: { path: string; dir: string };
let c2: { path: string; dir: string };
const r = new Registry();
r.addDomain(offline);
r.addDomain(compute);

beforeAll(async () => {
  s1 = await v1Server();
  s2 = await v2Server();
  c1 = tempConfig({ airflowUrl: s1.url, allowExecute: true });
  c2 = v2Config(s2.url, true);
});
afterAll(async () => {
  await s1.close();
  await s2.close();
});
beforeEach(() => {
  clearAirflowTokenCache();
  v2State = { tokenCalls: 0, valid: '', strictViolations: [], posts: [] };
});

const call = (cfg: { path: string }, cap: string, inputs: Record<string, unknown>) => invoke(r, cap, inputs, { configPath: cfg.path, timeoutMs: 10_000 });

/** Drop provenance / per-call values so v1 and v2 data can be compared for equality. */
function comparable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(comparable);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (['source', 'observed_at', 'plan_id', 'expires_at', 'file_token', 'basis', 'next', 'checked_at'].includes(k)) continue;
      out[k] = comparable(x);
    }
    return out;
  }
  return typeof v === 'string' ? v.replace(/\/api\/v[12]\//g, '/api/vN/').replace(/op-\d{8}-[0-9a-f]+/g, 'op-X') : v;
}

async function both(cap: string, inputs: Record<string, unknown>) {
  const a = await call(c1, cap, inputs);
  const b = await call(c2, cap, inputs);
  const def = r.get(cap)!;
  for (const [label, env] of [['v1', a], ['v2', b]] as const) {
    expect(env.status, `${label} ${cap}: ${JSON.stringify(env.error)}`).not.toBe('error');
    expect(def.output!.safeParse(env.data).success, `${label} ${cap} output schema`).toBe(true);
    expect(env.meta.warnings.filter((w) => w.includes('schema')), `${label} ${cap}`).toEqual([]);
  }
  return { v1: a, v2: b };
}

describe('airflow-rest-v2: same capability contract as v1', () => {
  it('workflow get: same data; sources carry adapter/version/route of the API actually called', async () => {
    const { v1, v2 } = await both('offline.workflow.get', { id: DAG_ID });
    expect(comparable(v2.data)).toEqual(comparable(v1.data));
    const d = v2.data as any;
    expect(d.schedule).toEqual({ type: 'CronExpression', value: '0 0 * * *', description: 'At 00:00' });
    expect(d.is_active).toBe(true);
    expect(d.dagrun_timeout_seconds).toBe(3600);
    expect(d.params.fault).toEqual({ default: null, description: 'f', schema: { type: ['null', 'string'] } });
    expect(d.next_run.create_after.local).toBe('2026-10-18T00:00:00+08:00');
    // same DAG file content -> same content hash, whichever API served it
    expect(d.code_version.source_sha256).toBe((v1.data as any).code_version.source_sha256);
    expect(v1.meta.sources[0]).toMatchObject({ adapter: 'airflow-rest-v1', version: '2.10.5', method: `GET /api/v1/dags/${DAG_ID}/details` });
    expect(v2.meta.sources[0]).toMatchObject({ adapter: 'airflow-rest-v2', version: '3.3.2', method: `GET /api/v2/dags/${DAG_ID}/details` });
    expect(v2.meta.sources.map((s) => s.method)).toContain('GET /api/v2/dagSources/{dag_id}');
    expect(v1.context.adapter).toBe(v2.context.adapter);
    expect(JSON.stringify(v2)).not.toContain('fake-password');
    expect(JSON.stringify(v2)).not.toContain(v2State.valid);
  });

  it('task get: retry_exponential_backoff number -> boolean, timedeltas unchanged', async () => {
    const { v1, v2 } = await both('offline.task.get', { workflow: DAG_ID, task: 'agg' });
    expect(v2.data).toEqual(v1.data);
    expect(v2.data).toMatchObject({ retry_exponential_backoff: false, execution_timeout_seconds: 1800, upstream_task_ids: ['wait'] });
  });

  it('run list: logical_date_* filters on v2, same matched runs and business dates', async () => {
    const { v1, v2 } = await both('offline.run.list', { workflow: DAG_ID, data_date: '2026-10-16', timezone: 'Asia/Shanghai' });
    const a = v1.data as any;
    const b = v2.data as any;
    expect(b.runs).toEqual(a.runs);
    expect(b.runs.map((x: any) => [x.run_id, x.match, x.business_date, x.external_trigger])).toEqual([['r16', 'exact', '2026-10-16', true]]);
    expect(Object.keys(a.mapping.query)).toContain('execution_date_gte');
    expect(Object.keys(b.mapping.query)).toContain('logical_date_gte');
    expect(b.mapping.query.logical_date_gte).toBe(a.mapping.query.execution_date_gte);
    expect(v2State.strictViolations).toEqual([]);
    expect(v2.meta.coverage?.scope).toBe(v1.meta.coverage?.scope);
  });

  it('run get: same layered states, task instances and findings', async () => {
    const { v1, v2 } = await both('offline.run.get', { workflow: DAG_ID, id: 'r16' });
    expect(comparable(v2.data)).toEqual(comparable(v1.data));
    const s = (v2.data as any).summary;
    expect(s.scheduler_state).toBe('success');
    expect(s.layers.compute.app_id).toBe('local-1');
    expect(s.layers.scheduler.source.adapter).toBe('airflow-rest-v2');
  });

  it('dependency list: same task edges and states', async () => {
    const { v1, v2 } = await both('offline.dependency.list', { workflow: DAG_ID, run_id: 'r16', direction: 'upstream' });
    expect(comparable(v2.data)).toEqual(comparable(v1.data));
    expect((v2.data as any).task_edges).toEqual([{ from: 'wait', to: 'agg', from_state: 'success', to_state: 'success', edge_source: 'scheduler-metadata' }]);
  });

  it('log get: structured JSON log -> text lines; same tail, truncation and spark ids', async () => {
    const { v1, v2 } = await both('offline.log.get', { workflow: DAG_ID, run_id: 'r16', task: 'agg', limit_lines: 50 });
    const a = v1.data as any;
    const b = v2.data as any;
    for (const k of ['try_number', 'task_state', 'returned_lines', 'truncated', 'spark_app_ids']) expect(b[k], k).toEqual(a[k]);
    expect(b.total_lines).toBe(a.total_lines + 1); // + "::group::" header line Airflow 3 adds
    expect(b.lines[b.lines.length - 1]).toMatch(/INFO airflow\.task\.hooks\.subprocess - WORKCTL_SPARK_APP_ID=local-1$/);
    expect(v2.meta.sources[0].method).toBe(`GET /api/v2/dags/${DAG_ID}/dagRuns/r16/taskInstances/agg/logs/1`);
  });

  it('compute queue get: same pool view; source records v2', async () => {
    const { v1, v2 } = await both('compute.queue.get', { id: 'demo-batch-pool' });
    expect(v2.data).toEqual(v1.data);
    expect(v2.meta.sources[0]).toMatchObject({ system: 'airflow', adapter: 'airflow-rest-v2', method: 'GET /api/v2/pools/demo-batch-pool', version: '3.3.2' });
  });

  it('backfill plan: same targets, actions and preconditions; steps name the v2 routes', async () => {
    const { v1, v2 } = await both('offline.backfill.plan', { workflow: DAG_ID, from: '2026-10-14', to: '2026-10-16', timezone: 'Asia/Shanghai' });
    const a = v1.data as any;
    const b = v2.data as any;
    expect(comparable(b.targets)).toEqual(comparable(a.targets));
    expect(b.targets.map((t: any) => t.action)).toEqual(a.targets.map((t: any) => t.action));
    expect(b.preconditions).toEqual(a.preconditions);
    expect(comparable(b.steps)).toEqual(comparable(a.steps));
    expect(JSON.stringify(b.steps)).toContain('/api/v2/');
    expect(JSON.stringify(b.steps)).not.toContain('/api/v1/');
  });

  it('token: one POST /auth/token per process, refreshed once after a 401', async () => {
    await call(c2, 'compute.queue.get', { id: 'demo-batch-pool' });
    await call(c2, 'offline.task.get', { workflow: DAG_ID, task: 'agg' });
    expect(v2State.tokenCalls).toBe(1);
    v2State.valid = 'revoked-by-server';
    const env = await call(c2, 'compute.queue.get', { id: 'demo-batch-pool' });
    expect(env.status).toBe('success');
    expect(v2State.tokenCalls).toBe(2);
  });

  it('wrong password -> UNAUTHENTICATED without leaking credentials; unknown api_version -> UNSUPPORTED', async () => {
    const bad = v2Config(s2.url);
    writeFileSync(`${bad.dir}/secrets/airflow`, 'wrong-password');
    const env = await call(bad, 'offline.workflow.get', { id: DAG_ID });
    expect(env.error?.code).toBe('UNAUTHENTICATED');
    expect(JSON.stringify(env)).not.toContain('wrong-password');
    const v3 = v2Config(s2.url);
    writeFileSync(v3.path, readFileSync(v3.path, 'utf8').replace('api_version: v2', 'api_version: v3'));
    expect((await call(v3, 'offline.workflow.get', { id: DAG_ID })).error?.code).toBe('UNSUPPORTED');
  });

  it('not found stays NOT_FOUND on v2', async () => {
    const env = await call(c2, 'offline.run.get', { workflow: DAG_ID, id: 'nope' });
    expect(env.error?.code).toBe('NOT_FOUND');
  });
});

describe('airflow-rest-v2: backfill executor', () => {
  function makePlan(c: Ctx, targets: any[]) {
    const draft: PlanDraft = {
      kind: 'offline.backfill',
      title: 't',
      params: { workflow: DAG_ID, from: targets[0].business_date, to: targets[targets.length - 1].business_date, timezone: 'Asia/Shanghai', rerun_succeeded: false, max_active_runs: 2, airflow_endpoint: 'a' },
      targets,
      impact: {},
      preconditions: [{ check: 'has_actions', ok: true }],
      steps: [],
      idempotent: true,
      cancellable: false,
    };
    const plan = c.plans().create(draft, { profile: 't', env: 'test', executable: true });
    c.plans().transition(plan.id, 'running', 'test');
    return c.plans().get(plan.id);
  }
  const target = (d: string, action: string, runId: string | null) => {
    const start = new Date(Date.parse(`${d}T00:00:00+08:00`)).toISOString();
    const end = new Date(Date.parse(`${d}T00:00:00+08:00`) + 86_400_000).toISOString();
    return { business_date: d, data_interval: { start_local: `${d}T00:00:00+08:00`, end_local: '', start_utc: start, end_utc: end }, existing_runs: [], action, run_id: runId, reason: 't', target_partition: null, partition_state: 'unknown', upstream_inputs: [], not_due: false };
  };

  it('trigger sends logical_date + explicit data interval; clear uses clearTaskInstances', async () => {
    const c = new Ctx({ registry: r, loaded: loadConfig(c2.path), profileName: 't', requestId: 'req-v2', timeoutMs: 10_000 });
    const res: any = await backfillExecutor(c, makePlan(c, [target('2026-10-12', 'trigger_new', null), target('2026-10-14', 'clear_failed', 'r14-failed')]), () => undefined);
    const trig = v2State.posts.find((x) => x.path.endsWith('/dagRuns'));
    expect(trig?.body).toMatchObject({ logical_date: '2026-10-11T16:00:00.000Z', data_interval_start: '2026-10-11T16:00:00.000Z', data_interval_end: '2026-10-12T16:00:00.000Z' });
    const clear = v2State.posts.find((x) => x.path.endsWith('/clearTaskInstances'));
    expect(clear?.body).toMatchObject({ dag_run_id: 'r14-failed', only_failed: true, dry_run: false });
    expect(res.submitted.map((s: any) => s.action)).toEqual(['trigger_new', 'clear_failed']);
    expect(v2State.strictViolations).toEqual([]);
  });
});

describe('airflow-v2 normalisation helpers', () => {
  it('routes and methods', () => {
    expect(toV2Route('/dags', { only_active: true, limit: 5 }).query).toEqual({ exclude_stale: true, limit: 5 });
    expect(toV2Route('/dags/x/dagRuns', { execution_date_gte: 'a', order_by: '-execution_date' }).query).toEqual({ logical_date_gte: 'a', order_by: '-logical_date' });
    expect(toV2Method('GET /api/v1/dagSources/{file_token}')).toBe('GET /api/v2/dagSources/{dag_id}');
  });
  it('durations, logs and run fields', () => {
    expect(isoDurationToTimedelta('PT1800S')).toEqual({ __type: 'TimeDelta', days: 0, seconds: 1800, microseconds: 0 });
    expect(isoDurationToTimedelta('P1DT2H0.5S')).toEqual({ __type: 'TimeDelta', days: 1, seconds: 7200, microseconds: 500000 });
    expect(structuredLogToText({ content: [{ event: 'a\nb', level: 'error', timestamp: 't', logger: 'l' }, 'plain'] })).toBe('[t] ERROR l - a\nb\nplain\n');
    const run = normalizeV2('/dags/d/dagRuns/x', { dag_run_id: 'x', logical_date: null, run_type: 'scheduled', triggered_by: 'timetable' }) as any;
    expect(run).toMatchObject({ execution_date: null, external_trigger: false });
    const xcom = normalizeV2('/dags/d/dagRuns/x/taskInstances/t/xcomEntries/return_value', { value: { a: 1 } }) as any;
    expect(xcom.value).toBe('{"a":1}');
  });
});
