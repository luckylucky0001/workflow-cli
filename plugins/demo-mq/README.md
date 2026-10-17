# demo-mq — workctl 消息队列演示插件（Kafka）

演示“新系统通过插件机制接入”：不修改 workctl core，把 Kafka 消息队列接入为 `mq` 领域能力（CLI + Skill + 文档 + 输出 Schema）。

- 插件协议：`workctl-plugin/1`；后端模式：`live`（直连真实 broker，无模拟回包）
- 能力：`mq.consumer.lag`、`mq.topic.get`、`mq.topic.list`（available），`mq.queue.get`（RabbitMQ，planned）
- 兼容性：Kafka 3.x；已在 Kafka 3.9.1（隔离演示环境）验证
- 领域指南：`guides/mq.md`；Skill：`skills/mq-operations/SKILL.md`

## 包结构

```
workctl-plugin.json            清单：领域、能力、输入、兼容性、backend_mode
dist/plugin.mjs                单文件 esbuild 产物（内含 kafkajs、zod），core 以 `node dist/plugin.mjs` 执行
schemas/mq.*.v1.json           各能力 data 的 JSON Schema（由 zod 生成）
guides/mq.md                   领域指南：对象模型、lag 口径、兼容性、限制
skills/mq-operations/SKILL.md  Agent 排查流程
README.md
```

## 构建与安装

```bash
node plugins/demo-mq/build.mjs                          # → plugins/demo-mq/dist/demo-mq-plugin.tgz
workctl plugin install --file plugins/demo-mq/dist/demo-mq-plugin.tgz
workctl --json capability list --domain mq
workctl mq consumer lag --cluster demo-mq --group demo-consumer
```

源码在 `plugins/demo-mq/src/`：`manifest.ts`（清单唯一来源）、`capabilities.ts`（处理逻辑）、`lag.ts`（纯计算，可单测）、`kafka.ts`（客户端、端点解析、错误映射）、`schemas.ts`（输出 zod schema）、`protocol.ts`、`plugin.ts`（入口）。构建时校验：每个 available 能力都有 handler 和输出 Schema，planned 能力没有 handler。

## 执行协议

core 把一个 JSON 请求写入插件的 stdin：

```json
{"protocol":"workctl-plugin/1","capability":"mq.consumer.lag",
 "inputs":{"cluster":"demo-mq","group":"demo-consumer"},
 "endpoints":{"kafka":{"demo-mq":{"brokers":["127.0.0.1:19092"],"client_id":"workctl"}}},
 "defaults":{"kafka":"demo-mq"},"profile":"demo","env":"sandbox","request_id":"req-...","timeout_ms":30000}
```

插件向 stdout 写且仅写一个 JSON 文档并以 0 退出（错误也在 JSON 中表达）：

```json
{"status":"success|partial|error","data":{},"error":null,
 "meta":{"sources":[{"system":"kafka","adapter":"kafka-admin","endpoint":"kafka/demo-mq","method":"OffsetFetch(group=demo-consumer)","observed_at":"...","version":"inter.broker.protocol.version=3.9-IV0","relation":"explicit"}],
         "coverage":{"complete":true},"warnings":[]}}
```

- 日志只写 stderr（kafkajs 日志默认关闭，`WORKCTL_DEBUG=1` 时以 WARN 级别写 stderr）。
- 凭据：配置里的 `sasl_password_ref` 由 core 解析后以 `sasl_password` 经 stdin 传入，插件不打印、不回显。
- 时间预算：插件在 `timeout_ms - 500ms` 内返回 `TIMEOUT`，早于 core 的强制终止。

## 手动调试

```bash
echo '{"protocol":"workctl-plugin/1","capability":"mq.topic.list","inputs":{"cluster":"demo-mq"},"endpoints":{"kafka":{"demo-mq":{"brokers":["127.0.0.1:19092"]}}},"defaults":{},"timeout_ms":10000}' \
  | node plugins/demo-mq/dist/plugin.mjs
```

## 测试

```bash
npx vitest run test/plugins/demo-mq.test.ts                 # 单元测试（lag 计算、错误映射、清单）
WORKCTL_IT=1 npx vitest run test/plugins/demo-mq.test.ts    # 加上对 demo-kafka 的实时测试（自建并清理临时 topic/组）
```
