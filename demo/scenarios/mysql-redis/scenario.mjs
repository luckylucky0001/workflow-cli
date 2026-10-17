#!/usr/bin/env node
// workctl demo scenario helpers for the MySQL / Redis domains. All data is synthetic.
//
//   node demo/scenarios/mysql-redis/scenario.mjs warm-cache [--flush]
//   node demo/scenarios/mysql-redis/scenario.mjs mysql-load [--seconds 20] [--concurrency 4]
//   node demo/scenarios/mysql-redis/scenario.mjs lock-wait  [--seconds 20]
//   node demo/scenarios/mysql-redis/scenario.mjs redis-traffic [--seconds 10]
//
// Uses only dependencies already in the repo (mysql2, ioredis). Connects as the demo
// application account `demo_app` (password read from demo/environment/.runtime/secrets,
// never printed). Override with MYSQL_HOST/MYSQL_PORT/REDIS_HOST/REDIS_PORT.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import Redis from 'ioredis';

const here = dirname(fileURLToPath(import.meta.url));
const secrets = resolve(here, '../../environment/.runtime/secrets');
const args = process.argv.slice(2);
const mode = args[0];
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);

function mysqlConfig() {
  return {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 13306),
    user: 'demo_app',
    password: readFileSync(resolve(secrets, 'mysql_app_password'), 'utf8').trim(),
    database: 'demo',
  };
}
function redisClient() {
  return new Redis({ host: process.env.REDIS_HOST ?? '127.0.0.1', port: Number(process.env.REDIS_PORT ?? 16379), maxRetriesPerRequest: 1 });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg, extra = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), scenario: mode, msg, ...extra }));

async function warmCache() {
  const db = await mysql.createConnection(mysqlConfig());
  const r = redisClient();
  try {
    if (flag('flush')) {
      let cursor = '0';
      let n = 0;
      do {
        const [next, keys] = await r.scan(cursor, 'MATCH', 'demo:*', 'COUNT', 500);
        if (keys.length) n += await r.unlink(...keys);
        cursor = next;
      } while (cursor !== '0');
      log('flushed demo:* keys', { removed: n });
    }
    // 1) order snapshots — same shape as demo-order's cache-aside (JSON of SELECT * row)
    const [orders] = await db.query('SELECT * FROM orders WHERE id <= 3000');
    let p = r.pipeline();
    for (const o of orders) {
      // ~10% without TTL (PTTL -1) so key inspect shows both cases
      if (o.id % 10 === 0) p.set(`demo:order:${o.id}`, JSON.stringify(o));
      else p.set(`demo:order:${o.id}`, JSON.stringify(o), 'EX', 1800 + (o.id % 600));
    }
    await p.exec();
    log('warmed order snapshots', { keys: orders.length, pattern: 'demo:order:<id>' });

    // 2) per-customer recent orders (one full scan, grouped client-side) + big history lists
    const [rows] = await db.query('SELECT id, customer_id, status, amount, created_at FROM orders WHERE customer_id <= 300 ORDER BY created_at DESC');
    const byCustomer = new Map();
    for (const row of rows) {
      if (!byCustomer.has(row.customer_id)) byCustomer.set(row.customer_id, []);
      byCustomer.get(row.customer_id).push(row);
    }
    p = r.pipeline();
    let lists = 0;
    for (const [cid, list] of byCustomer) {
      const recent = list.slice(0, 20).map(({ id, status, amount, created_at }) => ({ id, status, amount, created_at }));
      p.set(`demo:customer:${cid}:recent`, JSON.stringify(recent), 'EX', 1800);
      if (cid <= 20) {
        // big keys: full order history as a list (hundreds of JSON items)
        const key = `demo:customer:${cid}:history`;
        p.del(key);
        for (let k = 0; k < list.length; k += 200) p.rpush(key, ...list.slice(k, k + 200).map((x) => JSON.stringify({ ...x, note: 'synthetic order history entry for workctl demo' })));
        lists++;
      }
    }
    await p.exec();
    log('warmed customer keys', { recent: byCustomer.size, history_lists: lists, patterns: ['demo:customer:<id>:recent', 'demo:customer:<id>:history'] });

    // 3) profiles (hash, no TTL) — synthetic, no contact data
    const [customers] = await db.query('SELECT id, name, city, created_at FROM customers WHERE id <= 500');
    p = r.pipeline();
    for (const c of customers) p.hset(`demo:customer:${c.id}:profile`, { name: c.name, city: c.city, since: c.created_at.toISOString().slice(0, 10) });
    await p.exec();
    log('warmed profiles', { keys: customers.length, pattern: 'demo:customer:<id>:profile' });

    // 4) a large sorted set and a large string (big-key candidates)
    const [daily] = await db.query(
      "SELECT customer_id, SUM(amount) AS total FROM orders WHERE created_at >= '2026-10-16' AND created_at < '2026-10-17' GROUP BY customer_id",
    );
    p = r.pipeline();
    p.del('demo:leaderboard:amount:2026-10-16');
    for (let k = 0; k < daily.length; k += 500) {
      const chunk = daily.slice(k, k + 500).flatMap((d) => [Number(d.total), `customer:${d.customer_id}`]);
      p.zadd('demo:leaderboard:amount:2026-10-16', ...chunk);
    }
    await p.exec();
    const [exportRows] = await db.query("SELECT id, customer_id, status, amount FROM orders WHERE created_at >= '2026-10-16' AND created_at < '2026-10-16 06:00:00'");
    await r.set('demo:export:orders:2026-10-16T00', JSON.stringify(exportRows), 'EX', 7200);
    log('warmed big keys', { zset_members: daily.length, export_rows: exportRows.length, keys: ['demo:leaderboard:amount:2026-10-16', 'demo:export:orders:2026-10-16T00'] });

    // 5) skewed reads so LFU counters / hits / misses / slowlog have something real
    await redisTraffic(r, 1);
    log('done', { dbsize: await r.dbsize() });
  } finally {
    await db.end();
    r.disconnect();
  }
}

