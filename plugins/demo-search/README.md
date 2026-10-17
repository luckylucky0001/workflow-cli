# demo-search — workctl 搜索引擎演示插件（OpenSearch）

演示“插件实现内置目录中待接入（planned）的能力”：不修改 workctl core，把 OpenSearch 接入为 `search` 领域（CLI + Skill + 文档 + 输出 Schema）。内置目录中 planned 的 `search.index.get`、`search.query` 被插件同名能力替换（`origin: plugin:demo-search@0.1.0`），另新增 `search.cluster.get`。

- 插件协议：`workctl-plugin/1`；后端模式：`live`（直连真实 OpenSearch，无模拟回包）
- 能力：`search.cluster.get`、`search.index.get`、`search.query`（available），`search.snapshot.list`（planned）
- 兼容性：OpenSearch 2.x；已在 **OpenSearch 2.19.3**（隔离演示环境）验证
- 领域指南：`guides/search.md`；Skill：`skills/search-operations/SKILL.md`

## 包结构

```
workctl-plugin.json                清单：领域、能力、输入、兼容性、backend_mode
dist/plugin.mjs                    单文件 esbuild 产物（内含 zod；HTTP 用 Node 内置 fetch），core 以 `node dist/plugin.mjs` 执行
schemas/search.*.v1.json           各能力 data 的 JSON Schema（由 zod 生成）
guides/search.md                   领域指南：对象模型、口径、查询限制、兼容性
skills/search-operations/SKILL.md  Agent 排查流程
README.md
```

## 构建与安装

```bash
npm run build                                               # workctl 本体 → dist/workctl.js
node plugins/demo-search/build.mjs                          # → plugins/demo-search/dist/demo-search-plugin.tgz
node dist/workctl.js plugin install --file plugins/demo-search/dist/demo-search-plugin.tgz
export WORKCTL_CONFIG=$PWD/demo/environment/workctl.yaml
node dist/workctl.js --json capability list --domain search
node dist/workctl.js search cluster get --cluster demo-search
node dist/workctl.js search index get --cluster demo-search --index demo-orders
node dist/workctl.js search query --cluster demo-search --index demo-orders --query 'status:paid AND city:shanghai'
```

演示环境与数据见 `demo/scenarios/search/README.md`。源码在 `plugins/demo-search/src/`：`manifest.ts`（清单唯一来源）、`capabilities.ts`（处理逻辑与纯函数的结果整形）、`dsl.ts`（受限 DSL 守卫、size 上限、_source 截断）、`opensearch.ts`（HTTP 客户端、端点解析、错误映射）、`schemas.ts`、`protocol.ts`、`plugin.ts`（入口）。构建时校验：每个 available 能力都有 handler 和输出 Schema，planned 能力没有 handler。

## 执行协议

core 把一个 JSON 请求写入 stdin（`endpoints.opensearch.<name>`，`password_ref` 已由 core 解析为 `password`，只经 stdin 传递）；插件向 stdout 写且仅写一个 JSON 文档并以 0 退出，错误也在 JSON 中表达。日志只写 stderr。插件在 `timeout_ms - 500ms` 内返回 `TIMEOUT`，搜索请求体的 `timeout` 再预留 1.5s。

```bash
echo '{"protocol":"workctl-plugin/1","capability":"search.cluster.get","inputs":{"cluster":"demo-search"},"endpoints":{"opensearch":{"demo-search":{"url":"http://127.0.0.1:19200"}}},"defaults":{},"timeout_ms":10000}' \
  | node plugins/demo-search/dist/plugin.mjs
```

## 测试

```bash
npx vitest run test/plugins/demo-search.test.ts                 # 单元：DSL 守卫、size 上限、错误映射、结果整形、清单
WORKCTL_IT=1 npx vitest run test/plugins/demo-search.test.ts    # 加上对 demo-search 的实时测试（直接运行插件入口 + 经 core 安装/调用）
node scripts/verify-demo.mjs demo/verification/cases.search.json # CLI 端到端验证 → demo/verification/report.search.md
```

## 已知限制

- 只读：不提供 reindex、副本数调整、快照等写操作；`search.snapshot.list` 为 planned。
- `--dsl-file` 可以是相对路径：core 在参数校验时按调用方目录把文件参数转成绝对路径再交给插件（插件工作目录是安装目录）；直接按协议调用插件时须传绝对路径。
- 未验证：OpenSearch 1.x/3.x、Elasticsearch、启用安全插件（basic auth/TLS）的集群、多节点集群；basic auth 与 401/403 映射只在单元测试中覆盖。
- 未提供基于时间窗口的查询速率；`cumulative_stats` 为累计值，需两次采样差分。
- `search.index.get` 只描述单个索引；别名指向多个索引时返回 `INVALID_ARGUMENT` 并列出这些索引。
