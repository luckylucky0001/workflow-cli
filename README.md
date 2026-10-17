# workctl — 企业基础设施、中间件与离线链路的 Agent 能力底座

通过**统一 CLI、Skill 和文档**，把计算/容器、网络、存储、可观测、MySQL、Redis、消息队列，以及调度、计算作业、元数据、血缘、分区产出和数据质量接入 Agent，使资源查询、运行诊断、任务分析和受控操作成为**可发现、可组合、可维护**的能力。

- **CLI**（TypeScript → esbuild 单文件 ESM，Node.js ≥ 20，npm 分发）：`workctl <domain> [resource] <action> [options]`，统一结果信封、错误码、凭据引用、时间预算。
- **Skill**（Markdown）：入口 Skill + 领域 Skill + 跨系统流程 Skill，组织领域经验与排查流程。
- **文档**：能力目录、命令参考与输出 Schema 由能力定义自动生成；领域指南写明口径、权限前置条件与已验证版本。
- **同一实现，多种消费者**：人（终端）、脚本（`--json` / 库 API）、Agent（Skill + CLI，或 MCP `workctl mcp serve`）走同一执行引擎，得到同一契约。

> 状态标注：本仓库区分 **已实现并在隔离环境验证**、**已实现未验证**、**待接入（planned）**。所有业务数据均为合成数据；没有客户环境验证结果，也不预设提效百分比。详见 [docs/compatibility.md](docs/compatibility.md) 与 [demo/evaluation.md](demo/evaluation.md)。

## 能力全景

```bash
workctl capability list                  # 目录（含待接入）
workctl capability get --name mysql.statement.summary
```

| 板块 | 领域（命令前缀） | 首版重点 |
| --- | --- | --- |
| 基础设施 | `container` `capacity` `network` `storage` `metric` `log` `trace` `resource` `service` `operation` `auth` `access` | Docker 工作负载状态/事件/资源、资源绑定与依赖、Prometheus 指标、容器日志、日志派生调用链、重启操作计划与执行 |
| 中间件 | `mysql` `redis` `mq`（插件） | MySQL 库表/索引/会话/锁/语句采样差分/慢日志/执行计划/受限查询/索引计划；Redis 运行信息/窗口采样/慢日志/Key 元数据/SCAN 采样/LFU 热度 |
| 离线链路 | `offline` `compute` `sql` `data` | Airflow 工作流/实例/依赖/日志/补数计划与执行、Spark 作业/Stage/日志、Airflow 资源池、Spark SQL 提交、数据目录/分区/血缘/质量规则/时效 |
| 待接入 | `config` `discovery` `search` `document` `kv` `analytics` `middleware` `object` … | 只出现在目录中（`status: planned`），不生成可调用命令 |

完整列表：[docs/capability-catalog.md](docs/capability-catalog.md) · 参数与输出：[docs/command-reference.md](docs/command-reference.md)

## 架构

```mermaid
flowchart TB
    H[工程师与自动化脚本] --> CLI[workctl CLI<br/>Commander]
    A[Agent] --> S[入口 Skill / 领域 Skill / 流程 Skill]
    D[能力目录 / 领域指南 / 命令参考<br/>由能力定义生成] --> S
    S --> CLI
    A --> M[MCP 接入层<br/>workctl mcp serve]
    M --> E
    CLI --> E[执行引擎 invoke<br/>参数校验 · 执行授权 · 超时 · 信封]
    C[能力定义 defineCapability<br/>Zod 输出 Schema] --> CLI
    C --> D
    C --> M
    E --> R[公共运行能力<br/>profile · 凭据引用 · 资源绑定 · 计划存储 · HTTP · 错误映射]
    R --> P[领域适配器 / 插件 workctl-plugin/1]
    P --> I[Docker · Prometheus · DNS/TCP · 文件系统]
    P --> W[MySQL · Redis · Kafka 插件]
    P --> O[Airflow · Spark · 数据目录 · 质量规则]
```

## 快速开始

```bash
npm ci && npm run build                   # 产出 dist/workctl.js（单文件）
cd demo/environment && ./up.sh && cd -    # 隔离演示环境（Docker + Airflow + Spark）
export WORKCTL_CONFIG=$PWD/demo/environment/workctl.yaml
node dist/workctl.js doctor
node dist/workctl.js --json service dependency list --service demo-order --env sandbox
node dist/workctl.js --json mysql statement summary --instance demo-mysql --sample-window 10s --timeout 30s
node dist/workctl.js --json offline run get --id <run_id> --workflow demo-daily-orders
```

详见 [docs/quickstart.md](docs/quickstart.md)、[demo/walkthrough.md](demo/walkthrough.md)。

## 结果契约

```json
{
  "schema_version": "1.0",
  "status": "success | partial | error",
  "capability": "offline.run.get",
  "data": { "scheduler_state": "success", "compute_state": "success", "output_state": "missing", "quality_state": "not_run" },
  "error": null,
  "meta": {
    "sources": [{ "system": "airflow", "adapter": "airflow-rest-v1", "method": "GET /api/v1/dags/{id}/dagRuns/{run}", "version": "2.10.5", "observed_at": "...", "relation": "explicit" }],
    "coverage": { "complete": true, "window": { "start": "...", "end": "..." } },
    "warnings": []
  },
  "context": { "request_id": "req-...", "profile": "demo", "env": "sandbox", "data_mode": "live", "capability_version": "1.0.0", "adapter": "...", "operation": "read" }
}
```

空结果、无权限（`PERMISSION_DENIED`）、未采集（`COLLECTION_DISABLED`）、部分结果（`status: partial`）、任务执行中（`data.state`）分别表达；退出码见 `workctl --help`。

## 仓库结构

```text
src/core/          能力注册、执行引擎、信封与错误码、profile 与凭据引用、资源绑定、计划存储、HTTP、插件加载
src/domains/       领域适配器：container network storage observability mysql redis offline compute sql data (+ planned)
src/cli/           Commander 命令树（由能力定义生成）、文档生成、Skill 分发
src/mcp/           MCP stdio 服务（同一能力目录与引擎）
plugins/demo-mq/   消息队列插件（Kafka）：演示新系统通过插件机制接入
skills/            入口 / 领域 / 流程 Skill（Markdown）
docs/              目录与命令参考（生成）、Schema（生成）、领域指南、资源模型、接入与兼容说明
demo/              隔离演示环境、样例服务、离线工作流、合成数据、质量规则、场景脚本、演示与评估说明
test/              单元测试、契约测试；WORKCTL_IT=1 时运行真实环境集成测试
```

## 开发

```bash
npm run typecheck && npm run build && npm test     # 单元 + 契约测试
WORKCTL_IT=1 npm test                              # 需要演示环境
npm run docs                                       # 重新生成 docs/ 下的目录、参考与 Schema
```

新增系统见 [docs/provider-onboarding.md](docs/provider-onboarding.md)；设计约束见 [docs/design-principles.md](docs/design-principles.md)。
