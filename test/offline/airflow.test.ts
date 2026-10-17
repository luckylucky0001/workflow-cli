import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Registry } from '../../src/core/registry';
import { invoke } from '../../src/core/engine';
import offline from '../../src/domains/offline';
import compute from '../../src/domains/compute';
import { fakeServer, tempConfig } from './fake';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';

const DAG = {
  dag_id: 'demo-daily-orders',
  description: 'd',
  timezone: 'Asia/Shanghai',
  schedule_interval: { __type: 'CronExpression', value: '@daily' },
  timetable_description: 'At 00:00',
  start_date: '2026-10-09T16:00:00+00:00',
  catchup: false,
  is_paused: false,
  is_active: true,
  has_import_errors: false,
  owners: ['team-data'],
  tags: [{ name: 'demo' }],
  max_active_runs: 3,
  max_active_tasks: 16,
  dag_run_timeout: null,
  params: { fault: { __class: 'airflow.models.param.Param', value: null, description: 'f', schema: { type: ['null', 'string'] } } },
  file_token: 'tok',
  fileloc: '/x/demo_daily_orders.py',
  last_parsed_time: '2026-10-17T12:30:00+00:00',
  next_dagrun: '2026-10-16T16:00:00+00:00',
  next_dagrun_data_interval_start: '2026-10-16T16:00:00+00:00',
  next_dagrun_data_interval_end: '2026-10-17T16:00:00+00:00',
  next_dagrun_create_after: '2026-10-17T16:00:00+00:00',
};
const RUN = (id: string, start: string, end: string, state = 'success') => ({
  dag_run_id: id, dag_id: 'demo-daily-orders', state, run_type: 'manual', external_trigger: true,
  logical_date: start, execution_date: start, data_interval_start: start, data_interval_end: end,
  start_date: '2026-10-17T12:37:14+00:00', end_date: state === 'success' ? '2026-10-17T12:39:00+00:00' : null, conf: {}, note: null,
});
const RUNS = [
  RUN('r16', '2026-10-15T16:00:00+00:00', '2026-10-16T16:00:00+00:00'),
  // manual run at D 00:00 without explicit interval: Airflow inferred the previous day
  RUN('r15-inferred', '2026-10-14T16:00:00+00:00', '2026-10-15T16:00:00+00:00'),
];
const TASKS = [
  { task_id: 'wait', operator_name: 'PythonSensor', pool: 'default_pool', downstream_task_ids: ['agg'], class_ref: { class_name: 'PythonSensor', module_path: 'airflow.sensors.python' }, retries: 0, retry_delay: { __type: 'TimeDelta', days: 0, seconds: 300, microseconds: 0 }, trigger_rule: 'all_success', template_fields: [] },
  { task_id: 'agg', operator_name: 'BashOperator', pool: 'demo-batch-pool', downstream_task_ids: [], class_ref: { class_name: 'BashOperator', module_path: 'airflow.operators.bash' }, retries: 0, execution_timeout: { __type: 'TimeDelta', days: 0, seconds: 1800, microseconds: 0 }, trigger_rule: 'all_success', template_fields: ['bash_command'] },
];

let srv: Awaited<ReturnType<typeof fakeServer>>;
let cfg: { path: string };
let badAuth = false;
const r = new Registry();
r.addDomain(offline);
r.addDomain(compute);

