import { describe, expect, it } from 'vitest';
import { Registry } from '../../src/core/registry';
import { invoke } from '../../src/core/engine';
import sql from '../../src/domains/sql';

/** WORKCTL_IT=1: submits a real Spark SQL query in the demo environment and waits for it. */
describe.skipIf(process.env.WORKCTL_IT !== '1')('sql live (spark-submit local)', () => {
  process.env.WORKCTL_VALIDATE_OUTPUT = '1';
  const r = new Registry();
  r.addDomain(sql);
  const call = (cap: string, inputs: Record<string, unknown>) => invoke(r, cap, inputs, { configPath: 'demo/environment/workctl.yaml', timeoutMs: 30_000 });

  it('submit → running → succeeded with preview and result location', async () => {
    const sub = await call('sql.query.submit', { engine: 'spark', file: 'demo/offline-workflows/sql/examples/daily_orders_by_date.sql' });
    expect(sub.status).toBe('success');
    const id = (sub.data as any).query_id;
    let state = 'submitted';
    let last: any;
    for (let i = 0; i < 60 && ['submitted', 'running'].includes(state); i++) {
      await new Promise((ok) => setTimeout(ok, 2000));
      last = (await call('sql.query.get', { id })).data;
      state = last.state;
    }
    expect(state).toBe('succeeded');
    expect(last.app_id).toMatch(/^local-/);
    expect(last.preview.length).toBeGreaterThan(0);
    expect(last.columns).toContain('dt');
  }, 150_000);
});
