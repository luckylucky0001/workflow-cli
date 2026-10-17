# 提效评估与验收

本文件定义评估方法，并记录**已实际测得**的数据。没有测到的项目明确标为“未测量”，不预设收益百分比。

## 1. 基础设施层收益（可由仓库直接测量）

| 维度 | 测量方式 | 结果 |
| --- | --- | --- |
| 共享代码复用 | `node scripts/maintenance-report.mjs`：共享运行时（core/cli/mcp）与各领域适配器代码行 | 见 §4 实测 |
| 消费者复用 | `node demo/scenarios/reuse/same-contract.mjs`：同一能力经 CLI、脚本 API、MCP 调用，比较契约 | 见 §4 实测 |
| 流程扩展成本 | `node scripts/reuse-matrix.mjs`：Skill × 能力复用矩阵；新流程 Skill 是否需要修改适配器 | 见 [docs/reuse-matrix.md](../docs/reuse-matrix.md) |
| 接入效率 | 插件 demo-mq：新增系统需要的文件与代码量、是否修改核心 | 见 §4 实测 |
| 维护影响范围 | 契约测试（`test/contract`）：能力定义变化后帮助、目录、参考、Schema、MCP 描述是否同步 | 测试在 CI 中强制 |
| 文档一致性 | `docs generate` 输出与提交版本逐字比对；示例命令中的命令与参数必须存在 | 测试在 CI 中强制 |

## 2. 任务层收益（对照实验协议）

三组：**人工流程**、**Agent + 仅 CLI**、**Agent + Skill + CLI + 文档**。三组使用同一演示环境、同一数据、同一权限和同一验收标准。

| 任务 | 合格标准（漏一项即不合格） |
| --- | --- |
| A 资源巡检 | 找到 demo-order 的容器、MySQL、Redis 依赖并给出依据；报告实例状态、重启/事件、资源限制与使用；区分快照与窗口 |
| B 中间件分析 | 确认缓存命中下降与数据库访问上升的时间对齐；指出全表扫描语句（EXPLAIN 依据）；不把累计计数当窗口值；说明哪些需对照实验确认 |
| C 离线链路 | 区分调度成功、计算成功、分区产出、质量检查四层；找到错误目标分区或缺失的上游分区；补数计划包含区间、目标分区、写入方式、下游影响 |

每次记录：合格完成时间、人工介入次数、错误与重试、系统切换次数、证据完整性、结论正确性、模型与工具成本（含能力发现与读取帮助的消耗）。失败任务保留记录。

**更快但漏查关键依赖、误读累计指标或遗漏产出检查，不计为合格完成。**

运行 Agent 组：`./demo/agent-host/run-agent-demo.sh`（转录与摘要保存在 `demo/agent-host/runs/`）。人工组需由参与者按同一任务卡执行并计时。

## 3. 验收项

见 §5 的逐项结论（实测后填写）。

## 4. 实测记录

### 4.1 Agent 组（Claude Code 无头模式，隔离演示环境，2026-10-17）

运行：`./demo/agent-host/run-agent-demo.sh`。Agent 使用只读 profile（`allow_execute: false`），主线 A/B 运行期间真实注入缓存旁路故障并保持 8 rps 负载。转录摘要：[agent-host/runs/](agent-host/runs/)。成本为宿主报告值，含能力发现（ToolSearch、Skill 读取）的消耗。

| 组 | 主线 | workctl 调用 | 总工具调用 | 耗时 | 宿主报告成本 | 是否合格 | 依据 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Skill + MCP/CLI | A 资源巡检 | 9 | 10 | 24.3 s | $0.26 | 合格 | 依赖带来源；容器状态/重启/OOM/限制；快照与窗口区分；指出事件缓冲覆盖不足而不说“没有事件” |
| Skill + MCP/CLI | B 中间件分析 | 20 | 24 | 58.9 s | $0.38 | 合格 | 时间对齐（13:00:47 切换 bypass 后 hit_ratio→0、db_query_rate↑、p95↑）；EXPLAIN + 慢日志 + 10s 摘要差分定位无索引全扫描；Redis 无查找时命中率为 null；累计值不当窗口；未执行 analyze 与变更 |
| Skill + MCP/CLI | C 离线链路 | 11 | 13 | 37.3 s | $0.25 | 合格 | 四层状态分别取证；日志证明写入 dt=2026-10-17；目标分区、上游就绪、下游影响；补数计划含区间/写入方式/并发并识别 `dag_not_paused` 前置条件与 conf 复用风险；未执行 |