beforeAll(async () => {
  srv = await fakeServer((req, url) => {
    if (badAuth) return { status: 401, json: { title: 'Unauthorized' } };
    const p = url.pathname.replace('/api/v1', '');
    if (p === '/version') return { json: { version: '2.10.5' } };
    if (p === '/dags/demo-daily-orders/details') return { json: DAG };
    if (p === '/dags/demo-daily-orders/tasks') return { json: { tasks: TASKS } };
    if (p === '/dags/demo-daily-orders/tasks/agg') return { json: TASKS[1] };
    if (p === '/dagSources/tok') return { text: 'dag source' };
    if (p === '/dags/demo-daily-orders/dagRuns') return { json: { dag_runs: RUNS, total_entries: RUNS.length } };
    if (p === '/dags/demo-daily-orders/dagRuns/r16/taskInstances/agg') return { json: { task_id: 'agg', state: 'success', try_number: 1 } };
    if (p === '/dags/demo-daily-orders/dagRuns/r16') return { json: RUNS[0] };
    if (p === '/dags/demo-daily-orders/dagRuns/r16/taskInstances/agg/logs/1') {
      return { text: Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n') + '\nWORKCTL_SPARK_APP_ID=local-1\n' };
    }
    if (p === '/pools/demo-batch-pool') return { json: { name: 'demo-batch-pool', slots: 2, occupied_slots: 1, running_slots: 1, queued_slots: 1, scheduled_slots: 0, deferred_slots: 0, open_slots: 1, description: 'p', include_deferred: false } };
    return undefined;
  });
  cfg = tempConfig({ airflowUrl: srv.url });
});
afterAll(async () => srv.close());

const call = (cap: string, inputs: Record<string, unknown>) => invoke(r, cap, inputs, { configPath: cfg.path, timeoutMs: 10_000 });

describe('offline domain against a fake Airflow REST API', () => {
  it('run list maps the business date to data intervals, not logical dates', async () => {
    const env = await call('offline.run.list', { workflow: 'demo-daily-orders', data_date: '2026-10-16', timezone: 'Asia/Shanghai' });
    expect(env.status).toBe('success');
    expect(env.meta.warnings).toEqual([]);
    const d = env.data as any;
    expect(d.runs.map((x: any) => x.run_id)).toEqual(['r16']);
    expect(d.runs[0].match).toBe('exact');
    expect(d.runs[0].data_interval.start.local).toBe('2026-10-16T00:00:00+08:00');
    expect(d.mapping.business_interval.start_utc).toBe('2026-10-15T16:00:00.000Z');
    expect(env.meta.sources[0]).toMatchObject({ system: 'airflow', version: '2.10.5', method: 'GET /api/v1/dags/demo-daily-orders/dagRuns' });
  });

  it('run list returns success + empty + note when nothing matches', async () => {
    const env = await call('offline.run.list', { workflow: 'demo-daily-orders', data_date: '2026-10-10' });
    expect(env.status).toBe('success');
    expect((env.data as any).runs).toEqual([]);
    expect((env.data as any).notes[0]).toMatch(/没有 data_interval/);
  });

  it('workflow get reports schedule, params and a content-based code version', async () => {
    const env = await call('offline.workflow.get', { id: 'demo-daily-orders' });
    expect(env.status).toBe('success');
    expect(env.meta.warnings).toEqual([]);
    const d = env.data as any;
    expect(d.schedule.value).toBe('@daily');
    expect(d.params.fault.default).toBeNull();
    expect(d.code_version.source_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(d.tasks).toHaveLength(2);
    expect(JSON.stringify(env)).not.toContain('fake-password');
  });

  it('task get derives upstream ids and timeouts', async () => {
    const env = await call('offline.task.get', { workflow: 'demo-daily-orders', task: 'agg' });
    expect(env.meta.warnings).toEqual([]);
    expect(env.data).toMatchObject({ upstream_task_ids: ['wait'], pool: 'demo-batch-pool', execution_timeout_seconds: 1800 });
  });

  it('log get tails and flags truncation', async () => {
    const env = await call('offline.log.get', { workflow: 'demo-daily-orders', run_id: 'r16', task: 'agg', limit_lines: 50 });
    expect(env.meta.warnings).toEqual([]);
    const d = env.data as any;
    expect(d.returned_lines).toBe(50);
    expect(d.truncated).toBe(true);
    expect(d.spark_app_ids).toEqual(['local-1']);
  });

  it('compute queue get reads the Airflow pool', async () => {
    const env = await call('compute.queue.get', { id: 'demo-batch-pool' });
    expect(env.meta.warnings).toEqual([]);
    expect(env.data).toMatchObject({ slots: 2, occupied_slots: 1, waiting_slots: 1, utilization: 0.5 });
  });

  it('maps 404 and 401 to stable error codes', async () => {
    const nf = await call('offline.workflow.get', { id: 'nope' });
    expect(nf.error?.code).toBe('NOT_FOUND');
    badAuth = true;
    try {
      const ua = await call('offline.workflow.get', { id: 'demo-daily-orders' });
      expect(ua.error?.code).toBe('UNAUTHENTICATED');
      expect(JSON.stringify(ua)).not.toContain('fake-password');
    } finally {
      badAuth = false;
    }
  });

  it('rejects invalid dates', async () => {
    const env = await call('offline.run.list', { workflow: 'demo-daily-orders', data_date: '2026-13-01' });
    expect(env.error?.code).toBe('INVALID_ARGUMENT');
  });
});
