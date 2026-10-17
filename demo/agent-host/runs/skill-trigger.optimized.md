# Skill 触发评测（optimized）

生成时间 2026-10-17T17:43:51.445Z，命令 `node demo/agent-host/skill-trigger-eval.mjs --tag optimized`。每条提示在独立的 Claude Code 无头会话中运行（项目 Skill、只读 profile、最多 3 轮），记录实际加载的 Skill。

**命中 19/19**（期望的 Skill 被加载；只加载入口 Skill 记为 entry-only，不算命中）。

| 用例 | 期望 | 实际加载（按顺序） | 结论 | 前几个工具调用 |
| --- | --- | --- | --- | --- |
| latency | service-latency-investigation | service-latency-investigation | hit | Skill<br>Bash: export WORKCTL_CONFIG=demo/environment/workctl.yaml; which w<br>Bash: ls dist bin 2>&1 \| head; grep -n '"bin"' -A3 package.json |
| offline-delay | offline-delay-investigation | offline-delay-investigation | hit | Skill<br>Bash: export WORKCTL_CONFIG=${WORKCTL_CONFIG:-demo/environment/wor<br>Bash: which workctl; ls; ls dist 2>/dev/null \| head; workctl --jso |
| capacity | resource-capacity-review | resource-capacity-review → enterprise-infra | hit | Skill<br>Skill<br>Bash: ls; ls dist 2>/dev/null \| head -3; ls demo/environment 2>/de<br>Bash: (workctl --json service dependency list --service demo-order<br>Bash: workctl --json resource list --service demo-order --env sand<br>Bash: workctl --json service dependency list --service demo-order  |
| mysql | mysql-operations | mysql-operations | hit | Skill<br>Bash: export WORKCTL_CONFIG=demo/environment/workctl.yaml; workctl<br>Bash: workctl --json mysql instance get --instance demo-mysql<br>Bash: workctl --json --timeout 45s mysql statement summary --insta |
| postgres | postgres-operations | postgres-operations | hit | Skill<br>Bash: workctl --json pg lock list --instance demo-postgres; echo - |
| redis | redis-operations | redis-operations | hit | Skill<br>Bash: export WORKCTL_CONFIG=demo/environment/workctl.yaml; (workct<br>Bash: export WORKCTL_CONFIG=demo/environment/workctl.yaml && workc<br>Bash: export WORKCTL_CONFIG=demo/environment/workctl.yaml && workc<br>Bash: export WORKCTL_CONFIG=demo/environment/workctl.yaml && workc |
| mq | mq-operations | mq-operations | hit | Skill<br>Bash: workctl --json capability list --domain mq 2>&1 \| head -40;  |
| search | search-operations | search-operations | hit | Skill<br>Bash: workctl --json search cluster get --cluster demo-search 2>&1<br>Bash: curl -s localhost:9200/_cat/indices?h=index,health 2>&1 \| he |
| deploy | deploy-operations | deploy-operations | hit | Skill<br>Bash: export WORKCTL_CONFIG=${WORKCTL_CONFIG:-demo/environment/wor<br>Bash: which workctl; ls dist demo/environment 2>&1 \| head -20; cat |
| config | infra-operations | infra-operations | hit | Skill<br>Bash: workctl config get --service demo-payment --json 2>&1 \| head<br>Bash: workctl config diff --service demo-payment --json 2>&1 \| hea |
| data-quality | data-validation | data-validation | hit | Skill<br>Bash: export WORKCTL_CONFIG=demo/environment/workctl.yaml; workctl<br>Bash: export WORKCTL_CONFIG=demo/environment/workctl.yaml; workctl<br>Bash: WORKCTL_CONFIG=demo/environment/workctl.yaml workctl --json <br>Bash: WORKCTL_CONFIG=demo/environment/workctl.yaml workctl --json <br>Bash: WORKCTL_CONFIG=demo/environment/workctl.yaml workctl --json  |
| restart | infra-operations | infra-operations | hit | Skill<br>Bash: (workctl container workload get --service demo-order --json <br>Bash: workctl container workload get --service demo-order --json |
| backfill | offline-operations / offline-delay-investigation | offline-operations | hit | Skill<br>Bash: workctl --json offline backfill plan --workflow demo-daily-o<br>Bash: which workctl; ls dist 2>/dev/null \| head; grep -n '"bin"' - |
| vague-timeout | service-latency-investigation | service-latency-investigation → enterprise-infra | hit | Skill<br>Skill<br>Bash: export WORKCTL_CONFIG=${WORKCTL_CONFIG:-demo/environment/wor<br>Bash: ls; ls dist demo/environment 2>&1 \| head -30; grep -n '"bin" |
| vague-report | offline-delay-investigation | offline-delay-investigation | hit | Skill<br>Bash: (WORKCTL_CONFIG=demo/environment/workctl.yaml node dist/cli/<br>Bash: which workctl; ls /home/user/workflow-cli/dist 2>&1 \| head;  |
| vague-release | deploy-operations / service-latency-investigation | service-latency-investigation | hit | Skill<br>Bash: ls; (which workctl; ls dist 2>/dev/null \| head; ls demo/envi<br>Bash: ls<br>Bash: which workctl; ls /home/user/workflow-cli/dist /home/user/wo |
| vague-pg | postgres-operations | postgres-operations | hit | Skill<br>Bash: export WORKCTL_CONFIG=demo/environment/workctl.yaml; (node d<br>Bash: which workctl; ls /home/user/workflow-cli/dist /home/user/wo |
| vague-discovery | infra-operations | infra-operations | hit | Skill<br>Bash: ls; (WORKCTL_CONFIG=demo/environment/workctl.yaml node dist/<br>Bash: workctl discovery list --service demo-inventory --json |
| vague-capacity | resource-capacity-review | resource-capacity-review | hit | Skill<br>Bash: ls demo/environment 2>/dev/null \| head; export WORKCTL_CONFI<br>Bash: which workctl; ls dist demo/environment |

提示原文见 `demo/agent-host/skill-trigger-eval.mjs`。LLM 有非确定性，单次结果只说明趋势。
