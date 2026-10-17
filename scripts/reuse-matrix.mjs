// Which capabilities (and therefore adapters) each Skill reuses — evidence for
// "一次接入，多处复用" (design §3.1 / §10.4). Writes docs/reuse-matrix.md.
// Usage: npm run build && node scripts/reuse-matrix.mjs
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '../dist/index.js';

const { registry } = createClient();
const caps = registry.list().filter((c) => c.status !== 'planned');
const byCommand = [...caps].sort((a, b) => b.command.length - a.command.length);
const skillDirs = ['skills', 'plugins/demo-mq/skills'].filter(existsSync);
const usage = new Map(); // capability -> Set(skill)
const skills = [];
for (const root of skillDirs) {
  for (const d of readdirSync(root)) {
    const f = join(root, d, 'SKILL.md');
    if (!existsSync(f)) continue;
    const text = readFileSync(f, 'utf8');
    const used = new Set();
    // tokenise every "workctl ..." mention; skip global options (and their values) before the command words
    const withValue = new Set(['--timeout', '--profile', '--config', '-o', '--output', '--request-id']);
    for (const m of text.matchAll(/workctl\s+([^`\n|]+)/g)) {
      const tokens = m[1].trim().split(/\s+/);
      const words = [];
      for (let k = 0; k < tokens.length; k++) {
        if (withValue.has(tokens[k])) { k++; continue; }
        if (tokens[k].startsWith('-')) { if (words.length) break; continue; }
        if (!/^[a-z][a-z-]*$/.test(tokens[k])) break;
        words.push(tokens[k]);
      }
      const phrase = words.join(' ');
      const c = byCommand.find((x) => phrase === x.command || phrase.startsWith(`${x.command} `));
      if (c) used.add(c.name);
    }
    skills.push({ name: d, used });
    for (const c of used) (usage.get(c) ?? usage.set(c, new Set()).get(c)).add(d);
  }
}
const lines = ['# Skill × 能力复用矩阵', '', '> 由 `node scripts/reuse-matrix.mjs` 从 Skill 正文中引用的命令生成。一个能力被多个 Skill 引用，说明同一适配器在多个流程中复用。', ''];
lines.push('| 能力 | 适配器 | 被引用的 Skill 数 | Skill |', '| --- | --- | --- | --- |');
for (const c of caps) {
  const s = usage.get(c.name);
  if (!s) continue;
  lines.push(`| \`${c.name}\` | ${c.adapter} | ${s.size} | ${[...s].sort().join(', ')} |`);
}
const multi = [...usage.values()].filter((s) => s.size > 1).length;
const adapters = new Map();
for (const [cap, s] of usage) {
  const a = registry.get(cap).adapter;
  adapters.set(a, new Set([...(adapters.get(a) ?? []), ...s]));
}
lines.push('', `- Skill 数：${skills.length}；被引用能力数：${usage.size}；被 2 个及以上 Skill 复用的能力：${multi}`);
lines.push('', '| 适配器 | 使用它的 Skill 数 |', '| --- | --- |');
for (const [a, s] of [...adapters].sort((x, y) => y[1].size - x[1].size)) lines.push(`| ${a} | ${s.size} |`);
// Capability composition in code: handlers that call other capabilities through ctx.call
// (same engine and contract, no duplicated adapter code).
const compositions = [];
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []));
for (const f of walk('src/domains')) {
  const domain = f.split('/')[2];
  for (const m of readFileSync(f, 'utf8').matchAll(/ctx\.call\('([a-z_.]+)'/g)) compositions.push(`| ${domain} (\`${f}\`) | \`${m[1]}\` | ${registry.get(m[1])?.adapter ?? '?'} |`);
}
lines.push('', '## 能力组合（代码层复用）', '', '能力实现通过 `ctx.call()` 调用其他能力：走同一执行引擎与契约，不复制适配器代码。', '', '| 调用方领域 | 被调用能力 | 被调用能力的适配器 |', '| --- | --- | --- |', ...[...new Set(compositions)]);
writeFileSync('docs/reuse-matrix.md', lines.join('\n') + '\n');
console.log(`skills=${skills.length} capabilities_referenced=${usage.size} reused_by_2plus=${multi}`);
