# 离线调度（offline 领域）

`offline` 领域把调度系统（当前接入 Airflow 2.x stable REST API v1）暴露为能力：工作流与任务定义、按**业务日期**查找运行、
一次运行的**分层状态**（调度 / 计算 / 数据产出 / 质量）、依赖、任务日志、补数计划与产出时效。
Spark 作业、资源池见 [compute.md](compute.md)；分区与质量规则本身见 [data.md](data.md)。

| 能力 | 命令示例 | 操作 |
|---|---|---|
| `offline.workflow.get` | `offline workflow get --id demo-daily-orders` | read |
| `offline.task.get` | `offline task get --workflow demo-daily-orders --task aggregate_orders` | read |
| `offline.run.list` | `offline run list --workflow demo-daily-orders --data-date 2026-10-16 --timezone Asia/Shanghai` | read |
| `offline.run.get` | `offline run get --workflow demo-daily-orders --id demo__2026-10-16__wrong_partition` | diagnose |
| `offline.dependency.list` | `offline dependency list --run-id demo__2026-10-14__missing_upstream --direction upstream` | diagnose |
| `offline.log.get` | `offline log get --run-id <run_id> --task aggregate_orders --limit-lines 200` | read |
| `offline.backfill.plan` | `offline backfill plan --workflow demo-daily-orders --from 2026-10-12 --to 2026-10-16` | plan |
| `offline.backfill.get` | `offline backfill get --id op-20261017-xxxxxx` | read |
| `offline.freshness.check` | `offline freshness check --dataset analytics.daily_orders --data-date 2026-10-16` | diagnose |

profile 端点（凭据只用引用）：

```yaml
endpoints:
  airflow:
    demo-airflow:
      url: http://127.0.0.1:18080
      api_version: v1                 # 只接入 v1（Airflow 2.x）
      username: admin
      password_ref: file:.runtime/secrets/airflow_admin_password
      timezone: Asia/Shanghai         # 缺省业务时区
```

Airflow 需要启用 `[api] auth_backends = airflow.api.auth.backend.basic_auth,...`。401 → `UNAUTHENTICATED`，403 → `PERMISSION_DENIED`，
404 → `NOT_FOUND`（DAG / run / 任务不存在）。

## 1. 语义：DAG、run、任务实例、数据区间

参考 Airflow 文档 [DAG Runs](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/dag-run.html)。

- **DAG**（工作流）：调度单元。`schedule`、`timezone`、`catchup`、`max_active_runs`、`params` 都在 DAG 上。
- **DAG run**：DAG 的一次运行。关键时间字段**不是同一个东西**：
  - `data_interval_start / data_interval_end`：这次运行**处理的数据区间**。日调度 `@daily` + `Asia/Shanghai` 时，业务日期 D 的 run 区间是 `[D 00:00, D+1 00:00) +08:00`。
  - `logical_date`（旧称 execution_date）：定时 run 等于 `data_interval_start`；**手动触发且不传区间时**，Airflow 用时间表推断“logical_date 之前最近一个完整区间”，此时区间比 logical_date 早一天。
  - `start_date / end_date`：实际开始、结束时间，通常在区间结束之后（D+1 凌晨）。
- **任务实例**（task instance）：run 中某个任务的一次执行，带 `try_number`；传感器 `mode=reschedule` 等待时状态为 `up_for_reschedule`，不占执行槽。

**业务日期 ≠ 启动日期**。workctl 统一把业务日期定义为 `data_interval_start` 在业务时区的日期，所有输出同时给出 UTC 与业务时区时间（`{utc, local}`）。

### `run list` 的匹配规则

`--data-date D --timezone TZ` 映射为 `[D 00:00, D+1 00:00)`（TZ），按 run 的 data_interval 与之相交来匹配，输出 `mapping` 说明规则：

| match | 含义 |
|---|---|
| `exact` | 区间完全相同（日调度） |
| `contained` | run 区间落在当天内（小时级调度） |
| `covers` | run 区间覆盖当天（周/月调度） |
| `overlaps` | 部分重叠 |

只检索 logical_date 在 `[D-1d, D+1d]` 内的 run（coverage 注明）。没有匹配 → `success` + 空数组 + note，不是错误。

## 2. 分层状态（`run get`）

“调度成功”“计算成功”“分区存在”“质量通过”是**四个不同的检查项**，各自带来源：

| 层 | 来源 | 状态取值 | 说明 |
|---|---|---|---|
| scheduler | Airflow `GET /dags/{id}/dagRuns/{run}` | queued/running/success/failed | 只代表调度层任务全部成功 |
| compute | Spark history server（经 `compute.job.get`） | running/succeeded/failed/incomplete/unknown | application id 取自任务 XCom `return_value` 或任务日志中的 `WORKCTL_SPARK_APP_ID=` |
| output | `data.partition.get`（目录 + 文件系统） | present/missing/empty/incomplete/unreadable/unknown | 目标表 = 目录中 `produced_by.workflow` 为该 DAG 的表；分区值 = data_interval_start 在分区时区的日期 |
| quality | `data quality check` 最近一次落盘结果 | pass/fail/error/not_run/unknown | 结果带 `checked_at`，不会随分区重写自动失效 |

`summary.findings` 只列可由上述事实直接得出的不一致（如“调度 success 但分区 missing”）；原因（例如写错分区）属于假设，需要日志和输出路径证据。
无法确定的层标为 `unknown` 并在 `coverage.notes` 说明原因，不会被当作成功。

## 3. 依赖（`dependency list`）

