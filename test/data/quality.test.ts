import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLatestQualityResult } from '../../src/domains/data';
import { dailyRows, makeFixture, odsRows, REPO, schemaWarnings, type Fixture } from './fixture';

let fx: Fixture;
beforeEach(() => {
  fx = makeFixture();
});
afterEach(() => fx.cleanup());

const check = (inputs: Record<string, unknown>) => fx.call('data.quality.check', inputs);
const byId = (env: any, id: string) => env.data.results.find((r: any) => r.id === id);
const early = new Date('2026-10-17T03:00:00+08:00');

describe('data quality check', () => {
  it('passes a clean partition with a full scan and persists the latest result', async () => {
    fx.writePartition('analytics.daily_orders', '2026-10-16', dailyRows('2026-10-16'), { mtime: early });
    const env = await check({ dataset: 'demo.daily_orders', partition: 'dt=2026-10-16', ruleset: 'demo-daily-rules' });
    expect(env.status).toBe('success');
    expect(schemaWarnings(env)).toEqual([]);
    const d = env.data as any;
    expect(d.dataset).toMatchObject({ catalog: 'demo', table: 'analytics.daily_orders' });
    expect(d.quality_state).toBe('pass');
    expect(d.conclusive).toBe(true);
    expect(d.results.every((r: any) => r.status === 'pass')).toBe(true);
    expect(byId(env, 'on_time').expected.deadline).toBe('2026-10-17T06:00:00+08:00');
    expect(d.scan).toMatchObject({ mode: 'full', rows_read: 6, rows_total: 6, files_read: 1 });
    expect(env.meta.coverage).toMatchObject({ complete: true, sampled: false });

    const stored = readLatestQualityResult(fx.stateDir, 'analytics.daily_orders', 'dt=2026-10-16');
    expect(stored?.quality_state).toBe('pass');
    expect(stored?.persisted_to).toBe(d.persisted_to);
    expect(stored?.request_id).toBe(env.context.request_id);
    expect(readLatestQualityResult(fx.stateDir, 'analytics.daily_orders', 'dt=2026-10-15')).toBeNull();
  });

  it('detects duplicates, nulls, bad values and wrong-partition data with masked samples', async () => {
    const rows = odsRows('2026-10-16', 300);
    rows.push({ ...rows[5] });
    rows[7].customer_id = null;
    rows[8].status = 'UNKNOWN';
    rows[9].amount = -1;
    rows[10].created_at = '2026-10-15T23:59:00+08:00';
    fx.writePartition('ods.orders', '2026-10-16', rows, { mtime: early });
    const env = await check({ dataset: 'demo.ods.orders', partition: 'dt=2026-10-16' });
    expect(schemaWarnings(env)).toEqual([]);
    const d = env.data as any;
    expect(d.ruleset.name).toBe('demo-ods-rules'); // default from table metadata
    expect(d.quality_state).toBe('fail');
    const dup = byId(env, 'order_id_unique');
    expect(dup.status).toBe('fail');
    expect(dup.observed).toMatchObject({ duplicate_keys: 1, extra_rows: 1 });
    expect(dup.samples[0].row.customer_id).toBe('***'); // sensitive column masked
    expect(byId(env, 'required_not_null').observed.null_counts.customer_id).toBe(1);
    expect(byId(env, 'known_status').observed.invalid_values).toEqual([{ value: 'UNKNOWN', count: 1 }]);
    expect(byId(env, 'non_negative_amount').observed.below_min).toBe(1);
    expect(byId(env, 'created_in_business_date').observed.mismatched).toBe(1);
    expect(byId(env, 'min_rows').status).toBe('pass');
  });

  it('missing partition: partition_exists fails, other rules skipped, overall fail', async () => {
    const env = await check({ dataset: 'demo.daily_orders', partition: 'dt=2026-10-15' });
    expect(env.status).toBe('success');
    expect(schemaWarnings(env)).toEqual([]);
    const d = env.data as any;
    expect(d.quality_state).toBe('fail');
    expect(d.precondition).toMatchObject({ ok: false, partition_state: 'missing' });
    expect(byId(env, 'partition_exists').status).toBe('fail');
    expect(d.results.filter((r: any) => r.id !== 'partition_exists').every((r: any) => r.status === 'skipped')).toBe(true);
    expect(d.scan.mode).toBe('none');
  });

  it('partition without _SUCCESS is a failed precondition', async () => {
    fx.writePartition('analytics.daily_orders', '2026-10-16', dailyRows('2026-10-16'), { success: false });
    const d = (await check({ dataset: 'demo.daily_orders', partition: 'dt=2026-10-16' })).data as any;
    expect(d.precondition).toMatchObject({ ok: false, partition_state: 'incomplete' });
    expect(d.quality_state).toBe('fail');
  });

  it('sampled mode: content passes are not conclusive, row counts stay complete', async () => {
    fx.writePartition('ods.orders', '2026-10-16', odsRows('2026-10-16', 400), { mtime: early });
    const env = await check({ dataset: 'demo.orders', partition: 'dt=2026-10-16', sample_rows: 50 });
    expect(schemaWarnings(env)).toEqual([]);
    const d = env.data as any;
    expect(d.scan).toMatchObject({ mode: 'sampled', rows_read: 50, rows_total: 400 });
    expect(d.quality_state).toBe('pass');
    expect(d.conclusive).toBe(false);
    expect(byId(env, 'order_id_unique')).toMatchObject({ evaluated_on: 'sample', conclusive: false });
    expect(byId(env, 'min_rows')).toMatchObject({ evaluated_on: 'full', conclusive: true });
    expect(env.meta.coverage).toMatchObject({ complete: false, sampled: true });
  });

  it('freshness after the deadline fails but is warn severity in the demo ruleset', async () => {
    fx.writePartition('analytics.daily_orders', '2026-10-16', dailyRows('2026-10-16'), { mtime: new Date('2026-10-17T09:30:00+08:00') });
    const env = await check({ dataset: 'demo.daily_orders', partition: 'dt=2026-10-16' });
    const d = env.data as any;
    expect(byId(env, 'on_time')).toMatchObject({ status: 'fail', severity: 'warn' });
    expect(d.quality_state).toBe('pass');
    expect(d.summary.warn_failures).toBe(1);
  });

  it('unparseable records and schema drift fail', async () => {
    const rows: (Record<string, unknown> | string)[] = dailyRows('2026-10-16').map((r) => ({ ...r, extra_col: 1 }));
    rows.push('not json');
    fx.writePartition('analytics.daily_orders', '2026-10-16', rows, { mtime: early });
    const env = await check({ dataset: 'demo.daily_orders', partition: 'dt=2026-10-16' });
    expect(byId(env, 'records_parseable')).toMatchObject({ status: 'fail', implicit: true });
    expect(byId(env, 'schema').observed.extra).toEqual(['extra_col']);
    expect((env.data as any).precondition.partition_state).toBe('unreadable');
  });

  it('evaluates CSV tables (empty field = null, numeric strings in value_range)', async () => {
    const tables = join(fx.root, 'demo/catalog/tables');
    writeFileSync(
      join(tables, 'ods.orders_csv.yaml'),
      readFileSync(join(tables, 'ods.orders.yaml'), 'utf8')
        .replace('name: ods.orders', 'name: ods.orders_csv')
        .replace('format: json', 'format: csv')
        .replace('location: ods/orders', 'location: ods/orders_csv')
        .replace('quality_ruleset: demo-ods-rules', 'quality_ruleset: csv-rules'),
    );
    writeFileSync(
      join(fx.root, 'demo/quality-rules/csv-rules.yaml'),
      ['name: csv-rules', 'table: ods.orders_csv', 'rules:', '  - { id: rows, type: row_count_min, min: 5 }', '  - { id: nn, type: not_null, columns: [customer_id] }',
        '  - { id: amt, type: value_range, column: amount, min: 0 }', '  - { id: uniq, type: unique, columns: [order_id] }', '  - { id: schema, type: schema_match }'].join('\n'),
    );
    const rows = odsRows('2026-10-16', 5);
    rows[2].customer_id = null;
    fx.writePartition('ods/orders_csv', '2026-10-16', rows, { format: 'csv', mtime: early });
    const env = await check({ dataset: 'demo.ods.orders_csv', partition: 'dt=2026-10-16' });
    expect(schemaWarnings(env)).toEqual([]);
    expect(byId(env, 'rows').observed.rows).toBe(5);
    expect(byId(env, 'nn').observed.null_counts.customer_id).toBe(1);
    expect(byId(env, 'amt')).toMatchObject({ status: 'pass' });
    expect(byId(env, 'amt').observed.min_observed).toBe(10);
    expect(byId(env, 'schema').status).toBe('pass');
    expect((env.data as any).quality_state).toBe('fail');
  });

  it('dataset resolution and ruleset errors', async () => {
    expect((await check({ dataset: 'demo.nothing', partition: 'dt=2026-10-16' })).error?.code).toBe('NOT_FOUND');
    expect((await check({ dataset: 'a.b.c.d', partition: 'dt=2026-10-16' })).error?.code).toBe('INVALID_ARGUMENT');
    expect((await check({ dataset: 'demo.daily_orders', partition: 'dt=2026-10-16', ruleset: 'nope' })).error?.code).toBe('NOT_FOUND');
    expect((await check({ dataset: 'demo.daily_orders', partition: 'dt=2026-10-16', ruleset: 'demo-ods-rules' })).error?.code).toBe('INVALID_ARGUMENT');
    const viaCatalog = await check({ dataset: 'analytics.daily_orders', catalog: 'demo', partition: 'dt=2026-10-16' });
    expect((viaCatalog.data as any).dataset.table).toBe('analytics.daily_orders');
    // ambiguous short name
    const meta = join(fx.root, 'demo/catalog/tables');
    writeFileSync(join(meta, 'tmp.daily_orders.yaml'), readFileSync(join(meta, 'analytics.daily_orders.yaml'), 'utf8').replace('name: analytics.daily_orders', 'name: tmp.daily_orders'));
    const amb = await check({ dataset: 'demo.daily_orders', partition: 'dt=2026-10-16' });
    expect(amb.error?.code).toBe('INVALID_ARGUMENT');
    expect(amb.error?.message).toContain('tmp.daily_orders');
  });
});

