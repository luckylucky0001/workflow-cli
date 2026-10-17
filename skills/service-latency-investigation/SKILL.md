---
name: service-latency-investigation
description: 排查在线服务延迟升高、超时或错误增多的流程：按 资源绑定 → 最近发布 → 容器状态/事件 → 指标 → 日志/调用链 → Redis → MySQL/PostgreSQL 的顺序取证，区分事实与假设，给出可验证的结论与下一步。当用户说“某服务变慢了”“p95 升高”“接口超时/偶尔超时”“发布后报错变多”时使用。离线数据延迟改用 offline-delay-investigation；容量规划改用 resource-capacity-review。
---

# 服务延迟排查

目标：用证据回答“慢在哪一层、从什么时候开始、与什么变化同时发生”，而不是猜原因。所有命令加 `--json` 读取完整信封；结论引用 `meta.sources` 与 `meta.coverage`。

## 原则

- **事实**＝命令返回的数据（带来源、观测时间、窗口）。**假设**＝对因果的推断，必须写出验证它的命令。报告里两者分开写。
- 依赖关系只用资源绑定/服务配置给出的关系（`resource` 命令或 `container workload restart-plan` 的 impact），不要按名称相似认定“这个库就是它用的”。
- 窗口要对齐：先确定异常开始时间，再让指标、日志、慢查询使用覆盖该时间的窗口。快照（stats）不能证明“过去 15 分钟”。
- `empty`/`no samples in window` ≠ 0；`COLLECTION_DISABLED` ≠ “没有问题”；`partial` 要说明缺了什么。

## 流程

### 1. 范围与依赖（事实）
```bash
workctl resource get --id <service>                 # 绑定的上下游关系及来源（depends_on mysql/redis，runs_on 容器）
workctl service dependency list --service <service> # 传递依赖
workctl container workload get --service <service>
```
记录：容器是否 running、health、restart_count、oom_killed、started_at（是否刚重启/重建）。

### 2. 变化事件
```bash
workctl container event list --service <service> --window 1h
```
看 die/oom/restart/health_status。注意 `daemon_buffer_full` 与 `visible_since`：缓冲已满时更早的事件**不可见**，不能据此说“没有重启”，改用 workload 的 `started_at` 判断。

服务在配置中心有绑定时，再看配置变更（未绑定返回 `NOT_CONFIGURED`，跳过即可）：
```bash
workctl config get --service <service>                       # 各键 mod_revision；修订号越大越新（etcd 不记录时间）
workctl config diff --service <service> --key <name>         # 与该键上一版本比较；敏感值只显示 ***
```
修订号不是时间：配置变更与指标起点 T 的先后，要靠服务日志中的变更记录（第 4 步）对齐。

服务有部署系统绑定时，再看最近的发布（未绑定返回 `NOT_CONFIGURED`，跳过即可）：
```bash
workctl deploy release list --service <service> --window 24h   # 版本、开始时间、状态；Kubernetes 时间为 derived（ReplicaSet 创建时间）
workctl deploy status get --service <service>                  # 是否有进行中/失败的 rollout
```
发布开始时间早于且接近指标起点 T，只是“可能相关”的线索；用 `deploy release get` 看变更内容（镜像/环境变量差异），并用第 3 步的指标在发布前后对比确认。详见 `skills/deploy-operations/SKILL.md`。

### 3. 指标：确认现象与起点
```bash
workctl metric list --resource <service>
workctl metric query --resource <service> --metric request_latency --window 30m
workctl metric query --resource <service> --metric error_rate --window 30m
workctl metric query --resource <service> --metric cache_hit_ratio --window 30m
workctl metric query --resource <service> --metric db_query_rate --window 30m
```
- 用数据点找出延迟上升的时间点 T（不是只看 avg）。p95 来自直方图：落在最大有限桶之外时只返回桶边界（demo-order 为 10s），应读作“≥ 该值”。
- 同一时间点 `cache_hit_ratio` 下降、`db_query_rate` 上升 → 指向“缓存未起作用，请求落到数据库”（假设，继续验证）。
- `cache_hit_ratio` 的分母包含 `result=bypass/error`：缓存被绕过时比值为 0；为 null（NaN）只表示窗口内没有任何缓存请求。拆开看原始计数：
  `workctl metric query --resource <service> --promql 'sum by (result) (rate(cache_requests_total{service="<service>"}[1m]))'`
