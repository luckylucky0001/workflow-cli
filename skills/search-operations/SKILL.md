---
name: search-operations
description: 排查 OpenSearch 搜索引擎问题（集群 red/yellow、分片未分配、索引容量与映射、“查不到数据”、命中数核对）。当用户提到 OpenSearch/Elasticsearch、搜索、索引健康、分片、别名、mapping、query_string、命中数时使用；能力由 demo-search 插件提供（workctl search ...）。
---

# 搜索引擎排查（OpenSearch，demo-search 插件）

`search` 领域由插件提供。先确认：`workctl --json capability list --domain search`，`search.query` 等应为 available 且 origin 为 `plugin:demo-search@…`；否则 `workctl plugin install --file <demo-search-plugin.tgz>`。

## 能力

| 目的 | 命令 |
|---|---|
| 集群健康、版本、索引数 | `workctl --json search cluster get --cluster <c>` |
| 索引设置/映射/容量/分片 | `workctl --json search index get --cluster <c> --index <索引或单索引别名>` |
| 受限查询 | `workctl --json search query --cluster <c> --index <i> --query '<query_string>' [--max-hits N]` |
| 统计/排序 | `... search query --cluster <c> --index <i> --dsl-file q.json`（只允许 query/size/sort/_source/aggs） |
| 快照列表 | `search.snapshot.list` 为 planned，如实告知未接入 |

`--cluster` 是 profile 中 `endpoints.opensearch` 的名字（演示环境 `demo-search`）。

## 流程：“搜索变慢 / 集群不健康”

1. `search cluster get`：看 `health.status` 与 `unassigned_shards`、`initializing_shards`、`relocating_shards`。red/yellow 时 status 仍为 success，原因在 `meta.warnings`。
2. 对可疑索引 `search index get`：看 `health`、`shards.unassigned[].unassigned_reason`、`settings.number_of_replicas` 与节点数。单节点 + 副本 ≥1 → 必然 yellow，是配置问题而不是故障。
3. 判断负载要用 `cumulative_stats` 两次采样差分；单次值是累计值，**不能说成“最近的查询量”**。

## 流程：“数据查不到 / 数量对不上”

1. `search index get` 确认索引存在（`NOT_FOUND` 时核对名称或别名，不要猜相近名字），看 `docs.count` 与 `mapping.top_level_fields` 的字段类型（`text` 与 `keyword` 的匹配方式不同）。
2. `search query` 用最小条件核对：读 `data.total.value` 与 `total.relation`——`gte` 只是下限。
3. 刚写入的数据查不到：近实时语义，等待 refresh（`settings.refresh_interval`，null=默认 1s）后再查，不要直接判定丢数。
4. 需要分布时用 DSL `aggs`（terms/date_histogram），不要用前 N 条命中推断总体；terms 聚合多分片下是近似值。

## 口径（回答时必须遵守）

- `status=partial`：部分分片失败或搜索超时，引用 `data.shard_failures` 与 `meta.warnings` 说明缺了什么；结果不能当成全量。
- `coverage.truncated=true`：命中列表只是前 N 条。
- skipped 分片是预筛选跳过，不是失败。
- 引用证据带上 `meta.sources[].method`、`version`（实际引擎版本）和 `observed_at`。

## 错误处理

| code | 下一步 |
|---|---|
| `NOT_FOUND` | 索引/别名不存在；核对名称 |
| `INVALID_ARGUMENT` | query_string 语法/字段类型错误，或 DSL 违反限制（脚本、size>100、多余顶层字段）；按 message 修正，不要尝试绕过限制 |
| `UPSTREAM_UNAVAILABLE` / `TIMEOUT` | 集群不可达或超时；报告事实，不要当成“没有数据” |
| `UNAUTHENTICATED` / `PERMISSION_DENIED` | 凭据或角色权限问题；不要索要或输出密码 |
| `CAPABILITY_PLANNED` | 能力未接入 |

## 边界

- 只读：只调用 `_search` 与监控/元数据接口；不写入、不删除、不改设置、不执行脚本。需要 reindex、改副本数等操作时只能给建议并说明影响。
- 已验证版本：OpenSearch 2.19.3（隔离演示环境）；其它版本与 Elasticsearch 如实说明“未验证”。详见插件指南 `guides/search.md`。
