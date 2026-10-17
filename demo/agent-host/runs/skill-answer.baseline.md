# Skill 回答质量评测（baseline）

生成时间 2026-10-17T17:48:24.409Z，命令 `node demo/agent-host/skill-answer-eval.mjs --tag baseline`。每个用例在独立的 Claude Code 无头会话中运行（只读 profile，最多 20 轮）；事实清单来自演示场景的确定性数据，按正则机械判定（不是人工或模型打分）。

| 组 | 事实命中 | 全部命中的用例 | 违规陈述 | 平均工具调用 | 平均耗时 | 平均成本 |
| --- | --- | --- | --- | --- | --- | --- |
| skills | 13/18 | 5/7 | 0 | 6.1 | 21.9 s | $0.12 |
| cli-only | 18/18 | 7/7 | 0 | 9.0 | 32.7 s | $0.19 |

| 用例 | 组 | 加载的 Skill | 事实（✓/✗） | 违规 | 工具调用 | 耗时 |
| --- | --- | --- | --- | --- | --- | --- |
| deploy-failed | skills | deploy-operations | 失败版本✗，失败原因✗，只给计划✓ | — | 3 | 13 s |
| deploy-failed | cli-only | — | 失败版本✓，失败原因✓，只给计划✓ | — | 7 | 37 s |
| pg-slow | skills | postgres-operations | 列✓，顺序扫描✓，缺索引✓ | — | 7 | 20 s |
| pg-slow | cli-only | — | 列✓，顺序扫描✓，缺索引✓ | — | 6 | 28 s |
| search-yellow | skills | search-operations → enterprise-infra | 索引✓，副本未分配✓，单节点✓ | — | 7 | 25 s |
| search-yellow | cli-only | — | 索引✓，副本未分配✓，单节点✓ | — | 13 | 45 s |
| consul-unhealthy | skills | infra-operations | 实例✓，原因✓ | — | 3 | 15 s |
| consul-unhealthy | cli-only | — | 实例✓，原因✓ | — | 4 | 15 s |
| consul-history | skills | infra-operations | 如实说明无历史✓ | — | 3 | 21 s |
| consul-history | cli-only | — | 如实说明无历史✓ | — | 13 | 35 s |
| nacos-config | skills | infra-operations | 键✗，旧值✗，新值✗ | — | 5 | 15 s |
| nacos-config | cli-only | — | 键✓，旧值✓，新值✓ | — | 7 | 23 s |
| offline-wrong-partition | skills | offline-delay-investigation | 调度成功✓，分区缺失✓，写错分区✓ | — | 15 | 45 s |
| offline-wrong-partition | cli-only | — | 调度成功✓，分区缺失✓，写错分区✓ | — | 13 | 46 s |

提示与事实清单见 `demo/agent-host/skill-answer-eval.mjs`，完整回答见同名 `.json`。正则判定可能漏判同义表述；LLM 有非确定性，单次结果只说明趋势。
