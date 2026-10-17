---
name: enterprise-infra
description: workctl 入口：当任务涉及容器/网络/存储、配置中心与服务发现（etcd/Nacos/Consul）、发布记录（Kubernetes/Jenkins）、MySQL/PostgreSQL、Redis、Kafka、OpenSearch，或离线调度、Spark 作业、数据分区、血缘和质量，而不确定用哪个领域 skill、需要能力发现或跨系统组合时使用。提供能力发现、结果信封解读规则和路由表；不替代领域 skill：问题已明确属于某领域时同时加载对应领域 skill 或排查流程 skill。
---

# 企业基础设施 / 中间件 / 离线链路入口

> **调用约定**：profile/端点已由环境（`WORKCTL_CONFIG` / `--profile`）给定，直接以 `workctl` 开头调用，全局参数紧跟其后：`workctl --json <命令> ...`；不要加环境变量前缀、`cd`、管道或 `node dist/workctl.js`。命令被宿主拒绝时不要换写法绕过，说明需要授权的只读命令。

workctl 是统一 CLI：`workctl <domain> [resource] <action> [options]`，加 `--json` 得到统一结果信封。所有命令共享同一套 profile、凭据引用、错误码和输出契约。

## 流程

1. **明确对象与范围**：环境（profile 的 env）、资源或任务标识（服务名、实例名、工作流、表），以及时间窗口或**业务数据区间**（业务日期 + 时区，不等于启动日期）。缺失时先问或用资源目录查。
2. **定位资源与能力**
   - `workctl --json resource list --service <svc> --env <env>` / `workctl --json service dependency list --service <svc>`：依赖关系，每条带 `source` 和 `evidence`。没有记录的关系不要凭名称相似推断。
   - `workctl --json capability list [--domain mysql]`：能力目录；`status=planned` 的能力不可调用，如实告诉用户“待接入”。
   - `workctl --json capability get --name <cap>` 或 `workctl <command> --help`：参数、口径说明、前置条件。
3. **按需读取领域指南与 Skill**（只读需要的）：
   - 基础设施/可观测/配置中心与服务发现：`skills/infra-operations`、`docs/guides/infrastructure.md`、`docs/guides/observability.md`
   - MySQL / PostgreSQL / Redis：`skills/mysql-operations`、`skills/postgres-operations`、`skills/redis-operations`
   - 发布与变更（最近发布了什么、是否成功、如何回滚）：`skills/deploy-operations`、`docs/guides/deploy.md`
   - 离线链路：`skills/offline-operations`、`skills/data-validation`
   - 跨系统流程：`skills/service-latency-investigation`、`skills/offline-delay-investigation`、`skills/resource-capacity-review`
   - 消息队列（插件）：安装 demo-mq 插件后见 `capability get --name mq.consumer.lag`
   - 搜索引擎（插件）：安装 demo-search 插件前 `search.*` 为 planned；安装后见 `skills/search-operations` 与 `capability get --name search.query`
4. **执行查询并读懂信封（通用读结果规则，各领域 skill 只补充本领域口径）**
   - `status`: success / partial / error。`partial` = 结果不完整：读 `meta.coverage.notes` / `meta.warnings`，在结论中写明缺了什么，不能说“没有问题”。
   - 五种情况不可混同：空结果（`success` + 空数组 + `coverage.complete=true`，才是“确实没有”）≠ `COLLECTION_DISABLED`（未采集/未开启，不是“没有”）≠ `PERMISSION_DENIED`（无权限；`UNAUTHENTICATED` 为缺凭据/认证失败）≠ `DATA_UNAVAILABLE`（请求范围内无数据，如历史已压缩/不保留）≠ `partial`。其他：`NOT_FOUND`、`UPSTREAM_UNAVAILABLE`、`NOT_CONFIGURED`（未绑定/未配置）、`CAPABILITY_PLANNED`。
   - 时间口径：快照只说明“此刻”；累计值（自启动/自 stats_reset）不能当窗口值；“最近 N 分钟”只用有起止时间的窗口差分或时间序列，看 `meta.coverage.window`；采样结果（`coverage.sampled`/`truncated`）不能当全量。
   - `meta.sources[]`：来源系统、方法、观测时间、实际版本、`relation`（explicit 系统明确记录 / inferred 推断 / derived 由其他字段计算 / sampled 采样）。结论引用证据时带上来源与 relation；inferred/derived 不能说成系统记录。
   - `data` 里的业务状态（如任务 `data.state=running`）与调用 `status` 无关：`success` 只表示查询成功。
   - `status=planned` 的能力没有可调用命令（`CAPABILITY_PLANNED`），如实说“待接入”，不要用其他命令的结果冒充。
   - `context.data_mode` 不是真实引擎（合成/录制/模拟）或 `meta.warnings` 有提示时，在回答中说明，不当作实时生产数据。
5. **组合与关联**：按依赖关系逐层查询，用同一时间窗口对齐指标、日志、慢日志和任务实例。离线链路分层检查：调度状态 → 计算状态 → 分区产出 → 质量规则，每层单独给证据。
6. **操作**：变更（计划 → 确认 → 执行 → 复核）：先 `workctl --json operation plan --action <type> ...` 或领域 `... plan`（如 `deploy rollback plan`、`offline backfill plan`、`mysql index plan`） 生成计划；向用户展示 `targets`（实际解析出的目标）、`impact`、`preconditions`（全部 ok）；仅当用户明确确认且 profile `allow_execute: true` 时执行 `workctl --json operation execute --id <id> --confirm <id>`；执行后用 `workctl --json operation get --id <id>` 和 领域只读命令 复核。计划预览不是执行成功的证据；不要自行发起执行。
7. **输出结论**：**事实**（命令 + 来源/relation + 窗口）/ **判断与假设**（依据、不确定性、验证命令）/ **下一步**（可复现命令、计划 ID）/ **覆盖缺口**（未采集、无权限、partial、保留期外）。

## 规则

- 不在命令、Skill 或回答中写入凭据；凭据只通过 profile 的 `*_ref` 引用。
- 采样类命令（`mysql statement summary --sample-window`、`redis stats sample --duration`）需要 `--timeout` 大于采样时长。
