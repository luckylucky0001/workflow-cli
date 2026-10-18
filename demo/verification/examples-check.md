# 文档命令实跑记录（examples-check）

> 由 `node scripts/examples-check.mjs` 生成于 2026-10-18T05:52:49.036Z。逐条执行能力定义中的 `examples`（command-reference 与 `--help` 展示的内容）以及 quickstart / walkthrough / README / guides / skills 中的 `workctl` 命令，全部 `--json`。
> 默认 profile `demo/environment/workctl.yaml`；Kubernetes 专属示例（失败时）再用 `demo/environment/k8s/workctl.k8s.yaml` 重试。`operation=execute`、`operation execute`、重启、安装、Airflow 3 profile 一律跳过不执行。
> 占位符替换：`<trace_id>` 取自 `log query`，`<app_id>` 取自 `offline run get`，`op-…`/`<plan>` 取自 `offline backfill plan`，`q-…`/`<q>` 取自 `sql query submit`，`q.sql` 为按引擎生成的临时只读 SQL。
> `expected-error`：失败的错误码在该能力的说明（notes）或所在文档中有说明（如示例中的虚构 id → `NOT_FOUND`）。

| | 总数 | pass | expected-error | fail | skipped |
|---|---|---|---|---|---|
| 能力 examples | 115 | 114 | 0 | 0 | 1 |
| 文档命令 | 75 | 63 | 1 | 0 | 11 |
| Skill 命令 | 109 | 99 | 0 | 0 | 10 |

链式取值：`trace_id=d995b0c0ce3a0507d9d84184dec8014b`，`app_id=local-1792300311012`，`plan_id=op-20261018-b05701`，`sql_query_id=q-20261018-5aed7e`，`replicaset=demo-order-77fdb45bf4`

## 能力 examples

