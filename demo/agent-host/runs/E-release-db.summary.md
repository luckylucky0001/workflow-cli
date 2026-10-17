# demo/agent-host/runs/E-release-db.json

- 工具调用次数：13；workctl 调用：9
- 耗时：54148 ms；宿主报告成本：0.34922349999999996 USD；轮次：16；结束状态：success

## 调用序列

1. `ToolSearch: {"query":"select:mcp__workctl__deploy_release_list,mcp__workctl__deploy_release_get,mcp__workctl__deploy_status_get,mcp__workctl__deploy_rollback_plan,mcp__work`
1. `Skill: {"skill":"deploy-operations"}`
1. `Skill: {"skill":"postgres-operations"}`
1. `MCP: deploy_release_list {"service":"demo-order","env":"sandbox","limit":10}`
1. `MCP: deploy_status_get {"service":"demo-order","env":"sandbox"}`
1. `MCP: postgres_instance_get {"instance":"demo-postgres"}`
1. `MCP: postgres_statement_summary {"instance":"demo-postgres","sample_window":"20s","top":10,"order_by":"total_time"}`
1. `MCP: postgres_statement_summary {"instance":"demo-postgres","sample_window":"0","top":10,"order_by":"total_time"}`
1. `MCP: deploy_release_get {"service":"demo-order","env":"sandbox","id":"3","tail":40}`
1. `MCP: deploy_rollback_plan {"service":"demo-order","env":"sandbox"}`
1. `MCP: postgres_query_explain {"instance":"demo-postgres","database":"demo_orders","sql":"SELECT id, status, amount, created_at FROM orders WHERE customer_id = 42 ORDER BY created_at DESC LIMIT 20"}`
1. `ToolSearch: {"query":"select:mcp__workctl__postgres_table_get","max_results":1}`
1. `MCP: postgres_table_get {"instance":"demo-postgres","database":"demo_orders","table":"orders"}`

## 最终回答

以下全部是只读查询,没有执行任何变更。

## 一、demo-order(sandbox)发布情况

最近有发布。部署走 Jenkins job `deploy-demo-order`,构建时间是 Jenkins 记录的(explicit),保留了 5 个构建:

| 构建 | 版本 | 开始时间(UTC) | 结果 |
|---|---|---|---|
| #1 | v1.4.0 | 16:56:08 | 成功 |
| #2 | v1.4.1 | 16:56:18 | 成功 |
| **#3** | **v1.4.2-bad** | 16:56:28 | **失败** |
| #4 | v1.4.1 | 16:56:38 | 成功 |
| #5 | v1.4.0 | 16:59:53 | 成功(当前) |

