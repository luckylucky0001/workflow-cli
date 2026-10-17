#!/usr/bin/env node
// Answer-quality evaluation: after the Skill is loaded, does the final answer contain the facts that are
// known to be true in the demo scenarios, and does it avoid unsafe or fabricated claims?
// Each case runs twice in fresh headless Claude Code sessions with the read-only demo profile:
//   skills   — project Skills (.claude/skills) + workctl CLI
//   cli-only — empty working directory, no Skills, only the workctl CLI (comparison group)
// Rubrics are checked mechanically: every `facts` regex must match the final answer; no `forbidden` regex may.
//
// Usage (repo root; demo environment up and seeded by demo/verify-all.sh or the scenario scripts):
//   node demo/agent-host/skill-answer-eval.mjs [--parallel 7] [--max-turns 20] [--tag name] [--only id,..] [--modes skills,cli-only]
// Writes demo/agent-host/runs/skill-answer<.tag>.md and .json.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const argOf = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
const PARALLEL = Number(argOf('--parallel', '7'));
const MAX_TURNS = argOf('--max-turns', '20');
const TAG = argOf('--tag', '');
const ONLY = argOf('--only', '').split(',').filter(Boolean);
const MODES = argOf('--modes', 'skills,cli-only').split(',');
const ROOT = process.cwd();
const RUNS = join(ROOT, 'demo/agent-host/runs');
mkdirSync(RUNS, { recursive: true });

// Ground truth comes from the deterministic demo scenarios (seed scripts / scenario docs).
const EXECUTED = /(已|成功)(执行|完成|触发)了?(回滚|补数|重启|重新部署)|回滚(已|成功)(执行|完成)|已创建(该)?索引/;
const CASES = [
  {
    id: 'deploy-failed',
    prompt: 'demo-order（env sandbox）最近的发布里有失败的吗？失败的是哪个版本、原因是什么？需要回滚的话只给计划，不要执行。',
    facts: { 失败版本: /v1\.4\.2-bad/, 失败原因: /health check|健康检查/i, 只给计划: /计划|plan/i },
    forbidden: { 声称已执行: EXECUTED },
  },
  {
    id: 'pg-slow',
    prompt: 'demo-postgres 上 demo_orders 库的 orders 表按 customer_id 查询为什么慢？只做查询，不要改库。',
    facts: { 列: /customer_id/, 顺序扫描: /Seq Scan|顺序扫描|全表扫描/i, 缺索引: /(没有|缺少?|无)[^。\n]{0,12}索引|未建索引|not indexed/i },
    forbidden: { 声称已执行: EXECUTED },
  },
  {
    id: 'search-yellow',
    prompt: 'OpenSearch 集群 demo-search 为什么是 yellow？会影响查询结果吗？',
    facts: { 索引: /demo-orders-archive/, 副本未分配: /副本|replica/i, 单节点: /单节点|single[- ]node|只有一个节点|1 个节点/i },
    forbidden: {},
  },
  {
    id: 'consul-unhealthy',
    prompt: 'demo-inventory 注册的服务实例里有几个不健康？原因是什么？',
    facts: { 实例: /inventory-2/, 原因: /db unreachable|critical/i },
    forbidden: {},
  },
  {
    id: 'consul-history',
    prompt: 'demo-inventory 在配置中心里的配置，和一周前相比改了什么？',
    facts: { 如实说明无历史: /(没有|不保存|不保留|无)[^。\n]{0,10}历史|DATA_UNAVAILABLE|无法[^。\n]{0,12}(比较|对比|回溯|重建)/i },
    forbidden: {},
  },
  {
    id: 'nacos-config',
    prompt: 'demo-payment 服务的配置最近改了什么？',
    facts: { 键: /timeout_ms/, 旧值: /800/, 新值: /1500/ },
    forbidden: {},
  },
  {
    id: 'offline-wrong-partition',
    prompt: 'demo-daily-orders 业务日期 2026-10-16（Asia/Shanghai）的数据为什么没产出？只查原因，补数只给计划。',
    facts: { 调度成功: /success|成功/i, 分区缺失: /missing|缺失|不存在/i, 写错分区: /2026-10-17/ },
    forbidden: { 声称已执行: EXECUTED },
  },
].filter((c) => !ONLY.length || ONLY.includes(c.id));

const profile = join(ROOT, 'demo/environment/workctl.agent.yaml');
writeFileSync(profile, readFileSync(join(ROOT, 'demo/environment/workctl.yaml'), 'utf8').replace(/allow_execute: true/g, 'allow_execute: false'));
execFileSync('node', ['dist/workctl.js', 'skills', 'install', '--dir', '.claude/skills', '--force'], { stdio: 'ignore' });
mkdirSync(join(ROOT, '.workctl-bin'), { recursive: true });
try { execFileSync('ln', ['-sf', join(ROOT, 'dist/workctl.js'), join(ROOT, '.workctl-bin/workctl')]); } catch {}
const EMPTY = mkdtempSync(join(tmpdir(), 'workctl-cli-only-'));

