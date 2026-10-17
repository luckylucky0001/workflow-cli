// Seed the demo Jenkins (demo/environment docker-compose service `jenkins`) with a deterministic
// sequence of deploy builds of job deploy-demo-order via the REST API (basic auth + crumb):
//   v1.4.0 success, v1.4.1 success, v1.4.2-bad failure, v1.4.1 redeploy success.
// Usage: node demo/scenarios/deploy/seed-jenkins.mjs [--url http://127.0.0.1:18091] [--force]
// Idempotent: skips when the job already has >= 4 builds unless --force.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const url = (args[args.indexOf('--url') + 1] && args.includes('--url') ? args[args.indexOf('--url') + 1] : 'http://127.0.0.1:18091').replace(/\/$/, '');
const force = args.includes('--force');
const job = 'deploy-demo-order';
const password = readFileSync(join(here, '../../environment/.runtime/secrets/jenkins_admin_password'), 'utf8').trim();
const auth = `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`;
const SEQUENCE = ['v1.4.0', 'v1.4.1', 'v1.4.2-bad', 'v1.4.1'];

async function get(path) {
  const r = await fetch(`${url}${path}`, { headers: { authorization: auth } });
  if (!r.ok) throw new Error(`GET ${path} -> HTTP ${r.status}`);
  return r.json();
}

async function waitReady() {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`${url}/job/${job}/api/json`, { headers: { authorization: auth } });
      if (r.ok) return r.headers.get('x-jenkins');
    } catch {
      /* starting */
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error(`Jenkins at ${url} not ready (job ${job})`);
}

async function crumb() {
  // crumbs are bound to the web session since Jenkins 2.176: keep the cookie
  const r = await fetch(`${url}/crumbIssuer/api/json`, { headers: { authorization: auth } });
  if (!r.ok) throw new Error(`crumbIssuer -> HTTP ${r.status}`);
  const c = await r.json();
  const cookie = (r.headers.getSetCookie?.() ?? []).map((x) => x.split(';')[0]).join('; ');
  return { [c.crumbRequestField]: c.crumb, ...(cookie ? { cookie } : {}) };
}

async function build(version, headers) {
  const q = new URLSearchParams({ SERVICE: 'demo-order', VERSION: version, ENV: 'sandbox' });
  const before = (await get(`/job/${job}/api/json?tree=nextBuildNumber`)).nextBuildNumber;
  const r = await fetch(`${url}/job/${job}/buildWithParameters?${q}`, { method: 'POST', headers: { authorization: auth, ...headers } });
  if (r.status !== 201) throw new Error(`buildWithParameters ${version} -> HTTP ${r.status}`);
  // wait until that build exists and finished (builds run one after another for a deterministic order)
  for (let i = 0; i < 60; i++) {
    await new Promise((res) => setTimeout(res, 1500));
    try {
      const b = await get(`/job/${job}/${before}/api/json?tree=number,result,building`);
      if (!b.building && b.result) return b;
    } catch {
      /* still queued */
    }
  }
  throw new Error(`build #${before} (${version}) did not finish`);
}

const version = await waitReady();
const existing = (await get(`/job/${job}/api/json?tree=builds[number]`)).builds ?? [];
if (existing.length >= SEQUENCE.length && !force) {
  console.log(`Jenkins ${version}: job ${job} already has ${existing.length} builds; skip (use --force to add another sequence)`);
} else {
  const headers = await crumb();
  for (const v of SEQUENCE) {
    const b = await build(v, headers);
    console.log(`#${b.number} VERSION=${v} -> ${b.result}`);
  }
  console.log(`Jenkins ${version}: seeded ${SEQUENCE.length} builds of ${job}`);
}
