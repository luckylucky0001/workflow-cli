#!/usr/bin/env node
// 实测截图教程生成器：逐步真实运行 workctl 命令（只读），把终端输出渲染成终端样式的 HTML，
// 用 Playwright + Chromium 截图到 docs/tutorial/images/<nn>-<id>.png，并把原始文本存为 <nn>-<id>.txt。
//
// 用法（仓库根目录，需要演示环境已启动：demo/environment/up.sh）：
//   node scripts/tutorial-screenshots.mjs                 # 全部步骤
//   node scripts/tutorial-screenshots.mjs --only doctor,mysql-explain
//   node scripts/tutorial-screenshots.mjs --text-only     # 只运行命令、写 .txt，不截图
//   node scripts/tutorial-screenshots.mjs --out /tmp/x    # 输出到其他目录（试跑时不覆盖已提交的截图）
//
// 约定：
// - 命令从仓库根目录用 bash 运行；`workctl` 是 shell 函数，等价于 `node dist/workctl.js`。
// - 默认 WORKCTL_CONFIG=demo/environment/workctl.yaml，步骤可用 config 覆盖。
// - 只放只读命令（以及只生成计划、不执行的 plan 类命令）。执行类命令只演示“被拒绝”，且运行前先用
//   access check 确认该 profile 会拒绝执行，否则跳过。
// - 写文件前扫描 demo/environment/.runtime/secrets/* 中的每个值，命中则该步失败、不写任何文件。
// - CLI 本身不输出 ANSI 颜色；渲染时保留 ANSI（如有），否则只给 YAML/JSON 的键、注释行和错误行上色。
import { spawnSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx >= 0 ? resolve(process.argv[outIdx + 1]) : join(ROOT, 'docs/tutorial/images');
const DEFAULT_CONFIG = 'demo/environment/workctl.yaml';
const AGENT_CONFIG = 'demo/environment/workctl.agent.yaml';
// 不是秘密文件里的值，但输出中应当被遮蔽的字符串（Jenkins 部署 job 打印的 registry token 默认值）
const EXTRA_FORBIDDEN = ['dummy-token-not-a-secret'];
const PRELUDE = `workctl() { node "${ROOT}/dist/workctl.js" "$@"; }\n`;

// ---------------------------------------------------------------------------------------------
// 步骤清单。字段：
//   id, title            文件名与窗口标题
//   cmd                  bash 命令（可含 {{VAR}}，由前面步骤的 capture 提供）
//   config               覆盖 WORKCTL_CONFIG；env 追加环境变量
//   maxLines / tail      截断：保留前 maxLines-tail 行与最后 tail 行，中间显示 “… N lines omitted”
//   keepKeys             只保留这些顶层 YAML 键（列 0）的块，其余块折叠为 “… N lines omitted”
//   blockMax             { 顶层键: N }，该块只保留前 N 行，其余折叠为 “… N lines omitted”
//   capture              { VAR: regex }，从输出中取第 1 个分组供后续步骤使用
//   guardExecute         运行前确认该 profile 对 operation.execute 的 access check 为 denied
//   optional             可选步骤：命令不存在（unknown command）或失败时跳过，不算错误
//   render: 'markdown'   把 file 指向的 Markdown 渲染成页面截图（不运行命令）
// ---------------------------------------------------------------------------------------------
const STEPS = [
  // 1. 安装与自检
  { id: 'version', title: '版本', cmd: 'node dist/workctl.js --version' },
  { id: 'doctor', title: '自检', cmd: 'workctl doctor', maxLines: 44, tail: 10 },

  // 2. 能力发现
  { id: 'capability-list', title: '能力目录（按领域过滤）', cmd: 'workctl capability list --domain redis', maxLines: 46, tail: 12 },
  { id: 'capability-get', title: '单个能力定义', cmd: 'workctl capability get --name mysql.statement.summary', blockMax: { output_json_schema: 8 }, maxLines: 72, tail: 4 },
  { id: 'command-help', title: '命令帮助', cmd: 'workctl redis stats sample --help', maxLines: 50, tail: 6 },

  // 3. 统一结果信封
  { id: 'envelope-json', title: '--json 信封', cmd: 'workctl --json network connectivity check --target 127.0.0.1:13306', maxLines: 90, tail: 20 },
  { id: 'error-permission', title: '错误码与退出码', cmd: 'workctl --json mysql query execute --instance demo-mysql --database demo --sql "SELECT user, host FROM mysql.user"; echo "exit=$?"', maxLines: 60, tail: 16 },

  // 4. 主线 A 基础设施
  { id: 'service-deps', title: '服务依赖', cmd: 'workctl service dependency list --service demo-order --env sandbox', maxLines: 60 },
  { id: 'workload-get', title: '容器工作负载', cmd: 'workctl container workload get --service demo-order --env sandbox', blockMax: { containers: 42 }, maxLines: 72, tail: 8 },
  { id: 'metric-query', title: '指标查询', cmd: 'workctl metric query --resource demo-order --metric request_rate --window 1h --step 5m', maxLines: 60, tail: 18 },
  { id: 'log-query', title: '日志查询', cmd: 'workctl log query --service demo-order --env sandbox --window 6h --contains "cache mode changed" --limit 2', maxLines: 64, tail: 14 },

  // 5. 主线 B 中间件
  { id: 'mysql-statement-summary', title: 'MySQL 语句摘要（10s 采样窗口）', cmd: 'workctl --timeout 30s mysql statement summary --instance demo-mysql --sample-window 10s --top 3', maxLines: 70, tail: 10 },
  { id: 'mysql-statement-cumulative', title: 'MySQL 语句摘要（累计值，对照）', cmd: 'workctl mysql statement summary --instance demo-mysql --sample-window 0 --top 2 --database demo', maxLines: 60, tail: 8 },
  { id: 'mysql-explain', title: 'MySQL 执行计划（估计，不执行）', cmd: 'workctl mysql query explain --instance demo-mysql --database demo --sql-file demo/scenarios/latency/customer_recent.sql', maxLines: 64, tail: 8 },
  { id: 'redis-stats-sample', title: 'Redis 窗口统计采样', cmd: 'workctl --timeout 30s redis stats sample --instance demo-redis --duration 5s', maxLines: 60 },
  { id: 'redis-key-sample', title: 'Redis 键采样（SCAN 预算）', cmd: "workctl redis key sample --instance demo-redis --pattern 'demo:*' --max-keys 20", maxLines: 52, tail: 16 },
  { id: 'mq-consumer-lag', title: 'Kafka 消费组 lag（插件）', cmd: 'workctl mq consumer lag --cluster demo-mq --group demo-consumer', maxLines: 60, tail: 12 },

  // 6. 主线 C 离线
  { id: 'offline-run-list', title: '按业务日期找运行', cmd: 'workctl offline run list --workflow demo-daily-orders --data-date 2026-10-16 --timezone Asia/Shanghai', keepKeys: ['workflow', 'mapping', 'runs'], maxLines: 48, tail: 6 },
  { id: 'offline-run-get', title: '运行分层状态', cmd: 'workctl --timeout 60s offline run get --id demo__2026-10-16__wrong_partition --workflow demo-daily-orders', keepKeys: ['summary'], maxLines: 74, tail: 24 },
  { id: 'offline-backfill-plan', title: '补数计划（只生成，不执行）', cmd: 'workctl --timeout 60s offline backfill plan --workflow demo-daily-orders --from 2026-10-14 --to 2026-10-16 --timezone Asia/Shanghai', keepKeys: ['plan_id', 'status', 'executable', 'workflow', 'targets', 'impact', 'preconditions', 'next'], blockMax: { targets: 26, impact: 14 }, maxLines: 80, tail: 26 },
  { id: 'data-partition-get', title: '分区产出检查', cmd: 'workctl data partition get --catalog demo --table analytics.daily_orders --partition dt=2026-10-16', maxLines: 60, tail: 10 },

  // 7. 配置中心（etcd）
  { id: 'config-get', title: '配置读取（etcd）', cmd: 'workctl config get --service demo-order --env sandbox', blockMax: { items: 50 }, maxLines: 70, tail: 4 },
  { id: 'config-diff', title: '配置修订差异', cmd: 'workctl config diff --service demo-order --key cache.ttl_seconds', maxLines: 60 },
  { id: 'discovery-list', title: '服务发现实例', cmd: 'workctl discovery list --service demo-order', blockMax: { instances: 46 }, maxLines: 72, tail: 4 },

  // 8. 插件扩展
  { id: 'plugin-list', title: '已安装插件', cmd: 'workctl plugin list', maxLines: 40 },
  { id: 'capability-list-search', title: '插件提供的能力', cmd: 'workctl capability list --domain search', maxLines: 60, tail: 6 },
  { id: 'search-query-partial', title: '部分分片失败 → partial', cmd: 'workctl search query --cluster demo-search --index demo-orders-all --dsl-file demo/scenarios/search/dsl/latest_across_archive.json; echo "exit=$?"', maxLines: 70, tail: 16 },
  { id: 'search-query-rejected', title: '受限 DSL 被拒绝', cmd: 'workctl search query --cluster demo-search --index demo-orders-all --dsl-file demo/scenarios/search/dsl/script_score.json; echo "exit=$?"', maxLines: 40 },

  // 9. 受控操作（只生成计划；执行只演示被拒绝）
  { id: 'restart-plan', title: '重启计划（只读 profile）', config: AGENT_CONFIG, cmd: 'workctl container workload restart-plan --service demo-order --env sandbox', keepKeys: ['id', 'kind', 'title', 'impact', 'preconditions', 'steps', 'rollback', 'status', 'expires_at', 'profile', 'executable'], maxLines: 70, tail: 8, capture: { PLAN_ID: /^id: (op-[\w-]+)/m } },
  { id: 'access-check-execute', title: '执行前授权检查', config: AGENT_CONFIG, cmd: 'workctl access check --capability operation.execute', maxLines: 40 },
  { id: 'execute-refused', title: '执行被拒绝', config: AGENT_CONFIG, guardExecute: true, cmd: 'workctl --json operation execute --id {{PLAN_ID}} --confirm {{PLAN_ID}}; echo "exit=$?"', maxLines: 60, tail: 18 },

  // 10. 多 provider
  { id: 'k8s-workload-get', title: 'Kubernetes provider（k3s）', config: 'demo/environment/k8s/workctl.k8s.yaml', cmd: 'workctl container workload get --service demo-order --env sandbox', blockMax: { containers: 30, kubernetes: 18 }, maxLines: 72, tail: 4 },
  { id: 'af3-run-list', title: 'Airflow 3（REST v2）', config: 'demo/environment/workctl.af3.yaml', optional: true, cmd: 'workctl --json offline run list --workflow demo-daily-orders --data-date 2026-10-16 --timezone Asia/Shanghai', maxLines: 50, tail: 38 },
  { id: 'loki-log-query', title: '日志来源：Loki', config: 'demo/environment/workctl.loki.yaml', optional: true, cmd: 'workctl log query --service demo-order --env sandbox --window 6h --contains "cache mode changed" --limit 2', maxLines: 64, tail: 14 },

  // 11. Agent 接入
  { id: 'mcp-tools', title: 'MCP：initialize / tools/list / tools/call', config: AGENT_CONFIG, cmd: 'node docs/tutorial/mcp-tools-list.mjs', maxLines: 60 },
  { id: 'agent-run-summary', title: 'Agent 运行摘要（D-extend）', render: 'markdown', file: 'demo/agent-host/runs/D-extend.summary.md', maxLines: 90 },

  // 附加领域（主线之后接入）：PostgreSQL、部署系统（k8s）、Nacos / Consul 配置
  { id: 'pg-instance-get', title: 'PostgreSQL 实例', cmd: 'workctl pg instance get --instance demo-postgres', blockMax: { settings: 10 }, maxLines: 72, tail: 6 },
  { id: 'deploy-release-list', title: '发布历史（Kubernetes）', config: 'demo/environment/k8s/workctl.k8s.yaml', cmd: 'workctl deploy release list --service demo-order --env sandbox --limit 3', blockMax: { releases: 50 }, maxLines: 66, tail: 4 },
  { id: 'config-get-nacos', title: '配置读取（Nacos）', cmd: 'workctl config get --service demo-payment --env sandbox', blockMax: { items: 30 }, maxLines: 64, tail: 4 },
  { id: 'config-get-consul', title: '配置读取（Consul KV）', cmd: 'workctl config get --service demo-inventory --env sandbox', blockMax: { items: 30 }, maxLines: 64, tail: 4 },

  // 以下步骤追加在末尾，保持已有图片编号不变。
  // 数据库 PostgreSQL：后台用场景脚本产生 15s 只读负载（两条 SELECT），同时做 10s 窗口采样
  { id: 'pg-statement-summary', title: 'PostgreSQL 语句摘要（10s 窗口，后台负载）', cmd: 'node demo/scenarios/postgres/scenario.mjs load --seconds 15 >/dev/null 2>&1 &\nworkctl --timeout 30s pg statement summary --sample-window 10s --database demo_orders --top 2; wait', maxLines: 60, tail: 12 },
  { id: 'pg-query-explain', title: 'PostgreSQL 执行计划（估计，不执行）', cmd: 'workctl pg query explain --sql "SELECT id, status, amount, created_at FROM orders WHERE customer_id = 42 ORDER BY created_at DESC LIMIT 20"', blockMax: { nodes: 34, plan: 6 }, maxLines: 70, tail: 4 },
  { id: 'pg-lock-list', title: 'PostgreSQL 锁等待', cmd: 'workctl pg lock list', maxLines: 30 },
  // 部署系统：Jenkins provider（docker profile 的资源绑定）；回滚只生成计划
  { id: 'deploy-jenkins-release-list', title: '发布历史（Jenkins）', cmd: 'workctl deploy release list --service demo-order --env sandbox', blockMax: { releases: 77 }, maxLines: 86, tail: 4, capture: { BAD_BUILD: /- id: "(\d+)"\n\s+provider: jenkins\n\s+version: v1\.4\.2-bad/ } },
  { id: 'deploy-jenkins-release-get', title: '失败构建详情（控制台日志遮蔽）', cmd: 'workctl deploy release get --service demo-order --env sandbox --id {{BAD_BUILD}}', maxLines: 70, tail: 6 },
  { id: 'deploy-jenkins-rollback-plan', title: '回滚计划（只生成，不执行）', cmd: 'workctl deploy rollback plan --service demo-order --env sandbox', keepKeys: ['id', 'kind', 'title', 'targets', 'impact', 'preconditions', 'steps', 'rollback', 'status', 'expires_at', 'executable'], blockMax: { impact: 8 }, maxLines: 72, tail: 6 },
  // 服务发现与配置差异：Nacos / Consul
  { id: 'discovery-nacos', title: '服务发现（Nacos）', cmd: 'workctl discovery list --service demo-payment', blockMax: { instances: 36 }, maxLines: 66, tail: 4 },
  { id: 'discovery-consul', title: '服务发现（Consul）', cmd: 'workctl discovery list --service demo-inventory', blockMax: { instances: 76 }, maxLines: 100, tail: 14 },
  { id: 'config-diff-nacos', title: '配置修订差异（Nacos 配置历史）', cmd: 'workctl config diff --service demo-payment --key order.timeout_ms', maxLines: 66, tail: 6 },
  { id: 'config-diff-consul', title: 'Consul KV 无历史 → DATA_UNAVAILABLE', cmd: 'workctl config diff --service demo-inventory --key cache.ttl_seconds; echo "exit=$?"', maxLines: 30 },
  // TODO：deploy status get、pg table get / pg query analyze（analyze 会真实执行查询，只读但有负载）
];

// ---------------------------------------------------------------------------------------------
const args = process.argv.slice(2);
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? new Set(args[onlyIdx + 1].split(',').map((s) => s.trim()).filter(Boolean)) : null;
const textOnly = args.includes('--text-only');

function loadSecrets() {
  const dirs = [join(ROOT, 'demo/environment/.runtime/secrets')];
  const values = new Set();
  const add = (v) => {
    if (typeof v === 'string' && v.trim().length >= 4) values.add(v.trim());
  };
  // Kubernetes：ServiceAccount token 与 kubeconfig 中的凭据字段（证书公钥部分不算秘密，但一并扫描无妨）
  const k8s = join(ROOT, 'demo/environment/.runtime/k8s');
  if (existsSync(join(k8s, 'workctl-token'))) add(readFileSync(join(k8s, 'workctl-token'), 'utf8'));
  if (existsSync(join(k8s, 'kubeconfig.yaml'))) {
    for (const m of readFileSync(join(k8s, 'kubeconfig.yaml'), 'utf8').matchAll(/^\s*(?:token|client-key-data|client-certificate-data|password):\s*(\S+)/gm)) add(m[1]);
  }
  const walk = (x) => {
    if (typeof x === 'string') add(x);
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') Object.values(x).forEach(walk);
  };
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (!statSync(p).isFile()) continue;
      const raw = readFileSync(p, 'utf8');
      add(raw);
      for (const line of raw.split('\n')) add(line);
      try {
        walk(JSON.parse(raw));
      } catch {
        /* not JSON */
      }
    }
  }
  return [...values];
}

