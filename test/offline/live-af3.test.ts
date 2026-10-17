import { describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { Registry } from '../../src/core/registry';
import compute from '../../src/domains/compute';
import data from '../../src/domains/data';
import offline from '../../src/domains/offline';
import sql from '../../src/domains/sql';

/**
 * Live checks against the Airflow 3 (REST v2) demo instance and, for the contract comparison, the
 * Airflow 2 (REST v1) instance. Needs demo/environment/offline3-up.sh + demo/scenarios/reuse/af3-produce.sh
 * and the Airflow 2 scenarios (demo/scenarios/offline/run-all.sh). Read-only: nothing is triggered.
 *   WORKCTL_IT=1 WORKCTL_AF3=1 npx vitest run test/offline/live-af3.test.ts
 */
describe.skipIf(process.env.WORKCTL_IT !== '1' || process.env.WORKCTL_AF3 !== '1')('offline live on Airflow 3 (REST v2)', () => {
  process.env.WORKCTL_VALIDATE_OUTPUT = '1';
  const r = new Registry();
  for (const d of [offline, compute, sql, data]) r.addDomain(d);
  const v2 = (cap: string, inputs: Record<string, unknown>) => invoke(r, cap, inputs, { configPath: 'demo/environment/workctl.af3.yaml', timeoutMs: 60_000 });
  const v1 = (cap: string, inputs: Record<string, unknown>) => invoke(r, cap, inputs, { configPath: 'demo/environment/workctl.yaml', timeoutMs: 60_000 });
  const schemaOk = (cap: string, d: unknown) => r.get(cap)!.output!.safeParse(d).success;

  it('sources name the v2 adapter, the v2 route and the actual 3.x version', async () => {
    const env = await v2('offline.run.list', { workflow: 'demo-daily-orders', data_date: '2026-10-16', timezone: 'Asia/Shanghai' });
    expect(env.status).toBe('success');
    expect(env.meta.warnings).toEqual([]);
    expect(env.meta.sources[0]).toMatchObject({ adapter: 'airflow-rest-v2', method: 'GET /api/v2/dags/demo-daily-orders/dagRuns' });
    expect(env.meta.sources[0].version).toMatch(/^3\./);
    const run = (env.data as any).runs.find((x: any) => x.run_id === 'demo__2026-10-16__wrong_partition');
    expect(run).toMatchObject({ match: 'exact', business_date: '2026-10-16', conf: { fault: 'wrong_partition' }, external_trigger: true });
  });

  it('wrong_partition: same layered states as on Airflow 2', async () => {
    const inputs = { workflow: 'demo-daily-orders', id: 'demo__2026-10-16__wrong_partition' };
    // equal preconditions: the quality layer reads each profile's stored check of the target partition
    const qc = { dataset: 'analytics.daily_orders', catalog: 'demo', partition: 'dt=2026-10-16' };
    await v1('data.quality.check', qc);
    await v2('data.quality.check', qc);
    const [a, b] = [await v1('offline.run.get', inputs), await v2('offline.run.get', inputs)];
    expect(b.meta.warnings).toEqual([]);
    const states = (e: any) => ['scheduler', 'compute', 'output', 'quality'].map((k) => e.data.summary[`${k}_state`]);
    expect(states(b)).toEqual(states(a));
    expect((b.data as any).summary).toMatchObject({ scheduler_state: 'success', compute_state: 'succeeded', output_state: 'missing', target_partition: { partition: 'dt=2026-10-16' } });
    expect((b.data as any).summary.layers.compute.app_id).not.toBe((a.data as any).summary.layers.compute.app_id); // separate real executions
  });

  it('missing upstream on Airflow 3: sensor waits, input partition missing', async () => {
    const env = await v2('offline.dependency.list', { run_id: 'demo__2026-10-14__missing_upstream', direction: 'upstream', workflow: 'demo-daily-orders' });
    expect(env.meta.warnings).toEqual([]);
    const d = env.data as any;
    expect(d.task_edges.find((e: any) => e.from === 'wait_for_ods_partition').from_state).toBe('up_for_reschedule');
    expect(d.data_dependencies[0]).toMatchObject({ table: 'ods.orders', partition: 'dt=2026-10-14', state: 'missing' });
  });

  it('log get turns the structured v2 log into lines with the Spark app id', async () => {
    const env = await v2('offline.log.get', { workflow: 'demo-daily-orders', run_id: 'demo__2026-10-15__ok', task: 'aggregate_orders', limit_lines: 30 });
    expect(env.meta.warnings).toEqual([]);
    expect((env.data as any).spark_app_ids).toHaveLength(1);
    expect((env.data as any).lines.some((l: string) => l.includes('WORKCTL_SPARK_APP_ID='))).toBe(true);
  });

  it('same output contract for the version-swap capability set', async () => {
    const cases: [string, Record<string, unknown>][] = [
      ['offline.workflow.get', { id: 'demo-daily-orders' }],
      ['offline.task.get', { workflow: 'demo-daily-orders', task: 'aggregate_orders' }],
      ['offline.run.list', { workflow: 'demo-daily-orders', data_date: '2026-10-15' }],
      ['offline.freshness.check', { dataset: 'analytics.daily_orders', data_date: '2026-10-16' }],
      ['compute.queue.get', { id: 'demo-batch-pool' }],
    ];
    for (const [cap, inputs] of cases) {
      const [a, b] = [await v1(cap, inputs), await v2(cap, inputs)];
      expect(b.status, `${cap} ${JSON.stringify(b.error)}`).not.toBe('error');
      expect(schemaOk(cap, a.data) && schemaOk(cap, b.data), cap).toBe(true);
      expect(Object.keys(b.data as object).sort(), cap).toEqual(Object.keys(a.data as object).sort());
      expect(b.context.adapter, cap).toBe(a.context.adapter);
    }
    const wf = [await v1('offline.workflow.get', { id: 'demo-daily-orders' }), await v2('offline.workflow.get', { id: 'demo-daily-orders' })];
    // both schedulers parse the same DAG file
    expect((wf[1].data as any).code_version.source_sha256).toBe((wf[0].data as any).code_version.source_sha256);
  });
});
