#!/usr/bin/env node
// Skill trigger evaluation: does the agent load the right Skill for a task, judged only by the Skill
// descriptions? Each prompt runs in a fresh headless Claude Code session (project Skills installed into
// .claude/skills, read-only demo profile, at most a few turns), and we record which Skills it loaded.
//
// Usage (repo root, after `npm run build` and with the demo environment up):
//   node demo/agent-host/skill-trigger-eval.mjs [--parallel 5] [--max-turns 3] [--tag name] [--only id,id]
// Writes demo/agent-host/runs/skill-trigger<.tag>.md (summary) and .json (raw per-prompt results).
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const argOf = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
const PARALLEL = Number(argOf('--parallel', '5'));
const MAX_TURNS = argOf('--max-turns', '3');
const TAG = argOf('--tag', '');
const ONLY = argOf('--only', '').split(',').filter(Boolean);
const ROOT = process.cwd();
const RUNS = join(ROOT, 'demo/agent-host/runs');
mkdirSync(RUNS, { recursive: true });

// expected: the Skill(s) that should be loaded; any of them counts as a hit. The entry skill
// (enterprise-infra) loaded alone is a partial hit: it routes, but the domain knowledge was not read.
const CASES = [
  { id: 'latency', prompt: 'demo-order（env sandbox）的 p95 延迟突然升高了，帮我查一下原因。只做查询。', expected: ['service-latency-investigation'] },
  { id: 'offline-delay', prompt: 'demo-daily-orders 业务日期 2026-10-16 的数据还没产出，帮我看看卡在哪。只做查询。', expected: ['offline-delay-investigation'] },
  { id: 'capacity', prompt: '帮我盘点一下 sandbox 环境 demo-order 及其依赖的资源使用和容量风险。只做查询。', expected: ['resource-capacity-review'] },
  { id: 'mysql', prompt: 'demo-mysql 上现在哪些 SQL 语句最慢？', expected: ['mysql-operations'] },
  { id: 'postgres', prompt: 'demo-postgres 这个 PostgreSQL 实例上有没有锁等待或者阻塞？', expected: ['postgres-operations'] },
  { id: 'redis', prompt: 'demo-redis 的缓存命中率怎么样？有没有热 key？', expected: ['redis-operations'] },
  { id: 'mq', prompt: 'Kafka 消费组 demo-consumer 现在积压了多少消息？', expected: ['mq-operations'] },
  { id: 'search', prompt: 'OpenSearch 集群 demo-search 为什么是 yellow？', expected: ['search-operations'] },
  { id: 'deploy', prompt: 'demo-order 最近一次发布成功了吗？如果要回滚该怎么做（只给计划）？', expected: ['deploy-operations'] },
  { id: 'config', prompt: 'demo-payment 服务在配置中心里的配置最近改了什么？', expected: ['infra-operations'] },
  { id: 'data-quality', prompt: '表 analytics.daily_orders 分区 dt=2026-10-16 的数据质量检查结果和血缘是什么？', expected: ['data-validation'] },
  { id: 'restart', prompt: '帮我重启一下 demo-order 容器（先给计划，不要执行）。', expected: ['infra-operations'] },
  { id: 'backfill', prompt: 'Airflow 工作流 demo-daily-orders 帮我生成 2026-10-14 的补数计划（不执行）。', expected: ['offline-operations', 'offline-delay-investigation'] },
  // vaguer phrasings: no system named, or ambiguous between neighbouring skills
  { id: 'vague-timeout', prompt: '下单接口最近经常超时，怎么回事？', expected: ['service-latency-investigation'] },
  { id: 'vague-report', prompt: '昨天的订单日报怎么还没出来？', expected: ['offline-delay-investigation'] },
  { id: 'vague-release', prompt: 'demo-order 刚发完版之后错误率上升了，是不是发布导致的？', expected: ['deploy-operations', 'service-latency-investigation'] },
  { id: 'vague-pg', prompt: 'demo_orders 库（在 PostgreSQL 上）里 orders 表按 customer_id 查询很慢，为什么？', expected: ['postgres-operations'] },
  { id: 'vague-discovery', prompt: 'demo-inventory 注册的服务实例里有几个不健康？', expected: ['infra-operations'] },
  { id: 'vague-capacity', prompt: '下个月 demo-order 流量要翻倍，现有资源够不够？', expected: ['resource-capacity-review'] },
].filter((c) => !ONLY.length || ONLY.includes(c.id));