交叉审查修复后的回归运行（`RUN_TAG=after-review`，同一环境与提示）：

| 主线 | workctl 调用 | 总工具调用 | 耗时 | 宿主报告成本 | 是否合格 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| A | 5 | 6 | 18.6 s | $0.11 | 合格 | 识别出 13:18:42 的重启为手动操作（restart 策略 no、退出码 0），并说明事件缓冲覆盖不足 |
| B | 16 | 19 | 49.1 s | $0.27 | 合格 | 同样定位缓存旁路 + 无索引全扫描，给出注入时刻前后的指标对照 |
| C | 9 | 11 | 30.6 s | $0.26 | 合格 | 同样定位写错分区；注明日志只取了部分行 |

交付版本（全部交叉审查修复之后，`RUN_TAG=final`）：A 10 次 workctl 调用 / 21.2 s / $0.16；B 16 / 52.0 s / $0.27；C 11 / 32.3 s / $0.26，三条均合格（A 线这次从日志中直接定位到当前的缓存旁路故障注入）。

同一 Skill 在 Kubernetes provider 下（k3s，只读 profile，主线 A 提示相同）：5 次 workctl 调用、25.3 s、$0.26，合格——Pod/Deployment 状态、事件按 1h event-ttl 标注覆盖不完整、metrics-server 快照、只按绑定认定依赖；并识别出验证用例做过的真实滚动更新（[A-infra.k8s.summary.md](agent-host/runs/A-infra.k8s.summary.md)）。

新接入能力（`run-agent-demo.sh D-extend`：etcd 配置中心/服务发现 + demo-search 插件，只读 profile，无故障注入）：10 次 workctl 调用（MCP）、13 次工具调用、31.9 s、$0.19，合格——`config diff` 给出修订 30→41 的逐键新增/修改/删除，敏感值只说“已变更”；`discovery list` 指出 `order-2` 自报不健康、`order-legacy` 无租约可能是残留，并说明健康为自报而非探测；对 `demo-orders-all` 按 `created_at` 排序识别出 `status: partial`（archive 分片因映射缺少 `created_at` 失败，total 3000 而非 3400），用无排序查询排除别名/分片本身的问题，并区分 yellow（副本未分配）与本次不完整无关；未做变更（[D-extend.summary.md](agent-host/runs/D-extend.summary.md)）。这些能力是在主线 A/B/C 之后才加入的；这次运行中 Agent 没有读取 Skill，直接从 MCP 工具目录（由同一能力定义生成）找到 `config_*`、`discovery_list`、`search_*` 工具。

部署系统 + PostgreSQL（`run-agent-demo.sh E-release-db`，完整复位后的环境，Jenkins provider，期间 PostgreSQL 有 2 并发合成负载；只读 profile）：9 次 workctl 调用（MCP）、13 次工具调用、54.1 s、$0.35，合格——先加载 `deploy-operations` 与 `postgres-operations` 两个 Skill；列出 5 个构建并指出失败的是 #3 v1.4.2-bad（控制台“health check failed after rollout”），说明“当前版本”只是最近成功构建、需用 `container workload get` 核对；生成回滚计划但指出 `allow_execute` 前置条件不满足、并质疑默认回滚目标是否合理；`pg statement summary` 20 s 窗口定位 `WHERE customer_id = $1 ORDER BY created_at` 占窗口总耗时约 98%，用 EXPLAIN（Seq Scan）与表统计（seq_scan 远多于 idx_scan、无 customer_id 索引）佐证，建议索引交 DBA 评审且未执行任何 DDL / ANALYZE（[E-release-db.summary.md](agent-host/runs/E-release-db.summary.md)）。

同一任务两次运行的调用次数与成本有波动（LLM 非确定性），只能说明量级，不能作为精确对比。

