# demo/agent-host/runs/C-offline.final.json

- 工具调用次数：13；workctl 调用：11
- 耗时：32258 ms；宿主报告成本：0.2611392 USD；轮次：15；结束状态：success

## 调用序列

1. `Skill: {"skill":"offline-delay-investigation"}`
1. `ToolSearch: {"query":"select:mcp__workctl__offline_freshness_check,mcp__workctl__offline_run_list,mcp__workctl__offline_run_get,mcp__workctl__offline_dependency_list,mcp__w`
1. `MCP: offline_workflow_get {"id":"demo-daily-orders"}`
1. `MCP: offline_run_list {"workflow":"demo-daily-orders","data_date":"2026-10-16"}`
1. `MCP: offline_freshness_check {"dataset":"analytics.daily_orders","data_date":"2026-10-16"}`
1. `MCP: offline_run_get {"id":"demo__2026-10-16__wrong_partition","workflow":"demo-daily-orders"}`
1. `MCP: offline_dependency_list {"run_id":"demo__2026-10-16__wrong_partition","workflow":"demo-daily-orders","direction":"upstream"}`
1. `MCP: data_partition_list {"table":"analytics.daily_orders","from":"2026-10-12"}`
1. `MCP: offline_log_get {"run_id":"demo__2026-10-16__wrong_partition","task":"aggregate_orders","workflow":"demo-daily-orders","limit_lines":60}`
1. `MCP: data_quality_check {"dataset":"analytics.daily_orders","partition":"dt=2026-10-17"}`
1. `MCP: data_lineage_get {"table":"analytics.daily_orders","direction":"downstream"}`
1. `MCP: offline_backfill_plan {"workflow":"demo-daily-orders","from":"2026-10-16","to":"2026-10-17"}`
1. `MCP: offline_backfill_plan {"workflow":"demo-daily-orders","from":"2026-10-16","to":"2026-10-16","rerun_succeeded":true,"max_active_runs":1}`

## 最终回答

## 结论

业务日期 2026-10-16(Asia/Shanghai)的 `analytics.daily_orders` 目前是 **missing**。产出时限是 2026-10-17 06:00(+08:00,即 UTC 2026-10-16 22:00)。检查时间是 2026-10-17 23:11(+08:00),已超时约 1032 分钟。

数据已经算出来了,但**写进了 `dt=2026-10-17`,没有写进 `dt=2026-10-16`**。调度和计算都显示成功,所以没有告警。

**目标分区:**
- 要补的是 `analytics.daily_orders/dt=2026-10-16`。
- `dt=2026-10-17` 里现有的数据是错位的。它是 10-16 的数据,不能当作 10-17 的数据使用。

## 事实

| 层 | 现象 | 来源 |
|---|---|---|
| 上游 | `ods.orders/dt=2026-10-16` 存在,有 `_SUCCESS`;上游工作流 `demo-ods-orders` 的 run `demo__2026-10-16__ods` 已成功。上游没问题,不是在等上游。 | `offline.dependency.list`(catalog-metadata、binding-file) |
| 调度 | run `demo__2026-10-16__wrong_partition` 状态 success,手动触发,业务日期匹配。运行时间是 10-17 22:57–22:58(+08:00),`conf={"fault":"wrong_partition"}`。 | `offline.run.list/get`(Airflow 2.10.5) |
| 计算 | Spark 应用 `local-1792249100267` 成功,无失败作业。 | `offline.run.get`(spark-history) |
| 日志 | 日志写着 `wrote 6 rows to …/daily_orders/dt=2026-10-17 (mode=overwrite) business_date=2026-10-16`。写入路径和业务日期对不上。 | `offline.log.get` |
| 产出 | `dt=2026-10-16` 目录不存在。现有分区只有 `dt=2026-10-15` 和 `dt=2026-10-17`。 | `data.partition.list` |
| 质量 | `dt=2026-10-16` 的质量检查是 fail(分区不存在,其余 10 条规则跳过)。我对 `dt=2026-10-17` 做了检查:11 条通过,`order_date_matches_dt` 失败,6 行全部是 `order_date=2026-10-16`。 | `data.quality.check` |
| 调度器 | DAG 当前是**暂停**状态(`is_paused=true`)。 | `offline.workflow.get` |

## 假设(尚未验证)

- 根因很可能是运行时的 `conf.fault=wrong_partition` 让输出路径取了 `data_interval_end`(即 D+1)。依据是 run 的 conf 和日志里的写入路径。我还没读 `demo/offline-workflows/dags/demo_daily_orders.py`,所以这一条是推断。
- 如果是这样,**直接 rerun 没用**。清理重跑会沿用原 run 的 conf,还会写回 `dt=2026-10-17`。

## 影响范围

- 下游有 `report.daily_summary` 和订单日报 `demo-daily-report`。
- `report.daily_summary` 的产出工作流 `demo-report-workflow` 在目录里是 `planned`,还没实现。
- 我没有检查这些下游今天是否已经读到了错误数据。
- 10-17 的 ods 还没到(`ods.orders/dt=2026-10-17` missing),所以现在的 `dt=2026-10-17` 全是错位数据。10-17 的时限是 10-18 06:00。

## 处理与补数计划(只生成计划,未执行)

1. **先确认根因**(只读)
   - 看 DAG 文件里输出路径的取值。
   - 用只读 SQL 按 `dt` 汇总 `order_date`,再确认一遍。
2. **取消 `fault=wrong_partition`**
   - 不要对原 run 做 rerun。
   - 删除该 run 后,用不带 fault 参数的 `trigger_new` 重新触发,并显式传 `data_interval=[2026-10-16 00:00, 2026-10-17 00:00)+08:00`。
   - 这一步和恢复 DAG 都是变更,需要你单独授权。
3. **恢复 DAG 暂停状态**
   - 预检查 `dag_not_paused` 不通过,需要先恢复。
   - 恢复后调度器会开始创建新的定时 run,建议同时确认 10-17 的 run 是否会被拉起。
4. **补数 10-16**
   - 目标是 `dt=2026-10-16`,写入模式是 `overwrite_partition`,重跑是幂等的。
   - 并发 1,`demo-batch-pool` 有 2 个空闲槽位。
   - 用的是调度器当前解析的 DAG 代码,sha256 前缀 `11501b7d…`。
5. **清理 `dt=2026-10-17`**
   - 它现在是 10-16 的数据,等 10-17 的 ods 到了,让 10-17 的正常 run 以 overwrite 覆盖它。
   - 在此之前,下游不要读它。
   - 这是对数据的修改,同样需要你确认。
6. **复核**
   - 补完后检查 `offline freshness check`(10-16 应不再是 missing)。
   - 对 `dt=2026-10-16` 跑质量检查,看 `order_date_matches_dt` 是否通过。
   - 再确认下游日报是否需要重新产出。

**已生成的计划(均不执行,2026-10-17 17:11 UTC 过期):**
- `op-20261017-199e84`:对 10-16 的 rerun。它只演示了流程,不建议执行,因为会沿用错误的 conf。
- `op-20261017-f097d6`:10-16..10-17。10-16 的动作是 `skip_succeeded`,10-17 的动作是 `trigger_new`,但被拦截,原因是 DAG 暂停、ods 10-17 缺失、区间未结束。

另外,为核对 `dt=2026-10-17`,我跑了一次质量检查,它在 `.runtime/state/quality/` 下写了一份结果文件。

要不要我接着读 DAG 代码确认根因?
