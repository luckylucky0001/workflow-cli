---
name: postgres-operations
description: 排查 PostgreSQL 慢查询、锁等待/阻塞链、idle in transaction、顺序扫描与缺索引、死元组与 vacuum 状态（只读诊断，不执行变更）。当用户提到 PostgreSQL/Postgres/PG 慢、慢 SQL、pg_stat_statements、锁等待、事务卡住、连接数、执行计划/EXPLAIN、Seq Scan、缺索引、表膨胀/死元组/autovacuum、或想对 PG 业务库做只读查询时使用（workctl pg ...）。MySQL 库改用 mysql-operations；库类型不明时先用 workctl resource list 看绑定。
---

# PostgreSQL 只读诊断

> **调用约定**：profile/端点已由环境（`WORKCTL_CONFIG` / `--profile`）给定，直接以 `workctl` 开头调用，全局参数紧跟其后：`workctl --json <命令> ...`；不要加环境变量前缀、`cd`、管道或 `node dist/workctl.js`。命令被宿主拒绝时不要换写法绕过，说明需要授权的只读命令。

`--instance` 缺省取 profile 的 `defaults.postgres`；`--database` 缺省为端点配置的库。口径、权限与错误码见 `docs/guides/postgres.md`。

## 原则

- **事实 vs 假设**：引擎查询结果（`sources[].adapter=pg-driver`，`version` 为实际版本）是事实；资源绑定（`binding-file`）是平台元数据；“加索引会变快”在 `query explain`/`analyze` 验证前只是假设。
- **窗口 vs 累计**：`statement summary --sample-window 0`、`database list` 的计数、`table get` 的 `seq_scan/idx_scan/n_tup_*` 都是自 `stats_reset` 以来的累计值，不能说成“最近”。“最近 N 秒”只用 `statement summary --sample-window Ns`（`aggregation=window_delta`）。报告累计值时写出起点（`cumulative_since.stats_reset` / `stats_reset`）。
- **估计 vs 实际**：`rows_estimate`、`n_live_tup/n_dead_tup`、`query explain` 都是估计；只有 `query analyze` 是实际执行（它**会执行语句**，只用于 SELECT，先问用户是否可以在该实例上跑）。
- **区分状态**：`COLLECTION_DISABLED`（pg_stat_statements 未加载/未在该库创建）≠ 没有慢语句；`PERMISSION_DENIED` ≠ 表不存在；空列表 + `coverage.complete=true` 才是“确实没有”。`status=partial` 时读 `meta.coverage.notes`（常见：缺 `pg_read_all_stats`，语句文本被隐藏），在结论里写明缺了什么。其余通用规则见 `skills/enterprise-infra/SKILL.md` 第 4 步。
- 不执行写操作、DDL、VACUUM、`pg_terminate_backend`；`pg vacuum plan` / `pg index plan` / `pg replication get` 尚未接入（planned），不要假装有结果。

## 场景 1：数据库慢 / 慢 SQL

```bash
workctl --json pg instance get --instance <i>                         # 版本、连接使用、primary/standby、pg_stat_statements 是否就绪
workctl --json --timeout 45s pg statement summary --instance <i> --sample-window 20s --top 10
workctl --json pg statement summary --instance <i> --sample-window 0 --order-by mean_time --top 10   # 累计，注明 stats_reset
```
读法：
- 窗口内 `total_exec_ms` 最高的语句是耗时占比最大的；看 `mean_exec_ms`、`rows_per_call`、`shared_blks_hit + shared_blks_read`（每次读很多块却只返回几行 → 可能缺索引，待 EXPLAIN 验证）。
- `query` 是归一化文本（常量为 `$n`），可以直接交给 `pg query explain`（PG16+ 用 GENERIC_PLAN）；`query analyze` 需要先把 `$n` 换成具体值。
- 窗口内 `statements` 为空：窗口内没有语句执行；窗口须小于 `--timeout`。
- `COLLECTION_DISABLED`：如实说明“pg_stat_statements 未加载或未在该库创建，无法给出语句统计”，提示 hint 中的 DBA 操作；改用 `session list` 看当前在跑什么。

## 场景 2：某条 SQL 为什么慢