// read-only profile + current Skills, exactly as the agent-host demo does
const profile = join(ROOT, 'demo/environment/workctl.agent.yaml');
writeFileSync(profile, readFileSync(join(ROOT, 'demo/environment/workctl.yaml'), 'utf8').replace(/allow_execute: true/g, 'allow_execute: false'));
execFileSync('node', ['dist/workctl.js', 'skills', 'install', '--dir', '.claude/skills', '--force'], { stdio: 'ignore' });
mkdirSync(join(ROOT, '.workctl-bin'), { recursive: true });
try { execFileSync('ln', ['-sf', join(ROOT, 'dist/workctl.js'), join(ROOT, '.workctl-bin/workctl')]); } catch {}

function runCase(c) {
  return new Promise((resolve) => {
    const env = { ...process.env, WORKCTL_CONFIG: profile, PATH: `${join(ROOT, '.workctl-bin')}:${process.env.PATH}` };
    delete env.CLAUDE_CODE_SESSION_ID;
    delete env.CLAUDE_CODE_CHILD_SESSION;
    const t0 = Date.now();
    const p = spawn('claude', ['-p', c.prompt, '--output-format', 'stream-json', '--verbose', '--max-turns', MAX_TURNS,
      '--allowedTools', 'Skill', 'Read', 'Glob', 'Grep', 'Bash(workctl:*)'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    const timer = setTimeout(() => p.kill('SIGTERM'), 240_000);
    p.on('close', () => {
      clearTimeout(timer);
      const skills = [];
      const tools = [];
      for (const line of out.split('\n')) {
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (e.type !== 'assistant') continue;
        for (const b of e.message?.content ?? []) {
          if (b.type !== 'tool_use') continue;
          tools.push(b.name === 'Bash' ? `Bash: ${String(b.input?.command ?? '').slice(0, 60)}` : b.name);
          if (b.name === 'Skill') skills.push(String(b.input?.skill ?? b.input?.name ?? '').replace(/^.*:/, ''));
        }
      }
      const hit = c.expected.some((s) => skills.includes(s));
      const entryOnly = !hit && skills.length > 0 && skills.every((s) => s === 'enterprise-infra');
      const wrong = skills.filter((s) => s !== 'enterprise-infra' && !c.expected.includes(s));
      resolve({ ...c, skills, first_tools: tools.slice(0, 6), verdict: hit ? (wrong.length ? 'hit+extra' : 'hit') : entryOnly ? 'entry-only' : skills.length ? 'wrong' : 'none', wrong, ms: Date.now() - t0 });
    });
  });
}

const results = [];
const queue = [...CASES];
await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
  while (queue.length) {
    const c = queue.shift();
    const r = await runCase(c);
    results.push(r);
    console.log(`${r.verdict.padEnd(10)} ${r.id.padEnd(14)} skills=[${r.skills.join(', ')}] ${Math.round(r.ms / 1000)}s`);
  }
}));
results.sort((a, b) => CASES.findIndex((c) => c.id === a.id) - CASES.findIndex((c) => c.id === b.id));

const hits = results.filter((r) => r.verdict.startsWith('hit')).length;
const name = `skill-trigger${TAG ? `.${TAG}` : ''}`;
writeFileSync(join(RUNS, `${name}.json`), JSON.stringify(results, null, 2));
const md = [
  `# Skill 触发评测${TAG ? `（${TAG}）` : ''}`,
  '',
  `生成时间 ${new Date().toISOString()}，命令 \`node demo/agent-host/skill-trigger-eval.mjs${TAG ? ` --tag ${TAG}` : ''}\`。每条提示在独立的 Claude Code 无头会话中运行（项目 Skill、只读 profile、最多 ${MAX_TURNS} 轮），记录实际加载的 Skill。`,
  '',
  `**命中 ${hits}/${results.length}**（期望的 Skill 被加载；只加载入口 Skill 记为 entry-only，不算命中）。`,
  '',
  '| 用例 | 期望 | 实际加载（按顺序） | 结论 | 前几个工具调用 |',
  '| --- | --- | --- | --- | --- |',
  ...results.map((r) => `| ${r.id} | ${r.expected.join(' / ')} | ${r.skills.join(' → ') || '（无）'} | ${r.verdict} | ${r.first_tools.map((t) => t.replace(/\|/g, '\\|')).join('<br>')} |`),
  '',
  '提示原文见 `demo/agent-host/skill-trigger-eval.mjs`。LLM 有非确定性，单次结果只说明趋势。',
  '',
].join('\n');
writeFileSync(join(RUNS, `${name}.md`), md);
console.log(`hits ${hits}/${results.length} -> demo/agent-host/runs/${name}.md`);