function sh(cmd, env) {
  return spawnSync('bash', ['-c', `${PRELUDE}{\n${cmd}\n} 2>&1`], {
    cwd: ROOT,
    env: { ...process.env, FORCE_COLOR: '1', COLUMNS: '120', ...env },
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
}

const looksLikeRebuild = (out) => /Cannot find module|ERR_MODULE_NOT_FOUND|SyntaxError|Unexpected end of input|dist\/workctl\.js:\d+/.test(out);
const looksUnknown = (out) => /unknown command|error: unknown option/.test(out);

function runStep(step, vars) {
  const cmd = step.cmd.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`缺少变量 ${k}（先运行提供它的步骤）`);
    return vars[k];
  });
  const config = step.config ?? DEFAULT_CONFIG;
  const env = { WORKCTL_CONFIG: config, ...(step.env ?? {}) };
  let r = sh(cmd, env);
  let out = (r.stdout ?? '') + (r.stderr ?? '');
  if (looksLikeRebuild(out)) {
    console.log(`  ${step.id}: 输出像是 dist 正在重建，5s 后重试一次`);
    execSync('sleep 5');
    r = sh(cmd, env);
    out = (r.stdout ?? '') + (r.stderr ?? '');
  }
  return { cmd, config, out: out.replace(/\s+$/, ''), status: r.status, signal: r.signal };
}

