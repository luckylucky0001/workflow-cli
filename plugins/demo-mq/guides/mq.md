# 消息队列（mq）领域指南 — demo-mq 插件

`mq` 领域不是 workctl 内置能力，而是由 **demo-mq 插件**（`workctl-plugin/1`）接入的：安装插件包后，`workctl mq ...` 命令、能力目录、`--help`、MCP 工具描述和输出 Schema 都来自插件清单 `workctl-plugin.json`，执行时由 core 以子进程方式调用 `node dist/plugin.mjs`，返回与内置能力相同的统一信封。

| 能力 | 命令 | 状态 | 说明 |
|---|---|---|---|
| `mq.consumer.lag` | `mq consumer lag --cluster --group [--topic]` | available | 消费组状态、成员、每分区已提交位点 / 结束位点 / lag |
| `mq.topic.get` | `mq topic get --cluster --topic` | available | 分区 leader / 副本 / ISR、高低水位、关键配置 |
| `mq.topic.list` | `mq topic list --cluster [--include-internal] [--limit]` | available | topic 名与分区数 |
| `mq.queue.get` | `mq queue get --cluster --queue [--vhost]` | planned | RabbitMQ 队列深度，仅在目录中出现，不生成可调用命令 |

## 对象模型（Kafka）

- **集群（cluster）**：`--cluster` 取 profile 中 `endpoints.kafka` 下的 endpoint 名（演示环境为 `demo-mq`），不是 broker 地址。
- **topic / 分区（partition）**：消息按分区追加，每条消息有分区内单调递增的 **位点（offset）**。
  - `log_start_offset`：分区当前最早可读位点；更早的消息已被 retention 或 compaction 清理。
  - `end_offset`：ListOffsets(latest) 返回的结束位点（下一条将写入的位点）。插件按 **read_committed** 读取，即 LSO；没有未完成事务时等于高水位（HW）。
- **消费组（consumer group）**：由 `group.id` 标识，组内成员分摊分区。组状态来自 DescribeGroups：`Stable`（有成员在消费）、`Empty`（无成员，但可能保留已提交位点）、`PreparingRebalance` / `CompletingRebalance`（重平衡中）、`Dead`（组不存在或已删除）。
- **已提交位点（committed offset）**：消费组提交的“下一条要读的位点”，存放在 `__consumer_offsets`。`-1` 表示该分区 **没有已提交位点**。

## lag 口径

```
lag(partition) = end_offset - committed_offset        单位：位点（offsets）
```

- **位点差，不是时间延迟**。lag=1000 在每秒 10 条和每秒 1 万条的 topic 上意味着完全不同的追赶时间；需要时间维度请结合生产速率或消息时间戳另行分析，不要把 lag 直接说成“延迟 N 秒”。
- **快照**：已提交位点（OffsetFetch）与结束位点（ListOffsets）分两次请求读取，不是原子快照；结果对应 `data.observed_at` 时刻，各请求的时间见 `meta.sources[].observed_at`。
- **无已提交位点**：分区 `state=no_committed_offset`，`lag=null`，不计入 `total_lag`，并给出解释——消费者下次启动时按 `auto.offset.reset`（earliest/latest）决定起点，此时“积压”取决于该配置，不能按位点计算。
- **位点早于日志起点**：`state=committed_before_log_start`，lag 仍按位点差给出（与 `kafka-consumer-groups.sh` 一致），但解释中说明有多少位点的消息已被 retention 删除、仍可消费的积压是多少。
- **已提交位点大于结束位点**：`state=committed_ahead_of_end`，lag 不计算（常见于 topic 删除重建）。
- **事务与 compaction**：事务控制记录也占用位点，compacted topic 中位点不连续，因此 lag 是位点数，不严格等于消息条数。
- **成员分配**：仅对协议类型为 `consumer` 的组解码分配信息，`assigned_member` 为当前分配到该分区的成员 `client_id`；`Empty` 组无成员时为 `null`。
- **不做归一化**：Kafka 消费组 lag 与 RabbitMQ 队列深度（ready / unacked 消息数）语义不同；两者都接入后也分别表达，不换算成同一个“积压”指标。

