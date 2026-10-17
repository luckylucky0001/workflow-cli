# /home/user/workflow-cli/demo/agent-host/runs/C-offline.cli-only.json

- 工具调用次数：21；workctl 调用：21
- 耗时：60344 ms；宿主报告成本：0.30998820000000005 USD；轮次：22；结束状态：success

## 调用序列

1. `Bash: workctl --help`
1. `Bash: workctl offline --help; workctl data --help; workctl capability list --domain offline; workctl capability list --domain data`
1. `Bash: workctl offline run list --help; workctl offline freshness check --help; workctl data table get --help; workctl offline backfill plan --help`
1. `Bash: workctl data table get --name demo-daily-orders 2>&1 | head -60; workctl offline workflow get --help | head -20`
1. `Bash: cd /tmp; W="workctl --json"; $W offline workflow get --id demo-daily-orders; $W offline run list --workflow demo-daily-orders --data-date 2026-10-16 --timezone Asia/Shanghai`
1. `Bash: workctl --json offline workflow get --id demo-daily-orders; workctl --json offline run list --workflow demo-daily-orders --data-date 2026-10-16 --timezone Asia/Shanghai`
1. `Bash: workctl offline run get --help | sed -n 1,12p; workctl offline dependency list --help | sed -n 1,12p; workctl data partition get --help | sed -n 1,14p; workctl data lineage get --help | sed -n 1,12p`
1. `Bash: R=demo__2026-10-16__wrong_partition; workctl --json offline run get --workflow demo-daily-orders --id $R | python3 -c "import json,sys;d=json.load(sys.stdin);print(json.dumps({k:d['data'][k] for k in `
1. `Bash: for p in dt=2026-10-16 dt=2026-10-15 dt=2026-10-17; do echo "== $p"; workctl --json data partition get --table analytics.daily_orders --partition $p | python3 -c "import json,sys;d=json.load(sys.stdin`
1. `Bash: workctl --json offline run get --workflow demo-daily-orders --id demo__2026-10-16__wrong_partition`
1. `Bash: workctl --json offline dependency list --workflow demo-daily-orders --run-id demo__2026-10-16__wrong_partition`
1. `Bash: workctl --json data partition get --table analytics.daily_orders --partition dt=2026-10-16`
1. `Bash: workctl --json data partition list --table analytics.daily_orders`
1. `Bash: workctl --json offline freshness check --dataset analytics.daily_orders --data-date 2026-10-16`
1. `Bash: workctl offline log get --help | sed -n 1,12p`
1. `Bash: workctl --json data partition get --table analytics.daily_orders --partition dt=2026-10-17`
1. `Bash: workctl --json offline dependency list --workflow demo-daily-orders --run-id demo__2026-10-16__wrong_partition --direction downstream`
1. `Bash: workctl --json offline backfill plan --workflow demo-daily-orders --from 2026-10-16 --to 2026-10-16 --timezone Asia/Shanghai`
1. `Bash: workctl offline log get --workflow demo-daily-orders --run-id demo__2026-10-16__wrong_partition --task aggregate_orders --limit-lines 80`
1. `Bash: workctl --json data quality check --help | sed -n 1,20p`
1. `Bash: workctl --json offline backfill plan --workflow demo-daily-orders --from 2026-10-16 --to 2026-10-16 --timezone Asia/Shanghai --rerun-succeeded --max-active-runs 1`

## 最终回答

**结论：** 目标分区 `analytics.daily_orders` 的 `dt=2026-10-16` 不存在，已超过 06:00 的产出时限约 909 分钟（freshness 判定 `missing`）。上游没问题，原因是这次 run 把 10-16 的数据写错了分区。以下都是只读检查，我没有执行任何变更。

## 检查链路

| 环节 | 结果 |
|---|---|
| 上游 `ods.orders dt=2026-10-16` | 存在，有 `_SUCCESS`；上游工作流 `demo-ods-orders` 的 10-16 run 为 success |
| Airflow run `demo__2026-10-16__wrong_partition` | 调度 success，三个任务全部成功 |
| Spark 应用 `local-1792240691874` | 正常结束，没有失败作业，退出码 0 |
| 目标分区 `dt=2026-10-16` | 不存在 |
| 质量检查 | fail（11 条规则里 1 条失败，10 条因分区缺失被跳过） |