| 结果 | 位置 | 命令 | profile | 错误码 / 说明 |
|---|---|---|---|---|
| pass | capability.list | `workctl --json capability list --domain mysql` | docker |  |
| pass | capability.list | `workctl capability list --status planned` | docker |  |
| pass | capability.get | `workctl capability get --name mysql.table.get` | docker |  |
| pass | resource.list | `workctl --json resource list --service demo-order --env sandbox` | docker |  |
| pass | service.dependency.list | `workctl --json service dependency list --service demo-order --env sandbox` | docker |  |
| pass | operation.plan | `workctl --json operation plan --action container.restart --param service=demo-order --param env=sandbox` | docker |  |
| pass | container.workload.get | `workctl container workload get --service demo-order --env sandbox` | docker |  |
| pass | container.event.list | `workctl container event list --service demo-order --window 1h` | docker |  |
| pass | container.stats.get | `workctl container stats get --service demo-order` | docker |  |
| pass | container.capacity.summary | `workctl capacity summary --env sandbox` | docker |  |
| pass | container.workload.restart_plan | `workctl container workload restart-plan --service demo-order --env sandbox` | docker |  |
| pass | network.dns.get | `workctl network dns get --name localhost` | docker |  |
| pass | network.backend.list | `workctl network backend list --service demo-order` | docker |  |
| pass | network.connectivity.check | `workctl network connectivity check --target 127.0.0.1:13306 --count 3` | docker |  |
| pass | storage.volume.get | `workctl storage volume get --id workctl-demo_mysql-data` | docker |  |
| pass | storage.file.stat | `workctl storage file stat --path demo/environment/workctl.yaml` | docker |  |
| pass | observability.metric.query | `workctl metric query --resource demo-order --metric request_latency --window 15m` | docker |  |
| pass | observability.metric.query | `workctl metric query --resource demo-order --promql 'sum by (route) (rate(http_requests_total{service="demo-order"}[1m]))'` | docker |  |
| pass | observability.metric.list | `workctl metric list --resource demo-order` | docker |  |
| pass | observability.log.query | `workctl log query --service demo-order --window 15m --level error` | docker |  |
| pass | observability.log.query | `workctl log query --service demo-order --trace-id <trace_id> --include-spans`<br>替换：<trace_id> -> d995b0c0ce3a0507d9d84184dec8014b | docker |  |
| pass | observability.trace.get | `workctl trace get --id <trace_id> --window 1h`<br>替换：<trace_id> -> d995b0c0ce3a0507d9d84184dec8014b | docker |  |
| pass | mysql.instance.get | `workctl mysql instance get --instance demo-mysql` | docker |  |
| pass | mysql.table.get | `workctl mysql table get --instance demo-mysql --database demo --table orders` | docker |  |
| pass | mysql.index.list | `workctl mysql index list --instance demo-mysql --database demo --table orders` | docker |  |
| pass | mysql.session.list | `workctl mysql session list --instance demo-mysql` | docker |  |
| pass | mysql.session.list | `workctl mysql session list --instance demo-mysql --include-idle` | docker |  |
| pass | mysql.lock.list | `workctl mysql lock list --instance demo-mysql` | docker |  |
| pass | mysql.statement.summary | `workctl mysql statement summary --instance demo-mysql --sample-window 5s --top 10` | docker |  |
| pass | mysql.statement.summary | `workctl --timeout 60s mysql statement summary --instance demo-mysql --sample-window 30s --database demo` | docker |  |
| pass | mysql.statement.summary | `workctl mysql statement summary --instance demo-mysql --sample-window 0` | docker |  |
| pass | mysql.slowlog.list | `workctl mysql slowlog list --instance demo-mysql --since 1h --limit 20` | docker |  |
| pass | mysql.query.explain | `workctl mysql query explain --instance demo-mysql --database demo --sql "SELECT * FROM orders WHERE customer_id = 42"` | docker |  |
| pass | mysql.query.explain | `workctl mysql query explain --instance demo-mysql --database demo --sql-file ./q.sql`<br>替换：q.sql -> mysql sample (SELECT * FROM orders WHERE customer_id = 42) | docker |  |
| pass | mysql.query.analyze | `workctl mysql query analyze --instance demo-mysql --database demo --sql "SELECT * FROM orders WHERE customer_id = 42"` | docker |  |
| pass | mysql.query.analyze | `workctl mysql query analyze --instance demo-mysql --database demo --sql-file ./q.sql`<br>替换：q.sql -> mysql sample (SELECT * FROM orders WHERE customer_id = 42) | docker |  |
| pass | mysql.query.execute | `workctl mysql query execute --instance demo-mysql --database demo --sql "SELECT id, status FROM orders WHERE customer_id = 42" --max-rows 20` | docker |  |
| pass | mysql.query.execute | `workctl mysql query execute --instance demo-mysql --database demo --sql-file ./q.sql --max-rows 20`<br>替换：q.sql -> mysql sample (SELECT * FROM orders WHERE customer_id = 42) | docker |  |
| pass | mysql.index.plan | `workctl mysql index plan --instance demo-mysql --database demo --table orders --columns customer_id` | docker |  |
| pass | postgres.instance.get | `workctl pg instance get --instance demo-postgres` | docker |  |
| pass | postgres.database.list | `workctl pg database list --instance demo-postgres` | docker |  |
| pass | postgres.table.get | `workctl pg table get --instance demo-postgres --database demo_orders --table orders` | docker |  |
| pass | postgres.table.get | `workctl pg table get --instance demo-postgres --schema public --table order_items` | docker |  |
| pass | postgres.session.list | `workctl pg session list --instance demo-postgres` | docker |  |
| pass | postgres.session.list | `workctl pg session list --instance demo-postgres --include-idle` | docker |  |
| pass | postgres.lock.list | `workctl pg lock list --instance demo-postgres` | docker |  |
| pass | postgres.statement.summary | `workctl pg statement summary --instance demo-postgres --sample-window 10s --top 10` | docker |  |
| pass | postgres.statement.summary | `workctl pg statement summary --instance demo-postgres --sample-window 0 --order-by mean_time --database demo_orders` | docker |  |
| pass | postgres.query.explain | `workctl pg query explain --instance demo-postgres --sql "SELECT * FROM orders WHERE customer_id = 42"` | docker |  |
| pass | postgres.query.explain | `workctl pg query explain --instance demo-postgres --database demo_orders --sql-file ./q.sql`<br>替换：q.sql -> pg sample (SELECT * FROM orders WHERE customer_id = 42) | docker |  |
| pass | postgres.query.analyze | `workctl pg query analyze --instance demo-postgres --sql "SELECT * FROM orders WHERE customer_id = 42"` | docker |  |
| pass | postgres.query.analyze | `workctl pg query analyze --instance demo-postgres --database demo_orders --sql-file ./q.sql`<br>替换：q.sql -> pg sample (SELECT * FROM orders WHERE customer_id = 42) | docker |  |
| pass | postgres.query.run | `workctl pg query run --instance demo-postgres --sql "SELECT id, status, amount FROM orders WHERE customer_id = 42" --max-rows 20` | docker |  |
| pass | postgres.query.run | `workctl pg query run --instance demo-postgres --database demo_orders --sql-file ./q.sql --max-rows 50`<br>替换：q.sql -> pg sample (SELECT * FROM orders WHERE customer_id = 42) | docker |  |
| pass | redis.instance.get | `workctl redis instance get --instance demo-redis` | docker |  |
| pass | redis.info.get | `workctl redis info get --instance demo-redis --section stats` | docker |  |
| pass | redis.stats.sample | `workctl redis stats sample --instance demo-redis --duration 10s` | docker |  |
| pass | redis.stats.sample | `workctl --timeout 60s redis stats sample --instance demo-redis --duration 30s` | docker |  |
| pass | redis.slowlog.list | `workctl redis slowlog list --instance demo-redis --limit 10` | docker |  |
| pass | redis.key.inspect | `workctl redis key inspect --instance demo-redis --key demo:order:10` | docker |  |
| pass | redis.key.inspect | `workctl redis key inspect --instance demo-redis --key demo:customer:1:history --include-value` | docker |  |
| pass | redis.key.sample | `workctl redis key sample --instance demo-redis --pattern "demo:*" --max-keys 200` | docker |  |
| pass | redis.key.hot | `workctl redis key hot --instance demo-redis --pattern "demo:*" --max-keys 500` | docker |  |
| pass | redis.config.get | `workctl redis config get --instance demo-redis --pattern "maxmemory*"` | docker |  |
| pass | offline.workflow.get | `workctl offline workflow get --id demo-daily-orders` | docker |  |
| pass | offline.task.get | `workctl offline task get --workflow demo-daily-orders --task aggregate_orders` | docker |  |
| pass | offline.run.list | `workctl offline run list --workflow demo-daily-orders --data-date 2026-10-16 --timezone Asia/Shanghai` | docker |  |
| pass | offline.run.get | `workctl offline run get --workflow demo-daily-orders --id demo__2026-10-16__wrong_partition` | docker |  |
| pass | offline.dependency.list | `workctl offline dependency list --workflow demo-daily-orders --run-id demo__2026-10-14__missing_upstream --direction upstream` | docker |  |
| pass | offline.log.get | `workctl offline log get --workflow demo-daily-orders --run-id demo__2026-10-16__wrong_partition --task aggregate_orders --limit-lines 50` | docker |  |
| pass | offline.backfill.plan | `workctl offline backfill plan --workflow demo-daily-orders --from 2026-10-14 --to 2026-10-16 --timezone Asia/Shanghai` | docker |  |
| pass | offline.backfill.get | `workctl offline backfill get --id op-20261017-abc123`<br>替换：op-20261017-abc123 -> op-20261018-b05701 | docker |  |
| pass | offline.freshness.check | `workctl offline freshness check --dataset analytics.daily_orders --data-date 2026-10-16` | docker |  |
| pass | compute.job.get | `workctl compute job get --id <app_id>`<br>替换：<app_id> -> local-1792300311012 | docker |  |
| pass | compute.stage.list | `workctl compute stage list --job-id <app_id>`<br>替换：<app_id> -> local-1792300311012 | docker |  |
| pass | compute.stage.list | `workctl compute stage list --job-id <app_id> --status failed`<br>替换：<app_id> -> local-1792300311012 | docker |  |
| pass | compute.log.get | `workctl compute log get --job-id <app_id> --limit-lines 100`<br>替换：<app_id> -> local-1792300311012 | docker |  |
| pass | compute.queue.get | `workctl compute queue get --id demo-batch-pool` | docker |  |
| pass | sql.query.submit | `workctl sql query submit --engine spark --file demo/offline-workflows/sql/examples/daily_orders_by_date.sql` | docker |  |
| pass | sql.query.submit | `workctl sql query submit --engine trino --file q.sql --catalog tpch --schema tiny`<br>替换：q.sql -> trino sample (SELECT name FROM nation ORDER BY nationkey LIMIT 5) | docker |  |
| pass | sql.query.get | `workctl sql query get --id q-20261017-1a2b3c`<br>替换：q-20261017-1a2b3c -> q-20261018-5aed7e | docker |  |
| skipped | sql.query.cancel | `workctl sql query cancel --id q-20261017-1a2b3c` |  | operation=execute |
| pass | data.table.get | `workctl data table get --catalog demo --table analytics.daily_orders` | docker |  |
| pass | data.partition.list | `workctl data partition list --catalog demo --table ods.orders --from 2026-10-10 --to 2026-10-16` | docker |  |
| pass | data.partition.get | `workctl data partition get --catalog demo --table analytics.daily_orders --partition 'dt=2026-10-16'` | docker |  |
| pass | data.lineage.get | `workctl data lineage get --catalog demo --table analytics.daily_orders --direction upstream` | docker |  |
| pass | data.lineage.get | `workctl data lineage get --catalog demo --table ods.orders --direction downstream --depth 3` | docker |  |
| pass | data.quality.check | `workctl data quality check --dataset demo.daily_orders --partition 'dt=2026-10-16' --ruleset demo-daily-rules` | docker |  |
| pass | config.get | `workctl config get --service demo-order --env sandbox` | docker |  |
| pass | config.get | `workctl config get --service demo-order --key cache.ttl_seconds` | docker |  |
| pass | config.get | `workctl config get --service demo-payment --env sandbox` | docker |  |
| pass | config.get | `workctl config get --service demo-inventory --endpoint consul/demo-consul` | docker |  |
| pass | config.diff | `workctl config diff --service demo-order --env sandbox --from-rev 2` | docker |  |
| pass | config.diff | `workctl config diff --service demo-order --key cache.ttl_seconds` | docker |  |
| pass | config.diff | `workctl config diff --service demo-payment --key order.timeout_ms` | docker |  |
| pass | discovery.list | `workctl discovery list --service demo-order` | docker |  |
| pass | discovery.list | `workctl discovery list --service demo-order --env sandbox --healthy-only` | docker |  |
| pass | discovery.list | `workctl discovery list --service demo-payment` | docker |  |
| pass | discovery.list | `workctl discovery list --service demo-inventory` | docker |  |
| pass | deploy.release.list | `workctl deploy release list --service demo-order --env sandbox --window 7d` | docker |  |
| pass | deploy.release.get | `workctl deploy release get --service demo-order --env sandbox --id 3` | docker |  |
| pass | deploy.release.get | `workctl deploy release get --service demo-order --id <replicaset>`<br>替换：<replicaset> -> demo-order-77fdb45bf4 | k8s |  |
| pass | deploy.status.get | `workctl deploy status get --service demo-order --env sandbox` | docker |  |
| pass | deploy.rollback.plan | `workctl deploy rollback plan --service demo-order --env sandbox` | docker |  |
| pass | deploy.rollback.plan | `workctl deploy rollback plan --service demo-order --to 3` | docker |  |
| pass | mq.consumer.lag | `workctl mq consumer lag --cluster demo-mq --group demo-consumer` | docker |  |
| pass | mq.consumer.lag | `workctl mq consumer lag --cluster demo-mq --group demo-consumer --topic demo.order.events --json` | docker |  |
| pass | mq.topic.get | `workctl mq topic get --cluster demo-mq --topic demo.order.events` | docker |  |
| pass | mq.topic.list | `workctl mq topic list --cluster demo-mq` | docker |  |
| pass | mq.topic.list | `workctl mq topic list --cluster demo-mq --include-internal` | docker |  |
| pass | search.cluster.get | `workctl search cluster get --cluster demo-search` | docker |  |
| pass | search.index.get | `workctl search index get --cluster demo-search --index demo-orders` | docker |  |
| pass | search.index.get | `workctl search index get --cluster demo-search --index demo-orders-current --json` | docker |  |
| pass | search.query | `workctl search query --cluster demo-search --index demo-orders --query "status:paid AND city:shanghai"` | docker |  |
| pass | search.query | `workctl search query --cluster demo-search --index demo-orders --dsl-file "$PWD/demo/scenarios/search/dsl/paid_by_city.json"` | docker |  |

