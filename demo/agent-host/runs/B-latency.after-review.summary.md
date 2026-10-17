# demo/agent-host/runs/B-latency.after-review.json

- 工具调用次数：19；workctl 调用：16
- 耗时：49147 ms；宿主报告成本：0.2711442 USD；轮次：21；结束状态：success

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
1. `MCP: observability_log_query {"service":"demo-order","window":"1h","level":"warn"}`
1. `MCP: redis_stats_sample {"duration":"10s"}`
1. `MCP: redis_info_get {"section":"memory"}`
1. `MCP: mysql_statement_summary {"sample_window":"10s","top":5}`
1. `MCP: mysql_slowlog_list {"since":"30m","limit":10}`
1. `MCP: observability_log_query {"service":"demo-order","window":"2m","limit":8}`
1. `MCP: observability_trace_get {"id":"f462da1761cd6f29bc15f5ff7b29cee4","window":"1h"}`
1. `ToolSearch: {"query":"select:mcp__workctl__mysql_query_explain,mcp__workctl__mysql_index_list","max_results":2}`
1. `MCP: mysql_query_explain {"database":"demo","sql":"SELECT id, status, amount, created_at FROM orders WHERE customer_id = 171 ORDER BY created_at DESC LIMIT 20"}`
1. `MCP: mysql_index_list {"database":"demo","table":"orders"}`

## 最终回答

# demo-order 变慢：排查结论

全程只做了查询，没有改动任何东西。时间均为 UTC，观测时刻约 13:22。

**一句话结论：** 变慢从 13:21:09 开始，起因是 demo-order 的缓存模式被改成了 `bypass`（应用不再查 Redis）。请求因此全部落到 MySQL，`/customers/:id/orders` 这条 SQL 又缺少 `customer_id` 索引，每次要扫约 30 万行。

## 已确认的事实

**1. 依赖关系**（来源：`bindings.yaml` 与 docker-compose 配置）
- demo-order 依赖 `demo-mysql` 和 `demo-redis`。
- 容器是 running，`restart_count=0`，没有 OOM。
- 容器 `started_at` 是 13:18:42，比变慢早 2.5 分钟，所以变慢不是刚启动造成的。

**2. 现象**（Prometheus，30 分钟窗口）

| 时间 | p95 延迟 | 缓存命中率 | 数据库查询速率 |
|---|---|---|---|
| 13:21:15 及之前 | ≈5ms | ≈0.89 | 0.65/s |
| 13:21:30 | 0.35s | 0.61 | 2.8/s |
| 13:22:15 | 0.50s | 0 | 8.0/s |
| 13:22:30 | 0.72s | 0 | 7.9/s |

- 命中率归零、数据库查询速率约升到 12 倍，与延迟上升同时发生。

**3. 变更日志**（`level=warn`）
- 13:21:09.887 出现 `cache mode changed`：`normal → bypass`，TTL 不变（300 秒），`reason: "admin api (fault injection)"`。
- 之后每条访问日志都带 `cache_mode: "bypass"`。
- 这个时间点正好在指标拐点（13:21:15 到 13:21:30）之前。

**4. 慢的是哪个接口**
- `/orders/:id` 约 1.2–1.5ms，不受影响。
- `/customers/:id/orders` 约 260–700ms。
- 例如 trace `f462da17…` 总耗时 558ms，其中 `mysql.query` 占 99.8%（557ms），`mysql.pool.acquire` 仅 0.05ms。所以不是连接池排队，是语句本身慢。

**5. MySQL**（`demo-mysql`，8.4.11）
- 慢日志已开启（阈值 0.2s），最近 10 条全是同一条 SQL：`SELECT … FROM orders WHERE customer_id=? ORDER BY created_at DESC LIMIT ?`。每条查询耗时 258–706ms，`rows_examined=300000`。
- 10 秒窗口的语句摘要里，这条 SQL 执行了 23 次，平均 308ms，平均每次检查 20.2 万行，只返回 325 行。
- `orders` 表只有 `PRIMARY` 和 `idx_created_at` 两个索引，没有 `customer_id` 索引。
- EXPLAIN 显示它走 `idx_created_at` 倒序扫描，再用 `customer_id=171` 过滤，估计成本 30227。
- 因为用了索引，摘要里的 `no_index_used_count` 是 0。但这是在扫整个索引，不是靠 `customer_id` 定位。

**6. Redis**（`demo-redis`，7.4.11）
- 10 秒采样窗口内 `keyspace_hits` 和 `misses` 都是 0，所以命中率是 null（不是 0）。
- 窗口内没有淘汰（`evicted_keys=0`），只有少量正常过期（`expired_keys=5`）。
- 内存 5.8MB，上限 64MB，策略 `allkeys-lfu`，没有内存压力。
- Redis 在这个窗口内几乎没收到业务读请求。

**7. 排除项**
- 没有重启、OOM、健康检查失败的迹象。
- Redis 没有淘汰，也没有内存压力。

## 待验证的判断

| 判断 | 依据 | 验证方式 |
|---|---|---|
| 变慢的根因是缓存绕过，这是一次人为注入的故障 | 时间吻合，日志自带 `fault injection`；但谁改的、是否有意，日志里没有 | 查 admin API 的调用记录；把模式改回 `normal` 后观察指标是否恢复（这是变更，需要你确认） |
| 给 `orders(customer_id, created_at)` 建联合索引可以消除这条慢 SQL | 当前缺少 `customer_id` 索引，EXPLAIN 是扫索引过滤 | 先用 `mysql index plan` 生成方案并评审；上线后再次 EXPLAIN 和做语句摘要对比 |
| 缓存正常时这条 SQL 已经存在，只是被缓存掩盖 | 13:14 起摘要里就有这条 SQL，缓存正常时命中率约 0.9、查询速率不到 0.7/s | 缓存恢复后看这条 SQL 的执行频率是否降回去 |
| Redis 本身没有问题，只是没被使用 | 只有 10 秒采样，窗口内无查找 | 查 `cache_requests_total` 按 `result` 拆分，看 `bypass` 是否占满 |

## 数据缺口
- **容器事件**：Docker 事件缓冲已满，只能看到 13:18:59 之后的事件。更早是否有重启，只能从 `started_at` 和 `warn` 日志推断。
- **重启记录**：日志里 13:15:54 和 13:18:42 各有一次 SIGTERM `shutting down`，对应的重启原因这次没有查。
- **指标断档**：15 秒步长应有 121 个点，实际只有 25–27 个。13:16–13:17 和 13:19–13:20 之间有空档，对应这两次重启期间的抓取缺失。
- **慢日志**：只取了最近 10 条，窗口内更多。
- **EXPLAIN**：是优化器估计，不是实际执行耗时。
- **Redis 采样**：只有 10 秒，不能代表之前 30 分钟。

## 建议（均需你确认后再做）
1. 先确认是谁、为什么把缓存模式改成 `bypass`。如果不是有意的，改回 `normal`。这是写操作，我没有执行。
2. 缓存恢复之后，给 `orders` 加 `(customer_id, created_at)` 联合索引，避免缓存失效时再次打到全表扫描。我可以用 `mysql index plan` 生成变更计划，只生成计划，不执行。回退方式是删除该索引。
