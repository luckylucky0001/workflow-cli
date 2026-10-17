# Skill 触发评测（baseline-vague）

生成时间 2026-10-17T17:34:55.555Z，命令 `node demo/agent-host/skill-trigger-eval.mjs --tag baseline-vague`。每条提示在独立的 Claude Code 无头会话中运行（项目 Skill、只读 profile、最多 3 轮），记录实际加载的 Skill。

**命中 5/6**（期望的 Skill 被加载；只加载入口 Skill 记为 entry-only，不算命中）。

| 用例 | 期望 | 实际加载（按顺序） | 结论 | 前几个工具调用 |
| --- | --- | --- | --- | --- |
| vague-timeout | service-latency-investigation | service-latency-investigation | hit | Skill<br>Bash: ls; ls demo demo/environment 2>/dev/null \| head -50; echo --<br>Bash: ls /home/user/workflow-cli /home/user/workflow-cli/demo/envi |
| vague-report | offline-delay-investigation | offline-delay-investigation | hit | Skill<br>Bash: ls; (grep -rniE "order.*(daily\|日报)\|daily.*order" demo docs/*<br>Grep |
| vague-release | deploy-operations / service-latency-investigation | deploy-operations → service-latency-investigation | hit | Skill<br>Skill<br>Bash: export WORKCTL_CONFIG=demo/environment/workctl.yaml; (workct<br>Bash: which workctl; ls dist 2>/dev/null \| head; ls demo/environme |
| vague-pg | postgres-operations | postgres-operations | hit | Skill<br>Bash: export WORKCTL_CONFIG=demo/environment/workctl.yaml; node di<br>Bash: WORKCTL_CONFIG=demo/environment/workctl.yaml workctl --json  |
| vague-discovery | infra-operations | （无） | none | Grep<br>Bash: ls; ls src/domains; ls dist 2>/dev/null \| head<br>Bash: grep -n "discovery" docs/command-reference.md \| head -20; ca<br>Bash: WORKCTL_CONFIG=demo/environment/workctl.yaml timeout 60 node |
| vague-capacity | resource-capacity-review | resource-capacity-review | hit | Skill<br>Bash: ls demo/environment 2>/dev/null \| head; export WORKCTL_CONFI<br>Bash: ls demo/environment dist; which workctl docker |

提示原文见 `demo/agent-host/skill-trigger-eval.mjs`。LLM 有非确定性，单次结果只说明趋势。
