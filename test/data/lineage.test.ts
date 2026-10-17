import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inferSql } from '../../src/domains/data/lineage';
import { makeFixture, schemaWarnings, type Fixture } from './fixture';

describe('inferSql', () => {
  it('finds targets and sources, skipping CTEs, comments, strings, subqueries and EXTRACT(.. FROM ..)', () => {
    const inf = inferSql(`
      -- FROM fake_comment
      /* JOIN fake_block */
      WITH recent AS (SELECT * FROM ods.orders WHERE dt = '\${dt}'),
           agg (a, b) AS (SELECT 1 FROM recent)
      INSERT OVERWRITE TABLE analytics.daily_orders PARTITION (dt = '2026-10-16')
      SELECT r.status, EXTRACT(YEAR FROM r.created_at), TRIM(BOTH ' ' FROM r.status)
      FROM recent r
      JOIN dim.customers c ON c.id = r.customer_id
      LEFT JOIN (SELECT * FROM dim.city) x ON x.id = c.city_id
      JOIN \`ods\`.\`refunds\` f ON f.order_id = r.order_id
      WHERE r.status IS DISTINCT FROM 'x' AND r.note <> 'from secret_table'
    `);
    expect(inf.targets.map((t) => t.name)).toEqual(['analytics.daily_orders']);
    expect(inf.sources.map((s) => s.name).sort()).toEqual(['dim.city', 'dim.customers', 'ods.orders', 'ods.refunds']);
    expect(inf.ctes.sort()).toEqual(['agg', 'recent']);
  });

  it('handles comma joins, temp views and Spark file sources', () => {
    const inf = inferSql(`
      CREATE OR REPLACE TEMPORARY VIEW v AS SELECT * FROM json.\`/wh/ods/orders/dt=2026-10-16\`;
      INSERT INTO report.daily_summary SELECT * FROM v, analytics.daily_orders d;
    `);
    expect(inf.targets.map((t) => t.name)).toEqual(['report.daily_summary']);
    expect(inf.sources.map((s) => s.name)).toEqual(['analytics.daily_orders']);
    expect(inf.path_sources.map((s) => s.name)).toEqual(['json:/wh/ods/orders/dt=2026-10-16']);
  });
});

describe('data lineage get', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => fx.cleanup());

  it('upstream: explicit edge confirmed by SQL inference through declared input_views', async () => {
    const env = await fx.call('data.lineage.get', { catalog: 'demo', table: 'analytics.daily_orders', direction: 'upstream' });
    expect(env.status).toBe('success');
    expect(schemaWarnings(env)).toEqual([]);
    const d = env.data as any;
    const e = d.edges.find((x: any) => x.from === 'ods.orders' && x.to === 'analytics.daily_orders');
    expect(e.relations).toEqual(['explicit', 'inferred']);
    expect(e.confirmed_by_both).toBe(true);
    expect(e.via).toMatchObject({ workflow: 'demo-daily-orders', task: 'aggregate_orders' });
    const ext = d.edges.find((x: any) => x.to === 'ods.orders');
    expect(ext).toMatchObject({ from: 'mysql://demo-mysql/demo.orders', relations: ['explicit'], confirmed_by_both: false });
    expect(d.nodes.find((n: any) => n.id === 'mysql://demo-mysql/demo.orders').type).toBe('external');
    // the CTE name `base` must not appear as a source
    expect(d.nodes.map((n: any) => n.id)).not.toContain('base');
    expect(d.sql_scans[0]).toMatchObject({ status: 'parsed', targets: [] });
    expect(env.meta.sources.map((s) => s.relation)).toEqual(['explicit', 'inferred']);
    expect(env.meta.coverage?.notes?.join()).toContain('正则');
  });

  it('depth limits traversal and marks truncation', async () => {
    const env = await fx.call('data.lineage.get', { table: 'analytics.daily_orders', direction: 'upstream', depth: 1 });
    const d = env.data as any;
    expect(d.nodes.map((n: any) => n.id).sort()).toEqual(['analytics.daily_orders', 'ods.orders']);
    expect(env.meta.coverage).toMatchObject({ complete: false, truncated: true });
  });

  it('downstream: tables declaring the upstream plus consumers', async () => {
    const env = await fx.call('data.lineage.get', { table: 'ods.orders', direction: 'downstream', depth: 3 });
    const d = env.data as any;
    const ids = d.edges.map((e: any) => `${e.from}->${e.to}`);
    expect(ids).toEqual(expect.arrayContaining(['ods.orders->analytics.daily_orders', 'analytics.daily_orders->report.daily_summary', 'analytics.daily_orders->demo-daily-report', 'ods.orders->demo-daily-orders']));
    const planned = d.edges.find((e: any) => e.to === 'report.daily_summary');
    expect(planned.via.status).toBe('planned');
    expect(d.nodes.find((n: any) => n.id === 'demo-daily-report').type).toBe('report');
  });

  it('missing SQL file: only explicit relations, noted in coverage', async () => {
    rmSync(join(fx.root, 'demo/offline-workflows/sql/daily_orders.sql'));
    const env = await fx.call('data.lineage.get', { table: 'analytics.daily_orders' });
    const d = env.data as any;
    expect(d.sql_scans[0].status).toBe('missing');
    expect(d.edges.find((e: any) => e.from === 'ods.orders').relations).toEqual(['explicit']);
    expect(env.meta.coverage?.complete).toBe(false);
    expect(env.meta.coverage?.notes?.join()).toContain('不存在');
  });

  it('unqualified SQL names without a declared view mapping stay unresolved (no similar-name matching)', async () => {
    writeFileSync(join(fx.root, 'demo/offline-workflows/sql/daily_orders.sql'), 'SELECT status FROM orders');
    const env = await fx.call('data.lineage.get', { table: 'analytics.daily_orders', depth: 1 });
    const d = env.data as any;
    const n = d.nodes.find((x: any) => x.id === 'orders');
    expect(n.type).toBe('unresolved');
    expect(d.edges.find((e: any) => e.from === 'ods.orders').confirmed_by_both).toBe(false);
  });

  it('warns when the SQL target disagrees with the catalog', async () => {
    writeFileSync(join(fx.root, 'demo/offline-workflows/sql/daily_orders.sql'), 'INSERT OVERWRITE TABLE analytics.other SELECT * FROM ods_orders');
    const env = await fx.call('data.lineage.get', { table: 'analytics.daily_orders', depth: 1 });
    expect(env.meta.warnings.join()).toContain('analytics.other');
  });
});
