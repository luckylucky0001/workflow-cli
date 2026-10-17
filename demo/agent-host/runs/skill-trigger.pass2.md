# Skill 触发评测（pass2）

生成时间 2026-10-17T17:52:05.351Z，命令 `node demo/agent-host/skill-trigger-eval.mjs --tag pass2`。每条提示在独立的 Claude Code 无头会话中运行（项目 Skill、只读 profile、最多 3 轮），记录实际加载的 Skill。

**命中 19/19**（期望的 Skill 被加载；只加载入口 Skill 记为 entry-only，不算命中）。

| 用例 | 期望 | 实际加载（按顺序） | 结论 | 前几个工具调用 |
| --- | --- | --- | --- | --- |
| latency | service-latency-investigation | service-latency-investigation | hit | Skill<br>Bash: workctl --json resource get --id demo-order<br>Bash: workctl --json container workload get --service demo-order<br>Bash: workctl --json container event list --service demo-order --w<br>Bash: workctl --json config get --service demo-order<br>Bash: workctl --json deploy release list --service demo-order --wi |
| offline-delay | offline-delay-investigation | offline-delay-investigation | hit | Skill<br>Bash: workctl --json offline workflow get --id demo-daily-orders<br>Bash: workctl --json offline run list --workflow demo-daily-orders<br>Bash: workctl --json offline freshness check --dataset analytics.d<br>Bash: workctl --json offline run get --workflow demo-daily-orders <br>Bash: workctl --json data partition get --table analytics.daily_or |
| capacity | resource-capacity-review | resource-capacity-review → enterprise-infra | hit | Skill<br>Skill<br>Bash: workctl --json resource list --service demo-order --env sand<br>Bash: workctl --json service dependency list --service demo-order<br>Bash: workctl --json capacity summary --env sandbox<br>Bash: workctl --json container workload get --service demo-order |
| mysql | mysql-operations | mysql-operations | hit | Skill<br>Bash: workctl --json --timeout 45s mysql statement summary --insta<br>Bash: workctl --json mysql slowlog list --instance demo-mysql --si |
| postgres | postgres-operations | postgres-operations | hit | Skill<br>Bash: workctl --json pg lock list --instance demo-postgres<br>Bash: workctl --json pg session list --instance demo-postgres |
| redis | redis-operations | redis-operations | hit | Skill<br>Bash: workctl --json redis instance get --instance demo-redis<br>Bash: workctl --json --timeout 45s redis stats sample --instance d<br>Bash: workctl --json redis key hot --instance demo-redis --max-key |
| mq | mq-operations | mq-operations | hit | Skill<br>Bash: workctl --json mq consumer lag --cluster demo-mq --group dem |
| search | search-operations | search-operations | hit | Skill<br>Bash: workctl --json search cluster get --cluster demo-search<br>Grep |
| deploy | deploy-operations | deploy-operations | hit | Skill<br>Bash: workctl --json deploy release list --service demo-order --wi<br>Bash: workctl --json deploy status get --service demo-order<br>Bash: workctl --json deploy rollback plan --service demo-order |
| config | infra-operations | infra-operations | hit | Skill<br>Bash: workctl --json config get --service demo-payment<br>Bash: workctl --json config diff --service demo-payment --from-rev |
| data-quality | data-validation | data-validation | hit | Skill<br>Bash: workctl --json data partition get --table analytics.daily_or<br>Bash: workctl --json data quality check --dataset demo.analytics.d<br>Bash: workctl --json data lineage get --table analytics.daily_orde<br>Bash: workctl --json data lineage get --table analytics.daily_orde |
| restart | infra-operations | infra-operations | hit | Skill<br>Bash: workctl --json container workload get --service demo-order<br>Bash: workctl --json resource list<br>Bash: workctl --json container workload restart-plan --service dem |
| backfill | offline-operations / offline-delay-investigation | offline-operations | hit | Skill<br>Bash: workctl --json offline backfill plan --workflow demo-daily-o |
| vague-timeout | service-latency-investigation | service-latency-investigation | hit | Skill<br>Bash: workctl --json resource list<br>Bash: workctl --json resource get --id demo-order<br>Bash: workctl --json service dependency list --service demo-order<br>Bash: workctl --json container workload get --service demo-order<br>Bash: workctl --json container event list --service demo-order --w |
| vague-report | offline-delay-investigation | offline-delay-investigation | hit | Skill<br>Bash: workctl --json offline workflow list<br>Bash: workctl offline --help; workctl offline freshness --help |
| vague-release | deploy-operations / service-latency-investigation | service-latency-investigation | hit | Skill<br>Bash: workctl --json resource get --id demo-order<br>Bash: workctl --json deploy release list --service demo-order --wi<br>Bash: workctl --json deploy status get --service demo-order<br>Bash: workctl --json container workload get --service demo-order<br>Bash: workctl --json metric query --resource demo-order --metric e |
| vague-pg | postgres-operations | postgres-operations | hit | Skill<br>Bash: workctl --json pg table get --table orders --database demo_o<br>Bash: workctl --json pg query explain --database demo_orders --sql |
| vague-discovery | infra-operations | infra-operations | hit | Skill<br>Bash: workctl --json discovery list --service demo-inventory |
| vague-capacity | resource-capacity-review | resource-capacity-review | hit | Skill<br>Bash: workctl --json capacity summary --env demo<br>Bash: workctl --json container workload get --service demo-order<br>Bash: workctl --json container stats get --service demo-order<br>Bash: workctl --json capacity summary --env sandbox<br>Bash: workctl --json metric query --resource demo-order --metric r |

提示原文见 `demo/agent-host/skill-trigger-eval.mjs`。LLM 有非确定性，单次结果只说明趋势。
