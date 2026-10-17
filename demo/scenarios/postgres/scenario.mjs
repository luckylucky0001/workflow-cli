#!/usr/bin/env node
// workctl demo: PostgreSQL scenarios (synthetic data only). Run from the repository root.
//
//   node demo/scenarios/postgres/scenario.mjs reset-stats              pg_stat_statements_reset() + pg_stat_reset()
//   node demo/scenarios/postgres/scenario.mjs load [--seconds 20] [--concurrency 4]
//        replays two queries: WHERE customer_id = $1 (no index → Seq Scan) and WHERE id = $1 (PK)
//   node demo/scenarios/postgres/scenario.mjs churn                    deterministic UPDATE of 10% of orders → n_dead_tup
//   node demo/scenarios/postgres/scenario.mjs lock-wait [--seconds 20] tx A locks orders.id=42 and stays idle in
//        transaction; tx B waits on the same row; both roll back at the end
//
// Connects as the demo superuser `postgres` (password read from
// demo/environment/.runtime/secrets/pg_superuser_password; never printed). Writes only to the
// synthetic demo_orders database. Override with PG_HOST / PG_PORT / PG_DATABASE.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const secret = join(here, '../../environment/.runtime/secrets/pg_superuser_password');
const args = process.argv.slice(2);
const mode = args[0];
const opt = (name, def) => {
  const k = args.indexOf(`--${name}`);
  return k >= 0 && args[k + 1] !== undefined ? Number(args[k + 1]) : def;
};

function config() {
  let password;
  try {
    password = readFileSync(secret, 'utf8').trim();
  } catch (e) {
    console.error(`cannot read ${secret} (run demo/environment/up.sh postgres first): ${e.message}`);
    process.exit(2);
  }
  return {
    host: process.env.PG_HOST ?? '127.0.0.1',
    port: Number(process.env.PG_PORT ?? 15432),
    user: 'postgres',
    password,
    database: process.env.PG_DATABASE ?? 'demo_orders',
    application_name: 'demo-scenario',
  };
}

async function connect(name = 'demo-scenario') {
  const c = new pg.Client({ ...config(), application_name: name });
  c.on('error', () => undefined);
  await c.connect();
  return c;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resetStats() {
  const c = await connect();
  await c.query('SELECT pg_stat_statements_reset()');
  await c.query('SELECT pg_stat_reset()');
  await c.end();
  console.log('pg_stat_statements and pg_stat_* counters reset for demo_orders');
}

async function load() {
  const seconds = opt('seconds', 20);
  const concurrency = opt('concurrency', 4);
  const until = Date.now() + seconds * 1000;
  let byCustomer = 0;
  let byId = 0;
  const worker = async (w) => {
    const c = await connect('demo-order-load');
    let k = w;
    while (Date.now() < until) {
      k++;
      // deterministic ids: customers 1..2000, orders 1..50000
      const customer = 1 + ((k * 7919) % 2000);
      await c.query('SELECT id, status, amount, created_at FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 20', [customer]);
      byCustomer++;
      const id = 1 + ((k * 104729) % 50000);
      await c.query('SELECT id, customer_id, status, amount FROM orders WHERE id = $1', [id]);
      byId++;
    }
    await c.end();
  };
  console.log(`load: ${seconds}s, concurrency ${concurrency} (customer_id lookups → Seq Scan on orders)`);
  await Promise.all(Array.from({ length: concurrency }, (_, w) => worker(w)));
  console.log(`done: ${byCustomer} customer_id lookups, ${byId} id lookups`);
}

async function churn() {
  const c = await connect();
  const r = await c.query("UPDATE orders SET updated_at = updated_at + interval '1 second' WHERE id % 10 = 0");
  await c.end();
  console.log(`updated ${r.rowCount} orders (dead tuples until (auto)vacuum; threshold 50 + 20% of rows is not reached)`);
}

async function lockWait() {
  const seconds = opt('seconds', 20);
  const a = await connect('demo-lock-holder');
  const b = await connect('demo-lock-waiter');
  const aPid = (await a.query('SELECT pg_backend_pid() AS p')).rows[0].p;
  const bPid = (await b.query('SELECT pg_backend_pid() AS p')).rows[0].p;
  await a.query('BEGIN');
  await a.query('UPDATE orders SET status = status WHERE id = 42');
  console.log(`tx A (pid ${aPid}) holds row lock on orders.id=42, idle in transaction`);
  await b.query('BEGIN');
  await b.query(`SET LOCAL lock_timeout = '${seconds + 10}s'`);
  const waiting = b.query("UPDATE orders SET status = 'paid' WHERE id = 42").catch((e) => e);
  console.log(`tx B (pid ${bPid}) waits on the same row for ~${seconds}s — run: workctl pg lock list / workctl pg session list`);
  await sleep(seconds * 1000);
  await a.query('ROLLBACK');
  await waiting;
  await b.query('ROLLBACK');
  await a.end();
  await b.end();
  console.log('both transactions rolled back');
}

const modes = { 'reset-stats': resetStats, load, churn, 'lock-wait': lockWait };
if (!modes[mode]) {
  console.error(`usage: scenario.mjs ${Object.keys(modes).join('|')} [--seconds N] [--concurrency N]`);
  process.exit(2);
}
modes[mode]().catch((e) => {
  console.error(`${mode} failed: ${e.code ?? ''} ${e.message}`);
  process.exit(1);
});
