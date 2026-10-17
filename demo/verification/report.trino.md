# 隔离演示环境验证记录（trino）

> 由 `node scripts/verify-demo.mjs demo/verification/cases.trino.json` 生成于 2026-10-17T14:54:19.680Z；原始结果信封见 `demo/verification/envelopes-trino/`。全部为合成数据。

通过 15 / 15

| # | 命令 | 期望 | 实际 | 退出码 | 耗时 ms | 来源@版本 | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ✅ trino-01 | `workctl auth status --probe` | success | success | 0 | 632 | workctl | trino 端点探测：GET /v1/info（nodeVersion） |
| ✅ trino-02 | `workctl sql query submit --engine trino --file test/sql/fixtures/trino/orders_by_status.sql` | success | success | 0 | 706 | trino@476 | POST /v1/statement，短窗口内跟随 nextUri，返回 submitted + engine_state |
| ✅ trino-03 | `workctl sql query get --id q-20261017-df1918` | success | success | 0 | 709 | workctl-state@476, trino@476 | 继续拉取结果页至 FINISHED：state=succeeded、3 行预览、stats |
| ✅ trino-04 | `workctl sql query submit --engine trino --file test/sql/fixtures/trino/top_customers.sql --preview-rows 5` | success | success | 0 | 664 | trino@476 | 多表 join，25 行结果 |
| ✅ trino-05 | `workctl sql query get --id q-20261017-f70ac8` | success | success | 0 | 765 | workctl-state@476, trino@476 | preview 5 行，preview_truncated=true，coverage.truncated |
| ✅ trino-06 | `workctl sql query submit --engine trino --file test/sql/fixtures/trino/runtime_nodes.sql` | success | success | 0 | 456 | trino@476 | system catalog |
| ✅ trino-07 | `workctl sql query get --id q-20261017-bcde27` | success | success | 0 | 679 | workctl-state@476, trino@476 |  |
| ✅ trino-08 | `workctl sql query submit --engine trino --file test/sql/fixtures/trino/syntax_error.sql` | INVALID_ARGUMENT | INVALID_ARGUMENT | 2 | 346 |  | Trino SYNTAX_ERROR（USER_ERROR）→ INVALID_ARGUMENT，带行列号 |
| ✅ trino-09 | `workctl sql query submit --engine trino --file test/sql/fixtures/trino/missing_table.sql` | NOT_FOUND | NOT_FOUND | 5 | 354 |  | TABLE_NOT_FOUND → NOT_FOUND |
| ✅ trino-10 | `workctl sql query submit --engine trino --file test/sql/fixtures/trino/table_function_passthrough.sql` | INVALID_ARGUMENT | INVALID_ARGUMENT | 2 | 312 |  | workctl 只读守卫在提交前拒绝透传表函数（未发往 Trino） |
| ✅ trino-11 | `workctl sql query submit --engine trino --file test/sql/fixtures/trino/long_cross_join.sql` | success | success | 0 | 465 | trino@476 | 长查询 |
| ✅ trino-12 | `workctl sql query get --id q-20261017-2854b1` | success | success | 0 | 5874 | workctl-state@476, trino@476 | 5 秒拉取预算内未结束：state=running，stats 显示进度 |
| ✅ trino-13 | `workctl sql query cancel --id q-20261017-2854b1` | success | success | 0 | 666 | trino@476 | DELETE nextUri → GET /v1/query/{id} 确认 USER_CANCELED |
| ✅ trino-14 | `workctl sql query get --id q-20261017-2854b1` | success | success | 0 | 315 | workctl-state@476 | state=cancelled，error.type=USER_CANCELED |
| ✅ trino-15 | `workctl sql query cancel --id q-20261017-2854b1` | CONFLICT | CONFLICT | 9 | 306 |  | 已结束的查询不能再取消 |