// ---- truncation ------------------------------------------------------------------------------
const OMIT = (n) => `\u0000OMIT … ${n} lines omitted`;

function keepTopKeys(lines, keys, blockMax = {}) {
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    const m = /^([A-Za-z_][\w.-]*):/.exec(line);
    if (m || line.startsWith('#') || !cur) {
      cur = { key: m ? m[1] : line.startsWith('#') ? '#' : null, lines: [] };
      blocks.push(cur);
    }
    cur.lines.push(line);
  }
  const out = [];
  let omitted = 0;
  const order = blocks.filter((b) => !keys || b.key === null || b.key === '#' || keys.includes(b.key));
  // keep original order but only listed keys
  for (const b of blocks) {
    if (order.includes(b)) {
      if (omitted) out.push(OMIT(omitted));
      omitted = 0;
      const cap = blockMax[b.key];
      if (cap && b.lines.length > cap) out.push(...b.lines.slice(0, cap), OMIT(b.lines.length - cap));
      else out.push(...b.lines);
    } else omitted += b.lines.length;
  }
  if (omitted) out.push(OMIT(omitted));
  return out;
}

function truncate(lines, maxLines = 48, tail = 8) {
  if (lines.length <= maxLines) return lines;
  const head = Math.max(1, maxLines - tail - 1);
  const omitted = lines.length - head - tail;
  return [...lines.slice(0, head), OMIT(omitted), ...lines.slice(lines.length - tail)];
}

