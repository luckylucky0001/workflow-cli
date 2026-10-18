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
import { defineCapability, Registry } from '../../src/core/registry';
import { z } from 'zod';
import { withPg } from '../../src/domains/postgres/client';
import postgresDomain from '../../src/domains/postgres';
import { assertStandardStrings } from '../../src/domains/postgres/capabilities/query';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';
const CONFIG = resolve(__dirname, '../../demo/environment/workctl.yaml');
const r = new Registry();
r.addDomain(postgresDomain);
// probe that bypasses the client-side lexer: what does the server accept for a user statement?
r.addCapability(
  defineCapability({
    name: 'it.pg.multi', command: 'it pg multi', summary: 'probe', domain: 'postgres', output: z.object({}).passthrough(), adapter: 'it', operation: 'read', auth_provider: 'none', guide: 'docs/x.md',
    inputs: { sql: { type: 'string', description: 's' }, simple: { type: 'bool', description: 'b' } },
    handler: async (ctx, i) => withPg(ctx, undefined, async (s) => ({ data: { rows: i.simple ? await s.query(String(i.sql)) : await s.queryUser(String(i.sql)) } })),
  }),
);
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

  it('query run / analyze: Unicode-escaped names and ts_rewrite are refused; errors over sensitive columns hide the value', async () => {
    // both were accepted and executed the SQL text before the fix (benign payloads)
    expect((await call('postgres.query.run', { sql: `SELECT U&"\\0071uery_to_xml"('select 1', true, true, '')` })).error?.code).toBe('INVALID_ARGUMENT');
    expect((await call('postgres.query.run', { sql: "SELECT ts_rewrite('a & b'::tsquery, 'SELECT ''a''::tsquery, ''c''::tsquery')" })).error?.code).toBe('INVALID_ARGUMENT');
    expect((await call('postgres.query.run', { sql: 'SELECT txid_current()' })).error?.code).toBe('INVALID_ARGUMENT');
    const phone = ok(await call('postgres.query.run', { sql: 'SELECT phone FROM customers ORDER BY id', max_rows: 1 }));
    expect(phone.masked_columns).toEqual(['phone']);
    for (const [cap, sql] of [
      ['postgres.query.run', 'SELECT phone::int FROM customers ORDER BY id LIMIT 1'],
      ['postgres.query.analyze', 'SELECT c.phone::int FROM customers c ORDER BY c.id LIMIT 1'],
      ['postgres.query.run', "SELECT (row_to_json(c)->>('ph'||'one'))::regclass FROM customers c ORDER BY c.id LIMIT 1"],
    ]) {
      const env = await call(cap, { sql });
      expect(env.error?.code, sql).toMatch(/INVALID_ARGUMENT|NOT_FOUND/);
      expect(JSON.stringify(env), sql).not.toMatch(/\+86-1\d{3}/);
      expect(env.error?.message, sql).toContain('"***"');
    }
    // unrelated errors keep their text
    expect((await call('postgres.query.run', { sql: "SELECT 'abc'::int" })).error?.message).toContain('"abc"');
  });

  it('guarded statements refuse a session with standard_conforming_strings=off (guard lexes as on)', async () => {
    const password = readFileSync(resolve(__dirname, '../../demo/environment/.runtime/secrets/pg_ro_password'), 'utf8').trim();
    const c = new pg.Client({ host: '127.0.0.1', port: 15432, user: 'workctl_ro', password, database: 'demo_orders', application_name: 'it-scs-off', options: '-c standard_conforming_strings=off' });
    c.on('error', () => undefined);
    await c.connect();
    try {
      const s = { ep: { id: 'postgres/demo-postgres' } as any, query: async (sql: string) => (await c.query(sql)).rows };
      await expect(assertStandardStrings(s)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    } finally {
      await c.end();
    }
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

  it('user statements go through the extended protocol: the server itself rejects multiple commands', async () => {
    // the simple protocol (old path) would have run both
    expect((await call('it.pg.multi', { sql: 'SELECT 1 AS a; SELECT 2 AS b', simple: true })).status).toBe('success');
    const env = await call('it.pg.multi', { sql: 'SELECT 1 AS a; SELECT 2 AS b' });
    expect(env.error).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(env.error?.message).toContain('cannot insert multiple commands');
    // GENERIC_PLAN with $n still works (NULLs bound for every parameter)
    const e = ok(await call('postgres.query.explain', { sql: 'SELECT id FROM orders WHERE customer_id = $1 AND status = $2' }));
    expect(e.estimate_only).toBe(true);
  });

  it('session list masks comment contents in query text', async () => {
    const a = await admin('it-comment');
    const aPid = (await a.query('SELECT pg_backend_pid() AS p')).rows[0].p;
    const running = a.query('/* token=it-secret-123 */ SELECT pg_sleep(2) -- phone 13800001111').catch((e) => e);
    try {
      await new Promise((res) => setTimeout(res, 300));
      const s = ok(await call('postgres.session.list', {}));
      const q = s.sessions.find((x: any) => x.pid === aPid).query;
      expect(q).toBe('/* ? */ SELECT pg_sleep(?) -- ?');
      expect(JSON.stringify(s)).not.toContain('it-secret-123');
    } finally {
      await running;
      await a.end();
    }
  });

  it('statement summary detects a single-entry reset even when calls exceed the pre-reset count', async () => {
    const a = await admin('it-pss-reset');
    const b = await admin('it-pss-observer');
    const tag = `it_reset_${randomBytes(3).toString('hex')}`;
    const q = (sec: number) => a.query(`SELECT pg_sleep(${sec}) AS ${tag}`);
    try {
      // the queryid as pg_stat_statements sees it: pg_stat_activity.query_id of the running statement
      const aPid = (await a.query('SELECT pg_backend_pid() AS p')).rows[0].p;
      const running = q(0.3);
      await new Promise((res) => setTimeout(res, 100));
      const queryid = String((await b.query('SELECT query_id::text AS q FROM pg_stat_activity WHERE pid = $1', [aPid])).rows[0].q);
      await running;
      // start the entry from zero, then 2 calls (max_exec_time ≈ 300ms) before the in-window reset
      await a.query('SELECT pg_stat_statements_reset(0, 0, $1::bigint)', [queryid]);
      await q(0.3);
      await q(0); // 2 calls before the reset
      const pending = call('postgres.statement.summary', { sample_window: '4s', top: 100, order_by: 'calls', database: 'demo_orders' }, 20_000);
      await new Promise((res) => setTimeout(res, 1500)); // t0 snapshot taken
      await a.query('SELECT pg_stat_statements_reset(0, 0, $1::bigint)', [queryid]);
      for (let k = 0; k < 5; k++) await q(0.001); // 5 > 2 calls before the reset
      const env = await pending;
      expect(env.status).toBe('partial');
      const st = (env.data as any).statements.find((x: any) => x.queryid === queryid);
      expect(st).toMatchObject({ calls: 5, reset_detected: true });
      expect(env.meta.coverage?.notes?.join(' ')).toContain('单独重置');
    } finally {
      await a.end();
      await b.end();
    }
  });
  it('table get on partitioned tables / views is not reported as empty; masking sees quoted mixed-case relations; unknown --database is NOT_FOUND', async () => {
    const a = await admin('it-edge-objects');
    try {
      await a.query('DROP SCHEMA IF EXISTS "It Edge" CASCADE');
      await a.query('CREATE SCHEMA "It Edge"');
      await a.query('CREATE TABLE "It Edge"."Events"(id int, ts date, phone text) PARTITION BY RANGE (ts)');
      await a.query(`CREATE TABLE "It Edge"."Events_2026" PARTITION OF "It Edge"."Events" FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')`);
      await a.query(`INSERT INTO "It Edge"."Events" SELECT g, '2026-05-01', '1380013800' || g FROM generate_series(1, 500) g`);
      await a.query('CREATE VIEW "It Edge".v AS SELECT id FROM "It Edge"."Events"');
      await a.query('GRANT USAGE ON SCHEMA "It Edge" TO workctl_ro');
      await a.query('GRANT SELECT ON ALL TABLES IN SCHEMA "It Edge" TO workctl_ro');
      const p = ok(await call('postgres.table.get', { schema: 'It Edge', table: 'Events' }));
      expect(p.kind).toBe('partitioned table');
      expect(p.size.total_bytes).toBeGreaterThan(0);
      expect(p.stats).toBeNull();
      await a.query('CREATE INDEX ON "It Edge"."Events"(id)');
      const pi = ok(await call('postgres.table.get', { schema: 'It Edge', table: 'Events' }));
      expect(pi.indexes[0].size_bytes).toBeNull();
      expect(pi.size.indexes_bytes).toBeGreaterThan(0);
      const v = ok(await call('postgres.table.get', { schema: 'It Edge', table: 'v' }));
      expect(v.kind).toBe('view');
      expect(v.size.total_bytes).toBeNull();
      for (const sql of ['SELECT e FROM "It Edge"."Events" e ORDER BY id LIMIT 1', 'SELECT row_to_json(e) AS j FROM "It Edge"."Events" e ORDER BY id LIMIT 1']) {
        const q = await call('postgres.query.run', { sql });
        expect(JSON.stringify(q.data)).not.toContain('13800138001');
        expect((q.data as any).masked_columns.length).toBe(1);
      }
      const st = await call('postgres.statement.summary', { sample_window: '0', database: 'no_such_db_it' });
      expect(st.error?.code).toBe('NOT_FOUND');
    } finally {
      await a.query('DROP SCHEMA IF EXISTS "It Edge" CASCADE');
      await a.end();
    }
  });
});
