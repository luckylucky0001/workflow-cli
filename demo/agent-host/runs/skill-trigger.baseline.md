# Skill 触发评测（baseline）

生成时间 2026-10-17T17:34:25.488Z，命令 `node demo/agent-host/skill-trigger-eval.mjs --tag baseline`。每条提示在独立的 Claude Code 无头会话中运行（项目 Skill、只读 profile、最多 3 轮），记录实际加载的 Skill。

**命中 12/13**（期望的 Skill 被加载；只加载入口 Skill 记为 entry-only，不算命中）。

| 用例 | 期望 | 实际加载（按顺序） | 结论 | 前几个工具调用 |
| --- | --- | --- | --- | --- |
| latency | service-latency-investigation | service-latency-investigation | hit | Skill<br>Bash: export WORKCTL_CONFIG=demo/environment/workctl.yaml && ls di<br>Bash: grep -A5 '"bin"' package.json; ls dist |
| offline-delay | offline-delay-investigation | offline-delay-investigation | hit | Skill<br>Bash: export WORKCTL_CONFIG=${WORKCTL_CONFIG:-demo/environment/wor<br>Bash: which workctl; ls dist bin 2>&1 \| head; grep -n '"bin"' -A3  |
| capacity | resource-capacity-review | resource-capacity-review | hit | Skill<br>Bash: ls; (workctl --help 2>&1 \|\| node dist/cli/main.js --help 2>&<br>Bash: which workctl; ls; ls dist 2>/dev/null \| head |
| mysql | mysql-operations | mysql-operations | hit | Skill<br>Bash: export WORKCTL_CONFIG=demo/environment/workctl.yaml; workctl<br>Bash: WORKCTL_CONFIG=demo/environment/workctl.yaml workctl --json  |
| postgres | postgres-operations | postgres-operations | hit | Skill<br>Bash: workctl --json pg lock list --instance demo-postgres; echo - |
| redis | redis-operations | redis-operations | hit | Skill<br>Bash: export WORKCTL_CONFIG=${WORKCTL_CONFIG:-demo/environment/wor<br>Bash: export WORKCTL_CONFIG=demo/environment/workctl.yaml; which w |
| mq | mq-operations | mq-operations | hit | Skill<br>Bash: workctl --json capability list --domain mq 2>&1 \| head -30;  |
| search | search-operations | search-operations | hit | Skill<br>Bash: workctl --json search cluster get --cluster demo-search 2>&1<br>Bash: workctl --json search index --help 2>&1 \| head -20; curl -s  |
| deploy | deploy-operations | deploy-operations | hit | Skill<br>Bash: export WORKCTL_CONFIG=demo/environment/workctl.yaml; workctl<br>Bash: WORKCTL_CONFIG=demo/environment/workctl.yaml workctl deploy  |
| config | infra-operations | enterprise-infra | entry-only | Skill<br>Bash: cat skills/infra-operations/SKILL.md \| grep -n -i -B2 -A8 "c<br>Grep<br>Bash: which workctl; ls /home/user/workflow-cli |
| data-quality | data-validation | data-validation | hit | Skill<br>Bash: export WORKCTL_CONFIG=demo/environment/workctl.yaml; W="node<br>Bash: which workctl; ls /home/user/workflow-cli/dist |
| restart | infra-operations | infra-operations | hit | Skill<br>Bash: ls dist 2>/dev/null \| head -3; ls demo/environment 2>/dev/nu<br>Bash: ls dist demo/environment package.json |
| backfill | offline-operations / offline-delay-investigation | offline-operations | hit | Skill<br>Bash: workctl --json offline backfill plan --workflow demo-daily-o |

提示原文见 `demo/agent-host/skill-trigger-eval.mjs`。LLM 有非确定性，单次结果只说明趋势。
