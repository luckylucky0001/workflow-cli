# 计算作业与 SQL 提交（compute / sql 领域）

`compute` 领域回答“计算引擎上发生了什么”：Spark 应用的状态、作业与阶段、driver 日志、资源池占用；
`sql` 领域把只读 SQL 异步提交到计算引擎并跟踪状态。调度状态见 [offline.md](offline.md)，数据分区见 [data.md](data.md)。

| 能力 | 命令示例 | 适配器 | 操作 |
|---|---|---|---|
| `compute.job.get` | `compute job get --id local-1792240691874` | spark-history-rest | read |
| `compute.stage.list` | `compute stage list --job-id local-1792240691874 [--status failed]` | spark-history-rest | read |
| `compute.log.get` | `compute log get --job-id local-1792240691874 --limit-lines 200` | spark-driver-log-dir | read |
| `compute.queue.get` | `compute queue get --id demo-batch-pool` | airflow-pool | read |
| `compute.yarn-queue.get` | — | yarn-rm-rest | **planned** |
| `compute.instance.get` | — | cloud-compute-api | **planned** |
| `sql.query.submit` | `sql query submit --engine spark --file q.sql` | spark-submit-local | read（async） |
| `sql.query.get` | `sql query get --id q-20261017-xxxxxx` | spark-submit-local | read |
| `sql.query.cancel` | `sql query cancel --id q-20261017-xxxxxx` | spark-submit-local | execute |
| `sql.query.submit-trino` / `-hive` | — | — | **planned**（`--engine trino|hive` 返回 `UNSUPPORTED`） |

```yaml
endpoints:
  spark:
    demo-spark:
      history_url: http://127.0.0.1:18088
      spark_home: /opt/venvs/spark/lib/python3.12/site-packages/pyspark
      python: /opt/venvs/spark/bin/python
      driver_log_dir: ./.runtime/spark/driver-logs
      event_log_dir: ./.runtime/spark/events
      query_state_dir: ./.runtime/spark/queries
      warehouse_root: ./.runtime/warehouse
      # submit_script: ../offline-workflows/spark/spark-submit.sh   # 缺省按此相对配置文件目录解析
```

## 1. Spark 监控 REST 语义

参考 [Spark Monitoring and Instrumentation](https://spark.apache.org/docs/latest/monitoring.html)。history server 在 `/api/v1` 提供
`applications/{id}`、`jobs`、`stages`、`allexecutors` 等接口，数据来自**事件日志**：

- **前置条件**：提交时 `spark.eventLog.enabled=true`，`spark.eventLog.dir` 指向 history server 的 `spark.history.fs.logDirectory`。
  没有事件日志的应用在 history 中不存在。
- 运行中的应用写 `<app_id>.inprogress`，history server 按 `spark.history.fs.update.interval` 周期扫描，所以刚启动的应用可能暂时查不到。
- `local` / standalone 模式下 history 不记录驱动退出码。`compute job get` 的 `status` 是**推导值**（`status_basis` 说明依据）：

| status | 依据 |
|---|---|
| `succeeded` | `attempt.completed=true` 且没有失败作业 |
| `failed` | `attempt.completed=true` 且有失败作业 |
| `running` | 事件日志仍在写入（10 分钟内有更新或有运行中作业） |
| `incomplete` | 事件日志未正常结束且长时间无更新（驱动被杀或崩溃） |

找不到应用时的区分：事件日志存在但未加载 → `DATA_UNAVAILABLE`（稍后重试）；只有 driver 日志没有事件日志 → `COLLECTION_DISABLED`；都没有 → `NOT_FOUND`。

`compute stage list`：`duration_ms` = completionTime − submissionTime（墙钟），`executor_run_time_ms` 是所有任务执行时间之和；
输入/输出/shuffle 字节来自阶段聚合指标；失败阶段带 `failure_reason`（截断到 2000 字符）。

## 2. driver 日志（`compute log get`）

driver 日志**不是** Spark REST 提供的。演示环境由包装脚本 `demo/offline-workflows/spark/spark-submit.sh` 把 driver 的 stdout/stderr
（log4j 控制台输出）tee 到 `<driver_log_dir>/<app_id>.log`；应用运行中该文件是指向临时文件的符号链接（输出 `in_progress=true`）。
YARN / Kubernetes 环境应改用日志聚合适配器（planned）。

## 3. 资源池（`compute queue get`）

当前接入 Airflow pool（Airflow 2 REST v1 或 Airflow 3 REST v2，由 airflow 端点的 `api_version` 决定，输出相同；来源中的 adapter/method 记录实际版本，见 [offline.md §7](offline.md)）：`slots`、`occupied/running/queued/scheduled/deferred/open` 槽位。pool 只限制并发槽，不代表 CPU/内存；
reschedule 模式的传感器等待时不占槽。值为观测时刻的瞬时值，不是窗口统计。YARN 队列见 `compute.yarn-queue.get`（planned）。

## 4. SQL 提交（`sql query submit / get / cancel`）

- 只接受**单条** `SELECT` / `WITH` 查询：去掉注释与字符串字面量后检查，出现 `INSERT/CREATE/DROP/ALTER/SET/...` 等关键字或多条语句即拒绝（`INVALID_ARGUMENT`）。
  写入/DDL 不走此入口。
- 提交是异步的：workctl 复制 SQL 快照（记录 `sql_sha256`），以独立进程组启动 `spark-submit`（local[2]，事件日志开启），立即返回 `q-...` 和 `state=submitted`。
  运行器更新状态文件 `query_state_dir/<id>.json`：`running`（带 `app_id`）→ `succeeded`（`row_count`、≤20 行预览、`result_location`）| `failed`（`error`）。
- `sql query get` 发现提交进程已退出但状态未到终态时报告 `lost`，与运行器捕获的 `failed` 区分。
- 结果以 JSON lines 写到 `query_state_dir/<id>/result`（或 `--output`，须不存在且不在 warehouse_root 内）。
- 演示环境的表：warehouse_root 下每个 `<db>/<table>` 目录注册为临时视图 `<db>_<table>`（如 `analytics_daily_orders`），`dt=...` 分区目录成为 `dt` 列。
- `sql query cancel` 是 `execute` 操作（需 `allow_execute`）：向进程组发送 SIGTERM，5 秒未退出再 SIGKILL，状态记为 `cancelled`；
  被终止的 Spark 应用在 history 中为 `incomplete`。

示例查询在 `demo/offline-workflows/sql/examples/`：`daily_orders_by_date.sql`（按 dt 汇总，可直接看到 `dt` 与 `order_date` 不一致的分区）、
`slow_cross_join.sql`（用于演示取消）。

## 5. 与 offline 的关系

`offline run get` 通过任务 XCom / 日志中的 `WORKCTL_SPARK_APP_ID=<id>` 找到 application id，再调用 `compute.job.get` 得到计算层状态。
调度成功、Spark 成功、分区存在、质量通过是四个不同的检查项。
