# MySQL 能力指南

本指南覆盖 `mysql` 领域的 11 个命令（适配器 `mysql-driver`/mysql2，认证 `database-profile`）。结果信封、错误码与通用约束见 `docs/design-principles.md`；Agent 使用流程见 `skills/mysql-operations/SKILL.md`。

> 已在隔离 Demo 环境验证：**MySQL Community Server 8.4.11**（`mysql:8.4` 镜像，performance_schema=ON，slow_query_log=ON，long_query_time=0.2，log_output=TABLE）。其它 8.0.22+ 版本预期可用（依赖 `performance_schema.processlist`、`data_locks`、`EXPLAIN ANALYZE`、`STATEMENT_DIGEST` 等 8.0 特性），未在客户环境验证。5.7 不支持。

## 对象模型

```
profile.endpoints.mysql.<instance>  ──(资源绑定 forEndpoint)──▶ mysql.instance 资源（平台元数据：owner/env/labels）
   └─ 引擎实时查询（workctl_ro 账号）
        ├─ schema(database) ─ table ─ columns / indexes（information_schema）
        ├─ session / transaction / lock wait（performance_schema.processlist、INNODB_TRX、data_lock_waits）
        ├─ statement digest（events_statements_summary_by_digest：累计计数器）
        └─ slow log（mysql.slow_log，需 log_output 含 TABLE）
```

- **平台元数据 vs 引擎事实**：`instance get` 的 `binding` 来自资源绑定文件（`sources[].adapter=binding-file`），`engine/variables/status` 来自引擎实时查询（`adapter=mysql-driver`）。两者不一致时以引擎事实为准并报告差异。
- 所有时间为 UTC（会话 `time_zone='+00:00'`）。BIGINT/DECIMAL 以字符串返回以保证精度。

## 命令

| 命令 | 操作 | 来源 | 语义要点 |
|---|---|---|---|
| `mysql instance get [--instance]` | read | `SHOW GLOBAL VARIABLES/STATUS`、`VERSION()` + 资源绑定 | `status_semantics` 标注 gauge / cumulative_since_start；`Questions`、`Slow_queries` 是自启动累计值 |
| `mysql table get --database --table` | read | `information_schema.TABLES/COLUMNS` | `rows_estimate`/`data_length` 是 InnoDB 统计**估计值**，且受 `information_schema_stats_expiry`（默认 86400s）缓存；列上标注 `sensitive` |
| `mysql index list --database --table` | read | `information_schema.STATISTICS` + `table_io_waits_summary_by_index_usage` | 按索引分组的列顺序、唯一性、`cardinality_estimate`；`io_by_index` 为累计值，`index=null` 行表示不走索引的行读取 |
| `mysql session list [--include-idle]` | read | `performance_schema.processlist` ⟕ `INNODB_TRX` | 瞬时快照；默认只返回活跃或持有事务的会话；`summary.idle_in_trx` 是常见锁源 |
| `mysql lock list` | read | `data_lock_waits` ⋈ `data_locks` ⟕ `INNODB_TRX`；`metadata_locks`(PENDING) | 谁在等、被谁阻塞、`root_blockers`；无等待 → `success` + 空列表 |
| `mysql statement summary --sample-window 10s [--top 10] [--database]` | diagnose | `events_statements_summary_by_digest` 两次快照差分 | 见下文“窗口与累计” |
| `mysql slowlog list [--since 1h] [--limit 20]` | read | `mysql.slow_log` | 未开启/只写文件 → `COLLECTION_DISABLED`；开启但无记录 → `success` + 空列表 + `coverage.window` |
| `mysql query explain --database --sql-file` | read | `EXPLAIN FORMAT=JSON` | **优化器估计，非实际执行**；返回原始 JSON + 扁平摘要（access_type、key、rows_examined_per_scan、filtered、filesort/temporary、full_scans / full_index_scans） |
| `mysql query analyze --database --sql-file` | diagnose | `EXPLAIN ANALYZE` | **会实际执行语句**；只允许 SELECT；只读事务 + MAX_EXECUTION_TIME；返回 TREE 原文与逐算子实际耗时/行数 |
| `mysql query execute --database --sql-file [--max-rows 20]` | read | 受限只读查询 | 见下文“受限查询” |
| `mysql index plan --database --table --columns c1[,c2] [--name]` | plan | information_schema + INNODB_TRX + 摘要统计 | 生成 `mysql.index.create` 计划；**无执行器**（`executable=false`） |

`--instance` 缺省取 profile 的 `defaults.mysql`。`--sql-file` 只接受单条语句（≤256KB）。

### 窗口与累计（statement summary）

