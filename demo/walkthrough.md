# 演示手册：三条主线与一组复用证明

所有命令都在隔离演示环境中实际运行过（[verification/report.md](verification/report.md)）。业务数据全部为合成数据；故障条件是人为设计的，读取引擎和应用观测是真实执行的。

## 0. 准备（约 5 分钟）

```bash
npm ci && npm run build
cd demo/environment && ./up.sh && cd -          # MySQL 8.4、Redis 7.4、Kafka 3.9、Prometheus、demo-order、Airflow 2.10、Spark 3.5 history
export WORKCTL_CONFIG=$PWD/demo/environment/workctl.yaml
alias workctl="node $PWD/dist/workctl.js"
node demo/scenarios/mysql-redis/scenario.mjs warm-cache       # 预热缓存键（合成数据）
./demo/scenarios/offline/run-all.sh                             # 产生离线场景：10-15 正常、10-16 错误分区、10-14 上游缺失
node demo/scenarios/mq/produce-and-consume.mjs --reset          # 产生真实消费积压
workctl doctor                                                  # 自检：配置、凭据引用、端点可达、插件
```

开场：`workctl capability list` 展示三大板块与“待接入”能力；`workctl capability get --name mysql.statement.summary` 展示一个能力的参数、口径说明、输出 Schema、指南。

## 主线 A：基础设施资源与运行状态

> 用户：看一下 demo-order 的运行资源和依赖，定位当前异常关联的实例、事件和资源情况。

```bash
workctl service dependency list --service demo-order --env sandbox    # 依赖：容器、MySQL、Redis，每条带 source/evidence
workctl container workload get --service demo-order --env sandbox     # 状态、健康、重启次数、OOM、资源限制
workctl container event list --service demo-order --env sandbox --window 1h   # Docker 事件（注意 daemon 事件缓冲覆盖说明）
workctl container stats get --service demo-order --env sandbox        # 资源快照（kind=snapshot，不是窗口）
workctl capacity summary --env sandbox                                # 哪些容器没有 CPU/内存限制
workctl network backend list --service demo-order --env sandbox       # 后端探测（真实 HTTP 健康检查与延迟）
workctl metric query --resource demo-order --metric request_latency --window 15m
workctl container workload restart-plan --service demo-order --env sandbox    # 只生成操作计划：目标、影响、前置条件
```

**证明点**：异构基础设施经统一入口发现和关联；每条能力也能单独被人或脚本使用；操作先计划后执行（`operation execute --id <id> --confirm <id>`，需要 `allow_execute`）。

## 主线 B：MySQL + Redis 跨依赖分析

> 用户：demo-order 最近变慢了，请检查 Redis 与 MySQL 的情况，并结合请求日志给出依据。

故障注入（受控实验，见 [scenarios/latency/README.md](scenarios/latency/README.md)）：

```bash
node demo/scenarios/latency/loadgen.mjs --rps 10 --duration 60 --seed 42 --label baseline
./demo/scenarios/latency/inject.sh                                    # 缓存旁路：所有请求直达 MySQL
node demo/scenarios/latency/loadgen.mjs --rps 10 --duration 600 --seed 42 --label fault &
```

排查：

```bash
workctl metric query --resource demo-order --metric cache_hit_ratio --window 15m   # 命中率降到 0
workctl metric query --resource demo-order --metric db_query_rate --window 15m     # 数据库访问上升
workctl log query --service demo-order --env sandbox --window 15m --contains "cache mode changed"
workctl log query --service demo-order --env sandbox --window 15m --level error
workctl trace get --id <最慢请求的 trace_id>                                       # 耗时集中在 mysql.query（日志派生调用链）
workctl --timeout 30s redis stats sample --instance demo-redis --duration 10s      # 窗口差分，不是累计值
workctl --timeout 40s mysql statement summary --instance demo-mysql --sample-window 10s   # 采样窗口内的语句摘要
workctl mysql query explain --instance demo-mysql --database demo --sql-file demo/scenarios/latency/customer_recent.sql
workctl mysql query analyze --instance demo-mysql --database demo --sql-file demo/scenarios/latency/customer_recent.sql   # 会实际执行（只读、限时）
workctl mysql index plan --instance demo-mysql --database demo --table orders --columns customer_id,created_at
```

恢复与复验：`./demo/scenarios/latency/recover.sh`，用同一负载（同 seed、同速率）再跑一次 loadgen，结果以实测为准。

**证明点**：MySQL 与 Redis 能力组合成排查流程，也能单独用于巡检与容量盘点；结论区分“请求证据已确认”和“需要对照实验确认”。

## 主线 C：离线产出延迟与补数计划