// ---- rendering -------------------------------------------------------------------------------
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ANSI_FG = { 30: '#5c6370', 31: '#ef6b73', 32: '#9ece6a', 33: '#e0af68', 34: '#7aa2f7', 35: '#bb9af7', 36: '#7dcfff', 37: '#c0caf5', 90: '#737aa2', 91: '#ff7a93', 92: '#b9f27c', 93: '#ff9e64', 94: '#7da6ff', 95: '#c0a8ff', 96: '#a4daff', 97: '#ffffff' };

function ansiToHtml(line) {
  let html = '';
  let open = false;
  let last = 0;
  const re = /\x1b\[([\d;]*)m/g;
  let m;
  while ((m = re.exec(line))) {
    html += esc(line.slice(last, m.index));
    last = re.lastIndex;
    const codes = m[1] === '' ? [0] : m[1].split(';').map(Number);
    const style = [];
    for (const c of codes) {
      if (ANSI_FG[c]) style.push(`color:${ANSI_FG[c]}`);
      else if (c === 1) style.push('font-weight:bold');
      else if (c === 2) style.push('opacity:.7');
    }
    if (open) html += '</span>';
    open = style.length > 0;
    if (open) html += `<span style="${style.join(';')}">`;
  }
  html += esc(line.slice(last));
  if (open) html += '</span>';
  return html;
}

function highlight(line) {
  if (/\x1b\[/.test(line)) return ansiToHtml(line);
  if (line.startsWith('\u0000OMIT')) return `<span class="omit">${esc(line.slice(6))}</span>`;
  if (/^\s*#/.test(line)) return `<span class="cmt">${esc(line)}</span>`;
  if (/^(error [A-Z_]+:|Error )/.test(line)) return `<span class="err">${esc(line)}</span>`;
  if (/^exit=\d+$/.test(line)) return `<span class="exit">${esc(line)}</span>`;
  if (/^(hint:)/.test(line)) return `<span class="hint">${esc(line)}</span>`;
  if (/^→ /.test(line)) return `<span class="key">${esc(line)}</span>`;
  // JSON  "key": value
  let m = /^(\s*)("[^"]+")(:\s?)(.*)$/.exec(line);
  if (m) return `${m[1]}<span class="key">${esc(m[2])}</span>${esc(m[3])}${valueSpan(m[4], m[2])}`;
  // YAML  key: value  /  - key: value
  m = /^(\s*(?:- )?)([^\s:#'"][^:]*?)(:)(\s.*|$)/.exec(line);
  if (m && !/^\s*(Usage|Options|Commands)/.test(line) && m[2].length < 48) return `${esc(m[1])}<span class="key">${esc(m[2])}</span>${esc(m[3])}${valueSpan(m[4], m[2])}`;
  return esc(line);
}

const BOOL_HEALTH_KEYS = /^"?(ok|healthy|reachable|healthy_overall|cursor_complete|complete)"?$/;
function valueSpan(v, key = '') {
  const t = v.trim().replace(/,$/, '');
  const k = key.trim();
  if (/^"?(error|partial|missing|fail|failed|denied|unhealthy)"?$/.test(t) || (BOOL_HEALTH_KEYS.test(k) && t === 'false')) return `<span class="bad">${esc(v)}</span>`;
  if (/^"?(success|succeeded|healthy|available|allowed|running)"?$/.test(t) || (BOOL_HEALTH_KEYS.test(k) && t === 'true')) return `<span class="good">${esc(v)}</span>`;
  if (/^"?(explicit|inferred|derived|sampled)"?$/.test(t)) return `<span class="rel">${esc(v)}</span>`;
  if (/^-?\d+(\.\d+)?,?$/.test(t)) return `<span class="num">${esc(v)}</span>`;
  return esc(v);
}

const PAGE_CSS = `
  :root { color-scheme: dark; }
  html, body { margin: 0; background: #e9ecf2; }
  body { padding: 24px; font-family: 'DejaVu Sans Mono', 'WenQuanYi Zen Hei Mono', monospace; }
  .win { width: 1100px; border-radius: 10px; overflow: hidden; background: #1a1b26; box-shadow: 0 8px 28px rgba(0,0,0,.28); }
  .bar { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: #2a2b3d; color: #a9b1d6; font-size: 13px; }
  .dot { width: 12px; height: 12px; border-radius: 50%; flex: none; }
  .bar .t { margin-left: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar .cfg { margin-left: auto; color: #737aa2; white-space: nowrap; padding-left: 12px; }
  pre { margin: 0; padding: 14px 18px 18px; color: #c0caf5; font: 13.5px/1.5 'DejaVu Sans Mono', 'WenQuanYi Zen Hei Mono', monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
  .prompt { color: #9ece6a; } .cmd { color: #e0e6ff; font-weight: bold; }
  .key { color: #7aa2f7; } .cmt { color: #e0af68; } .err { color: #ff7a93; font-weight: bold; } .hint { color: #ff9e64; }
  .exit { color: #ff9e64; font-weight: bold; } .bad { color: #ff7a93; } .good { color: #9ece6a; } .rel { color: #bb9af7; } .num { color: #ff9e64; }
  .omit { display: inline-block; margin: 2px 0; padding: 0 8px; color: #1a1b26; background: #737aa2; border-radius: 4px; }
`;

function terminalHtml({ title, cmd, config, lines }) {
  const body = lines.map(highlight).join('\n');
  const cfgLabel = `WORKCTL_CONFIG=${config}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body>
<div class="win" id="shot"><div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span class="t">${esc(title)}</span><span class="cfg">${esc(cfgLabel)}</span></div>
<pre><span class="prompt">$ </span><span class="cmd">${esc(cmd)}</span>
${body}</pre></div></body></html>`;
}

// minimal Markdown → HTML (headings, lists, tables, code, bold, inline code, paragraphs)
function inlineMd(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}
function markdownHtml(md) {
  const lines = md.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('\u0000OMIT')) { out.push(`<p class="omit">${esc(l.slice(6))}</p>`); i++; continue; }
    if (/^```/.test(l)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre>${esc(buf.join('\n'))}</pre>`);
      continue;
    }
    let m = /^(#{1,4})\s+(.*)$/.exec(l);
    if (m) { out.push(`<h${m[1].length}>${inlineMd(m[2])}</h${m[1].length}>`); i++; continue; }
    if (/^\|/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(rows[0]);
      const body = rows.slice(2).map(cells);
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inlineMd(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (/^\s*(\d+\.|-)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items = [];
      while (i < lines.length && /^\s*(\d+\.|-)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*(\d+\.|-)\s+/, ''));
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((x) => `<li>${inlineMd(x)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (!l.trim()) { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\||```|\s*(\d+\.|-)\s+)/.test(lines[i]) && !lines[i].startsWith('\u0000OMIT')) para.push(lines[i++]);
    out.push(`<p>${inlineMd(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

function markdownPage({ title, file, lines }) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
  html, body { margin: 0; background: #e9ecf2; }
  body { padding: 24px; }
  .win { width: 1100px; border-radius: 10px; overflow: hidden; background: #fff; box-shadow: 0 8px 28px rgba(0,0,0,.2); }
  .bar { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: #2a2b3d; color: #a9b1d6; font: 13px 'DejaVu Sans Mono', 'WenQuanYi Zen Hei Mono', monospace; }
  .dot { width: 12px; height: 12px; border-radius: 50%; }
  .bar .t { margin-left: 10px; }
  .doc { padding: 8px 28px 22px; color: #1f2330; font: 14px/1.6 'WenQuanYi Zen Hei', 'DejaVu Sans', sans-serif; }
  h1 { font-size: 18px; margin: 14px 0 6px; } h2 { font-size: 16px; margin: 16px 0 6px; border-bottom: 1px solid #e3e6ee; padding-bottom: 4px; } h3 { font-size: 15px; }
  strong { font-weight: 700; color: #000; -webkit-text-stroke: .3px #000; }
  code { font: 12.5px 'DejaVu Sans Mono', 'WenQuanYi Zen Hei Mono', monospace; background: #f1f3f8; padding: 1px 4px; border-radius: 3px; overflow-wrap: anywhere; }
  table { border-collapse: collapse; margin: 6px 0; font-size: 13px; } th, td { border: 1px solid #d9dde7; padding: 3px 8px; text-align: left; } th { background: #f4f6fa; }
  ul, ol { margin: 4px 0; padding-left: 24px; } li { margin: 1px 0; } p { margin: 6px 0; }
  .omit { display: inline-block; color: #fff; background: #737aa2; border-radius: 4px; padding: 0 8px; font: 13px 'DejaVu Sans Mono', monospace; }
  </style></head><body><div class="win" id="shot"><div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span class="t">${esc(file)}（Markdown 渲染）</span></div>
  <div class="doc">${markdownHtml(lines.join('\n'))}</div></div></body></html>`;
}

// ---- playwright ------------------------------------------------------------------------------
async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    /* fall through */
  }
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const req = createRequire(join(globalRoot, 'noop.js'));
    return await import(pathToFileURL(req.resolve('playwright')).href);
  } catch {
    throw new Error('找不到 playwright：npm i -D playwright（浏览器用 PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers 中预装的 Chromium）');
  }
}

function findChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (!existsSync(base)) return undefined;
  for (const d of readdirSync(base).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
    const p = join(base, d, 'chrome-linux/chrome');
    if (existsSync(p)) return p;
  }
  return undefined;
}

// 可选：用 python3 + Pillow 把截图量化为 256 色调色板 PNG（文字截图体积约减半）；不可用时保留原图
let pillow;
function shrinkPng(file) {
  if (pillow === false) return;
  const r = spawnSync('python3', ['-I', '-c', 'import sys\nfrom PIL import Image\nim=Image.open(sys.argv[1]).convert("RGB")\nim.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE).save(sys.argv[1], optimize=True)', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    pillow = false;
    console.log('  （python3/Pillow 不可用，跳过 PNG 量化）');
  }
}

// ---- main ------------------------------------------------------------------------------------
async function main() {
  mkdirSync(OUT, { recursive: true });
  const secrets = loadSecrets();
  console.log(`秘密值扫描：已载入 ${secrets.length} 个值`);
  let browser;
  let page;
  if (!textOnly) {
    const pw = await loadPlaywright();
    const chromium = pw.chromium ?? pw.default?.chromium;
    browser = await chromium.launch({ executablePath: findChromium() });
    page = await browser.newPage({ viewport: { width: 1148, height: 800 }, deviceScaleFactor: 1 });
  }
  const vars = {};
  const report = [];
  try {
    for (const [idx, step] of STEPS.entries()) {
      const nn = String(idx + 1).padStart(2, '0');
      const base = `${nn}-${step.id}`;
      const needed = !only || only.has(step.id) || (step.capture && [...only].some((id) => STEPS.find((s) => s.id === id)?.cmd?.includes(`{{${Object.keys(step.capture)[0]}}}`)));
      if (!needed) continue;

      let shown;
      let rawText;
      let html;
      if (step.render === 'markdown') {
        const md = readFileSync(join(ROOT, step.file), 'utf8').replace(/\s+$/, '');
        rawText = md;
        shown = truncate(md.split('\n'), step.maxLines ?? 60, step.tail ?? 0);
        html = markdownPage({ title: step.title, file: step.file, lines: shown });
      } else {
        if (step.guardExecute) {
          const g = sh('workctl access check --capability operation.execute', { WORKCTL_CONFIG: step.config ?? DEFAULT_CONFIG });
          if (!/verdict: denied/.test(g.stdout ?? '')) {
            report.push({ id: base, result: 'skipped', why: '安全检查：该 profile 未拒绝 operation.execute，不运行执行类命令' });
            console.log(`- ${base}: 跳过（profile 未拒绝执行）`);
            continue;
          }
        }
        let r;
        try {
          r = runStep(step, vars);
        } catch (e) {
          report.push({ id: base, result: 'skipped', why: e.message });
          console.log(`- ${base}: 跳过（${e.message}）`);
          continue;
        }
        if (looksUnknown(r.out) || (step.optional && r.status !== 0)) {
          report.push({ id: base, result: 'skipped', why: looksUnknown(r.out) ? `unknown command: ${r.out.split('\n')[0]}` : `可选步骤失败（exit ${r.status}）: ${r.out.split('\n')[0]}` });
          console.log(`- ${base}: 跳过（${report.at(-1).why}）`);
          continue;
        }
        if (r.signal) throw new Error(`${base}: 命令被 ${r.signal} 终止`);
        if (step.capture) {
          for (const [k, re] of Object.entries(step.capture)) {
            const m = re.exec(r.out);
            if (m) vars[k] = m[1];
          }
        }
        rawText = `$ ${r.cmd}\n# [截图脚本记录，非命令输出] WORKCTL_CONFIG=${r.config}\n${r.out}`;
        let lines = r.out.split('\n');
        if (step.keepKeys || step.blockMax) lines = keepTopKeys(lines, step.keepKeys ?? null, step.blockMax);
        shown = truncate(lines, step.maxLines ?? 48, step.tail ?? 8);
        html = terminalHtml({ title: step.title + ' — ' + r.cmd, cmd: r.cmd, config: r.config, lines: shown });
      }

      const leaked = [...secrets, ...EXTRA_FORBIDDEN].filter((s) => rawText.includes(s));
      if (leaked.length) {
        report.push({ id: base, result: 'FAILED', why: `输出包含 ${leaked.length} 个秘密值，未写文件` });
        console.log(`! ${base}: 输出包含秘密值，未写文件`);
        process.exitCode = 1;
        continue;
      }
      writeFileSync(join(OUT, `${base}.txt`), rawText.replace(/\x1b\[[\d;]*m/g, '') + '\n');
      if (!textOnly) {
        await page.setContent(html, { waitUntil: 'load' });
        await page.locator('#shot').screenshot({ path: join(OUT, `${base}.png`) });
        shrinkPng(join(OUT, `${base}.png`));
      }
      const omitted = shown.filter((l) => l.startsWith('\u0000OMIT')).length;
      report.push({ id: base, result: 'ok', why: `${rawText.split('\n').length} 行${omitted ? '，截图中有省略' : ''}` });
      console.log(`✓ ${base}`);
    }
  } finally {
    await browser?.close();
  }
  console.log('\n' + report.map((r) => `${r.result.padEnd(7)} ${r.id}  ${r.why}`).join('\n'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
