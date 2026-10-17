---
name: mysql-operations
description: 排查 MySQL 慢查询、锁等待、全表扫描与索引问题，并生成加索引的变更计划（只读诊断 + 计划，不执行 DDL）。当用户提到 MySQL 慢、慢 SQL、慢日志、锁等待/死锁/事务卡住、连接数、执行计划/EXPLAIN、缺索引、某条 SQL 要不要加索引、或想对 MySQL 业务库做只读查询时使用（workctl mysql ...）。PostgreSQL/PG 库改用 postgres-operations；库类型不明时先用 workctl resource list 看绑定。
---

# MySQL 诊断与变更计划

> **调用约定**：profile/端点已由环境（`WORKCTL_CONFIG` / `--profile`）给定，直接以 `workctl` 开头调用，全局参数紧跟其后：`workctl --json <命令> ...`；不要加环境变量前缀、`cd`、管道或 `node dist/workctl.js`。命令被宿主拒绝时不要换写法绕过，说明需要授权的只读命令。

`--instance` 缺省取 profile 的 `defaults.mysql`。口径、权限与错误码见 `docs/guides/mysql.md`。

## 原则

- **事实 vs 假设**：引擎查询结果（`sources[].adapter=mysql-driver`）是事实；资源绑定（`binding-file`）是平台元数据；“加索引会变快”在 `query explain`/`analyze` 验证前只是假设。
- **窗口 vs 累计**：`statement summary --sample-window 0`、`instance get` 的 `Questions/Slow_queries`、`index list` 的 `io_by_index` 都是自启动累计值，不能说成“最近”。“最近 N 秒”只用 `statement summary --sample-window Ns`（`aggregation=window_delta`）。
- **估计 vs 实际**：`table get` 的 `rows_estimate`、`index list` 的 `cardinality_estimate`、`query explain` 都是估计；只有 `query analyze` 是实际执行（它**会执行语句**，只用于 SELECT，先问用户是否可以在该实例上跑）。
- **区分状态**：`COLLECTION_DISABLED`（慢日志/performance_schema 未开启）≠ 没有慢查询；`PERMISSION_DENIED` ≠ 表不存在；空列表 + `coverage.complete=true` 才是“确实没有”。
- 读结果：通用规则（partial、空结果与各错误码的区分、累计/快照 vs 窗口、`relation`、`data.state`、planned、`data_mode`）见 `skills/enterprise-infra/SKILL.md` 第 4 步，单独加载本 Skill 时至少遵守：`status=partial` 读 `meta.coverage.notes` 并写明缺口；`COLLECTION_DISABLED`/`PERMISSION_DENIED`/`DATA_UNAVAILABLE` 都不是“没有”；结论引用 `meta.sources`。
- 不执行写操作或 DDL；`query execute` 只用于只读核对，结果默认最多 20 行。

## 场景 1：数据库慢 / 慢 SQL

```bash
workctl --json mysql instance get --instance <i>                       # 版本、Threads_running、slow_log 是否 table
workctl --json --timeout 45s mysql statement summary --instance <i> --sample-window 30s --top 10
workctl --json mysql slowlog list --instance <i> --since 1h --limit 20
```
读法：
- 按 `total_latency_ms` 排序的摘要就是窗口内耗时占比最大的语句；看 `avg_latency_ms`、`avg_rows_examined` 与 `rows_sent/count` 的比值。扫描行数远大于返回行数 → 缺少合适索引（假设，待 EXPLAIN 验证）。
- `no_index_used_count>0` 表示全表扫描；为 0 也可能是“全索引扫描”（如按 `created_at` 索引反向扫完整张表）。
- 窗口内 `digests` 为空：窗口内没有语句执行（确认窗口是否覆盖问题时段）；窗口须小于 `--timeout`，否则先加大 `--timeout`。
- 慢日志 `COLLECTION_DISABLED`：如实说明“慢日志未开启/只写文件，无法从慢日志判断”，改用 statement summary。

## 场景 2：某条 SQL 为什么慢

