# 版本替换对照：Airflow 2（REST v1）↔ Airflow 3（REST v2）

生成时间 2026-10-17T15:41:31.054Z，命令 `node demo/scenarios/reuse/version-swap.mjs`（真实调用，两个调度实例各自的真实运行）。
v1 = `demo/environment/workctl.yaml`（profile demo，Airflow 2 @ 127.0.0.1:18080），v2 = `demo/environment/workctl.af3.yaml`（profile demo-af3，Airflow 3 @ 127.0.0.1:18090）。
两边场景相同（同 run_id、同业务日期、同 conf），但是两套独立的真实执行：运行时间、Spark application id、分区写入时间不同。

| 能力 | v1 适配器 · 实际版本 | v2 适配器 · 实际版本 | 输出 schema 一致（两边 data 均通过 zod output） | 顶层 data 键一致 | 分层状态一致（run get） | 关键事实对照 |
|---|---|---|---|---|---|---|
| `offline.workflow.get` | airflow-rest-v1 · 2.10.5 | airflow-rest-v2 · 3.3.2 | yes | yes | n/a | 相同 |
| `offline.task.get` | airflow-rest-v1 · 2.10.5 | airflow-rest-v2 · 3.3.2 | yes | yes | n/a | 相同 |
| `offline.run.list` | airflow-rest-v1 · 2.10.5 | airflow-rest-v2 · 3.3.2 | yes | yes | n/a | 相同 |
| `offline.run.get (wrong_partition)` | airflow-rest-v1 · 2.10.5 | airflow-rest-v2 · 3.3.2 | yes | yes | yes (scheduler=success compute=succeeded output=missing quality=fail) | 相同 |
| `offline.run.get (ok)` | airflow-rest-v1 · 2.10.5 | airflow-rest-v2 · 3.3.2 | yes | yes | yes (scheduler=success compute=succeeded output=present quality=not_run) | 相同 |
| `offline.dependency.list` | airflow-rest-v1 · 2.10.5 | airflow-rest-v2 · 3.3.2 | yes | yes | n/a | 相同 |
| `offline.log.get` | airflow-rest-v1 · 2.10.5 | airflow-rest-v2 · 3.3.2 | yes | yes | n/a | 相同 |
| `offline.backfill.plan` | airflow-rest-v1 · 2.10.5 | airflow-rest-v2 · 3.3.2 | yes | yes | n/a | 相同 |
| `offline.freshness.check` | airflow-rest-v1 · 2.10.5 | airflow-rest-v2 · 3.3.2 | yes | yes | n/a | 相同 |
| `compute.queue.get` | airflow-rest-v1 · 2.10.5 | airflow-rest-v2 · 3.3.2 | yes | yes | n/a | 相同 |

## 嵌套字段差异（键路径；同一 schema 内的可选/可空字段）

| 能力 | 差异 |
|---|---|
| `offline.workflow.get` | 无 |
| `offline.task.get` | 无 |
| `offline.run.list` | 仅 v1 有: mapping.query.execution_date_gte, mapping.query.execution_date_lte；仅 v2 有: mapping.query.logical_date_gte, mapping.query.logical_date_lte；v1 为 null、v2 有值: runs[].queued_at |
| `offline.run.get (wrong_partition)` | v1 为 null、v2 有值: run.queued_at |
| `offline.run.get (ok)` | v1 为 null、v2 有值: run.queued_at |
| `offline.dependency.list` | 无 |
| `offline.log.get` | 无 |
| `offline.backfill.plan` | 无 |
| `offline.freshness.check` | 无 |
| `compute.queue.get` | 无 |

已知原因（适配层不改写这些值）：`mapping.query` 记录实际发送给调度器的查询参数，REST v1 为 `execution_date_*`、REST v2 为 `logical_date_*`（同一时间窗口）；
`queued_at`：Airflow 2.10 的 REST v1 DAGRun 响应没有该字段（schema 中可空，v1 为 null），REST v2 返回它。

## 来源方法（meta.sources 中第一个 airflow 来源）与 context.adapter

