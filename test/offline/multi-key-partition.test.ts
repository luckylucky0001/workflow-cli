/**
 * Tables partitioned by more than one key (dt + region): the offline catalog used only the
 * first key, so `offline run get` asked data.partition.get for `dt=...` on a dt/region table and
 * the output layer came back `unknown`. The business-date prefix now resolves to its
 * sub-partitions (data.partition.list) and their states are aggregated.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { Registry } from '../../src/core/registry';
import data from '../../src/domains/data';
import offline from '../../src/domains/offline';
import { fakeServer, tempConfig } from './fake';

const DEMO = resolve(dirname(fileURLToPath(import.meta.url)), '../../demo/catalog/tables');
const DAG_ID = 'wf';
const run = { dag_run_id: 'd16', state: 'success', run_type: 'scheduled', logical_date: '2026-10-15T16:00:00Z', execution_date: '2026-10-15T16:00:00Z', data_interval_start: '2026-10-15T16:00:00Z', data_interval_end: '2026-10-16T16:00:00Z', start_date: '2026-10-16T16:05:00Z', end_date: '2026-10-16T16:10:00Z', conf: {} };
let srv: Awaited<ReturnType<typeof fakeServer>>;
let cfg: { path: string; dir: string };
const registry = new Registry();
registry.addDomain(offline);
registry.addDomain(data);

const ROW = '{"order_date":"2026-10-16","status":"paid","order_count":1,"total_amount":1,"avg_amount":1,"customer_count":1}\n';
function writePart(region: string, marker = true) {
  const dir = join(cfg.dir, 'warehouse', 'analytics', 'orders_by_region', 'dt=2026-10-16', `region=${region}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'part-00000.json'), ROW);
  if (marker) writeFileSync(join(dir, '_SUCCESS'), '');
}

beforeAll(async () => {
  srv = await fakeServer((req, url) => {
    const p = url.pathname.replace('/api/v1', '');
    if (p === '/version') return { json: { version: '2.10.5' } };
    if (p === `/dags/${DAG_ID}/details` || p === `/dags/${DAG_ID}`) return { json: { dag_id: DAG_ID, is_paused: false, is_active: true, has_import_errors: false, owners: ['x'], max_active_runs: 3, timezone: 'Asia/Shanghai' } };
    if (p === `/dags/${DAG_ID}/dagRuns` && req.method === 'GET') return { json: { dag_runs: [run], total_entries: 1 } };
    if (p === `/dags/${DAG_ID}/dagRuns/d16`) return { json: run };
    if (p === `/dags/${DAG_ID}/tasks`) return { json: { tasks: [] } };
    if (/^\/dags\/wf\/dagRuns\/[^/]+\/taskInstances$/.test(p)) return { json: { task_instances: [], total_entries: 0 } };
    return undefined;
  });
  cfg = tempConfig({ airflowUrl: srv.url });
  const meta = join(cfg.dir, 'catalog');
  mkdirSync(join(meta, 'tables'), { recursive: true });
  const yaml = readFileSync(join(DEMO, 'analytics.daily_orders.yaml'), 'utf8')
    .replace('name: analytics.daily_orders', 'name: analytics.orders_by_region')
    .replace('location: analytics/daily_orders', 'location: analytics/orders_by_region')
    .replace('workflow: demo-daily-orders', `workflow: ${DAG_ID}`)
    .replace('columns:\n', '  - name: region\n    type: string\n    semantics: 销售大区\ncolumns:\n');
  writeFileSync(join(meta, 'tables', 'analytics.orders_by_region.yaml'), yaml);
  appendFileSync(cfg.path, `      catalog:\n        demo:\n          provider: file\n          metadata_dir: ${meta}\n          warehouse_root: ./warehouse\n`);
});
afterAll(async () => srv.close());

const call = (cap: string, inp: Record<string, unknown>) => invoke(registry, cap, inp, { configPath: cfg.path, timeoutMs: 15_000 });

describe('multi-key partitions (dt + region)', () => {
  it('fixture table really has two partition keys', async () => {
    const env = await call('data.table.get', { catalog: 'demo', table: 'analytics.orders_by_region' });
    expect((env.data as any).table.partition_keys.map((k: any) => k.name)).toEqual(['dt', 'region']);
  });

  it('missing: no sub-partition under the business date', async () => {
    const env = await call('offline.run.get', { workflow: DAG_ID, id: 'd16' });
    expect(env.error ?? null).toBeNull();
    const out = (env.data as any).summary.layers.output;
    expect(out.state).toBe('missing');
  });

  it('run get output layer aggregates the region sub-partitions instead of unknown', async () => {
    writePart('north');
    writePart('south');
    let env = await call('offline.run.get', { workflow: DAG_ID, id: 'd16' });
    let out = (env.data as any).summary.layers.output;
    expect(out.state).toBe('present');
    expect(out.sub_partitions.map((s: any) => s.partition).sort()).toEqual(['dt=2026-10-16/region=north', 'dt=2026-10-16/region=south']);
    expect(out.detail).toMatch(/不能证明子分区齐全/);
    // one region without its success marker makes the business date incomplete
    writePart('west', false);
    env = await call('offline.run.get', { workflow: DAG_ID, id: 'd16' });
    out = (env.data as any).summary.layers.output;
    expect(out.state).toBe('incomplete');
  });
});