- `--sample-window 10s`（默认）：t0 快照 → 等待窗口 → t1 快照，按 `(SCHEMA_NAME, DIGEST)` 求差，`aggregation=window_delta`，`coverage.window` 为实际起止时间。命令会等待整个窗口：窗口须小于 `--timeout`（默认 30s），否则在连接前直接返回 `INVALID_ARGUMENT` 并提示 `--timeout`。
- `--sample-window 0`：返回累计值，`aggregation=cumulative_since`，附 `cumulative_since.server_started_at` 与每行 `first_seen`。**累计值不能当作窗口值或速率。**
- 每个摘要输出 `count`、`total_latency_ms`/`avg_latency_ms`（皮秒换算为毫秒）、`rows_examined`、`rows_sent`、`no_index_used_count`、`digest_text`（字面量为 `?`，最长 `max_digest_length` 字节）。累计模式另有 `max_latency_ms`（窗口模式没有：`MAX_TIMER_WAIT` 不可差分）。
- 部分结果（`status=partial`）：窗口内有摘要消失（表被 TRUNCATE/重置）、计数回退（只计入重置后部分，`reset_detected=true`）、`Performance_schema_digest_lost` 增加或活动被归入 `DIGEST=NULL` 行（摘要表满，容量见 `performance_schema_digests_size`）。
- 查询 `events_statements_summary_by_digest` 的语句（含 workctl 自身采样）会被排除，数量见 `excluded_self_digests`。
- `no_index_used_count=0` 不代表扫描少：例如 Demo 中 `WHERE customer_id=? ORDER BY created_at DESC LIMIT 20` 走 `idx_created_at` 反向全索引扫描，Demo 中 `avg_rows_examined` 约 22 万～30 万行、每次只返回不到 20 行。要同时看 `avg_rows_examined / rows_sent`。

### 估计 vs 实际（explain / analyze）

- `explain` 不执行语句，`rows_examined_per_scan`、`filtered`、`cost` 都是估计；`full_scans` 是 `access_type=ALL`，`full_index_scans` 是 `access_type=index`（遍历整个索引）。
- `analyze` 执行一次语句：`actual time` 为毫秒（每次 loop 的平均值），`rows` 也是每 loop 平均值；结果受 buffer pool 命中影响。Demo 实测（`WHERE customer_id=4242 ORDER BY created_at DESC LIMIT 20`）：`explain` 估计 `Index scan … idx_created_at (reverse)` 只读 20 行；`analyze` 实际读了 300000 行、耗时约 300ms，只返回 15 行——该客户订单不足 20 条，LIMIT 无法提前结束，整条索引被反向扫完。
- EXPLAIN 需要与执行该语句相同的权限：只读账号 `EXPLAIN UPDATE ...` 返回 `PERMISSION_DENIED`。

### 受限查询（query execute）

程序层与数据库层同时落实，**数据库账号才是真正的权限边界**：

1. 静态检查（词法分析，不受引号/注释干扰）：单条语句；首关键字只允许 `SELECT / WITH(…SELECT) / SHOW / DESCRIBE / EXPLAIN`；拒绝 `INTO OUTFILE/DUMPFILE`、`SELECT … INTO @var`、`FOR UPDATE/SHARE`、`LOCK IN SHARE MODE`、`:=` 赋值、`GET_LOCK/LOAD_FILE` 等、可执行注释 `/*! */`、`EXPLAIN ANALYZE`。
2. `SET SESSION TRANSACTION READ ONLY` + `START TRANSACTION READ ONLY`。
3. `SET SESSION MAX_EXECUTION_TIME = <endpoint.max_execution_time_ms，默认 5000>`（只约束 SELECT；`SLEEP()` 被中断时返回 1 而不是报错，此时会给出 warning）。
4. `sql_select_limit = max_rows+1`，并流式读取，超过 `max_rows` 立即停止读取（`truncated=true`）。
5. 敏感列脱敏：列名或原始列名（含别名场景，如 `email AS mail`）命中端点 `sensitive_columns` → `138****0000` / `u***@example.com` / `***`，`masked_columns` 列出。表达式（`CONCAT(phone,'')`）无法识别——需要数据库侧列权限或脱敏视图兜底。

## 索引变更计划（mysql index plan / operation plan --action mysql.index.create）

计划内容：

- `targets`：实际解析出的表（引擎、`rows_estimate`、数据/索引大小、现有索引、引擎版本、观测时间）。
- `impact.ddl`：`ALTER TABLE … ADD INDEX … , ALGORITHM=INPLACE, LOCK=NONE;`；`estimated_new_index_bytes` 为**启发式估计**（行数 × 估计条目宽度 × 1.45），不是测量；`affected_statements` 来自累计摘要统计、按表名文本匹配（`relation=inferred`），标出是否引用索引首列、写语句需额外维护索引。
- `preconditions`：表存在、列存在、InnoDB、索引名未占用、**没有以相同列开头的现有索引**（否则可能冗余）、无需前缀长度、没有运行超过 60 秒的事务（MDL 风险）。
- `steps` / `rollback`（`DROP INDEX`）；`idempotent=false`、`cancellable=false`、`executable=false`。

