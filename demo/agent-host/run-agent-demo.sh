#!/usr/bin/env bash
# Run the three demo main lines through a real Agent host (Claude Code, headless).
# Requires: npm run build; demo environment up; offline scenarios produced.
# The agent gets a read-only copy of the demo profile (allow_execute: false), so it can
# plan but never execute changes, whatever it decides to do.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"
RUNS="$ROOT/demo/agent-host/runs"
mkdir -p "$RUNS"
sed 's/allow_execute: true/allow_execute: false/' demo/environment/workctl.yaml > demo/environment/workctl.agent.yaml
export WORKCTL_CONFIG="$ROOT/demo/environment/workctl.agent.yaml"
cat > "$RUNS/mcp.json" <<JSON
{ "mcpServers": { "workctl": { "command": "node", "args": ["$ROOT/dist/workctl.js", "mcp", "serve"], "env": { "WORKCTL_CONFIG": "$WORKCTL_CONFIG" } } } }
JSON
mkdir -p .workctl-bin && ln -sf "$ROOT/dist/workctl.js" .workctl-bin/workctl && export PATH="$ROOT/.workctl-bin:$PATH"
node dist/workctl.js skills install --dir .claude/skills --force >/dev/null

# Live anomaly for main lines A/B: warm cache, then cache bypass under steady load.
LOAD_PID=""
start_fault() {
  node demo/scenarios/latency/loadgen.mjs --rps 8 --duration 45 --seed 7 --label warmup >/dev/null 2>&1 || true
  demo/scenarios/latency/inject.sh >/dev/null
  node demo/scenarios/latency/loadgen.mjs --rps 8 --duration 1800 --seed 7 --label agent-demo > "$RUNS/loadgen.log" 2>&1 &
  LOAD_PID=$!
  sleep 60
}
stop_fault() {
  [ -n "$LOAD_PID" ] && kill "$LOAD_PID" 2>/dev/null || true
  demo/scenarios/latency/recover.sh >/dev/null || true
}
trap stop_fault EXIT

declare -A PROMPTS=(
  [A-infra]="看一下 demo-order（env sandbox）的运行资源和依赖，定位当前异常关联的实例、事件和资源情况。只做查询，不要执行任何变更。"
  [B-latency]="demo-order 最近变慢了，请检查 Redis 与 MySQL 的情况，并结合请求日志给出依据。区分已确认的事实与待验证的判断。只做查询。"
  [C-offline]="demo-daily-orders 对应业务日期 2026-10-16（Asia/Shanghai）的数据还没到，请沿依赖和计算链路检查，确认目标分区，并给出处理或补数计划（只生成计划，不执行）。"
)
ONLY="${1:-A-infra B-latency C-offline}"
# MODE=skill-mcp (default): project Skills + MCP tools + CLI.  MODE=cli-only: no Skills, no MCP,
# the agent only has the workctl CLI (comparison group for demo/evaluation.md).
MODE="${MODE:-skill-mcp}"
EMPTY_DIR="$(mktemp -d)"
start_fault
for key in $ONLY; do
  suffix=""; [ "$MODE" = "cli-only" ] && suffix=".cli-only"
  out="$RUNS/${key}${suffix}.json"
  echo "== ${key} (${MODE})"
  # Independent session: do not inherit the caller's session id.
  if [ "$MODE" = "cli-only" ]; then
    (cd "$EMPTY_DIR" && env -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION timeout 1200 claude -p "${PROMPTS[$key]} 可以使用 workctl 命令行（workctl --help）。" \
      --output-format stream-json --verbose --strict-mcp-config \
      --allowedTools "Bash(workctl:*)" \
      < /dev/null > "$out") || echo "run ${key} exited with $?"
  else
    env -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION timeout 1200 claude -p "${PROMPTS[$key]}" \
      --output-format stream-json --verbose \
      --mcp-config "$RUNS/mcp.json" \
      --allowedTools "Bash(workctl:*)" "Bash(node dist/workctl.js:*)" "Read" "Glob" "Grep" "Skill" "mcp__workctl" \
      < /dev/null > "$out" || echo "run ${key} exited with $?"
  fi
  node demo/agent-host/summarize-run.mjs "$out" > "$RUNS/${key}${suffix}.summary.md"
  head -5 "$RUNS/${key}${suffix}.summary.md"
done