| 能力 | v1 method | v2 method | context.adapter（能力级，两边相同） |
|---|---|---|---|
| `offline.workflow.get` | `GET /api/v1/dags/demo-daily-orders/details` | `GET /api/v2/dags/demo-daily-orders/details` | airflow-rest-v1|v2 |
| `offline.task.get` | `GET /api/v1/dags/demo-daily-orders/tasks/aggregate_orders` | `GET /api/v2/dags/demo-daily-orders/tasks/aggregate_orders` | airflow-rest-v1|v2 |
| `offline.run.list` | `GET /api/v1/dags/demo-daily-orders/dagRuns` | `GET /api/v2/dags/demo-daily-orders/dagRuns` | airflow-rest-v1|v2 |
| `offline.run.get (wrong_partition)` | `GET /api/v1/dags/demo-daily-orders/dagRuns/demo__2026-10-16__wrong_partition` | `GET /api/v2/dags/demo-daily-orders/dagRuns/demo__2026-10-16__wrong_partition` | airflow-rest-v1|v2 |
| `offline.run.get (ok)` | `GET /api/v1/dags/demo-daily-orders/dagRuns/demo__2026-10-15__ok` | `GET /api/v2/dags/demo-daily-orders/dagRuns/demo__2026-10-15__ok` | airflow-rest-v1|v2 |
| `offline.dependency.list` | `GET /api/v1/dags/demo-daily-orders/tasks` | `GET /api/v2/dags/demo-daily-orders/tasks` | airflow-rest-v1|v2 |
| `offline.log.get` | `GET /api/v1/dags/demo-daily-orders/dagRuns/demo__2026-10-16__wrong_partition/taskInstances/aggregate_orders/logs/1` | `GET /api/v2/dags/demo-daily-orders/dagRuns/demo__2026-10-16__wrong_partition/taskInstances/aggregate_orders/logs/1` | airflow-rest-v1|v2 |
| `offline.backfill.plan` | `GET /api/v1/dags/demo-daily-orders/details` | `GET /api/v2/dags/demo-daily-orders/details` | airflow-rest-v1|v2 |
| `offline.freshness.check` | `GET /api/v1/dags/demo-daily-orders/dagRuns` | `GET /api/v2/dags/demo-daily-orders/dagRuns` | file-catalog+airflow-rest-v1|v2 |
| `compute.queue.get` | `GET /api/v1/pools/demo-batch-pool` | `GET /api/v2/pools/demo-batch-pool` | airflow-pool |

## 关键事实（两侧原值）

- `offline.workflow.get`
  - v1: `{"schedule_type":"CronExpression","timezone":"Asia/Shanghai","is_paused":true,"is_active":true,"owners":["team-data"],"tasks":["aggregate_orders:BashOperator:demo-batch-pool","validate_output:PythonOperator:default_pool","wait_for_ods_partition:PythonSensor:default_pool"],"dag_source_sha256":"11501b7deba7b46586851c578bd6b8202e9210d2e053a20da5852f3fe3bc0317"}`
  - v2: `{"schedule_type":"CronExpression","timezone":"Asia/Shanghai","is_paused":true,"is_active":true,"owners":["team-data"],"tasks":["aggregate_orders:BashOperator:demo-batch-pool","validate_output:PythonOperator:default_pool","wait_for_ods_partition:PythonSensor:default_pool"],"dag_source_sha256":"11501b7deba7b46586851c578bd6b8202e9210d2e053a20da5852f3fe3bc0317"}`
- `offline.task.get`
  - v1: `{"operator":"BashOperator","pool":"demo-batch-pool","retries":0,"retry_exponential_backoff":false,"execution_timeout_seconds":1800,"upstream":["wait_for_ods_partition"],"downstream":["validate_output"]}`
  - v2: `{"operator":"BashOperator","pool":"demo-batch-pool","retries":0,"retry_exponential_backoff":false,"execution_timeout_seconds":1800,"upstream":["wait_for_ods_partition"],"downstream":["validate_output"]}`
