// Regression tests for the data domain cross-review fixes.
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config';
import { Registry } from '../../src/core/registry';
import { Ctx } from '../../src/core/runtime';
import { resolveDataset } from '../../src/domains/data/catalog';
import { inferSql } from '../../src/domains/data/lineage';
import { makeFixture, schemaWarnings, type Fixture } from './fixture';

let fx: Fixture;
beforeEach(() => {
  fx = makeFixture();
});
afterEach(() => fx.cleanup());

const ROW_RULES = `name: rv-row-rules
table: analytics.daily_orders
rules:
  - { id: keys_not_null, type: not_null, columns: [order_date, status] }
  - { id: one_row_per_status, type: unique, columns: [order_date, status] }
  - { id: known_status, type: accepted_values, column: status, values: [PAID] }
`;

describe('quality check on partitions without records', () => {
  it('does not report row rules as passed for an empty partition', async () => {
    writeFileSync(join(fx.root, 'demo', 'quality-rules', 'rv-row-rules.yaml'), ROW_RULES);
    fx.writePartition('analytics.daily_orders', '2026-10-16', []);
    const env = await fx.call('data.quality.check', { dataset: 'demo.daily_orders', partition: 'dt=2026-10-16', ruleset: 'rv-row-rules' });
    expect(schemaWarnings(env)).toEqual([]);
    const d = env.data as any;
    expect(d.precondition.partition_state).toBe('empty');
    const rowRules = d.results.filter((r: any) => ['keys_not_null', 'one_row_per_status', 'known_status'].includes(r.id));
    expect(rowRules.map((r: any) => r.status)).toEqual(['skipped', 'skipped', 'skipped']);
    expect(d.conclusive).toBe(false);
  });

  it('skips row rules when no record parses (and fails on parseability)', async () => {
    writeFileSync(join(fx.root, 'demo', 'quality-rules', 'rv-row-rules.yaml'), ROW_RULES);
    fx.writePartition('analytics.daily_orders', '2026-10-16', ['not json', '{broken']);
    const env = await fx.call('data.quality.check', { dataset: 'demo.daily_orders', partition: 'dt=2026-10-16', ruleset: 'rv-row-rules' });
    const d = env.data as any;
    expect(d.quality_state).toBe('fail');
    expect(d.results.find((r: any) => r.id === 'keys_not_null').status).toBe('skipped');
    expect(d.results.find((r: any) => r.id === 'records_parseable').status).toBe('fail');
  });
});

describe('dataset resolution ambiguity', () => {
  function twoCatalogs(otherTables: string[]): Ctx {
    // second catalog named "ods" next to the default "demo" (which holds ods.orders)
    const other = join(fx.root, 'demo', 'catalog-ods');
    cpSync(join(fx.root, 'demo', 'catalog'), other, { recursive: true });
    for (const t of ['ods.orders', 'analytics.daily_orders', 'report.daily_summary']) {
      if (!otherTables.includes(t)) rmSync(join(other, 'tables', `${t}.yaml`));
    }
    const cfg = `schema_version: "1.0"
current_profile: t
profiles:
  t:
    env: test
    defaults: { catalog: demo }
    endpoints:
      catalog:
        demo: { provider: file, metadata_dir: ${join(fx.root, 'demo', 'catalog')}, warehouse_root: ${fx.warehouse} }
        ods: { provider: file, metadata_dir: ${other}, warehouse_root: ${fx.warehouse} }
`;
    const path = join(fx.root, 'two.yaml');
    writeFileSync(path, cfg);
    return new Ctx({ registry: new Registry(), loaded: loadConfig(path), profileName: 't', requestId: 'req-x', timeoutMs: 5000 });
  }

  it('refuses to guess when <a>.<b> names a table under both readings', () => {
    const ctx = twoCatalogs(['ods.orders']);
    expect(() => resolveDataset(ctx, 'ods.orders')).toThrow(/歧义/);
  });

  it('falls back to <db>.<table> in the default catalog when the catalog reading finds nothing', () => {
    const ctx = twoCatalogs(['analytics.daily_orders']);
    expect(resolveDataset(ctx, 'ods.orders')).toMatchObject({ catalog: 'demo', table: 'ods.orders' });
    expect(resolveDataset(ctx, 'ods.daily_orders')).toMatchObject({ catalog: 'ods', table: 'analytics.daily_orders' });
  });
});

describe('lineage inference false positives / negatives', () => {
  it('INSERT OVERWRITE DIRECTORY is not a table target', () => {
    const inf = inferSql(`INSERT OVERWRITE LOCAL DIRECTORY '/tmp/export' STORED AS TEXTFILE SELECT * FROM ods.orders`);
    expect(inf.targets).toEqual([]);
    expect(inf.sources.map((s) => s.name)).toEqual(['ods.orders']);
    expect(inferSql(`INSERT OVERWRITE DIRECTORY '/x' SELECT 1 FROM a`).targets).toEqual([]);
  });

  it('MERGE INTO ... USING <table> records the merge source', () => {
    const inf = inferSql(`MERGE INTO analytics.daily_orders AS t
USING ods.orders s
ON t.id = s.id
WHEN MATCHED THEN UPDATE SET *`);
    expect(inf.targets.map((t) => t.name)).toEqual(['analytics.daily_orders']);
    expect(inf.sources.map((s) => `${s.name}@${s.line}`)).toEqual(['ods.orders@2']);
    const sub = inferSql(`MERGE INTO t USING (SELECT * FROM src) s ON t.id = s.id WHEN MATCHED THEN DELETE`);
    expect(sub.sources.map((s) => s.name)).toEqual(['src']);
  });

  it('a file source outside the warehouse is not attributed to a table by path suffix', async () => {
    writeFileSync(
      join(fx.root, 'demo', 'offline-workflows', 'sql', 'daily_orders.sql'),
      `INSERT OVERWRITE TABLE analytics.daily_orders
SELECT * FROM json.\`/backup/elsewhere/ods/orders/dt=2026-10-16\`
UNION ALL SELECT * FROM json.\`${fx.warehouse}/ods/orders/dt=2026-10-16\``,
    );
    mkdirSync(join(fx.warehouse, 'ods', 'orders'), { recursive: true });
    const env = await fx.call('data.lineage.get', { catalog: 'demo', table: 'analytics.daily_orders', direction: 'upstream', depth: 1 });
    expect(env.status).not.toBe('error');
    const inferred = (env.data as any).edges.filter((e: any) => e.relations.includes('inferred')).map((e: any) => e.from).sort();
    expect(inferred).toContain('ods.orders');
    expect(inferred).toContain('json:/backup/elsewhere/ods/orders/dt=2026-10-16');
  });
});
