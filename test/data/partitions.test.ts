import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dailyRows, makeFixture, odsRows, schemaWarnings, type Fixture } from './fixture';
import { formatInZone, zonedToInstant, dateInZone } from '../../src/domains/data/time';
import { parseCsvLine } from '../../src/domains/data/partitions';

let fx: Fixture;
beforeEach(() => {
  fx = makeFixture();
});
afterEach(() => fx.cleanup());

describe('time helpers', () => {
  it('converts business wall-clock time in Asia/Shanghai', () => {
    const t = zonedToInstant('2026-10-17', '06:00', 'Asia/Shanghai');
    expect(new Date(t).toISOString()).toBe('2026-10-16T22:00:00.000Z');
    expect(formatInZone(t, 'Asia/Shanghai')).toBe('2026-10-17T06:00:00+08:00');
    expect(dateInZone(Date.parse('2026-10-16T17:30:00Z'), 'Asia/Shanghai')).toBe('2026-10-17');
  });
  it('parses quoted CSV fields', () => {
    expect(parseCsvLine('1,"a,b","say ""hi""",')).toEqual(['1', 'a,b', 'say "hi"', '']);
  });
});

describe('data table get', () => {
  it('returns metadata, physical location and partition count', async () => {
    fx.writePartition('analytics.daily_orders', '2026-10-15', dailyRows('2026-10-15'));
    fx.writePartition('analytics.daily_orders', '2026-10-16', dailyRows('2026-10-16'));
    const env = await fx.call('data.table.get', { catalog: 'demo', table: 'analytics.daily_orders' });
    expect(env.status).toBe('success');
    expect(schemaWarnings(env)).toEqual([]);
    const d = env.data as any;
    expect(d.table.partition_keys[0]).toMatchObject({ name: 'dt', type: 'date', timezone: 'Asia/Shanghai' });
    expect(d.table.produced_by).toMatchObject({ workflow: 'demo-daily-orders', task: 'aggregate_orders' });
    expect(d.physical).toMatchObject({ exists: true, partition_count: 2, latest_partition: 'dt=2026-10-16' });
    expect(d.physical.storage.type).toBe('local-filesystem');
    expect(env.meta.sources.map((s) => s.relation)).toEqual(['explicit', 'derived']);
  });

  it('reports a table whose directory does not exist yet', async () => {
    const env = await fx.call('data.table.get', { table: 'report.daily_summary' });
    expect(env.status).toBe('success');
    expect((env.data as any).physical).toMatchObject({ exists: false, partition_count: null });
    expect(env.meta.warnings.join()).toContain('表目录不存在');
  });

  it('unknown table is NOT_FOUND, malformed name is INVALID_ARGUMENT', async () => {
    expect((await fx.call('data.table.get', { table: 'analytics.nope' })).error?.code).toBe('NOT_FOUND');
    expect((await fx.call('data.table.get', { table: 'nope' })).error?.code).toBe('INVALID_ARGUMENT');
  });

  it('rejects storage types other than local-filesystem', async () => {
    const { readFileSync } = await import('node:fs');
    writeFileSync(fx.config, readFileSync(fx.config, 'utf8').replace('storage: local-filesystem', 'storage: s3'));
    const env = await fx.call('data.table.get', { table: 'ods.orders' });
    expect(env.error?.code).toBe('UNSUPPORTED');
  });
});

