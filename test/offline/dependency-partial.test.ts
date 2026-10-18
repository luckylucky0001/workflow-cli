// Regression: offline.dependency.list swallowed failed run lookups for related workflows
// (status=success, run: null, raw driver text in run_lookup) — same defect class as the
// freshness producer lookup. A failed lookup must make the result partial and name the workflow.
import { appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { Registry } from '../../src/core/registry';
import data from '../../src/domains/data';
import offline from '../../src/domains/offline';
import { fakeServer, tempConfig } from './fake';

const CATALOG = resolve(dirname(fileURLToPath(import.meta.url)), '../../demo/catalog');
const DAG = 'demo-daily-orders';
const RUN = 'manual__2026-10-16';
const start = new Date(Date.parse('2026-10-16T00:00:00+08:00')).toISOString();
const end = new Date(Date.parse('2026-10-17T00:00:00+08:00')).toISOString();
const run = { dag_run_id: RUN, state: 'success', run_type: 'manual', logical_date: start, execution_date: start, data_interval_start: start, data_interval_end: end, conf: {} };

let srv: Awaited<ReturnType<typeof fakeServer>>;
let cfgPath: string;
beforeAll(async () => {
  srv = await fakeServer((_req, url) => {
    const p = url.pathname.replace('/api/v1', '');
    if (p === '/version') return { json: { version: '2.10.5' } };
    if (p === `/dags/${DAG}/details` || p === `/dags/${DAG}`) return { json: { dag_id: DAG, timezone: 'Asia/Shanghai', owners: ['data'] } };
    if (p === `/dags/${DAG}/tasks`) return { json: { tasks: [{ task_id: 'a', downstream_task_ids: ['b'] }, { task_id: 'b', downstream_task_ids: [] }] } };
    if (p === `/dags/${DAG}/dagRuns/${RUN}`) return { json: run };
    if (p === `/dags/${DAG}/dagRuns/${RUN}/taskInstances`) return { json: { task_instances: [{ task_id: 'a', state: 'success' }, { task_id: 'b', state: 'success' }], total_entries: 2 } };
    // the related upstream workflow's run listing fails
    if (p === '/dags/demo-ods-orders/dagRuns') return { status: 500, json: { title: 'boom', detail: 'internal error at 10.0.0.1' } };
    return undefined;
  });
  const cfg = tempConfig({ airflowUrl: srv.url });
  appendFileSync(cfg.path, `      catalog:\n        demo:\n          provider: file\n          metadata_dir: ${CATALOG}\n          warehouse_root: ./warehouse\n`);
  cfgPath = cfg.path;
});
afterAll(async () => srv.close());

describe('offline.dependency.list related-workflow run lookup failure', () => {
  it('is partial with a coverage note naming the workflow, not success with run: null', async () => {
    const r = new Registry();
    r.addDomain(offline);
    r.addDomain(data);
    const env = await invoke(r, 'offline.dependency.list', { run_id: RUN, workflow: DAG, direction: 'upstream' }, { configPath: cfgPath, timeoutMs: 10_000 });
    expect(env.error).toBeNull();
    expect(env.status).toBe('partial');
    expect(env.meta.coverage?.complete).toBe(false);
    expect(env.meta.coverage?.notes?.join(' ')).toMatch(/demo-ods-orders.*未采集/);
    const w = (env.data as any).workflow_dependencies.find((x: any) => x.workflow === 'demo-ods-orders');
    expect(w.run).toBeNull();
    expect(w.run_lookup).toMatch(/查询失败/);
    expect(w.run_lookup).not.toMatch(/10\.0\.0\.1|127\.0\.0\.1/);
  });
});
