# 操作语义：查询、诊断、计划、执行

每个能力声明一个 `operation`：

| 类型 | 含义 | 示例 | 默认是否对 Agent/MCP 开放 |
| --- | --- | --- | --- |
| `read` | 读取状态、元数据、指标、日志 | `mysql table get`、`offline run get` | 是 |
| `diagnose` | 有额外成本的诊断，可能实际执行只读语句或采样 | `mysql query analyze`、`redis stats sample` | 是 |
| `plan` | 生成变更计划，不改变目标系统 | `operation plan`、`offline backfill plan`、`mysql index plan` | 是 |
| `execute` | 改变目标系统 | `operation execute`、`sql query cancel` | 否（MCP 需 `--allow-execute`，且 profile `allow_execute: true`） |

## 计划（plan）

计划存放在 profile 的 `state_dir/operations/<id>.json`，字段：

- `targets`：生成计划时**实际解析出的**目标对象（如容器 ID、DAG run、分区）。
- `impact`：影响范围预览（依赖方、下游表、写入范围、并发预算）。
- `preconditions`：前置条件逐项检查结果；任一失败则不可执行。
- `steps`、`rollback`、`idempotent`、`cancellable`。
- `executable`：是否存在执行器。没有执行器的计划（如 `mysql.index.create`）只作为变更方案参考，交由既有变更流程执行。
- `expires_at`：计划默认 1 小时过期，过期后需重新生成（目标状态可能已变化）。
- `history`：状态迁移记录 `planned → running → succeeded | failed`，或 `cancelled` / `expired`。
- `digest`：`sha256:` + 计划内容（除 `digest` 外所有字段，规范化 JSON）的摘要。计划存储每次写入（生成、状态迁移、执行进度）时重新封存，`operation get/execute/cancel` 读取时校验；手工改动计划文件（前置条件、参数、目标、状态等）会得到 `PRECONDITION_FAILED`（plan file was modified），需重新生成计划。摘要用于发现误改/篡改，不是签名：能写 state_dir 的一方仍能重算摘要，state_dir 的写权限应只给 workctl 的使用者。没有 `digest` 的旧版本计划：`operation get/list` 仍可查看（附 warning），`execute/cancel` 拒绝。
- `config_identity`：生成计划时配置身份的摘要（profile 的端点、默认端点、资源绑定文件与配置目录）。多份配置共享 state_dir 和 profile 名时（如演示的 `workctl.yaml` / `workctl.loki.yaml`），计划只能在端点一致的配置下执行。

**计划预览不能作为执行成功的证据**；执行结果以 `operation get --id` 的状态和 `result` 为准。

## 执行（execute）

```bash
workctl --json operation plan --action container.restart --param service=demo-order --param env=sandbox
workctl --json operation execute --id op-20261017-abc123 --confirm op-20261017-abc123
workctl --json operation get --id op-20261017-abc123
```

执行前校验：

1. profile `allow_execute: true`（只应在隔离或已授权环境开启）；
2. `--confirm` 与计划 ID 一致；
3. 计划状态为 `planned` 且未过期；
4. 当前 profile/env 与生成计划时一致，且配置身份（`config_identity`，端点/资源绑定）一致，否则 `PRECONDITION_FAILED`；
5. 计划前置条件全部满足；
6. 存在对应执行器。

目标系统仍会做自己的授权校验，workctl 的检查不替代平台权限。

`--confirm` 只是防止执行错误计划的意图校验，**不是人工审批**：能调用 `operation execute` 的一方也能填写它。人工把关靠以下机制：

- 给 Agent 使用的 profile 设置 `allow_execute: false`（演示中 `run-agent-demo.sh` 使用这样的只读 profile），Agent 只能生成计划；
- MCP 服务默认不暴露 execute 类工具，只有以 `workctl mcp serve --allow-execute` 启动时才暴露；
- `workctl mcp serve --domain X` 同时限定 `operation.*`：只能为领域 X 的操作类型生成、执行、取消计划，其他领域的计划（如 `container.restart`）返回 `PERMISSION_DENIED`；
- 执行由授权人员在终端完成，或接入客户既有的变更审批流程（计划 ID 可作为审批单附件）。

同一计划的执行与取消持有独占锁（`operations/<id>.json.lock`）：两个终端或 CLI 与 MCP 同时执行同一计划时，后到者得到 `CONFLICT`；过期计划返回 `PRECONDITION_FAILED`。

## 已注册的计划器与执行器

| 操作类型 | 计划命令 | 执行器 | 说明 |
| --- | --- | --- | --- |
| `container.restart` | `operation plan --action container.restart` / `container workload restart-plan` | 有（Docker Engine API） | 重启后确认同一实例稳定运行 3 秒、有健康检查时需为 healthy，才记为 verified |
| `mysql.index.create` | `mysql index plan` | 无 | 产出 DDL 与影响评估，交 DBA 变更流程 |
| `offline.backfill` | `offline backfill plan` | 有（Airflow REST） | 按区间触发/清理 DAG run，遵守并发预算 |

新增操作类型：在领域模块中注册 `planners` 与（可选）`executors`，见 [provider-onboarding.md](../provider-onboarding.md)。
