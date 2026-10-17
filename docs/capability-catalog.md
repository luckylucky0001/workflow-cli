# 能力目录

> 由 `workctl docs generate` 从能力定义自动生成（workctl 0.1.0），请勿手工编辑。运行时目录：`workctl --json capability list`。

状态说明：**已支持** = 有适配器实现、可调用；**需授权** = 可调用但需要额外授权；**待接入** = 列入能力全景、尚无适配器，不生成可调用命令。插件提供的能力在安装后出现在运行时目录中。

| 板块 | 已支持 | 待接入 |
| --- | --- | --- |
| 核心（发现、资源、身份、操作） | 13 | 0 |
| 基础设施 | 21 | 7 |
| 中间件 | 28 | 14 |
| 离线链路 | 21 | 4 |

## 核心（发现、资源、身份、操作）

### 核心（`core`）

能力发现、资源关系、身份与授权检查、操作计划与状态。指南：[docs/capability-catalog.md](../docs/capability-catalog.md)；Skill：`skills/enterprise-infra`

| 能力 | 命令 | 操作 | 状态 | 适配器 | 版本 |
| --- | --- | --- | --- | --- | --- |
| `access.check` | `workctl access check` | read | 已支持 | profile | 1.0.0 |
| `auth.status` | `workctl auth status` | read | 已支持 | profile | 1.0.0 |
| `capability.get` | `workctl capability get` | read | 已支持 | registry | 1.0.0 |
| `capability.list` | `workctl capability list` | read | 已支持 | registry | 1.0.0 |
| `doctor.run` | `workctl doctor` | diagnose | 已支持 | local | 1.0.0 |
| `operation.cancel` | `workctl operation cancel` | plan | 已支持 | plan-store | 1.0.0 |
| `operation.execute` | `workctl operation execute` | execute | 已支持 | plan-store | 1.0.0 |
| `operation.get` | `workctl operation get` | read | 已支持 | plan-store | 1.0.0 |
| `operation.list` | `workctl operation list` | read | 已支持 | plan-store | 1.0.0 |
| `operation.plan` | `workctl operation plan` | plan | 已支持 | plan-store | 1.0.0 |
| `resource.get` | `workctl resource get` | read | 已支持 | binding-file | 1.0.0 |
| `resource.list` | `workctl resource list` | read | 已支持 | binding-file | 1.0.0 |
| `service.dependency.list` | `workctl service dependency list` | read | 已支持 | binding-file | 1.0.0 |

## 基础设施

### 容器与资源容量（`container`）

容器工作负载状态、事件、资源快照、容量汇总与受控重启（Docker Engine API；按资源绑定可走 Kubernetes API）。指南：[docs/guides/infrastructure.md](../docs/guides/infrastructure.md)；Skill：`skills/infra-operations`

| 能力 | 命令 | 操作 | 状态 | 适配器 | 版本 |
| --- | --- | --- | --- | --- | --- |
| `container.capacity.summary` | `workctl capacity summary` | read | 已支持 | docker-engine-api \| kubernetes-api | 1.0.0 |
| `container.event.list` | `workctl container event list` | read | 已支持 | docker-engine-api \| kubernetes-api | 1.0.0 |
| `container.stats.get` | `workctl container stats get` | read | 已支持 | docker-engine-api \| kubernetes-api | 1.0.0 |
| `container.workload.get` | `workctl container workload get` | read | 已支持 | docker-engine-api \| kubernetes-api | 1.0.0 |
| `container.workload.restart_plan` | `workctl container workload restart-plan` | plan | 已支持 | docker-engine-api \| kubernetes-api | 1.0.0 |

### 网络（`network`）

DNS 解析、服务后端探测与 TCP 连通性采样。指南：[docs/guides/infrastructure.md](../docs/guides/infrastructure.md)；Skill：`skills/infra-operations`

| 能力 | 命令 | 操作 | 状态 | 适配器 | 版本 |
| --- | --- | --- | --- | --- | --- |
| `network.backend.list` | `workctl network backend list` | diagnose | 已支持 | docker-engine-api + http-probe | 1.0.0 |
| `network.connectivity.check` | `workctl network connectivity check` | diagnose | 已支持 | node-net | 1.0.0 |
| `network.dns.get` | `workctl network dns get` | read | 已支持 | node-dns | 1.0.0 |
| `network.loadbalancer.get` | `workctl network loadbalancer get` | read | 待接入 | loadbalancer-api (待接入) | 1.0.0 |

