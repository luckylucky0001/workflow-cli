# 计算作业与 SQL 提交（compute / sql 领域）

`compute` 领域回答“计算引擎上发生了什么”：Spark 应用的状态、作业与阶段、driver 日志、资源池占用；
`sql` 领域把只读 SQL 异步提交到计算引擎（Spark SQL / Trino）并跟踪状态。调度状态见 [offline.md](offline.md)，数据分区见 [data.md](data.md)。

| 能力 | 命令示例 | 适配器 | 操作 |
|---|---|---|---|
| `compute.job.get` | `compute job get --id local-1792240691874` | spark-history-rest | read |
| `compute.stage.list` | `compute stage list --job-id local-1792240691874 [--status failed]` | spark-history-rest | read |
| `compute.log.get` | `compute log get --job-id local-1792240691874 --limit-lines 200` | spark-driver-log-dir | read |
| `compute.queue.get` | `compute queue get --id demo-batch-pool` | airflow-pool | read |
| `compute.yarn-queue.get` | — | yarn-rm-rest | **planned** |
| `compute.instance.get` | — | cloud-compute-api | **planned** |
| `sql.query.submit` | `sql query submit --engine spark\|trino --file q.sql` | spark-submit-local \| trino-http | read（async） |
| `sql.query.get` | `sql query get --id q-20261017-xxxxxx` | spark-submit-local \| trino-http | read |
| `sql.query.cancel` | `sql query cancel --id q-20261017-xxxxxx` | spark-submit-local \| trino-http | execute |
| `sql.query.submit-hive` | — | — | **planned**（`--engine hive` 返回 `UNSUPPORTED`） |

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
  trino:
    demo-trino:
      url: http://127.0.0.1:18085      # 协调节点
      user: workctl                    # X-Trino-User
      # password_ref: env:TRINO_PASSWORD   # 可选，basic 认证（Trino 要求 HTTPS 才接受密码）
      catalog: tpch                    # 可选，X-Trino-Catalog（--catalog 覆盖）
      schema: tiny                     # 可选，X-Trino-Schema（--schema 覆盖）
      source: workctl                  # 可选，X-Trino-Source，便于在 Trino UI / 审计中识别
      # query_state_dir: ./.runtime/trino/queries   # 缺省 <state_dir>/sql/trino/<端点名>
      # max_result_rows: 100000        # 结果行数上限，超过即取消查询并记 failed（RESULT_LIMIT_EXCEEDED）
      # submit_wait_ms: 3000           # submit 跟随 nextUri 的窗口（让语法/语义错误在提交时暴露）
      # poll_budget_ms: 5000           # 每次 get 拉取结果页的预算
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

## 5. Trino（`sql query submit --engine trino`）

> 权限边界（演示环境）：Trino 使用基于文件的访问控制（`demo/environment/trino/rules.json`），workctl 使用的 `workctl` 账号对所有目录只读；即使语句绕过了 workctl 的只读防护，`CREATE TABLE` 等写操作也会被 Trino 以 `PERMISSION_DENIED` 拒绝（`test/sql/trino-acl.live.test.ts`）。客户环境应同样为 workctl 配置只读账号，程序侧防护只是第一道。