describe('data partition list', () => {
  it('lists partitions newest first with file stats, filters and truncation', async () => {
    for (const d of ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']) fx.writePartition('ods.orders', d, odsRows(d, 10), { success: d !== '2026-10-14' });
    mkdirSync(join(fx.warehouse, 'ods/orders/_temporary'), { recursive: true });
    mkdirSync(join(fx.warehouse, 'ods/orders/dt=garbage'), { recursive: true });
    const env = await fx.call('data.partition.list', { table: 'ods.orders', from: '2026-10-14', limit: 2 });
    expect(schemaWarnings(env)).toEqual([]);
    const d = env.data as any;
    expect(d.partitions.map((p: any) => p.partition)).toEqual(['dt=2026-10-16', 'dt=2026-10-15']);
    expect(d.matched).toBe(3);
    expect(d.partitions[0]).toMatchObject({ file_count: 1, success_marker: true });
    expect(d.partitions[0].total_bytes).toBeGreaterThan(100);
    expect(d.nonconforming_entries).toEqual(['dt=garbage/']);
    expect(env.meta.coverage).toMatchObject({ complete: false, truncated: true, limit: 2 });
    const all = (await fx.call('data.partition.list', { table: 'ods.orders' })).data as any;
    expect(all.partitions.find((p: any) => p.partition === 'dt=2026-10-14').success_marker).toBe(false);
  });

  // Regression: --from later than --to returned success, partitions: [], coverage.complete=true
  // (reads as "no partitions in range") instead of rejecting the inverted range.
  it('rejects an inverted --from/--to range instead of a complete empty listing', async () => {
    fx.writePartition('ods.orders', '2026-10-14', odsRows('2026-10-14', 3), { success: true });
    const env = await fx.call('data.partition.list', { table: 'ods.orders', from: '2026-10-16', to: '2026-10-01' });
    expect(env.status).toBe('error');
    expect(env.error?.code).toBe('INVALID_ARGUMENT');
    const same = await fx.call('data.partition.list', { table: 'ods.orders', from: '2026-10-14', to: '2026-10-14' });
    expect((same.data as any).matched).toBe(1);
  });

  it('empty result when the table directory does not exist (complete coverage, warning)', async () => {
    const env = await fx.call('data.partition.list', { table: 'analytics.daily_orders' });
    expect(env.status).toBe('success');
    expect((env.data as any)).toMatchObject({ partitions: [], location_exists: false });
    expect(env.meta.coverage?.complete).toBe(true);
    expect(env.meta.warnings.length).toBe(1);
  });
});

describe('data partition get', () => {
  const get = (partition: string, table = 'analytics.daily_orders') => fx.call('data.partition.get', { table, partition });

  it('present: separate check items, crc and _SUCCESS excluded from data files', async () => {
    fx.writePartition('analytics.daily_orders', '2026-10-16', dailyRows('2026-10-16'));
    const env = await get('dt=2026-10-16');
    expect(env.status).toBe('success');
    expect(schemaWarnings(env)).toEqual([]);
    const d = env.data as any;
    expect(d.state).toBe('present');
    expect(d.checks.defined.ok).toBe(true);
    expect(d.checks.exists.ok).toBe(true);
    expect(d.checks.files).toMatchObject({ ok: true, count: 1 });
    expect(d.checks.files.ignored).toContain('.part-00000-abc-c000.json.crc');
    expect(d.checks.success_marker).toMatchObject({ ok: true, present: true, name: '_SUCCESS' });
    expect(d.checks.updated_at.local).toMatch(/\+08:00$/);
    expect(d.checks.readable.ok).toBe(true);
    expect(d.checks.readable.files[0].records_parsed).toBe(6);
    expect(d.checks.readable.observed_columns).toContain('order_date');
    expect(env.meta.sources.some((s) => s.relation === 'sampled')).toBe(true);
  });

  it('missing partition is success with state=missing and nearby partitions', async () => {
    fx.writePartition('analytics.daily_orders', '2026-10-17', dailyRows('2026-10-16'));
    const env = await get('dt=2026-10-16');
    expect(env.status).toBe('success');
    expect(schemaWarnings(env)).toEqual([]);
    const d = env.data as any;
    expect(d.state).toBe('missing');
    expect(d.checks.exists.ok).toBe(false);
    expect(d.checks.files.ok).toBeNull();
    expect(d.nearby_partitions).toEqual(['dt=2026-10-17']);
  });

  it('missing partition of a business day that has not ended is explained as not yet due', async () => {
    const d = (await get('dt=2099-01-01')).data as any;
    expect(d.state).toBe('missing');
    expect(d.checks.defined.business_date).toMatchObject({ value: '2099-01-01', timezone: 'Asia/Shanghai', day_ended: false, deadline_passed: false, expected_ready_by: '2099-01-02T06:00:00+08:00' });
    expect(d.explanation).toContain('尚未结束');
    const past = (await get('dt=2026-01-01')).data as any;
    expect(past.checks.defined.business_date).toMatchObject({ day_ended: true, deadline_passed: true });
  });

  it('incomplete, unreadable and empty states', async () => {
    fx.writePartition('analytics.daily_orders', '2026-10-14', dailyRows('2026-10-14'), { success: false });
    fx.writePartition('analytics.daily_orders', '2026-10-13', [dailyRows('2026-10-13')[0], '{broken']);
    mkdirSync(join(fx.warehouse, 'analytics/daily_orders/dt=2026-10-12'), { recursive: true });
    writeFileSync(join(fx.warehouse, 'analytics/daily_orders/dt=2026-10-12/_SUCCESS'), '');
    expect(((await get('dt=2026-10-14')).data as any).state).toBe('incomplete');
    const bad = (await get('dt=2026-10-13')).data as any;
    expect(bad.state).toBe('unreadable');
    expect(bad.checks.readable.files[0].parse_errors[0].line).toBe(2);
    expect(((await get('dt=2026-10-12')).data as any).state).toBe('empty');
  });

  it('partition spec errors are INVALID_ARGUMENT; unknown table NOT_FOUND', async () => {
    expect((await get('ds=2026-10-16')).error?.code).toBe('INVALID_ARGUMENT');
    expect((await get('dt=2026-02-30')).error?.code).toBe('INVALID_ARGUMENT');
    expect((await get('2026-10-16')).error?.code).toBe('INVALID_ARGUMENT');
    expect((await get('dt=2026-10-16', 'analytics.missing_table')).error?.code).toBe('NOT_FOUND');
  });

  it('reads CSV tables with header', async () => {
    const meta = join(fx.root, 'demo/catalog/tables/ods.orders_csv.yaml');
    const { readFileSync } = await import('node:fs');
    writeFileSync(meta, readFileSync(join(fx.root, 'demo/catalog/tables/ods.orders.yaml'), 'utf8').replace('name: ods.orders', 'name: ods.orders_csv').replace('format: json', 'format: csv').replace('location: ods/orders', 'location: ods/orders_csv'));
    fx.writePartition('ods/orders_csv', '2026-10-16', odsRows('2026-10-16', 5), { format: 'csv' });
    const env = await fx.call('data.partition.get', { table: 'ods.orders_csv', partition: 'dt=2026-10-16' });
    const d = env.data as any;
    expect(d.state).toBe('present');
    expect(d.checks.readable.files[0].records_parsed).toBe(5);
    expect(d.checks.readable.observed_columns).toContain('customer_id');
  });
});
