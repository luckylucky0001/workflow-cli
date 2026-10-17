# Skill × 能力复用矩阵

> 由 `node scripts/reuse-matrix.mjs` 从 Skill 正文中引用的命令生成。一个能力被多个 Skill 引用，说明同一适配器在多个流程中复用。

| 能力 | 适配器 | 被引用的 Skill 数 | Skill |
| --- | --- | --- | --- |
| `capability.get` | registry | 1 | enterprise-infra |
| `capability.list` | registry | 2 | enterprise-infra, mq-operations |
| `compute.queue.get` | airflow-pool | 1 | offline-operations |
| `container.capacity.summary` | docker-engine-api | kubernetes-api | 1 | resource-capacity-review |
| `container.event.list` | docker-engine-api | kubernetes-api | 2 | infra-operations, service-latency-investigation |
| `container.stats.get` | docker-engine-api | kubernetes-api | 2 | resource-capacity-review, service-latency-investigation |
| `container.workload.get` | docker-engine-api | kubernetes-api | 3 | infra-operations, resource-capacity-review, service-latency-investigation |
| `container.workload.restart_plan` | docker-engine-api | kubernetes-api | 1 | infra-operations |
| `data.lineage.get` | file-catalog | 1 | data-validation |
| `data.partition.get` | file-catalog | 1 | data-validation |
| `data.partition.list` | file-catalog | 1 | data-validation |
| `data.quality.check` | file-catalog | 1 | data-validation |
| `data.table.get` | file-catalog | 1 | data-validation |
| `mq.consumer.lag` | kafka-admin | 1 | mq-operations |
| `mq.topic.get` | kafka-admin | 1 | mq-operations |
| `mq.topic.list` | kafka-admin | 1 | mq-operations |
| `mysql.index.list` | mysql-driver | 1 | mysql-operations |
| `mysql.index.plan` | mysql-driver | 1 | mysql-operations |
| `mysql.instance.get` | mysql-driver | 1 | mysql-operations |
| `mysql.lock.list` | mysql-driver | 1 | mysql-operations |
| `mysql.query.analyze` | mysql-driver | 1 | mysql-operations |
| `mysql.query.execute` | mysql-driver | 1 | mysql-operations |
| `mysql.query.explain` | mysql-driver | 2 | mysql-operations, service-latency-investigation |
| `mysql.session.list` | mysql-driver | 1 | mysql-operations |
| `mysql.slowlog.list` | mysql-driver | 1 | mysql-operations |
| `mysql.statement.summary` | mysql-driver | 2 | mysql-operations, service-latency-investigation |
| `mysql.table.get` | mysql-driver | 1 | mysql-operations |
| `network.backend.list` | docker-engine-api + http-probe | 2 | infra-operations, service-latency-investigation |
| `network.connectivity.check` | node-net | 2 | infra-operations, service-latency-investigation |
| `network.dns.get` | node-dns | 1 | infra-operations |
| `observability.log.query` | docker-engine-api|loki-http-api | 2 | infra-operations, service-latency-investigation |
| `observability.metric.list` | prometheus-http-api | 1 | service-latency-investigation |
| `observability.metric.query` | prometheus-http-api | 2 | resource-capacity-review, service-latency-investigation |
| `observability.trace.get` | docker-engine-api|loki-http-api | 1 | service-latency-investigation |
| `offline.dependency.list` | airflow-rest-v1|v2 | 2 | offline-delay-investigation, offline-operations |
| `offline.freshness.check` | file-catalog+airflow-rest-v1|v2 | 1 | offline-delay-investigation |
| `offline.log.get` | airflow-rest-v1|v2 | 1 | offline-operations |
| `offline.run.get` | airflow-rest-v1|v2 | 2 | offline-delay-investigation, offline-operations |
| `offline.run.list` | airflow-rest-v1|v2 | 1 | offline-operations |
| `offline.task.get` | airflow-rest-v1|v2 | 1 | offline-operations |
| `offline.workflow.get` | airflow-rest-v1|v2 | 1 | offline-operations |
| `operation.execute` | plan-store | 1 | infra-operations |
| `operation.get` | plan-store | 1 | infra-operations |
| `redis.config.get` | redis-client | 1 | redis-operations |
| `redis.instance.get` | redis-client | 1 | redis-operations |
| `redis.key.hot` | redis-client | 1 | redis-operations |
| `redis.key.inspect` | redis-client | 1 | redis-operations |
| `redis.key.sample` | redis-client | 2 | redis-operations, service-latency-investigation |
| `redis.slowlog.list` | redis-client | 1 | redis-operations |
| `redis.stats.sample` | redis-client | 2 | redis-operations, service-latency-investigation |
| `resource.get` | binding-file | 1 | service-latency-investigation |
| `resource.list` | binding-file | 1 | enterprise-infra |
| `service.dependency.list` | binding-file | 2 | enterprise-infra, service-latency-investigation |
| `storage.file.stat` | node-fs | 1 | infra-operations |
| `storage.volume.get` | docker-engine-api | 2 | infra-operations, resource-capacity-review |

- Skill 数：10；被引用能力数：55；被 2 个及以上 Skill 复用的能力：16

| 适配器 | 使用它的 Skill 数 |
| --- | --- |
| docker-engine-api | kubernetes-api | 3 |
| binding-file | 2 |
| registry | 2 |
| docker-engine-api + http-probe | 2 |
| docker-engine-api|loki-http-api | 2 |
| node-net | 2 |
| docker-engine-api | 2 |
| mysql-driver | 2 |
| airflow-rest-v1|v2 | 2 |
| redis-client | 2 |
| prometheus-http-api | 2 |
| file-catalog | 1 |
| node-dns | 1 |
| node-fs | 1 |
| plan-store | 1 |
| kafka-admin | 1 |
| file-catalog+airflow-rest-v1|v2 | 1 |
| airflow-pool | 1 |

## 能力组合（代码层复用）

能力实现通过 `ctx.call()` 调用其他能力：走同一执行引擎与契约，不复制适配器代码。

| 调用方领域 | 被调用能力 | 被调用能力的适配器 |
| --- | --- | --- |
| offline (`src/domains/offline/runs.ts`) | `data.partition.get` | file-catalog |
| offline (`src/domains/offline/runs.ts`) | `compute.job.get` | spark-history-rest |
