/**
 * Regression tests for the cross-review fixes in the offline domain:
 * backfill executor safety (live re-validation, concurrency, no-op clears, 409, partial
 * results), append write-mode safety, and the enriched quality layer of `offline run get`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config';
import type { PlanDraft } from '../../src/core/operations';
import { Registry } from '../../src/core/registry';
import { Ctx } from '../../src/core/runtime';
import offline from '../../src/domains/offline';
import { backfillExecutor, writeModeCheck } from '../../src/domains/offline/backfill';
import { qualityLayer, qualityStaleness } from '../../src/domains/offline/runs';
import { writeQualityResult } from '../../src/domains/data/quality';
import { fakeServer, tempConfig } from './fake';

const DAG_ID = 'demo-daily-orders';
const iv = (d: string) => {
  const start = new Date(Date.parse(`${d}T00:00:00+08:00`)).toISOString();
  const end = new Date(Date.parse(`${d}T00:00:00+08:00`) + 86_400_000).toISOString();
  return { start, end };
};
const run = (id: string, d: string, state: string) => ({ dag_run_id: id, state, run_type: 'manual', logical_date: iv(d).start, execution_date: iv(d).start, data_interval_start: iv(d).start, data_interval_end: iv(d).end, conf: {} });

// mutable fake Airflow state
let runs: any[] = [];
let activeCount = 0;
let clearResponse: any = { task_instances: [{ task_id: 'agg' }] };
let triggerStatus: number | ((body: any) => { status: number; json: unknown }) = 200;
const posts: string[] = [];

let srv: Awaited<ReturnType<typeof fakeServer>>;
let cfg: { path: string; dir: string };
const registry = new Registry();
registry.addDomain(offline);

beforeAll(async () => {
  srv = await fakeServer((req, url, body) => {
    const p = url.pathname.replace('/api/v1', '');
    if (p === '/version') return { json: { version: '2.10.5' } };
    if (p === `/dags/${DAG_ID}/dagRuns` && req.method === 'GET') {
      if (url.searchParams.get('state')) return { json: { dag_runs: [], total_entries: url.searchParams.get('state') === 'running' ? activeCount : 0 } };
      return { json: { dag_runs: runs, total_entries: runs.length } };
    }
    if (p === `/dags/${DAG_ID}/dagRuns` && req.method === 'POST') {
      posts.push(`trigger ${JSON.parse(body).logical_date}`);
      if (typeof triggerStatus === 'function') return triggerStatus(JSON.parse(body));
      if (triggerStatus !== 200) return { status: triggerStatus, json: { title: 'conflict' } };
      const b = JSON.parse(body);
      return { json: { dag_run_id: b.dag_run_id, state: 'queued', logical_date: b.logical_date } };
    }
    if (p === `/dags/${DAG_ID}/clearTaskInstances`) {
      posts.push(`clear ${JSON.parse(body).dag_run_id}`);
      return { json: clearResponse };
    }
    const m = /^\/dags\/demo-daily-orders\/dagRuns\/([^/]+)$/.exec(p);
    if (m) {
      const r = runs.find((x) => x.dag_run_id === decodeURIComponent(m[1]));
      return r ? { json: r } : undefined;
    }
    return undefined;
  });
  cfg = tempConfig({ airflowUrl: srv.url, allowExecute: true });
});
afterAll(async () => srv.close());
beforeEach(() => {
  runs = [];
  activeCount = 0;
  clearResponse = { task_instances: [{ task_id: 'agg' }] };
  triggerStatus = 200;
  posts.length = 0;
});

function ctx(timeoutMs = 10_000): Ctx {
  return new Ctx({ registry, loaded: loadConfig(cfg.path), profileName: 't', requestId: 'req-test', timeoutMs });
}

function target(d: string, action: string, runId: string | null) {
  return {
    business_date: d,
    data_interval: { start_local: `${d}T00:00:00+08:00`, end_local: '', start_utc: iv(d).start, end_utc: iv(d).end },
    existing_runs: [],
    action,
    run_id: runId,
    reason: 'test',
    target_partition: null,
    partition_state: 'unknown',
    upstream_inputs: [],
    not_due: false,
  };
}

function makePlan(c: Ctx, targets: any[], maxActive = 2) {
  const draft: PlanDraft = {
    kind: 'offline.backfill',
    title: 't',
    params: { workflow: DAG_ID, from: targets[0].business_date, to: targets[targets.length - 1].business_date, timezone: 'Asia/Shanghai', rerun_succeeded: false, max_active_runs: maxActive, airflow_endpoint: 'a' },
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

describe('backfill executor re-validates live state', () => {
  it('does not clear a failed run when the date has since succeeded (another run)', async () => {
    runs = [run('old-failed', '2026-10-14', 'failed'), run('manual-ok', '2026-10-14', 'success')];
    const c = ctx();
    const res: any = await backfillExecutor(c, makePlan(c, [target('2026-10-14', 'clear_failed', 'old-failed')]), () => undefined);
    expect(res.submitted).toEqual([]);
    expect(res.skipped[0].reason).toMatch(/skip_succeeded/);
    expect(posts).toEqual([]);
  });

  it('does not trigger when a run for the date is now in progress', async () => {
    runs = [run('someone-else', '2026-10-14', 'running')];
    const c = ctx();
    const res: any = await backfillExecutor(c, makePlan(c, [target('2026-10-14', 'trigger_new', null)]), () => undefined);
    expect(res.submitted).toEqual([]);
    expect(res.skipped[0].reason).toMatch(/skip_in_progress/);
    expect(posts).toEqual([]);
  });

  it('counts running runs of the DAG that it did not submit against the concurrency budget', async () => {
    activeCount = 2; // e.g. scheduled runs already running
    const c = ctx(10_000); // budget too small to wait for a slot
    const res: any = await backfillExecutor(c, makePlan(c, [target('2026-10-14', 'trigger_new', null)], 2), () => undefined);
    expect(res.submitted).toEqual([]);
    expect(res.not_submitted).toHaveLength(1);
    expect(posts).toEqual([]);
  });

  it('a clear that resets no task instance is reported as skipped, not submitted', async () => {
    runs = [run('timed-out', '2026-10-14', 'failed')];
    clearResponse = { task_instances: [] };
    const c = ctx();
    const res: any = await backfillExecutor(c, makePlan(c, [target('2026-10-14', 'clear_failed', 'timed-out')]), () => undefined);
    expect(res.submitted).toEqual([]);
    expect(res.skipped[0].reason).toMatch(/没有可清理/);
  });

  it('treats 409 from Airflow as "already exists" and continues', async () => {
    triggerStatus = 409;
    const c = ctx();
    const res: any = await backfillExecutor(c, makePlan(c, [target('2026-10-14', 'trigger_new', null), target('2026-10-15', 'trigger_new', null)]), () => undefined);
    expect(res.submitted).toEqual([]);
    expect(res.skipped).toHaveLength(2);
  });

  it('keeps already-submitted runs on the plan when a later submission fails', async () => {
    triggerStatus = (b: any) => (b.logical_date === iv('2026-10-15').start ? { status: 500, json: { title: 'boom' } } : { status: 200, json: { dag_run_id: b.dag_run_id, state: 'queued', logical_date: b.logical_date } });
    const c = ctx();
    const plan = makePlan(c, [target('2026-10-14', 'trigger_new', null), target('2026-10-15', 'trigger_new', null)], 3);
    await expect(backfillExecutor(c, plan, () => undefined)).rejects.toThrow();
    const stored: any = c.plans().get(plan.id).result;
    expect(stored.partial).toBe(true);
    expect(stored.submitted.map((s: any) => s.business_date)).toEqual(['2026-10-14']);
    expect(stored.not_submitted[0].business_date).toBe('2026-10-15');
  });
});

describe('append write-mode safety', () => {
  it('only treats positively missing partitions as safe to append to', () => {
    expect(writeModeCheck('append', [{ action: 'trigger_new', partition_state: 'missing' }], false).ok).toBe(true);
    expect(writeModeCheck('append', [{ action: 'trigger_new', partition_state: 'unknown' }], false).ok).toBe(false);
    expect(writeModeCheck('append', [{ action: 'clear_failed', partition_state: 'unreadable' }], false).ok).toBe(false);
    expect(writeModeCheck('append', [{ action: 'clear_failed', partition_state: 'unknown' }], true).ok).toBe(true);
  });
});

describe('quality layer in offline run get', () => {
  const table = 'analytics.daily_orders';
  const partition = 'dt=2026-10-16';
  const stored = (checkedAt: string, extra: Record<string, unknown> = {}) => ({
    dataset: { input: table, catalog: 'demo', table, method: 'file' },
    partition,
    ruleset: { name: 'daily_orders', file: 'x.yaml', rules: 3 },
    quality_state: 'fail',
    conclusive: true,
    precondition: { ok: true, partition_state: 'present', path: '/w/x' },
    summary: { total: 8, pass: 1, fail: 6, error: 0, skipped: 1, warn_failures: 0 },
    results: [
      { id: 'partition_exists', type: 'partition_exists', severity: 'error', implicit: true, status: 'pass', evaluated_on: 'filesystem', conclusive: true, message: 'ok' },
      ...Array.from({ length: 6 }, (_, k) => ({ id: `r${k}`, type: 'not_null', severity: 'error', implicit: false, status: 'fail', evaluated_on: 'full', conclusive: true, message: `rule ${k} failed` })),
      { id: 'fresh', type: 'freshness', severity: 'warn', implicit: false, status: 'skipped', evaluated_on: 'none', conclusive: true, message: '没有记录' },
    ],
    scan: { mode: 'full', rows_read: 1, rows_total: 1, files_read: 1, files_total: 1, parse_errors: 0 },
    checked_at: checkedAt,
    persisted_to: null,
    stored_schema_version: '1',
    request_id: 'r',
    profile: 't',
    sources: [],
    coverage: null,
    ...extra,
  });

  it('reports partition, checked_at, failed rules (max 5) and freshness vs the partition', async () => {
    const c = ctx();
    writeQualityResult(c.stateDir, table, partition, stored('2026-10-17T01:00:00.000Z') as any);
    const l: any = await qualityLayer(c, table, partition, { partitionState: 'present', partitionUpdatedAt: '2026-10-17T02:00:00.000Z' });
    expect(l).toMatchObject({ state: 'fail', table, partition, checked_at: '2026-10-17T01:00:00.000Z', stale: true, failed_rules_truncated: 1 });
    expect(l.failed_rules).toHaveLength(5);
    expect(l.failed_rules[0]).toMatchObject({ rule: 'r0', type: 'not_null', message: 'rule 0 failed' });
    expect(l.skipped_reason).toMatch(/1 条规则被跳过/);
    const fresh: any = await qualityLayer(c, table, partition, { partitionState: 'present', partitionUpdatedAt: '2026-10-17T00:30:00.000Z' });
    expect(fresh.stale).toBe(false);
  });

  it('explains skipped rules when the partition was missing, and flags checks older than the run end', async () => {
    const c = ctx();
    writeQualityResult(c.stateDir, table, 'dt=2026-10-15', {
      ...stored('2026-10-16T01:00:00.000Z'),
      partition: 'dt=2026-10-15',
      precondition: { ok: false, partition_state: 'missing', path: '/w/y', reason: '分区目录不存在' },
      results: [{ id: 'rows', type: 'row_count_min', severity: 'error', implicit: false, status: 'skipped', evaluated_on: 'none', conclusive: true, message: '前置条件不满足：分区目录不存在' }],
    } as any);
    const l: any = await qualityLayer(c, table, 'dt=2026-10-15', { partitionState: 'missing', runEndDate: '2026-10-17T00:00:00+00:00' });
    expect(l.failed_rules).toEqual([]);
    expect(l.skipped_reason).toMatch(/前置条件不满足（分区 missing/);
    expect(l.stale).toBe(true);
  });

  it('staleness is null when there is no basis for comparison', () => {
    expect(qualityStaleness('2026-10-17T00:00:00Z', { partitionState: 'present' }).stale).toBeNull();
    expect(qualityStaleness(undefined, { partitionState: 'present', partitionUpdatedAt: '2026-10-17T00:00:00Z' }).stale).toBeNull();
  });
});

describe('business-date run lookup window', () => {
  it('finds a manual run triggered during D+1 whose inferred interval is day D', async () => {
    const { runsForBusinessDate } = await import('../../src/domains/offline/runs');
    const { businessInterval } = await import('../../src/domains/offline/time');
    const day = businessInterval('2026-10-15', 'Asia/Shanghai');
    // triggered 2026-10-16 10:00 +08:00, Airflow inferred the previous complete interval (day 15)
    const manual = { dag_run_id: 'manual__2026-10-16T02:00:00+00:00', state: 'success', logical_date: '2026-10-16T02:00:00+00:00', data_interval_start: day.start_utc, data_interval_end: day.end_utc };
    let q: any;
    const fakeAf: any = {
      get: async (_p: string, query: any) => {
        q = query;
        const lte = Date.parse(query.execution_date_lte);
        const gte = Date.parse(query.execution_date_gte);
        const inWindow = [manual].filter((r) => Date.parse(r.logical_date) <= lte && Date.parse(r.logical_date) >= gte);
        return { dag_runs: inWindow, total_entries: inWindow.length };
      },
    };
    const r = await runsForBusinessDate(fakeAf, DAG_ID, day);
    expect(Date.parse(q.execution_date_lte)).toBeGreaterThanOrEqual(Date.parse(manual.logical_date));
    expect(r.matched.map((m) => m.run.dag_run_id)).toEqual([manual.dag_run_id]);
    expect(r.matched[0].match).toBe('exact');
  });
});