每条边标注来源：`scheduler-metadata`（DAG 内任务边，带本次 run 的任务状态）、`catalog-metadata`（目录 `upstream` / `consumers` / `produced_by`）、
`binding-file`（`bindings.yaml` 中的 `produces` / `reads_from` / `depends_on`）。同一关系在多个来源出现时用 `corroborated_by` 标注。
上游数据依赖按同一业务日期检查输入分区状态；跨工作流依赖给出对方同一业务日期的 run。**不根据名称相似推断依赖。**

## 4. 补数（`backfill plan` → `operation execute`）

参考 Airflow 文档 [Backfill](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/backfill.html)。
workctl 不调用 `airflow dags backfill` 命令，而是按业务日期逐个决策，并通过 REST 显式触发/清理，便于预览、授权与审计：

| 字段 | 含义 |
|---|---|
| `targets[].existing_runs` | 该业务日期已有的 run（按区间匹配） |
| `targets[].action` | `skip_succeeded` / `skip_in_progress` / `trigger_new`（POST dagRuns，显式传 logical_date 与 data_interval）/ `clear_failed`（只清理失败任务实例）/ `rerun`（`--rerun-succeeded`，清理全部任务实例） |
| `targets[].target_partition` / `partition_state` | 目标分区及其当前状态（`data.partition.get`） |
| `targets[].upstream_inputs` | 目录 upstream 中同业务日期的输入分区状态；外部来源标 `external` |
| `impact.write_mode` / `idempotent_rewrite` | `overwrite_partition` 重跑幂等；`append` 重跑有重复风险，未加 `--allow-append-duplicates` 时前置条件失败 |
| `impact.downstream` | 目录 consumers、以本表为上游的表、绑定文件中读取本表的工作流 |
| `impact.code_version` | `sha256(GET /dagSources/{file_token})` + `last_parsed_time`：重跑使用**当前**代码，不是原 run 当时的代码 |
| `impact.concurrency` | 计划并发、DAG `max_active_runs`、当前在途 run、相关 pool 余量 |
| `preconditions` | `dag_importable`、`dag_not_paused`、`write_mode_safe`、`upstream_inputs_present`、`intervals_complete`、`has_actions`、`max_active_runs_valid` |

计划存为 `kind=offline.backfill`（`operation get --id` 可查看），**计划不是执行证据**。执行：

```bash
workctl operation execute --id op-20261017-xxxxxx --confirm op-20261017-xxxxxx   # 需要 profile allow_execute: true
workctl offline backfill get --id op-20261017-xxxxxx                               # 已触发 run 的实时状态
```

执行器在提交前重新读取每个业务日期的 run（计划可能已过时），同时在途的 run 不超过计划的并发上限，超出时间预算的剩余日期记为 `not_submitted`。
清理（clear）沿用原 run 的 `conf`：如果问题来自 conf（如演示中的 `fault`），重跑会复现同样的问题。

## 5. 产出时效（`freshness check`）

目录 `freshness: {expected_by: "06:00", day_offset: 1, timezone?}` → 时限 = 业务日期 + day_offset 天的 HH:MM（业务时区）。

| verdict | 条件 |
|---|---|
| `on_time` | 分区 present 且更新时间 ≤ 时限 |
| `late` | 分区 present 但更新时间 > 时限（`lateness_minutes`） |
| `missing` | 已过时限，分区不是 present（missing/empty/incomplete/unreadable 都算） |
| `not_due` | 未到时限且分区尚未 present |
| `unknown` | 分区状态或更新时间无法确定 |

同时附带产出工作流同一业务日期的 run（`producer`），便于区分“没跑”“跑了失败”“跑成功但没产出”。

## 6. 演示环境与场景

`demo/environment/offline-up.sh`（由 `up.sh` 调用，幂等）启动 Airflow 2.10（SequentialExecutor + sqlite，127.0.0.1:18080，
DAG 目录 `demo/offline-workflows/dags`，默认时区 Asia/Shanghai，pool `demo-batch-pool` 2 槽）和 Spark history server（127.0.0.1:18088）。
`offline-down.sh` 停止它们。

| DAG | 任务 | 说明 |
|---|---|---|
| `demo-ods-orders` | `extract_orders` | 调用合成数据生成器写 `ods/orders/dt=D`（含 `_SUCCESS`） |
| `demo-daily-orders` | `wait_for_ods_partition` → `aggregate_orders` → `validate_output` | 传感器（reschedule，30s）等 ODS 分区；spark-submit local[2] 执行 `sql/daily_orders.sql` 覆盖写 `analytics/daily_orders/dt=D` |

`demo/scenarios/offline/` 通过 REST 触发真实运行（见其 README）：

| 场景 | 现象（真实执行产生） |
|---|---|
| ODS 2026-10-15 / 16 | 两个分区 present |
| daily 2026-10-15 | 四层全部正常 |
| daily 2026-10-16 + `{"fault":"wrong_partition"}` | 所有任务 success、Spark 成功，但写到 `dt=2026-10-17`；`dt=2026-10-16` missing |
| daily 2026-10-14（ODS 未抽取） | 传感器 `up_for_reschedule` 持续等待；`dependency list` 显示输入分区 missing、上游工作流该日期没有 run |

## 7. 限制

- 只接入 Airflow stable REST API v1；Airflow 3（API v2）、DolphinScheduler 等调度器待接入。
- 传感器 mode/poke_interval/timeout、SLA 不在 REST 任务接口中（`task get` 的 `not_exposed`）。
- `run get` 不指定 `--workflow` 时最多扫描 100 个活跃 DAG。
- 质量层只读取已落盘的最近结果，不自动执行规则。
