# Skill 回答质量评测（nacos-v2）

生成时间 2026-10-17T18:00:22.192Z，命令 `node demo/agent-host/skill-answer-eval.mjs --tag nacos-v2`。每个用例在独立的 Claude Code 无头会话中运行（只读 profile，最多 20 轮）；事实清单来自演示场景的确定性数据，按正则机械判定（不是人工或模型打分）。

| 组 | 事实命中 | 全部命中的用例 | 违规陈述 | 平均工具调用 | 平均耗时 | 平均成本 |
| --- | --- | --- | --- | --- | --- | --- |
| skills | 3/3 | 1/1 | 0 | 3.0 | 14.6 s | $0.10 |
| cli-only | 3/3 | 1/1 | 0 | 4.0 | 16.2 s | $0.09 |

| 用例 | 组 | 加载的 Skill | 事实（✓/✗） | 违规 | 工具调用 | 耗时 |
| --- | --- | --- | --- | --- | --- | --- |
| nacos-config | skills | infra-operations | 键✓，旧值✓，新值✓ | — | 3 | 15 s |
| nacos-config | cli-only | — | 键✓，旧值✓，新值✓ | — | 4 | 16 s |

提示与事实清单见 `demo/agent-host/skill-answer-eval.mjs`，完整回答见同名 `.json`。正则判定可能漏判同义表述；LLM 有非确定性，单次结果只说明趋势。
