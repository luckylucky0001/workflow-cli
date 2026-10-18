# workctl 0.1.0 发布说明

首个可演示版本：按《企业基础设施、中间件与离线链路：Agent 能力底座与 Demo 设计》实现统一 CLI、Skill、文档与演示环境。所有验证均在隔离演示环境中完成，业务数据为合成数据；**没有客户环境验证，也不预设提效比例**。

## 交付内容

| 类别 | 内容 |
| --- | --- |
| CLI | TypeScript + Commander + Zod，esbuild 打包为单文件 ESM，npm 分发（压缩包 2.2 MB，不含教程截图）。内置能力目录 83 个可调用 + 25 个待接入；安装 demo-mq 与 demo-search 两个插件后 89 个可调用 + 25 个待接入：核心 13、基础设施 21（含部署系统 4）、中间件 34（含 PostgreSQL 9、插件 6）、离线链路 21 |
| 统一契约 | 结果信封（status/data/error/meta.sources/meta.coverage/context）、14 个稳定错误码与退出码、凭据只允许 `*_ref` 引用、执行类操作需 `allow_execute` 与计划确认、计划执行加锁 |
| 消费入口 | 终端（text/yaml/json）、脚本（`--json` 与 `createClient` 库 API）、Agent（Skill + CLI，或 `workctl mcp serve`，默认不暴露执行类工具） |
| 扩展机制 | 插件协议 `workctl-plugin/1`（清单、stdin/stdout 执行、安装校验、凭据仅经 stdin 传递）；插件可新增领域，也可实现内置目录中 planned 的能力。示例 demo-mq（Kafka，新增领域）、demo-search（OpenSearch，实现内置 planned 的 `search.index.get` / `search.query`） |
| Skill | 13 个：入口 enterprise-infra；领域 infra/deploy/mysql/postgres/redis/mq/search/offline/data；流程 service-latency-investigation、offline-delay-investigation、resource-capacity-review。`workctl skills install/status` 支持项目级安装与版本检查 |
| 实测截图教程 | `docs/tutorial/`：50 个步骤的真实终端截图与原始输出（只读命令，演示环境实跑），由 `scripts/tutorial-screenshots.mjs` 重新生成；截图不进入 npm 包 |
| 文档 | 能力目录、命令参考、输出 Schema（自动生成并由契约测试保证一致）；资源模型、操作语义、8 份领域指南、接入指南、兼容说明、演示手册、评估文档 |
| 演示环境 | Docker Compose（MySQL、Redis、Kafka、Prometheus、Trino、Loki/Promtail、etcd、OpenSearch、demo-order 样例服务）+ Airflow 2/3 + Spark history；可选 k3s；`reset.sh` / `up.sh` / `verify-all.sh` |

## 已验证的 provider 与版本

| 板块 | provider（同一能力定义，可替换） | 实测版本 |
| --- | --- | --- |
| 容器 | Docker Engine API ↔ Kubernetes API | Docker 29.8.2；k3s v1.31.4 |
| 指标 / 日志 / 调用链 | Prometheus；Docker 日志 ↔ Loki；日志派生调用链 | Prometheus 3.5.0；Loki/Promtail 3.5.5 |
| 配置中心 / 服务发现 | etcd v3 HTTP/JSON 网关 ↔ Nacos Open API ↔ Consul HTTP API | etcd 3.5.21；Nacos 2.4.3；Consul 1.20.6 |
| 部署系统 | Kubernetes Deployment/ReplicaSet ↔ Jenkins REST（部署 job） | k3s v1.31.4；Jenkins 2.541.3 |
| 关系型数据库 | MySQL 原生协议 + performance_schema；PostgreSQL 原生协议 + pg_stat_* / pg_stat_statements | MySQL 8.4.11；PostgreSQL 16.15 |
| 缓存 | Redis RESP | Redis 7.4.11 |
| 消息队列（插件） | Kafka Admin | Kafka 3.9.1 |
| 搜索引擎（插件） | OpenSearch REST | OpenSearch 2.19.3 |
| 调度 | Airflow REST v1 ↔ v2 | Airflow 2.10.5；3.3.2 |
| 计算 / SQL | Spark history + driver 日志；Spark SQL ↔ Trino | Spark 3.5.5；Trino 476 |
| 数据 | 文件目录 + 本地文件系统仓库（JSON Lines/CSV） | 本地文件系统 |

## 质量

- 单元 + 契约测试 798 个通过（10-18）；完整复位后全部开关的真实环境集成测试 896/896；开启全部开关的真实环境集成测试 733/733（最终代码）；逐能力真实调用用例 224 个：主套件 74、Trino 15、etcd 16、PostgreSQL 34、Nacos 13、Consul 12、Jenkins 15、搜索插件 21、Kubernetes 10、Kubernetes 发布 14，均全部通过（`demo/verify-all.sh` 从完整复位开始一键复现，约 10.5 分钟）。
- 缺陷测评：非作者交叉审查与黑盒契约模糊测试累计修复 217 个缺陷（每个都有回归测试），见 `demo/evaluation.md` §4.4 与 `demo/verification/contract-fuzz.md`。
- 各领域由非作者交叉审查，修复的缺陷均有回归测试（见 git 历史 “Cross-review fixes”）。
- 完整复位：`reset.sh` 后 `up.sh` 约 45 秒重建，场景重放约 3 分钟，随后全部套件通过。
- Agent 宿主：Claude Code 无头模式经 Skill + MCP 跑三条主线（只读 profile）均达到验收标准；新接入的配置中心与搜索插件（D-extend）、部署系统 + PostgreSQL（E-release-db）同样合格；仅 CLI 对照组与回归运行记录见 `demo/evaluation.md`。

## 已知限制

- 待接入（目录中为 planned，不可调用）：Apollo / ZooKeeper 配置中心、Argo CD / Spinnaker / 内部发布平台、文档/KV、分析数据库、托管中间件生命周期、对象存储与 HDFS、YARN 队列、Hive 查询、数据同步、RabbitMQ、搜索快照、配额，以及 MySQL 复制/死锁、Redis 集群/延迟监控、负载均衡、主机实例；搜索引擎的索引与查询在未安装 demo-search 插件时也是 planned。
- etcd 仅验证 3.5.21 单节点无认证（token 认证与权限拒绝只在假网关单测中验证）；Nacos 仅 2.4.3 standalone 且演示中关闭鉴权，Consul 仅 1.20.6 dev agent（ACL 关闭），二者的鉴权路径只在假服务器单测中验证；Consul KV 没有历史，配置差异不可回溯；Jenkins 只验证核心插件下的 freestyle job，“当前版本”指最近成功的部署构建；Kubernetes 发布记录的触发人不可得、只有当前修订有完成时间；OpenSearch 仅验证 2.19.3 单节点、安全插件关闭（basic auth 只在假服务器单测中验证），Elasticsearch 未验证。
- Kubernetes 仅在单节点 k3s 验证（演示环境因沙箱内核限制使用了仅限演示的 runc 规避）；Airflow 3 仅验证 3.3.2；Trino 仅单节点 476、未验证密码/JWT 认证；Loki 的租户与 basic auth 仅模拟测试。
- MySQL 受限查询的脱敏是尽力而为，真实权限边界是数据库只读账号；质量检查的抽样为头部样本。
- 人工对照组未测量；单次 Agent 运行有非确定性，只能说明量级。
