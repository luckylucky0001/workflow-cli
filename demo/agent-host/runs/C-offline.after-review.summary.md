# demo/agent-host/runs/C-offline.after-review.json

- 工具调用次数：11；workctl 调用：9
- 耗时：30620 ms；宿主报告成本：0.26372639999999997 USD；轮次：13；结束状态：success

## 调用序列

1. `Skill: {"skill":"offline-delay-investigation"}`
1. `ToolSearch: {"query":"select:mcp__workctl__offline_freshness_check,mcp__workctl__offline_run_list,mcp__workctl__offline_dependency_list,mcp__workctl__offline_workflow_get,m`
1. `MCP: offline_workflow_get {"id":"demo-daily-orders"}`
1. `MCP: offline_run_list {"workflow":"demo-daily-orders","data_date":"2026-10-16","timezone":"Asia/Shanghai"}`
1. `MCP: offline_freshness_check {"dataset":"analytics.daily_orders","data_date":"2026-10-16","timezone":"Asia/Shanghai"}`
1. `MCP: data_partition_list {"table":"analytics.daily_orders","from":"2026-10-12"}`
1. `MCP: offline_dependency_list {"run_id":"demo__2026-10-16__wrong_partition","workflow":"demo-daily-orders","direction":"upstream"}`
1. `MCP: offline_dependency_list {"run_id":"demo__2026-10-16__wrong_partition","workflow":"demo-daily-orders","direction":"downstream"}`
1. `MCP: offline_log_get {"run_id":"demo__2026-10-16__wrong_partition","task":"aggregate_orders"}`
1. `MCP: data_quality_check {"dataset":"demo.analytics.daily_orders","partition":"dt=2026-10-17"}`
1. `MCP: offline_backfill_plan {"workflow":"demo-daily-orders","from":"2026-10-16","to":"2026-10-16","timezone":"Asia/Shanghai","rerun_succeeded":true}`

## 最终回答

## 结论

`analytics.daily_orders` 业务日期 2026-10-16（Asia/Shanghai）的目标分区是 `dt=2026-10-16`。该分区不存在，已超过 2026-10-17 06:00 的时限约 923 分钟。

这不是上游没到。调度显示成功，但数据被写进了 `dt=2026-10-17`。我没有执行任何操作，只生成了补数计划。

## 事实

**调度层（Airflow 2.10.5）**
- run `demo__2026-10-16__wrong_partition` 的 data_interval 与 10-16 完全一致。它是手动触发的，conf 为 `{"fault":"wrong_partition"}`。
- 这个 run 在 10-17 20:37–20:38（+08:00）运行并成功，三个任务（`wait_for_ods_partition`、`aggregate_orders`、`validate_output`）都是 success。
- DAG `demo-daily-orders` 当前是暂停状态（`is_paused=true`）。

**上游**
- `ods.orders` 的 `dt=2026-10-16` 存在，有 `_SUCCESS`，数据可解析。
- 上游工作流 `demo-ods-orders` 的 run `demo__2026-10-16__ods` 已成功。
- 上游没有阻塞。

**计算层**
- `aggregate_orders` 的日志显示：`wrote 6 rows to .../analytics/daily_orders/dt=2026-10-17 (mode=overwrite) business_date=2026-10-16`。
- Spark app 是 `local-1792240691874`，退出码 0。
- 日志只取了前 200 行，共 372 行，没有取全。

**产出层**
- `dt=2026-10-16` 缺失。
- `dt=2026-10-17` 存在，有 `_SUCCESS`，6 行。
- `dt=2026-10-15`、`10-13`、`10-12` 存在。`dt=2026-10-14` 在列表里没有出现，我没有核查，建议另行确认。

**质量层**
- 对 `dt=2026-10-17` 做质量检查，12 条规则中 11 条通过。
- 失败的是 `order_date_matches_dt`：6 行的 `order_date` 全是 2026-10-16，和分区 `dt=2026-10-17` 不一致。

**下游影响**
- `report.daily_summary` 的 `dt=2026-10-16` 缺失。它的产出流程 `demo-report-workflow` 尚未接入调度。
- 订单日报 `demo-daily-report` 也依赖这张表。

## 假设

- **根因：** run 的 conf 带了故障注入参数 `fault=wrong_partition`，导致输出路径用了错误的日期。依据是 conf 和写入路径吻合。我没有读 DAG 源码确认这一点。
- **`dt=2026-10-17` 的内容：** 它目前是 10-16 的数据，是被污染的分区。10-17 的真实数据要等 10-18 06:00 前由正常 run 产出，到时会被 overwrite 覆盖。在那之前不要把它当作 10-17 的数据使用。

## 补数计划

计划 `op-20261017-760cae`，预览用，约 2026-10-17 23:23（+08:00）过期。

1. **前置：恢复 DAG。** 计划的前置检查 `dag_not_paused` 未通过，目前不能执行。恢复 DAG 是变更，需要你单独授权。
2. **去掉错误 conf，需要你拍板。** 计划默认是 `rerun`：清理 run `demo__2026-10-16__wrong_partition` 的全部任务实例并重跑。重跑会沿用 `fault=wrong_partition`，很可能再写错一次。计划自己的警告也建议改成：先删除该 run，再用 `trigger_new` 触发，并显式传 data_interval 为 `[2026-10-16 00:00, 2026-10-17 00:00)`（Asia/Shanghai），不带 fault 参数。需要重新生成对应的计划。
3. **重跑条件：** 目标表是 `overwrite_partition`，重跑幂等。`ods.orders` 输入分区已就绪。并发上限为 2，`demo-batch-pool` 有 2 个空闲槽。
4. **复核：**
   - `data partition get` 确认 `dt=2026-10-16` 存在，且有 `_SUCCESS`。
   - `data quality check` 确认 `order_date_matches_dt` 通过。
   - `offline freshness check` 确认 `on_time` 或已有产出。
5. **处理污染分区：** 方案要你定。
   - 方案 A：保留 `dt=2026-10-17`，等 10-17 的正常 run 覆盖它。
   - 方案 B：现在清理它。
   - 清理属于删除操作，需要你确认。
6. **下游：** 10-16 分区产出并通过质量检查后，再触发或补 `report.daily_summary` 和 `demo-daily-report`。目前没有为它们生成计划。

执行需要 `allow_execute`，而这个 MCP 服务只能出计划。你要我继续的话，请先确认三件事：是否恢复 DAG、是否用不带 fault 的 `trigger_new`、如何处理 `dt=2026-10-17`。
