# 场景：服务延迟升高（缓存失效 → 数据库压力）

受控实验：同一份确定性负载（相同 `--seed`、速率和路由比例）在注入故障前后各跑一次，用 workctl 收集证据并对照。结果是什么就记录什么，不预设数值。

## 组成

| 文件 | 作用 |
|---|---|
| `loadgen.mjs` | 开环负载：按固定速率发请求（`/orders/:id` 与 `/customers/:id/orders` 混合，热点集合 + 长尾），输出实测 p50/p95/p99、状态码、最慢请求的 trace_id |
| `inject.sh` | 故障注入：`POST /admin/cache-mode {"mode":"bypass"}`，demo-order 不再使用 Redis，所有请求直达 MySQL |
| `recover.sh` | 恢复：`{"mode":"normal"}` |
| `experiment.sh` | 预热（不计入）→ 基线 → 注入 → 同负载再跑 →（默认）恢复；保存两次 loadgen 汇总与阶段时间到 `demo/environment/.runtime/scenarios/latency/<时间>/` |

`/customers/:id/orders` 查询 `orders.customer_id`（该列刻意无索引），缓存失效后每次都是全表扫描 + 排序。

## 运行

```bash
cd demo/environment && SKIP_OFFLINE=1 ./up.sh mysql redis demo-order prometheus
export WORKCTL_CONFIG=$PWD/workctl.yaml
cd ../scenarios/latency
KEEP_FAULT=1 ./experiment.sh            # 默认 10 rps，每阶段 120s；KEEP_FAULT=1 保留故障供排查
# 或手动：node loadgen.mjs --rps 10 --duration 120 --seed 42 --label baseline；./inject.sh；再跑同样的命令
```

## 用 workctl 排查（按 skills/service-latency-investigation）

```bash
workctl resource get --id demo-order                                         # 依赖：demo-mysql、demo-redis（service-config）
workctl container workload get --service demo-order                          # 运行状态、重启、限制
workctl metric query --resource demo-order --metric request_latency --window 15m
workctl metric query --resource demo-order --metric cache_hit_ratio --window 15m
workctl metric query --resource demo-order --metric db_query_rate --window 15m
workctl metric query --resource demo-order --promql 'sum by (result) (rate(cache_requests_total{service="demo-order"}[1m]))'
workctl log query --service demo-order --window 15m --level warn             # “cache mode changed”与超时/连接池错误
workctl trace get --id <loadgen 输出 slowest[].trace_id>                     # mysql.pool.acquire vs mysql.query 的耗时
workctl redis stats sample --instance demo-redis                             # redis 领域
workctl mysql statement summary --instance demo-mysql --window 15m           # mysql 领域：全表扫描语句
workctl mysql query explain --instance demo-mysql --sql-file customer_recent.sql
```

预期能被证据支撑的链条（以实测为准）：注入时刻之后 `cache_requests_total{result="bypass"}` 出现、`cache_hit_ratio` 变为 NaN/下降、`db_query_rate` 上升、p95 上升；日志中有 `cache mode changed`（warn，含前后值）；慢 trace 的耗时集中在 `mysql.pool.acquire`（排队）和 `mysql.query`（全表扫描）；EXPLAIN 显示 `customer_id` 条件无可用索引。

## 实测记录（隔离环境，2026-10-17，单机 Docker，4 vCPU）

同一 seed、每阶段 120s：

| 运行 | 速率 | 阶段 | 请求数 | p50 | p95 | p99 | 状态码 |
|---|---|---|---|---|---|---|---|
| 1 | 20 rps | 基线（无预热，缓存冷） | 2400 | 3.3 ms | 3015.7 ms | 5628.3 ms | 200×2400 |
| 1 | 20 rps | bypass | 2399 | 10000.8 ms | 10007.3 ms | 10017.2 ms | 200×313，503×625，客户端超时×1461 |
| 2 | 10 rps | 基线（预热 30s） | 见下方 | | | | |
| 2 | 10 rps | bypass | 见下方 | | | | |

运行 1 的 503 来自 demo-order 连接池排队上限（`mysql connection unavailable`），客户端超时为 loadgen 的 10s 上限。运行 1 基线的 p95 偏高是因为没有预热（缓存过期后的冷启动），所以 `experiment.sh` 增加了不计入的预热阶段。
