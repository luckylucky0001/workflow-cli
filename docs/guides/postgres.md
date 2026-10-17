# PostgreSQL 能力指南

本指南覆盖 `postgres` 领域（命令前缀 `pg`）的 9 个可用命令与 3 个规划中命令（适配器 `pg-driver`/node-postgres，认证 `database-profile`）。结果信封、错误码与通用约束见 `docs/design-principles.md`；Agent 使用流程见 `skills/postgres-operations/SKILL.md`。

> 已在隔离 Demo 环境验证：**PostgreSQL 16.15**（`postgres:16-alpine` 镜像，`shared_preload_libraries=pg_stat_statements`，`pg_stat_statements.track=top`，`track_io_timing=on`，扩展版本 1.10）。代码按版本适配（13+ 用 `total_exec_time`，更早回退 `total_time`；14+ 读 `pg_stat_statements_info` 的 `stats_reset/dealloc`，更早为 null；16+ 才支持 `GENERIC_PLAN` 与 `last_idx_scan`），但 16 以外的版本未在 Demo 或客户环境验证。

## 对象模型

```
profile.endpoints.postgres.<instance>  ──(资源绑定 forEndpoint)──▶ postgres.instance 资源（平台元数据：owner/env/attributes）
   └─ 引擎实时查询（workctl_ro 角色；一个连接只属于一个 database，缺省为端点的 database）
        ├─ instance：version()、pg_settings、pg_is_in_recovery()、pg_stat_replication
        ├─ database：pg_database + pg_stat_database（累计计数，起点 stats_reset）
        │    └─ schema ─ table ─ columns / indexes（pg_class/pg_attribute/pg_index，对所有角色可见）
        │                     └─ 表/索引统计（pg_stat_all_tables / pg_stat_all_indexes：累计 + 估计）
        ├─ extensions（按库创建：pg_stat_statements 只在 CREATE EXTENSION 的库中可查）
        ├─ session / lock wait（pg_stat_activity、pg_blocking_pids()、pg_locks）
        └─ statement statistics（pg_stat_statements：累计计数器，起点 pg_stat_statements_info.stats_reset）
```

- **平台元数据 vs 引擎事实**：`instance get` 的 `binding` 来自资源绑定文件（`sources[].adapter=binding-file`），其余来自引擎（`adapter=pg-driver`，`sources[].version` 为实际 `server_version`）。两者不一致时以引擎事实为准并报告差异。
- 会话 `TimeZone=UTC`；时间字段统一为 ISO 8601（UTC）。`query run` 中的时间值保持服务端文本（如 `2026-01-02 08:00:00+00`），`bigint`/`numeric` 以字符串返回以保证精度。
- 对象名区分大小写，按实际名称给出（不加双引号）；`--schema` 缺省 `public`。

## 命令

