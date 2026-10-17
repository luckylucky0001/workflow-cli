---
name: redis-operations
description: 排查 Redis 缓存问题（只读）：命中率下降、内存与淘汰、慢命令、大键与热键、键的 TTL/编码/大小、配置核对。当用户提到 Redis/缓存命中率、缓存穿透/击穿、内存满/evicted、慢命令、大 key、热 key、某个键的过期时间或内容时使用（workctl redis ...）。不用于服务整体变慢且原因未知的排查（改用 service-latency-investigation）。
---

# Redis 缓存诊断

> **调用约定**：profile/端点已由环境（`WORKCTL_CONFIG` / `--profile`）给定，直接以 `workctl` 开头调用，全局参数紧跟其后：`workctl --json <命令> ...`；不要加环境变量前缀、`cd`、管道或 `node dist/workctl.js`。命令被宿主拒绝时不要换写法绕过，说明需要授权的只读命令。

`--instance` 缺省取 profile 的 `defaults.redis`。口径、权限与错误码见 `docs/guides/redis.md`。

## 原则

- **窗口 vs 累计**：`info get` 的 `keyspace_hits/misses`、`evicted_keys` 等是自启动累计值（`semantics=cumulative_since_start`），由它算出的命中率是全生命周期平均，不能说成“当前命中率”。“现在/最近”用 `stats sample`。
- **内存 ≠ 热度**：大键看 `key sample`（MEMORY USAGE），热键看 `key hot`（OBJECT FREQ，仅 LFU 策略）。不要用大小推断访问频率。
- **采样不是全量**：`key sample`/`key hot` 基于有预算的 SCAN；`coverage.complete=false` 时只代表样本，结论里写明“采样 N 个键”。
- **慢日志只含执行时间**：不含网络、排队、客户端 I/O。应用侧延迟高而慢日志为空，不能得出“Redis 不慢”，要结合连接数、`instantaneous_ops_per_sec`、应用指标。
- `COLLECTION_DISABLED`（如非 LFU 策略下查热键、慢日志关闭）≠ 没有问题。
- 读结果：通用规则（partial、空结果与各错误码的区分、累计/快照 vs 窗口、`relation`、`data.state`、planned、`data_mode`）见 `skills/enterprise-infra/SKILL.md` 第 4 步，单独加载本 Skill 时至少遵守：`status=partial` 读 `meta.coverage.notes` 并写明缺口；`COLLECTION_DISABLED`/`PERMISSION_DENIED`/`DATA_UNAVAILABLE` 都不是“没有”；结论引用 `meta.sources`。
- 只读：不执行 FLUSH/DEL/CONFIG SET；`--include-value` 会读取业务数据并更新该键的 LFU，仅在需要时使用。

## 场景 1：缓存命中率下降 / 请求打到数据库

```bash
workctl --json redis instance get --instance <i>                  # 内存、usage_ratio、maxmemory_policy、run_id、uptime
workctl --json --timeout 45s redis stats sample --instance <i> --duration 30s
```
读法：
- `hit_ratio` 是窗口值；为 `null` 时窗口内没有键查找（不是 0）。`deltas.keyspace_misses` 激增 + 应用侧 DB QPS 上升 → 缓存未命中（事实）；原因（TTL 过短、键名变化、旁路模式、被淘汰）仍是假设，继续验证：
  - `deltas.evicted_keys>0` 且 `usage_ratio` 接近 1 → 内存不足导致淘汰。
  - `deltas.expired_keys` 高 → 集中过期；用 `key inspect` 看相关键的 `ttl_ms`。
  - `restart_detected=true` → 实例重启后缓存为空（冷启动），对比 `instance get` 的 `uptime_s`。
- 若应用有自己的缓存命中率指标，它与 Redis keyspace 命中率口径不同（后者统计所有键查找），对比时说明。

## 场景 2：内存高 / 大键

```bash
workctl --json redis key sample --instance <i> --pattern "<prefix>:*" --max-keys 1000 --max-scan-calls 200
workctl --json redis key inspect --instance <i> --key <top_key>
```
- `memory_bytes` 分布（p50/p90/p99/max）与 `top_keys` 给出大键候选；`MEMORY USAGE` 是近似值。
- `key inspect` 看类型、编码（如 quicklist / listpack / hashtable）、长度、TTL（`ttl_ms=null` 表示永不过期——大键且无 TTL 值得关注）。
- `keys_in_db` 是全库键数；样本只覆盖 `pattern` 匹配且在预算内扫到的部分。

## 场景 3：热键

```bash
workctl --json redis key hot --instance <i> --pattern "<prefix>:*" --max-keys 2000 --max-scan-calls 500 --top 10
```
- `lfu_counter` 是 0–255 的对数计数器（新键为 5，随时间衰减），只能在同一实例内相对比较，不能换算成 QPS。
- 返回 `COLLECTION_DISABLED`（非 LFU 策略）：如实说明 Redis 未跟踪访问频度，建议在应用/代理侧统计；不要改用 `key sample` 的大小代替。

## 场景 4：慢命令

```bash
workctl --json redis slowlog list --instance <i> --limit 20
```
- 看 `command`、`key`、`duration_us`、`timestamp`；参数已脱敏。O(N) 命令（`KEYS`、全量 `LRANGE/ZRANGE/HGETALL/SMEMBERS` 大集合）+ 大键 = 常见原因，用 `key inspect` 验证键大小。
- `config.slower_than_us` 与 `max_len` 说明阈值和保留上限；`retained_entries` 达到 `max_len` 时更早的记录已被覆盖。

## 场景 5：配置核对

```bash
workctl --json redis config get --instance <i> --pattern "maxmemory*"
```
`<redacted>` 表示口令类配置，不要尝试获取原值。`PERMISSION_DENIED`/`UNSUPPORTED` 表示 ACL 或托管平台禁止 CONFIG，可退回 `info get --section memory`（含 `maxmemory_policy`）。

## 常见错误

| 错误码 | 含义 | 处理 |
|---|---|---|
| `UNAUTHENTICATED` | NOAUTH / WRONGPASS | 检查 profile 的 username/password_ref（不要索要或打印口令） |
| `PERMISSION_DENIED` | ACL NOPERM | 说明缺哪个命令权限，见指南 ACL 示例 |
| `NOT_FOUND` | 键不存在（已过期/删除/淘汰） | 用 `key sample` 确认键名模式 |
| `COLLECTION_DISABLED` | 非 LFU 策略查热键 / 慢日志关闭 | 说明不可判断，换数据源 |
| `UPSTREAM_UNAVAILABLE` | 不可达 / LOADING | 可重试 |