- **最近一次发布(#5)成功**,没有进行中或排队的部署。
- **失败的是 #3,版本 v1.4.2-bad。** 控制台日志写着 `health check failed after rollout of v1.4.2-bad`,即发布后健康检查失败,随后构建被标为 FAILURE。日志里没有更深的根因,比如健康检查具体哪项没过。要查根因,得看该版本服务本身的日志。
- #4 重新发布 v1.4.1,#5 又发布了 v1.4.0,都由 admin 手动触发。从版本序列看,这像是 v1.4.2-bad 失败后做的手动回退。这是我从序列推断的,变更单里没有直接说明。
- 当前版本 v1.4.0 来自"最近一次成功的构建"。Jenkins 不观测实际运行的版本,所以它是不是真的在跑,需要用 `container workload get` 核对镜像,我没做这一步。
- 回滚计划的依赖里有 demo-mysql、demo-redis,被 demo-prometheus 抓取。

## 二、回滚计划(仅计划,未执行)

计划 ID:`op-20261017-24931f`,30 分钟后过期(17:36:30)。

- **内容:**回滚到构建 #4,即 v1.4.0 → v1.4.1。执行方式是用 #4 的参数(`SERVICE=demo-order&VERSION=v1.4.1&ENV=sandbox`)重新触发部署 job,会产生新的构建号。
- **前置条件:**目标仍保留、目标构建成功、目标与当前版本不同、没有进行中的部署、参数可原样重放,这五项都满足。**`profile_allow_execute` 不满足**,当前 profile 未开启 allow_execute,所以这个计划现在不能执行。
- **步骤:**
  1. 执行前复核当前构建仍是 #5;
  2. 触发 job;
  3. 轮询到构建结束,最多 300 秒。
- **执行后:**job 成功不等于服务健康,需要再核对容器镜像和指标。
- **回退方式:**再生成 `--to 5` 的计划,重新部署 v1.4.0。
- 回滚只回滚部署版本,配置和数据库结构不会跟着回滚。
- 把 v1.4.0 回滚到 v1.4.1 是否合理,请先确认。v1.4.1 在 #2 和 #4 都部署成功,但目前没有证据表明 v1.4.0 有问题。

## 三、demo-postgres 最耗时语句

实例是 PostgreSQL 16.15 主库,库名 demo_orders,`pg_stat_statements` 正常采集。

**最耗时的语句**(20 秒窗口,两次快照做差):
```sql
SELECT id, status, amount, created_at FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT $2
```
- 20 秒内 7362 次调用,总耗时 23.7 秒(是窗口时长的 1.2 倍,说明并发执行)。
- 占窗口内全部语句总耗时(24.2 秒)的约 98%。
- 平均 3.2 ms,每次只返回 20 行,但每次约读 568 个缓冲块,全部命中缓存。
- 累计值(自 16:57:07 统计重置起)是同一个结论:5697 次调用,总计 18.1 秒,单次最长 23 ms。

**为什么慢(缺索引):**
- `orders` 表约 5 万行,`customer_id` 上没有索引。表注释也写明了 "customer_id intentionally not indexed",这是 demo 的故意设计。现有索引只有 `orders_pkey(id)` 和 `orders_created_at_idx(created_at)`。
- EXPLAIN 的估计计划是对 orders 做 Seq Scan(过滤 `customer_id = 42`),再 Sort、Limit。
- 表的累计统计佐证:`seq_scan` 15315 次,读取 7.66 亿行,远大于 `idx_scan` 的 14561 次。
- 次要的一条是 `SELECT count(*) ... WHERE customer_id = $1`,同样缺索引,累计 816 次、1.9 秒。
- 另一个次要现象:这张表自统计重置后没有做过 vacuum 和 analyze,有 5000 行死元组、`n_mod_since_analyze` 为 5000。这来自一次整表更新(`UPDATE ... WHERE id % ... = ...`)。这会让优化器统计信息失真,但不是当前慢的主因。

**怎么验证**(都是建议,我没有执行):
1. 先用 `pg query analyze` 看实际执行。它会真实执行 SELECT,不过是在只读事务里,结束后回滚,需要你同意在该实例上跑。看 Seq Scan 的 `rows_removed_by_filter` 是否远大于 `actual_rows`。
2. 把下面的建议索引交给 DBA 评审,最好先在非生产的副本上建:
   ```sql
   CREATE INDEX CONCURRENTLY orders_customer_id_created_at_idx ON orders (customer_id, created_at DESC);
   ```
   这个复合索引能同时覆盖过滤和排序,也让 `count(*)` 那条查询受益。workctl 不会执行这条 DDL。
3. 建好后重做 `pg query explain`,确认变成 Index Scan 且没有 Sort 节点。再做一次 20 秒窗口的 `pg statement summary`,对比 `mean_exec_ms` 和总耗时占比。
4. 另外让 DBA 评估对 `orders` 做一次 ANALYZE。

## 需要说明的限制
- 角色 `workctl_ro` 看不到 `shared_preload_libraries`,所以实例信息的覆盖不完整。但 pg_stat_statements 实际可用,语句文本也可见,不影响上面的结论。
- 发布时间线只包含保留范围内的构建。Jenkins 当前只保留最近 20 个,本次只看到 5 个,看起来是完整的,更早的发布不可见。
