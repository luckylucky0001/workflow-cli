import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { Registry, describeCapability } from '../../src/core/registry';
import postgresDomain from '../../src/domains/postgres';
import { isoFromPg, mapPgError } from '../../src/domains/postgres/client';
import { flattenPlan, maskedColumns } from '../../src/domains/postgres/capabilities/query';
import { diffStatements, isSelf, parseWindow, type PssRow } from '../../src/domains/postgres/capabilities/statements';
import { guardPg } from '../../src/domains/postgres/sql-guard';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';

function registry(): Registry {
  const r = new Registry();
  r.addDomain(postgresDomain);
  return r;
}

describe('postgres domain definition', () => {
  const r = registry();
  const caps = r.list({ domain: 'postgres' });

  it('registers the designed commands (pg prefix) and planned ones without handler', () => {
    expect(caps.filter((c) => c.status === 'available').map((c) => c.command).sort()).toEqual(
      [
        'pg database list',
        'pg instance get',
        'pg lock list',
        'pg query analyze',
        'pg query explain',
        'pg query run',
        'pg session list',
        'pg statement summary',
        'pg table get',
      ].sort(),
    );
    const planned = caps.filter((c) => c.status === 'planned');
    expect(planned.map((c) => c.name).sort()).toEqual(['postgres.index.plan', 'postgres.replication.get', 'postgres.vacuum.plan']);
    for (const c of planned) expect(c.handler).toBeUndefined();
    expect(r.probes.has('postgres')).toBe(true);
  });

  it('every capability carries the full contract metadata', () => {
    for (const c of caps) {
      expect(c.name.startsWith('postgres.')).toBe(true);
      expect(c.command).toBe(c.name.replace(/^postgres\./, 'pg.').replace(/\./g, ' '));
      expect(c.summary).toMatch(/[一-龥]/);
      expect(c.guide).toBe('docs/guides/postgres.md');
      if (c.status === 'planned') continue;
      expect(c.output).toBeDefined();
      expect(c.adapter).toBe('pg-driver');
      expect(c.auth_provider).toBe('database-profile');
      expect(c.examples?.length).toBeGreaterThan(0);
      expect(c.notes?.length).toBeGreaterThan(0);
      expect(c.prerequisites?.length).toBeGreaterThan(0);
      expect(['read', 'diagnose']).toContain(c.operation);
      expect(() => r.outputJsonSchema(c)).not.toThrow();
      expect(describeCapability(c).output_schema).toBe(`docs/schemas/${c.name}.v1.json`);
    }
    expect(r.get('postgres.query.analyze')!.operation).toBe('diagnose');
    expect(r.get('postgres.query.explain')!.operation).toBe('read');
  });
});

describe('postgres error mapping', () => {
  const dbErr = (code: string, msg = code) => Object.assign(new Error(msg), { code, severity: 'ERROR' });

  it.each([
    ['28P01', 'UNAUTHENTICATED'],
    ['28000', 'UNAUTHENTICATED'],
    ['42501', 'PERMISSION_DENIED'],
    ['25006', 'PERMISSION_DENIED'],
    ['42P01', 'NOT_FOUND'],
    ['3D000', 'NOT_FOUND'],
    ['57014', 'TIMEOUT'],
    ['55P03', 'TIMEOUT'],
    ['42601', 'INVALID_ARGUMENT'],
    ['22P02', 'INVALID_ARGUMENT'],
    ['42703', 'INVALID_ARGUMENT'],
    ['53300', 'UPSTREAM_UNAVAILABLE'],
    ['57P01', 'UPSTREAM_UNAVAILABLE'],
    ['08006', 'UPSTREAM_UNAVAILABLE'],
    ['XX000', 'UPSTREAM_UNAVAILABLE'],
  ])('SQLSTATE %s → %s (state kept in details)', (state, expected) => {
    const we = mapPgError(dbErr(state));
    expect(we?.code).toBe(expected);
    expect(we?.details?.sql_state).toBe(state);
  });

  it('maps pg_stat_statements not loaded to COLLECTION_DISABLED', () => {
    expect(mapPgError(dbErr('55000', 'pg_stat_statements must be loaded via "shared_preload_libraries"'))?.code).toBe('COLLECTION_DISABLED');
  });

  it('maps network / auth driver errors and ignores unrelated errors', () => {
    expect(mapPgError(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }))?.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(mapPgError(new Error('SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string'))?.code).toBe('UNAUTHENTICATED');
    expect(mapPgError(new Error('timeout exceeded when trying to connect'))?.code).toBe('TIMEOUT');
    expect(mapPgError(new Error('random'))).toBeUndefined();
    expect(mapPgError('x')).toBeUndefined();
  });
});

