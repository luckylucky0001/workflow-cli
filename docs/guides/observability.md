# 可观测性能力指南：指标、日志、调用链

本指南覆盖 `observability` 领域：`metric query`、`metric list`、`log query`、`trace get`。结果信封与错误码见 `docs/design-principles.md`。

## 对象模型

```
resource / service ──(指标目录 $service 模板)──▶ Prometheus 时间序列
service ──(容器标签)──▶ container ──(Docker logs)──▶ 结构化日志行
   │                                                └─ kind=span 记录 ──▶ 日志派生的调用链
   └──(labels 映射 → LogQL 流选择器)──▶ Loki 日志流 ──▶ 同一结构化日志行（provider=loki 时）
```

- 指标通过 profile 中 Prometheus 端点的 `metrics` 目录把业务名（`request_latency`、`cache_hit_ratio`、`db_query_rate`…）映射为 PromQL，`$service` 替换为资源 ID。目录就是指标口径的契约，`metric list` 可查看。
- 日志与调用链按服务的容器标签找到容器（同 `container workload get` 的选择规则），不按名称猜；provider 为 Loki 时按端点的 `labels` 映射生成 LogQL 流选择器（见下文“Loki provider”）。

## 命令

| 命令 | 语义 |
|---|---|
| `metric list [--resource R]` | 列出指标目录：名称、含义、单位、模板、渲染后的 PromQL |
| `metric query --resource R --metric M [--window 15m] [--step 15s]` | Prometheus `/api/v1/query_range`；返回每条序列的数据点和 min/max/avg/last |
| `metric query --promql Q` | 直接查询（与 `--metric` 二选一） |
| `log query --service S [--window 15m] [--level error] [--contains X] [--trace-id T] [--limit 200] [--order newest\|oldest]` | Docker 容器日志（stdout+stderr，默认）或 Loki（provider=loki），解析 JSON 行，过滤并返回；两个 provider 输出同一契约 |
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
| Loki：选择器在回看期内没有任何日志流（labels 映射不对、采集器未推送该服务） | `NOT_FOUND`（与 Docker“没有匹配的容器”对应） |
| Loki：选择器有日志流，但窗口内没有日志行 / 过滤后为空 | `success` + 空 `entries`（`coverage.notes` 说明窗口内无日志行） |
| Loki 拒绝 LogQL（HTTP 400，如 labels 模板写错） | `INVALID_ARGUMENT`，message 带 Loki 原文 |
| Loki 401 / 403 | `UNAUTHENTICATED` / `PERMISSION_DENIED`（检查 username/password_ref、tenant） |
| Loki 不可达、429 限流、5xx | `UPSTREAM_UNAVAILABLE`（retryable） |
| 窗口起点早于 Loki 保留期 / `max_query_lookback` | 结果照常返回，`coverage.notes` 标出不可见的时间段 |

- 延迟分位数来自 `histogram_quantile`：结果受桶边界限制，落在最大有限桶（demo-order 为 10s）之外时返回该边界值，应解读为“≥ 边界”。
- `metric query` 的窗口终点对齐到 step，`coverage.window` 是实际查询的起止时间。窗口值来自时间序列（`rate()` 已处理计数器重置），不要用累计计数器的当前值代替窗口值。
- `log query` 默认 `order=newest`：返回窗口内**最新**的 `limit` 条，按时间倒序；`order=oldest` 返回最早的 `limit` 条、按时间正序。`coverage.truncated=true` 表示匹配条数超过 limit；`data.stats` 给出扫描行数、匹配数、非 JSON 行数、被省略的 span 记录数。
- 非 JSON 行保留原文（`raw`），级别未知；使用 `--level` 时它们会被排除并计入 `unparsed_excluded_by_level`。
- span 记录（`kind=span`）默认不在 `log query` 中返回（`--include-spans` 返回），调用链用 `trace get` 看。

## 保留期与覆盖范围

- Docker 日志保留取决于日志驱动与轮转配置（`max-size`/`max-file`）；容器被**重建**（compose up 重新创建）后，旧容器的日志随之删除，`coverage.notes` 会标出容器创建时间晚于窗口起点的情况。重启（restart）不丢日志。
- `trace get` 是**日志派生**视图（`relation: derived`）：只包含服务打点并仍在保留期内的 span。未打点的耗时体现为父 span 的 `self_ms`。根 span 的父 span 不在日志中时记为 `external_parent`（来自未记录日志的调用方）；有多个根时 `coverage.complete=false`。
- trace 默认扫描资源绑定中当前环境全部 `service` 的容器，窗口 1h；按 trace_id 子串预过滤，扫描量见 `data.scanned`。