### 存储（`storage`）

Docker 卷与本机文件系统元数据；对象存储与 HDFS 规划中。指南：[docs/guides/infrastructure.md](../docs/guides/infrastructure.md)；Skill：`skills/resource-capacity-review`

| 能力 | 命令 | 操作 | 状态 | 适配器 | 版本 |
| --- | --- | --- | --- | --- | --- |
| `storage.file.stat` | `workctl storage file stat` | read | 已支持 | node-fs | 1.0.0 |
| `storage.hdfs.stat` | `workctl hdfs path stat` | read | 待接入 | webhdfs (待接入) | 1.0.0 |
| `storage.object.stat` | `workctl object stat` | read | 待接入 | s3-api (待接入) | 1.0.0 |
| `storage.volume.get` | `workctl storage volume get` | read | 已支持 | docker-engine-api | 1.0.0 |

### 可观测性（`observability`）

指标（Prometheus）、日志（Docker 容器日志 / Loki）与日志派生调用链；Jaeger / Tempo 规划中。指南：[docs/guides/observability.md](../docs/guides/observability.md)；Skill：`skills/service-latency-investigation`

| 能力 | 命令 | 操作 | 状态 | 适配器 | 版本 |
| --- | --- | --- | --- | --- | --- |
| `observability.log.query` | `workctl log query` | read | 已支持 | docker-engine-api\|loki-http-api | 1.0.0 |
| `observability.metric.list` | `workctl metric list` | read | 已支持 | prometheus-http-api | 1.0.0 |
| `observability.metric.query` | `workctl metric query` | read | 已支持 | prometheus-http-api | 1.0.0 |
| `observability.quota.get` | `workctl quota get` | read | 待接入 | quota-provider (待接入) | 1.0.0 |
| `observability.trace.get` | `workctl trace get` | diagnose | 已支持 | docker-engine-api\|loki-http-api | 1.0.0 |

### 配置与服务发现（`config`）

配置中心与服务注册（etcd v3 JSON 网关 / Nacos Open API / Consul HTTP API，按端点类型选择）：配置读取、修订间差异、注册实例与健康。指南：[docs/guides/infrastructure.md](../docs/guides/infrastructure.md)；Skill：`skills/infra-operations`

| 能力 | 命令 | 操作 | 状态 | 适配器 | 版本 |
| --- | --- | --- | --- | --- | --- |
| `config.diff` | `workctl config diff` | read | 已支持 | etcd-v3-gateway\|nacos-open-api\|consul-http-api | 1.0.0 |
| `config.get` | `workctl config get` | read | 已支持 | etcd-v3-gateway\|nacos-open-api\|consul-http-api | 1.0.0 |
| `discovery.list` | `workctl discovery list` | read | 已支持 | etcd-v3-gateway\|nacos-open-api\|consul-http-api | 1.0.0 |

### 部署系统（`deploy`）

发布/rollout 历史、发布详情、当前发布状态与回滚计划（Kubernetes Deployment 修订、Jenkins 部署 job；按资源绑定选择 provider）。指南：[docs/guides/deploy.md](../docs/guides/deploy.md)；Skill：`skills/deploy-operations`

| 能力 | 命令 | 操作 | 状态 | 适配器 | 版本 |
| --- | --- | --- | --- | --- | --- |
| `deploy.app.history` | `workctl deploy app history` | read | 待接入 | argocd (待接入) | 1.0.0 |
| `deploy.app.sync_status` | `workctl deploy app sync-status` | read | 待接入 | argocd (待接入) | 1.0.0 |
| `deploy.pipeline.execution.list` | `workctl deploy pipeline execution list` | read | 待接入 | spinnaker \| internal-release-platform (待接入) | 1.0.0 |
| `deploy.release.get` | `workctl deploy release get` | read | 已支持 | kubernetes-api \| jenkins-rest | 1.0.0 |
| `deploy.release.list` | `workctl deploy release list` | read | 已支持 | kubernetes-api \| jenkins-rest | 1.0.0 |
| `deploy.rollback.plan` | `workctl deploy rollback plan` | plan | 已支持 | kubernetes-api \| jenkins-rest | 1.0.0 |
| `deploy.status.get` | `workctl deploy status get` | read | 已支持 | kubernetes-api \| jenkins-rest | 1.0.0 |

