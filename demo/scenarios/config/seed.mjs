// Seed the demo etcd (config center + service registry) with SYNTHETIC data for demo-order.
// Usage: node demo/scenarios/config/seed.mjs [--url http://127.0.0.1:12379] [--ttl 86400]
// Idempotent: clears /config/sandbox/demo-order/ and /services/demo-order/ (revoking their leases) and
// rewrites them in several steps so that real revision history exists. Every value here is made up.
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const URL_ = (opt('url', process.env.ETCD_URL ?? 'http://127.0.0.1:12379')).replace(/\/+$/, '');
const TTL = Number(opt('ttl', '86400'));
const CONFIG = '/config/sandbox/demo-order/';
const SERVICES = '/services/demo-order/';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const prefixEnd = (p) => {
  const b = Buffer.from(p, 'utf8');
  b[b.length - 1] += 1;
  return b.toString('base64');
};

async function call(path, body) {
  const r = await fetch(`${URL_}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(`${path}: HTTP ${r.status} ${j.message ?? j.error}`);
  return j;
}
const put = async (key, value, lease) => Number((await call('/v3/kv/put', { key: b64(key), value: b64(typeof value === 'string' ? value : JSON.stringify(value)), ...(lease ? { lease } : {}) })).header.revision);
const del = async (key) => Number((await call('/v3/kv/deleterange', { key: b64(key) })).header.revision);

const steps = [];
const step = (label, revision) => steps.push({ label, revision });

// 0. reset: revoke leases attached to old registrations, then delete both prefixes
const old = await call('/v3/kv/range', { key: b64(SERVICES), range_end: prefixEnd(SERVICES) });
for (const lease of new Set((old.kvs ?? []).map((kv) => kv.lease).filter((l) => l && l !== '0'))) {
  await call('/v3/lease/revoke', { ID: lease }).catch(() => undefined);
}
await call('/v3/kv/deleterange', { key: b64(SERVICES), range_end: prefixEnd(SERVICES) });
step('reset', Number((await call('/v3/kv/deleterange', { key: b64(CONFIG), range_end: prefixEnd(CONFIG) })).header.revision));

// 1. initial release config (v1)
await put(`${CONFIG}cache.mode`, 'read-through');
await put(`${CONFIG}cache.ttl_seconds`, '300');
await put(`${CONFIG}db.pool_size`, '10');
await put(`${CONFIG}db.password`, 'synthetic-demo-password-v1');
await put(`${CONFIG}feature.flags`, { new_checkout: false, async_audit: true, rollout_percent: 0 });
await put(`${CONFIG}feature.legacy_mode`, 'on');
step('v1 initial config', await put(`${CONFIG}upstream.payment`, { url: 'http://payment.sandbox.invalid', timeout_ms: 800, token: 'synthetic-token-v1' }));

// 2. feature rollout (v2): flags changed, pool enlarged, legacy flag removed
await put(`${CONFIG}feature.flags`, { new_checkout: true, async_audit: true, rollout_percent: 20 });
await put(`${CONFIG}db.pool_size`, '20');
step('v2 feature rollout', await del(`${CONFIG}feature.legacy_mode`));

// 3. cache tuning + credential rotation (v3)
await put(`${CONFIG}cache.ttl_seconds`, '60');
await put(`${CONFIG}cache.max_entries`, '10000');
await put(`${CONFIG}db.password`, 'synthetic-demo-password-v2');
step('v3 cache tuning + rotation', await put(`${CONFIG}upstream.payment`, { url: 'http://payment.sandbox.invalid', timeout_ms: 1500, token: 'synthetic-token-v2' }));

// 4. a rewrite with the same value (shows up as rewritten_same_value, not as a change)
step('v4 same-value rewrite of cache.mode', await put(`${CONFIG}cache.mode`, 'read-through'));

// service registrations: two leased instances, one registration without a lease (never expires)
const now = new Date().toISOString();
const lease = async () => (await call('/v3/lease/grant', { TTL: String(TTL) })).ID;
const l1 = await lease();
const l2 = await lease();
await put(`${SERVICES}order-1`, { address: '10.88.0.11', port: 8080, version: '1.4.2', healthy: true, env: 'sandbox', registered_at: now }, l1);
await put(`${SERVICES}order-2`, { address: '10.88.0.12', port: 8080, version: '1.4.2', healthy: false, env: 'sandbox', registered_at: now }, l2);
step('registrations', await put(`${SERVICES}order-legacy`, { address: '10.88.0.9', port: 8080, version: '1.3.0', healthy: true, env: 'sandbox', registered_at: '2026-01-05T08:00:00Z' }));

console.log(JSON.stringify({ etcd: URL_, config_prefix: CONFIG, discovery_prefix: SERVICES, lease_ttl_s: TTL, leases: [l1, l2], steps }, null, 2));