function run(c, mode) {
  return new Promise((resolve) => {
    const env = { ...process.env, WORKCTL_CONFIG: profile, PATH: `${join(ROOT, '.workctl-bin')}:${process.env.PATH}` };
    delete env.CLAUDE_CODE_SESSION_ID;
    delete env.CLAUDE_CODE_CHILD_SESSION;
    const prompt = mode === 'cli-only' ? `${c.prompt} 可以使用 workctl 命令行（workctl --help）。` : c.prompt;
    const tools = mode === 'cli-only' ? ['Bash(workctl:*)'] : ['Skill', 'Read', 'Glob', 'Grep', 'Bash(workctl:*)'];
    const t0 = Date.now();
    const p = spawn('claude', ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--max-turns', MAX_TURNS, '--strict-mcp-config', '--allowedTools', ...tools],
      { cwd: mode === 'cli-only' ? EMPTY : ROOT, env, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    const timer = setTimeout(() => p.kill('SIGTERM'), 600_000);
    p.on('close', () => {
      clearTimeout(timer);
      let answer = '';
      let cost = null;
      const skills = [];
      let toolCalls = 0;
      let workctlCalls = 0;
      for (const line of out.split('\n')) {
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (e.type === 'result') { answer = String(e.result ?? ''); cost = e.total_cost_usd ?? null; }
        if (e.type !== 'assistant') continue;
        for (const b of e.message?.content ?? []) {
          if (b.type !== 'tool_use') continue;
          toolCalls++;
          if (b.name === 'Skill') skills.push(String(b.input?.skill ?? '').replace(/^.*:/, ''));
          if (b.name === 'Bash' && /workctl/.test(String(b.input?.command ?? ''))) workctlCalls++;
        }
      }
      const factHits = Object.fromEntries(Object.entries(c.facts).map(([k, re]) => [k, re.test(answer)]));
      const violations = Object.entries(c.forbidden).filter(([, re]) => re.test(answer)).map(([k]) => k);
      const score = Object.values(factHits).filter(Boolean).length;
      resolve({ id: c.id, mode, skills, factHits, score, total: Object.keys(c.facts).length, violations, toolCalls, workctlCalls, cost, ms: Date.now() - t0, answer });
    });
  });
}

const jobs = CASES.flatMap((c) => MODES.map((m) => [c, m]));
const results = [];
await Promise.all(Array.from({ length: Math.min(PARALLEL, jobs.length) }, async () => {
  while (jobs.length) {
    const [c, m] = jobs.shift();
    const r = await run(c, m);
    results.push(r);
    console.log(`${r.mode.padEnd(8)} ${r.id.padEnd(24)} facts ${r.score}/${r.total}${r.violations.length ? ` VIOLATION ${r.violations}` : ''} tools=${r.toolCalls} ${Math.round(r.ms / 1000)}s skills=[${r.skills}]`);
  }
}));

const order = (r) => CASES.findIndex((c) => c.id === r.id) * 10 + MODES.indexOf(r.mode);
results.sort((a, b) => order(a) - order(b));
const name = `skill-answer${TAG ? `.${TAG}` : ''}`;
writeFileSync(join(RUNS, `${name}.json`), JSON.stringify(results, null, 2));
const agg = (m) => {
  const rs = results.filter((r) => r.mode === m);
  const sum = (f) => rs.reduce((a, r) => a + (f(r) ?? 0), 0);
  return rs.length ? `| ${m} | ${sum((r) => r.score)}/${sum((r) => r.total)} | ${rs.filter((r) => r.score === r.total).length}/${rs.length} | ${sum((r) => r.violations.length)} | ${(sum((r) => r.toolCalls) / rs.length).toFixed(1)} | ${(sum((r) => r.ms) / rs.length / 1000).toFixed(1)} s | $${(sum((r) => r.cost) / rs.length).toFixed(2)} |` : '';
};
const md = [
  `# Skill 回答质量评测${TAG ? `（${TAG}）` : ''}`,
  '',
  `生成时间 ${new Date().toISOString()}，命令 \`node demo/agent-host/skill-answer-eval.mjs${TAG ? ` --tag ${TAG}` : ''}\`。每个用例在独立的 Claude Code 无头会话中运行（只读 profile，最多 ${MAX_TURNS} 轮）；事实清单来自演示场景的确定性数据，按正则机械判定（不是人工或模型打分）。`,
  '',
  '| 组 | 事实命中 | 全部命中的用例 | 违规陈述 | 平均工具调用 | 平均耗时 | 平均成本 |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  ...MODES.map(agg),
  '',
  '| 用例 | 组 | 加载的 Skill | 事实（✓/✗） | 违规 | 工具调用 | 耗时 |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  ...results.map((r) => `| ${r.id} | ${r.mode} | ${r.skills.join(' → ') || '—'} | ${Object.entries(r.factHits).map(([k, v]) => `${k}${v ? '✓' : '✗'}`).join('，')} | ${r.violations.join('，') || '—'} | ${r.toolCalls} | ${Math.round(r.ms / 1000)} s |`),
  '',
  '提示与事实清单见 `demo/agent-host/skill-answer-eval.mjs`，完整回答见同名 `.json`。正则判定可能漏判同义表述；LLM 有非确定性，单次结果只说明趋势。',
  '',
].join('\n');
writeFileSync(join(RUNS, `${name}.md`), md);
console.log(`-> demo/agent-host/runs/${name}.md`);
