# demo/agent-host/runs/B-latency.json

- 工具调用次数：24；workctl 调用：20
- 耗时：58896 ms；宿主报告成本：0.3839908 USD；轮次：26；结束状态：success

## 调用序列

1. `Skill: {"skill":"service-latency-investigation","args":"demo-order"}`
1. `ToolSearch: {"query":"select:mcp__workctl__resource_get,mcp__workctl__service_dependency_list,mcp__workctl__container_workload_get,mcp__workctl__container_event_list,mcp__w`
1. `MCP: resource_get {"id":"demo-order"}`
1. `MCP: service_dependency_list {"service":"demo-order"}`
1. `MCP: container_workload_get {"service":"demo-order"}`
1. `MCP: container_event_list {"service":"demo-order","window":"1h"}`
1. `MCP: observability_metric_list {"resource":"demo-order"}`
1. `MCP: observability_metric_query {"resource":"demo-order","metric":"request_latency","window":"30m"}`
1. `MCP: observability_metric_query {"resource":"demo-order","metric":"error_rate","window":"30m"}`
1. `MCP: observability_metric_query {"resource":"demo-order","metric":"cache_hit_ratio","window":"30m"}`
1. `MCP: observability_metric_query {"resource":"demo-order","metric":"db_query_rate","window":"30m"}`
1. `MCP: observability_log_query {"service":"demo-order","window":"1h","level":"warn","limit":50}`
1. `MCP: observability_log_query {"service":"demo-order","window":"1h","contains":"cache mode changed"}`
1. `MCP: redis_stats_sample {"duration":"10s"}`
1. `MCP: mysql_statement_summary {"sample_window":"10s","top":10}`
1. `MCP: mysql_slowlog_list {"since":"1h","limit":20}`
1. `MCP: container_stats_get {"service":"demo-order"}`
1. `MCP: observability_log_query {"service":"demo-order","window":"3m","level":"info","limit":8}`
1. `MCP: observability_log_query {"service":"demo-order","window":"2m","contains":"/customers/","limit":40}`
1. `ToolSearch: {"query":"select:mcp__workctl__mysql_index_list,mcp__workctl__mysql_query_explain","max_results":5}`
1. `Write: {"file_path":"<host-scratch>","content":"SELECT id, status, amount, created_at FROM`
1. `MCP: mysql_index_list {"database":"demo","table":"orders"}`
1. `MCP: observability_trace_get {"id":"5d648f8033c287a6655a62b14c4b19bc","service":"demo-order","window":"1h"}`
1. `MCP: mysql_query_explain {"database":"demo","sql_file":"<host-scratch>"}`

## 最终回答

# demo-order 变慢排查报告

我只做了查询，没有改动任何东西。观测时间约为 2026-10-17 13:02 UTC，环境是 sandbox。

**结论：** 变慢有两层原因。
- **近因（已确认）：** 13:00:47 缓存被切到 `bypass` 模式，请求全部落到 MySQL。
- **根因（已确认）：** `orders` 表上没有 `customer_id` 索引。每次查"某客户的订单"都要扫描约 30 万行。缓存绕过后，这个问题就暴露出来了。

## 一、已确认的事实

**1. 依赖关系**（来源：绑定文件和 docker-compose 配置）
- demo-order 依赖 demo-mysql 和 demo-redis。
- 容器 running，`restart_count=0`，没有 OOM。
- 最近一次启动是 12:55:48，日志里有 SIGTERM 记录，说明是人为重启。

**2. 现象：p95 延迟和数据库查询速率同时上升**（Prometheus，30 分钟窗口，步长 15 秒）

| 时间 | p95 延迟 | cache_hit_ratio | db_query_rate |
|---|---|---|---|
| 13:00:45 | 0.0049 s | 0.90 | 0.58/s |
| 13:01:15 | 0.39 s | 0.52 | 3.9/s |
| 13:02:15 | 1.36 s | 0 | 约 8/s |
| 13:02:30 | 1.33 s | 0 | 约 8/s |

**3. 变更日志**
- 13:00:47.757 出现 `cache mode changed`：`normal` 变为 `bypass`，原因是 `admin api (fault injection)`。
- 此后所有访问日志都带 `cache_mode: bypass`，指标变化紧跟在这条日志之后。

**4. 慢的集中在一个路由**
- `/orders/:id` 约 1.2–2 ms，没有变慢。
- `/customers/:id/orders` 在 13:02:32–34 这十几秒里大多是 1–2 秒，其余时段在 16 ms–1 s 之间。
- 慢请求的调用链：trace `5d648f80…` 总耗时 1946 ms，其中 `mysql.query` 占 1943 ms（99.8%），`mysql.pool.acquire` 只有 0.045 ms。所以慢在语句本身，不是排队等连接。