| 命令 | 操作 | 来源 | 语义要点 |
|---|---|---|---|
| `pg instance get [--instance]` | read | `version()`、`pg_settings`、`pg_stat_activity`、`pg_is_in_recovery()`、`pg_extension` + 资源绑定 | 关键参数含 `value/unit/display/source`；角色看不到的参数列入 `hidden_settings`（不臆造）；连接数为瞬时值；`role=primary/standby` |
| `pg database list [--include-templates]` | read | `pg_database` ⟕ `pg_stat_database` | `xact_commit/blks_hit/deadlocks/temp_bytes` 为**自 `stats_reset` 以来累计**；`cache_hit_ratio` 由累计值算出；`xid_age=age(datfrozenxid)` |
| `pg table get [--database] [--schema public] --table` | read | `pg_class`、`pg_attribute`、`pg_index`、`pg_stat_all_tables/indexes`、`pg_*_size()` | 结构、索引（定义/列/大小/`idx_scan`）、heap/表/索引/总大小；`rows_estimate`、`n_live_tup/n_dead_tup` 为**估计**（统计重置后、下次 vacuum/analyze 前只反映重置后的变化，此时 `dead_ratio=null`）；`seq_scan/idx_scan/n_tup_*` 为**累计**；`access.select` 标明能否读数据 |
| `pg session list [--include-idle] [--include-background]` | read | `pg_stat_activity` + `pg_blocking_pids()` | 瞬时快照；默认只含非 idle 的客户端会话（被阻塞的 idle 也保留）；`summary.idle_in_transaction` 是常见锁源；排除 workctl 自身 |
| `pg lock list` | read | `pg_stat_activity` + `pg_blocking_pids()` + `pg_locks(granted=false)` | 等待者、等待的锁（行锁表现为 `transactionid ShareLock`）、阻塞者、`root_blockers`、`max_chain_depth`；无等待 → `success` + 空列表 |
| `pg statement summary [--sample-window 10s] [--top 10] [--order-by total_time] [--database]` | diagnose | `pg_stat_statements` 两次快照差分 | 见下文“窗口与累计” |
| `pg query explain [--database] --sql "..." \| --sql-file q.sql` | read | `EXPLAIN (FORMAT JSON)` | **优化器估计，不执行**；含 `$n` 时 PG16+ 用 `GENERIC_PLAN`；接受 SELECT/WITH/VALUES/TABLE/INSERT/UPDATE/DELETE/MERGE（只读角色 EXPLAIN 写语句会因权限被拒） |
| `pg query analyze [--database] --sql "..." \| --sql-file q.sql` | diagnose | `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` | **会实际执行语句**；只允许纯查询；READ ONLY 事务 + `statement_timeout`，结束后 ROLLBACK |
| `pg query run [--database] --sql "..." \| --sql-file q.sql [--max-rows 20]` | read | 受限只读查询 | 见下文“受限查询” |
| `pg replication get` | — | planned | 流复制延迟、复制槽（未接入，`access check` 显示待接入） |
| `pg vacuum plan` / `pg index plan` | — | planned | VACUUM/ANALYZE、`CREATE INDEX CONCURRENTLY` 变更计划（未接入；当前只读角色也不执行任何变更） |

`--instance` 缺省取 profile 的 `defaults.postgres`。SQL 来源二选一（`--sql` 内联或 `--sql-file`），都只接受单条语句、上限 256KB；同时给出或都不给 → `INVALID_ARGUMENT`。

### 窗口与累计（statement summary）

- `pg_stat_statements` 的计数是**自 `stats_reset` 以来的累计值**（`pg_stat_statements_reset()` 或扩展创建时；`pg_stat_statements.save=on`（默认）时正常重启不清空，崩溃恢复会清空）。
- 缺省 `--sample-window 10s`：在同一连接上取 t0、t1 两次快照，按 `userid+dbid+queryid+toplevel` 求差，`aggregation=window_delta`，`coverage.window` 给出起止时间。命令会等待整个窗口，窗口须小于 `--timeout`（默认 30s），否则在连接前返回 `INVALID_ARGUMENT`。
- `--sample-window 0`：直接返回累计值，`aggregation=cumulative_since`，`cumulative_since.stats_reset` 给出起点，另附 `max_exec_ms`。**不能**把累计值说成“最近”。
- 计数回退的条目（窗口内被重置）只计入重置后的部分（`reset_detected=true`）；窗口内 `dealloc` 增加（超过 `pg_stat_statements.max` 被淘汰）、条目消失或 `stats_reset` 变化 → `status=partial` 并在 `coverage.notes` 说明。
- 查询 `pg_stat_statements` 的采样语句（含 workctl 自身）被排除，数量见 `excluded_self`。
- `total_exec_ms` 只含执行时间（不含规划时间）；`rows_per_call`、`cache_hit_ratio`（shared_blks_hit/(hit+read)）帮助判断“扫描多、返回少”。
- `--database` 按 `dbid` 过滤（视图本身包含所有库的语句）；扩展需在**端点连接的库**中创建，否则 `COLLECTION_DISABLED`。

### 估计 vs 实际（explain / analyze）

