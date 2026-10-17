/** Regression tests for cross-review fixes in the compute domain. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { Registry } from '../../src/core/registry';
import compute from '../../src/domains/compute';
import { driverFailureSignal, tailFile } from '../../src/domains/compute/spark';
import { fakeServer, tempConfig } from '../offline/fake';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';

const app = (id: string) => ({ id, name: 'demo', attempts: [{ startTimeEpoch: 1792240640000, endTimeEpoch: 1792240660000, lastUpdatedEpoch: 1792240661000, duration: 20000, sparkUser: 'root', completed: true, appSparkVersion: '3.5.5' }] });

let srv: Awaited<ReturnType<typeof fakeServer>>;
let cfg: { path: string; dir: string };
const r = new Registry();
r.addDomain(compute);

beforeAll(async () => {
  srv = await fakeServer((_req, url) => {
    const p = url.pathname.replace('/api/v1', '');
    if (p === '/version') return { json: { spark: '3.5.5' } };
    const m = /^\/applications\/(local-\d+)(\/.*)?$/.exec(p);
    if (!m) return undefined;
    if (!m[2]) return { json: app(m[1]) };
    if (m[2] === '/jobs') return { json: [] }; // driver failed before submitting any job
    if (m[2] === '/allexecutors') return { json: [] };
    return undefined;
  });
  cfg = tempConfig({ historyUrl: srv.url });
  const failing = [
    '26/10/17 12:00:00 INFO SparkContext: Running Spark version 3.5.5',
    'Traceback (most recent call last):',
    '  File "/x/sql_runner.py", line 140, in main',
    '    raise FileNotFoundError(f"input partition not found: {path}")',
    'FileNotFoundError: input partition not found: /w/ods/orders/dt=2026-10-14',
    '26/10/17 12:00:05 INFO SparkContext: SparkContext is stopping with exitCode 0.',
    '26/10/17 12:00:05 INFO ShutdownHookManager: Shutdown hook called',
  ];
  writeFileSync(join(cfg.dir, 'driver-logs', 'local-501.log'), `${failing.join('\n')}\n`);
  const handled = ['Traceback (most recent call last):', '  File "x", line 1', 'ValueError: retrying', '26/10/17 INFO DAGScheduler: Job 0 finished: json at x, took 0.1 s', 'INFO ShutdownHookManager: Shutdown hook called'];
  writeFileSync(join(cfg.dir, 'driver-logs', 'local-502.log'), `${handled.join('\n')}\n`);
});
afterAll(async () => srv.close());

const call = (cap: string, inputs: Record<string, unknown>) => invoke(r, cap, inputs, { configPath: cfg.path, timeoutMs: 10_000 });

describe('compute job get: driver failures outside Spark jobs', () => {
  it('a completed app without failed jobs but with an uncaught driver exception is failed', async () => {
    const env = await call('compute.job.get', { id: 'local-501' });
    expect(env.meta.warnings).toEqual([]);
    expect(env.data).toMatchObject({ status: 'failed' });
    expect((env.data as any).status_basis).toContain('FileNotFoundError: input partition not found');
  });

  it('an exception handled before later jobs finished does not flip the status', async () => {
    const env = await call('compute.job.get', { id: 'local-502' });
    expect(env.data).toMatchObject({ status: 'succeeded' });
  });

  it('without a driver log the basis says the driver was not checked', async () => {
    const env = await call('compute.job.get', { id: 'local-503' });
    expect(env.data).toMatchObject({ status: 'succeeded' });
    expect((env.data as any).status_basis).toContain('未能检查 driver 日志');
  });

  it('driverFailureSignal recognises JVM main-thread exceptions', () => {
    expect(driverFailureSignal(['Exception in thread "main" org.apache.spark.sql.AnalysisException: [TABLE_OR_VIEW_NOT_FOUND]'])).toMatch(/AnalysisException/);
    expect(driverFailureSignal(['INFO all good'])).toBeNull();
  });
});

describe('tailFile on large logs', () => {
  it('reads only the tail window and returns the last lines', () => {
    const p = join(cfg.dir, 'driver-logs', 'big.log');
    writeFileSync(p, Array.from({ length: 200_000 }, (_, i) => `line ${i}`).join('\n') + '\n');
    const t = tailFile(p, 3, 64 * 1024);
    expect(t.lines).toEqual(['line 199997', 'line 199998', 'line 199999']);
    expect(t.truncated).toBe(true);
    expect(t.total_lines).toBeNull();
  });
});
