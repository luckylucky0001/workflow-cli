# demo/agent-host/runs/D-extend.json

- 工具调用次数：13；workctl 调用：10
- 耗时：31915 ms；宿主报告成本：0.1862371 USD；轮次：14；结束状态：success

## 调用序列

1. `ToolSearch: {"query":"select:mcp__workctl__config_diff,mcp__workctl__config_get,mcp__workctl__resource_list,mcp__workctl__resource_get,mcp__workctl__search_query,mcp__workc`
1. `MCP: config_diff {"service":"demo-order","env":"sandbox","to_rev":"current"}`
1. `MCP: config_get {"service":"demo-order","env":"sandbox"}`
1. `MCP: discovery_list {"service":"demo-order","env":"sandbox"}`
1. `MCP: search_query {"cluster":"demo-search","index":"demo-orders-all","query":"*","max_hits":5}`
1. `MCP: search_cluster_get {"cluster":"demo-search"}`
1. `Bash: mkdir -p <host-scratch> && cat > <host-scratch> <<'`
1. `MCP: config_diff {"service":"demo-order","env":"sandbox","from_rev":30,"to_rev":"current"}`
1. `MCP: search_index_get {"cluster":"demo-search","index":"demo-orders-all"}`
1. `Write: {"file_path":"<host-scratch>","content":"{\"query\": {\"match_all\": {}}, \"size\"`
1. `MCP: search_index_get {"cluster":"demo-search","index":"demo-orders"}`
1. `MCP: search_index_get {"cluster":"demo-search","index":"demo-orders-archive"}`
1. `MCP: search_query {"cluster":"demo-search","index":"demo-orders-all","dsl_file":"<host-scratch>","max_hits":5}`

## 最终回答

两部分都只做了只读查询，没有执行任何变更。

## 1) demo-order(sandbox)的配置变更和注册实例

**配置变更。** 我比较了 etcd 修订 30 和当前修订 41(history 未被压缩,覆盖完整)。当前共 7 个配置项,区间内有 7 项变化:

| 配置项 | 变化 |
|---|---|
| `cache.ttl_seconds` | 300 → **60** |
| `cache.max_entries` | **新增**,值为 10000 |
| `db.pool_size` | 10 → **20** |
| `feature.flags` | `new_checkout` false → true;`rollout_percent` 0 → 20;`async_audit` 不变,仍为 true |
| `upstream.payment` | `timeout_ms` 800 → **1500**;`url` 不变 |
| `db.password` | 已变更(版本 1 → 2)。值被遮蔽,看不到具体内容 |
| `feature.legacy_mode` | **已删除**,原值为 "on" |

- `upstream.payment` 的 `token` 也被遮蔽。
- `cache.mode` 在当前修订里显示为 read-through,版本为 2,最后修改在修订 38。修订 30 时它的值我没有读到,所以没法说它从什么改成了什么。
- 这个 diff 只比较两个时刻的快照,中间改了又改回的值看不到。
- 具体改动的时间点和操作人这次查不到,只有修订号:各键的最后修改修订在 31 到 38 之间。

**注册实例。** 共 3 个,覆盖完整:

| 实例 | 地址 | 版本 | 自报健康 | 租约 |
|---|---|---|---|---|
| order-1 | 10.88.0.11:8080 | 1.4.2 | healthy | 有,剩余约 86290 秒 |
| order-2 | 10.88.0.12:8080 | 1.4.2 | **unhealthy** | 有,剩余约 86290 秒 |
| order-legacy | 10.88.0.9:8080 | 1.3.0 | healthy | **无租约** |

- 健康状态是实例自己上报的,不是我探测的。
- `order-legacy` 注册于 2026-01-05,版本 1.3.0,没有租约。实例下线后这条注册不会自动过期,可能是残留。

## 2) 用别名 demo-orders-all 按 created_at 倒序查最近 5 条

**结果不完整,不能当作"最近 5 条订单"。** 查询状态是 `partial`,3 个分片里有 1 个失败:

- 失败分片属于 `demo-orders-archive`,原因是 `No mapping found for [created_at] in order to sort on`。
- 别名 `demo-orders-all` 同时指向两个索引:`demo-orders`(3000 条,有 `created_at`)和 `demo-orders-archive`(400 条)。
- archive 索引的映射里根本没有 `created_at` 字段,而且 `amount` 的类型是 keyword,和 `demo-orders` 的 double 不一致。
- 所以排序时 archive 整个被丢掉。返回的 total 是 3000,不是别名下的 3400。

**拿到的 5 条** 全部来自 `demo-orders`,都是 2026-10-15 的订单:

| order_id | created_at(UTC) |
|---|---|
| ORD-001499 | 10-15 23:47:39 |
| ORD-000581 | 10-15 22:52:10 |
| ORD-001028 | 10-15 22:40:37 |
| ORD-002514 | 10-15 22:37:08 |
| ORD-002733 | 10-15 22:36:00 |

这 5 条只是 `demo-orders` 内部按时间排序的最近 5 条,archive 里的 400 条完全没参与。

- 不带排序时,同一个别名查到 3400 条、3 个分片全部成功。所以问题出在排序,不是别名或分片本身。
- 另外,集群状态是 yellow:archive 有 1 个副本分片未分配(原因 `INDEX_CREATED`)。它的副本数是 1,而这是单节点集群。这只影响冗余,和这次不完整无关,主分片都可用。

**建议:** 要拿到可信的最近订单,可以直接查 `demo-orders`(或别名 `demo-orders-current`)。如果确实需要把 archive 一起排序,需要先处理两个索引的映射不一致,这属于变更,我没有动。
