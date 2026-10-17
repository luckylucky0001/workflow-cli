# 设计约束摘要（实现者必读）

本文件是《企业基础设施、中间件与离线链路：Agent 能力底座与 Demo 设计》的实现约束摘要。所有适配器、Skill 和文档都要满足这些约束。

## 能力底座

- **CLI** 执行稳定动作并返回结构化结果；**Skill** 组织领域知识和跨系统流程；**文档** 提供能力发现与契约；**Agent** 选择能力、关联证据并区分事实与假设。
- 一次接入多处复用：人、脚本、Agent（含 MCP）调用同一实现（`src/core/engine.ts#invoke`），得到同一信封契约。
- 命令结构：`workctl <domain> [resource] <action> [options]`。能力定义（`defineCapability`）是命令注册、帮助、目录、参考文档、MCP 工具描述的唯一来源。
- 领域语义不做错误归一化：MySQL、Redis、调度、计算引擎各自的口径分别表达。

## 结果契约

- 信封：`schema_version`、`status`(success/partial/error)、`capability`、`data`、`error`、`meta{sources, coverage, warnings}`、`context{request_id, profile, env, data_mode, ...}`。
- 每个结果记录 **来源**（系统、适配器、方法、观测时间、实际版本、explicit/inferred/derived/sampled）和 **覆盖范围**（complete、sampled、truncated、window、notes）。
- 空结果、无权限、未采集、部分结果、任务执行中必须可区分：
  - 空结果 → `success` + 空数组 + `coverage.complete=true`
  - 无权限 → `PERMISSION_DENIED`；缺凭据/认证失败 → `UNAUTHENTICATED`
  - 未采集/功能未开启 → `COLLECTION_DISABLED`（绝不能返回“没有慢查询”）
  - 请求范围内无数据 → `DATA_UNAVAILABLE`
  - 部分结果 → `status=partial` + coverage 说明
  - 任务执行中 → `success`，业务状态在 `data.state`
- 退出码表示调用状态，业务状态按契约读取（见 `ERROR_CODES`）。

## 操作语义

- 能力的 `operation` 区分 `read` / `diagnose` / `plan` / `execute`。
- 计划（plan）只预览：列出实际解析出的目标、影响范围、前置条件、步骤、是否幂等/可取消。**计划预览不是执行成功的证据。**
- 执行通过独立入口（`operation execute --id <plan> --confirm <plan>`），要求 profile `allow_execute: true`；MCP 默认不开放执行。

## 凭据

- 配置中只允许凭据引用 `*_ref: env:NAME | file:PATH`，禁止内联；凭据不进入命令示例、Skill 正文、输出和模型上下文。
- 实际授权仍由目标系统校验；查询到实例不代表具备数据面权限。

## 时间与数据语义

- 窗口指标必须来自有起止时间的采样差分或时间序列；不能把累计值当作窗口值。处理计数器重置/重启和分母为零。
- 离线：业务日期 ≠ 启动日期。保留业务数据区间、时区、计划时间、实际开始/结束时间和代码版本。
- 调度成功、计算成功、数据产出（分区存在、文件可读）、质量规则通过是**不同检查项**，分别验证。
- 血缘区分平台明确关系（explicit）与 SQL 推断（inferred），并标注覆盖范围。
- Redis `SCAN` 可能重复、`COUNT` 只是提示：自行去重、设预算、标注覆盖；`MEMORY USAGE` 是内存，不是热度；慢日志只含执行时间、不含 I/O。
- MySQL 普通 `EXPLAIN` 看计划；`EXPLAIN ANALYZE` 会执行语句，是不同操作。受限查询在程序和数据库权限层同时落实（只读账号 + 只读事务 + 执行时间上限 + 行数上限 + 敏感列处理）。

## 标识与诚实性

- 真实引擎、模拟回包、合成数据、分析判断分开标识（`context.data_mode`、`meta.sources[].relation`、插件 `backend_mode`）。
- 待接入能力在目录中标为 `planned`，不生成可调用命令。
- 没有足够依据时，不根据相似名称认定依赖关系。
- 不预设提效百分比；设计、已实现、隔离环境验证、客户环境验证分别标注。
