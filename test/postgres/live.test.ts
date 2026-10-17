/**
 * Live integration tests against the demo PostgreSQL (demo/environment: `docker compose up -d --no-deps postgres`
 * then `./postgres/provision-users.sh`). Run with: WORKCTL_IT=1 npx vitest run test/postgres
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import type { Envelope } from '../../src/core/output';
import { Registry } from '../../src/core/registry';
import postgresDomain from '../../src/domains/postgres';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';
const CONFIG = resolve(__dirname, '../../demo/environment/workctl.yaml');
const r = new Registry();
r.addDomain(postgresDomain);
const call = (cap: string, inputs: Record<string, unknown>, timeoutMs?: number) => invoke(r, cap, inputs, { configPath: CONFIG, timeoutMs });
const ok = (env: Envelope) => {
  expect(env.error, JSON.stringify(env.error)).toBeNull();
  expect(env.meta.sources.length).toBeGreaterThan(0);
  for (const s of env.meta.sources.filter((x) => x.system === 'postgresql')) expect(s.version).toMatch(/^16\./);
  return env.data as any;
};

/** Superuser connection for test setup only (lock holder / workload); password never printed. */
async function admin(name: string): Promise<pg.Client> {
  const password = readFileSync(resolve(__dirname, '../../demo/environment/.runtime/secrets/pg_superuser_password'), 'utf8').trim();
  const c = new pg.Client({ host: '127.0.0.1', port: 15432, user: 'postgres', password, database: 'demo_orders', application_name: name });
  c.on('error', () => undefined);
  await c.connect();
  return c;
}

