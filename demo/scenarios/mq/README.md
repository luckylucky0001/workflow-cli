# 场景：Kafka 消费积压（demo-mq 插件）

目的：证明一个新系统（Kafka）可以只通过插件接入 workctl，并用真实 broker 上的真实位点回答“消费组积压了多少、为什么”。

所有消息都是合成数据（payload 含 `synthetic: true`，header `x-synthetic: true`）。

## 步骤（在仓库根目录执行）

```bash
# 1. 启动 Kafka（apache/kafka:3.9.1，KRaft 单节点，advertised localhost:19092）
(cd demo/environment && docker compose up -d kafka)

# 2. 制造真实积压：建 topic demo.order.events（3 分区）→ 生产 300 条合成订单事件
#    → 消费组 demo-consumer 每个分区只消费约 40% 并提交位点 → 退出（组内无成员）
node demo/scenarios/mq/produce-and-consume.mjs --reset

# 3. 构建并安装插件
node plugins/demo-mq/build.mjs
workctl plugin install --file plugins/demo-mq/dist/demo-mq-plugin.tgz

# 4. 查询（配置: export WORKCTL_CONFIG=$PWD/demo/environment/workctl.yaml）
workctl mq consumer lag --cluster demo-mq --group demo-consumer
workctl mq topic get --cluster demo-mq --topic demo.order.events
workctl mq topic list --cluster demo-mq

# 5.（可选）交叉核对：Kafka 自带工具给出的 LAG 应与 workctl 一致
docker exec demo-kafka /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:19092 --describe --group demo-consumer
```

脚本参数：`--messages N`（默认 300）、`--consume-ratio 0..1`（默认 0.4，按分区计算本次新消息中消费的比例）、`--skip-partition P`（该分区不消费、不提交，用来演示“无已提交位点”）、`--reset`（先删除组和 topic）、`--brokers host:port`。不带 `--reset` 重复运行会在现有位点基础上继续生产和部分消费，积压逐步累积。

脚本结束时会打印它自己算出的“预期 lag”，可与第 4 步的 `data.topics[].partitions[].lag` 对照。分区分布由 key（order_id）哈希决定，每次运行的具体数字会不同。

## 期望看到什么

- `data.group_state = Empty`、`member_count = 0`：积压的原因是**没有消费者在运行**，而不是消费慢。
- 每个分区 `lag = end_offset - committed_offset`，`totals.total_lag` 为合计，`max_partition_lag` 指出最大的分区。
- `meta.sources`：DescribeGroups / OffsetFetch / ListOffsets 为 `explicit`，lag 计算为 `derived`。
- 使用 `--skip-partition 2` 时，分区 2 为 `state=no_committed_offset`、`lag=null`，并在 `explanation` 与 `meta.warnings` 中说明未计入合计。
- 不存在的组：`workctl mq consumer lag --cluster demo-mq --group nope` → `NOT_FOUND`（退出码 5），`details.known_groups` 列出 `demo-consumer`。

## 复位

```bash
node demo/scenarios/mq/produce-and-consume.mjs --reset      # 删除并重建 topic 与消费组
```
