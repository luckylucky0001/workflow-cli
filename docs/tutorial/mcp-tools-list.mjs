#!/usr/bin/env node
// 教程辅助脚本：通过 stdio 启动 `workctl mcp serve`，发送 JSON-RPC initialize → tools/list → 一次只读 tools/call，
// 打印服务信息、工具清单摘要和一次调用返回的信封要点。只读：不调用任何 execute 类工具。
//
// 用法（仓库根目录）：
//   WORKCTL_CONFIG=demo/environment/workctl.agent.yaml node docs/tutorial/mcp-tools-list.mjs
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const child = spawn(process.execPath, [join(root, 'dist/workctl.js'), 'mcp', 'serve'], { stdio: ['pipe', 'pipe', 'inherit'] });

const pending = new Map();
let buf = '';
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((res, rej) => {
    pending.set(id, res);
    setTimeout(() => rej(new Error(`${method} 超时`)), 20_000).unref();
  });
}

const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

try {
  const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tutorial', version: '0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const info = init.result;
  console.log(`→ initialize`);
  console.log(`  serverInfo: ${info.serverInfo.name} ${info.serverInfo.version}  protocolVersion: ${info.protocolVersion}`);
  console.log(`  instructions: ${info.instructions}`);

  const list = (await request('tools/list', {})).result.tools;
  const byDomain = new Map();
  for (const t of list) {
    const d = t.name.split('_')[0];
    byDomain.set(d, (byDomain.get(d) ?? 0) + 1);
  }
  console.log(`\n→ tools/list: ${list.length} 个工具`);
  console.log(`  按前缀: ${[...byDomain].map(([d, n]) => `${d}(${n})`).join(' ')}`);
  const opOf = (t) => /操作类型 (\w+)/.exec(t.description ?? '')?.[1] ?? '?';
  const ops = new Map();
  for (const t of list) ops.set(opOf(t), (ops.get(opOf(t)) ?? 0) + 1);
  console.log(`  按操作类型: ${[...ops].map(([o, n]) => `${o}(${n})`).join(' ')}`);
  for (const name of ['service_dependency_list', 'mysql_statement_summary', 'offline_run_get', 'mq_consumer_lag']) {
    const t = list.find((x) => x.name === name);
    if (!t) continue;
    const props = Object.keys(t.inputSchema?.properties ?? {});
    console.log(`  - ${t.name}: ${cut(t.title ?? t.description.split('\n')[0], 46)}`);
    console.log(`      inputSchema: {${props.join(', ')}}`);
  }

  const call = await request('tools/call', { name: 'service_dependency_list', arguments: { service: 'demo-order', env: 'sandbox' } });
  const text = call.result.content?.find((c) => c.type === 'text')?.text ?? '';
  const env = JSON.parse(text);
  console.log(`\n→ tools/call service_dependency_list {"service":"demo-order","env":"sandbox"}`);
  console.log(`  isError: ${call.result.isError ?? false}`);
  console.log(`  status: ${env.status}  capability: ${env.capability}`);
  console.log(`  data.dependencies: ${env.data.dependencies.map((d) => `${d.resource_id}(${d.relation})`).join(', ')}`);
  for (const s of env.meta.sources) console.log(`  meta.sources: ${s.system} ${s.method ?? ''} [${s.relation}]`);
  console.log(`  meta.coverage: ${JSON.stringify(env.meta.coverage)}`);
  console.log(`  context: profile=${env.context.profile} operation=${env.context.operation} adapter=${env.context.adapter}`);
} finally {
  child.stdin.end();
  child.kill();
}
