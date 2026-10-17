# demo/agent-host/runs/C-offline.json

- 工具调用次数：13；workctl 调用：11
- 耗时：37276 ms；宿主报告成本：0.2494943 USD；轮次：15；结束状态：success

## 调用序列

1. `Skill: {"skill":"offline-delay-investigation"}`
1. `ToolSearch: {"query":"select:mcp__workctl__capability_list,mcp__workctl__offline_freshness_check,mcp__workctl__offline_run_list,mcp__workctl__offline_run_get,mcp__workctl__`
1. `MCP: offline_workflow_get {"id":"demo-daily-orders"}`
1. `MCP: offline_run_list {"workflow":"demo-daily-orders","data_date":"2026-10-16","timezone":"Asia/Shanghai"}`
1. `MCP: offline_freshness_check {"dataset":"analytics.daily_orders","data_date":"2026-10-16","timezone":"Asia/Shanghai"}`
1. `MCP: offline_run_get {"id":"demo__2026-10-16__wrong_partition","workflow":"demo-daily-orders"}`
1. `MCP: offline_dependency_list {"run_id":"demo__2026-10-16__wrong_partition","workflow":"demo-daily-orders","direction":"upstream"}`
1. `MCP: data_partition_list {"table":"analytics.daily_orders","from":"2026-10-12"}`
1. `MCP: data_table_get {"table":"analytics.daily_orders"}`
1. `MCP: offline_log_get {"run_id":"demo__2026-10-16__wrong_partition","workflow":"demo-daily-orders","task":"aggregate_orders","limit_lines":80}`
1. `MCP: data_partition_get {"table":"analytics.daily_orders","partition":"dt=2026-10-17","sample_records":5}`
1. `MCP: data_lineage_get {"table":"analytics.daily_orders","direction":"downstream"}`
1. `MCP: offline_backfill_plan {"workflow":"demo-daily-orders","from":"2026-10-16","to":"2026-10-16","timezone":"Asia/Shanghai"}`

## 最终回答

**结论：** `analytics.daily_orders` 的 `dt=2026-10-16` 分区缺失（`missing`）。时限是 2026-10-17 06:00 +08:00（UTC 2026-10-16 22:00），当前已超 904 分钟。Spark 作业成功了，但数据写进了 `dt=2026-10-17`。

## 目标分区
- 要补的分区是 `analytics.daily_orders` 的 `dt=2026-10-16`，业务区间为 [2026-10-16 00:00, 2026-10-17 00:00) +08:00。
- `dt` 是 Asia/Shanghai 自然日的业务日期，与 `order_date` 列一致，写入方式是 `overwrite_partition`，所以重跑可以幂等覆盖。

## 事实（括号内为取证来源）
- **上游已就绪。**
  - `ods.orders dt=2026-10-16` 存在，有 `_SUCCESS`，抽查记录可解析。
  - 上游工作流 `demo-ods-orders` 对应的 run `demo__2026-10-16__ods` 已成功。
  - 来源：`offline.dependency.list`、catalog、binding-file。
  - 这条链路不是延迟原因。
- **调度层成功但跑得很晚。**
  - run `demo__2026-10-16__wrong_partition` 是手动触发，`conf={"fault":"wrong_partition"}`，业务日期匹配 exact。
  - 它在 2026-10-17 20:37:14 +08:00 才启动，用时 73 秒。
  - 三个任务（`wait_for_ods_partition`、`aggregate_orders`、`validate_output`）都是 success。
  - 来源：`offline.run.get`。
- **计算层成功，但写错了分区。**
  - Spark 应用 `local-1792240691874` 正常结束，没有失败作业，退出码为 0。
  - `aggregate_orders` 日志写着 `wrote 6 rows to .../daily_orders/dt=2026-10-17 (mode=overwrite) business_date=2026-10-16`。也就是业务日期是 10-16，却落到了 `dt=2026-10-17`。
  - 来源：`offline.log.get`。
