/**
 * Cluster-mode (YARN) Spark apps carry attempt ids; the history server serves their jobs /
 * executors / stages only under /applications/{id}/{attemptId} (404 "no such app" without it).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { Registry } from '../../src/core/registry';
import compute from '../../src/domains/compute';
import { fakeServer, tempConfig } from '../offline/fake';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';
const ID = 'application_1792240000000_0007';
const attempt = (id: string, start: number, completed: boolean) => ({ attemptId: id, startTimeEpoch: start, endTimeEpoch: start + 1000, lastUpdatedEpoch: start + 1000, duration: 1000, completed, sparkUser: 'u', appSparkVersion: '3.5.5', startTime: '', endTime: '', lastUpdated: '' });
// newest attempt first, as the history server lists them
const APP = { id: ID, name: 'x', attempts: [attempt('2', 1792240100000, true), attempt('1', 1792240000000, true)] };

let srv: Awaited<ReturnType<typeof fakeServer>>;
const r = new Registry();
r.addDomain(compute);

beforeAll(async () => {
  srv = await fakeServer((_req, url) => {
    const p = url.pathname.replace('/api/v1', '');
    if (p === '/version') return { json: { spark: '3.5.5' } };
    if (p === `/applications/${ID}`) return { json: APP };
    if (p === `/applications/${ID}/2/jobs`) return { json: [{ jobId: 0, name: 'j', status: 'SUCCEEDED', stageIds: [0], numTasks: 1, numFailedTasks: 0 }] };
    if (p === `/applications/${ID}/2/allexecutors`) return { json: [] };
    if (p === `/applications/${ID}/2/stages`) return { json: [{ status: 'COMPLETE', stageId: 0, attemptId: 0, numTasks: 1, numCompleteTasks: 1, numFailedTasks: 0, numKilledTasks: 0, name: 's' }] };
    return undefined; // /applications/{id}/jobs etc.: 404 like Spark for attempt-scoped apps
  });
});
afterAll(async () => srv.close());

describe('Spark apps with attempt ids', () => {
  it('job get and stage list read the latest attempt', async () => {
    const cfg = tempConfig({ historyUrl: srv.url });
    const job = await invoke(r, 'compute.job.get', { id: ID }, { configPath: cfg.path, timeoutMs: 10_000 });
    expect(job.status).toBe('success');
    expect((job.data as any).jobs.succeeded).toBe(1);
    expect(JSON.stringify(job.meta.sources)).toContain(`/applications/${ID}/2/jobs`);
    const st = await invoke(r, 'compute.stage.list', { job_id: ID }, { configPath: cfg.path, timeoutMs: 10_000 });
    expect(st.status).toBe('success');
    expect((st.data as any).total).toBe(1);
  });
});
