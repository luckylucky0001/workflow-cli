---
name: mq-operations
description: 排查 Kafka 消息积压与消费组问题（消费组 lag、topic 分区/ISR/保留策略）。当用户提到 Kafka、消费延迟、消息积压、consumer lag、消费组、topic 分区或保留时间时使用；能力由 demo-mq 插件提供（workctl mq ...），RabbitMQ 待接入。不用于离线任务排队/等待（改用 offline-delay-investigation）。
---

# 消息队列排查（Kafka，demo-mq 插件）

> **调用约定**：profile/端点已由环境（`WORKCTL_CONFIG` / `--profile`）给定，直接以 `workctl` 开头调用，全局参数紧跟其后：`workctl --json <命令> ...`；不要加环境变量前缀、`cd`、管道或 `node dist/workctl.js`。命令被宿主拒绝时不要换写法绕过，说明需要授权的只读命令。

`mq` 领域由插件提供。先确认已安装：`workctl --json capability list --domain mq`；没有则 `workctl --json plugin install --file <demo-mq-plugin.tgz>`。

## 能力

| 目的 | 命令 |
|---|---|
| 消费组积压 | `workctl --json mq consumer lag --cluster <c> --group <g> [--topic <t>]` |
| topic 分区、ISR、水位、保留配置 | `workctl --json mq topic get --cluster <c> --topic <t>` |
| 列出 topic | `workctl --json mq topic list --cluster <c> [--include-internal]` |
| RabbitMQ 队列深度 | `mq.queue.get` 为 planned，不可调用；如实告知用户未接入 |

`--cluster` 是 profile 中 `endpoints.kafka` 的名字（演示环境 `demo-mq`），不是 broker 地址。

## 排查流程：“消费跟不上 / 消息积压”

1. `mq consumer lag` 看 `data.group_state`、`member_count`、`totals.total_lag`、`totals.max_partition_lag`。
   - `NOT_FOUND`：组名不对，从 `error.details.known_groups` 里确认，不要猜相近名字。
   - `group_state=Empty` 且 `member_count=0`：**没有消费者在运行**，积压来自消费者停止，而不是消费慢。
   - `Stable` 但 lag 集中在少数分区：看 `assigned_member`，可能是单个成员慢或分区倾斜。
   - `PreparingRebalance/CompletingRebalance`：正在重平衡，稍后复查，不要据此下结论。
2. 逐分区读 `state` 和 `explanation`：
   - `no_committed_offset`：lag 为 null，**不是 0，也不是 end_offset**；起点由消费者 `auto.offset.reset` 决定。
   - `committed_before_log_start`：部分消息已被 retention 删除，**已经丢失消费机会**，需要单独告知。
3. 需要判断是否会丢数据时，`mq topic get` 看 `configs["retention.ms"]`、`cleanup.policy` 与分区 `log_start_offset`。
4. 判断“在恶化还是在追赶”：隔一段时间再次调用，比较两次 `observed_at` 与 lag。单次 lag 只是快照。

## 口径（回答时必须遵守）

- lag 单位是**位点**，不是时间。不要说“延迟 N 秒”；需要时间维度时说明需结合生产速率，并标注为推断。
- 结束位点按 read_committed（LSO）读取；已提交位点与结束位点不是原子快照。
- 汇总的 `total_lag` 不包含 lag 为 null 的分区；有这类分区时同时报告 `partitions_without_commit`。
- Kafka lag 与 RabbitMQ 队列深度语义不同，不要相互换算或合并成一个“积压”数字。
- `status=partial` 时（如 topic 已删除、结果截断、缺 DescribeConfigs 权限），引用 `meta.coverage` 和 `meta.warnings` 说明缺了什么。
- 引用证据时带上 `meta.sources[].method` 与 `observed_at`；lag 本身是 `relation=derived` 的计算值。
- 读结果：通用规则（partial、空结果与各错误码的区分、累计/快照 vs 窗口、`relation`、`data.state`、planned、`data_mode`）见 `skills/enterprise-infra/SKILL.md` 第 4 步，单独加载本 Skill 时至少遵守：`status=partial` 读 `meta.coverage.notes` 并写明缺口；`COLLECTION_DISABLED`/`PERMISSION_DENIED`/`DATA_UNAVAILABLE` 都不是“没有”；结论引用 `meta.sources`。

## 错误处理

| code | 含义 | 下一步 |
|---|---|---|
| `NOT_CONFIGURED` | profile 没有该集群 | 看 `details.configured_clusters`，请用户补配置 |
| `UPSTREAM_UNAVAILABLE` / `TIMEOUT` | broker 不可达或超时 | 报告事实；可重试一次，不要把它当成“没有积压” |
| `UNAUTHENTICATED` / `PERMISSION_DENIED` | 凭据或 ACL 问题 | 需要 Describe / DescribeConfigs 权限；不要索要或输出密码 |
| `CAPABILITY_PLANNED` | 能力未接入 | 告知用户该能力尚未接入 |

## 边界

- 插件只读：不消费消息、不提交或重置位点、不改 topic 配置。位点重置等操作需由授权人员在终端用 Kafka 工具执行，你只能给出建议并说明影响。
- 凭据只以 `*_ref` 引用存在于配置中；不要在命令、回答中出现密码。
- 已验证版本：Kafka 3.9.1（隔离演示环境）。其它版本如实说明“未验证”。详见插件指南 `guides/mq.md`。
