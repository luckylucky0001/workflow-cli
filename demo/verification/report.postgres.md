# 隔离演示环境验证记录（postgres）

> 由 `node scripts/verify-demo.mjs demo/verification/cases.postgres.json` 生成于 2026-10-18T05:46:07.323Z；原始结果信封见 `demo/verification/envelopes-postgres/`。全部为合成数据。

通过 35 / 35

| # | 命令 | 期望 | 实际 | 退出码 | 耗时 ms | 来源@版本 | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ✅ pg-01 | `workctl access check --capability postgres.query.run --target demo-postgres` | success | success | 0 | 599 | workctl | 前置检查：端点配置、password_ref 可解析、实际连接 workctl_ro（角色、pg_read_all_stats 成员、default_transaction_read_only=on） |
| ✅ pg-01b | `workctl auth status --probe` | success/partial | success | 0 | 1439 | workctl | 所有端点探测；postgres/demo-postgres：身份 workctl_ro、版本 16.x、MEMBER OF pg_read_all_stats、default_transaction_read_only=on（其它端点结果与本套件无关） |
| ✅ pg-02 | `workctl pg instance get --instance demo-postgres` | success | success | 0 | 899 | postgresql@16.15, workctl | 版本 16.x、运行时长、关键参数（max_connections/shared_buffers/work_mem…）、连接使用、primary、扩展 pg_stat_statements；shared_preload_libraries 对只读角色不可见 → hidden_settings（不臆造） |
| ✅ pg-03 | `workctl pg database list` | success | success | 0 | 556 | postgresql@16.15 | demo_orders / postgres：大小、连接数、累计计数与 stats_reset、xid 年龄 |
| ✅ pg-04 | `workctl pg table get --table orders` | success | success | 0 | 683 | postgresql@16.15 | orders：列、索引（无 customer_id 索引）、heap/索引/总大小、reltuples 估计、seq_scan/idx_scan 累计、n_live/n_dead_tup、最近 (auto)vacuum/analyze |
| ✅ pg-05 | `workctl pg table get --table internal_ledger` | success | success | 0 | 982 | postgresql@16.15 | 未授权表：结构来自系统目录（对所有角色可见），access.select=false 并在 coverage 说明 |
| ✅ pg-06 | `workctl pg table get --table no_such_table` | NOT_FOUND | NOT_FOUND | 5 | 838 |  | 表不存在 → NOT_FOUND |
| ✅ pg-07 | `workctl pg table get --database no_such_db --table orders` | NOT_FOUND | NOT_FOUND | 5 | 676 |  | 库不存在（SQLSTATE 3D000）→ NOT_FOUND |
| ✅ pg-08 | `workctl pg session list --include-idle` | success | success | 0 | 505 | postgresql@16.15 | pg_stat_activity 快照（排除自身连接），语句字面量替换为 ? |
| ✅ pg-09 | `workctl pg lock list` | success | success | 0 | 871 | postgresql@16.15 | 无锁等待时返回空列表（success）；阻塞链场景见 demo/scenarios/postgres lock-wait 与 test/postgres/live.test.ts |
| ✅ pg-10 | `workctl pg statement summary --sample-window 0 --top 5 --order-by total_time` | success | success | 0 | 732 | postgresql@16.15 | 累计模式：aggregation=cumulative_since，附 pg_stat_statements_info.stats_reset、dealloc、track、max |
| ✅ pg-11 | `workctl --timeout 30s pg statement summary --sample-window 3s --database demo_orders --top 5` | success | success | 0 | 3841 | postgresql@16.15 | 窗口模式：两次快照差分（t1 − t0），排除采样语句自身 |
| ✅ pg-12 | `workctl --config demo/environment/postgres/workctl.nostats.yaml pg statement summary --sample-window 0` | COLLECTION_DISABLED | COLLECTION_DISABLED | 7 | 651 |  | 端点连接的 postgres 库未 CREATE EXTENSION pg_stat_statements → COLLECTION_DISABLED（不是空结果） |
| ✅ pg-13 | `workctl pg query explain --sql SELECT id, status, amount, created_at FROM orders WHERE customer_id = 42 ORDER BY created_at DESC LIMIT 20` | success | success | 0 | 787 | postgresql@16.15 | EXPLAIN (FORMAT JSON) 估计：Seq Scan on orders + Sort（缺 customer_id 索引），estimate_only=true |
| ✅ pg-14 | `workctl pg query explain --sql SELECT * FROM orders WHERE id = $1` | success | success | 0 | 652 | postgresql@16.15 | 含 $1 占位符（pg_stat_statements 归一化文本）→ GENERIC_PLAN（PG16+），Index Scan on orders_pkey |
| ✅ pg-15 | `workctl pg query explain --sql UPDATE orders SET status = 'x' WHERE id = 1` | PERMISSION_DENIED | PERMISSION_DENIED | 4 | 884 |  | EXPLAIN 不执行但仍检查权限：只读角色无 UPDATE 权限 → PERMISSION_DENIED（SQLSTATE 42501） |
| ✅ pg-16 | `workctl pg query analyze --sql SELECT id, status, amount, created_at FROM orders WHERE customer_id = 42 ORDER BY created_at DESC LIMIT 20` | success | success | 0 | 973 | postgresql@16.15 | EXPLAIN (ANALYZE, BUFFERS) 实际执行于 READ ONLY 事务并回滚：Rows Removed by Filter≈49975、实际耗时与缓冲区命中 |
| ✅ pg-17 | `workctl pg query analyze --sql DELETE FROM orders WHERE id = 1` | INVALID_ARGUMENT | INVALID_ARGUMENT | 2 | 494 |  | analyze 会实际执行，只允许 SELECT → 静态检查拒绝（未连接数据库） |
| ✅ pg-18 | `workctl pg query run --sql SELECT c.id, c.name, c.phone AS p, upper(c.email) AS em, o.amount FROM customers c JOIN orders o ON o.customer_id = c.id ORDER BY o.id --max-rows 3` | success | success | 0 | 578 | postgresql@16.15 | 游标取 max_rows+1 行（truncated=true）；别名 p 按来源列 phone 脱敏，表达式 em 保守脱敏 |
| ✅ pg-18b | `workctl pg query run --sql SELECT c AS whole_row, count(*) OVER () AS n FROM customers c ORDER BY c.id --max-rows 2` | success | success | 0 | 575 | postgresql@16.15 | 整行引用（tableID 有值、columnID=0）：涉及含敏感列的表 customers → whole_row 整列遮蔽为 ***；数值列 n 不受影响 |
| ✅ pg-19 | `workctl pg query run --sql SELECT * FROM internal_ledger` | PERMISSION_DENIED | PERMISSION_DENIED | 4 | 518 |  | 未授权表 → PERMISSION_DENIED（SQLSTATE 42501，数据库角色是真正的边界） |
| ✅ pg-20 | `workctl pg query run --sql DELETE FROM orders` | INVALID_ARGUMENT | INVALID_ARGUMENT | 2 | 479 |  | 写语句 → 静态检查拒绝 |
| ✅ pg-21 | `workctl pg query run --sql WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d` | INVALID_ARGUMENT | INVALID_ARGUMENT | 2 | 787 |  | 数据修改型 CTE → 静态检查拒绝 |
| ✅ pg-22 | `workctl pg query run --sql SELECT 1; SELECT 2` | INVALID_ARGUMENT | INVALID_ARGUMENT | 2 | 780 |  | 多语句 → 拒绝 |
| ✅ pg-23 | `workctl pg query run --sql SELECT pg_terminate_backend(1)` | INVALID_ARGUMENT | INVALID_ARGUMENT | 2 | 889 |  | 有副作用的函数（终止会话）→ 拒绝 |
| ✅ pg-24 | `workctl pg query run --sql SELECT pg_sleep(8)` | TIMEOUT | TIMEOUT | 6 | 5677 |  | 超过端点 statement_timeout_ms=5000 → TIMEOUT（SQLSTATE 57014） |
| ✅ pg-25 | `workctl pg query run --sql SELECT * FROM no_such_table` | NOT_FOUND | NOT_FOUND | 5 | 672 |  | 关系不存在（SQLSTATE 42P01）→ NOT_FOUND |
| ✅ pg-25b | `workctl pg query run --sql SELECT U&"\0071uery_to_xml"('select 1', true, true, '')` | INVALID_ARGUMENT | INVALID_ARGUMENT | 2 | 464 |  | U&"..." Unicode 转义标识符（解码后是 query_to_xml）会绕过函数名检查 → 拒绝（静态检查，未连接） |
| ✅ pg-25c | `workctl pg query run --sql SELECT ts_rewrite('a & b'::tsquery, 'SELECT ''a''::tsquery, ''c''::tsquery')` | INVALID_ARGUMENT | INVALID_ARGUMENT | 2 | 667 |  | ts_rewrite(tsquery, text) 会把文本当作查询执行（同 query_to_xml）→ 拒绝 |
| ✅ pg-25d | `workctl pg query run --sql SELECT txid_current()` | INVALID_ARGUMENT | INVALID_ARGUMENT | 2 | 454 |  | txid_current() 即使在 READ ONLY 事务中也会分配事务号 → 拒绝 |
| ✅ pg-25e | `workctl pg query run --sql SELECT phone::int FROM customers LIMIT 1` | INVALID_ARGUMENT | INVALID_ARGUMENT | 2 | 666 |  | 类型转换错误（SQLSTATE 22P02）的服务端消息会带出敏感列的值：语句涉及敏感列时引号内的值显示为 "***"，DETAIL/HINT 省略 |
| ✅ pg-26 | `workctl pg session list --instance nope` | NOT_FOUND | NOT_FOUND | 5 | 634 |  | profile 中没有该端点 → NOT_FOUND（hint 列出可用端点） |
| ✅ pg-27 | `workctl --timeout 10s pg statement summary --sample-window 30s` | INVALID_ARGUMENT | INVALID_ARGUMENT | 2 | 504 |  | 采样窗口超过时间预算 → 连接前拒绝 |
| ✅ pg-28 | `workctl access check --capability postgres.replication.get` | success | success | 0 | 749 | workctl | planned 能力（无 handler，不生成 CLI 命令）：access check 给出 verdict=denied（能力待接入），不模拟结果 |
| ✅ pg-29 | `workctl pg query explain --sql SELECT * FROM orders WHERE id = $1` | success | success | 0 | 795 | postgresql@16.15 | 含 $n 的 GENERIC_PLAN：先经扩展协议让服务端确认是单条命令，再生成通用计划（Index Scan on orders_pkey） |