workctl 不提供该计划的执行器：执行属于 DBA 变更流程（workctl_ro 也没有 ALTER 权限）。**计划预览不是执行成功的证据**；执行后用 `index list` + `query explain` + `statement summary` 独立复核。

## 权限前提

Demo 账号 `workctl_ro`（`demo/environment/mysql/init/02-users.sh`）：

```sql
GRANT SELECT ON demo.* TO 'workctl_ro'@'%';
GRANT SELECT ON performance_schema.* TO 'workctl_ro'@'%';
GRANT SELECT ON mysql.slow_log TO 'workctl_ro'@'%';
GRANT PROCESS ON *.* TO 'workctl_ro'@'%';
```

- 没有 `PROCESS`：`session list` 只能看到本账号会话（`status=partial`），`INNODB_TRX` 不可见。
- 没有 `SELECT on performance_schema.*`：`statement summary`、`lock list`、`index list.io_by_index` 不可用（后者降级为 warning）。
- information_schema 只显示有权限的对象，因此 `table get` 在元数据为空时会再用 `SELECT … LIMIT 0` 区分 `NOT_FOUND` 与 `PERMISSION_DENIED`。
- 凭据只通过 `password_ref: file:… | env:…` 引用，不进入输出。`workctl access check` 与 `workctl auth status --probe` 使用本领域 probe（`CURRENT_USER()`、`SHOW GRANTS`）。

## 错误语义

| 情况 | 错误码 |
|---|---|
| 账号/密码错误、账号锁定 | `UNAUTHENTICATED` |
| 表/命令权限不足（1142/1143/1227/1044）、只读事务拒绝写 | `PERMISSION_DENIED` |
| 表/库不存在（1146/1049） | `NOT_FOUND` |
| SQL 语法或语义错误（SQLSTATE 21/22/23/42）、静态检查拒绝 | `INVALID_ARGUMENT` |
| 超过 MAX_EXECUTION_TIME（3024）、锁等待超时（1205）、超过 `--timeout` | `TIMEOUT` |
| 连接拒绝/中断、连接数满（1040） | `UPSTREAM_UNAVAILABLE`（retryable） |
| performance_schema 关闭或 consumer 未启用；慢日志关闭或只写文件 | `COLLECTION_DISABLED`（**不是**“没有慢查询”） |

`error.details` 保留 MySQL 原始 `errno`、`sql_state`、`driver_code` 和服务端消息。

performance_schema=OFF（静态参数，需重启才能开启）时：`statement summary` → `COLLECTION_DISABLED`；`session list` 回退到 `information_schema.PROCESSLIST`；`lock list` 无法读取 `data_lock_waits`，只列出处于 `LOCK WAIT` 的事务（`waiting_without_blocker_info`，阻塞方未知，`status=partial`）——不会把空表当成“没有锁等待”；`index list` 的 `io_by_index=null` 并给出 warning。

## 敏感信息处理

- `session list`、`lock list`、`slowlog list` 中的 SQL 文本把字符串/数字字面量替换为 `?` 并截断到 512 字符；`statement summary` 只输出归一化的 `digest_text`，不输出 `QUERY_SAMPLE_TEXT`。
- `query execute` 按端点 `sensitive_columns` 脱敏；`table get` 不读数据，只标注 `sensitive`。

## Demo 数据与场景

- `demo/environment/mysql/init/01-schema.sql`：合成库 `demo`，`customers` 2 万行、`orders` 30 万行（2026-10-01 ~ 2026-10-17），`orders.customer_id` **故意无索引**。
- 初始化脚本以 `mysql` 用户运行，读不到 0600 的 secret 文件，因此账号先以 LOCKED 创建；`demo/environment/mysql/provision-users.sh` 在容器内以 root 设置口令（幂等）。
- `demo/scenarios/mysql-redis/`：`mysql-load`（复现 customer_id 全扫描负载）、`lock-wait`（制造行锁等待）。

## 参考

- Performance Schema：https://dev.mysql.com/doc/refman/8.4/en/performance-schema.html
- 语句摘要：https://dev.mysql.com/doc/refman/8.4/en/performance-schema-statement-digests.html
- EXPLAIN / EXPLAIN ANALYZE：https://dev.mysql.com/doc/refman/8.4/en/explain.html
- 慢查询日志：https://dev.mysql.com/doc/refman/8.4/en/slow-query-log.html
- InnoDB 在线 DDL：https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl-operations.html
- data_locks / data_lock_waits：https://dev.mysql.com/doc/refman/8.4/en/performance-schema-data-locks-table.html
