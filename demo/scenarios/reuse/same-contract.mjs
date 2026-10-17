#!/usr/bin/env node
// Reuse proof (design §10.4): a human (CLI), a script (library API) and an Agent
// (MCP tools/call) query the same capability. All three go through the same engine
// and must return the same contract. Run from the repo root after `npm run build`:
//   WORKCTL_CONFIG=demo/environment/workctl.yaml node demo/scenarios/reuse/same-contract.mjs [capability] [json-inputs]
import { spawn, spawnSync } from 'node:child_process';
import { createClient } from '../../../dist/index.js';

const capability = process.argv[2] ?? 'redis.info.get';
const inputs = JSON.parse(process.argv[3] ?? '{"instance":"demo-redis","section":"memory"}');
const cli = 'dist/workctl.js';

// 1) human / shell: the CLI
const cap = createClient().registry.get(capability);
if (!cap) throw new Error(`unknown capability ${capability}`);
const flags = Object.entries(inputs).flatMap(([k, v]) => [`--${k.replace(/_/g, '-')}`, String(v)]);
const viaCli = JSON.parse(spawnSync(process.execPath, [cli, '--json', ...cap.command.split(' '), ...flags], { encoding: 'utf8' }).stdout);

// 2) script: programmatic API
const viaScript = await createClient().invoke(capability, inputs);

// 3) agent: MCP over stdio
const viaMcp = await new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [cli, 'mcp', 'serve'], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d;
    for (const line of buf.split('\n').slice(0, -1)) {
      const msg = JSON.parse(line);
      if (msg.id === 2) {
        p.kill();
        resolve(msg.result.structuredContent);
      }
    }
    buf = buf.slice(buf.lastIndexOf('\n') + 1);
  });
  p.on('error', reject);
  const send = (m) => p.stdin.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'reuse-proof', version: '0' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: capability.replace(/\./g, '_'), arguments: inputs } });
});

const shape = (env) => ({
  status: env.status,
  capability: env.capability,
  capability_version: env.context.capability_version,
  adapter: env.context.adapter,
  data_keys: env.data ? Object.keys(env.data).sort().join(',') : null,
  source: env.meta.sources.map((s) => `${s.system}:${s.adapter}`).join(';'),
  error: env.error?.code ?? null,
});
const rows = { cli: shape(viaCli), script: shape(viaScript), mcp: shape(viaMcp) };
console.table(rows);
const same = JSON.stringify(rows.cli) === JSON.stringify(rows.script) && JSON.stringify(rows.script) === JSON.stringify(rows.mcp);
console.log(same ? 'SAME CONTRACT: cli == script == mcp' : 'MISMATCH between consumers');
process.exitCode = same ? 0 : 1;
