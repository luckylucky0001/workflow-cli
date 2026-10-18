/**
 * A DAG that produces several catalog tables: write_mode_safe must cover all of them, not only
 * the first table file in the catalog (an append table listed second was ignored).
 */
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { Registry } from '../../src/core/registry';
import data from '../../src/domains/data';
import offline from '../../src/domains/offline';
import { fakeServer, tempConfig } from './fake';

const DEMO = resolve(dirname(fileURLToPath(import.meta.url)), '../../demo/catalog/tables');
const DAG_ID = 'demo-daily-orders';
let srv: Awaited<ReturnType<typeof fakeServer>>;

beforeAll(async () => {
  srv = await fakeServer((req, url) => {
    const p = url.pathname.replace('/api/v1', '');
    if (p === '/version') return { json: { version: '2.10.5' } };
    if (p === `/dags/${DAG_ID}/details` || p === `/dags/${DAG_ID}`) return { json: { dag_id: DAG_ID, is_paused: false, is_active: true, has_import_errors: false, owners: ['x'], max_active_runs: 3, timezone: 'Asia/Shanghai' } };
    if (p === `/dags/${DAG_ID}/dagRuns` && req.method === 'GET') return { json: { dag_runs: [], total_entries: 0 } };
    if (p === `/dags/${DAG_ID}/tasks`) return { json: { tasks: [] } };
    return undefined;
  });
});
afterAll(async () => srv.close());

describe('backfill plan for a DAG producing several tables', () => {
  it('fails write_mode_safe when a later table is append and its partition already has rows', async () => {
    const cfg = tempConfig({ airflowUrl: srv.url });
    const meta = join(cfg.dir, 'catalog');
    mkdirSync(join(meta, 'tables'), { recursive: true });
    copyFileSync(join(DEMO, 'analytics.daily_orders.yaml'), join(meta, 'tables', 'analytics.daily_orders.yaml'));
    copyFileSync(join(DEMO, 'ods.orders.yaml'), join(meta, 'tables', 'ods.orders.yaml'));
    const events = readFileSync(join(DEMO, 'analytics.daily_orders.yaml'), 'utf8')
      .replace('name: analytics.daily_orders', 'name: analytics.order_events')
      .replace('location: analytics/daily_orders', 'location: analytics/order_events')
      .replace('write_mode: overwrite_partition', 'write_mode: append')
      .replace('success_marker: _SUCCESS', 'success_marker: null');
    writeFileSync(join(meta, 'tables', 'analytics.order_events.yaml'), events);
    const part = join(cfg.dir, 'warehouse', 'analytics', 'order_events', 'dt=2026-10-14');
    mkdirSync(part, { recursive: true });
    writeFileSync(join(part, 'part-00000.json'), '{"order_date":"2026-10-14","status":"paid","order_count":1,"total_amount":1,"avg_amount":1,"customer_count":1}\n');
    appendFileSync(cfg.path, `      catalog:\n        demo:\n          provider: file\n          metadata_dir: ${meta}\n          warehouse_root: ./warehouse\n`);
    const r = new Registry();
    r.addDomain(offline);
    r.addDomain(data);
    const env = await invoke(r, 'offline.backfill.plan', { workflow: DAG_ID, from: '2026-10-14', to: '2026-10-14', timezone: 'Asia/Shanghai' }, { configPath: cfg.path, timeoutMs: 10_000 });
    expect(env.status).toBe('success');
    const d = env.data as any;
    expect(d.targets[0].action).toBe('trigger_new');
    const wm = d.preconditions.find((p: any) => p.check === 'write_mode_safe');
    expect(wm.ok).toBe(false);
    expect(wm.detail).toMatch(/analytics\.order_events: append/);
    expect(d.impact.idempotent_rewrite).toBe(false);
    expect(env.meta.warnings.join(' ')).toMatch(/产出 2 张表/);
  });
});

describe('freshness check producer lookup', () => {
  it('maps the business date with the partition timezone, not freshness.timezone (deadline only)', async () => {
    const DAY = 86_400_000;
    const s16 = Date.parse('2026-10-15T16:00:00Z');
    const mk = (id: string, start: number) => ({ dag_run_id: id, state: 'success', run_type: 'scheduled', logical_date: new Date(start).toISOString(), execution_date: new Date(start).toISOString(), data_interval_start: new Date(start).toISOString(), data_interval_end: new Date(start + DAY).toISOString() });
    const af = await fakeServer((req, url) => {
      const p = url.pathname.replace('/api/v1', '');
      if (p === '/version') return { json: { version: '2.10.5' } };
      if (p === `/dags/${DAG_ID}/dagRuns`) return { json: { dag_runs: [mk('d17', s16 + DAY), mk('d16', s16), mk('d15', s16 - DAY)], total_entries: 3 } };
      return undefined;
    });
    try {
      const cfg = tempConfig({ airflowUrl: af.url });
      const meta = join(cfg.dir, 'catalog');
      mkdirSync(join(meta, 'tables'), { recursive: true });
      writeFileSync(join(meta, 'tables', 'analytics.daily_orders.yaml'), readFileSync(join(DEMO, 'analytics.daily_orders.yaml'), 'utf8').replace('  day_offset: 1', '  day_offset: 1\n  timezone: UTC'));
      appendFileSync(cfg.path, `      catalog:\n        demo:\n          provider: file\n          metadata_dir: ${meta}\n          warehouse_root: ./warehouse\n`);
      const r = new Registry();
      r.addDomain(offline);
      r.addDomain(data);
      const env = await invoke(r, 'offline.freshness.check', { dataset: 'analytics.daily_orders', data_date: '2026-10-16' }, { configPath: cfg.path, timeoutMs: 10_000 });
      expect(env.status).toBe('success');
      const d = env.data as any;
      expect(d.expected_by.local).toBe('2026-10-17T06:00:00+00:00');
      expect(d.producer.runs.map((x: any) => x.run_id)).toEqual(['d16']);
    } finally {
      await af.close();
    }
  });
});
