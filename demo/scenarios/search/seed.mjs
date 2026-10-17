#!/usr/bin/env node
// Seed the demo OpenSearch (demo-search, http://127.0.0.1:19200) with deterministic synthetic orders.
//   demo-orders          2 primary shards, 0 replicas, explicit mapping, 3000 docs (synthetic)
//   demo-orders-archive  1 primary shard, 1 replica (cannot be assigned on a single node -> yellow),
//                        legacy mapping WITHOUT created_at, 400 docs (synthetic)
//   alias demo-orders-current -> demo-orders (write index)
//   alias demo-orders-all     -> demo-orders + demo-orders-archive
// Re-running recreates both indices (same seed -> same documents).
// Usage: node demo/scenarios/search/seed.mjs [--url http://127.0.0.1:19200]
const args = process.argv.slice(2);
const urlIdx = args.indexOf('--url');
const BASE = (urlIdx >= 0 ? args[urlIdx + 1] : process.env.OPENSEARCH_URL) ?? 'http://127.0.0.1:19200';

const CURRENT = 'demo-orders';
const ARCHIVE = 'demo-orders-archive';
const N_CURRENT = 3000;
const N_ARCHIVE = 400;

// mulberry32: tiny deterministic PRNG so every run produces identical documents
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STATUSES = [
  ['paid', 30],
  ['shipped', 25],
  ['delivered', 25],
  ['created', 10],
  ['cancelled', 6],
  ['refunded', 4],
];
const CITIES = ['shanghai', 'beijing', 'shenzhen', 'hangzhou', 'chengdu', 'wuhan', 'nanjing', 'xian'];
const NOTES = [
  'express delivery requested',
  'gift wrap please',
  'customer called about delay',
  'address changed after payment',
  'leave at the front desk',
  'synthetic order for demo',
  'coupon applied at checkout',
  'deliver after 6pm',
];

function weighted(rand, table) {
  const total = table.reduce((s, [, w]) => s + w, 0);
  let x = rand() * total;
  for (const [v, w] of table) {
    if ((x -= w) < 0) return v;
  }
  return table[table.length - 1][0];
}

function makeDocs(n, seed, prefix, startMs, spanMs) {
  const rand = prng(seed);
  const docs = [];
  for (let i = 1; i <= n; i++) {
    const created = new Date(startMs + Math.floor(rand() * spanMs));
    created.setUTCMilliseconds(0);
    docs.push({
      order_id: `${prefix}-${String(i).padStart(6, '0')}`,
      customer_id: 10000 + Math.floor(rand() * 800),
      status: weighted(rand, STATUSES),
      amount: Math.round((5 + rand() * rand() * 2000) * 100) / 100,
      city: CITIES[Math.floor(rand() * CITIES.length)],
      created_at: created.toISOString(),
      note: rand() < 0.6 ? NOTES[Math.floor(rand() * NOTES.length)] : '',
      synthetic: true,
    });
  }
  return docs;
}

async function os(method, path, body, ndjson = false) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': ndjson ? 'application/x-ndjson' : 'application/json' },
    body: body === undefined ? undefined : ndjson ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

async function must(method, path, body, ndjson) {
  const r = await os(method, path, body, ndjson);
  if (r.status >= 300) throw new Error(`${method} ${path} -> HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 400)}`);
  return r.json;
}

async function bulk(index, docs) {
  for (let i = 0; i < docs.length; i += 1000) {
    const chunk = docs.slice(i, i + 1000);
    const body = chunk.map((d) => `${JSON.stringify({ index: { _index: index, _id: d.order_id } })}\n${JSON.stringify(d)}\n`).join('');
    const r = await must('POST', '/_bulk', body, true);
    if (r.errors) throw new Error(`bulk into ${index} reported item errors: ${JSON.stringify(r.items.find((x) => x.index?.error)).slice(0, 400)}`);
  }
}

const info = await must('GET', '/');
console.log(`OpenSearch ${info.version?.distribution ?? '?'} ${info.version?.number ?? '?'} at ${BASE}`);

for (const idx of [CURRENT, ARCHIVE]) {
  const r = await os('DELETE', `/${idx}`);
  if (r.status !== 200 && r.status !== 404) throw new Error(`DELETE /${idx} -> HTTP ${r.status}`);
}

await must('PUT', `/${CURRENT}`, {
  settings: { number_of_shards: 2, number_of_replicas: 0, refresh_interval: '1s' },
  mappings: {
    dynamic: 'strict',
    properties: {
      order_id: { type: 'keyword' },
      customer_id: { type: 'long' },
      status: { type: 'keyword' },
      amount: { type: 'double' },
      city: { type: 'keyword' },
      created_at: { type: 'date' },
      note: { type: 'text' },
      synthetic: { type: 'boolean' },
    },
  },
  aliases: { 'demo-orders-current': { is_write_index: true }, 'demo-orders-all': {} },
});
// legacy archive: amount stored as keyword and no created_at field (mapping drift on purpose)
await must('PUT', `/${ARCHIVE}`, {
  settings: { number_of_shards: 1, number_of_replicas: 1 },
  mappings: {
    dynamic: 'strict',
    properties: {
      order_id: { type: 'keyword' },
      customer_id: { type: 'long' },
      status: { type: 'keyword' },
      amount: { type: 'keyword' },
      city: { type: 'keyword' },
      note: { type: 'text' },
      synthetic: { type: 'boolean' },
    },
  },
  aliases: { 'demo-orders-all': {} },
});

const day = 86_400_000;
const current = makeDocs(N_CURRENT, 20261017, 'ORD', Date.UTC(2026, 8, 1), 45 * day);
const archive = makeDocs(N_ARCHIVE, 20250101, 'ARC', Date.UTC(2025, 0, 1), 180 * day).map(({ created_at, ...d }) => ({ ...d, amount: String(d.amount) }));
await bulk(CURRENT, current);
await bulk(ARCHIVE, archive);
await must('POST', `/${CURRENT},${ARCHIVE}/_refresh`);

const counts = await must('GET', `/_cat/indices/${CURRENT},${ARCHIVE}?format=json&h=index,health,pri,rep,docs.count`);
const health = await must('GET', '/_cluster/health');
console.log(JSON.stringify({ indices: counts, cluster_status: health.status, unassigned_shards: health.unassigned_shards, aliases: ['demo-orders-current -> demo-orders', 'demo-orders-all -> demo-orders, demo-orders-archive'] }, null, 2));
console.log('done (synthetic data only)');
