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
    for (const m of text.matchAll(/workctl(?:\s+--json)?\s+([a-z][a-z -]*[a-z])/g)) {
      const words = m[1].trim();
      const c = byCommand.find((x) => words === x.command || words.startsWith(`${x.command} `));
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
writeFileSync('docs/reuse-matrix.md', lines.join('\n') + '\n');
console.log(`skills=${skills.length} capabilities_referenced=${usage.size} reused_by_2plus=${multi}`);
