---
name: enterprise-infra
description: 当任务涉及计算/容器、网络、存储、数据库（MySQL）、缓存（Redis）、消息队列，或离线调度、计算作业、数据分区、血缘和数据质量时使用。提供 workctl 能力发现、结果解读和跨系统组合的入口流程。
---

# 企业基础设施 / 中间件 / 离线链路入口

workctl 是统一 CLI：`workctl <domain> [resource] <action> [options]`，加 `--json` 得到统一结果信封。所有命令共享同一套 profile、凭据引用、错误码和输出契约。

## 流程

1. **明确对象与范围**：环境（profile 的 env）、资源或任务标识（服务名、实例名、工作流、表），以及时间窗口或**业务数据区间**（业务日期 + 时区，不等于启动日期）。缺失时先问或用资源目录查。
2. **定位资源与能力**
   - `workctl --json resource list --service <svc> --env <env>` / `workctl --json service dependency list --service <svc>`：依赖关系，每条带 `source` 和 `evidence`。没有记录的关系不要凭名称相似推断。
   - `workctl --json capability list [--domain mysql]`：能力目录；`status=planned` 的能力不可调用，如实告诉用户“待接入”。
   - `workctl capability get --name <cap>` 或 `workctl <command> --help`：参数、口径说明、前置条件。
3. **按需读取领域指南与 Skill**（只读需要的）：
   - 基础设施/可观测：`skills/infra-operations`、`docs/guides/infrastructure.md`、`docs/guides/observability.md`
   - MySQL / Redis：`skills/mysql-operations`、`skills/redis-operations`
   - 离线链路：`skills/offline-operations`、`skills/data-validation`
   - 跨系统流程：`skills/service-latency-investigation`、`skills/offline-delay-investigation`、`skills/resource-capacity-review`
   - 消息队列（插件）：安装 demo-mq 插件后见 `capability get --name mq.consumer.lag`
4. **执行查询并读懂信封**
   - `status`: success / partial / error。partial = 结果不完整，看 `meta.coverage.notes`。
   - `data` 里的业务状态（如任务 `state=running`）与调用状态无关。
   - `meta.sources[]`：来源系统、方法、观测时间、实际版本、`relation`（explicit 明确 / inferred 推断 / derived 派生 / sampled 采样）。结论中引用证据时带上来源。
   - `meta.coverage`：窗口、是否采样、是否截断。采样结果不能当全量；累计值不能当窗口值。
   - 错误码：`COLLECTION_DISABLED`（未采集，不是“没有”）、`DATA_UNAVAILABLE`、`PERMISSION_DENIED`、`UNAUTHENTICATED`、`NOT_FOUND`、`UPSTREAM_UNAVAILABLE`、`NOT_CONFIGURED`、`CAPABILITY_PLANNED`。
5. **组合与关联**：按依赖关系逐层查询，用同一时间窗口对齐指标、日志、慢日志和任务实例。离线链路分层检查：调度状态 → 计算状态 → 分区产出 → 质量规则，每层单独给证据。
6. **操作**：先 `operation plan` / 领域 `... plan` 生成计划（实际目标、影响范围、前置条件、步骤）。计划预览不是执行成功的证据。执行需用户确认，且 `operation execute --id <id> --confirm <id>` 只在 profile 允许执行时可用；Agent 不应自行执行变更。
7. **输出结论**：分三部分——**事实**（带命令与来源）、**判断/假设**（说明依据和不确定性）、**待验证项与下一步**（可复现的命令、任务 ID、计划 ID）。

## 规则

- 不在命令、Skill 或回答中写入凭据；凭据只通过 profile 的 `*_ref` 引用。
- 不把 `planned` 能力描述为可用；不把合成/录制数据当作实时数据（看 `context.data_mode` 与 warnings）。
- 空结果要说明覆盖范围（窗口、采样、权限），不能直接说“没有问题”。
- 采样类命令（`mysql statement summary --sample-window`、`redis stats sample --duration`）需要 `--timeout` 大于采样时长。