## 中间件

### MySQL（`mysql`）

MySQL 实例、表结构、会话与锁、语句摘要、慢日志、执行计划、受限查询与索引变更计划。指南：[docs/guides/mysql.md](../docs/guides/mysql.md)；Skill：`skills/mysql-operations`

| 能力 | 命令 | 操作 | 状态 | 适配器 | 版本 |
| --- | --- | --- | --- | --- | --- |
| `mysql.deadlock.get` | `workctl mysql deadlock get` | diagnose | 待接入 | mysql-driver | 1.0.0 |
| `mysql.index.list` | `workctl mysql index list` | read | 已支持 | mysql-driver | 1.0.0 |
| `mysql.index.plan` | `workctl mysql index plan` | plan | 已支持 | mysql-driver | 1.0.0 |
| `mysql.instance.get` | `workctl mysql instance get` | read | 已支持 | mysql-driver | 1.0.0 |
| `mysql.lock.list` | `workctl mysql lock list` | read | 已支持 | mysql-driver | 1.0.0 |
| `mysql.query.analyze` | `workctl mysql query analyze` | diagnose | 已支持 | mysql-driver | 1.0.0 |
| `mysql.query.execute` | `workctl mysql query execute` | read | 已支持 | mysql-driver | 1.0.0 |
| `mysql.query.explain` | `workctl mysql query explain` | read | 已支持 | mysql-driver | 1.0.0 |
| `mysql.replication.get` | `workctl mysql replication get` | read | 待接入 | mysql-driver | 1.0.0 |
| `mysql.session.list` | `workctl mysql session list` | read | 已支持 | mysql-driver | 1.0.0 |
| `mysql.slowlog.list` | `workctl mysql slowlog list` | read | 已支持 | mysql-driver | 1.0.0 |
| `mysql.statement.summary` | `workctl mysql statement summary` | diagnose | 已支持 | mysql-driver | 1.0.0 |
| `mysql.table.get` | `workctl mysql table get` | read | 已支持 | mysql-driver | 1.0.0 |

### PostgreSQL（`postgres`）

PostgreSQL 实例、数据库、表结构与统计、会话与锁等待、语句统计（pg_stat_statements）、执行计划与受限只读查询。指南：[docs/guides/postgres.md](../docs/guides/postgres.md)；Skill：`skills/postgres-operations`

| 能力 | 命令 | 操作 | 状态 | 适配器 | 版本 |
| --- | --- | --- | --- | --- | --- |
| `postgres.database.list` | `workctl pg database list` | read | 已支持 | pg-driver | 1.0.0 |
| `postgres.index.plan` | `workctl pg index plan` | plan | 待接入 | pg-driver | 1.0.0 |
| `postgres.instance.get` | `workctl pg instance get` | read | 已支持 | pg-driver | 1.0.0 |
| `postgres.lock.list` | `workctl pg lock list` | read | 已支持 | pg-driver | 1.0.0 |
| `postgres.query.analyze` | `workctl pg query analyze` | diagnose | 已支持 | pg-driver | 1.0.0 |
| `postgres.query.explain` | `workctl pg query explain` | read | 已支持 | pg-driver | 1.0.0 |
| `postgres.query.run` | `workctl pg query run` | read | 已支持 | pg-driver | 1.0.0 |
| `postgres.replication.get` | `workctl pg replication get` | read | 待接入 | pg-driver | 1.0.0 |
| `postgres.session.list` | `workctl pg session list` | read | 已支持 | pg-driver | 1.0.0 |
| `postgres.statement.summary` | `workctl pg statement summary` | diagnose | 已支持 | pg-driver | 1.0.0 |
| `postgres.table.get` | `workctl pg table get` | read | 已支持 | pg-driver | 1.0.0 |
| `postgres.vacuum.plan` | `workctl pg vacuum plan` | plan | 待接入 | pg-driver | 1.0.0 |

