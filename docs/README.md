# 文档包

| 文档 | 重点 | 位置 |
| --- | --- | --- |
| 总览与 Quickstart | 三大能力板块、安装、环境配置、首次查询、给 Agent 使用 | [../README.md](../README.md)、[quickstart.md](quickstart.md) |
| 实测截图教程 | 在隔离演示环境中逐步运行只读命令：截图、原始输出与读法（可用脚本重新生成） | [tutorial/README.md](tutorial/README.md) |
| 能力目录 | 已支持 / 需授权 / 待接入，按板块与领域（自动生成） | [capability-catalog.md](capability-catalog.md)、[capabilities.json](capabilities.json)；运行时 `workctl capability list` |
| 命令参考 | 参数、输出 Schema、错误码与退出码、异步状态、示例（自动生成） | [command-reference.md](command-reference.md)、[schemas/](schemas/) |
| 资源模型 | 服务、实例、作业、数据集、分区的关联与关系来源 | [resource-model.md](resource-model.md) |
| 操作语义 | read / diagnose / plan / execute、计划字段、执行前置条件 | [guides/operations.md](guides/operations.md) |
| 基础设施指南 | 容器（Docker / Kubernetes）、网络、存储；快照与窗口；配置中心与服务发现（etcd / Nacos / Consul：provider 选择、修订空间、历史与压缩、遮蔽、租约与健康） | [guides/infrastructure.md](guides/infrastructure.md) |
| 可观测指南 | 指标目录与 PromQL、日志查询、日志派生调用链 | [guides/observability.md](guides/observability.md) |
| 部署系统指南 | 发布记录（Kubernetes ReplicaSet 修订 / Jenkins 构建）、当前状态、回滚计划与执行、保留期与时间口径 | [guides/deploy.md](guides/deploy.md) |
| MySQL 指南 | 库表、索引、会话与锁、语句采样差分、慢日志、执行计划与受限查询 | [guides/mysql.md](guides/mysql.md) |
| PostgreSQL 指南 | 实例、表与索引、会话与锁、pg_stat_statements 口径、执行计划与受限查询 | [guides/postgres.md](guides/postgres.md) |
| Redis 指南 | 节点范围、计数器与窗口、TTL、SCAN 采样覆盖、慢日志、LFU 热度 | [guides/redis.md](guides/redis.md) |
| 离线链路指南 | DAG、任务实例、数据区间、分层状态、补数计划与执行 | [guides/offline.md](guides/offline.md)、[guides/compute.md](guides/compute.md) |
| 数据指南 | 目录元数据、分区检查项、explicit / inferred 血缘、质量规则 | [guides/data.md](guides/data.md) |
| 消息队列指南（插件） | 消费组 lag 口径、兼容性、backend_mode | [../plugins/demo-mq/guides/mq.md](../plugins/demo-mq/guides/mq.md) |
| 搜索引擎指南（插件） | 集群/索引健康、别名解析、受限查询白名单、部分分片失败 | [../plugins/demo-search/guides/search.md](../plugins/demo-search/guides/search.md) |
| 平台接入指南 | 管理 API / 原生协议 / 观测接口的适配方法、插件协议、契约检查清单 | [provider-onboarding.md](provider-onboarding.md) |
| 兼容说明 | CLI、适配器、引擎版本、Skill 的对应关系与已验证版本 | [compatibility.md](compatibility.md) |
| 设计约束 | 实现必须满足的契约与诚实性约束 | [design-principles.md](design-principles.md) |
| 发布说明 | 交付内容、已验证 provider 与版本、已知限制 | [release-notes.md](release-notes.md) |
| 演示与评估 | 演示步骤、复位方式、验收与测量、复用矩阵 | [../demo/walkthrough.md](../demo/walkthrough.md)、[../demo/evaluation.md](../demo/evaluation.md)、[reuse-matrix.md](reuse-matrix.md) |

## Skill

| 类型 | Skill | 内容 |
| --- | --- | --- |
| 入口 | [enterprise-infra](../skills/enterprise-infra/SKILL.md) | 识别任务所属板块、发现能力、读懂信封、组合与报告规则 |
| 基础设施 | [infra-operations](../skills/infra-operations/SKILL.md)、[deploy-operations](../skills/deploy-operations/SKILL.md) | 容器/网络/存储/配置中心检查，计划 → 确认 → 执行 → 复核；发布记录与故障关联、回滚计划 |
| 中间件 | [mysql-operations](../skills/mysql-operations/SKILL.md)、[postgres-operations](../skills/postgres-operations/SKILL.md)、[redis-operations](../skills/redis-operations/SKILL.md)、[mq-operations](../skills/mq-operations/SKILL.md)、[search-operations](../skills/search-operations/SKILL.md) | 对象模型、口径、命令选择与限制 |
| 离线 | [offline-operations](../skills/offline-operations/SKILL.md)、[data-validation](../skills/data-validation/SKILL.md) | 任务实例、数据区间、血缘、产出与补数 |
| 流程 | [service-latency-investigation](../skills/service-latency-investigation/SKILL.md)、[offline-delay-investigation](../skills/offline-delay-investigation/SKILL.md)、[resource-capacity-review](../skills/resource-capacity-review/SKILL.md) | 跨系统排查与盘点流程，复用领域能力 |

生成类文档（目录、参考、Schema）由 `npm run docs` 从能力定义生成，契约测试保证与代码一致；其余文档人工编写，口径以实际验证为准。