```bash
workctl --json pg query explain --instance <i> --sql "SELECT ... WHERE customer_id = 42"
workctl --json pg table get     --instance <i> --table <t> [--schema <s>]
workctl --json pg query analyze --instance <i> --sql "SELECT ..."      # 会实际执行（READ ONLY 事务后回滚），先确认
```
- 看 `summary.seq_scans`、`nodes[].filter` / `index_cond`、`plan_rows`；`analyze` 的 `rows_removed_by_filter` 远大于 `actual_rows` → 过滤发生在扫描之后，缺合适索引的证据。
- `actual_rows`、`actual_total_ms` 是每次 loop 的平均值，乘以 `loops` 才是总量；与 `plan_rows` 差距大 → 统计失真，可建议 ANALYZE（作为建议，不执行）。
- `table get`：WHERE 列不是任何 `indexes[].columns` 的首列 → 缺索引证据；`seq_scan` 累计远大于 `idx_scan` 且表不小 → 佐证（累计值，注明起点）。
- 加索引建议写成 `CREATE INDEX CONCURRENTLY ...` 文本供 DBA 评审，明确 workctl 不执行。

## 场景 3：锁等待 / 事务卡住

```bash
workctl --json pg lock list --instance <i>
workctl --json pg session list --instance <i>
```
- `summary.root_blockers` 是自身不在等待的阻塞会话；在 `blockers[]` 看其 `state`：`idle in transaction` + `state_age_s` 大 = 应用开启事务后未提交（最常见）。
- 等待者 `waiting_for[].locktype=transactionid, mode=ShareLock` 是典型行锁等待；`relation` 非空则是表级锁（如 DDL 的 AccessExclusiveLock）。
- 阻塞方 `query` 是它**最后一条**语句，不一定是持锁语句，不要据此下结论。
- 都是瞬时快照；需要时间维度就隔几秒再查一次并说明。不要建议 `pg_terminate_backend`，除非用户明确要求；那属于受控变更，不在本 Skill 范围。

## 场景 4：表膨胀 / vacuum

```bash
workctl --json pg table get --instance <i> --table <t>
workctl --json pg database list --instance <i>
```
- `stats.n_dead_tup`、`dead_ratio`（估计值）、`last_autovacuum`/`last_autoanalyze`、`n_mod_since_analyze`；`size.total_bytes` 与 `rows_estimate` 对照。
- `database list` 的 `xid_age` 接近 20 亿需关注事务 ID 回卷。
- 长时间 `idle in transaction`（场景 3）会阻止 vacuum 回收死元组，两者常一起出现。

## 场景 5：只读核对数据

```bash
workctl --json pg query run --instance <i> --sql "SELECT id, status FROM orders WHERE id = 1" --max-rows 20
```
- 只允许单条 SELECT / WITH...SELECT / VALUES / TABLE；被拒绝时按提示改写，不要尝试绕过（例如用函数、`query_to_xml` 或拆分语句）。
- `truncated=true` 表示还有更多行；`masked_columns` 中的值已脱敏，不要尝试还原或构造表达式拿原值。
- 真正的边界是只读数据库角色；如果某个查询返回 `PERMISSION_DENIED`，如实告知缺哪张表的 SELECT 权限。

## 常见错误

| 错误码 | 含义 | 处理 |
|---|---|---|
| `UNAUTHENTICATED` | 口令错误、角色无 LOGIN 或 pg_hba 拒绝 | 检查 profile 的 password_ref（不要索要或打印口令） |
| `PERMISSION_DENIED` | 角色缺权限（如表未授权、EXPLAIN UPDATE 需 UPDATE 权限）或只读事务拒绝 | 说明缺哪个权限，见指南“权限前提” |
| `NOT_FOUND` | 表/库/端点不存在（名称区分大小写） | 核对名称；`pg database list`、`pg table get` |
| `COLLECTION_DISABLED` | pg_stat_statements 未加载/未在连接库创建/track=none | 说明不可判断，换数据源（session list） |
| `TIMEOUT` | 超过 statement_timeout（端点 `statement_timeout_ms`）或 `--timeout` | 缩小范围或加大 `--timeout` |
| `UPSTREAM_UNAVAILABLE` | 实例不可达、连接数满 | 可重试；结合 `instance get` / 网络检查 |
