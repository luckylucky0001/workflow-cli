# Redis 能力指南

本指南覆盖 `redis` 领域的 8 个命令（适配器 `redis-client`/ioredis，认证 `redis-profile`）。结果信封与错误码见 `docs/design-principles.md`；Agent 使用流程见 `skills/redis-operations/SKILL.md`。

> 已在隔离 Demo 环境验证：**Redis 7.4.11**（`redis:7.4` 镜像，standalone，`maxmemory 64mb`，`maxmemory-policy allkeys-lfu`，`slowlog-log-slower-than 1000`，`slowlog-max-len 256`，无口令）。Redis 6.x 预期可用（ACL WHOAMI 需要 6.0+；`INFO` 多分区参数需要 7.0+，更低版本自动回退为 `INFO all`）；集群模式、Sentinel、托管 Redis 未验证。

## 对象模型

```
profile.endpoints.redis.<instance>（host/port、可选 username/password_ref/db/tls）
   ├─ 资源绑定 forEndpoint ──▶ redis.instance 资源（平台元数据）
   └─ 引擎实时查询
        ├─ INFO 各分区（累计计数器 / 瞬时值 / 静态值）
        ├─ SLOWLOG（环形缓冲，只含执行时间）
        └─ 键空间 db<N>：SCAN 采样 → TYPE / MEMORY USAGE / OBJECT FREQ / 单键检查
```

## 命令

| 命令 | 操作 | 来源 | 语义要点 |
|---|---|---|---|
| `redis instance get` | read | `INFO server replication persistence clients memory keyspace` + 资源绑定 | 版本、角色、连接、内存与 `usage_ratio`（maxmemory=0 时为 null）、淘汰策略、RDB/AOF 状态、run_id |
| `redis info get --section <s>` | read | `INFO <s>` | 原样解析；`semantics` 逐项标注 `cumulative_since_start` / `gauge` / `instantaneous_estimate` / `static` / `timestamp` |
| `redis stats sample --duration 10s` | diagnose | 同一连接两次 `INFO server stats memory clients` | 窗口增量、每秒速率、`hit_ratio`；处理重启与计数器重置 |
| `redis slowlog list [--limit 10]` | read | `SLOWLOG GET/LEN`、`CONFIG GET slowlog-*` | 只含执行时间；参数脱敏 |
| `redis key inspect --key K [--include-value]` | read | `TYPE`、`PTTL`、`OBJECT ENCODING`、`MEMORY USAGE … SAMPLES 5`、长度命令、`OBJECT FREQ` | 键不存在 → `NOT_FOUND`；值读取有上限 |
| `redis key sample --pattern P [--max-keys 100] [--max-scan-calls 50] [--scan-count 100]` | diagnose | `SCAN MATCH COUNT` 循环 + 管道 `TYPE`/`MEMORY USAGE` | 有预算的采样；大小分布与最大键候选 |
| `redis key hot --pattern P [--max-keys] [--top 10]` | diagnose | `SCAN` + `OBJECT FREQ` | 仅 LFU 策略可用；对数计数器，不是 QPS |
| `redis config get --pattern P` | read | `CONFIG GET` | 口令类配置显示为 `<redacted>` |

`--instance` 缺省取 profile 的 `defaults.redis`。

## 指标口径

### 累计 vs 窗口

- `INFO stats` 中 `keyspace_hits/misses`、`total_commands_processed`、`evicted_keys`、`expired_keys`、`rejected_connections` 等是**自启动（或 `CONFIG RESETSTAT`）以来的累计值**。用累计值算出的“命中率”是全生命周期平均值，不能说明“最近”。
- `instantaneous_ops_per_sec` 等是服务端对最近约 1.6 秒的抽样估计（`instantaneous_estimate`），不是精确窗口值。
- `stats sample` 在**同一连接**上取两次 INFO：`deltas` = 第二次 − 第一次，`rates_per_sec` = 增量 / 实际窗口秒数，`coverage.window` 为实际起止时间。命令会等待整个窗口，窗口须小于 `--timeout`（默认 30s），否则连接前即返回 `INVALID_ARGUMENT`。
- **重启**（`run_id` 变化或 `uptime_in_seconds` 回退）→ 所有增量为 `null`，`restart_detected=true`，`status=partial`。**计数器回退但未重启**（`CONFIG RESETSTAT`）→ 对应增量为 `null`，列入 `reset_counters`，`status=partial`。绝不输出负数增量。
- `hit_ratio = hits / (hits + misses)`；窗口内没有键查找时为 `null`（不是 0），`hit_ratio_note` 说明分母。
- `total_commands_processed` 增量包含 workctl 自身的 1 条 INFO（`self_commands_in_window=1`）。

### 慢日志

