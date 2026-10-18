/**
 * Fix pass: Airflow task log reads are capped (tail kept, truncation reported) and masked;
 * run list and run get use one business-timezone rule (DAG timezone before the endpoint
 * default); backfill plans report the data interval a clear/rerun actually recomputes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { Registry } from '../../src/core/registry';
import offline, { LOG_MAX_BYTES } from '../../src/domains/offline';
import { businessTimeZone } from '../../src/domains/offline/runs';
import { fakeServer, tempConfig } from './fake';

const DAG_ID = 'wf';
let dagTz = 'UTC';
let runs: any[] = [];
let logText = '';
let srv: Awaited<ReturnType<typeof fakeServer>>;
let cfg: { path: string; dir: string };
const registry = new Registry();
registry.addDomain(offline);

beforeAll(async () => {
  srv = await fakeServer((req, url) => {
    const p = url.pathname.replace('/api/v1', '');
    if (p === '/version') return { json: { version: '2.10.5' } };
    if (p === `/dags/${DAG_ID}/details` || p === `/dags/${DAG_ID}`) {
      return { json: { dag_id: DAG_ID, is_paused: false, is_active: true, has_import_errors: false, owners: ['x'], max_active_runs: 3, timezone: dagTz } };
    }
    if (p === `/dags/${DAG_ID}/dagRuns` && req.method === 'GET') {
      if (url.searchParams.get('state')) return { json: { dag_runs: [], total_entries: 0 } };
      return { json: { dag_runs: runs, total_entries: runs.length } };
    }
    if (p === `/dags/${DAG_ID}/tasks`) return { json: { tasks: [] } };
    let m = /^\/dags\/wf\/dagRuns\/([^/]+)$/.exec(p);
    if (m) {
      const r = runs.find((x) => x.dag_run_id === decodeURIComponent(m![1]));
      return r ? { json: r } : undefined;
    }
    if (/^\/dags\/wf\/dagRuns\/[^/]+\/taskInstances$/.test(p)) return { json: { task_instances: [], total_entries: 0 } };
    if ((m = /^\/dags\/wf\/dagRuns\/[^/]+\/taskInstances\/t$/.exec(p))) return { json: { task_id: 't', state: 'success', try_number: 1 } };
    if (/^\/dags\/wf\/dagRuns\/[^/]+\/taskInstances\/t\/logs\/1$/.test(p)) return { text: logText };
    return undefined;
  });
  cfg = tempConfig({ airflowUrl: srv.url }); // endpoint timezone: Asia/Shanghai
});
afterAll(async () => srv.close());
beforeEach(() => {
  dagTz = 'UTC';
  runs = [];
  logText = '';
});

const call = (cap: string, inp: Record<string, unknown>) => invoke(registry, cap, inp, { configPath: cfg.path, timeoutMs: 15_000 });
const mkRun = (id: string, start: string, end: string, state = 'success') => ({ dag_run_id: id, state, run_type: 'scheduled', logical_date: start, execution_date: start, data_interval_start: start, data_interval_end: end, conf: {} });

describe('offline log get: size cap and credential masking', () => {
  it('masks credentials in Airflow task log lines and counts them', async () => {
    logText = ['start', 'connecting jdbc:postgresql://etl:s3cr3t@db:5432/w', 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz"', 'spark.conf password=hunter2', 'done'].join('\n') + '\n';
    runs = [mkRun('r1', '2026-10-16T00:00:00Z', '2026-10-17T00:00:00Z')];
    const env = await call('offline.log.get', { workflow: DAG_ID, run_id: 'r1', task: 't' });
    expect(env.status).toBe('success');
    const d = env.data as any;
    const all = d.lines.join('\n');
    expect(all).not.toMatch(/s3cr3t|hunter2|abcdefghijklmnop/);
    expect(all).toMatch(/etl:\*\*\*@db/);
    expect(d.credentials_masked).toBe(3);
    expect(d.total_lines).toBe(5);
    expect(env.meta.coverage?.notes?.join(' ')).toMatch(/3 行含凭据/);
  });

  it('keeps only the tail of a log larger than the read cap and reports truncation', async () => {
    const line = `${'x'.repeat(90)} token=abc123\n`; // 104 bytes
    const n = Math.ceil((LOG_MAX_BYTES * 1.5) / line.length);
    logText = line.repeat(n) + 'WORKCTL_SPARK_APP_ID=local-42\nlast line\n';
    runs = [mkRun('r1', '2026-10-16T00:00:00Z', '2026-10-17T00:00:00Z')];
    const env = await call('offline.log.get', { workflow: DAG_ID, run_id: 'r1', task: 't', limit_lines: 5 });
    expect(env.status).toBe('success');
    const d = env.data as any;
    expect(d.truncated).toBe(true);
    expect(d.total_lines).toBeNull();
    expect(d.bytes).toBe(Buffer.byteLength(logText));
    expect(d.lines.slice(-2)).toEqual(['WORKCTL_SPARK_APP_ID=local-42', 'last line']);
    expect(d.lines[0]).toMatch(/^x+ token=\*\*\*$/);
    expect(d.spark_app_ids).toEqual(['local-42']);
    expect(env.meta.coverage).toMatchObject({ complete: false, truncated: true });
    expect(env.meta.coverage?.notes?.join(' ')).toMatch(/超过读取上限/);
  });
});

describe('business timezone: run list and run get agree', () => {
  it('businessTimeZone: --timezone > DAG timezone > endpoint default', () => {
    expect(businessTimeZone({ timezone: 'UTC' }, 'Asia/Shanghai')).toBe('UTC');
    expect(businessTimeZone({ timezone: "Timezone('Europe/Berlin')" }, 'Asia/Shanghai')).toBe('Europe/Berlin');
    expect(businessTimeZone({}, 'Asia/Shanghai')).toBe('Asia/Shanghai');
    expect(businessTimeZone({ timezone: 'not/a-zone' }, 'Asia/Shanghai')).toBe('Asia/Shanghai');
    expect(businessTimeZone({ timezone: 'UTC' }, 'Asia/Shanghai', 'America/New_York')).toBe('America/New_York');
  });

  it('a UTC DAG on an Asia/Shanghai endpoint: run list maps the date in the DAG timezone like run get', async () => {
    dagTz = 'UTC';
    runs = [mkRun('d16', '2026-10-16T00:00:00Z', '2026-10-17T00:00:00Z')];
    const list = await call('offline.run.list', { workflow: DAG_ID, data_date: '2026-10-16' });
    expect(list.status).toBe('success');
    const ld = list.data as any;
    expect(ld.mapping.timezone).toBe('UTC');
    expect(ld.runs.map((r: any) => [r.run_id, r.match, r.business_date])).toEqual([['d16', 'exact', '2026-10-16']]);
    const get = await call('offline.run.get', { workflow: DAG_ID, id: 'd16' });
    expect(get.error ?? null).toBeNull();
    expect((get.data as any).summary.business_date).toBe(ld.runs[0].business_date);
  });
});

describe('backfill plan on a weekly schedule', () => {
  it('reports the whole run interval that clearing the overlapping weekly run recomputes', async () => {
    dagTz = 'Asia/Shanghai';
    // weekly run [10-12, 10-19) +08:00, failed
    runs = [mkRun('w42', '2026-10-11T16:00:00Z', '2026-10-18T16:00:00Z', 'failed')];
    const env = await call('offline.backfill.plan', { workflow: DAG_ID, from: '2026-10-12', to: '2026-10-13' });
    expect(env.status).toBe('success');
    const d = env.data as any;
    expect(d.targets.map((t: any) => [t.action, t.run_id])).toEqual([
      ['clear_failed', 'w42'],
      ['clear_failed', 'w42'],
    ]);
    expect(d.targets[0].recompute_interval).toMatchObject({ run_id: 'w42', match: 'covers', start_local: '2026-10-12T00:00:00+08:00', end_local: '2026-10-19T00:00:00+08:00' });
    expect(d.impact.recompute_intervals).toHaveLength(2);
    expect(d.impact.recompute_intervals[0]).toMatchObject({ business_date: '2026-10-12', run_id: 'w42', end_utc: '2026-10-18T16:00:00.000Z' });
    const w = env.meta.warnings.join('\n');
    expect(w).toMatch(/2026-10-12: 清理 run w42 会重算其完整数据区间 \[2026-10-12T00:00:00\+08:00, 2026-10-19T00:00:00\+08:00\)/);
    expect(w).toMatch(/run w42 同时对应业务日期 2026-10-12, 2026-10-13/);
    expect(d.steps[0].detail).toMatch(/重算区间 \[2026-10-12T00:00:00\+08:00, 2026-10-19T00:00:00\+08:00\)，match=covers/);
    expect(d.targets[0].existing_runs[0].data_interval.start.local).toBe('2026-10-12T00:00:00+08:00');
  });

  it('daily exact matches carry no recompute note', async () => {
    dagTz = 'Asia/Shanghai';
    runs = [mkRun('d12', '2026-10-11T16:00:00Z', '2026-10-12T16:00:00Z', 'failed')];
    const env = await call('offline.backfill.plan', { workflow: DAG_ID, from: '2026-10-12', to: '2026-10-12' });
    const d = env.data as any;
    expect(d.targets[0]).toMatchObject({ action: 'clear_failed', recompute_interval: null });
    expect(d.impact.recompute_intervals).toEqual([]);
  });
});