async function redisTraffic(r, seconds) {
  const until = Date.now() + seconds * 1000;
  let ops = 0;
  do {
    const p = r.pipeline();
    for (let k = 0; k < 200; k++) p.get(`demo:order:${1 + (k % 10)}`); // hot
    for (let k = 0; k < 50; k++) p.hgetall(`demo:customer:${1 + (k % 5)}:profile`);
    for (let k = 0; k < 20; k++) p.get(`demo:order:${900000 + k}`); // misses
    await p.exec();
    ops += 270;
  } while (Date.now() < until);
  // a few intentionally heavy commands (> slowlog-log-slower-than=1ms on the demo instance)
  await r.lrange('demo:customer:1:history', 0, -1);
  await r.zrange('demo:leaderboard:amount:2026-10-16', 0, -1, 'WITHSCORES');
  await r.get('demo:export:orders:2026-10-16T00');
  log('redis traffic', { ops: ops + 3 });
}

async function mysqlLoad() {
  const seconds = Number(opt('seconds', 20));
  const conc = Number(opt('concurrency', 4));
  const pool = mysql.createPool({ ...mysqlConfig(), connectionLimit: conc });
  const until = Date.now() + seconds * 1000;
  let n = 0;
  let byId = 0;
  const worker = async (w) => {
    while (Date.now() < until) {
      const cid = 100 + ((n * 7919 + w) % 19000); // non-hot customers: scan most of idx_created_at
      await pool.query('SELECT id, status, amount, created_at FROM orders WHERE customer_id = ? ORDER BY created_at DESC LIMIT 20', [cid]);
      n++;
      for (let k = 0; k < 5; k++) {
        await pool.query('SELECT * FROM orders WHERE id = ?', [1 + ((n * 31 + k) % 300000)]);
        byId++;
      }
    }
  };
  await Promise.all(Array.from({ length: conc }, (_, w) => worker(w)));
  await pool.end();
  log('mysql load finished', { customer_queries: n, by_id_queries: byId, seconds, concurrency: conc });
}

async function lockWait() {
  const seconds = Number(opt('seconds', 20));
  const holder = await mysql.createConnection(mysqlConfig());
  const waiter = await mysql.createConnection(mysqlConfig());
  try {
    await holder.query('START TRANSACTION');
    await holder.query("UPDATE orders SET updated_at = updated_at WHERE id = 42");
    log('holder: row id=42 locked (transaction left open, idle)', { seconds });
    await waiter.query(`SET SESSION innodb_lock_wait_timeout = ${Math.max(1, seconds)}`);
    const t0 = Date.now();
    const p = waiter.query("UPDATE orders SET updated_at = updated_at WHERE id = 42").then(
      () => log('waiter: acquired lock', { waited_ms: Date.now() - t0 }),
      (e) => log('waiter: gave up', { code: e.code, waited_ms: Date.now() - t0 }),
    );
    await sleep(seconds * 1000 - 500);
    await holder.query('ROLLBACK');
    await p;
    await waiter.query('ROLLBACK');
  } finally {
    await holder.end();
    await waiter.end();
  }
}

const modes = {
  'warm-cache': warmCache,
  'mysql-load': mysqlLoad,
  'lock-wait': lockWait,
  'redis-traffic': async () => {
    const r = redisClient();
    try {
      await redisTraffic(r, Number(opt('seconds', 10)));
    } finally {
      r.disconnect();
    }
  },
};
if (!modes[mode]) {
  console.error(`usage: scenario.mjs <${Object.keys(modes).join('|')}> [options]`);
  process.exit(2);
}
modes[mode]().catch((e) => {
  console.error(JSON.stringify({ scenario: mode, error: e.code ?? e.name, message: e.message }));
  process.exit(1);
});