CLI-only 对照组见 §4.2。人工组：**未测量**（需要参与者按同一任务卡计时）。

### 4.2 仅 CLI 对照组（同一环境、同一任务、同一只读权限）

运行：`MODE=cli-only ./demo/agent-host/run-agent-demo.sh`。Agent 不加载 Skill、不连 MCP，只能用 `workctl` 命令行（提示中只告知“可以使用 workctl 命令行”），在空目录中运行。注意：该组常把多条命令合并在一次 Bash 调用中，调用次数只作参考。

| 主线 | workctl 调用（Bash 次数） | 耗时 | 宿主报告成本 | 是否合格 | 与 Skill 组的差异 |
| --- | --- | --- | --- | --- | --- |
| A 资源巡检 | 23 | 46.8 s | $0.36 | 基本合格 | 先花多轮读 `--help` 发现命令；依赖与状态正确，但未说明资源数据是快照还是窗口 |
| B 中间件分析 | 9（含大量合并的 `--help` 调用） | 69.4 s | $0.21 | **不合格** | 未用指标对齐时间、未看执行计划，根因停留在“待验证”；误把 `no_index_used_count=0` 读成“用了索引但选择性差”而未验证 |
| C 离线链路 | 21 | 60.3 s | $0.31 | 合格 | 结论与 Skill 组一致，但调用次数约 2 倍、耗时约 1.6 倍 |

观察（n=1，仅供参考，不能外推为提效比例）：

- Skill 组直接按领域流程取证（指标→日志→调用链→Redis→MySQL），CLI-only 组先用多轮 `--help` 探索命令面。
- 复杂跨系统任务（B）上差异最大：Skill 中“缓存命中率与数据库访问时间对齐”“EXPLAIN 是估计值”等口径与步骤，使 Agent 把假设推进到有证据的结论。
- 两组都没有执行任何变更（只读 profile 也保证了这一点），都区分了事实与假设。

### 4.3 基础设施层

| 维度 | 实测 |
| --- | --- |
| 消费者复用 | `same-contract.mjs`：`redis.info.get` 与插件能力 `mq.consumer.lag` 经 CLI、脚本 API、MCP 三种入口返回相同的能力名、版本、适配器、数据字段和来源 |
| 流程复用 | [reuse-matrix.md](../docs/reuse-matrix.md)：13 个 Skill 引用 74 个能力，其中 21 个能力被 2 个及以上 Skill 复用（新接入的 `config get/diff`、`deploy release list` 同时被领域 Skill 与延迟排查流程引用）；`offline run get` 在代码层通过 `ctx.call` 复用 `data.partition.get`、`compute.job.get` |
| 共享代码 | `scripts/maintenance-report.mjs`：共享运行时（core）约 1.5k 行、CLI+MCP 约 0.7k 行，被 11 个内置领域和 2 个插件共用；领域适配器 0.3k–2.8k 行（容器域含 Docker 与 Kubernetes 两个 provider） |
| 新系统接入（插件） | demo-mq：约 1.1k 行插件代码 + 清单/指南/Skill，无需为消息队列修改核心（开发过程中修复了插件加载器 2 个通用缺陷：重装校验、Schema 路径）；安装后命令、帮助、目录、MCP 工具自动出现，真实 Kafka 结果与 `kafka-consumer-groups.sh` 一致。demo-search：约 1.2k 行插件代码，实现内置目录中 planned 的 `search.index.get` / `search.query`；为此核心改动约 30 行（允许插件实现内置 planned 能力；文件参数在校验时转为绝对路径），OpenSearch 2.19.3 上 21/21 |
| 文档一致性 | 契约测试在 CI 中强制：生成文档逐字一致、示例命令/参数存在、设计稿命令全覆盖 |
| 接口版本替换（设计稿 §10.4） | `version-swap.mjs`：9 个离线/计算能力（10 次调用）分别对 Airflow 2.10.5（REST v1）与 Airflow 3.3.2（REST v2）真实调用，两侧 `data` 通过同一 zod 输出 schema、顶层字段与 `run get` 四层状态一致，差异只在 `meta.sources`（adapter/method/version）；适配器侧新增 `airflow-v2.ts` 约 250 行 + 客户端约 130 行改动，能力代码改动约 40 行、输出 schema 未改；v2 补数执行器真实执行成功。见 [version-swap.md](verification/version-swap.md) |
| 新系统接入（内置领域） | config/discovery：etcd 约 0.76k 行，之后加入 Nacos 与 Consul 两个 provider 后整个领域约 1.9k 行（同一输出 Schema，按绑定选择 provider）；deploy（Kubernetes + Jenkins）约 1.3k 行；PostgreSQL 约 2.3k 行。都复用核心的资源绑定、凭据引用、HTTP 客户端、计划存储与错误映射，接入时 `src/core` 未改，只在 doctor 的端点类型表（`src/domains/core`）登记新端点类型；验证 etcd 16、Nacos 13、Consul 12、Jenkins 15、Kubernetes 发布 14、PostgreSQL 34 |
| 多 provider 同一契约 | Docker ↔ Kubernetes（k3s v1.31.4，10/10）、Airflow 2 ↔ 3（REST v1 ↔ v2）、Spark ↔ Trino 476（15/15）、Docker 日志 ↔ Loki 3.5.5：每组都由同一能力定义与输出 Schema 承载，差异只在 `meta.sources` 与可选的 provider 专有字段 |
| 分发 | `npm pack` 后全局安装，CLI 可运行并找到随包 Skill；包大小 2.2 MB（依赖已打包进单文件；含 Skill 与文档，不含教程截图） |

