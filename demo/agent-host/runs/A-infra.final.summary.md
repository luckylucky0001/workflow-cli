# demo/agent-host/runs/A-infra.final.json

- 工具调用次数：12；workctl 调用：10
- 耗时：21160 ms；宿主报告成本：0.16331410000000002 USD；轮次：13；结束状态：success

## 调用序列

1. `ToolSearch: {"query":"select:mcp__workctl__resource_list,mcp__workctl__resource_get,mcp__workctl__service_dependency_list,mcp__workctl__container_workload_get,mcp__workctl_`
1. `MCP: resource_list {"service":"demo-order","env":"sandbox"}`
1. `MCP: service_dependency_list {"service":"demo-order","env":"sandbox"}`
1. `MCP: container_workload_get {"service":"demo-order","env":"sandbox"}`
1. `MCP: container_event_list {"service":"demo-order","env":"sandbox","window":"6h"}`
1. `MCP: container_stats_get {"service":"demo-order","env":"sandbox"}`
1. `ToolSearch: {"query":"select:mcp__workctl__mysql_instance_get,mcp__workctl__redis_instance_get,mcp__workctl__observability_log_query,mcp__workctl__mysql_session_list,mcp__w`
1. `MCP: observability_log_query {"service":"demo-order","env":"sandbox","window":"1h","level":"warn","limit":50}`
1. `MCP: mysql_instance_get {}`
1. `MCP: redis_instance_get {}`
1. `MCP: mysql_session_list {}`
1. `MCP: mysql_lock_list {}`

## 最终回答

## demo-order(sandbox)查询结果

当前最明确的异常是缓存被切到旁路(bypass)模式。从日志看,这是通过 admin API 做故障注入造成的,原因不是容器、Redis 或 MySQL 本身出问题。以上全部是只读查询,没有做任何变更。

### 依赖关系
依赖来自绑定文件和 docker-compose 配置,不是按名称推断的。

| 资源 | 类型 | 关系 |
|---|---|---|
| `demo-order-workload` | container.workload(Docker) | demo-order 运行在其上 |
| `demo-mysql` | mysql.instance | demo-order 依赖 |
| `demo-redis` | redis.instance | demo-order 依赖 |
| `demo-prometheus` | observability.metrics | 抓取 demo-order(下游) |

### 异常关联的事件
- **15:09:07 缓存模式变更(warn)**:日志显示 `cache mode changed`,从 `normal` 变为 `bypass`,TTL 仍是 300 秒。原因写的是 `admin api (fault injection)`,trace_id 是 `f7996d9bdd9b2ffbebd6aa9d518cb152`。缓存旁路后,请求会直接打到 MySQL。
- **多次 SIGTERM 退出**:`shutting down` 的 warn 日志出现在 15:00:12、15:04:43、15:05:48(这次对应当前这个容器的启动)。当前容器 15:05:49 启动,`restart_count=0`,`restart_policy=no`。这些看起来是手动重启,Docker 的自动重启计数不会统计手动重启。
- **事件窗口不完整**:Docker 事件缓冲(256 条)已满,只能看到 15:07:19 之后的事件,6 小时窗口内没有事件。更早的重启和退出细节没法靠事件确认,只能靠日志和容器 inspect。

### 各资源现状
- **demo-order 容器**:运行中,没有 OOM,退出码 0,没有健康检查(`health: none`)。资源上限是 0.5 CPU 和 256MiB。当前 CPU 约 1.7%,内存 26.6MB(约 9.9% 的上限),进程数 11。
- **demo-mysql(8.4.11)**:
  - 运行了约 13 分钟(798 秒)。
  - 慢查询累计 141 条,`long_query_time` 是 0.2 秒。慢查询数偏高,与缓存旁路的时间关系还没验证。
  - `Aborted_connects` 是 18,`Aborted_clients` 是 5,都是累计值。
  - 当前没有活跃会话,也没有锁等待。
- **demo-redis(7.4.11)**:
  - 内存 5.92M,上限 64M(约 9%),淘汰策略是 allkeys-lfu。
  - 共 3844 个 key,其中 3023 个带过期时间。
  - 2 个客户端连接,最近一次 bgsave 正常。

### 还不能确认的点
- 慢查询和 Aborted_connects 是在缓存旁路之前就有,还是之后才增加,目前没有证据。这两个值是自启动以来的累计值,不是窗口值。
- 要验证,可以继续看慢日志、语句摘要和 Prometheus 指标(延迟、缓存命中率),也可以看 trace `f7996d9b…`。要不要我接着查?
