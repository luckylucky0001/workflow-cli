import { describe, expect, it } from 'vitest';
import { Registry } from '../../src/core/registry';
import { invoke } from '../../src/core/engine';
import offline from '../../src/domains/offline';
import compute from '../../src/domains/compute';
import sql from '../../src/domains/sql';
import data from '../../src/domains/data';

/**
 * Live checks against the demo environment after demo/scenarios/offline/run-all.sh.
 * Run with: WORKCTL_IT=1 npx vitest run test/offline/live.test.ts
 */
describe.skipIf(process.env.WORKCTL_IT !== '1')('offline live (demo Airflow + Spark)', () => {
  process.env.WORKCTL_VALIDATE_OUTPUT = '1';
  const r = new Registry();
  for (const d of [offline, compute, sql, data]) r.addDomain(d);
  const call = (cap: string, inputs: Record<string, unknown>) => invoke(r, cap, inputs, { configPath: 'demo/environment/workctl.yaml', timeoutMs: 60_000 });

  it('run list maps 2026-10-16 to the wrong_partition run', async () => {
    const env = await call('offline.run.list', { workflow: 'demo-daily-orders', data_date: '2026-10-16', timezone: 'Asia/Shanghai' });
    expect(env.status).toBe('success');
    expect(env.meta.warnings).toEqual([]);
    const run = (env.data as any).runs.find((x: any) => x.run_id === 'demo__2026-10-16__wrong_partition');
    expect(run).toMatchObject({ match: 'exact', business_date: '2026-10-16', conf: { fault: 'wrong_partition' } });
    expect(env.meta.sources[0].version).toMatch(/^2\./);
  });

  it('layered status separates scheduler success from missing output', async () => {
    const env = await call('offline.run.get', { workflow: 'demo-daily-orders', id: 'demo__2026-10-16__wrong_partition' });
    expect(env.meta.warnings).toEqual([]);
    const s = (env.data as any).summary;
    expect(s).toMatchObject({ scheduler_state: 'success', compute_state: 'succeeded', output_state: 'missing', target_partition: { partition: 'dt=2026-10-16' } });
    expect(s.findings.some((f: any) => f.kind === 'inconsistency')).toBe(true);
    const job = await call('compute.job.get', { id: s.layers.compute.app_id });
    expect(job.meta.warnings).toEqual([]);
    expect((job.data as any).spark_version).toMatch(/^3\./);
    const stages = await call('compute.stage.list', { job_id: s.layers.compute.app_id });
    expect((stages.data as any).stages.length).toBeGreaterThan(0);
    const log = await call('compute.log.get', { job_id: s.layers.compute.app_id, limit_lines: 20 });
    expect((log.data as any).returned_lines).toBe(20);
  });

  it('normal run is consistent across layers', async () => {
    const env = await call('offline.run.get', { workflow: 'demo-daily-orders', id: 'demo__2026-10-15__ok' });
    expect((env.data as any).summary).toMatchObject({ scheduler_state: 'success', compute_state: 'succeeded', output_state: 'present' });
  });

  it('missing upstream: sensor waits, input partition missing, upstream workflow has no run', async () => {
    const env = await call('offline.dependency.list', { run_id: 'demo__2026-10-14__missing_upstream', direction: 'upstream' });
    expect(env.meta.warnings).toEqual([]);
    const d = env.data as any;
    expect(d.task_edges.find((e: any) => e.from === 'wait_for_ods_partition').from_state).toBe('up_for_reschedule');
    expect(d.data_dependencies[0]).toMatchObject({ table: 'ods.orders', partition: 'dt=2026-10-14', state: 'missing' });
    expect(d.workflow_dependencies[0]).toMatchObject({ workflow: 'demo-ods-orders', run: null });
  });

  it('freshness: 2026-10-16 missing after deadline', async () => {
    const env = await call('offline.freshness.check', { dataset: 'analytics.daily_orders', data_date: '2026-10-16' });
    expect(env.meta.warnings).toEqual([]);
    expect((env.data as any).verdict).toBe('missing');
  });

  it('pool and workflow metadata', async () => {
    const pool = await call('compute.queue.get', { id: 'demo-batch-pool' });
    expect((pool.data as any).slots).toBe(2);
    const wf = await call('offline.workflow.get', { id: 'demo-daily-orders' });
    expect((wf.data as any).timezone).toBe('Asia/Shanghai');
    expect(wf.meta.warnings).toEqual([]);
  });
});
