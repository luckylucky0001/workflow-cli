// Seed the demo Consul agent (KV config + service catalog) with SYNTHETIC data for demo-inventory.
// Usage: node demo/scenarios/config/seed-consul.mjs [--url http://127.0.0.1:18500]   (token: CONSUL_HTTP_TOKEN)
// Idempotent: deletes config/sandbox/demo-inventory/ and the demo-inventory registrations, then rewrites
// them in several steps. Consul KV keeps NO history: only the final values and their Create/ModifyIndex
// survive — the steps exist so that ModifyIndex differs between keys. Every value here is made up.
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const URL_ = opt('url', process.env.CONSUL_URL ?? 'http://127.0.0.1:18500').replace(/\/+$/, '');
const TOKEN = process.env.CONSUL_HTTP_TOKEN;
const PREFIX = 'config/sandbox/demo-inventory/';
const SERVICE = 'demo-inventory';

async function call(method, path, body) {
  const headers = { ...(TOKEN ? { 'x-consul-token': TOKEN } : {}) };
  const r = await fetch(`${URL_}${path}`, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status} ${text}`);
  return { text, index: Number(r.headers.get('x-consul-index') ?? 0) };
}
const put = (key, value) => call('PUT', `/v1/kv/${key}`, typeof value === 'string' ? value : JSON.stringify(value));
const kvIndex = async () => (await call('GET', `/v1/kv/${PREFIX}?recurse`).catch(() => ({ index: 0 }))).index;

const steps = [];
const step = async (label) => steps.push({ label, index: await kvIndex() });

// 0. reset
await call('DELETE', `/v1/kv/${PREFIX}?recurse`);
for (const id of ['inventory-1', 'inventory-2', 'inventory-3']) await call('PUT', `/v1/agent/service/deregister/${id}`).catch(() => undefined);
steps.push({ label: 'reset', index: (await call('GET', '/v1/kv/?keys&separator=/')).index });

// 1. initial config
await put(`${PREFIX}cache.ttl_seconds`, '120');
await put(`${PREFIX}db.pool_size`, '8');
await put(`${PREFIX}db.password`, 'synthetic-consul-password-v1');
await put(`${PREFIX}warehouse.default`, 'wh-east');
await put(`${PREFIX}upstream.order`, { url: 'http://order.sandbox.invalid', timeout_ms: 500, api_key: 'synthetic-api-key-v1' });
await step('v1 initial config');

// 2. tuning + rotation (old values are gone for good: Consul KV has no history)
await put(`${PREFIX}cache.ttl_seconds`, '30');
await put(`${PREFIX}db.password`, 'synthetic-consul-password-v2');
await put(`${PREFIX}feature.flags`, { reserve_on_cart: true, rollout_percent: 50 });
await step('v2 tuning + rotation');

// service registrations: one passing, one with a critical TTL check, one in warning
const reg = (id, port, version, ttlStatus) =>
  call('PUT', '/v1/agent/service/register', {
    ID: id,
    Name: SERVICE,
    Address: `10.88.1.${port - 9080}`,
    Port: port,
    Tags: ['sandbox', `v${version}`],
    Meta: { version, env: 'sandbox' },
    Checks: [{ CheckID: `${id}-ttl`, Name: 'app heartbeat (TTL)', TTL: '87600h', Status: ttlStatus }],
  });
await reg('inventory-1', 9081, '2.1.0', 'passing');
await reg('inventory-2', 9082, '2.1.0', 'critical');
await reg('inventory-3', 9083, '2.0.3', 'warning');
await call('PUT', '/v1/agent/check/pass/inventory-1-ttl?note=synthetic%20ok');
await call('PUT', '/v1/agent/check/fail/inventory-2-ttl?note=synthetic%20failure%3A%20db%20unreachable');
await call('PUT', '/v1/agent/check/warn/inventory-3-ttl?note=synthetic%20slow%20responses');
await step('registrations');

const kv = JSON.parse((await call('GET', `/v1/kv/${PREFIX}?recurse`)).text);
const self = JSON.parse((await call('GET', '/v1/agent/self')).text);
console.log(JSON.stringify({ consul: URL_, version: self.Config?.Version, config_prefix: PREFIX, service: SERVICE, keys: kv.map((k) => ({ key: k.Key, create_index: k.CreateIndex, modify_index: k.ModifyIndex })), steps }, null, 2));