- `query explain`：`total_cost`、`plan_rows` 是基于统计信息的估计；`summary.seq_scans` 列出顺序扫描的表，`index_scans` 为 `表:索引`。
- `query analyze`：`actual_total_ms`、`actual_rows` 是**每次 loop 的平均值**（节点总量 ≈ 值 × `loops`）；`rows_removed_by_filter` 大而 `actual_rows` 小 → 典型缺索引；`shared_hit/read_blocks` 区分缓存命中与磁盘读。实际耗时受缓存影响，重复执行可能更快。
- 两者都在 `BEGIN TRANSACTION READ ONLY` + `SET LOCAL statement_timeout`（端点 `statement_timeout_ms`，缺省 10000）中执行并回滚。

### 受限查询（query run）

**真正的边界是数据库角色**：Demo 的 `workctl_ro` 只有 SELECT 与 `pg_read_all_stats`，并设置了 `default_transaction_read_only=on`。程序层只是额外防线：

1. 静态检查（词法分析，正确处理 `'…'`、`E'…'`、`$tag$…$tag$`、`"…"`、嵌套注释）：只允许单条 `SELECT / WITH…SELECT / VALUES / TABLE`；拒绝多语句、数据修改型 CTE、`SELECT INTO`、`FOR UPDATE/SHARE`、`EXPLAIN` 前缀，以及终止会话、读写文件、咨询锁、序列、`set_config`、重置统计、执行任意 SQL 文本（`query_to_xml` 等）的函数。名单**不穷尽**——自定义函数可能有副作用，由角色权限兜底。
2. `BEGIN TRANSACTION READ ONLY`、`SET LOCAL statement_timeout / lock_timeout`，结束后 ROLLBACK。
3. 服务端游标 `DECLARE … NO SCROLL CURSOR` + `FETCH max_rows+1`，不缓冲完整结果集；超出 → `truncated=true`。
4. 敏感列：输出列名或其**来源列**（按 `tableID/columnID` 查系统目录，覆盖别名）命中端点 `sensitive_columns` 时脱敏；表达式列在语句引用了敏感列时保守脱敏；语句涉及含敏感列的表时，非数值类型的表达式列（整行引用 `SELECT c FROM customers c`、`row_to_json(c)`、`upper(name)` 等）也保守脱敏，数值/布尔/时间类表达式（如 `count(*)`）不受影响。不能替代数据库侧列权限或脱敏视图。

## 权限前提

Demo 角色 `workctl_ro`（`demo/environment/postgres/init/02-roles.sh`）：

```sql
CREATE ROLE workctl_ro LOGIN CONNECTION LIMIT 20;
ALTER ROLE workctl_ro SET default_transaction_read_only = on;
ALTER ROLE workctl_ro SET statement_timeout = '30s';
GRANT pg_read_all_stats TO workctl_ro;
GRANT CONNECT ON DATABASE demo_orders TO workctl_ro;
GRANT USAGE ON SCHEMA public TO workctl_ro;
GRANT SELECT ON customers, orders, order_items TO workctl_ro;   -- internal_ledger 故意不授权
```

- 没有 `pg_read_all_stats`：`session list` / `lock list` 中其他角色会话的语句与等待事件显示为 `<insufficient privilege>`（输出 `query=null`、`query_hidden=true`，`status=partial`）；`statement summary` 中其他角色的语句文本为 null（`collection.text_visible=false`，`partial`）。
- `shared_preload_libraries` 等参数需 `pg_read_all_settings` 才可见；不可见时列入 `hidden_settings`，`pg_stat_statements_loaded` 改由模块参数是否存在判断。
- 系统目录对所有角色可见，所以 `table get` 能看到无 SELECT 权限表的结构（`access.select=false`）；读数据（`query run`）才返回 `PERMISSION_DENIED`。
- 凭据只通过 `password_ref: file:… | env:…` 引用，不进入输出。`workctl access check` 与 `workctl auth status --probe` 使用本领域 probe（`current_user`、角色成员关系、`default_transaction_read_only`）。

## 错误语义