### 4.4 缺陷测评（2026-10-17 晚间一轮）

方法：每个新接入的领域/插件由**非作者**审查（对真实服务复现或用假服务器单测复现后才算“确认”），每个确认缺陷都有先失败后通过的回归测试；另用 `scripts/contract-fuzz.mjs` 对整个目录做黑盒契约模糊测试（每个可调用能力：缺参、错类型、超长、Unicode、路径穿越、上游全部不可达、全部枚举值；检查单信封、错误码与退出码映射、输出 Schema、来源与覆盖、无堆栈、无密钥值；MCP 同参对照）。

| 对象 | 确认并修复 | 典型缺陷 |
| --- | --- | --- |
| etcd 配置中心 | 5 | 嵌套在秘密字段下的值明文输出；超过 2^53 的整数被改写；快照截断时 diff 报出不存在的新增/删除 |
| OpenSearch 插件 + 插件加载 | 8 | `wrapper`（base64）与 `terms_set` 脚本绕过 DSL 白名单；聚合内跨索引读取；`top_hits` 绕过命中上限；红色分片报完整；URL 内凭据回显；插件加载失败后半注册 |
| Nacos / Consul | 12 | 未声明类型的 `.properties` 与解析失败的文档整段明文（含密码）；`value_bytes`/`md5` 可推出密钥长度；Consul 单键索引误当全局索引；ACL 过滤结果报完整 |
| 部署系统 | 14 | 非 http URL、Basic 头、环境变量值中的凭据明文；脱敏后比较导致密码变更被隐藏；回滚复用 ReplicaSet 后时间窗口漏掉修订；Jenkins 过期计划检查可绕过；回滚补丁竞态（改为条件补丁，冲突返回 `CONFLICT`） |
| PostgreSQL | 5 | `U&"..."` Unicode 转义标识符与 `ts_rewrite` 绕过只读防护执行任意文本；`standard_conforming_strings=off` 时语句切分与服务端不一致；错误消息带出敏感列原值 |
| 契约模糊测试（87 个能力，2366 个 CLI 用例 + 1179 次 MCP 调用） | 10 | `--timeout` 超范围立即超时并打印 Node 警告；不完整命令退出码 0 且无输出；上游不可达时 `freshness check` 报成功且空列表；一个领域的错误映射冒领其他领域的连接错误；部分核心能力缺 `meta.coverage` |
| 其他（集成时发现） | 2 | PostgreSQL 领域级错误映射认领所有网络错误；`--dsl-file` 指向非 JSON 文件时回显文件开头 |

