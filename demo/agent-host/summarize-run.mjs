// Summarise a Claude Code stream-json transcript: which workctl commands / MCP tools
// the agent used, the final answer, duration and cost reported by the host.
import { readFileSync } from 'node:fs';

const events = readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean).flatMap((l) => {
  try {
    return [JSON.parse(l)];
  } catch {
    return [];
  }
});
const calls = [];
for (const e of events) {
  if (e.type !== 'assistant') continue;
  for (const c of e.message?.content ?? []) {
    if (c.type !== 'tool_use') continue;
    if (c.name === 'Bash') calls.push(`Bash: ${String(c.input?.command ?? '').split('\n')[0].slice(0, 200)}`);
    else if (c.name.startsWith('mcp__workctl')) calls.push(`MCP: ${c.name.replace('mcp__workctl__', '')} ${JSON.stringify(c.input)}`);
    else if (c.name === 'Skill') calls.push(`Skill: ${JSON.stringify(c.input)}`);
    else calls.push(`${c.name}: ${JSON.stringify(c.input).slice(0, 160)}`);
  }
}
const result = events.find((e) => e.type === 'result') ?? {};
// Host scratch paths carry session identifiers; they are not part of the evidence.
const scrub = (t) => String(t).replace(/\/tmp\/claude-[^\s"'`]*/g, '<host-scratch>');
for (let i = 0; i < calls.length; i++) calls[i] = scrub(calls[i]);
if (result.result) result.result = scrub(result.result);
console.log(`# ${process.argv[2].replace(process.cwd() + '/', '')}\n`);
console.log(`- 工具调用次数：${calls.length}；workctl 调用：${calls.filter((c) => c.startsWith("MCP:") || (c.startsWith("Bash:") && /workctl/.test(c))).length}`);
console.log(`- 耗时：${result.duration_ms ?? '?'} ms；宿主报告成本：${result.total_cost_usd ?? '?'} USD；轮次：${result.num_turns ?? '?'}；结束状态：${result.subtype ?? '?'}`);
console.log('\n## 调用序列\n');
for (const c of calls) console.log(`1. \`${c.replace(/`/g, "'")}\``);
console.log('\n## 最终回答\n');
console.log(result.result ?? '(无)');
