# 场景：OpenSearch 搜索引擎（demo-search 插件）

目的：证明内置目录中“待接入”的搜索能力（`search.index.get`、`search.query`）可以只通过插件实现，并用真实 OpenSearch 上的真实数据回答“集群/索引健康吗、索引里有什么、查到多少”。

所有文档都是合成数据（`synthetic: true`，由固定种子的伪随机数生成，重复运行结果一致）。

## 数据

| 对象 | 内容 |
|---|---|
| 索引 `demo-orders` | 2 主分片、0 副本，`dynamic: strict` 显式映射：`order_id` keyword、`customer_id` long、`status` keyword、`amount` double、`city` keyword、`created_at` date、`note` text（另有 `synthetic` boolean）；3000 条，`created_at` 在 2026-09-01 起 45 天内 |
| 索引 `demo-orders-archive` | 1 主分片、**1 副本**（单节点无法分配 → 索引与集群 yellow）；旧映射：`amount` 为 keyword、**没有 `created_at`**；400 条 |
| 别名 `demo-orders-current` | → `demo-orders`（write index） |
| 别名 `demo-orders-all` | → `demo-orders` + `demo-orders-archive`（映射不一致，按 `created_at` 排序时 archive 分片失败 → partial） |
| `dsl/*.json` | 受限 DSL 示例：`paid_by_city.json`（过滤 + 排序 + 聚合）、`latest_across_archive.json`（制造部分分片失败）、`script_score.json` / `size_too_large.json` / `disallowed_from.json` / `wrapper_script.json` / `top_hits_per_bucket.json`（应被拒绝） |

## 步骤（在仓库根目录执行）

```bash
# 1. 启动 OpenSearch（opensearchproject/opensearch:2.19.3，单节点，安全插件关闭，localhost:19200）
(cd demo/environment && docker compose up -d search)
curl -s http://127.0.0.1:19200/_cluster/health

# 2. 写入合成数据（删除并重建两个索引与别名）
node demo/scenarios/search/seed.mjs

# 3. 构建并安装插件
npm run build
node plugins/demo-search/build.mjs
node dist/workctl.js plugin install --file plugins/demo-search/dist/demo-search-plugin.tgz

# 4. 查询
export WORKCTL_CONFIG=$PWD/demo/environment/workctl.yaml
node dist/workctl.js --json capability list --domain search
node dist/workctl.js search cluster get --cluster demo-search
node dist/workctl.js search index get --cluster demo-search --index demo-orders-current
node dist/workctl.js search query --cluster demo-search --index demo-orders --query 'status:paid AND city:shanghai' --max-hits 5
node dist/workctl.js search query --cluster demo-search --index demo-orders --dsl-file demo/scenarios/search/dsl/paid_by_city.json
node dist/workctl.js search query --cluster demo-search --index demo-orders-all --dsl-file demo/scenarios/search/dsl/latest_across_archive.json   # partial

# 5. 端到端验证 → demo/verification/report.search.md
WORKCTL_CONFIG=demo/environment/workctl.yaml node scripts/verify-demo.mjs demo/verification/cases.search.json
```

## 说明

- 演示主机磁盘占用超过 90%，OpenSearch 默认会因 high watermark 自动加 `cluster.blocks.create_index`；compose 中为演示容器设置了 `cluster.routing.allocation.disk.threshold_enabled=false`，**仅限隔离演示环境**。
- 容器没有挂载数据卷：重建容器后需重新运行 `seed.mjs`。
- `--dsl-file` 可用相对路径：核心在参数校验时把文件参数转成绝对路径，再交给插件（插件进程的工作目录是插件安装目录）。
