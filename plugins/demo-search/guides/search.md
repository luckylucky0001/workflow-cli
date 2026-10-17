# 搜索引擎（search）领域指南 — demo-search 插件

内置能力目录把 `search.index.get`、`search.query` 列为待接入（planned）。**demo-search 插件**（`workctl-plugin/1`）以同名能力实现它们（core 用插件能力替换内置的 planned 条目，`origin` 变为 `plugin:demo-search@0.1.0`），并新增 `search.cluster.get`。执行时 core 以子进程运行 `node dist/plugin.mjs`，返回与内置能力相同的统一信封。

| 能力 | 命令 | 状态 | 说明 |
|---|---|---|---|
| `search.cluster.get` | `search cluster get --cluster` | available | 集群健康、节点数、分片分配、实际版本、索引数量 |
| `search.index.get` | `search index get --cluster --index` | available | 设置、映射摘要、文档数/容量、累计读写统计、分片分配；别名解析 |
| `search.query` | `search query --cluster --index (--query \| --dsl-file) [--max-hits] [--track-total-hits]` | available | 受限只读查询：命中数、命中、聚合 |
| `search.snapshot.list` | `search snapshot list --cluster --repository` | planned | 快照列表，仅出现在目录中：CLI 不生成该命令，经引擎/MCP 调用返回 `CAPABILITY_PLANNED` |

## 1. 对象模型（OpenSearch）

- **集群（cluster）**：`--cluster` 取 profile 中 `endpoints.opensearch` 下的 endpoint 名（演示环境 `demo-search`），不是 URL。
- **索引（index）**：文档的逻辑集合，由若干 **主分片（primary shard）** 组成，每个主分片可有 N 个 **副本（replica）**。主分片数在创建后不可改，副本数可改。
- **别名（alias）**：指向一个或多个索引的名字。`search index get` 接受只指向一个索引的别名并在 `data.resolved_from_alias` 与 warnings 中注明；指向多个索引时返回 `INVALID_ARGUMENT` 并在 `details.resolved_indices` 列出。`search query` 可以直接查询多索引别名。
- **映射（mapping）**：字段类型。`keyword` 精确匹配/聚合，`text` 分词全文检索，`long/double/date` 可做范围查询与排序。`field_count` 统计叶子字段（含 multi-fields）。
- **分片状态**：`STARTED` 正常；`INITIALIZING` 恢复中；`RELOCATING` 迁移中；`UNASSIGNED` 未分配（`unassigned.reason` 说明原因，如 `INDEX_CREATED`）。
- **集群健康**：`green` 全部分片已分配；`yellow` 主分片都可用但有副本未分配（单节点集群上 `number_of_replicas ≥ 1` 必然 yellow）；`red` 至少一个主分片未分配，相关数据不可读。

## 2. 口径（不能与其他系统归一化）

- **命中数 total**：`relation=eq` 表示精确值；`relation=gte` 表示“至少这么多”——插件发送的 `track_total_hits` 默认且最大为 10000（`--track-total-hits` 可调低），命中数超过它后 OpenSearch 停止精确计数。回答时必须区分，不能把 `gte` 的值当成精确数。
- **命中列表是前 N 条**：`--max-hits` 默认 20、上限 100；匹配文档多于返回条数时 `coverage.truncated=true`。统计分布请用 `aggs`，不要用命中列表推断总体。
- **聚合**：OpenSearch 的 `terms` 聚合在多分片上是近似的（每个分片取 top-N 再合并），`doc_count_error_upper_bound`、`sum_other_doc_count` 原样返回；`cardinality` 是 HyperLogLog 估计值。
- **累计统计**：`search index get` 的 `cumulative_stats`（query_total、index_total、refresh_total 等）是**自分片在当前节点启动/重新分配以来的累计值**（所有分片副本之和），节点重启或分片迁移会清零。它不是窗口值；要得到速率必须隔一段时间采样两次再差分。
- **文档数**：`docs.count` 来自 `_stats` primaries，是 Lucene 文档数（nested 子文档也计入）；`docs.deleted` 是尚未被段合并清理的删除标记。
- **近实时（NRT）**：写入的文档在下一次 refresh 之后才可被搜索和统计（默认 `refresh_interval=1s`，`settings.refresh_interval=null` 表示用默认值）。“刚写入查不到”不等于数据丢失。
- **部分结果**：部分分片失败（`_shards.failed > 0`）或搜索超时（`timed_out=true`）时 `status=partial`，失败原因在 `data.shard_failures`。`_shards.skipped` 是 can_match 预筛选判定“该分片不可能有匹配”而跳过的分片，结果仍完整，只在 coverage.notes 中说明。
- **集群 red/yellow**：`search cluster get` 仍返回 `success`（调用本身成功），状态与未分配分片数写入 `warnings`。

## 3. 查询限制（search.query）

