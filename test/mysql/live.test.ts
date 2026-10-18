/**
 * Live integration tests against the demo MySQL (demo/environment, `./up.sh mysql`).
 * Run with: WORKCTL_IT=1 npx vitest run test/mysql
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { invoke } from '../../src/core/engine';
import type { Envelope } from '../../src/core/output';
import { Registry } from '../../src/core/registry';
import mysqlDomain from '../../src/domains/mysql';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';
const CONFIG = resolve(__dirname, '../../demo/environment/workctl.yaml');
const dir = mkdtempSync(join(tmpdir(), 'workctl-mysql-it-'));
const sql = (name: string, text: string) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};
const r = new Registry();
r.addDomain(mysqlDomain);
const call = (cap: string, inputs: Record<string, unknown>, timeoutMs?: number) => invoke(r, cap, inputs, { configPath: CONFIG, timeoutMs });
const ok = (env: Envelope) => {
  expect(env.error, JSON.stringify(env.error)).toBeNull();
  expect(env.meta.warnings).toEqual([]);
  expect(env.meta.sources.length).toBeGreaterThan(0);
  return env.data as any;
};

describe.skipIf(process.env.WORKCTL_IT !== '1')('mysql live (demo-mysql)', () => {
  it('instance get: engine facts + binding metadata', async () => {
    const env = await call('mysql.instance.get', {});
    const d = ok(env);
    expect(d.engine.version).toMatch(/^8\.4\./);
    expect(d.engine.current_user).toBe('workctl_ro@%');
    expect(d.binding.id).toBe('demo-mysql');
    expect(d.observability).toMatchObject({ performance_schema: true, slow_log: 'table', long_query_time_s: 0.2 });
    expect(env.meta.sources.map((s) => s.adapter)).toEqual(['mysql-driver', 'binding-file']);
  });

  it('table get / index list: orders has no index on customer_id', async () => {
    const t = ok(await call('mysql.table.get', { database: 'demo', table: 'orders' }));
    expect(t.columns.map((c: any) => c.name)).toEqual(['id', 'customer_id', 'status', 'amount', 'item_count', 'created_at', 'updated_at']);
    expect(t.rows_estimate).toBeGreaterThan(100_000);
    const c = ok(await call('mysql.table.get', { database: 'demo', table: 'customers' }));
    expect(c.columns.find((x: any) => x.name === 'phone').sensitive).toBe(true);
    const ix = ok(await call('mysql.index.list', { database: 'demo', table: 'orders' }));
    const cols = ix.indexes.flatMap((i: any) => i.columns.map((x: any) => x.column));
    expect(cols).not.toContain('customer_id');
    expect(ix.indexes.map((i: any) => i.name)).toEqual(expect.arrayContaining(['PRIMARY', 'idx_created_at']));
  });

  it('distinguishes NOT_FOUND from PERMISSION_DENIED', async () => {
    expect((await call('mysql.table.get', { database: 'demo', table: 'no_such_table' })).error?.code).toBe('NOT_FOUND');
    expect((await call('mysql.table.get', { database: 'mysql', table: 'user' })).error?.code).toBe('PERMISSION_DENIED');
  });

  it('query execute: guarded read with masking and truncation', async () => {
    const d = ok(await call('mysql.query.execute', { database: 'demo', sql_file: sql('c.sql', 'SELECT id, name, phone, email AS mail FROM customers ORDER BY id'), max_rows: 2 }));
    expect(d.rows).toHaveLength(2);
    expect(d.truncated).toBe(true);
    expect(d.masked_columns).toEqual(['phone', 'mail']);
    expect(d.rows[0][2]).toMatch(/^138\*{4}\d{4}$/);
    expect(d.guards).toMatchObject({ read_only_transaction: true, max_execution_time_ms: 5000 });
    const w = await call('mysql.query.execute', { database: 'demo', sql_file: sql('w.sql', "UPDATE orders SET status='X' WHERE id=1") });
    expect(w.error?.code).toBe('INVALID_ARGUMENT');
  });

  it('query explain (estimate) vs analyze (executed)', async () => {
    const q = sql('q.sql', 'SELECT id, status, amount, created_at FROM orders WHERE customer_id = 4242 ORDER BY created_at DESC LIMIT 20;');
    const e = ok(await call('mysql.query.explain', { database: 'demo', sql_file: q }));
    expect(e.estimate_only).toBe(true);
    expect(e.summary.tables[0].table).toBe('orders');
    expect(['ALL', 'index']).toContain(e.summary.tables[0].access_type);
    const a = ok(await call('mysql.query.analyze', { database: 'demo', sql_file: q }));
    expect(a.executed).toBe(true);
    expect(a.nodes.some((n: any) => n.actual_rows !== null)).toBe(true);
    // EXPLAIN of a write needs write privilege → the read-only account is refused
    const u = await call('mysql.query.explain', { database: 'demo', sql_file: sql('u.sql', 'UPDATE orders SET status = 1 WHERE id = 1') });
    expect(u.error?.code).toBe('PERMISSION_DENIED');
  });

  it('statement summary: window delta vs cumulative', async () => {
    const w = ok(await call('mysql.statement.summary', { sample_window: '2s', top: 5 }));
    expect(w.aggregation).toBe('window_delta');
    expect(w.window.duration_ms).toBeGreaterThanOrEqual(1900);
    const c = ok(await call('mysql.statement.summary', { sample_window: '0', database: 'demo', top: 50 }));
    expect(c.aggregation).toBe('cumulative_since');
    expect(c.cumulative_since.server_started_at).toBeTruthy();
    expect(c.digests.some((x: any) => /`customer_id` = \?/.test(x.digest_text ?? ''))).toBe(true);
  });

  it('slowlog / sessions / locks', async () => {
    const s = await call('mysql.slowlog.list', { since: '1h', limit: 5 });
    const sd = ok(s);
    expect(sd.config).toMatchObject({ slow_query_log: true, log_output: 'TABLE' });
    expect(s.meta.coverage?.window).toBeDefined();
    for (const e of sd.entries) expect(e.sql_text ?? '').not.toMatch(/'\d+'/);
    ok(await call('mysql.session.list', { include_idle: true }));
    const l = ok(await call('mysql.lock.list', {}));
    expect(Array.isArray(l.lock_waits)).toBe(true);
  });

  it('index plan: resolved target, DDL, rollback, not executable', async () => {
    const env = await call('mysql.index.plan', { database: 'demo', table: 'orders', columns: 'customer_id' });
    const p = ok(env);
    expect(p.kind).toBe('mysql.index.create');
    expect(p.status).toBe('planned');
    expect(p.executable).toBe(false);
    expect(p.impact.ddl).toBe('ALTER TABLE `demo`.`orders` ADD INDEX `idx_customer_id` (`customer_id`), ALGORITHM=INPLACE, LOCK=NONE;');
    expect(p.rollback).toContain('DROP INDEX `idx_customer_id`');
    expect(p.preconditions.find((x: any) => x.check === 'no_index_with_same_leading_columns').ok).toBe(true);
    const dup = ok(await call('mysql.index.plan', { database: 'demo', table: 'orders', columns: 'created_at' }));
    expect(dup.preconditions.find((x: any) => x.check === 'no_index_with_same_leading_columns').ok).toBe(false);
  });

  it('probe reports identity and grants', async () => {
    const { Ctx } = await import('../../src/core/runtime');
    const { loadConfig } = await import('../../src/core/config');
    const ctx = new Ctx({ registry: r, loaded: loadConfig(CONFIG), profileName: 'demo', requestId: 't', timeoutMs: 10_000 });
    const p = await r.probes.get('mysql')!(ctx, 'demo-mysql');
    expect(p.ok).toBe(true);
    expect(p.identity).toBe('workctl_ro@%');
    expect(p.privileges!.join('\n')).toContain('GRANT PROCESS');
  });

  it('wrong password → UNAUTHENTICATED', async () => {
    const cfg = YAML.parse(readFileSync(CONFIG, 'utf8'));
    const ep = cfg.profiles.demo.endpoints.mysql['demo-mysql'];
    ep.password_ref = 'env:WORKCTL_IT_WRONG_PW';
    process.env.WORKCTL_IT_WRONG_PW = 'definitely-wrong';
    const p = join(dir, 'bad.yaml');
    writeFileSync(p, YAML.stringify({ ...cfg, profiles: { demo: { ...cfg.profiles.demo, resources_file: undefined, state_dir: dir } } }));
    const env = await invoke(r, 'mysql.instance.get', {}, { configPath: p });
    expect(env.error?.code).toBe('UNAUTHENTICATED');
    expect(JSON.stringify(env)).not.toContain('definitely-wrong');
  });
  it('review: masking holds for * expansions, server error text and EXPLAIN conditions; EXPLAIN is time-bounded', async () => {
    const q = (cap: string, text: string) => call(cap, { instance: 'demo-mysql', database: 'demo', sql: text }, 20_000);
    const union = ok(await q('mysql.query.execute', 'SELECT 1,2,3,4,5,6 UNION ALL SELECT * FROM customers LIMIT 2'));
    expect(JSON.stringify(union.rows)).not.toMatch(/1380\d{7}|user\d+@example/);
    const cte = ok(await q('mysql.query.execute', 'WITH d(c1,c2,c3,c4,c5,c6) AS (SELECT * FROM customers) SELECT * FROM d LIMIT 1'));
    expect(JSON.stringify(cte.rows)).not.toMatch(/1380\d{7}|user\d+@example/);
    const err = await q('mysql.query.execute', 'SELECT EXTRACTVALUE(1, CONCAT(0x7e, (SELECT phone FROM customers LIMIT 1)))');
    expect(err.status).toBe('error');
    expect(JSON.stringify(err.error)).not.toMatch(/1380\d{7}/);
    const plan = 'SELECT o.id FROM customers c JOIN orders o ON o.status = c.phone WHERE c.id = 1';
    expect(JSON.stringify((await q('mysql.query.explain', plan)).data)).not.toMatch(/1380\d{7}/);
    expect(JSON.stringify((await q('mysql.query.analyze', plan)).data)).not.toMatch(/1380\d{7}/);
    expect(JSON.stringify((await q('mysql.query.execute', `EXPLAIN FORMAT=TREE ${plan}`)).data)).not.toMatch(/1380\d{7}/);
    const started = Date.now();
    const slow = await q('mysql.query.explain', 'SELECT * FROM customers WHERE id = (SELECT 1 FROM (SELECT SLEEP(8)) x)');
    expect(slow.error?.code).toBe('TIMEOUT');
    expect(Date.now() - started).toBeLessThan(7500);
  }, 30_000);
});
