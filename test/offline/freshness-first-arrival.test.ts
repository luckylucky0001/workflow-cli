/**
 * Freshness judged `late` from the partition's last write, so a later rewrite of an on-time
 * partition read as late. First arrival now comes from the earliest successful producer run end
 * when that is earlier than the last write; otherwise coverage states that last write was used.
 */
import { appendFileSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
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
let runs: any[] = [];
let srv: Awaited<ReturnType<typeof fakeServer>>;
let cfg: { path: string; dir: string };
const registry = new Registry();
registry.addDomain(offline);
registry.addDomain(data);

// due: 2026-10-17 06:00 Asia/Shanghai = 2026-10-16T22:00Z; the partition was rewritten at 03:00Z on the 17th
const REWRITE = new Date('2026-10-17T03:00:00Z');
const mkRun = (id: string, end: string, state = 'success') => ({ dag_run_id: id, state, run_type: 'scheduled', logical_date: '2026-10-15T16:00:00Z', execution_date: '2026-10-15T16:00:00Z', data_interval_start: '2026-10-15T16:00:00Z', data_interval_end: '2026-10-16T16:00:00Z', start_date: '2026-10-16T16:05:00Z', end_date: end });

beforeAll(async () => {
  srv = await fakeServer((req, url) => {
    const p = url.pathname.replace('/api/v1', '');
    if (p === '/version') return { json: { version: '2.10.5' } };
    if (p === `/dags/${DAG_ID}/dagRuns`) return { json: { dag_runs: runs, total_entries: runs.length } };
    return undefined;
  });
  cfg = tempConfig({ airflowUrl: srv.url });
  const meta = join(cfg.dir, 'catalog');
  mkdirSync(join(meta, 'tables'), { recursive: true });
  writeFileSync(join(meta, 'tables', 'analytics.daily_orders.yaml'), readFileSync(join(DEMO, 'analytics.daily_orders.yaml'), 'utf8'));
  const part = join(cfg.dir, 'warehouse', 'analytics', 'daily_orders', 'dt=2026-10-16');
  mkdirSync(part, { recursive: true });
  writeFileSync(join(part, 'part-00000.json'), '{"order_date":"2026-10-16","status":"paid","order_count":1,"total_amount":1,"avg_amount":1,"customer_count":1}\n');
  writeFileSync(join(part, '_SUCCESS'), '');
  for (const f of ['part-00000.json', '_SUCCESS']) utimesSync(join(part, f), REWRITE, REWRITE);
  appendFileSync(cfg.path, `      catalog:\n        demo:\n          provider: file\n          metadata_dir: ${meta}\n          warehouse_root: ./warehouse\n`);
});
afterAll(async () => srv.close());

const check = () => invoke(registry, 'offline.freshness.check', { dataset: 'analytics.daily_orders', data_date: '2026-10-16' }, { configPath: cfg.path, timeoutMs: 10_000 });

describe('freshness: lateness from first arrival, not last write', () => {
  it('an on-time partition rewritten later is on_time (first successful producer run ended before the deadline)', async () => {
    runs = [mkRun('d16', '2026-10-16T20:00:00Z'), mkRun('d16_rerun', '2026-10-17T03:00:00Z')];
    const env = await check();
    expect(env.error ?? null).toBeNull();
    const d = env.data as any;
    expect(d.partition_updated_at.utc).toBe(REWRITE.toISOString());
    expect(d.verdict).toBe('on_time');
    expect(d.arrival).toMatchObject({ basis: 'first_successful_producer_run_end', relation: 'derived', at: { utc: '2026-10-16T20:00:00.000Z' } });
    expect(d.lateness_minutes).toBeNull();
    expect(env.meta.coverage?.notes?.join(' ')).toMatch(/首次到达按最早成功的产出 run 结束时间判断/);
  });

  it('without first-arrival evidence it judges by last write and says so in coverage', async () => {
    runs = [mkRun('d16', '2026-10-16T21:00:00Z', 'failed')];
    const env = await check();
    const d = env.data as any;
    expect(d.verdict).toBe('late');
    expect(d.arrival.basis).toBe('last_write');
    expect(d.lateness_minutes).toBe(300);
    expect(env.meta.coverage?.notes?.join(' ')).toMatch(/迟到按分区最后写入时间判断（derived）/);
  });
});
