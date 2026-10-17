# demo/agent-host/runs/B-latency.final.json

- 工具调用次数：19；workctl 调用：16
- 耗时：51998 ms；宿主报告成本：0.2702462 USD；轮次：21；结束状态：success

## 调用序列

1. `Skill: {"skill":"service-latency-investigation"}`
1. `ToolSearch: {"query":"select:mcp__workctl__resource_get,mcp__workctl__service_dependency_list,mcp__workctl__container_workload_get,mcp__workctl__container_event_list,mcp__w`
1. `MCP: resource_get {"id":"demo-order"}`
1. `MCP: service_dependency_list {"service":"demo-order"}`
1. `MCP: container_workload_get {"service":"demo-order"}`
1. `MCP: container_event_list {"service":"demo-order","window":"1h"}`
1. `MCP: observability_metric_query {"resource":"demo-order","metric":"request_latency","window":"30m"}`
1. `MCP: observability_metric_query {"resource":"demo-order","metric":"cache_hit_ratio","window":"30m"}`
1. `MCP: observability_metric_query {"resource":"demo-order","metric":"db_query_rate","window":"30m"}`
1. `MCP: observability_metric_query {"resource":"demo-order","metric":"error_rate","window":"30m"}`
1. `MCP: observability_log_query {"service":"demo-order","window":"1h","contains":"cache mode changed"}`
1. `MCP: observability_log_query {"service":"demo-order","window":"15m","level":"warn","limit":20}`
1. `MCP: redis_stats_sample {"duration":"10s"}`
1. `MCP: redis_slowlog_list {"limit":10}`
1. `MCP: mysql_statement_summary {"sample_window":"10s","top":5}`
1. `MCP: mysql_slowlog_list {"since":"1h","limit":10}`
1. `ToolSearch: {"query":"select:mcp__workctl__mysql_index_list,mcp__workctl__mysql_query_explain","max_results":5}`
1. `MCP: mysql_index_list {"database":"demo","table":"orders"}`
1. `MCP: mysql_query_explain {"database":"demo","sql":"SELECT id, status, amount, created_at FROM orders WHERE customer_id = 1 ORDER BY created_at DESC LIMIT 15"}`

## 最终回答

排查已完成，全程只用了查询类能力，没有执行任何变更。

**结论：** demo-order 变慢的直接原因是缓存被切到 bypass 模式，请求全部落到 MySQL。落到 MySQL 后，`orders` 表上的一条查询因缺少合适索引而扫描约 30 万行，每次耗时几百毫秒。Redis 本身没有发现异常。

## 已确认的事实

**1. 延迟、缓存、数据库的变化在时间上一致（Prometheus，窗口 30 分钟，步长 15 秒）**

| 时间 (UTC) | p95 延迟 | 缓存命中率 | 数据库查询速率 |
|---|---|---|---|
| 15:09:00 | 0.005s | 0.96 | 0.22/s |
| 15:09:30 | 0.41s | 0.57 | 3.5/s |
| 15:10:15 | 0.78s | 0 | 8.0/s |
| 15:10:30 | 1.125s | 0 | 8.0/s |

- 正常时 p95 约 5ms，命中率约 0.9。
- 15:07 到 15:08 命中率为 1，同一时段查询速率为 0，说明那几分钟请求量很小。
- `error_rate` 返回 `no samples in window`。这表示没有 5xx 样本，不能当作错误率为 0。

**2. 变更记录（应用日志）**
- 15:09:07.129 有一条 warn 日志：`cache mode changed`，从 `normal` 变为 `bypass`，`reason: "admin api (fault injection)"`。
- 命中率从 15:09:15 开始下滑，晚于这条日志约 8 秒。
- 命中率是 1 分钟速率，所以下降是渐进的，这符合预期。

**3. Redis 没有问题**
- 10 秒采样窗口内 `keyspace_hits` 和 `keyspace_misses` 都是 0，应用几乎没有去查 Redis。命中率在这里是未定义，不是 0。
- 淘汰、过期、拒绝连接均为 0。内存用了 6MB，上限 64MB。
- 慢日志只有 4 条，最晚一条在 14:59，都在故障之前。

**4. MySQL 有一条慢语句**
- 10 秒采样窗口内，`SELECT id,status,amount,created_at FROM orders WHERE customer_id=? ORDER BY created_at DESC LIMIT ?` 执行了 25 次。
- 平均耗时 819ms，平均每次扫描 26.6 万行，返回约 13 行。
- 慢日志最近 10 条全是这条语句，耗时 347 到 757ms，每条都扫描 300000 行。慢日志已开启，阈值 0.2 秒，所以这不是"未采集"。
- `orders` 只有 `PRIMARY` 和 `idx_created_at` 两个索引，`customer_id` 上没有索引。
- EXPLAIN 显示走 `idx_created_at` 倒序扫描，再用 `customer_id` 做条件过滤。优化器估计的 15 行明显偏乐观，实测每次扫 30 万行。
- 摘要里 `no_index_used_count` 为 0，是因为它走了 `created_at` 索引。实际上这是扫整个索引并过滤，不是用索引定位。

**5. 依赖关系**
- demo-order 依赖 demo-mysql 和 demo-redis，来源是 docker-compose 配置里的 `MYSQL_HOST` 和 `REDIS_URL`，不是按名称推断。

## 待验证的判断

- **缓存关闭是本次变慢的唯一原因。**
  - 时间线一致，且日志里有变更记录，可信度高。
  - 但我没有取单个慢请求的调用链，所以没有直接看到请求内部的耗时分布。
  - 验证方法：用 `trace get` 看一个慢请求里是否有 `mysql.query` 耗时高、缺少 `redis.get`。
- **日志里写的是"fault injection"，这可能是一次人为注入的演练，而不是真实故障。** 这需要你来确认。
- **给 `customer_id` 加索引（如 `(customer_id, created_at)`）能消除这条慢查询。** 这只是推断，需要先做变更计划评审，再用 EXPLAIN 对比验证。
- **缓存恢复后，这条慢查询只是被缓存掩盖，并没有消失。** 缓存键过期或未命中时仍会出现，只是频率低很多。

## 缺口

- 容器事件缓冲已满，15:07:45 之前的事件看不到。
- 日志里有三次 SIGTERM（15:00:12、15:04:43、15:05:48），当前容器 15:05:49 启动。更早的 p95 尖峰（约 0.36 到 0.40 秒，出现在 15:00:15、15:01:45、15:03:45）发生在这些重启附近，我没有进一步查它们的原因。
- 没有查容器 CPU 和内存快照（`container_stats_get`），所以没有排除资源受限。容器上限是 0.5 核、256MB。
- 请求级日志我只查了 warn 及以上和 `cache mode changed`，没有逐条查看请求日志。

## 建议下一步（均不改动环境）

1. 向变更方确认 15:09:07 的 bypass 是不是预期操作。如果不是，需要走计划、人工确认的流程把缓存模式恢复为 normal。
2. 取一个 15:10 之后的慢请求 trace，验证上面第一条判断。
3. 对 `orders` 生成加索引的变更计划（`mysql_index_plan`），评审后再决定是否执行。