## Loki provider

`log query` 与 `trace get` 可以改由 Loki 提供日志，输出契约（`data` 的 zod schema、条目结构、`stats`、`coverage` 语义）与 Docker 路径相同：Loki 返回的每一行都按 Docker 的 `<时间戳> <内容>` 形式交给同一个解析器（`parseLogLine`）和同一个过滤器（`matches`）复核，LogQL 过滤只用于减少传输量。

### 选择哪个 provider

按以下顺序决定（Docker 始终是默认）：

1. 资源绑定中该服务的 `attributes.log_provider: loki | docker`（可选 `attributes.log_endpoint: <loki 端点名>`、`attributes.log_selector: '{app="$service"}'` 覆盖流选择器）；
2. profile 的 `defaults.logs: loki | docker`（Loki 端点取 `defaults.loki`，或唯一的 loki 端点）；
3. 都没有配置 → docker。

选择来源写在 `coverage.notes` 第一条（如 `日志 provider: loki（profiles.demo.defaults.logs=loki）`）。`trace get` 不指定 `--service` 时按每个服务各自的 provider 扫描，可以混用。

### 端点配置

```yaml
defaults:
  logs: loki            # 本 profile 的日志走 Loki
  loki: demo-loki
endpoints:
  loki:
    demo-loki:
      url: http://127.0.0.1:13100
      labels: '{service="$service", env="$env"}'   # 服务 → LogQL 流选择器；也可写成映射 {service: $service, env: $env}
      tenant: team-a                                 # 可选，发送 X-Scope-OrgID
      username: reader                               # 可选，basic auth
      password_ref: env:LOKI_PASSWORD                # 与 username 配对，只允许引用
      push_interval: 1s                              # 可选，写进入库延迟说明
      retention: 72h                                 # 可选；不配置时读取 Loki /config 的 retention_period / max_query_lookback
```

- `$service` 替换为 `--service`，`$env` 替换为 `--env` 或 profile 的 `env`；取值只允许字母、数字和 `. _ : -`。未配置 `labels` 时默认 `{service="$service"}`。
- 演示环境：`demo/environment/workctl.yaml` 只增加了 `endpoints.loki.demo-loki`（默认仍是 Docker）；`demo/environment/workctl.loki.yaml` 是同一个 demo profile 加上 `defaults.logs: loki`，用来对同一服务比较两个 provider（见 `demo/scenarios/reuse/log-provider-swap.mjs` 与 `demo/verification/log-provider-swap.md`）。
- 采集：`docker compose up -d loki promtail`（`demo/environment/loki/`）。Promtail 用 `docker_sd_configs` 读取带 `workctl.env` 标签的容器日志，把容器标签映射为流标签：`workctl.service→service`、`workctl.resource→resource`、`workctl.env→env`、容器名→`container`、容器 ID→`container_id`、stdout/stderr→`stream`。`level`、`trace_id` 留在日志行内，不做成标签（避免高基数），查询时用 `| json` 过滤。
- `auth status --probe` 对 loki 端点读取 `/loki/api/v1/status/buildinfo`（版本）和 `/ready`。

### 查询方式

| 输入 | LogQL |
|---|---|
| `--service` | 流选择器，如 `{service="demo-order", env="sandbox"}` |
| `--trace-id T` | `\|= "T"`（行过滤，再由本地过滤器按 `trace_id` 字段精确复核） |
| `--contains X` | `\|= "X"`（Go 字符串字面量转义，引号、反斜杠、换行均安全） |
| `--level L` | `\| json workctl_level="level" \| workctl_level=~"(?i)(error\|err\|fatal\|…\|50\|60)"`（与 Docker 路径同一级别排序，含 pino 数字级别） |
| 默认省略 span | `\| json workctl_kind="kind" \| workctl_kind!="span"` |
| `--order newest / oldest` | `direction=backward / forward` |
| `--limit N` | `limit=N+1`：多取一条判断是否截断；不足时按时间边界分页（边界去重） |