## 文档命令

| 结果 | 位置 | 命令 | profile | 错误码 / 说明 |
|---|---|---|---|---|
| pass | docs/quickstart.md:7 | `workctl --version` | docker |  |
| pass | docs/quickstart.md:8 | `workctl capability list` | docker |  |
| pass | docs/quickstart.md:41 | `workctl --json auth status --probe` | docker |  |
| pass | docs/quickstart.md:42 | `workctl --json access check --capability mysql.query.execute --target demo-mysql` | docker |  |
| pass | docs/quickstart.md:48 | `workctl --json mysql table get --instance demo-mysql --database demo --table orders` | docker |  |
| pass | docs/quickstart.md:49 | `workctl --json redis info get --instance demo-redis --section memory` | docker |  |
| pass | docs/quickstart.md:50 | `workctl --json offline run list --workflow demo-daily-orders --data-date 2026-10-16 --timezone Asia/Shanghai` | docker |  |
| skipped | docs/quickstart.md:69 | `workctl skills install --dir .claude/skills` |  | installs files |
| skipped | docs/quickstart.md:70 | `workctl mcp serve` |  | long-running server |
| pass | demo/walkthrough.md:15 | `workctl doctor` | docker |  |
| pass | demo/walkthrough.md:18 | `workctl capability get --name mysql.statement.summary` | docker |  |
| pass | demo/walkthrough.md:25 | `workctl service dependency list --service demo-order --env sandbox` | docker |  |
| pass | demo/walkthrough.md:26 | `workctl container workload get --service demo-order --env sandbox` | docker |  |
| pass | demo/walkthrough.md:27 | `workctl container event list --service demo-order --env sandbox --window 1h` | docker |  |
| pass | demo/walkthrough.md:28 | `workctl container stats get --service demo-order --env sandbox` | docker |  |
| pass | demo/walkthrough.md:29 | `workctl capacity summary --env sandbox` | docker |  |
| pass | demo/walkthrough.md:30 | `workctl network backend list --service demo-order --env sandbox` | docker |  |
| pass | demo/walkthrough.md:31 | `workctl metric query --resource demo-order --metric request_latency --window 15m` | docker |  |
| pass | demo/walkthrough.md:32 | `workctl container workload restart-plan --service demo-order --env sandbox` | docker |  |
| pass | demo/walkthrough.md:52 | `workctl metric query --resource demo-order --metric cache_hit_ratio --window 15m` | docker |  |
| pass | demo/walkthrough.md:53 | `workctl metric query --resource demo-order --metric db_query_rate --window 15m` | docker |  |
| pass | demo/walkthrough.md:54 | `workctl log query --service demo-order --env sandbox --window 15m --contains "cache mode changed"` | docker |  |
| pass | demo/walkthrough.md:55 | `workctl log query --service demo-order --env sandbox --window 15m --level error` | docker |  |
| pass | demo/walkthrough.md:56 | `workctl trace get --id <最慢请求的 trace_id>`<br>替换：<最慢请求的 trace_id> -> d995b0c0ce3a0507d9d84184dec8014b | docker |  |
| pass | demo/walkthrough.md:57 | `workctl --timeout 30s redis stats sample --instance demo-redis --duration 10s` | docker |  |
| pass | demo/walkthrough.md:58 | `workctl --timeout 40s mysql statement summary --instance demo-mysql --sample-window 10s` | docker |  |
| pass | demo/walkthrough.md:59 | `workctl mysql query explain --instance demo-mysql --database demo --sql-file demo/scenarios/latency/customer_recent.sql` | docker |  |
| pass | demo/walkthrough.md:60 | `workctl mysql query analyze --instance demo-mysql --database demo --sql-file demo/scenarios/latency/customer_recent.sql` | docker |  |
| pass | demo/walkthrough.md:61 | `workctl mysql index plan --instance demo-mysql --database demo --table orders --columns customer_id,created_at` | docker |  |
| pass | demo/walkthrough.md:73 | `workctl offline run list --workflow demo-daily-orders --data-date 2026-10-16 --timezone Asia/Shanghai` | docker |  |
| pass | demo/walkthrough.md:74 | `workctl --timeout 60s offline run get --id demo__2026-10-16__wrong_partition --workflow demo-daily-orders` | docker |  |
| pass | demo/walkthrough.md:76 | `workctl offline log get --run-id demo__2026-10-16__wrong_partition --workflow demo-daily-orders --task aggregate_orders` | docker |  |
| pass | demo/walkthrough.md:77 | `workctl compute job get --id <app_id>`<br>替换：<app_id> -> local-1792300311012 | docker |  |
| pass | demo/walkthrough.md:78 | `workctl compute stage list --job-id <app_id>`<br>替换：<app_id> -> local-1792300311012 | docker |  |
| pass | demo/walkthrough.md:79 | `workctl data partition get --catalog demo --table analytics.daily_orders --partition dt=2026-10-16` | docker |  |
| pass | demo/walkthrough.md:80 | `workctl data quality check --dataset demo.daily_orders --partition dt=2026-10-17 --ruleset demo-daily-rules` | docker |  |
| pass | demo/walkthrough.md:82 | `workctl data lineage get --catalog demo --table analytics.daily_orders --direction downstream` | docker |  |
| pass | demo/walkthrough.md:83 | `workctl --timeout 60s offline dependency list --run-id demo__2026-10-14__missing_upstream --workflow demo-daily-orders --direction upstream` | docker |  |
| pass | demo/walkthrough.md:85 | `workctl --timeout 60s offline backfill plan --workflow demo-daily-orders --from 2026-10-14 --to 2026-10-16 --timezone Asia/Shanghai` | docker |  |
| skipped | demo/walkthrough.md:98 | `workctl plugin install --file plugins/demo-mq/dist/demo-mq-plugin.tgz` |  | installs files |
| pass | demo/walkthrough.md:98 | `workctl --json capability list --domain mq` | docker |  |
| pass | demo/walkthrough.md:98 | `workctl mq consumer lag --help` | docker |  |
| pass | demo/walkthrough.md:98 | `workctl --json mq consumer lag --cluster demo-mq --group demo-consumer` | docker |  |
| skipped | demo/walkthrough.md:99 | `workctl plugin install --file plugins/demo-search/dist/demo-search-plugin.tgz` |  | installs files |
| pass | demo/walkthrough.md:99 | `workctl --json capability list --domain search` | docker |  |
| pass | demo/walkthrough.md:99 | `workctl --json search index get --cluster demo-search --index demo-orders-current` | docker |  |
| pass | demo/walkthrough.md:99 | `workctl --json search query --cluster demo-search --index demo-orders-all --dsl-file demo/scenarios/search/dsl/latest_across_archive.json` | docker |  |
| pass | demo/walkthrough.md:100 | `workctl --json config get --service demo-order --env sandbox` | docker |  |
| pass | demo/walkthrough.md:100 | `workctl --json config diff --service demo-order --key cache.ttl_seconds` | docker |  |
| pass | demo/walkthrough.md:100 | `workctl --json discovery list --service demo-order --healthy-only` | docker |  |
| pass | demo/walkthrough.md:101 | `workctl --json config get --service demo-payment` | docker |  |
| pass | demo/walkthrough.md:101 | `workctl --json config diff --service demo-payment --key <k>`<br>替换：<k> -> order.timeout_ms | docker |  |
| expected-error | demo/walkthrough.md:101 | `workctl --json config diff --service demo-inventory --key <k>`<br>替换：<k> -> cache.ttl_seconds | docker | DATA_UNAVAILABLE Consul KV 不保留历史，无法给出 config/sandbox/demo-inventory/cache.ttl_seconds 的上一版本 |
| pass | demo/walkthrough.md:102 | `workctl --json deploy release list --service demo-order --env sandbox` | docker |  |
| pass | demo/walkthrough.md:102 | `WORKCTL_CONFIG=demo/environment/k8s/workctl.k8s.yaml workctl --json deploy status get --service demo-order --env sandbox` | k8s |  |
| pass | demo/walkthrough.md:104 | `WORKCTL_CONFIG=demo/environment/k8s/workctl.k8s.yaml workctl container workload get --service demo-order --env sandbox` | k8s |  |
| pass | demo/walkthrough.md:105 | `workctl sql query submit --engine trino --file test/sql/fixtures/trino/orders_by_status.sql` | docker |  |
| pass | demo/walkthrough.md:105 | `workctl sql query get --id <q>`<br>替换：<q> -> q-20261018-5aed7e | docker |  |
| pass | README.md:104 | `workctl --help` | docker |  |
| pass | docs/guides/infrastructure.md:3 | `workctl capability get --name <name>`<br>替换：<name> -> mysql.table.get | docker |  |
| pass | docs/guides/infrastructure.md:50 | `workctl operation get --id <plan>`<br>替换：<plan> -> op-20261018-b05701 | docker |  |
| skipped | docs/guides/infrastructure.md:51 | `workctl operation execute --id <plan> --confirm <plan>` |  | operation execute |
| pass | docs/guides/infrastructure.md:52 | `workctl container workload get --service demo-order` | docker |  |
| pass | docs/guides/infrastructure.md:53 | `workctl network backend list --service demo-order` | docker |  |
| pass | docs/guides/infrastructure.md:289 | `workctl capability list --status planned` | docker |  |
| skipped | docs/guides/mysql.md:89 | `workctl access check` | docker | INVALID_ARGUMENT |
| pass | docs/guides/mysql.md:89 | `workctl auth status --probe` | docker |  |
| skipped | docs/guides/offline.md:101 | `workctl operation execute --id op-20261017-xxxxxx --confirm op-20261017-xxxxxx` |  | operation execute |
| pass | docs/guides/offline.md:102 | `workctl offline backfill get --id op-20261017-xxxxxx`<br>替换：op-20261017-xxxxxx -> op-20261018-b05701 | docker |  |
| skipped | docs/guides/offline.md:205 | `WORKCTL_CONFIG=demo/environment/workctl.af3.yaml workctl --json offline run get --workflow demo-daily-orders --id demo__2026-10-16__wrong_partition` |  | Airflow 3 profile (not running in this check) |
| pass | docs/guides/operations.md:30 | `workctl --json operation plan --action container.restart --param service=demo-order --param env=sandbox` | docker |  |
| skipped | docs/guides/operations.md:31 | `workctl --json operation execute --id op-20261017-abc123 --confirm op-20261017-abc123` |  | operation execute |
| pass | docs/guides/operations.md:32 | `workctl --json operation get --id op-20261017-abc123`<br>替换：op-20261017-abc123 -> op-20261018-b05701 | docker |  |
| skipped | docs/guides/operations.md:49 | `workctl mcp serve --allow-execute` |  | long-running server |
| skipped | docs/guides/operations.md:50 | `workctl mcp serve --domain X` |  | long-running server |