## 结果契约要点

| 情况 | 返回 |
|---|---|
| 组存在，有位点 | `success`，`coverage.complete=true` |
| 组存在但某些分区无已提交位点 | `success`，这些分区 `lag=null` + explanation，`meta.warnings` 说明未计入合计 |
| 组存在但没有任何位点、也没有分配 | `success`，`topics=[]` + warning |
| 不存在的组（Kafka 返回 `Dead` 且无位点） | `NOT_FOUND`，`details.known_groups` 列出已有组 |
| `--topic` 不存在 | `NOT_FOUND` |
| 组仍保留已删除 topic 的位点 | `partial`，这些分区 `state=end_offset_unavailable`，`coverage.complete=false` |
| topic 数超过 `--limit` | `partial`，`coverage.truncated=true` |
| 无 DescribeConfigs 权限（topic get） | `partial`，分区与位点完整，`configs={}` |
| broker 不可达 | `UPSTREAM_UNAVAILABLE`；超出时间预算为 `TIMEOUT` |
| SASL 认证失败 / 缺凭据 | `UNAUTHENTICATED`；ACL 拒绝为 `PERMISSION_DENIED` |
| profile 未配置该集群 | `NOT_CONFIGURED`，`details.configured_clusters` 列出已配置集群 |

`meta.sources` 中 Kafka API 调用标注 `relation=explicit`，lag 计算标注 `relation=derived`。

## 端点配置

```yaml
profiles:
  demo:
    defaults:
      kafka: demo-mq
    endpoints:
      kafka:
        demo-mq:
          brokers: [127.0.0.1:19092]
          client_id: workctl
          # 可选：
          # ssl: true
          # ssl_ca_file: /etc/ssl/kafka-ca.pem        # 相对路径以插件安装目录为基准，建议写绝对路径
          # sasl_mechanism: scram-sha-512             # plain | scram-sha-256 | scram-sha-512
          # sasl_username: workctl_ro
          # sasl_password_ref: env:KAFKA_RO_PASSWORD  # 只允许引用；core 解析后仅经 stdin 传给插件
```

所需最小权限（Kafka ACL）：Cluster `Describe`、Topic `Describe` / `DescribeConfigs`、Group `Describe`。插件只调用只读 Admin API，不消费消息、不提交位点、不修改配置。

## 兼容性与验证状态

- 声明支持：Kafka **3.x** broker（`compatibility.engines[0].versions`）。客户端为插件内打包的 kafkajs 2.2.4。
- **已验证**：Kafka **3.9.1**（隔离演示环境 `demo-kafka`，镜像 `apache/kafka:3.9.1`，KRaft 单节点；broker 启动日志 `Kafka version: 3.9.1`，DescribeConfigs 返回 `inter.broker.protocol.version=3.9-IV0`）。其它 3.x 版本属于“声明支持、未在本环境验证”。
- Kafka 协议不返回 broker 软件版本号，`meta.sources[].version` 记录的是 broker 配置 `inter.broker.protocol.version`（协议级别），读取失败时留空并给 warning。
- `backend_mode: live`：插件直连真实 broker，没有模拟回包；演示数据由 `demo/scenarios/mq/produce-and-consume.mjs` 生成，消息体带 `synthetic: true`。
- 验证层级：设计 + 实现 + 隔离环境验证；**未在客户环境验证**。

## 已知限制

- 结束位点固定按 read_committed（kafkajs Admin 不提供隔离级别选项），存在长事务时 lag 以 LSO 为准，低于按 HW 计算的值。
- 内部 topic 按 Kafka 内置名单（`__consumer_offsets`、`__transaction_state`、`__share_group_state`）判定，kafkajs Admin 不暴露 Metadata 的 `isInternal` 标志。
- 不支持 Kafka 4.x 新消费组协议（KIP-848 `consumer` group type）的专有描述字段，也未在 4.x 上验证。
- 不提供基于时间的 lag（需读取消息时间戳），不提供位点重置等写操作。
- `mq.queue.get`（RabbitMQ）为 planned：仅在目录中列出，调用返回 `CAPABILITY_PLANNED`。
