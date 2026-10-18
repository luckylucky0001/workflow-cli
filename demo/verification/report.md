# 隔离演示环境验证记录

> 由 `node scripts/verify-demo.mjs demo/verification/cases.json` 生成于 2026-10-18T06:10:16.348Z；原始结果信封见 `demo/verification/envelopes/`。全部为合成数据。

通过 74 / 74

| # | 命令 | 期望 | 实际 | 退出码 | 耗时 ms | 来源@版本 | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ✅ core-01 | `workctl doctor` | success | success | 0 | 438 | workctl | 自身环境诊断 |
| ✅ core-02 | `workctl capability list --status planned` | success | success | 0 | 472 | workctl | 待接入能力只在目录中 |
| ✅ core-03 | `workctl capability get --name mysql.statement.summary` | success | success | 0 | 393 | workctl |  |
| ✅ core-04 | `workctl resource list --service demo-order --env sandbox` | success | success | 0 | 419 | resource-bindings |  |
| ✅ core-05 | `workctl service dependency list --service demo-order --env sandbox` | success | success | 0 | 435 | resource-bindings |  |
| ✅ core-06 | `workctl auth status --probe` | success | success | 0 | 782 | workctl | 各端点身份与版本，不输出凭据 |
| ✅ core-07 | `workctl access check --capability mysql.query.execute --target demo-mysql` | success | success | 0 | 501 | workctl |  |
| ✅ core-08 | `workctl search query` | INVALID_ARGUMENT | INVALID_ARGUMENT | 2 | 427 |  | 待接入能力不生成命令（unknown command） |
| ✅ infra-01 | `workctl container workload get --service demo-order --env sandbox` | success | success | 0 | 578 | docker@29.8.2 (API 1.56), workctl |  |
| ✅ infra-02 | `workctl container event list --service demo-order --env sandbox --window 6h` | success | success | 0 | 652 | docker@29.8.2 (API 1.56) |  |
| ✅ infra-03 | `workctl container stats get --service demo-order --env sandbox` | success | success | 0 | 1455 | docker@29.8.2 (API 1.56) | 快照，非窗口 |
| ✅ infra-04 | `workctl capacity summary --env sandbox` | success | success | 0 | 2096 | docker@29.8.2 (API 1.56) |  |
| ✅ infra-05 | `workctl network dns get --name localhost` | success | success | 0 | 401 | dns |  |
| ✅ infra-06 | `workctl network backend list --service demo-order --env sandbox` | success | success | 0 | 445 | workctl, docker@29.8.2 (API 1.56), http-probe |  |
| ✅ infra-07 | `workctl network connectivity check --target 127.0.0.1:13306` | success | success | 0 | 893 | tcp |  |
| ✅ infra-08 | `workctl storage volume get --id workctl-demo_mysql-data` | success | success | 0 | 667 | docker@29.8.2 (API 1.56) |  |
| ✅ infra-09 | `workctl storage file stat --path demo/environment/workctl.yaml` | success | success | 0 | 448 | local-filesystem |  |
| ✅ infra-10 | `workctl metric list --resource demo-order` | success | success | 0 | 376 | workctl |  |
| ✅ infra-11 | `workctl metric query --resource demo-order --metric request_rate --window 15m` | success/partial/DATA_UNAVAILABLE | success | 0 | 543 | prometheus@3.5.0, workctl |  |
| ✅ infra-12 | `workctl log query --service demo-order --env sandbox --window 6h --contains request completed --limit 50` | success | success | 0 | 577 | docker@29.8.2 (API 1.56) |  |
| ✅ infra-13 | `workctl trace get --id c683f50c3902a1f658e98fc79ed0589a --window 6h` | success/partial | success | 0 | 530 | docker@29.8.2 (API 1.56) |  |
| ✅ infra-14 | `workctl container workload restart-plan --service demo-order --env sandbox` | success | success | 0 | 520 | docker@29.8.2 (API 1.56), workctl | 只生成计划 |
| ✅ mysql-01 | `workctl mysql instance get --instance demo-mysql` | success | success | 0 | 429 | mysql@8.4.11, workctl |  |
| ✅ mysql-02 | `workctl mysql table get --instance demo-mysql --database demo --table orders` | success | success | 0 | 392 | mysql@8.4.11 |  |
| ✅ mysql-03 | `workctl mysql index list --instance demo-mysql --database demo --table orders` | success | success | 0 | 404 | mysql@8.4.11 |  |
| ✅ mysql-04 | `workctl mysql session list --instance demo-mysql` | success | success | 0 | 363 | mysql@8.4.11 |  |
| ✅ mysql-05 | `workctl mysql lock list --instance demo-mysql` | success | success | 0 | 396 | mysql@8.4.11 |  |
| ✅ mysql-06 | `workctl --timeout 40s mysql statement summary --instance demo-mysql --sample-window 10s` | success | success | 0 | 10441 | mysql@8.4.11 |  |
| ✅ mysql-07 | `workctl mysql slowlog list --instance demo-mysql --since 24h` | success | success | 0 | 703 | mysql@8.4.11 |  |
| ✅ mysql-08 | `workctl mysql query explain --instance demo-mysql --database demo --sql-file demo/scenarios/latency/customer_recent.sql` | success | success | 0 | 586 | mysql@8.4.11 |  |
| ✅ mysql-09 | `workctl mysql query execute --instance demo-mysql --database demo --sql-file demo/scenarios/latency/customer_recent.sql --max-rows 5` | success | success | 0 | 575 | mysql@8.4.11 |  |
| ✅ mysql-10 | `workctl mysql index plan --instance demo-mysql --database demo --table orders --columns customer_id,created_at` | success | success | 0 | 590 | mysql@8.4.11, workctl |  |
| ✅ redis-01 | `workctl redis instance get --instance demo-redis` | success | success | 0 | 460 | redis@7.4.11, workctl |  |
| ✅ redis-02 | `workctl redis info get --instance demo-redis --section memory` | success | success | 0 | 479 | redis@7.4.11 |  |
| ✅ redis-03 | `workctl --timeout 30s redis stats sample --instance demo-redis --duration 5s` | success | success | 0 | 5485 | redis@7.4.11 |  |
| ✅ redis-04 | `workctl redis slowlog list --instance demo-redis --limit 5` | success | success | 0 | 443 | redis@7.4.11 |  |
| ✅ redis-05 | `workctl redis key sample --instance demo-redis --pattern demo:* --max-keys 50` | success | success | 0 | 395 | redis@7.4.11 |  |
| ✅ redis-06 | `workctl redis key inspect --instance demo-redis --key demo:customer:13:history` | success | success | 0 | 470 | redis@7.4.11 |  |
| ✅ redis-07 | `workctl redis key hot --instance demo-redis --pattern demo:*` | success | success | 0 | 469 | redis@7.4.11 |  |
| ✅ redis-08 | `workctl redis config get --instance demo-redis --pattern maxmemory*` | success | success | 0 | 491 | redis@7.4.11 |  |
| ✅ mq-01 | `workctl mq consumer lag --cluster demo-mq --group demo-consumer` | success | success | 0 | 914 | kafka@inter.broker.protocol.version=3.9-IV0 | 插件能力（demo-mq） |
| ✅ mq-02 | `workctl mq topic get --cluster demo-mq --topic demo.order.events` | success | success | 0 | 701 | kafka@inter.broker.protocol.version=3.9-IV0 |  |
| ✅ mq-03 | `workctl mq consumer lag --cluster demo-mq --group no-such-group` | NOT_FOUND | NOT_FOUND | 5 | 616 |  |  |
| ✅ offline-01 | `workctl offline workflow get --id demo-daily-orders` | success | success | 0 | 778 | airflow@2.10.5, catalog |  |
| ✅ offline-02 | `workctl offline task get --workflow demo-daily-orders --task aggregate_orders` | success | success | 0 | 517 | airflow@2.10.5 |  |
| ✅ offline-03 | `workctl offline run list --workflow demo-daily-orders --data-date 2026-10-16 --timezone Asia/Shanghai` | success | success | 0 | 629 | airflow@2.10.5 |  |
| ✅ offline-04 | `workctl --timeout 60s offline run get --id demo__2026-10-16__wrong_partition --workflow demo-daily-orders` | success | success | 0 | 1106 | airflow@2.10.5, spark@3.5.5, catalog, local-filesystem, workctl-state | 调度成功 / 计算成功 / 分区缺失 |
| ✅ offline-05 | `workctl --timeout 60s offline run get --id demo__2026-10-15__ok --workflow demo-daily-orders` | success | success | 0 | 1270 | airflow@2.10.5, spark@3.5.5, catalog, local-filesystem, workctl-state |  |
| ✅ offline-06 | `workctl --timeout 60s offline dependency list --run-id demo__2026-10-14__missing_upstream --workflow demo-daily-orders --direction upstream` | success | success | 0 | 1209 | airflow@2.10.5, catalog, local-filesystem, binding-file | 上游分区缺失 |
| ✅ offline-07 | `workctl offline log get --run-id demo__2026-10-16__wrong_partition --workflow demo-daily-orders --task aggregate_orders --limit-lines 50` | success | success | 0 | 759 | airflow@2.10.5 |  |
| ✅ offline-08 | `workctl offline freshness check --dataset analytics.daily_orders --data-date 2026-10-16 --timezone Asia/Shanghai` | success | success | 0 | 679 | catalog, local-filesystem, airflow@2.10.5 |  |
| ✅ offline-09 | `workctl --timeout 60s offline backfill plan --workflow demo-daily-orders --from 2026-10-14 --to 2026-10-16 --timezone Asia/Shanghai` | success | success | 0 | 1911 | airflow@2.10.5, catalog, local-filesystem | 只生成计划 |
| ✅ offline-10 | `workctl offline backfill get --id op-20261018-4ea114` | success | success | 0 | 465 | workctl |  |
| ✅ compute-01 | `workctl compute job get --id local-1792300311012` | success | success | 0 | 484 | spark@3.5.5, spark |  |
| ✅ compute-02 | `workctl compute stage list --job-id local-1792300311012` | success | success | 0 | 594 | spark@3.5.5 |  |
| ✅ compute-03 | `workctl compute log get --job-id local-1792300311012 --limit-lines 30` | success | success | 0 | 499 | filesystem |  |
| ✅ compute-04 | `workctl compute queue get --id demo-batch-pool` | success | success | 0 | 588 | airflow@2.10.5 |  |
| ✅ sql-01 | `workctl sql query submit --engine spark --file demo/offline-workflows/sql/examples/daily_orders_by_date.sql` | success | success | 0 | 465 | spark |  |
| ✅ sql-02 | `workctl sql query get --id q-20261018-bdd3f2` | success | success | 0 | 425 | workctl-state | 异步：状态以 data.state 为准 |
| ✅ sql-03 | `workctl sql query submit --engine hive --file demo/offline-workflows/sql/examples/daily_orders_by_date.sql` | UNSUPPORTED | UNSUPPORTED | 8 | 499 |  | Hive 引擎待接入（Trino 已接入，见 cases.trino.json） |
| ✅ data-01 | `workctl data table get --catalog demo --table analytics.daily_orders` | success | success | 0 | 761 | file-catalog, local-filesystem, binding-file |  |
| ✅ data-02 | `workctl data partition list --catalog demo --table analytics.daily_orders` | success | success | 0 | 565 | file-catalog, local-filesystem |  |
| ✅ data-03 | `workctl data partition get --catalog demo --table analytics.daily_orders --partition dt=2026-10-16` | success | success | 0 | 784 | file-catalog, local-filesystem | state=missing 是结果，不是错误 |
| ✅ data-04 | `workctl data lineage get --catalog demo --table analytics.daily_orders --direction upstream` | success | success | 0 | 655 | file-catalog, sql-file |  |
| ✅ data-05 | `workctl data lineage get --catalog demo --table analytics.daily_orders --direction downstream` | success | success | 0 | 612 | file-catalog, sql-file |  |
| ✅ data-06 | `workctl data quality check --dataset demo.daily_orders --partition dt=2026-10-17 --ruleset demo-daily-rules` | success | success | 0 | 609 | file-catalog, quality-ruleset, local-filesystem | 捕获错误分区：order_date 与 dt 不一致 |
| ✅ data-07 | `workctl data quality check --dataset demo.ods.orders --partition dt=2026-10-16 --ruleset demo-ods-rules` | success | success | 0 | 1915 | file-catalog, quality-ruleset, local-filesystem |  |
| ✅ op-01 | `workctl operation plan --action container.restart --param service=demo-order --param env=sandbox` | success | success | 0 | 442 | workctl |  |
| ✅ op-02 | `workctl operation get --id op-20261018-012047` | success | success | 0 | 541 | workctl |  |
| ✅ op-03 | `workctl operation execute --id op-20261018-012047 --confirm wrong` | PRECONDITION_FAILED | PRECONDITION_FAILED | 9 | 465 |  | 确认不一致拒绝执行 |
| ✅ op-04 | `workctl operation list` | success | success | 0 | 511 | workctl |  |
| ✅ op-05 | `workctl --timeout 90s operation execute --id op-20261018-012047 --confirm op-20261018-012047` | success | success | 0 | 4025 | workctl | 隔离环境中真实执行重启（allow_execute=true） |
| ✅ op-06 | `workctl operation get --id op-20261018-012047` | success | success | 0 | 492 | workctl | 状态与历史：planned → running → succeeded |
| ✅ op-07 | `workctl operation execute --id op-20261018-012047 --confirm op-20261018-012047` | CONFLICT | CONFLICT | 9 | 429 |  | 已执行的计划不能再次执行 |