`stats` 由同一窗口的 `count_over_time` 即时查询给出：`lines_scanned`（`sum by (container, container_id)`）、未截断时 `matched`/`by_level` 直接按返回条目计数，截断时取自统计查询（`sum by (…, workctl_level)`）、`unparsed_lines`（`__error__="JSONParserErr"`）、`spans_skipped`。`containers[]` 按 Loki 流（`container` + `container_id` 标签）给出。`trace get` 用 `{选择器} |= "<trace_id>"` 正向分页拉取，之后的 span 重建与 Docker 路径完全相同。

### 与 Docker 路径的口径差异

- **入库延迟**：日志要等采集器推送后才可见（demo 的 Promtail `batchwait=1s`）。窗口末尾刚写入的几行 Docker 能读到、Loki 可能还没有；每次结果的 `coverage.notes` 都会说明。需要“刚刚发生”的日志时可改用 Docker provider 或稍后重查。
- **保留期**：Docker 取决于 json-file 轮转（demo-order `max-size=20m`、`max-file=5`），容器重建后旧日志消失；Loki 取决于 `retention_period` / `max_query_lookback`（demo 72h），并且**保留已重建/删除容器的日志**（`containers[]` 中会出现同名不同 `container_id` 的行）。窗口起点早于 Loki 保留期时写入 `coverage.notes`。demo 的 Loki 数据在容器文件系统中，重建 Loki 容器即清空。
- **limit 语义**：两边都是窗口内最新/最早的 `limit` 条；Loki 的 `limit` 作用于服务端合并后的全部流。截断时 Docker 的 `matched` 是逐行扫描计数，Loki 的是统计查询结果；两次查询之间若有新日志入库，`coverage.notes` 会标出差异。
- **统计边界**：`count_over_time` 的区间是 (end−window, end]，`query_range` 是 [start, end)，边界上可能差一两行。`unparsed_lines` 以 Loki JSON 解析器的判定（`__error__="JSONParserErr"`）计数，个别边界行（如 JSON 数组、前导空白）可能与本地解析器判定不同；返回条目本身始终由本地解析器解析。
- **容器元数据**：Loki 流不含容器创建/启动时间和日志驱动：`containers[].created_at` 为空字符串、`started_at`/`log_driver` 为 null；`id` 来自 `container_id` 标签（缺失时为空）。没有 `stream` 标签的流按 stdout 记录并在 notes 说明。
- **时间戳**：Promtail 使用 Docker 记录的时间戳，`ts` 与 Docker 路径逐字节相同（9 位小数）。

## demo-order 的日志与指标约定

- 每行一个 JSON：`ts, level, service, msg, trace_id, span_id, parent_span_id`；访问日志 `kind=access`（route、status、duration_ms、cache_mode）；span 记录 `kind=span`（name、start、duration_ms、status、attributes）。span 名：`http.request`、`redis.get`、`redis.set`、`mysql.pool.acquire`（等待连接池）、`mysql.query`（语句执行）。
- 错误：`level=error`（如 `mysql query timeout`、`mysql connection unavailable`、`redis get failed`）。
- 指标：`http_requests_total{service,route,code}`、`http_request_duration_seconds`（histogram）、`cache_requests_total{service,result=hit|miss|bypass|error}`、`db_queries_total{service,query,outcome}`、`db_query_duration_seconds`、`db_pool_wait_seconds`、`cache_mode_info{mode}`。
- 响应头 `x-trace-id` 给出 trace_id，可直接用于 `trace get`。

## 前置条件

- Prometheus：`endpoints.prometheus.<name>.url`；指标目录 `endpoints.prometheus.<name>.metrics.<metric>: {query, unit, description}`。版本取自 `/api/v1/status/buildinfo` 写入 `meta.sources[].version`。
- 日志/调用链（docker provider）：`endpoints.docker` 可访问；容器日志驱动为 `json-file`、`local` 或 `journald`。
- 日志/调用链（loki provider）：`endpoints.loki.<name>.url` 与 `labels` 映射；日志采集器（Promtail / Alloy 等）把服务日志推送到 Loki，且流标签与 `labels` 映射一致。

## Provider 路线

| 数据 | 当前 | 规划 |
|---|---|---|
| 指标 | Prometheus HTTP API | 其他兼容 PromQL 的后端（同一接口） |
| 日志 | Docker 容器日志（默认）、Loki（LogQL） | 其他集中日志平台 |
| 调用链 | 结构化日志派生 | Jaeger / Tempo 等追踪后端 |
| 配额 | — | `quota get`（planned） |