describe('synthetic generator', () => {
  const py = spawnSync('python3', ['--version']).status === 0;
  it.skipIf(!py)('writes a deterministic partition with _SUCCESS that passes the ods rules', async () => {
    const gen = join(REPO, 'demo/synthetic-data/generate_orders.py');
    const out = join(fx.warehouse, 'ods/orders/dt=2026-10-16');
    const s1 = JSON.parse(execFileSync('python3', [gen, '--date', '2026-10-16', '--out', out, '--rows', '300']).toString());
    expect(s1).toMatchObject({ synthetic: true, rows: 300, files: ['part-00000.json', '_SUCCESS'] });
    const first = readFileSync(join(out, 'part-00000.json'), 'utf8');
    execFileSync('python3', [gen, '--date', '2026-10-16', '--out', out, '--rows', '300']);
    expect(readFileSync(join(out, 'part-00000.json'), 'utf8')).toBe(first);
    const env = await check({ dataset: 'demo.ods.orders', partition: 'dt=2026-10-16' });
    const d = env.data as any;
    expect(d.results.filter((r: any) => r.severity === 'error').every((r: any) => r.status === 'pass')).toBe(true);
    expect(d.quality_state).toBe('pass');

    const s2 = JSON.parse(execFileSync('python3', [gen, '--date', '2026-10-16', '--out', out, '--rows', '400', '--inject', 'duplicates', '--inject', 'nulls']).toString());
    expect(s2.injected).toEqual({ nulls: 2, duplicates: 2 });
    const bad = await check({ dataset: 'demo.ods.orders', partition: 'dt=2026-10-16' });
    expect((bad.data as any).quality_state).toBe('fail');
    expect(byId(bad, 'order_id_unique').observed.duplicate_keys).toBe(2);
  });
});