- 延迟按路由拆分：`--promql 'histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket{service="<service>"}[1m])))'`

### 4. 日志与调用链：慢请求花在哪
```bash
workctl log query --service <service> --window 15m --level warn
workctl log query --service <service> --window 1h --contains 'cache mode changed'   # 配置/模式变更记录
workctl trace get --id <trace_id> --window 1h
```
- trace_id 来自日志或响应头 `x-trace-id`。看 `breakdown` 的 `self_ms`：`mysql.pool.acquire` 高＝排队等连接（并发/连接池饱和），`mysql.query` 高＝语句本身慢，`redis.get` 缺失＝该请求没走缓存。
- 找“变化”日志：如 `cache mode changed`（level warn）给出了时间与前后值——这是事实，可与指标起点 T 对齐。

### 5. 缓存（Redis，由 redis 领域提供；采样窗口是“现在”的几秒，故障仍在时才有意义）
```bash
workctl redis stats sample --instance <redis> --duration 10s      # 两次 INFO 差分：命中/未命中、ops、淘汰/过期
workctl redis key sample --instance <redis> --pattern 'demo:order:*' # 有预算的 SCAN 抽样（非全量）
```
区分：Redis 本身无命中（键过期/被驱逐）与应用根本没去查 Redis（应用侧 `result=bypass`）。

### 6. 数据库（按 `resource get` 中 depends_on 的类型选择 MySQL 或 PostgreSQL）
```bash
workctl mysql statement summary --instance <mysql> --sample-window 10s   # 两次快照差分：执行次数、耗时、扫描行数、未用索引
workctl mysql query explain --instance <mysql> --database <db> --sql-file q.sql   # 普通 EXPLAIN，不执行语句
```
依赖是 PostgreSQL 时改用 pg 领域（同样是窗口差分；`--sample-window 0` 是自 stats_reset 以来的累计值，不能当窗口值），细节见 `skills/postgres-operations/SKILL.md`：
```bash
workctl pg statement summary --instance <pg> --sample-window 10s --top 10
```
对 trace/日志中出现的慢语句做 EXPLAIN：`type=ALL`、`key=NULL`、rows≈全表 → 全表扫描（事实）；“加索引能修复”是假设，需方案评审（mysql 的 plan 能力）后验证。

### 7. 资源与连通性（排除项）
```bash
workctl container stats get --service <service>        # 快照：CPU 是否顶到 limit、内存是否接近上限
workctl network backend list --service <service>       # 探测健康接口与延迟
workctl network connectivity check --target <db_host:port>
```

## 输出格式

1. **现象（事实）**：指标名、窗口、起点 T、前后数值（引用 sources）。
2. **证据链（事实）**：按时间排列的事件/日志/trace/慢语句，每条注明来源与覆盖范围。
3. **结论或假设**：明确标注“已验证”或“假设”；每个假设附验证命令。
4. **缺口**：哪些数据不可见（事件缓冲、日志保留、COLLECTION_DISABLED、partial）。
5. **建议动作**：只读验证优先；变更走 plan → 人工确认 → `operation execute`，并说明回退方式。

## 常见误判

- 用 `container stats get` 的累计网络字节说明“流量上涨”——它是累计值，要用指标窗口。
- 只看 avg 延迟：缓存失效时 p95/p99 先变差。
- 把“慢查询列表为空”当作数据库没问题：先确认慢日志/statement 采集是否开启。
- 看到名字像的容器/库就当依赖：以绑定与配置为准。