合计 56 个（此前各领域交叉审查 58 个，累计 114 个）。最终模糊测试轮次 0 违例；未修复的“疑似”项（如 Consul 检查输出可能含 token、PostgreSQL 数值表达式可绕过按列名脱敏）记录在各领域指南的限制中。

## 5. 验收结论（设计稿 §12.3）

| 验收项 | 结论 | 证据 |
| --- | --- | --- |
| 基础设施、中间件、离线链路均有实际演示路径 | ✅ | [walkthrough.md](walkthrough.md) 主线 A/B/C；Agent 宿主实跑 |
| MySQL 与 Redis 作为独立领域被发现和调用 | ✅ | `capability list --domain mysql`、`--domain redis`；verification mysql-*/redis-* |
| 实例管理、原生访问、观测接口及权限前置条件清晰 | ✅ | 能力 `prerequisites`；`access check`；`auth status --probe` 显示实际身份与 SHOW GRANTS |
| MySQL 计划估计、真实执行和采样统计语义正确 | ✅ | `query explain`（估计，不执行）/ `query analyze`（会执行，只读限时）/ `statement summary`（窗口差分，0 为累计并标注） |
| Redis 命中统计、采样覆盖、大小和热度分别表达 | ✅ | `stats sample`（差分、重启检测、分母为 0 时为 null）、`key sample`（SCAN 预算与覆盖）、`key inspect`（MEMORY USAGE）、`key hot`（LFU 计数，非 QPS） |
| 调度实例、计算作业、数据区间和目标分区可以关联 | ✅ | `offline run get` 分层摘要：data_interval、Spark app id、target_partition |
| 调度成功、计算成功、数据产出和质量检查分别验证 | ✅ | 同上四层各带来源；wrong_partition 场景 success/succeeded/missing/fail |
| 重跑或补数计划包含区间、范围、影响和写入策略 | ✅ | `offline backfill plan`；执行器经 `operation execute` 真实运行过（离线任务报告） |
| 空结果、未采集、无权限、部分结果和任务执行中可区分 | ✅ | 错误码与 `status=partial`；如 slowlog 关闭→`COLLECTION_DISABLED`、`workctl_ro` 访问 mysql.user→`PERMISSION_DENIED`、sensor 等待→`data.state` |
| 相同领域能力被多条 Skill 复用 | ✅ | [reuse-matrix.md](../docs/reuse-matrix.md)：21 个能力被 ≥2 个 Skill 引用 |
| 新插件按统一机制进入目录并完成实际调用 | ✅ | demo-mq：`plugin install` → `capability list --domain mq` → 真实 Kafka lag；demo-search：planned 的 `search.*` 安装后变为可调用，真实 OpenSearch 查询与部分分片失败 |
| 人、脚本和 Agent 使用相同执行实现与结果契约 | ✅ | `same-contract.mjs`：CLI == 脚本 API == MCP |
| 文档、Skill、CLI 与后端兼容信息一致 | ✅ | 契约测试（生成文档一致、示例有效）；[compatibility.md](../docs/compatibility.md) 记录实测版本 |
| 真实引擎、模拟回包、合成数据和分析判断分开标识 | ✅ | `context.data_mode`、`sources[].relation`（explicit/inferred/derived/sampled）、插件 `backend_mode`；Agent 输出区分事实与假设 |
| 演示可复位，结果可追溯且材料中没有凭据或真实业务标识 | ✅ | 完整复位实测（`verify-all.sh`，2026-10-17 17:04 UTC）：`reset.sh` → `up.sh`（45 s）→ 场景重放（170 s）→ 10 个套件 224 个用例全部通过 → 集成测试 731/731，整轮约 10.5 分钟；结果信封含 request_id 与来源；git 历史中检索不到任何实际密钥值 |

未覆盖或未测量：人工对照组；客户环境；Kubernetes 仅在单节点 k3s（嵌套于 Docker，含演示专用 runc 规避）上验证，未在多节点或托管集群验证；Jaeger/Tempo、Hive Metastore、对象存储、HDFS、YARN、文档/KV、分析数据库、托管中间件生命周期等 provider（目录中为“待接入”）；etcd 与 OpenSearch 的认证路径只在假服务器单测中验证。
