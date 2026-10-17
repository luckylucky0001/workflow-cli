// Code-size view of shared vs per-domain code (design §12.1 "共享代码复用 / 接入效率").
// Counts non-blank, non-comment TypeScript lines. Usage: node scripts/maintenance-report.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function loc(dir) {
  let n = 0;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) n += loc(p);
    else if (p.endsWith('.ts')) n += readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() && !/^\s*(\/\/|\*|\/\*)/.test(l)).length;
  }
  return n;
}
const rows = [['core (shared runtime)', loc('src/core')], ['cli + mcp (shared consumers)', loc('src/cli') + loc('src/mcp')]];
for (const d of readdirSync('src/domains')) {
  const p = join('src/domains', d);
  if (statSync(p).isDirectory()) rows.push([`domain: ${d}`, loc(p)]);
}
rows.push(['plugin: demo-mq', loc('plugins/demo-mq/src')]);
console.log('| 模块 | 代码行（不含空行/注释） |\n| --- | --- |');
for (const [k, v] of rows) console.log(`| ${k} | ${v} |`);