| 限制 | 实现 |
|---|---|
| 只读 | 只调用 `POST /{index}/_search`；`_update_by_query`、`_delete_by_query`、`_bulk` 等端点永远不会被调用 |
| query_string | `--query` 以 `query_string` 执行，`allow_leading_wildcard=false`，长度 ≤ 4096 |
| 受限 DSL | `--dsl-file` 顶层只允许 `query`、`size`、`sort`、`_source`、`aggs`；`from`、`search_after`、`timeout`、`track_total_hits`、`script_fields`、`runtime_mappings` 等一律拒绝 |
| 禁止脚本 | 任意层级出现 `script`、`script_score`、`scripted_metric`、`_script`（脚本排序）、`bucket_script`、`bucket_selector`、`stored_script` → `INVALID_ARGUMENT`，请求不发往集群 |
| 禁止跨索引读取 | `terms` lookup（`{index,id,path}`）、`indexed_shape`、`more_like_this` 引用其他索引文档 → `INVALID_ARGUMENT` |
| 条数 | DSL `size` > 100 → `INVALID_ARGUMENT`；实际 `size = min(DSL size, --max-hits)` |
| 计数 | `track_total_hits` = `--track-total-hits`（1–10000，默认 10000），DSL 中不可指定 |
| 聚合 | 聚合内 `size`/`shard_size` ≤ 1000 |
| 超时 | 请求体 `timeout` = 剩余时间预算 − 1.5s；HTTP 请求本身也受预算限制 |
| 目标 | 索引/别名/尾部 `*` 前缀，≤10 个；禁止 `_all`、`*` 和 `.` 开头的系统索引；`expand_wildcards=open` |
| `_source` | 字符串 > 512 字符、字段 > 50 个或单条 > 8 KiB 时截断，`source_truncated=true` |

`--dsl-file` 可用相对路径：core 在参数校验时按调用方目录转成绝对路径再交给插件（插件进程的工作目录是插件安装目录）。绕过 core、直接按协议调用插件时须传绝对路径。

## 4. 结果契约要点

| 情况 | 返回 |
|---|---|
| 集群 red / yellow | `success` + warnings（未分配分片数与含义） |
| 索引/别名不存在（404 `index_not_found_exception`） | `NOT_FOUND`，`details.index` |
| 别名指向多个索引（index get） | `INVALID_ARGUMENT`，`details.resolved_indices` |
| query_string 语法错误、字段类型不符（400，所有分片失败） | `INVALID_ARGUMENT`，消息含 OpenSearch 的 root cause |
| DSL 含脚本 / 不允许字段 / size > 100 | `INVALID_ARGUMENT`（插件内拒绝，不发请求） |
| 部分分片失败 / 搜索超时 | `partial`，`coverage.complete=false`，`data.shard_failures` |
| 匹配多于返回 | `success`，`coverage.truncated=true` |
| 401 / 403 | `UNAUTHENTICATED` / `PERMISSION_DENIED` |
| 429（线程池拒绝、熔断） | `UPSTREAM_UNAVAILABLE` |
| 连接失败 | `UPSTREAM_UNAVAILABLE`（`details.errno`）；超出预算 `TIMEOUT` |
| profile 未配置该集群 | `NOT_CONFIGURED`，`details.configured_clusters` |

`meta.sources[].version` 为 `GET /` 返回的实际版本（如 `opensearch 2.19.3`）；字段数与分片汇总标注 `relation=derived`。

## 5. 端点配置与权限

```yaml
profiles:
  demo:
    defaults: { opensearch: demo-search }
    endpoints:
      opensearch:
        demo-search:
          url: http://127.0.0.1:19200
          # 启用安全插件时：
          # username: workctl_ro
          # password_ref: env:OPENSEARCH_RO_PASSWORD   # 只允许引用；core 解析后仅经 stdin 传给插件
```

认证方式（auth_provider `search-profile`）：可选 basic auth。只读角色需要 `cluster:monitor/main`、`cluster:monitor/health`、`indices:monitor/stats`、`indices:monitor/settings/get`、`indices:admin/mappings/get`、`indices:admin/aliases/get`、`indices:data/read/search`。查询到集群不代表具备索引的读权限，403 原样映射为 `PERMISSION_DENIED`。

## 6. 兼容性与验证状态

- 声明支持 OpenSearch **2.x**；**已验证 OpenSearch 2.19.3**（`opensearchproject/opensearch:2.19.3`，单节点，安全插件关闭，隔离演示环境）。
- 未验证：OpenSearch 1.x / 3.x、Elasticsearch 7.x/8.x（API 大体相似，但不凭相似协议推断兼容）、启用安全插件（basic auth / TLS）的集群、多节点集群。
- HTTPS 自签证书需通过 `NODE_EXTRA_CA_CERTS` 提供 CA（core 会把该环境变量传给插件进程）。
- 验证层级：设计 + 实现 + 隔离环境验证（`demo/verification/report.search.md`）；**未在客户环境验证**。