- **产出层：目标分区不存在。**
  - `dt=2026-10-16` 目录不存在，已有分区是 10-12、10-13、10-15、10-17。
  - `dt=2026-10-17` 有 1 个文件、790 字节和 `_SUCCESS`，更新时间为 20:38:19 +08:00，可解析。
  - 10-17 这一天还没结束，它的时限是 10-18 06:00，所以这个分区里的数据是 10-16 的。
  - 来源：`data.partition.get`、`data.partition.list`。
- **质量层：最近一次检查未通过。**
  - 检查时间为 12:39:33 UTC，在这次写入之后。结果是 11 条规则里 1 条 fail、10 条 skipped。
  - 这次检查针对哪个分区、哪条规则失败，我没有查到，需要再用 `data.quality.check` 确认。
- **DAG 处于暂停状态。** `is_paused=true`，`catchup=false`，所以不会自动补跑。
- **下游受影响。**
  - `report.daily_summary` 和订单日报 `demo-daily-report` 都依赖这张表。
  - `report.daily_summary` 的产出工作流 `demo-report-workflow` 在 catalog 里标记为 `planned`，不确定它是否已有消费。

## 假设（尚未验证）
- 根因很可能是手动触发时带了 `fault=wrong_partition`，输出路径用了 `data_interval_end`（即 D+1），所以写进 `dt=2026-10-17`。
  - 验证方法：读 `demo/offline-workflows/dags/demo_daily_orders.py` 里 `aggregate_orders` 的 `--output` 路径逻辑。
  - 再用只读 Spark SQL 按 `order_date` 汇总 `dt=2026-10-17`，看是否全是 2026-10-16。
- `dt=2026-10-17` 里现在是 10-16 的数据，会污染 10-17 的结果和下游。上面第二条验证做完前，这只是推断。

## 处理与补数计划（只生成，不执行）
1. **先确认根因。** 读 DAG 代码和 `run.conf`，并用只读 SQL 验证上面的假设。
2. **确认 DAG 当前代码是否仍有该故障路径。**
   - 补数用的是调度器当前解析的代码。已知 `code_version.source_sha256=11501b7d…`，最后解析时间为 2026-10-17 13:03 UTC。
   - 如果代码本身写错分区，要先修代码；如果只是 `conf` 注入的故障，则不用改代码。
3. **需要你授权恢复暂停的 DAG。** 补数计划 `op-20261017-00c555` 的前置条件检查 `dag_not_paused` 未通过，恢复暂停属于变更操作。
4. **重新触发 10-16 的 run，不要沿用 fault 参数。**
   - 默认计划的动作是 `skip_succeeded`，因为那个 run 调度层已成功，所以要加 `rerun_succeeded` 重新生成计划。
   - 但原 run 的 `conf` 会被沿用，重跑会再写错一次。更稳妥的做法是新建一个 run，显式带 `data_interval=[2026-10-16 00:00, 2026-10-17 00:00) +08:00`，并且不带 `fault`。
   - 并发按计划上限 2，`demo-batch-pool` 有 2 个空闲槽位。
5. **处理被污染的 `dt=2026-10-17`。**
   - 方案 A：10-17 的 DAG 正常跑完后，用 `overwrite_partition` 自然覆盖。
   - 方案 B：如果下游会在此之前读它，先对 10-17 单独做一次补数覆盖。
   - 这个选择需要你定。
6. **验收（补数后）。**
   - `data partition get dt=2026-10-16`：应为 `present`，有 `_SUCCESS`，且 `order_date` 全为 2026-10-16。
   - `data quality check`：用规则集 `demo-daily-rules` 重跑一遍。
   - 确认 `dt=2026-10-17` 的内容已被正确覆盖，再通知 `report.daily_summary` 和 `demo-daily-report` 的消费方。
7. **顺带发现。** `dt=2026-10-14` 同样缺失，不在这次范围内。如果需要，补数范围可以扩大到 10-14。

我没有触发任何运行。下一步需要你确认三件事：是否恢复 DAG，10-17 分区用 A 还是 B，以及是否把 10-14 一起补。