### Redis（`redis`）

Redis 实例概况、INFO、窗口统计采样、慢日志、键采样/大键/热键、单键检查与配置读取。指南：[docs/guides/redis.md](../docs/guides/redis.md)；Skill：`skills/redis-operations`

| 能力 | 命令 | 操作 | 状态 | 适配器 | 版本 |
| --- | --- | --- | --- | --- | --- |
| `redis.cluster.get` | `workctl redis cluster get` | read | 待接入 | redis-client | 1.0.0 |
| `redis.config.get` | `workctl redis config get` | read | 已支持 | redis-client | 1.0.0 |
| `redis.info.get` | `workctl redis info get` | read | 已支持 | redis-client | 1.0.0 |
| `redis.instance.get` | `workctl redis instance get` | read | 已支持 | redis-client | 1.0.0 |
| `redis.key.hot` | `workctl redis key hot` | diagnose | 已支持 | redis-client | 1.0.0 |
| `redis.key.inspect` | `workctl redis key inspect` | read | 已支持 | redis-client | 1.0.0 |
| `redis.key.sample` | `workctl redis key sample` | diagnose | 已支持 | redis-client | 1.0.0 |
| `redis.latency.get` | `workctl redis latency get` | read | 待接入 | redis-client | 1.0.0 |
| `redis.slowlog.list` | `workctl redis slowlog list` | read | 已支持 | redis-client | 1.0.0 |
| `redis.stats.sample` | `workctl redis stats sample` | diagnose | 已支持 | redis-client | 1.0.0 |

### 搜索引擎（`search`）

Elasticsearch / OpenSearch（待接入）。指南：[docs/provider-onboarding.md](../docs/provider-onboarding.md)

| 能力 | 命令 | 操作 | 状态 | 适配器 | 版本 |
| --- | --- | --- | --- | --- | --- |
| `search.index.get` | `workctl search index get` | read | 待接入 | elasticsearch/opensearch (待接入) | 1.0.0 |
| `search.query` | `workctl search query` | read | 待接入 | elasticsearch/opensearch (待接入) | 1.0.0 |

### 文档与键值数据库（`document`）

文档库、KV 服务（待接入）。指南：[docs/provider-onboarding.md](../docs/provider-onboarding.md)

| 能力 | 命令 | 操作 | 状态 | 适配器 | 版本 |
| --- | --- | --- | --- | --- | --- |
| `document.collection.get` | `workctl document collection get` | read | 待接入 | document-db (待接入) | 1.0.0 |
| `kv.query` | `workctl kv query` | read | 待接入 | kv-service (待接入) | 1.0.0 |

### 分析数据库（`analytics`）

列式分析引擎（待接入）。指南：[docs/provider-onboarding.md](../docs/provider-onboarding.md)

| 能力 | 命令 | 操作 | 状态 | 适配器 | 版本 |
| --- | --- | --- | --- | --- | --- |
| `analytics.query.get` | `workctl analytics query get` | read | 待接入 | columnar-engine (待接入) | 1.0.0 |
| `analytics.table.get` | `workctl analytics table get` | read | 待接入 | columnar-engine (待接入) | 1.0.0 |

### 中间件生命周期（`middleware`）

托管平台操作入口（待接入）。指南：[docs/guides/operations.md](../docs/guides/operations.md)

| 能力 | 命令 | 操作 | 状态 | 适配器 | 版本 |
| --- | --- | --- | --- | --- | --- |
| `middleware.operation.plan` | `workctl middleware operation plan` | plan | 待接入 | managed-middleware-platform (待接入) | 1.0.0 |

## 离线链路

### 离线调度（`offline`）

离线工作流（Airflow）：工作流/任务定义、按业务日期查找运行、分层状态、依赖、日志、补数计划与产出时效。指南：[docs/guides/offline.md](../docs/guides/offline.md)；Skill：`skills/offline-operations`