> 用户：demo-daily-orders 对应业务日期 2026-10-16 的数据还没到，请沿依赖和计算链路检查，确认目标分区，并给出处理或补数计划。

```bash
workctl offline run list --workflow demo-daily-orders --data-date 2026-10-16 --timezone Asia/Shanghai   # 业务日期 → 数据区间 → 运行实例
workctl --timeout 60s offline run get --id demo__2026-10-16__wrong_partition --workflow demo-daily-orders
#   scheduler_state=success, compute_state=succeeded, output_state=missing, quality_state=fail —— 四层分别取证
workctl offline log get --run-id demo__2026-10-16__wrong_partition --workflow demo-daily-orders --task aggregate_orders
workctl compute job get --id <app_id>               # Spark 应用（history server）
workctl compute stage list --job-id <app_id>
workctl data partition get --catalog demo --table analytics.daily_orders --partition dt=2026-10-16   # state=missing
workctl data quality check --dataset demo.daily_orders --partition dt=2026-10-17 --ruleset demo-daily-rules
#   order_date 与分区 dt 不一致：数据写进了错误分区
workctl data lineage get --catalog demo --table analytics.daily_orders --direction downstream       # 下游影响
workctl --timeout 60s offline dependency list --run-id demo__2026-10-14__missing_upstream --workflow demo-daily-orders --direction upstream
#   另一类：上游 ods.orders dt=2026-10-14 缺失，传感器等待
workctl --timeout 60s offline backfill plan --workflow demo-daily-orders --from 2026-10-14 --to 2026-10-16 --timezone Asia/Shanghai
#   区间、任务集合、目标分区现状、写入方式（overwrite_partition）、下游影响、代码版本、并发预算
```

**证明点**：调度、计算、元数据、存储和质量能力被组合；“调度成功”不等于“数据产出”。

## 复用与扩展证明

| 演示动作 | 命令 | 需要看到的证据 |
| --- | --- | --- |
| 人、脚本、Agent 查询同一 Redis 实例 | `node demo/scenarios/reuse/same-contract.mjs` | 三种入口返回相同的能力、版本、适配器、数据字段与来源 |
| 排查与容量盘点复用同一适配器 | `node scripts/reuse-matrix.mjs` | Skill × 能力矩阵：同一能力被多个流程 Skill 引用 |
| 在线与离线共用日志、错误、来源机制 | 对比 `log query` 与 `offline log get` 的信封 | 相同的 `meta.sources`、`coverage`、错误码 |
| 插件新增消息队列能力 | `workctl plugin install --file plugins/demo-mq/dist/demo-mq-plugin.tgz`<br>`workctl --json capability list --domain mq`<br>`workctl mq consumer lag --help`<br>`workctl --json mq consumer lag --cluster demo-mq --group demo-consumer` | 新命令、指南、Schema 与真实 Kafka 结果；`mq queue get`（RabbitMQ）显示为待接入且不可调用 |
| 更换平台接口版本 | `demo/environment/offline3-up.sh`（Airflow 3.3.2，REST v2）后 `node demo/scenarios/reuse/version-swap.mjs` | 同一组离线/计算能力对 Airflow 2（v1）与 Airflow 3（v2）输出同一契约，只有 `meta.sources` 中的适配器与版本不同（[verification/version-swap.md](verification/version-swap.md)） |
| 更换容器平台 | `demo/environment/k8s/k3s-up.sh` 后 `WORKCTL_CONFIG=demo/environment/k8s/workctl.k8s.yaml workctl container workload get --service demo-order --env sandbox` | 同一命令按资源绑定改用 Kubernetes provider，输出通过同一 Schema（[verification/report.k8s.md](verification/report.k8s.md)） |
| 更换 SQL 引擎 | `workctl sql query submit --engine trino --file test/sql/fixtures/trino/orders_by_status.sql` → `sql query get --id <q>` | 与 Spark 引擎同一契约，Trino 专有信息在可选字段（[verification/report.trino.md](verification/report.trino.md)） |
| 更换日志来源 | `node demo/scenarios/reuse/log-provider-swap.mjs` | Docker 日志与 Loki 对同一流量返回一致的条目、统计与调用树（[verification/log-provider-swap.md](verification/log-provider-swap.md)） |
| Agent 宿主 | `./demo/agent-host/run-agent-demo.sh` | Claude Code 通过 Skill + CLI / MCP 完成三条主线的转录与摘要 |

## 复位

```bash
./demo/scenarios/latency/recover.sh
cd demo/environment && ./reset.sh      # 删除容器、卷、Airflow/Spark 运行时状态与密钥
```

注意：演示 DAG 默认被暂停以冻结场景状态（否则调度器会在下一个业务日自动运行并覆盖证据）。
