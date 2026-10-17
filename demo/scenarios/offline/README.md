# 离线链路场景（真实 Airflow + Spark 执行）

所有状态都来自真实执行：脚本只通过 Airflow stable REST API 触发 DAG run（带 `logical_date`、显式 `data_interval` 和 `conf`），
不直接改写元数据库、不伪造分区。数据是合成订单（`demo/synthetic-data/generate_orders.py`）。

前置：`demo/environment/offline-up.sh` 已启动 Airflow（127.0.0.1:18080）与 Spark history server（127.0.0.1:18088）。

| 脚本 | 场景 | 预期现象 |
|---|---|---|
| `01-ods-extract.sh` | 抽取 `ods.orders` 业务日期 2026-10-15、2026-10-16 | 两个 run success，`ods/orders/dt=...` 含 `_SUCCESS` |
| `02-daily-ok.sh` | `demo-daily-orders` 2026-10-15 正常聚合 | 调度/计算/产出全部正常 |
| `03-wrong-partition.sh` | 2026-10-16，conf `{"fault":"wrong_partition"}` | 所有任务 success、Spark 成功，但输出写到 `dt=2026-10-17`，`dt=2026-10-16` missing |
| `04-missing-upstream.sh` | 2026-10-14，ODS 从未抽取 | 传感器 `wait_for_ods_partition` 处于 `up_for_reschedule` 持续等待（超时默认 6h，`WORKCTL_DEMO_SENSOR_TIMEOUT`） |
| `run-all.sh` | 依次产生以上全部场景 | 先触发全部 run 再恢复（unpause）DAG，避免调度器为同一 logical_date 再建定时 run |

run_id 约定：`demo__<业务日期>__<场景>`，例如 `demo__2026-10-16__wrong_partition`。

## 观察（workctl）

```bash
export WORKCTL_CONFIG=demo/environment/workctl.yaml
workctl --json offline run list --workflow demo-daily-orders --data-date 2026-10-16 --timezone Asia/Shanghai
workctl --json offline run get --workflow demo-daily-orders --id demo__2026-10-16__wrong_partition     # scheduler success / compute succeeded / output missing
workctl --json offline freshness check --dataset analytics.daily_orders --data-date 2026-10-16          # missing（已过 10-17 06:00）
workctl --json offline dependency list --run-id demo__2026-10-14__missing_upstream --direction upstream   # ods.orders dt=2026-10-14 missing，上游无 run
workctl --json offline log get --run-id demo__2026-10-14__missing_upstream --task wait_for_ods_partition --limit-lines 20
workctl --json compute job get --id <WORKCTL_SPARK_APP_ID 来自 run get / log get>
workctl --json sql query submit --engine spark --file demo/offline-workflows/sql/examples/daily_orders_by_date.sql
```

补数演示（需要 `allow_execute: true`，演示 profile 已开启）：

```bash
workctl --json offline backfill plan --workflow demo-ods-orders --from 2026-10-12 --to 2026-10-13
workctl --json operation execute --id <plan_id> --confirm <plan_id>
workctl --json offline backfill plan --workflow demo-daily-orders --from 2026-10-12 --to 2026-10-13   # 上游输入已就绪后再补下游
```

## 复位

`demo/environment/reset.sh` 删除 `.runtime`（Airflow 元数据库、仓库目录、事件日志）。只想重做场景时可以在 Airflow 中删除对应 run
并删除 `.runtime/warehouse/analytics/daily_orders/dt=*` 后重新运行脚本。

## 注意

- 两个 DAG 恢复（unpause）后由调度器正常调度：每天 00:00（Asia/Shanghai）之后会为前一业务日期创建定时 run。
  例如 2026-10-18 00:00 +08:00 起会自动运行业务日期 2026-10-17，`analytics/daily_orders/dt=2026-10-17` 会被正确数据覆盖，
  wrong_partition 场景留下的 dt=2026-10-17 证据随之消失（dt=2026-10-16 仍为 missing）。需要固定现场时，在场景跑完后暂停 `demo-ods-orders`。
- 不要执行 ODS 2026-10-14 的补数计划，否则“缺上游”场景的传感器会放行。