单条语句直接用 `--sql` 传入（或写入文件用 `--sql-file`，二者只能给一个）：
```bash
workctl --json mysql query explain --instance <i> --database <db> --sql "SELECT ... WHERE customer_id = 42"
workctl --json mysql table get   --instance <i> --database <db> --table <t>
workctl --json mysql index list  --instance <i> --database <db> --table <t>
workctl --json mysql query analyze --instance <i> --database <db> --sql "SELECT ..."   # 会实际执行，先确认
```
- 看 `summary.full_scans`（ALL）与 `full_index_scans`（index）、`key`、`rows_examined_per_scan`、`filtered`、`using_filesort`。
- `analyze` 的 `nodes[].actual_rows` 与 `estimated_rows` 差距大 → 统计/分布导致估计失真，结论以实际值为准。
- WHERE 条件列在 `index list` 中不是任何索引的首列 → 缺索引的证据。

## 场景 3：锁等待 / 事务卡住

```bash
workctl --json mysql lock list --instance <i>
workctl --json mysql session list --instance <i>
```
- `summary.root_blockers` 是自身不在等待的阻塞事务；在 `session list` 中找同一 `trx.id`：`command=Sleep` 且 `trx` 非空（`summary.idle_in_trx`）= 应用开启事务后未提交。
- 阻塞方 `sql_text=null` 很常见（持锁语句已执行完），不要据此说“没有在执行”。
- 锁与会话都是瞬时快照；需要时间维度就隔几秒再查一次并说明。
- 不要建议 KILL，除非用户明确要求；这属于受控变更，不在本 Skill 范围。

## 场景 4：建议加索引

```bash
workctl --json mysql index plan --instance <i> --database <db> --table <t> --columns c1[,c2]
```
向用户展示：`targets`（表行数估计、大小）、`impact.ddl`、`impact.affected_statements`（哪些语句可能受益/写入需维护，来源为累计摘要的文本匹配，属推断）、`preconditions` 中 `ok=false` 的项（尤其 `no_index_with_same_leading_columns`、`no_long_running_transactions`）、`rollback`。
- 本计划 `executable=false`：没有执行器，不能 `operation execute`；按 计划 → 确认 → 执行 → 复核 的结构，确认与执行改由 DBA 变更流程完成（计划 ID 可作附件）。计划预览不是执行成功的证据；不要自行执行 DDL。
- 执行后复核：`index list` 出现新索引 → `query explain` 使用新索引 → `statement summary` 窗口对比延迟和 `rows_examined`。

## 场景 5：只读核对数据

```bash
workctl --json mysql query execute --instance <i> --database <db> --sql "SELECT id, status FROM orders WHERE id = 1" --max-rows 20
```
- 只允许单条 SELECT/WITH/SHOW/DESCRIBE/EXPLAIN；被拒绝时按提示改写，不要尝试绕过。
- `truncated=true` 表示还有更多行；`masked_columns` 中的值已脱敏，不要尝试还原。
- 引用敏感列的表达式、UNION、派生表会被保守地整列脱敏；不要为了拿到敏感值改写语句或构造表达式。
- 优化器提示 `MAX_EXECUTION_TIME` / `SET_VAR` / `RESOURCE_GROUP` 会被拒绝（会绕过执行时间上限）。

## 常见错误

| 错误码 | 含义 | 处理 |
|---|---|---|
| `UNAUTHENTICATED` | 账号/口令错误或锁定 | 检查 profile 的 password_ref（不要索要或打印口令） |
| `PERMISSION_DENIED` | 账号缺权限（如 EXPLAIN UPDATE 需要 UPDATE 权限） | 说明缺哪个权限，见指南“权限前提” |
| `COLLECTION_DISABLED` | performance_schema / 慢日志未开启 | 说明不可判断，换数据源 |
| `TIMEOUT` | 超过 MAX_EXECUTION_TIME 或 `--timeout` | 缩小范围或加大 `--timeout` |
| `UPSTREAM_UNAVAILABLE` | 实例不可达 | 可重试；结合 `instance get`/网络检查 |
