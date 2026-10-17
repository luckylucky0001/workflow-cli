#!/usr/bin/env node
// Open-loop load generator for demo-order (Node 22, no dependencies).
//   node demo/scenarios/latency/loadgen.mjs --rps 20 --duration 120 --customer-ratio 0.3 --seed 42
// The request sequence is deterministic for a given --seed, so a baseline run and a
// run after fault injection send the same requests. Prints a JSON summary of what was
// actually measured (latency percentiles, status codes, slowest trace ids).
import { writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
    return acc;
  }, []),
);
const URL_BASE = (args.url ?? process.env.DEMO_ORDER_URL ?? 'http://127.0.0.1:18081').replace(/\/$/, '');
const RPS = Number(args.rps ?? 20);
const DURATION_S = Number(args.duration ?? 60);
const CUSTOMER_RATIO = Number(args['customer-ratio'] ?? 0.3);
const MAX_INFLIGHT = Number(args['max-inflight'] ?? 200);
const TIMEOUT_MS = Number(args.timeout ?? 10_000);
const LABEL = args.label ?? 'run';
let seed = Number(args.seed ?? 42) >>> 0;

// mulberry32: small deterministic PRNG
function rand() {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (hotMax, max, hotShare = 0.9) => 1 + Math.floor(rand() * (rand() < hotShare ? hotMax : max));

function nextRequest() {
  if (rand() < CUSTOMER_RATIO) return { route: '/customers/:id/orders', path: `/customers/${pick(300, 20000)}/orders` };
  return { route: '/orders/:id', path: `/orders/${pick(2000, 300000)}` };
}

const results = [];
let inflight = 0;
let dropped = 0;

async function fire(req) {
  if (inflight >= MAX_INFLIGHT) {
    dropped++;
    return;
  }
  inflight++;
  const t0 = performance.now();
  const rec = { route: req.route, path: req.path, at: new Date().toISOString(), status: 0, ms: 0, trace_id: null, error: null };
  try {
    const r = await fetch(URL_BASE + req.path, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    await r.arrayBuffer();
    rec.status = r.status;
    rec.trace_id = r.headers.get('x-trace-id');
  } catch (e) {
    rec.error = e.name === 'TimeoutError' ? 'client_timeout' : e.cause?.code ?? e.message;
  } finally {
    rec.ms = performance.now() - t0;
    inflight--;
    results.push(rec);
  }
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, idx)] * 10) / 10;
}

function summarize(list) {
  const ms = list.map((r) => r.ms).sort((a, b) => a - b);
  const codes = {};
  for (const r of list) codes[r.error ? `error:${r.error}` : r.status] = (codes[r.error ? `error:${r.error}` : r.status] ?? 0) + 1;
  return {
    requests: list.length,
    codes,
    latency_ms: { p50: pct(ms, 50), p95: pct(ms, 95), p99: pct(ms, 99), max: ms.length ? Math.round(ms[ms.length - 1] * 10) / 10 : null },
  };
}

const started = new Date();
const intervalMs = 1000 / RPS;
const total = Math.round(RPS * DURATION_S);
process.stderr.write(`[loadgen ${LABEL}] ${URL_BASE} rps=${RPS} duration=${DURATION_S}s customer_ratio=${CUSTOMER_RATIO} requests=${total}\n`);
const pending = [];
const t0 = performance.now();
for (let i = 0; i < total; i++) {
  const due = t0 + i * intervalMs;
  const wait = due - performance.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  pending.push(fire(nextRequest()));
  if (i > 0 && i % (RPS * 10) === 0) process.stderr.write(`[loadgen ${LABEL}] sent ${i}/${total}, inflight ${inflight}\n`);
}
await Promise.all(pending);
const ended = new Date();

const byRoute = {};
for (const r of results) (byRoute[r.route] ??= []).push(r);
const summary = {
  label: LABEL,
  target: URL_BASE,
  started_at: started.toISOString(),
  ended_at: ended.toISOString(),
  config: { rps: RPS, duration_s: DURATION_S, customer_ratio: CUSTOMER_RATIO, seed: Number(args.seed ?? 42), max_inflight: MAX_INFLIGHT },
  dropped_due_to_inflight_limit: dropped,
  overall: summarize(results),
  by_route: Object.fromEntries(Object.entries(byRoute).map(([k, v]) => [k, summarize(v)])),
  slowest: [...results].sort((a, b) => b.ms - a.ms).slice(0, 5).map((r) => ({ path: r.path, status: r.status, ms: Math.round(r.ms), trace_id: r.trace_id, at: r.at })),
};
const out = JSON.stringify(summary, null, 2);
if (args.out) writeFileSync(args.out, out);
console.log(out);
