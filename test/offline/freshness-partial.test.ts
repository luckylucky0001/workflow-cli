// Regression (contract fuzz, upstream-down pass): when the producer workflow lookup failed
// (Airflow unreachable), offline.freshness.check returned status=success, coverage.complete=true,
// `producer.runs: []` (reads as "no runs") and the raw driver text ("Error: connect ECONNREFUSED ...").
import { appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { Registry } from '../../src/core/registry';
import data from '../../src/domains/data';
import offline from '../../src/domains/offline';
import { tempConfig } from './fake';

const CATALOG = resolve(dirname(fileURLToPath(import.meta.url)), '../../demo/catalog');

describe('offline.freshness.check producer lookup failure', () => {
  it('is a partial result with a coverage note, not success with an empty run list', async () => {
    const cfg = tempConfig({ airflowUrl: 'http://127.0.0.1:9' });
    appendFileSync(cfg.path, `      catalog:\n        demo:\n          provider: file\n          metadata_dir: ${CATALOG}\n          warehouse_root: ./warehouse\n`);
    const r = new Registry();
    r.addDomain(offline);
    r.addDomain(data);
    const env = await invoke(r, 'offline.freshness.check', { dataset: 'analytics.daily_orders', data_date: '2026-10-16' }, { configPath: cfg.path, timeoutMs: 10_000 });
    expect(env.status).toBe('partial');
    expect(env.meta.coverage?.complete).toBe(false);
    expect(env.meta.coverage?.notes?.join(' ')).toMatch(/producer.runs 未采集/);
    const producer = (env.data as any).producer;
    expect(producer.workflow).toBe('demo-daily-orders');
    expect(producer.lookup).not.toMatch(/Error:|127\.0\.0\.1/);
    // the verdict itself still comes from the partition layer
    expect((env.data as any).verdict).toBe('missing');
  });
});