describe('postgres helpers', () => {
  it('converts UTC timestamptz text to ISO 8601', () => {
    expect(isoFromPg('2026-10-17 16:00:29.908661+00')).toBe('2026-10-17T16:00:29.908661Z');
    expect(isoFromPg('2026-10-17 16:00:29+00')).toBe('2026-10-17T16:00:29Z');
    expect(isoFromPg(null)).toBeNull();
  });

  it('parses sample windows (0 = cumulative)', () => {
    expect(parseWindow('0')).toBe(0);
    expect(parseWindow('0s')).toBe(0);
    expect(parseWindow('10s')).toBe(10_000);
  });

  it('diffs pg_stat_statements snapshots, detecting resets and disappeared entries', () => {
    const row = (key: string, calls: number, total: number, query = 'SELECT $1'): PssRow => ({
      key,
      queryid: key,
      database: 'd',
      user: 'u',
      query,
      calls,
      total_ms: total,
      max_ms: null,
      rows: calls,
      shared_blks_hit: calls * 10,
      shared_blks_read: 0,
      temp_blks_written: 0,
    });
    const d = diffStatements([row('a', 10, 100), row('b', 5, 50), row('gone', 3, 3)], [row('a', 15, 160), row('b', 2, 20), row('new', 4, 8)]);
    const by = Object.fromEntries(d.stats.map((s) => [s.queryid, s]));
    expect(by.a.calls).toBe(5);
    expect(by.a.total_exec_ms).toBe(60);
    expect(by.a.mean_exec_ms).toBe(12);
    expect(by.b.calls).toBe(2);
    expect(by.b.reset_detected).toBe(true);
    expect(by.new.calls).toBe(4);
    expect(d.reset).toBe(1);
    expect(d.disappeared).toBe(1);
    expect(isSelf('SELECT * FROM public.pg_stat_statements p')).toBe(true);
    expect(isSelf('SELECT 1')).toBe(false);
  });

  it('flattens EXPLAIN JSON and finds sequential scans', () => {
    const plan = [
      {
        Plan: {
          'Node Type': 'Limit',
          'Total Cost': 10,
          'Plan Rows': 20,
          Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'orders', Alias: 'orders', Filter: '(customer_id = 42)', 'Actual Loops': 1, 'Actual Rows': 25, 'Rows Removed by Filter': 49975 }],
        },
        'Planning Time': 0.1,
        'Execution Time': 4.2,
      },
    ];
    const f = flattenPlan(plan, true);
    expect(f.seq_scans).toEqual(['orders']);
    expect(f.nodes).toHaveLength(2);
    expect(f.nodes[1]).toMatchObject({ depth: 1, rows_removed_by_filter: 49975, never_executed: false });
    expect(f.execution_ms).toBe(4.2);
    expect(flattenPlan(plan, false).nodes[1].actual_rows).toBeUndefined();
  });

  it('masks aliased sensitive columns and expressions over them', () => {
    const g = guardPg('SELECT c.phone AS p, upper(c.email) AS e, c.name, 1 AS one FROM customers c', 'run');
    const fields = [
      { name: 'p', tableID: 100, columnID: 3 },
      { name: 'e', tableID: 0, columnID: 0 },
      { name: 'name', tableID: 100, columnID: 2 },
      { name: 'one', tableID: 0, columnID: 0 },
    ];
    const src = new Map([
      ['100:3', 'phone'],
      ['100:2', 'name'],
    ]);
    const m = maskedColumns(fields, src, new Set(['phone', 'email']), g);
    // expression columns are masked conservatively once a sensitive column is referenced
    expect(m.masked).toEqual([true, true, false, true]);
    const plain = maskedColumns([{ name: 'one', tableID: 0, columnID: 0 }], new Map(), new Set(['phone']), guardPg('SELECT 1 AS one', 'run'));
    expect(plain.masked).toEqual([false]);
  });
});

describe('postgres capabilities without a live server', () => {
  let configPath: string;
  let sqlFile: string;
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'workctl-pg-'));
    writeFileSync(join(dir, 'pw'), 'not-a-real-password\n');
    configPath = join(dir, 'workctl.yaml');
    writeFileSync(
      configPath,
      [
        'current_profile: t',
        'profiles:',
        '  t:',
        '    env: test',
        `    state_dir: ${join(dir, 'state')}`,
        '    endpoints:',
        '      postgres:',
        '        down:',
        '          host: 127.0.0.1',
        '          port: 1',
        '          user: workctl_ro',
        '          password_ref: file:pw',
        '          database: demo_orders',
      ].join('\n'),
    );
    sqlFile = join(dir, 'q.sql');
    writeFileSync(sqlFile, 'DELETE FROM orders');
  });

  it('unreachable instance → UPSTREAM_UNAVAILABLE (retryable), no credential in output', async () => {
    const env = await invoke(registry(), 'postgres.instance.get', { instance: 'down' }, { configPath });
    expect(env.status).toBe('error');
    expect(env.error?.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(env.error?.retryable).toBe(true);
    expect(JSON.stringify(env)).not.toContain('not-a-real-password');
  });

  it('static guard rejects writes before connecting', async () => {
    const env = await invoke(registry(), 'postgres.query.run', { instance: 'down', sql_file: sqlFile }, { configPath });
    expect(env.error?.code).toBe('INVALID_ARGUMENT');
    expect(env.error?.message).toContain('DELETE');
  });

  it('requires exactly one of --sql / --sql-file', async () => {
    const both = await invoke(registry(), 'postgres.query.explain', { instance: 'down', sql: 'SELECT 1', sql_file: sqlFile }, { configPath });
    expect(both.error?.code).toBe('INVALID_ARGUMENT');
    const none = await invoke(registry(), 'postgres.query.explain', { instance: 'down' }, { configPath });
    expect(none.error?.code).toBe('INVALID_ARGUMENT');
  });

  it('unknown endpoint → NOT_FOUND with available names', async () => {
    const env = await invoke(registry(), 'postgres.session.list', { instance: 'nope' }, { configPath });
    expect(env.error?.code).toBe('NOT_FOUND');
    expect(env.error?.hint).toContain('down');
  });

  it('sample window larger than the time budget is refused up front', async () => {
    const env = await invoke(registry(), 'postgres.statement.summary', { instance: 'down', sample_window: '45s' }, { configPath, timeoutMs: 30_000 });
    expect(env.error?.code).toBe('INVALID_ARGUMENT');
    expect(env.error?.hint).toContain('--timeout');
  });
});