describe.skipIf(process.env.WORKCTL_IT !== '1')('postgres live (demo-postgres)', () => {
  it('instance get: engine facts, settings, extensions, binding metadata', async () => {
    const env = await call('postgres.instance.get', {});
    const d = ok(env);
    expect(d.engine.version).toMatch(/^16\./);
    expect(d.engine.current_user).toBe('workctl_ro');
    expect(d.engine.role).toBe('primary');
    expect(d.binding.id).toBe('demo-postgres');
    expect(d.settings.max_connections.value).toBe('100');
    expect(d.settings.default_transaction_read_only.value).toBe('on');
    expect(d.observability).toMatchObject({ pg_stat_statements_installed: true, pg_stat_statements_loaded: true });
    // shared_preload_libraries needs pg_read_all_settings: reported as hidden, not invented
    expect(d.hidden_settings).toContain('shared_preload_libraries');
    expect(env.meta.sources.map((s) => s.adapter)).toEqual(['pg-driver', 'binding-file']);
  });

  it('database list: demo_orders with cumulative counters and stats_reset', async () => {
    const d = ok(await call('postgres.database.list', {}));
    const db = d.databases.find((x: any) => x.name === 'demo_orders');
    expect(db.size_bytes).toBeGreaterThan(1_000_000);
    expect(db.can_connect).toBe(true);
    expect(d.databases.some((x: any) => x.is_template)).toBe(false);
  });

  it('table get: orders has no index on customer_id; sensitive columns flagged; NOT_FOUND', async () => {
    const t = ok(await call('postgres.table.get', { table: 'orders' }));
    expect(t.columns.map((c: any) => c.name)).toEqual(['id', 'customer_id', 'status', 'amount', 'item_count', 'created_at', 'updated_at']);
    expect(t.indexes.map((i: any) => i.name).sort()).toEqual(['orders_created_at_idx', 'orders_pkey']);
    expect(t.indexes.flatMap((i: any) => i.columns)).not.toContain('customer_id');
    expect(t.rows_estimate).toBeGreaterThan(40_000);
    expect(t.access.select).toBe(true);
    const c = ok(await call('postgres.table.get', { table: 'customers' }));
    expect(c.columns.find((x: any) => x.name === 'phone').sensitive).toBe(true);
    const ledger = ok(await call('postgres.table.get', { table: 'internal_ledger' }));
    expect(ledger.access.select).toBe(false);
    expect((await call('postgres.table.get', { table: 'no_such_table' })).error?.code).toBe('NOT_FOUND');
    expect((await call('postgres.table.get', { table: 'orders', database: 'no_such_db' })).error?.code).toBe('NOT_FOUND');
  });

  it('query run: guarded read, masking, truncation; PERMISSION_DENIED / INVALID_ARGUMENT / TIMEOUT', async () => {
    const d = ok(await call('postgres.query.run', { sql: 'SELECT id, phone AS p, upper(email) AS e FROM customers ORDER BY id', max_rows: 2 }));
    expect(d.row_count).toBe(2);
    expect(d.truncated).toBe(true);
    expect(d.masked_columns).toEqual(['p', 'e']);
    expect(d.rows[0][0]).toBe('1');
    expect(String(d.rows[0][1])).toContain('****');
    const w = ok(await call('postgres.query.run', { sql: 'SELECT c AS whole_row, count(*) OVER () AS n FROM customers c', max_rows: 1 }));
    expect(w.masked_columns).toEqual(['whole_row']);
    expect(w.rows[0]).toEqual(['***', '2000']);
    expect((await call('postgres.query.run', { sql: 'SELECT * FROM internal_ledger' })).error?.code).toBe('PERMISSION_DENIED');
    expect((await call('postgres.query.run', { sql: 'UPDATE orders SET status = status' })).error?.code).toBe('INVALID_ARGUMENT');
    expect((await call('postgres.query.run', { sql: 'SELECT pg_sleep(8)' })).error?.code).toBe('TIMEOUT');
  });

  it('explain / analyze: Seq Scan on orders for customer_id; explain of UPDATE is denied for the ro role', async () => {
    const sql = 'SELECT id, status FROM orders WHERE customer_id = 42 ORDER BY created_at DESC LIMIT 20';
    const e = ok(await call('postgres.query.explain', { sql }));
    expect(e.estimate_only).toBe(true);
    expect(e.summary.seq_scans).toEqual(['orders']);
    const g = ok(await call('postgres.query.explain', { sql: 'SELECT * FROM orders WHERE id = $1' }));
    expect(g.generic_plan).toBe(true);
    expect(g.summary.index_scans[0]).toContain('orders_pkey');
    const a = ok(await call('postgres.query.analyze', { sql }));
    expect(a.executed).toBe(true);
    const scan = a.nodes.find((n: any) => n.node_type === 'Seq Scan');
    expect(scan.rows_removed_by_filter).toBeGreaterThan(40_000);
    expect((await call('postgres.query.explain', { sql: "UPDATE orders SET status = 'x' WHERE id = 1" })).error?.code).toBe('PERMISSION_DENIED');
    expect((await call('postgres.query.analyze', { sql: 'DELETE FROM orders' })).error?.code).toBe('INVALID_ARGUMENT');
  });

  it('statement summary: cumulative with stats_reset, and a window delta that sees a workload', async () => {
    const cum = ok(await call('postgres.statement.summary', { sample_window: '0', top: 5 }));
    expect(cum.aggregation).toBe('cumulative_since');
    expect(cum.cumulative_since.stats_reset).toMatch(/^\d{4}-/);
    expect(cum.collection.text_visible).toBe(true);
    const c = await admin('it-load');
    const load = (async () => {
      const until = Date.now() + 2500;
      for (let k = 0; Date.now() < until; k++) await c.query('SELECT count(*) FROM orders WHERE customer_id = $1', [1 + (k % 2000)]);
    })();
    const env = await call('postgres.statement.summary', { sample_window: '2s', top: 5, database: 'demo_orders' }, 20_000);
    await load;
    await c.end();
    const w = ok(env);
    expect(w.aggregation).toBe('window_delta');
    const hit = w.statements.find((s: any) => /customer_id = \$1/.test(s.query ?? ''));
    expect(hit?.calls).toBeGreaterThan(0);
    expect(w.statements.every((s: any) => !/pg_stat_statements/.test(s.query ?? ''))).toBe(true);
  });

  it('wrong password → UNAUTHENTICATED; role without pg_read_all_stats → partial with hidden text, never invented', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'workctl-pg-it-'));
    const pw = `It${randomBytes(9).toString('hex')}`;
    writeFileSync(join(dir, 'bad'), 'definitely-wrong\n');
    writeFileSync(join(dir, 'pw'), `${pw}\n`);
    const ep = (name: string, user: string, ref: string) =>
      [`        ${name}:`, '          host: 127.0.0.1', '          port: 15432', `          user: ${user}`, `          password_ref: file:${ref}`, '          database: demo_orders'];
    const cfg = join(dir, 'workctl.yaml');
    writeFileSync(
      cfg,
      ['current_profile: t', 'profiles:', '  t:', '    env: test', `    state_dir: ${join(dir, 'state')}`, '    endpoints:', '      postgres:', ...ep('bad', 'workctl_ro', 'bad'), ...ep('nostats', 'it_nostats', 'pw')].join('\n'),
    );
    const bad = await invoke(r, 'postgres.instance.get', { instance: 'bad' }, { configPath: cfg });
    expect(bad.error?.code).toBe('UNAUTHENTICATED');
    expect(JSON.stringify(bad)).not.toContain('definitely-wrong');
    const a = await admin('it-visibility');
    const holder = await admin('it-visibility-holder');
    const dropRole = async () => {
      const exists = (await a.query("SELECT 1 FROM pg_roles WHERE rolname = 'it_nostats'")).rowCount;
      if (exists) {
        await a.query('DROP OWNED BY it_nostats'); // also revokes the database CONNECT grant
        await a.query('DROP ROLE it_nostats');
      }
    };
    try {
      await dropRole();
      await a.query(`CREATE ROLE it_nostats LOGIN PASSWORD '${pw}'`);
      await a.query('GRANT CONNECT ON DATABASE demo_orders TO it_nostats');
      await holder.query('BEGIN');
      await holder.query('SELECT 1');
      const s = await invoke(r, 'postgres.session.list', { instance: 'nostats' }, { configPath: cfg });
      expect(s.status).toBe('partial');
      const d = s.data as any;
      expect(d.summary.hidden_details).toBeGreaterThan(0);
      expect(d.sessions.filter((x: any) => x.query_hidden).every((x: any) => x.query === null)).toBe(true);
      const st = await invoke(r, 'postgres.statement.summary', { instance: 'nostats', sample_window: '0', top: 50 }, { configPath: cfg });
      expect(st.status).toBe('partial');
      expect((st.data as any).collection.text_visible).toBe(false);
      expect(JSON.stringify(st.data)).not.toContain('<insufficient privilege>');
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
      await dropRole();
      await a.end();
    }
  });

  it('lock list / session list: blocking chain with an idle-in-transaction root blocker', async () => {
    const a = await admin('it-lock-holder');
    const b = await admin('it-lock-waiter');
    const aPid = (await a.query('SELECT pg_backend_pid() AS p')).rows[0].p;
    const bPid = (await b.query('SELECT pg_backend_pid() AS p')).rows[0].p;
    await a.query('BEGIN');
    await a.query('UPDATE orders SET status = status WHERE id = 7');
    await b.query('BEGIN');
    const waiting = b.query("UPDATE orders SET status = 'paid' WHERE id = 7").catch((e) => e);
    try {
      await new Promise((res) => setTimeout(res, 500));
      const l = ok(await call('postgres.lock.list', {}));
      const w = l.waits.find((x: any) => x.pid === bPid);
      expect(w.blocked_by).toEqual([aPid]);
      expect(w.waiting_for[0]).toMatchObject({ locktype: 'transactionid', mode: 'ShareLock' });
      expect(l.summary.root_blockers).toContain(aPid);
      expect(l.blockers.find((x: any) => x.pid === aPid).state).toBe('idle in transaction');
      const s = ok(await call('postgres.session.list', {}));
      expect(s.summary.idle_in_transaction).toBeGreaterThanOrEqual(1);
      expect(s.sessions.find((x: any) => x.pid === bPid).query).toBe('UPDATE orders SET status = ? WHERE id = ?');
    } finally {
      await a.query('ROLLBACK');
      await waiting;
      await b.query('ROLLBACK');
      await a.end();
      await b.end();
    }
  });
});
