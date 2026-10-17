import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Registry } from '../../src/core/registry';
import { invoke } from '../../src/core/engine';
import compute from '../../src/domains/compute';
import { deriveStatus } from '../../src/domains/compute/spark';
import { fakeServer, tempConfig } from '../offline/fake';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';

const APP = { id: 'local-100', name: 'demo-daily-orders.aggregate_orders', attempts: [{ startTime: '2026-10-17T12:37:20.000GMT', endTime: '2026-10-17T12:37:40.000GMT', lastUpdated: '2026-10-17T12:37:41.000GMT', duration: 20000, sparkUser: 'root', completed: true, appSparkVersion: '3.5.5', startTimeEpoch: 1792240640000, endTimeEpoch: 1792240660000, lastUpdatedEpoch: 1792240661000 }] };
const JOBS = [{ jobId: 0, name: 'json at x', status: 'SUCCEEDED', stageIds: [0], numTasks: 1, numFailedTasks: 0, submissionTime: '2026-10-17T12:37:25.000GMT', completionTime: '2026-10-17T12:37:26.000GMT' }];
const STAGES = [
  { status: 'COMPLETE', stageId: 1, attemptId: 0, numTasks: 2, numCompleteTasks: 2, numFailedTasks: 0, numKilledTasks: 0, executorRunTime: 900, submissionTime: '2026-10-17T12:37:27.000GMT', completionTime: '2026-10-17T12:37:28.500GMT', inputBytes: 100, inputRecords: 5, outputBytes: 0, outputRecords: 0, shuffleReadBytes: 0, shuffleWriteBytes: 50, name: 'json' },
  { status: 'FAILED', stageId: 2, attemptId: 0, numTasks: 1, numCompleteTasks: 0, numFailedTasks: 1, numKilledTasks: 0, executorRunTime: 10, submissionTime: '2026-10-17T12:37:29.000GMT', completionTime: '2026-10-17T12:37:29.100GMT', inputBytes: 0, inputRecords: 0, outputBytes: 0, outputRecords: 0, shuffleReadBytes: 50, shuffleWriteBytes: 0, name: 'save', failureReason: 'boom' },
];

let srv: Awaited<ReturnType<typeof fakeServer>>;
let cfg: { path: string; dir: string };
const r = new Registry();
r.addDomain(compute);

beforeAll(async () => {
  srv = await fakeServer((_req, url) => {
    const p = url.pathname.replace('/api/v1', '');
    if (p === '/version') return { json: { spark: '3.5.5' } };
    if (p === '/applications/local-100') return { json: APP };
    if (p === '/applications/local-100/jobs') return { json: JOBS };
    if (p === '/applications/local-100/allexecutors') return { json: [{ id: 'driver', totalCores: 2, failedTasks: 0, completedTasks: 3, maxMemory: 1000, totalGCTime: 5 }] };
    if (p === '/applications/local-100/stages') {
      const st = url.searchParams.get('status');
      return { json: st ? STAGES.filter((s) => s.status.toLowerCase() === st) : STAGES };
    }
    return undefined;
  });
  cfg = tempConfig({ historyUrl: srv.url });
  writeFileSync(join(cfg.dir, 'driver-logs', 'local-100.log'), Array.from({ length: 30 }, (_, i) => `log ${i}`).join('\n') + '\n');
  writeFileSync(join(cfg.dir, 'events', 'local-200.inprogress'), '');
  writeFileSync(join(cfg.dir, 'driver-logs', '.pending-1.log'), 'running...\n');
  symlinkSync(join(cfg.dir, 'driver-logs', '.pending-1.log'), join(cfg.dir, 'driver-logs', 'local-300.log'));
});
afterAll(async () => srv.close());

const call = (cap: string, inputs: Record<string, unknown>) => invoke(r, cap, inputs, { configPath: cfg.path, timeoutMs: 10_000 });

describe('compute domain against a fake Spark history server', () => {
  it('job get derives status and reports the app spark version', async () => {
    const env = await call('compute.job.get', { id: 'local-100' });
    expect(env.status).toBe('success');
    expect(env.meta.warnings).toEqual([]);
    expect(env.data).toMatchObject({ status: 'succeeded', spark_version: '3.5.5', duration_ms: 20000, jobs: { total: 1, failed: 0 } });
    expect(env.meta.sources[0]).toMatchObject({ system: 'spark', version: '3.5.5', method: 'GET /api/v1/applications/local-100' });
  });

  it('distinguishes not-yet-loaded, no event log and unknown apps', async () => {
    expect((await call('compute.job.get', { id: 'local-200' })).error?.code).toBe('DATA_UNAVAILABLE');
    expect((await call('compute.job.get', { id: 'local-300' })).error?.code).toBe('COLLECTION_DISABLED');
    expect((await call('compute.job.get', { id: 'local-999' })).error?.code).toBe('NOT_FOUND');
    expect((await call('compute.job.get', { id: '../etc' })).error?.code).toBe('INVALID_ARGUMENT');
  });

  it('stage list exposes failures and durations', async () => {
    const env = await call('compute.stage.list', { job_id: 'local-100', status: 'failed' });
    expect(env.meta.warnings).toEqual([]);
    const d = env.data as any;
    expect(d.stages).toHaveLength(1);
    expect(d.stages[0]).toMatchObject({ stage_id: 2, num_failed_tasks: 1, failure_reason: 'boom', duration_ms: 100 });
  });

  it('log get tails the driver log and flags in-progress logs', async () => {
    const env = await call('compute.log.get', { job_id: 'local-100', limit_lines: 10 });
    expect(env.meta.warnings).toEqual([]);
    expect(env.data).toMatchObject({ returned_lines: 10, total_lines: 30, truncated: true, in_progress: false });
    const running = await call('compute.log.get', { job_id: 'local-300' });
    expect(running.data).toMatchObject({ in_progress: true, lines: ['running...'] });
    expect((await call('compute.log.get', { job_id: 'local-404' })).error?.code).toBe('NOT_FOUND');
  });

  it('deriveStatus: completed with failed jobs is failed; stale in-progress is incomplete', () => {
    expect(deriveStatus(APP, [{ status: 'FAILED' }]).status).toBe('failed');
    expect(deriveStatus({ attempts: [{ completed: false, lastUpdatedEpoch: Date.now() - 3_600_000 }] }, []).status).toBe('incomplete');
    expect(deriveStatus({ attempts: [{ completed: false, lastUpdatedEpoch: Date.now() }] }, []).status).toBe('running');
  });
});
