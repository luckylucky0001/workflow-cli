# 可观测性能力指南：指标、日志、调用链

本指南覆盖 `observability` 领域：`metric query`、`metric list`、`log query`、`trace get`。结果信封与错误码见 `docs/design-principles.md`。

## 对象模型

```
resource / service ──(指标目录 $service 模板)──▶ Prometheus 时间序列
service ──(容器标签)──▶ container ──(Docker logs)──▶ 结构化日志行
                                                    └─ kind=span 记录 ──▶ 日志派生的调用链
```

- 指标通过 profile 中 Prometheus 端点的 `metrics` 目录把业务名（`request_latency`、`cache_hit_ratio`、`db_query_rate`…）映射为 PromQL，`$service` 替换为资源 ID。目录就是指标口径的契约，`metric list` 可查看。
- 日志与调用链按服务的容器标签找到容器（同 `container workload get` 的选择规则），不按名称猜。

## 命令

| 命令 | 语义 |
|---|---|
| `metric list [--resource R]` | 列出指标目录：名称、含义、单位、模板、渲染后的 PromQL |
| `metric query --resource R --metric M [--window 15m] [--step 15s]` | Prometheus `/api/v1/query_range`；返回每条序列的数据点和 min/max/avg/last |
| `metric query --promql Q` | 直接查询（与 `--metric` 二选一） |
| `log query --service S [--window 15m] [--level error] [--contains X] [--trace-id T] [--limit 200] [--order newest\|oldest]` | Docker 容器日志（stdout+stderr），解析 JSON 行，过滤并返回 |
| `trace get --id T [--window 1h] [--service S]` | 从 `kind=span` 日志记录重建 span 树：总耗时、各 span 自身耗时（self_ms）和占比 |

## 窗口、空结果与错误的区分

| 情况 | 结果 |
|---|---|
| Prometheus 可达，窗口内没有样本 | `success`，`series: []`，`empty: true`，`coverage.notes` 含 `no samples in window` |
| 比率指标分母为零（窗口内无请求） | 点值为 `null`，计入 `summary.nan_points`，不当作 0 |
| 序列点数少于 window/step+1 | `coverage.notes` 说明缺点（抓取缺失、序列中途出现） |
| Prometheus 不可达 | `UPSTREAM_UNAVAILABLE` |
| PromQL 语法错误 | `INVALID_ARGUMENT`（带 Prometheus 的 errorType） |
| 容器日志驱动不支持读取（如 `none`、`syslog`） | `COLLECTION_DISABLED`（部分容器不可读时 `status=partial`） |
| 选择器没有匹配的容器 | `log query` 返回 `NOT_FOUND` |
| trace 在窗口内没有 span 记录 | `NOT_FOUND`，hint 提示扩大 `--window` |

- 延迟分位数来自 `histogram_quantile`：结果受桶边界限制，落在最大有限桶（demo-order 为 10s）之外时返回该边界值，应解读为“≥ 边界”。
- `metric query` 的窗口终点对齐到 step，`coverage.window` 是实际查询的起止时间。窗口值来自时间序列（`rate()` 已处理计数器重置），不要用累计计数器的当前值代替窗口值。
- `log query` 默认 `order=newest`：返回窗口内**最新**的 `limit` 条，按时间倒序；`order=oldest` 返回最早的 `limit` 条、按时间正序。`coverage.truncated=true` 表示匹配条数超过 limit；`data.stats` 给出扫描行数、匹配数、非 JSON 行数、被省略的 span 记录数。
- 非 JSON 行保留原文（`raw`），级别未知；使用 `--level` 时它们会被排除并计入 `unparsed_excluded_by_level`。
- span 记录（`kind=span`）默认不在 `log query` 中返回（`--include-spans` 返回），调用链用 `trace get` 看。

## 保留期与覆盖范围

- Docker 日志保留取决于日志驱动与轮转配置（`max-size`/`max-file`）；容器被**重建**（compose up 重新创建）后，旧容器的日志随之删除，`coverage.notes` 会标出容器创建时间晚于窗口起点的情况。重启（restart）不丢日志。
- `trace get` 是**日志派生**视图（`relation: derived`）：只包含服务打点并仍在保留期内的 span。未打点的耗时体现为父 span 的 `self_ms`。根 span 的父 span 不在日志中时记为 `external_parent`（来自未记录日志的调用方）；有多个根时 `coverage.complete=false`。
- trace 默认扫描资源绑定中当前环境全部 `service` 的容器，窗口 1h；按 trace_id 子串预过滤，扫描量见 `data.scanned`。

## demo-order 的日志与指标约定

- 每行一个 JSON：`ts, level, service, msg, trace_id, span_id, parent_span_id`；访问日志 `kind=access`（route、status、duration_ms、cache_mode）；span 记录 `kind=span`（name、start、duration_ms、status、attributes）。span 名：`http.request`、`redis.get`、`redis.set`、`mysql.pool.acquire`（等待连接池）、`mysql.query`（语句执行）。
- 错误：`level=error`（如 `mysql query timeout`、`mysql connection unavailable`、`redis get failed`）。
- 指标：`http_requests_total{service,route,code}`、`http_request_duration_seconds`（histogram）、`cache_requests_total{service,result=hit|miss|bypass|error}`、`db_queries_total{service,query,outcome}`、`db_query_duration_seconds`、`db_pool_wait_seconds`、`cache_mode_info{mode}`。
- 响应头 `x-trace-id` 给出 trace_id，可直接用于 `trace get`。

## 前置条件

- Prometheus：`endpoints.prometheus.<name>.url`；指标目录 `endpoints.prometheus.<name>.metrics.<metric>: {query, unit, description}`。版本取自 `/api/v1/status/buildinfo` 写入 `meta.sources[].version`。
- 日志/调用链：`endpoints.docker` 可访问；容器日志驱动为 `json-file`、`local` 或 `journald`。

## Provider 路线

| 数据 | 当前 | 规划 |
|---|---|---|
| 指标 | Prometheus HTTP API | 其他兼容 PromQL 的后端（同一接口） |
| 日志 | Docker 容器日志 | Loki / 集中日志平台 |
| 调用链 | 结构化日志派生 | Jaeger / Tempo 等追踪后端 |
| 配额 | — | `quota get`（planned） |