实现 Trino [client protocol](https://trino.io/docs/current/develop/client-protocol.html)（HTTP，不依赖驱动），已在 Trino 476（单节点 `trinodb/trino:476`，
内置 `tpch` / `system` catalog）上验证，记录见 [demo/verification/report.trino.md](../../demo/verification/report.trino.md)。输出与 Spark 相同的契约，
Trino 特有信息放在可选字段：`engine_query_id`（Trino query id）、`engine_state`（Trino 原始状态）、`stats`、`column_types`、`catalog`/`schema`、`engine_version`；
`pid`、`app_id`、`spark_version`、`views` 为 `null`。

**查询生命周期与状态映射**

| Trino 状态 | workctl `state` | 说明 |
|---|---|---|
| `QUEUED` / `WAITING_FOR_RESOURCES` / `DISPATCHING` / `PLANNING` | `submitted` | 已被协调节点接受，尚未开始执行 |
| `STARTING` / `RUNNING` / `FINISHING`，或 `FINISHED` 但仍有 `nextUri` | `running` | 结果页未取完 |
| `FINISHED` 且 `nextUri` 链结束 | `succeeded` | **Trino 报告完成且 workctl 已取回全部结果页** |
| `FAILED`（`USER_CANCELED`） | `cancelled` | 由 `sql query cancel` 或其他客户端/管理员取消（`state_basis` 区分） |
| `FAILED`（其他） | `failed` | `error` 含 `type`=errorName、`error_type`、`error_code`、`sql_state`、行列号、`code`（对应 workctl 错误码） |
| `nextUri` 失效且 `GET /v1/query/{id}` 404 | `lost` | 协调节点已清理该查询（`query.min-expire-age`）或重启 |

- **提交**：`POST /v1/statement`（头 `X-Trino-User`、`X-Trino-Source`、`X-Trino-Catalog`/`X-Trino-Schema`），随后在 `submit_wait_ms`（默认 3 秒）内跟随 `nextUri`，
  直到查询离开 QUEUED/PLANNING。解析/分析阶段的失败在提交时直接返回错误（状态文件同样记录为 `failed`）：
  `USER_ERROR`（如 `SYNTAX_ERROR`、`COLUMN_NOT_FOUND`、`TYPE_MISMATCH`）→ `INVALID_ARGUMENT`；`CATALOG/SCHEMA/TABLE_NOT_FOUND` → `NOT_FOUND`；
  `PERMISSION_DENIED`（访问控制拒绝）→ `PERMISSION_DENIED`；`INSUFFICIENT_RESOURCES` / `INTERNAL_ERROR` / `EXTERNAL` → `UPSTREAM_UNAVAILABLE`；
  `EXCEEDED_TIME_LIMIT` / `ABANDONED_QUERY` → `TIMEOUT`。执行中途失败则是业务状态：`get` 返回 `success` + `state=failed` + `error.code`。
  `submit` 的 `state` 恒为 `submitted`（已被引擎接受），返回时 Trino 的实际状态见 `engine_state`。
- **与 Spark 的异步差异**：Spark 由独立进程跑到结束；Trino 的结果是**由客户端拉取驱动**的——结果缓冲区满时查询暂停，等待客户端取页。
  workctl 没有后台进程，`sql query get` 每次在 `poll_budget_ms`（默认 5 秒）内继续跟随状态文件中保存的 `nextUri`（页令牌只能前进，每页落盘后才请求下一页；
  并发的 `get` 用锁文件互斥）。**超过 Trino `query.client.timeout`（默认 5 分钟）没有任何 `get`，Trino 会以 `ABANDONED_QUERY` 结束查询**，
  长查询需要周期性 `get`。
- **结果**：所有行按列名写成 JSON lines（`result_location/part-00000.json`，与 Spark 的结果目录格式一致），前 `preview_rows`（≤ 20）行进入预览，
  `row_count` 只在 `succeeded` 时给出（运行中的已接收行数见 `state_basis`）。重名列（如 `SELECT a.x, b.x`）在记录中为 `x`、`x#2`。
  超过 `max_result_rows`（默认 100000）时 workctl 取消查询并记 `failed`（`RESULT_LIMIT_EXCEEDED`），结果目录只保留前 N 行。
  Trino 以 JSON 数值返回 `bigint`，超过 2^53 的值在 JavaScript 中会丢失精度；`decimal`、日期时间以字符串返回。
- **统计**（`stats`）：来自结果页 `stats`（`source=statement`）——`elapsed_ms`、`queued_ms`、`cpu_ms`、`wall_ms`、`processed_rows/bytes`、`physical_input_bytes`、
  `peak_memory_bytes`、`spilled_bytes`、splits、`progress_pct`；取消/失效后改从 `GET /v1/query/{id}` 的 `queryStats` 解析（`source=query-info`，没有的字段为 `null`）。
  终态时用 `queryStats.executionStartTime/endTime` 填 `started_at/finished_at`；`duration_ms` = Trino `elapsedTime`。tpch 等生成数据的连接器 `processed_bytes` 可能为 0，是 Trino 的实际值。
- **取消**（`execute`）：`DELETE nextUri`（无 `nextUri` 或已失效时 `DELETE /v1/query/{id}`），随后轮询 `GET /v1/query/{id}` 确认 `FAILED/USER_CANCELED`：
  确认后 `state=cancelled`、`confirmed=true`；未在约 3 秒内确认则 `state=cancel_requested`，用 `get` 复核；查询已先结束则如实报告终态。
- **只读守卫**：与 Spark 共用“单条 SELECT/WITH + 禁止写入/DDL/会话关键字”的检查，Trino 另外拒绝 `EXECUTE`/`PREPARE`/`DEALLOCATE`/`COMMIT`/`ROLLBACK`、
  `WITH FUNCTION` 内联函数、除 `sequence` / `exclude_columns` 外的表函数（如 JDBC 连接器的 `system.query` 会把任意 SQL 透传到后端数据库）；
  `CALL`（含 `system.runtime.kill_query` 等过程）、`SET/RESET SESSION`、`USE`、`EXPLAIN ANALYZE`、`START TRANSACTION`、`CREATE TABLE AS`、`INSERT` 均因首关键字被拒绝。
  Spark 的“直接查询文件”规则不适用于 Trino（`hive.`、`iceberg.`、`delta.` 是常见 catalog 名）；紧跟 `(` 的词按函数调用处理（如 `replace(...)`）。
  守卫只是第一道防线，生产环境仍应给 workctl 用户配置只读的 Trino 访问控制规则。
- **安全**：`nextUri` 只在配置的 `url` 上跟随（按路径重新拼接到配置的协调节点），凭据不会发往 Trino 返回的其他主机；`nextUri` 中的 slug 只保存在本地状态文件，不进入输出。
- **身份探测**：`auth status --probe` 对 trino 端点调用 `GET /v1/info`（版本 `nodeVersion`、`starting`）。`/v1/info` 不校验身份，无密码时 `X-Trino-User` 只是声明，
  实际授权由查询时的访问控制决定。

## 6. 与 offline 的关系

`offline run get` 通过任务 XCom / 日志中的 `WORKCTL_SPARK_APP_ID=<id>` 找到 application id，再调用 `compute.job.get` 得到计算层状态。
调度成功、Spark 成功、分区存在、质量通过是四个不同的检查项。
