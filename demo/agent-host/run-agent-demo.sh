#!/usr/bin/env bash
# Run the three demo main lines through a real Agent host (Claude Code, headless).
# Requires: npm run build; demo environment up; skills installed into .claude/skills.
set -euo pipefail
cd "$(dirname "$0")/../.."
export WORKCTL_CONFIG="$PWD/demo/environment/workctl.yaml"
mkdir -p demo/agent-host/runs
# Keep the CLI on PATH for the agent's Bash tool.
mkdir -p .workctl-bin && ln -sf "$PWD/dist/workctl.js" .workctl-bin/workctl && export PATH="$PWD/.workctl-bin:$PATH"

declare -A PROMPTS=(
  [A-infra]="看一下 demo-order（env sandbox）的运行资源和依赖，定位当前异常关联的实例、事件和资源情况。只做查询，不要执行任何变更。"
  [B-latency]="demo-order 最近变慢了，请检查 Redis 与 MySQL 的情况，并结合请求日志给出依据。区分已确认的事实与待验证的判断。只做查询。"
  [C-offline]="demo-daily-orders 对应业务日期 2026-10-16（Asia/Shanghai）的数据还没到，请沿依赖和计算链路检查，确认目标分区，并给出处理或补数计划（只生成计划，不执行）。"
)
for key in A-infra B-latency C-offline; do
  out="demo/agent-host/runs/${key}.json"
  echo "== ${key}"
  # Run as an independent session (do not inherit the caller's session id).
  env -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION timeout 900 claude -p "${PROMPTS[$key]}" \
    --output-format stream-json --verbose \
    --mcp-config demo/agent-host/mcp.json \
    --allowedTools "Bash(workctl:*)" "Read" "Glob" "Grep" "mcp__workctl" \
    > "$out" || echo "run ${key} exited with $?"
  node demo/agent-host/summarize-run.mjs "$out" | tee "demo/agent-host/runs/${key}.summary.md"
done
