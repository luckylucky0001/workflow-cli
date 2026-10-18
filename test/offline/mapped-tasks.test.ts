/**
 * Mapped task instances (map_index >= 0) must be addressed with ?map_index=N: Airflow otherwise
 * looks up map_index=-1 and answers 404.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config';
import { Registry } from '../../src/core/registry';
import { Ctx } from '../../src/core/runtime';
import offline from '../../src/domains/offline';
import { AirflowClient } from '../../src/domains/offline/airflow';
import { findSparkApps } from '../../src/domains/offline/runs';
import { fakeServer, tempConfig } from './fake';

const DAG = 'demo-mapped';
const RUN = 'scheduled__2026-10-15T16:00:00+00:00';
let srv: Awaited<ReturnType<typeof fakeServer>>;
let cfg: { path: string; dir: string };
const registry = new Registry();
registry.addDomain(offline);

beforeAll(async () => {
  srv = await fakeServer((_req, url) => {
    const p = decodeURIComponent(url.pathname.replace('/api/v1', ''));
    if (p === '/version') return { json: { version: '2.10.5' } };
    const mi = url.searchParams.get('map_index');
    if (p === `/dags/${DAG}/dagRuns/${RUN}`) return { json: { dag_run_id: RUN, state: 'success' } };
    if (p === `/dags/${DAG}/dagRuns/${RUN}/taskInstances/spark_part/1`) return { json: { task_id: 'spark_part', map_index: 1, state: 'failed', try_number: 2 } };
    if (p === `/dags/${DAG}/dagRuns/${RUN}/taskInstances/spark_part/logs/5`) return { text: 'vm\n*** Could not read served logs: 404 Client Error\n' };
    if (p === `/dags/${DAG}/dagRuns/${RUN}/taskInstances/spark_part/logs/2`) {
      if (mi !== '1') return undefined;
      return { text: 'line a\nWORKCTL_SPARK_APP_ID=local-170000000001\n' };
    }
    if (p === `/dags/${DAG}/dagRuns/${RUN}/taskInstances/spark_part/xcomEntries/return_value`) {
      // real Airflow: no map_index → map_index=-1 → not found for a mapped task
      if (mi === null || mi === '-1') return undefined;
      return { json: { key: 'return_value', value: `WORKCTL_SPARK_APP_ID=local-17000000000${mi}` } };
    }
    return undefined;
  });
  cfg = tempConfig({ airflowUrl: srv.url });
});
afterAll(async () => srv.close());

describe('findSparkApps with mapped tasks', () => {
  it('reads the XCom of each mapped instance with its map_index', async () => {
    const ctx = new Ctx({ registry, loaded: loadConfig(cfg.path), profileName: 't', requestId: 'req-test', timeoutMs: 10_000 });
    const af = new AirflowClient(ctx);
    const tis = [0, 1].map((i) => ({ task_id: 'spark_part', map_index: i, state: 'success', try_number: 1, operator: 'PythonOperator' }));
    const apps = await findSparkApps(af, DAG, RUN, tis);
    expect(apps.map((a) => a.app_id)).toEqual(['local-170000000000', 'local-170000000001']);
  });

  it('offline log get reads a mapped instance via --map-index, and hints at it when omitted', async () => {
    const ctx = new Ctx({ registry, loaded: loadConfig(cfg.path), profileName: 't', requestId: 'req-test', timeoutMs: 10_000 });
    const env: any = await ctx.call('offline.log.get', { workflow: DAG, run_id: RUN, task: 'spark_part', map_index: 1, limit_lines: 200 });
    expect(env.status).toBe('success');
    expect(env.data.try_number).toBe(2);
    expect(env.data.spark_app_ids).toEqual(['local-170000000001']);
    const miss: any = await ctx.call('offline.log.get', { workflow: DAG, run_id: RUN, task: 'spark_part', limit_lines: 200 });
    expect(miss.error.code).toBe('NOT_FOUND');
    expect(miss.error.hint).toMatch(/--map-index/);
  });

  it('offline log get refuses a try number beyond the task instance try_number (Airflow returns a 200 stub)', async () => {
    const ctx = new Ctx({ registry, loaded: loadConfig(cfg.path), profileName: 't', requestId: 'req-test', timeoutMs: 10_000 });
    const env: any = await ctx.call('offline.log.get', { workflow: DAG, run_id: RUN, task: 'spark_part', map_index: 1, try: 5, limit_lines: 200 });
    expect(env.error?.code).toBe('NOT_FOUND');
    expect(env.error?.message).toMatch(/只有 2 次尝试/);
  });
});
