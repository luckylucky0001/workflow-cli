# /home/user/workflow-cli/demo/agent-host/runs/A-infra.cli-only.json

- 工具调用次数：24；workctl 调用：23
- 耗时：46833 ms；宿主报告成本：0.3608571 USD；轮次：25；结束状态：success

## 调用序列

1. `Bash: workctl --help`
1. `Bash: workctl service --help; workctl resource --help; workctl container --help`
1. `Bash: workctl resource list --help; workctl service dependency --help; workctl container workload --help; workctl container event --help; workctl container stats --help`
1. `Bash: for c in "resource list --service demo-order --env sandbox" "service dependency list --service demo-order --env sandbox" "container workload get --service demo-order --env sandbox" "container event li`
1. `Bash: workctl --json resource list --service demo-order --env sandbox 2>&1`
1. `Bash: workctl --json service dependency list --service demo-order --env sandbox 2>&1`
1. `Bash: workctl --json container workload get --service demo-order --env sandbox 2>&1`
1. `Bash: workctl --json container event list --service demo-order --env sandbox 2>&1`
1. `Bash: workctl --json container stats get --service demo-order --env sandbox 2>&1`
1. `Bash: workctl log --help; workctl metric --help; workctl mysql --help; workctl redis --help`
1. `Bash: workctl log query --help; workctl metric list --help; workctl mysql instance --help; workctl redis instance --help`
1. `Bash: workctl --json log query --service demo-order --env sandbox --window 1h --level warn --limit 50 2>&1`
1. `Bash: workctl --json mysql instance get --help 2>&1 | head -20; workctl --json redis instance get --help 2>&1 | head -20`
1. `Bash: workctl --json mysql instance get --instance demo-mysql 2>&1 | head -120`
1. `Bash: workctl --json redis instance get --instance demo-redis 2>&1 | head -120`
1. `Bash: workctl --json metric list --resource demo-order 2>&1 | head -60`
1. `Bash: workctl metric query --help | sed -n 1,25p; workctl mysql slowlog --help | sed -n 1,20p`
1. `Bash: for m in request_latency error_rate cache_hit_ratio db_query_rate; do echo "== $m"; workctl --json metric query --resource demo-order --metric $m --window 30m --step 60s 2>&1 | python3 -c "import sys,`
1. `Bash: workctl --json mysql slowlog list --help 2>&1 | sed -n 1,16p`
1. `Bash: workctl --json metric query --resource demo-order --metric request_latency --window 30m --step 60s 2>&1 | head -c 2500`
1. `Bash: workctl --json metric query --resource demo-order --metric cache_hit_ratio --window 30m --step 60s 2>&1 | head -c 2500`
1. `Bash: workctl --json metric query --resource demo-order --metric error_rate --window 30m --step 60s 2>&1 | head -c 2500`
1. `Bash: workctl --json metric query --resource demo-order --metric db_query_rate --window 30m --step 60s 2>&1 | head -c 2500`
1. `Bash: workctl --json mysql slowlog list --instance demo-mysql --since 30m --limit 5 2>&1 | head -c 3500`

## 最终回答

以下是 demo-order(sandbox)的只读排查结果,全程没有执行任何变更。

## 结论
当前异常的直接原因是**缓存被人为切到 bypass 模式,请求全部穿透到 MySQL,而 MySQL 的 `orders` 表查询是全表扫描。** 容器本身没有问题。

## 运行资源与依赖
| 资源 | 类型 | 状态 |
|---|---|---|
| demo-order(`0dd91c2d29da`,端口 18081) | service/容器 | running,重启 0 次,无 OOM,CPU 约 1%(占上限 2.2%),内存 29MB / 256MB(11%),pids 11 |
| demo-mysql(8.4.11) | mysql.instance | 正常,`Slow_queries` 累计 1783,`Threads_running` 3 |
| demo-redis(7.4.11) | redis.instance | 正常,standalone,内存 5.8MB / 64MB,3806 个 key |
| demo-prometheus | 依赖 demo-order 的下游(抓取其指标) | — |

demo-order 依赖 demo-mysql 和 demo-redis,依据是 docker-compose 里的环境变量。

## 异常关联的事件
应用日志里有这几条 warn/error:
- **13:00:47** `cache mode changed`:normal → **bypass**,原因是 `admin api (fault injection)`。
- **13:04:02** 切回 normal,原因同上。
- **13:05:33** 再次切到 **bypass**,原因同上。**目前缓存很可能仍处于 bypass。**
- **12:55:48** 容器收到 SIGTERM 并关闭,随后重新启动,`started_at` 为 12:55:48。
- **12:52:51** `redis connection error: getaddrinfo ENOTFOUND redis`。这发生在 Redis 刚启动时(Redis 12:52:51 启动),当时只是短暂解析失败。Redis 现在连接正常。

## 指标与慢查询
- MySQL 慢日志在 13:07 仍在持续出现同一条 SQL:`SELECT … FROM orders WHERE customer_id = ? ORDER BY created_at DESC LIMIT ?`。每次扫描 **300,000 行**,耗时 400–750ms,而 `long_query_time` 是 0.2 秒。这很像 `customer_id` 上缺索引。
- `db_query_rate` 在 13:02–13:03 升到约 8 req/s,时间上与缓存 bypass 吻合。
- 更早的 12:40–12:44 出现过明显的延迟尖峰,p95 达到 10 秒,5xx 最高 33.8%,缓存命中率降到 0。这些发生在上述容器重启之前。
- 我只看到延迟和缓存命中率前半段的数据,没有读完 13:00 之后的点,所以 bypass 期间的延迟没有确认。
- `error_rate` 只有 12:37–12:50 的样本,之后没有数据。

## 需要注意
- `container event list` 因 Docker 事件缓冲已满,只能看到 13:03:07 之后的事件,当前窗口内没有事件。更早的重启历史以容器 inspect 和应用日志为准。
- 日志里没有说明是谁、通过什么触发了"fault injection"。看起来是有人在通过 admin api 注入故障。如果这是演练,当前状态就是预期的。如果不是,需要找出调用方。

## 下一步建议
如果要继续,我可以只读地查 `orders` 表结构和索引(`mysql table get` / `index`)、执行计划(`explain`),以及 13:00 之后的完整延迟曲线,确认 customer_id 缺索引。修复动作(切回缓存、加索引)属于变更,需要你确认后再说。