- `offline.run.list`
  - v1: `{"runs":["demo__2026-10-16__wrong_partition:success:exact:2026-10-16:manual:true:{\"fault\":\"wrong_partition\"}"],"business_interval":{"start_local":"2026-10-16T00:00:00+08:00","end_local":"2026-10-17T00:00:00+08:00","start_utc":"2026-10-15T16:00:00.000Z","end_utc":"2026-10-16T16:00:00.000Z"}}`
  - v2: `{"runs":["demo__2026-10-16__wrong_partition:success:exact:2026-10-16:manual:true:{\"fault\":\"wrong_partition\"}"],"business_interval":{"start_local":"2026-10-16T00:00:00+08:00","end_local":"2026-10-17T00:00:00+08:00","start_utc":"2026-10-15T16:00:00.000Z","end_utc":"2026-10-16T16:00:00.000Z"}}`
- `offline.run.get (wrong_partition)`
  - v1: `{"findings":["inconsistency","inconsistency"],"target":{"table":"analytics.daily_orders","partition":"dt=2026-10-16","write_mode":"overwrite_partition"},"tasks":["wait_for_ods_partition:success:1","aggregate_orders:success:1","validate_output:success:1"]}`
  - v2: `{"findings":["inconsistency","inconsistency"],"target":{"table":"analytics.daily_orders","partition":"dt=2026-10-16","write_mode":"overwrite_partition"},"tasks":["wait_for_ods_partition:success:1","aggregate_orders:success:1","validate_output:success:1"]}`
- `offline.run.get (ok)`
  - v1: `{"findings":["fact"],"tasks":["wait_for_ods_partition:success","aggregate_orders:success","validate_output:success"]}`
  - v2: `{"findings":["fact"],"tasks":["wait_for_ods_partition:success","aggregate_orders:success","validate_output:success"]}`
- `offline.dependency.list`
  - v1: `{"task_edges":["aggregate_orders(null)->validate_output(null)","wait_for_ods_partition(up_for_reschedule)->aggregate_orders(null)"],"data":["ods.orders/dt=2026-10-14:missing"],"workflows":["demo-ods-orders:produces_input:no-run"]}`
  - v2: `{"task_edges":["aggregate_orders(null)->validate_output(null)","wait_for_ods_partition(up_for_reschedule)->aggregate_orders(null)"],"data":["ods.orders/dt=2026-10-14:missing"],"workflows":["demo-ods-orders:produces_input:no-run"]}`
- `offline.log.get`
  - v1: `{"task_state":"success","try_number":1,"returned_lines":20,"spark_app_ids":1}`
  - v2: `{"task_state":"success","try_number":1,"returned_lines":20,"spark_app_ids":1}`
- `offline.backfill.plan`
  - v1: `{"actions":["2026-10-14:skip_in_progress:demo__2026-10-14__missing_upstream:missing","2026-10-15:skip_succeeded:demo__2026-10-15__ok:present","2026-10-16:skip_succeeded:demo__2026-10-16__wrong_partition:missing"],"preconditions":["dag_importable=true","dag_not_paused=false","write_mode_safe=true","upstream_inputs_present=true","intervals_complete=true","has_actions=false","max_active_runs_valid=true"],"write_mode":"overwrite_partition"}`
  - v2: `{"actions":["2026-10-14:skip_in_progress:demo__2026-10-14__missing_upstream:missing","2026-10-15:skip_succeeded:demo__2026-10-15__ok:present","2026-10-16:skip_succeeded:demo__2026-10-16__wrong_partition:missing"],"preconditions":["dag_importable=true","dag_not_paused=false","write_mode_safe=true","upstream_inputs_present=true","intervals_complete=true","has_actions=false","max_active_runs_valid=true"],"write_mode":"overwrite_partition"}`
- `offline.freshness.check`
  - v1: `{"verdict":"missing","partition_state":"missing","producer_runs":["demo__2026-10-16__wrong_partition:success"]}`
  - v2: `{"verdict":"missing","partition_state":"missing","producer_runs":["demo__2026-10-16__wrong_partition:success"]}`
- `compute.queue.get`
  - v1: `{"provider":"airflow-pool","slots":2,"occupied_slots":0,"open_slots":2}`
  - v2: `{"provider":"airflow-pool","slots":2,"occupied_slots":0,"open_slots":2}`

**结论：所有能力在两个接口版本下输出同一契约（schema、顶层字段、分层状态语义一致），差异只出现在适配器与来源（meta.sources）。**
