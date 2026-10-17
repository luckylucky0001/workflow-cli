# 兼容说明

CLI、适配器、Skill、文档与目标系统版本的对应关系。**“已验证”只指在本仓库的隔离演示环境中实际运行通过**（见 [demo/verification/report.md](../demo/verification/report.md)）；没有任何客户环境验证结果。不凭相似协议推断兼容。

## 运行环境

| 组件 | 要求 | 已验证 |
| --- | --- | --- |
| Node.js | ≥ 20（ESM 单文件包） | 22.22.0 |
| 操作系统 | Linux / macOS（插件安装依赖系统 `tar`） | Ubuntu 24.04（容器内） |

## 目标系统

| 领域 | 适配器 | 接入路径 | 已验证版本 | 说明 |
| --- | --- | --- | --- | --- |
| container / network / storage | `docker-engine-api`、`http-probe`、`node-net`、`node-dns`、`node-fs` | Docker Engine API（unix socket） | Docker 29.8.2，API 1.56 | Kubernetes provider 见下一行 |
| container (kubernetes-api) | `kubernetes-api` | Kubernetes REST API（core/v1、apps/v1、metrics.k8s.io/v1beta1；Bearer token 或 kubeconfig） | k3s v1.31.4（单节点，运行在 Docker 中）| 真实集群验证 10/10（`demo/verification/report.k8s.md`），含真实滚动重启；未在多节点/托管集群（EKS/GKE/ACK 等）验证。演示环境因沙箱内核限制使用了仅限演示的 runc 规避（`K3S_OOM_WORKAROUND`），不影响 workctl 行为 |
| observability：指标 | `prometheus-http-api` | Prometheus HTTP API `query_range` | Prometheus 3.5.0 | |
| observability：日志 / 调用链 | `docker-engine-api`（容器日志） | Docker 容器日志（json-file 驱动） | Docker 29.8.2 | 调用链由结构化日志重建（`relation: derived`），不是追踪后端；Loki、Jaeger/Tempo 为待接入 |
| mysql | `mysql-driver`（mysql2） | 原生协议 + performance_schema / information_schema / mysql.slow_log | MySQL 8.4.11 | 需要 `performance_schema=ON`；慢日志 SQL 读取需要 `log_output` 含 TABLE；`EXPLAIN ANALYZE` 需 8.0.18+ |
| redis | `redis-client`（ioredis） | RESP 命令 | Redis 7.4.11（standalone） | `key hot` 需要 LFU 淘汰策略；集群模式未验证 |
| mq（插件 demo-mq 0.1.0） | `kafka-admin`（kafkajs） | Kafka Admin 协议 | Kafka 3.9.1（KRaft 单节点） | 端点偏移为 read_committed；Kafka 4.x、RabbitMQ 未验证/待接入 |
| offline | `airflow-rest-v1` | Airflow REST API v1（basic auth） | Airflow 2.10.5 | Airflow 3.x（REST v2、JWT）未适配 |
| compute | `spark-history-rest`、`spark-driver-log-dir`、`airflow-pool` | Spark History Server REST、driver 日志目录、Airflow 池 | Spark 3.5.5（local 模式 + event log） | YARN 队列为待接入 |
| sql | `spark-submit-local` | 本地 spark-submit 运行只读 SQL | Spark 3.5.5 | Trino / Hive 为待接入（返回 `UNSUPPORTED`） |
| data | `file-catalog` | 文件目录元数据 + 本地文件系统仓库 | 本地文件系统，JSON Lines / CSV | Hive Metastore、表格式（Iceberg 等）、HDFS、对象存储为待接入；**未验证对象存储协议** |

## 契约版本

| 对象 | 版本 | 规则 |
| --- | --- | --- |
| 结果信封 | `schema_version: "1.0"` | 新增可选字段不升版本；字段删除或语义变化升主版本 |
| 能力 | `capability_version`（语义化） | 输出 Schema 位于 `docs/schemas/<capability>.v<major>.json` |
| 插件协议 | `workctl-plugin/1` | 清单与 stdin/stdout 协议见 [provider-onboarding.md](provider-onboarding.md) |
| Skill | 随 CLI 版本发布 | `workctl skills status --dir <dir>` 检查项目内版本是否一致 |

## 升级检查

引擎或平台升级时：

1. 在隔离环境运行 `WORKCTL_IT=1 npm test` 与 `node scripts/verify-demo.mjs`；
2. 关注口径相关的变化（如 performance_schema 表结构、Airflow API 版本、Spark REST 字段）；
3. 更新本表的“已验证版本”，并在能力 `notes` 或指南中写明差异。