- 只记录**命令执行时间**，不含网络往返、排队等待（单线程阻塞时的排队）和客户端 I/O；应用看到的 Redis 延迟可能远大于 `duration_us`。
- 环形缓冲，只保留最近 `slowlog-max-len` 条，更早的已被覆盖；`retained_entries` 为当前保留条数。`slowlog-log-slower-than < 0` 表示关闭 → `COLLECTION_DISABLED`。
- 读不到 `CONFIG`（ACL 或托管平台禁用）时阈值与上限标注为 unknown，不报错。
- 参数只保留命令（含子命令）与键名，其余值替换为 `?`；`AUTH`/`HELLO` 不保留任何参数。

### 采样覆盖（key sample / key hot）

- `SCAN` 可能**重复返回**同一个键（已去重，`duplicates_seen` 计数）；`COUNT` 只是提示，每次返回数量不固定；遍历期间新增/删除的键可能遗漏。
- 预算：`max_keys`（不同键数）、`max_scan_calls`、剩余时间。`scan.stopped_by` 说明停止原因。
- `coverage.complete=true` 只表示游标在预算内回到 0（完整遍历一次），**仍不是一致性快照**；`complete=false` 时分布只代表样本。`sources[].relation=sampled`。
- `MEMORY USAGE … SAMPLES 5` 对集合类型是抽样估算（近似值）。`vanished_keys` 是 SCAN 返回后已过期/删除/淘汰的键。

### 内存 ≠ 热度

- 大键用 `key sample`（`MEMORY USAGE`）；热键用 `key hot`（`OBJECT FREQ`）。两者是不同维度，不能互相替代。
- `OBJECT FREQ` 只在 `maxmemory-policy` 为 `allkeys-lfu`/`volatile-lfu` 时有效：它是 0–255 的**对数概率计数器**（受 `lfu-log-factor` 影响，按 `lfu-decay-time` 分钟衰减，新键初始为 5），不是 QPS，也不能跨实例比较。非 LFU 策略 → `COLLECTION_DISABLED`（Redis 没有跟踪频度），提示在应用侧/代理层统计。
- `key inspect --include-value` 会读取值：计入 `keyspace_hits`、更新该键的 LFU/LRU；值上限为字符串前 1024 字节、集合前 20 个元素（`truncated=true`）；二进制值以 base64 返回。

## 权限前提

- 需要的命令：`INFO`、`SLOWLOG`、`SCAN`、`TYPE`、`PTTL`、`OBJECT`、`MEMORY USAGE`、`DBSIZE`、长度命令（`STRLEN/LLEN/HLEN/SCARD/ZCARD/XLEN`）；可选 `CONFIG GET`（慢日志阈值、LFU 参数、`config get`）、`ACL WHOAMI`（probe）。读取值需要相应读命令。
- 只读诊断 ACL 示例（不要授予 `+@dangerous`/`+@write`）：

```
ACL SETUSER workctl_ro on ><口令通过 password_ref 引用> ~* resetchannels -@all +@read +info +slowlog +scan +type +pttl +object +memory|usage +dbsize +config|get +acl|whoami +ping
```

- 凭据只通过 `password_ref: file:… | env:…` 引用，不进入输出。

## 错误语义

| 情况 | 错误码 |
|---|---|
| `NOAUTH` / `WRONGPASS` | `UNAUTHENTICATED` |
| ACL 拒绝命令或键（`NOPERM`） | `PERMISSION_DENIED` |
| 命令被禁用/重命名（`unknown command`，托管 Redis 常见） | `UNSUPPORTED` |
| 键不存在（`key inspect`） | `NOT_FOUND` |
| 连接拒绝、`LOADING`、`BUSY` | `UPSTREAM_UNAVAILABLE`（retryable） |
| 命令超时、采样超过时间预算 | `TIMEOUT` |
| 非 LFU 策略下请求热键；慢日志关闭 | `COLLECTION_DISABLED` |
| `WRONGTYPE`、语法错误 | `INVALID_ARGUMENT` |

## Demo 数据

`node demo/scenarios/mysql-redis/scenario.mjs warm-cache` 按 demo-order 的缓存格式写入 `demo:order:<id>`（JSON 字符串，约 10% 无 TTL）、`demo:customer:<id>:recent`，并写入大键候选 `demo:customer:<1..20>:history`（list）、`demo:leaderboard:amount:2026-10-16`（约 1.6 万成员 zset）、`demo:export:orders:2026-10-16T00`（约 300KB 字符串）、`demo:customer:<id>:profile`（hash，无 TTL），最后制造倾斜读流量（热键、缺失键、几条 >1ms 的慢命令）。见 `demo/scenarios/mysql-redis/README.md`。

## 参考

- INFO：https://redis.io/docs/latest/commands/info/
- SCAN：https://redis.io/docs/latest/commands/scan/
- SLOWLOG GET：https://redis.io/docs/latest/commands/slowlog-get/
- MEMORY USAGE：https://redis.io/docs/latest/commands/memory-usage/
- OBJECT FREQ：https://redis.io/docs/latest/commands/object-freq/
- 淘汰策略与 LFU：https://redis.io/docs/latest/develop/reference/eviction/
- ACL：https://redis.io/docs/latest/operate/oss_and_stack/management/security/acl/