| 情况 | 错误码 |
|---|---|
| 口令错误/无 LOGIN/pg_hba 拒绝（SQLSTATE 28P01/28000）、未配置口令 | `UNAUTHENTICATED` |
| 权限不足（42501）、只读事务拒绝写（25006） | `PERMISSION_DENIED` |
| 关系/库/schema 不存在（42P01/3D000/3F000/42704）、表不存在 | `NOT_FOUND` |
| 语法/语义/数据错误（SQLSTATE 21/22/23/42/0A）、静态检查拒绝 | `INVALID_ARGUMENT` |
| `statement_timeout`/取消（57014）、`lock_timeout`（55P03）、连接超时、超过 `--timeout` | `TIMEOUT` |
| 连接拒绝/中断、连接数满（53300）、实例关闭/启动中（57P01/57P03）、08 类 | `UPSTREAM_UNAVAILABLE`（retryable） |
| `pg_stat_statements` 未在连接库创建、未通过 `shared_preload_libraries` 加载（55000）、`track=none` | `COLLECTION_DISABLED`（**不是**“没有慢语句”） |
| planned 命令 | 不生成 CLI 命令；`access check` 显示“能力待接入” |

`error.details` 保留 PostgreSQL 原始 `sql_state`、`severity`、服务端消息、`server_detail`/`server_hint`。

## 敏感信息处理

- `session list`、`lock list` 的语句文本把字符串（含 `E'…'`、dollar 引用）与数字字面量替换为 `?`，截断到 512 字符（原文本身还受 `track_activity_query_size` 截断）。
- `statement summary` 输出 `pg_stat_statements` 已归一化的文本（常量为 `$n`），再做同样的字面量替换。
- `query run` 按端点 `sensitive_columns` 脱敏；`table get` 不读数据，只标注 `sensitive`。

- 语句引用敏感列（或含敏感列的表）时，服务端错误消息中的引号内容一律替换为 `"***"`，并丢弃 DETAIL/HINT（例如 `SELECT phone::int` 的类型转换错误会带出原值）。
- `query run / analyze / explain` 要求会话 `standard_conforming_strings=on`（PostgreSQL 默认值）；被关闭时返回 `UNSUPPORTED`，因为反斜杠转义会让语句切分与服务端不一致。`U&"..."` Unicode 转义标识符、`ts_rewrite`、`txid_current()` / `pg_current_xact_id()` 等会执行文本或分配事务号的函数被拒绝。
- 脱敏只按列名进行，数值型表达式（如 `ascii(substr(...))`）可以绕过；真正的边界是数据库列权限与只读角色。

## Demo 数据与场景

- `demo/environment/docker-compose.yml` 的 `postgres` 服务（容器 `demo-postgres`，宿主端口 15432）；`up.sh` 生成 `pg_superuser_password`、`pg_ro_password` 并调用 `postgres/provision-users.sh`（初始化脚本读不到 0600 的 secret，`workctl_ro` 先以 NOLOGIN 创建，该脚本在容器内以 root 设置口令并开启 LOGIN，幂等）。
- `demo/environment/postgres/init/01-schema.sql`：合成库 `demo_orders`，`customers` 2000 行、`orders` 50000 行（`customer_id` **故意无索引**）、`order_items` 约 10 万行、`internal_ledger`（不授权给 `workctl_ro`）；`CREATE EXTENSION pg_stat_statements`。
- `demo/environment/postgres/workctl.nostats.yaml`：同一实例但端点连 `postgres` 库（未创建扩展），用于验证 `COLLECTION_DISABLED`。
- `demo/scenarios/postgres/`：`load`（复现 customer_id 顺序扫描负载）、`churn`（制造死元组）、`lock-wait`（idle in transaction 持锁 + 等待者）、`reset-stats`。
- 验证套件：`demo/verification/cases.postgres.json` → `report.postgres.md`。

## 参考

- pg_stat_statements：https://www.postgresql.org/docs/16/pgstatstatements.html
- 统计视图（pg_stat_activity、pg_stat_database、pg_stat_all_tables）：https://www.postgresql.org/docs/16/monitoring-stats.html
- pg_locks / pg_blocking_pids：https://www.postgresql.org/docs/16/view-pg-locks.html、https://www.postgresql.org/docs/16/functions-info.html
- EXPLAIN：https://www.postgresql.org/docs/16/sql-explain.html
- 预定义角色（pg_read_all_stats / pg_read_all_settings）：https://www.postgresql.org/docs/16/predefined-roles.html
- 错误码（SQLSTATE）：https://www.postgresql.org/docs/16/errcodes-appendix.html
