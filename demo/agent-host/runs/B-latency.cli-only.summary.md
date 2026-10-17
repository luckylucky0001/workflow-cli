# /home/user/workflow-cli/demo/agent-host/runs/B-latency.cli-only.json

- 工具调用次数：10；workctl 调用：9
- 耗时：69431 ms；宿主报告成本：0.21206380000000002 USD；轮次：11；结束状态：success

## 调用序列

1. `Bash: workctl --help`
1. `Bash: workctl service --help; workctl resource --help; workctl log --help; workctl redis --help; workctl mysql --help`
1. `Bash: workctl resource list --service demo-order; workctl log query --help; workctl redis instance --help; workctl mysql instance --help; workctl redis stats --help; workctl redis slowlog --help; workctl my`
1. `Bash: for c in "redis instance get --help" "redis stats sample --help" "redis slowlog list --help" "mysql instance get --help" "mysql slowlog list --help" "mysql statement summary --help" "mysql session --h`
1. `Bash: workctl redis instance get --help; workctl redis stats sample --help; workctl redis slowlog list --help; workctl mysql instance get --help; workctl mysql slowlog list --help; workctl mysql statement s`
1. `Bash: workctl redis instance get --instance demo-redis; echo ----; workctl redis stats sample --instance demo-redis --duration 10s; echo ----; workctl redis slowlog list --instance demo-redis --limit 10; ec`
1. `Bash: cd /tmp; workctl --json log query --service demo-order --window 30m --level info --limit 2000 > /tmp/claude-0/-tmp-tmp-46019j1ZT4/45bac8d8-3b18-5f38-993e-83a45105273d/scratchpad/info.json; python3 -I `
1. `Bash: workctl --json log query --service demo-order --window 30m --level info --limit 3`
1. `Bash: workctl --json log query --service demo-order --window 30m --level info --limit 2000 | python3 -I -c "`
1. `Bash: workctl log query --service demo-order --window 30m --contains customer --limit 6 --order newest; workctl log query --service demo-order --window 30m --contains '"cache_mode":"normal"' --limit 4 --ord`

## 最终回答

**结论：** 慢的是 `GET /customers/:id/orders`，原因很可能是它背后的 MySQL 查询没有可用的索引。Redis 本身是健康的，但 demo-order 当前处于缓存旁路（bypass）模式，不走 Redis。以上全部是只读查询。

## 已确认的事实

**MySQL（demo-mysql）**
- 慢日志里全是同一条语句：`SELECT id,status,amount,created_at FROM orders WHERE customer_id=? ORDER BY created_at DESC LIMIT ?`。最近 20 条每条都扫描 300000 行，只返回约 15 行，耗时约 260–930ms。
- 10 秒采样窗口内，这条语句执行 23 次，平均 288ms，总耗时 6619ms，占窗口内全部语句耗时的约 99%，平均每次检查 21.4 万行。
- 另一条 `SELECT * FROM orders WHERE id=?` 平均只有 0.83ms，说明主键查询正常。
- 实例累计 `Slow_queries`=1870，而 `Questions`=10089，慢查询占比很高。`long_query_time` 是 0.2s。
- 连接数（10/200）和运行线程数（2）都不高，锁等待约 0.003ms。所以不是连接或锁的问题。

**请求日志（demo-order）**
- `/customers/:id/orders` 的响应时间分两档：有的约 20–26ms，有的约 470–645ms（我看到的 6 条样本：610、645、24、20、26、473ms）。
- `/orders/:id` 只有约 1–4ms。
- 日志里的 `cache_mode` 记录了缓存模式的切换：
  - 13:00:47 从 normal 切到 bypass；
  - 13:04:02 切回 normal；
  - 13:05:33 又切到 bypass，此后一直是 bypass。
- 三次切换的 `reason` 都是 `admin api (fault injection)`，也就是通过管理接口手动改的。
- 12:55:48 有一次 SIGTERM 重启，12:52:51 有一条 Redis 解析失败的报错（`ENOTFOUND redis`）。这两条都早于当前问题，之后没有再出现。

**Redis（demo-redis）**
- 内存用了 9%，淘汰数是 0，没有拒绝连接，慢日志为空（阈值 1ms）。
- 10 秒采样内只有 3 条命令，键查找（命中加未命中）为 0，所以命中率无法计算。
- 运行 889 秒，当前服务正常。

## 待验证的判断

1. **根因是 `orders.customer_id` 缺少合适的索引（如 `(customer_id, created_at)`）。**
   - 依据：每次扫描 30 万行，只返回约 15 行。
   - 摘要里 `no_index_used_count` 是 0，所以更像是"用了索引但选择性很差"，而不是完全没有索引。
   - 我没有查表结构和执行计划，需要先看 `mysql table get`、`mysql index` 和 explain 才能确认。
2. **缓存旁路让这个问题暴露出来。** 13:05:33 前后，同一路由的耗时有 normal 和 bypass 两种记录，样本里 normal 下也出现过 316ms，说明缓存只是部分缓解。正常模式下的命中率和 Redis 命中的比例，我没有足够数据对比。
3. **"最近变慢"的起点时间不确定。** MySQL 里这条语句最早出现在 12:34，比服务重启还早。日志轮转和容器重建会截断更早的数据，我无法对比"变慢之前"的基线。
4. **分档的原因。** 同一路由里快的请求（约 20ms）和慢的请求（约 500ms）可能是 customer_id 对应的行数差异，也可能是别的因素，我没有验证。
5. **没有统计分位数。** 我想对 4800 多条请求日志做汇总统计，但运行脚本需要审批，没有执行。上面的耗时只是抽样值，不是整体 p95。

## 建议的下一步（需要你决定，我不会自动执行）

- 只读验证：查 `orders` 的索引和执行计划，确认判断 1。
- 确认 bypass 是不是有人有意开启的，需要的话由有权限的人改回 normal。
- 加索引属于变更，应先走 `mysql index` 的变更计划，再由负责人审批。
