/** Regression tests for the second cross-review (Airflow v1/v2 adapter). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config';
import { Registry } from '../../src/core/registry';
import { Ctx } from '../../src/core/runtime';
import { AirflowClient } from '../../src/domains/offline/airflow';
import { runsForBusinessDate } from '../../src/domains/offline/runs';
import { businessInterval } from '../../src/domains/offline/time';
import { fakeServer, tempConfig } from './fake';

describe('task instance paging (both API versions page at 100)', () => {
  let srv: Awaited<ReturnType<typeof fakeServer>>;
  let cfg: { path: string };
  const TIS = Array.from({ length: 130 }, (_, i) => ({ task_id: `t${i}`, state: 'success', try_number: 1 }));
  beforeAll(async () => {
    srv = await fakeServer((_req, url) => {
      if (url.pathname.endsWith('/taskInstances')) {
        const limit = Number(url.searchParams.get('limit') ?? 100);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        return { json: { task_instances: TIS.slice(offset, offset + Math.min(limit, 100)), total_entries: TIS.length } };
      }
      return undefined;
    });
    cfg = tempConfig({ airflowUrl: srv.url });
  });
  afterAll(() => srv.close());

  it('returns every task instance, not only the first page', async () => {
    const ctx = new Ctx({ registry: new Registry(), loaded: loadConfig(cfg.path), profileName: 't', requestId: 'x', timeoutMs: 10_000 });
    const tis = await new AirflowClient(ctx).taskInstances('d', 'r');
    expect(tis).toHaveLength(130);
    expect(tis[129].task_id).toBe('t129');
  });
});

describe('Airflow 3 runs without logical_date', () => {
  it('are found by run_after and matched by their data interval (backfill must not trigger a duplicate)', async () => {
    const day = businessInterval('2026-10-15', 'Asia/Shanghai');
    const nullRun = { dag_run_id: 'manual__no_logical', state: 'success', logical_date: null, run_after: '2026-10-16T02:00:00Z', data_interval_start: day.start_utc, data_interval_end: day.end_utc };
    const queries: any[] = [];
    const af: any = {
      apiVersion: 'v2',
      get: async (_p: string, q: any) => {
        queries.push(q);
        // a logical_date filter never returns runs whose logical_date is null
        if (q.logical_date_gte) return { dag_runs: [], total_entries: 0 };
        return { dag_runs: [nullRun], total_entries: 1 };
      },
    };
    const r = await runsForBusinessDate(af, 'd', day);
    expect(queries.some((q) => q.run_after_gte)).toBe(true);
    expect(r.matched.map((m) => m.run.dag_run_id)).toEqual(['manual__no_logical']);
    expect(r.matched[0].match).toBe('exact');
  });

  it('v1 issues a single execution_date query', async () => {
    const queries: any[] = [];
    const af: any = { apiVersion: 'v1', get: async (_p: string, q: any) => (queries.push(q), { dag_runs: [], total_entries: 0 }) };
    await runsForBusinessDate(af, 'd', businessInterval('2026-10-15', 'Asia/Shanghai'));
    expect(queries).toHaveLength(1);
    expect(queries[0].execution_date_gte).toBeDefined();
  });
});