调度和计算都显示成功，但数据没有产出到目标分区。

## 根因

- **写错分区：** `aggregate_orders` 日志显示 `wrote 6 rows to .../dt=2026-10-17 (mode=overwrite) business_date=2026-10-16`。10-16 的聚合结果被写进了 `dt=2026-10-17`。
- **触发参数：** 这个 run 是手动触发的，conf 里带了 `{"fault":"wrong_partition"}`，DAG 的演示故障注入参数，run id 里也带这个名字。
- **监控没拦住：** `validate_output` 也显示 success，说明它没有拦住这个问题。
- **副作用：** `dt=2026-10-17` 现在有这份错位数据，但 10-17 还没结束，它本该由 10-18 的 run 产出。我没有读取其中的行内容，所以它的 `order_date` 值只是按日志推断。

## 其他发现

- **DAG 已暂停：** `is_paused=true`，所以没有定时 run，新触发或重跑的 run 也不会被调度。
- **下游：** `report.daily_summary dt=2026-10-16`（缺失）和订单日报 `demo-daily-report` 都依赖这个分区。目录里写着 `demo-report-workflow` 尚未接入调度。
- **其他分区：** `dt=2026-10-14` 在仓库里也不存在，我没有展开检查。

## 补数方案

我已生成两份 plan，都没有执行：

- `op-20261017-bd214b`：默认参数，动作是 `skip_succeeded`，没有实际作用，请忽略。
- `op-20261017-8a29f2`：`--rerun-succeeded --max-active-runs 1`，动作是 `rerun`。Airflow 的 `clearTaskInstances` 会沿用旧 run 的 conf，所以不能用它。

这两份 plan 的有效期到 2026-10-17 23:09（+08:00）。

**推荐的做法：**

1. **确认来源：** 向触发人确认 `wrong_partition` 这个 conf 是演示故障注入，不是业务需要。
2. **处理错位分区：** 写错的 `dt=2026-10-17` 先保留，等 10-18 的正常 run 覆盖。如果下游已经读取了它，就先暂停下游。
3. **恢复 DAG：** 取消 `demo-daily-orders` 的暂停（需要单独授权）。
4. **换成干净的 run：** 删除（或标记作废）旧 run `demo__2026-10-16__wrong_partition`，再用 `trigger_new`，显式传 `data_interval` 为 `[2026-10-16 00:00, 2026-10-17 00:00) +08:00`，conf 里不带 `fault`。重新生成 plan 后确认动作是 `trigger_new` 再执行。
5. **执行前后核对：**
   - 目标分区是 `dt=2026-10-16`。
   - 写入方式是 `overwrite_partition`，重跑可以安全覆盖。
   - 同一时间只有 1 个 run 在跑。
   - 使用的 DAG 代码 sha256 是 `11501b7d…`（重跑用调度器当前解析的代码，不是旧 run 当时的代码）。
6. **验证：**
   - `data partition get`：确认 `dt=2026-10-16` 有数据文件和 `_SUCCESS`。
   - `data quality check`：用 `demo-daily-rules` 对 `dt=2026-10-16` 重新检查，旧的 fail 结果不会自动失效。
   - `offline freshness check`：确认 10-16 的分区不再是 `missing`。
   - 确认 `dt=2026-10-17` 没有被这次重跑改动。
7. **下游：** 数据验证通过后，再重算 `report.daily_summary dt=2026-10-16` 和订单日报。

**风险：**

- 要先确认删除旧 run 是否在你的授权范围内。
- 恢复 DAG 会让调度器开始创建新的定时 run，所以建议只在补数窗口内恢复，补完再按需暂停。

## 需要你决定

- 是否授权取消暂停并执行第 4 步（删除旧 run、`trigger_new`）。
- `dt=2026-10-17` 的错位数据是保留等覆盖，还是现在清理。
