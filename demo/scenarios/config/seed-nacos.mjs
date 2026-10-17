// Seed the demo Nacos (config center + naming) with SYNTHETIC data for demo-payment.
// Usage: node demo/scenarios/config/seed-nacos.mjs [--url http://127.0.0.1:18848/nacos]
// (auth-enabled servers: NACOS_USERNAME / NACOS_PASSWORD → POST /v1/auth/login)
// Idempotent: (re)creates namespace `sandbox`, rewrites sandbox/DEFAULT_GROUP/demo-payment.properties in
// three steps (each publish adds a Nacos history record; earlier history records are kept) and
// re-registers three PERSISTENT instances (server-side TCP checks, no heartbeats needed):
//   127.0.0.1:8848 (reachable from the Nacos container → healthy), 127.0.0.1:9 (nothing listens →
//   unhealthy), 127.0.0.2:8848 (enabled=false: offline but still registered). Every value here is made up.
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const BASE = opt('url', process.env.NACOS_URL ?? 'http://127.0.0.1:18848/nacos').replace(/\/+$/, '');
const NS = 'sandbox';
const GROUP = 'DEFAULT_GROUP';
const DATA_ID = 'demo-payment.properties';
const SERVICE = 'demo-payment';

let token = null;
if (process.env.NACOS_USERNAME) {
  const r = await fetch(`${BASE}/v1/auth/login`, { method: 'POST', body: new URLSearchParams({ username: process.env.NACOS_USERNAME, password: process.env.NACOS_PASSWORD ?? '' }) });
  if (!r.ok) throw new Error(`login: HTTP ${r.status} ${await r.text()}`);
  token = (await r.json()).accessToken;
}

async function call(method, path, params = {}, okStatuses = []) {
  const qs = new URLSearchParams({ ...params, ...(token ? { accessToken: token } : {}) });
  const isBody = method === 'POST' || method === 'PUT';
  const r = await fetch(`${BASE}${path}${isBody ? '' : `?${qs}`}`, { method, ...(isBody ? { body: qs } : {}) });
  const text = await r.text();
  if (!r.ok && !okStatuses.includes(r.status)) throw new Error(`${method} ${path}: HTTP ${r.status} ${text}`);
  return text;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const latestHistoryId = async () => {
  const j = JSON.parse(await call('GET', '/v2/cs/history/list', { dataId: DATA_ID, group: GROUP, namespaceId: NS, pageNo: '1', pageSize: '1' }));
  return Number(j.data?.pageItems?.[0]?.id ?? 0);
};
const steps = [];
const publish = async (label, lines) => {
  const ok = await call('POST', '/v1/cs/configs', { dataId: DATA_ID, group: GROUP, tenant: NS, type: 'properties', content: lines.join('\n') + '\n' });
  if (ok.trim() !== 'true') throw new Error(`publish ${label}: ${ok}`);
  await sleep(300);
  steps.push({ label, history_id: await latestHistoryId() });
};

// 0. namespace + reset (a delete is itself a history record "D")
const nsList = JSON.parse(await call('GET', '/v1/console/namespaces'));
if (!(nsList.data ?? []).some((n) => n.namespace === NS)) await call('POST', '/v1/console/namespaces', { customNamespaceId: NS, namespaceName: NS, namespaceDesc: 'workctl demo (synthetic)' });
await call('DELETE', '/v1/cs/configs', { dataId: DATA_ID, group: GROUP, tenant: NS });
await sleep(300);
steps.push({ label: 'reset', history_id: await latestHistoryId() });

// 1. initial config
await publish('v1 initial config', [
  '# demo-payment (synthetic)',
  'order.timeout_ms=800',
  'pay.channel.default=alipay-sandbox',
  'db.url=jdbc:mysql://mysql.sandbox.invalid:3306/pay',
  'db.password=synthetic-nacos-password-v1',
  'feature.refund_v2=false',
  'legacy.callback=on',
]);
// 2. rollout: timeout raised, refund v2 on, legacy flag removed, new risk limit
await publish('v2 rollout', [
  '# demo-payment (synthetic)',
  'order.timeout_ms=1500',
  'pay.channel.default=alipay-sandbox',
  'db.url=jdbc:mysql://mysql.sandbox.invalid:3306/pay',
  'db.password=synthetic-nacos-password-v1',
  'feature.refund_v2=true',
  'risk.max_amount=5000',
]);
// 3. credential rotation + callback token
await publish('v3 rotation', [
  '# demo-payment (synthetic)',
  'order.timeout_ms=1500',
  'pay.channel.default=alipay-sandbox',
  'db.url=jdbc:mysql://mysql.sandbox.invalid:3306/pay',
  'db.password=synthetic-nacos-password-v2',
  'feature.refund_v2=true',
  'risk.max_amount=5000',
  'callback.token=synthetic-callback-token',
]);

// registrations (persistent instances)
const inst = [
  { ip: '127.0.0.1', port: '8848', enabled: 'true', metadata: { version: '3.2.0', env: 'sandbox', zone: 'az1' } },
  { ip: '127.0.0.1', port: '9', enabled: 'true', metadata: { version: '3.2.0', env: 'sandbox', zone: 'az2' } },
  { ip: '127.0.0.2', port: '8848', enabled: 'false', metadata: { version: '3.1.9', env: 'sandbox', zone: 'az1' } },
];
const common = { serviceName: SERVICE, groupName: GROUP, namespaceId: NS, ephemeral: 'false' };
for (const x of inst) await call('DELETE', '/v1/ns/instance', { ...common, ip: x.ip, port: x.port }, [400, 404, 500]);
for (const x of inst) await call('POST', '/v1/ns/instance', { ...common, ip: x.ip, port: x.port, enabled: x.enabled, weight: '1', metadata: JSON.stringify(x.metadata) });
// wait for the server-side TCP check to mark 127.0.0.1:9 unhealthy
// (registration and health are applied asynchronously: start after a pause and require two consecutive
// matching reads, otherwise a stale state from before the re-registration can be mistaken for the result)
let hosts = [];
let stable = 0;
await sleep(2000);
for (let t = 0; t < 60; t++) {
  // registration is applied asynchronously: the cluster may not exist for a moment (404)
  const txt = await call('GET', '/v1/ns/catalog/instances', { serviceName: SERVICE, groupName: GROUP, namespaceId: NS, clusterName: 'DEFAULT', pageNo: '1', pageSize: '100' }, [404]);
  try {
    hosts = JSON.parse(txt).list ?? [];
  } catch {
    hosts = [];
  }
  const bad = hosts.find((h) => h.port === 9);
  const good = hosts.find((h) => h.ip === '127.0.0.1' && h.port === 8848);
  if (hosts.length === 3 && bad && bad.healthy === false && good?.healthy === true) {
    if (++stable >= 2) break;
  } else stable = 0;
  await sleep(1000);
}
const state = JSON.parse(await call('GET', '/v1/console/server/state'));
console.log(
  JSON.stringify(
    { nacos: BASE, version: state.version, namespace: NS, group: GROUP, data_id: DATA_ID, service: SERVICE, steps, instances: hosts.map((h) => ({ id: h.instanceId, healthy: h.healthy, enabled: h.enabled, ephemeral: h.ephemeral })) },
    null,
    2,
  ),
);