**5. MySQL 慢日志和语句统计**
- 慢日志已开启（`long_query_time=0.2s`，`log_output=TABLE`）。
- 最近 20 条全是同一条语句：`SELECT id,status,amount,created_at FROM orders WHERE customer_id=? ORDER BY created_at DESC LIMIT ?`。
  - 每次都扫描 300,000 行，只返回 15 行或 0 行。
  - 耗时 0.37–2.08 秒。
- 10 秒窗口的 digest 差分显示：这条语句执行 16 次，平均 159.7 ms，平均扫描 14.2 万行，占窗口内总耗时的 98.6%（2555 / 2590 ms）。
- 这个窗口里语句数不多（83 条），而且已经处在缓存绕过状态。
- 按主键查询的 `SELECT * FROM orders WHERE id=?` 平均 0.445 ms，正常。

**6. 索引和执行计划**
- `orders` 表只有 `PRIMARY(id)` 和 `idx_created_at(created_at)`，没有 `customer_id` 索引。
- EXPLAIN（估计值，没有执行语句）显示：
  - 走 `idx_created_at` 的倒序全索引扫描，`attached_condition` 是 `customer_id = 1`。
  - 估计 `filtered=10%`，成本约 30,227。
- 累计 I/O：`idx_created_at` 约 4.27 亿次读取。这是启动以来的累计值，不能当窗口值，只能说明长期被大量使用。

**7. Redis**
- 10 秒采样内 hits 和 misses 都是 0，命中率为 null（没有查找，不是 0）。
- 没有淘汰（`evicted_keys=0`）。内存 6.1 MB / 64 MB。
- 命令速率约 0.3/s，基本只有我自己的 INFO 命令。

**8. 排除项**
- 容器 CPU 1.87%（占上限的 3.7%）。
- 内存 29 MB / 256 MB。
- 5xx 错误率在 12:42–12:44 前后有过一波，峰值约 34%，之后为 0。

## 二、待验证的判断

| 判断 | 依据 | 验证方式 |
|---|---|---|
| **A. 恢复缓存后延迟会回落。** | 同一模式 12:35 附近、12:45 之后都出现过：hit_ratio 回到约 0.9 后延迟回落到毫秒级。 | 缓存恢复后再看 `cache_hit_ratio` 和 `request_latency`。这是变更操作，我没有执行。 |
| **B. 加 `(customer_id, created_at)` 复合索引能消除全扫描。** | 缺少 `customer_id` 索引是事实，但效果要看实际数据分布。 | 用 `mysql index plan` 生成方案，评审后在测试环境验证。 |
| **C. 历史上几次延迟尖峰（12:34、12:39、12:41–12:44、12:47–12:50）是同类的缓存失效。** | 同样是 hit_ratio 下降或归零，同时 db_query_rate 上升。 | 当时日志已不可见，只能靠指标推断。 |
| **D. 12:42–12:44 的 5xx 和 p95=10 s 与缓存失效有关。** | 同期 db_query_rate 峰值约 20/s，cache_hit_ratio=0。 | 当时没有日志，无法确认 5xx 的具体原因。 |

关于 C 和 D，"p95=10"只能读作"≥10 秒"，因为超过了最大桶。

## 三、数据缺口

- **Docker 事件**缓冲已满，12:58:53 之前的事件看不到。我不能据此说"没有重启"，只能依据容器 `started_at`（12:55:48）。
- **容器日志**从 12:52:47 重建后才有，更早的缓存模式变更看不到。
- cache_hit_ratio 有 23 个 NaN 点（窗口内没有请求）。
- **error_rate** 只有 55/121 个点，12:51 之后缺失，所以不能说现在 5xx 为 0。
- **EXPLAIN** 是优化器估计。我没有跑 `query analyze`，因为它会执行语句。
- MySQL 慢日志只列了最近 20 条，窗口内更多，所以 20 条只是样本，不是完整统计。

## 四、建议动作

1. **缓解：** 把缓存模式从 `bypass` 恢复为 `normal`。日志显示这次切换来自 admin API 的故障注入，先确认是不是有意为之。
2. **根治：** 为 `orders(customer_id, created_at)` 加复合索引。先用 `mysql index plan` 生成方案，由人工确认后再执行，并写好回退方式（`DROP INDEX`）。

这两步我都没有做，需要你确认后再说。
