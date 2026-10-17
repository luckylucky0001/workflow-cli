# 平台接入指南

新增一个系统时，目标是得到一组**通过契约检查的能力**：人、脚本和 Agent 都能发现和调用，帮助、目录、参考文档和 MCP 工具自动生成。

## 1. 先回答四个问题

| 问题 | 例 |
| --- | --- |
| 接入路径：管理 API、原生协议/驱动，还是观测/元数据接口？ | MySQL：驱动（数据面）+ 管理平台 API（实例元数据） |
| 身份：用哪类凭据？目标系统如何校验？ | 只读数据库账号；平台 Token |
| 语义：哪些口径不能和其他系统归一化？ | 累计值 vs 窗口值、估计 vs 实际、采样覆盖 |
| 操作：哪些动作只读，哪些需要计划与执行器？ | 扩容、参数变更、补数 |

查询到实例不代表具备数据面权限——把每条接入路径的前置条件写进能力的 `prerequisites`。

## 2. 两种扩展方式

| 方式 | 适合 | 位置 |
| --- | --- | --- |
| 内置领域模块 | 核心系统，随 CLI 版本发布 | `src/domains/<name>/index.ts` |
| 插件包 | 客户专有系统、独立发布节奏 | `.tgz`，`workctl plugin install --file` |

### 内置领域模块

```ts
export default defineDomain({
  name: 'mysql', title: 'MySQL', pillar: 'middleware',
  summary: '...', guide: 'docs/guides/mysql.md', skill: 'skills/mysql-operations',
  capabilities: [tableGet, ...],
  probes: { mysql: async (ctx, name) => ({ ok: true, identity, version, privileges }) },
  planners: [...], executors: { 'mysql.index.create': ... },
  mapError: (e) => /* 驱动错误 → 稳定错误码 */,
});

const tableGet = defineCapability({
  name: 'mysql.table.get',
  command: 'mysql table get',
  summary: '获取指定 MySQL 表的结构与属性',
  inputs: { instance: { type: 'string', required: true, description: '...' }, ... },
  output: z.object({ ... }),          // data 的 zod schema → JSON Schema
  adapter: 'mysql-driver', operation: 'read', auth_provider: 'database-profile',
  guide: 'docs/guides/mysql.md',
  notes: ['table_rows 为估计值'], prerequisites: ['只读账号具有 information_schema 访问权限'],
  handler: async (ctx, i) => {
    const ep = ctx.endpoint('mysql', i.instance);          // 端点配置
    const password = ep.secret('password');                // 凭据引用解析，不进入输出
    ...
    return { data, sources: [source('mysql', 'mysql-driver', { method: 'information_schema.COLUMNS', version })], coverage: { complete: true } };
  },
});
```

在 `src/domains/index.ts` 注册后，命令、`--help`、`capability list/get`、`docs generate`、MCP 工具自动可用。

公共运行能力不要在适配器里重写：`ctx.endpoint()`（端点与默认值）、`ep.secret()`（凭据引用）、`httpJson()`（超时与 HTTP 状态映射）、`ctx.remainingMs()`（时间预算）、`ctx.resources()`（资源绑定）、`ctx.plans()`（计划存储）、`ctx.call()`（组合其他能力）。

### 插件包

```text
workctl-plugin.json      清单：plugin_api、name、version、backend_mode(live|recorded|synthetic_fixture)、
                         entry、domain、endpoint_kinds、compatibility、capabilities[]
dist/plugin.mjs          入口（node 执行）
schemas/*.json           每个能力 data 的 JSON Schema
guides/*.md              领域指南
skills/*/SKILL.md        领域 Skill
```

执行协议 `workctl-plugin/1`：核心通过 stdin 传入一个 JSON（capability、已校验的 inputs、该插件端点类型的配置——凭据引用已解析且只经 stdin 传递、profile、env、request_id、timeout_ms），插件向 stdout 写一个 JSON（status、data、error、meta）。核心负责参数校验、执行授权、超时、信封与 `context`；插件只实现系统语义。安装时校验清单、入口、Schema、领域指南和命名冲突；`backend_mode` 非 live 时结果自动带警告。示例：[plugins/demo-mq](../plugins/demo-mq)。

## 3. 结果契约检查清单

- [ ] `data` 有 zod schema；`WORKCTL_VALIDATE_OUTPUT=1` 下无 schema 警告
- [ ] `sources` 写明系统、适配器、方法（SQL 视图 / 命令 / REST 路径）、观测时间、**实际版本**、`relation`
- [ ] `coverage` 写明窗口、采样、截断；采样不当全量，累计不当窗口
- [ ] 空结果、未采集（`COLLECTION_DISABLED`）、无权限（`PERMISSION_DENIED`）、部分结果（`status: partial`）、执行中（`data.state`）可区分
- [ ] 驱动错误经 `mapError` 映射到稳定错误码
- [ ] 不输出凭据；敏感字段按配置脱敏
- [ ] 写操作走 planner/executor，计划包含实际目标、影响、前置条件、是否幂等/可取消
- [ ] 指南写明对象模型、口径、权限前置条件、已验证版本；Skill 引用指南而非复制
- [ ] 单元测试 + `WORKCTL_IT=1` 的真实环境测试
- [ ] `npm run docs` 后 `docs/` 无未提交差异（契约测试会检查）

## 4. 版本与兼容

能力有 `capability_version`（语义化版本）：新增可选字段为 minor，删除/改名字段或改变口径为 major，major 变化同时更新 `docs/schemas/<cap>.v<major>.json`。引擎版本按实际验证结果写入 [compatibility.md](compatibility.md)，不凭相似协议推断兼容。