| 能力 | 命令 | 操作 | 状态 | 适配器 | 版本 |
| --- | --- | --- | --- | --- | --- |
| `offline.backfill.get` | `workctl offline backfill get` | read | 已支持 | airflow-rest-v1\|v2 | 1.0.0 |
| `offline.backfill.plan` | `workctl offline backfill plan` | plan | 已支持 | airflow-rest-v1\|v2 | 1.0.0 |
| `offline.dependency.list` | `workctl offline dependency list` | diagnose | 已支持 | airflow-rest-v1\|v2 | 1.0.0 |
| `offline.freshness.check` | `workctl offline freshness check` | diagnose | 已支持 | file-catalog+airflow-rest-v1\|v2 | 1.0.0 |
| `offline.log.get` | `workctl offline log get` | read | 已支持 | airflow-rest-v1\|v2 | 1.0.0 |
| `offline.run.get` | `workctl offline run get` | diagnose | 已支持 | airflow-rest-v1\|v2 | 1.0.0 |
| `offline.run.list` | `workctl offline run list` | read | 已支持 | airflow-rest-v1\|v2 | 1.0.0 |
| `offline.task.get` | `workctl offline task get` | read | 已支持 | airflow-rest-v1\|v2 | 1.0.0 |
| `offline.workflow.get` | `workctl offline workflow get` | read | 已支持 | airflow-rest-v1\|v2 | 1.0.0 |

### 计算作业（`compute`）

Spark 应用（history server REST）、阶段、driver 日志与计算资源池。指南：[docs/guides/compute.md](../docs/guides/compute.md)；Skill：`skills/offline-operations`

| 能力 | 命令 | 操作 | 状态 | 适配器 | 版本 |
| --- | --- | --- | --- | --- | --- |
| `compute.instance.get` | `workctl compute instance get` | read | 待接入 | cloud-compute-api | 1.0.0 |
| `compute.job.get` | `workctl compute job get` | read | 已支持 | spark-history-rest | 1.0.0 |
| `compute.log.get` | `workctl compute log get` | read | 已支持 | spark-driver-log-dir | 1.0.0 |
| `compute.queue.get` | `workctl compute queue get` | read | 已支持 | airflow-pool | 1.0.0 |
| `compute.stage.list` | `workctl compute stage list` | read | 已支持 | spark-history-rest | 1.0.0 |
| `compute.yarn-queue.get` | `workctl compute yarn-queue get` | read | 待接入 | yarn-rm-rest | 1.0.0 |

### SQL 提交（`sql`）

向计算引擎异步提交只读 SQL 查询并跟踪状态（Spark SQL / Trino）。指南：[docs/guides/compute.md](../docs/guides/compute.md)；Skill：`skills/offline-operations`

| 能力 | 命令 | 操作 | 状态 | 适配器 | 版本 |
| --- | --- | --- | --- | --- | --- |
| `sql.query.cancel` | `workctl sql query cancel` | execute | 已支持 | spark-submit-local\|trino-http | 1.0.0 |
| `sql.query.get` | `workctl sql query get` | read | 已支持 | spark-submit-local\|trino-http | 1.0.0 |
| `sql.query.submit` | `workctl sql query submit` | read | 已支持 | spark-submit-local\|trino-http | 1.0.0 |
| `sql.query.submit-hive` | `workctl sql query submit-hive` | read | 待接入 | hiveserver2-thrift | 1.0.0 |

### 数据目录、分区、血缘与质量（`data`）

表元数据与分区语义、分区产出检查、explicit/inferred 血缘、分区质量规则（file 目录 provider + 本地文件系统仓库）。指南：[docs/guides/data.md](../docs/guides/data.md)；Skill：`skills/data-validation`

| 能力 | 命令 | 操作 | 状态 | 适配器 | 版本 |
| --- | --- | --- | --- | --- | --- |
| `data.lineage.get` | `workctl data lineage get` | read | 已支持 | file-catalog | 1.0.0 |
| `data.partition.get` | `workctl data partition get` | read | 已支持 | file-catalog | 1.0.0 |
| `data.partition.list` | `workctl data partition list` | read | 已支持 | file-catalog | 1.0.0 |
| `data.quality.check` | `workctl data quality check` | diagnose | 已支持 | file-catalog | 1.0.0 |
| `data.table.get` | `workctl data table get` | read | 已支持 | file-catalog | 1.0.0 |
| `data.transfer.get` | `workctl data transfer get` | read | 待接入 | data-transfer (待接入) | 1.0.0 |