## Skill 命令（通用占位符 <svc>/<i>/<db.table>… 替换为演示环境的值）

| 结果 | 位置 | 命令 | profile | 错误码 / 说明 |
|---|---|---|---|---|
| pass | skills/data-validation/SKILL.md:14 | `workctl --json data table get --catalog demo --table <db.table>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/data-validation/SKILL.md:15 | `workctl --json data partition list --table <db.table> [--from D1 --to D2]`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/data-validation/SKILL.md:16 | `workctl --json data partition get --table <db.table> --partition 'dt=YYYY-MM-DD'`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/data-validation/SKILL.md:17 | `workctl --json data quality check --dataset demo.<db>.<table> --partition 'dt=YYYY-MM-DD' [--ruleset <name>] [--sample-rows N]`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/data-validation/SKILL.md:18 | `workctl --json data lineage get --table <db.table> --direction upstream\\|downstream [--depth N]`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/deploy-operations/SKILL.md:25 | `workctl --json deploy release list --service <svc> --window 24h`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/deploy-operations/SKILL.md:26 | `workctl --json deploy status get --service <svc>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/deploy-operations/SKILL.md:33 | `workctl --json deploy release get --service <svc> --id <release id>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/deploy-operations/SKILL.md:49 | `workctl --json deploy rollback plan --service <svc>`<br>替换：skill placeholders -> demo values | docker |  |
| skipped | skills/deploy-operations/SKILL.md:49 | `workctl --json operation execute --id <id> --confirm <id>` |  | operation execute |
| pass | skills/deploy-operations/SKILL.md:49 | `workctl --json operation get --id <id>`<br>替换：skill placeholders -> demo values; <plan> -> op-20261018-b05701 | docker |  |
| pass | skills/deploy-operations/SKILL.md:52 | `workctl --json deploy rollback plan --service <svc> [--to <release id>]`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/enterprise-infra/SKILL.md:16 | `workctl --json resource list --service <svc> --env <env>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/enterprise-infra/SKILL.md:16 | `workctl --json service dependency list --service <svc>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/enterprise-infra/SKILL.md:17 | `workctl --json capability list [--domain mysql]`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/enterprise-infra/SKILL.md:18 | `workctl --json capability get --name <cap>`<br>替换：skill placeholders -> demo values | docker |  |
| skipped | skills/enterprise-infra/SKILL.md:36 | `workctl --json operation plan --action <type> ...` |  | template with "..." (not runnable as written) |
| pass | skills/infra-operations/SKILL.md:23 | `workctl --json container workload get --service <svc>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/infra-operations/SKILL.md:24 | `workctl --json network backend list --service <svc>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/infra-operations/SKILL.md:32 | `workctl --json container event list --service <svc> --window 6h`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/infra-operations/SKILL.md:33 | `workctl --json log query --service <svc> --window 30m --level error`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/infra-operations/SKILL.md:42 | `workctl --json network dns get --name <host>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/infra-operations/SKILL.md:43 | `workctl --json network connectivity check --target <host:port> --count 5`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/infra-operations/SKILL.md:51 | `workctl --json storage volume get --id <volume>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/infra-operations/SKILL.md:52 | `workctl --json storage file stat --path <path>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/infra-operations/SKILL.md:59 | `workctl --json container workload restart-plan --service <svc> --env <env>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/infra-operations/SKILL.md:79 | `workctl --json config get --service <svc> [--key <name>]`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/infra-operations/SKILL.md:80 | `workctl --json config diff --service <svc> --from-rev <rev>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/infra-operations/SKILL.md:81 | `workctl --json discovery list --service <svc> [--healthy-only]`<br>替换：skill placeholders -> demo values | docker |  |
| skipped | skills/mq-operations/SKILL.md:10 | `workctl --json plugin install --file <demo-mq-plugin.tgz>` |  | installs files |
| pass | skills/mq-operations/SKILL.md:16 | `workctl --json mq consumer lag --cluster <c> --group <g> [--topic <t>]`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/mq-operations/SKILL.md:17 | `workctl --json mq topic get --cluster <c> --topic <t>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/mq-operations/SKILL.md:18 | `workctl --json mq topic list --cluster <c> [--include-internal]`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/mysql-operations/SKILL.md:24 | `workctl --json mysql instance get --instance <i>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/mysql-operations/SKILL.md:25 | `workctl --json --timeout 45s mysql statement summary --instance <i> --sample-window 30s --top 10`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/mysql-operations/SKILL.md:26 | `workctl --json mysql slowlog list --instance <i> --since 1h --limit 20`<br>替换：skill placeholders -> demo values | docker |  |
| skipped | skills/mysql-operations/SKILL.md:38 | `workctl --json mysql query explain --instance <i> --database <db> --sql "SELECT ... WHERE customer_id = 42"` |  | template with "..." (not runnable as written) |
| pass | skills/mysql-operations/SKILL.md:39 | `workctl --json mysql table get   --instance <i> --database <db> --table <t>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/mysql-operations/SKILL.md:40 | `workctl --json mysql index list  --instance <i> --database <db> --table <t>`<br>替换：skill placeholders -> demo values | docker |  |
| skipped | skills/mysql-operations/SKILL.md:41 | `workctl --json mysql query analyze --instance <i> --database <db> --sql "SELECT ..."` |  | template with "..." (not runnable as written) |
| pass | skills/mysql-operations/SKILL.md:50 | `workctl --json mysql lock list --instance <i>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/mysql-operations/SKILL.md:51 | `workctl --json mysql session list --instance <i>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/mysql-operations/SKILL.md:61 | `workctl --json mysql index plan --instance <i> --database <db> --table <t> --columns c1[,c2]`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/mysql-operations/SKILL.md:70 | `workctl --json mysql query execute --instance <i> --database <db> --sql "SELECT id, status FROM orders WHERE id = 1" --max-rows 20`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/offline-delay-investigation/SKILL.md:15 | `workctl --json offline freshness check --dataset <db.table> --data-date D`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/offline-delay-investigation/SKILL.md:21 | `workctl --json offline run get --workflow <dag> --id <run_id>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/offline-delay-investigation/SKILL.md:33 | `workctl --json offline dependency list --run-id <run_id> --direction upstream`<br>替换：skill placeholders -> demo values | docker |  |
| skipped | skills/offline-delay-investigation/SKILL.md:55 | `workctl --json offline backfill plan ...` |  | template with "..." (not runnable as written) |
| pass | skills/offline-operations/SKILL.md:14 | `workctl --json offline workflow get --id <dag_id>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/offline-operations/SKILL.md:15 | `workctl --json offline task get --workflow <dag_id> --task <task_id>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/offline-operations/SKILL.md:16 | `workctl --json offline run list --workflow <dag_id> --data-date YYYY-MM-DD [--timezone Asia/Shanghai]`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/offline-operations/SKILL.md:17 | `workctl --json offline run get --workflow <dag_id> --id <run_id>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/offline-operations/SKILL.md:18 | `workctl --json offline dependency list --run-id <run_id> --direction upstream\\|downstream`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/offline-operations/SKILL.md:19 | `workctl --json offline log get --run-id <run_id> --task <task_id> [--try N] [--limit-lines 200]`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/offline-operations/SKILL.md:21 | `workctl --json compute queue get --id demo-batch-pool` | docker |  |
| skipped | skills/offline-operations/SKILL.md:22 | `workctl sql query get --id q-...` |  | template with "..." (not runnable as written) |
| pass | skills/offline-operations/SKILL.md:43 | `workctl --json offline backfill plan --workflow <dag> --from D1 --to D2 [--timezone <tz>] [--rerun-succeeded] [--max-active-runs N]`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/postgres-operations/SKILL.md:23 | `workctl --json pg instance get --instance <i>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/postgres-operations/SKILL.md:24 | `workctl --json --timeout 45s pg statement summary --instance <i> --sample-window 20s --top 10`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/postgres-operations/SKILL.md:25 | `workctl --json pg statement summary --instance <i> --sample-window 0 --order-by mean_time --top 10`<br>替换：skill placeholders -> demo values | docker |  |
| skipped | skills/postgres-operations/SKILL.md:36 | `workctl --json pg query explain --instance <i> --sql "SELECT ... WHERE customer_id = 42"` |  | template with "..." (not runnable as written) |
| pass | skills/postgres-operations/SKILL.md:37 | `workctl --json pg table get     --instance <i> --table <t> [--schema <s>]`<br>替换：skill placeholders -> demo values | docker |  |
| skipped | skills/postgres-operations/SKILL.md:38 | `workctl --json pg query analyze --instance <i> --sql "SELECT ..."` |  | template with "..." (not runnable as written) |
| pass | skills/postgres-operations/SKILL.md:48 | `workctl --json pg lock list --instance <i>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/postgres-operations/SKILL.md:49 | `workctl --json pg session list --instance <i>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/postgres-operations/SKILL.md:59 | `workctl --json pg table get --instance <i> --table <t>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/postgres-operations/SKILL.md:60 | `workctl --json pg database list --instance <i>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/postgres-operations/SKILL.md:69 | `workctl --json pg query run --instance <i> --sql "SELECT id, status FROM orders WHERE id = 1" --max-rows 20`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/redis-operations/SKILL.md:25 | `workctl --json redis instance get --instance <i>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/redis-operations/SKILL.md:26 | `workctl --json --timeout 45s redis stats sample --instance <i> --duration 30s`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/redis-operations/SKILL.md:38 | `workctl --json redis key sample --instance <i> --pattern "<prefix>:*" --max-keys 1000 --max-scan-calls 200`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/redis-operations/SKILL.md:39 | `workctl --json redis key inspect --instance <i> --key <top_key>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/redis-operations/SKILL.md:48 | `workctl --json redis key hot --instance <i> --pattern "<prefix>:*" --max-keys 2000 --max-scan-calls 500 --top 10`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/redis-operations/SKILL.md:56 | `workctl --json redis slowlog list --instance <i> --limit 20`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/redis-operations/SKILL.md:64 | `workctl --json redis config get --instance <i> --pattern "maxmemory*"`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/resource-capacity-review/SKILL.md:24 | `workctl --json capacity summary --env <env>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/resource-capacity-review/SKILL.md:40 | `workctl --json container stats get --service <svc>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/resource-capacity-review/SKILL.md:47 | `workctl --json metric query --resource <svc> --metric request_rate --window 6h --step 1m`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/resource-capacity-review/SKILL.md:48 | `workctl --json metric query --resource <svc> --promql 'process_resident_memory_bytes{service="<svc>"}' --window 6h --step 1m`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/resource-capacity-review/SKILL.md:55 | `workctl --json deploy release list --service <svc> --window 7d`<br>替换：skill placeholders -> demo values | docker |  |
| skipped | skills/search-operations/SKILL.md:10 | `workctl --json plugin install --file <demo-search-plugin.tgz>` |  | installs files |
| pass | skills/search-operations/SKILL.md:16 | `workctl --json search cluster get --cluster <c>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/search-operations/SKILL.md:17 | `workctl --json search index get --cluster <c> --index <索引或单索引别名>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/search-operations/SKILL.md:18 | `workctl --json search query --cluster <c> --index <i> --query '<query_string>' [--max-hits N]`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/service-latency-investigation/SKILL.md:23 | `workctl --json resource get --id <service>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/service-latency-investigation/SKILL.md:24 | `workctl --json service dependency list --service <service>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/service-latency-investigation/SKILL.md:25 | `workctl --json container workload get --service <service>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/service-latency-investigation/SKILL.md:31 | `workctl --json container event list --service <service> --window 1h`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/service-latency-investigation/SKILL.md:37 | `workctl --json config get --service <service>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/service-latency-investigation/SKILL.md:38 | `workctl --json config diff --service <service> --key <name>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/service-latency-investigation/SKILL.md:44 | `workctl --json deploy release list --service <service> --window 24h`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/service-latency-investigation/SKILL.md:45 | `workctl --json deploy status get --service <service>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/service-latency-investigation/SKILL.md:51 | `workctl --json metric list --resource <service>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/service-latency-investigation/SKILL.md:52 | `workctl --json metric query --resource <service> --metric request_latency --window 30m`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/service-latency-investigation/SKILL.md:53 | `workctl --json metric query --resource <service> --metric error_rate --window 30m`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/service-latency-investigation/SKILL.md:54 | `workctl --json metric query --resource <service> --metric cache_hit_ratio --window 30m`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/service-latency-investigation/SKILL.md:55 | `workctl --json metric query --resource <service> --metric db_query_rate --window 30m`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/service-latency-investigation/SKILL.md:60 | `workctl --json metric query --resource <service> --promql 'sum by (result) (rate(cache_requests_total{service="<service>"}[1m]))'`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/service-latency-investigation/SKILL.md:65 | `workctl --json log query --service <service> --window 15m --level warn`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/service-latency-investigation/SKILL.md:66 | `workctl --json log query --service <service> --window 1h --contains 'cache mode changed'`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/service-latency-investigation/SKILL.md:67 | `workctl --json trace get --id <trace_id> --window 1h`<br>替换：<trace_id> -> d995b0c0ce3a0507d9d84184dec8014b | docker |  |
| pass | skills/service-latency-investigation/SKILL.md:74 | `workctl --json redis stats sample --instance <redis> --duration 10s`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/service-latency-investigation/SKILL.md:75 | `workctl --json redis key sample --instance <redis> --pattern 'demo:order:*'`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/service-latency-investigation/SKILL.md:81 | `workctl --json mysql statement summary --instance <mysql> --sample-window 10s`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/service-latency-investigation/SKILL.md:82 | `workctl --json mysql query explain --instance <mysql> --database <db> --sql-file q.sql`<br>替换：skill placeholders -> demo values; q.sql -> mysql sample (SELECT * FROM orders WHERE customer_id = 42) | docker |  |
| pass | skills/service-latency-investigation/SKILL.md:86 | `workctl --json pg statement summary --instance <pg> --sample-window 10s --top 10`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/service-latency-investigation/SKILL.md:92 | `workctl --json container stats get --service <service>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/service-latency-investigation/SKILL.md:93 | `workctl --json network backend list --service <service>`<br>替换：skill placeholders -> demo values | docker |  |
| pass | skills/service-latency-investigation/SKILL.md:94 | `workctl --json network connectivity check --target <db_host:port>`<br>替换：skill placeholders -> demo values | docker |  |
