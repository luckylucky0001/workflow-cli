---
name: offline-operations
description: 离线调度与计算的日常操作：查看 Airflow 工作流/任务定义、按业务日期找运行、看任务日志、看 Spark 应用/阶段/driver 日志、资源池占用、提交只读 Spark SQL、生成并执行补数计划。当用户提到 DAG、工作流、调度、run、任务实例、补数/回填/backfill、重跑、Spark 作业、pool、SQL 查询提交时使用（workctl offline / compute / sql ...）。
---

# 离线调度与计算操作（workctl offline / compute / sql）

## 能力速查

| 目的 | 命令 |
|---|---|
| 工作流定义（调度、时区、暂停、代码版本、参数） | `workctl --json offline workflow get --id <dag_id>` |
| 任务定义（算子、重试、pool、上下游、超时） | `workctl --json offline task get --workflow <dag_id> --task <task_id>` |
| 按业务日期找运行 | `workctl --json offline run list --workflow <dag_id> --data-date YYYY-MM-DD [--timezone Asia/Shanghai]` |
| 一次运行的分层状态 | `workctl --json offline run get --workflow <dag_id> --id <run_id>` |
| 依赖（任务/数据/跨工作流） | `workctl --json offline dependency list --run-id <run_id> --direction upstream\|downstream` |
| 任务日志尾部 | `workctl --json offline log get --run-id <run_id> --task <task_id> [--try N] [--limit-lines 200]` |
| Spark 应用 / 阶段 / driver 日志 | `compute job get --id <app_id>` / `compute stage list --job-id <app_id> [--status failed]` / `compute log get --job-id <app_id>` |
| 资源池 | `workctl --json compute queue get --id demo-batch-pool` |
| 只读 SQL | `sql query submit --engine spark --file q.sql` → `sql query get --id q-...`；取消 `sql query cancel --id q-...` |
| 补数 | `offline backfill plan ...` → `operation execute --id op-... --confirm op-...` → `offline backfill get --id op-...` |

YARN 队列、VM 实例、Trino/Hive 查询为 planned：如实告知未接入，不要用其他命令的结果冒充。

## 先换算业务日期

- 用户说的日期默认是**业务日期**（数据日期），不是启动日期。`run list` 会把 D 映射为业务时区的 `[D 00:00, D+1 00:00)`，并按 data_interval 匹配；
  输出的 `mapping` 说明规则，引用时带上。
- 时间字段都有 `{utc, local}`；对用户使用业务时区时间，并说明时区。
- run list 为空是 `success` + 空数组：表示该业务日期没有 run（未调度/未触发/已删除），不是查询失败。

## 回答运行状态

1. 用 `run get` 的 `summary`，**分别**报告四层：scheduler、compute、output、quality，每层引用自己的 `source`。
2. `unknown` 层说明原因（`detail`），不要推断为成功。`quality_state=not_run` 表示没有检查记录，不是通过。
3. `findings` 中 `inconsistency` 是事实层面的不一致；原因是假设，需要日志/路径证据后再下结论。

## 补数流程

1. `offline backfill plan --workflow <dag> --from D1 --to D2 [--timezone] [--rerun-succeeded] [--max-active-runs N]`。
2. 向用户逐日展示 `targets[]`（现有 run、动作、目标分区状态、上游输入）、`impact`（写入模式与幂等、下游、代码版本、并发）与 `preconditions`。
   - `write_mode_safe=false`（append 表重跑有重复风险）、`upstream_inputs_present=false`（先补上游）、`dag_not_paused=false` 时不要执行。
   - 调度 success 但分区不是 present 的日期会出现在 warnings：先查原因，`clear` 会沿用原 run 的 conf 和当前代码。
3. 用户明确确认后才执行 `operation execute --id <plan> --confirm <plan>`（需要 profile `allow_execute`；MCP 默认不开放）。
4. 执行结果只说明“调度系统已接受请求”；用 `offline backfill get --id` 跟踪，再用 `run get` 分层验证产出。

## SQL 提交

- 只接受单条 SELECT/WITH；演示环境表名为 `<db>_<table>` 临时视图（如 `analytics_daily_orders`），分区列 `dt`。
- `submitted/running` 是进行中的正常状态；`lost` 表示提交进程消失且无终态；预览最多 20 行，完整结果在 `result_location`。

## 口径

- 计划预览不是执行证据；执行成功不是数据正确的证据。
- 凭据只通过 profile 的 `*_ref` 引用，不要在回答或命令里出现密码。
- 依赖只报告带 `edge_source` 的关系，不按名称相似推断。
