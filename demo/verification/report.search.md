# 隔离演示环境验证记录（search）

> 由 `node scripts/verify-demo.mjs demo/verification/cases.search.json` 生成于 2026-10-18T06:24:16.920Z；原始结果信封见 `demo/verification/envelopes-search/`。全部为合成数据。

通过 26 / 26

| # | 命令 | 期望 | 实际 | 退出码 | 耗时 ms | 来源@版本 | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ✅ search-01 | `workctl capability list --domain search` | success | success | 0 | 381 | workctl | 插件实现内置 planned 能力：search.index.get / search.query 为 available，origin=plugin:demo-search@0.1.0；search.snapshot.list 仍为 planned |
| ✅ search-02 | `workctl search cluster get --cluster demo-search` | success | success | 0 | 679 | opensearch@opensearch 2.19.3 | GET / + _cluster/health + _cat/indices：实际版本、节点、分片；集群 yellow（archive 副本无法在单节点分配）仍为 success + warning |
| ✅ search-03 | `workctl search index get --cluster demo-search --index demo-orders` | success | success | 0 | 583 | opensearch@opensearch 2.19.3 | _cat/indices + _settings + _mapping + _stats + _cat/shards：3000 文档、8 个字段、2 主分片 STARTED，累计统计标注 cumulative |
| ✅ search-04 | `workctl search index get --cluster demo-search --index demo-orders-current` | success | success | 0 | 610 | opensearch@opensearch 2.19.3 | 单索引别名解析为 demo-orders（resolved_from_alias + warning） |
| ✅ search-05 | `workctl search index get --cluster demo-search --index demo-orders-archive` | success | success | 0 | 548 | opensearch@opensearch 2.19.3 | 索引 yellow：副本 0r UNASSIGNED（INDEX_CREATED），shards.unassigned 列出 |
| ✅ search-06 | `workctl search index get --cluster demo-search --index no-such-index` | NOT_FOUND | NOT_FOUND | 5 | 471 |  | 404 index_not_found_exception → NOT_FOUND |
| ✅ search-07 | `workctl search index get --cluster demo-search --index demo-orders-all` | INVALID_ARGUMENT | INVALID_ARGUMENT | 2 | 448 |  | 别名指向 2 个索引：index get 只描述单个索引，details.resolved_indices 列出 |
| ✅ search-08 | `workctl search query --cluster demo-search --index demo-orders --query status:paid AND city:shanghai --max-hits 5` | success | success | 0 | 436 | opensearch@opensearch 2.19.3 | query_string：total relation=eq（精确），只返回 5 条 → coverage.truncated=true |
| ✅ search-09 | `workctl search query --cluster demo-search --index demo-orders --dsl-file demo/scenarios/search/dsl/paid_by_city.json` | success | success | 0 | 526 | opensearch@opensearch 2.19.3 | 受限 DSL：bool filter + sort amount desc + _source + terms/date_histogram 聚合 |
| ✅ search-10 | `workctl search query --cluster demo-search --index demo-orders --query *:* --track-total-hits 1000 --max-hits 1` | success | success | 0 | 507 | opensearch@opensearch 2.19.3 | 3000 文档、track_total_hits=1000 → total={1000, gte}（下限，非精确）+ warning |
| ✅ search-11 | `workctl search query --cluster demo-search --index demo-orders-all --dsl-file demo/scenarios/search/dsl/latest_across_archive.json` | partial | partial | 0 | 462 | opensearch@opensearch 2.19.3 | 别名跨 2 个索引按 created_at 排序；archive 映射无该字段 → 1/3 分片失败，status=partial，shard_failures 给出原因 |
| ✅ search-12 | `workctl search query --cluster demo-search --index demo-orders --dsl-file demo/scenarios/search/dsl/script_score.json` | INVALID_ARGUMENT | INVALID_ARGUMENT | 2 | 407 |  | DSL 含 script_score → 插件内拒绝，不发往 OpenSearch |
| ✅ search-13 | `workctl search query --cluster demo-search --index demo-orders --dsl-file demo/scenarios/search/dsl/size_too_large.json` | INVALID_ARGUMENT | INVALID_ARGUMENT | 2 | 444 |  | DSL size=500 > 100 上限 |
| ✅ search-14 | `workctl search query --cluster demo-search --index demo-orders --dsl-file demo/scenarios/search/dsl/disallowed_from.json` | INVALID_ARGUMENT | INVALID_ARGUMENT | 2 | 406 |  | 顶层 from 不在允许列表（query/size/sort/_source/aggs） |
| ✅ search-15 | `workctl search query --cluster demo-search --index demo-orders --query status:(paid` | INVALID_ARGUMENT | INVALID_ARGUMENT | 2 | 495 |  | OpenSearch 400 query_shard_exception（all shards failed）→ INVALID_ARGUMENT，带 parse 错误原文 |
| ✅ search-16 | `workctl search query --cluster demo-search --index no-such-index --query *:*` | NOT_FOUND | NOT_FOUND | 5 | 476 |  | 查询不存在的索引 → NOT_FOUND |
| ✅ search-17 | `workctl search query --cluster demo-search --index _all --query *:*` | INVALID_ARGUMENT | INVALID_ARGUMENT | 2 | 454 |  | 禁止 _all / * / . 开头的系统索引 |
| ✅ search-18 | `workctl search query --cluster demo-search --index demo-orders --query *:* --max-hits 500` | INVALID_ARGUMENT | INVALID_ARGUMENT | 2 | 473 |  | --max-hits 上限 100 |
| ✅ search-19 | `workctl search query --cluster demo-search --index demo-orders --dsl-file demo/scenarios/search/dsl/paid_by_city.json` | success/partial | success | 0 | 513 | opensearch@opensearch 2.19.3 | 相对路径的 --dsl-file：核心在校验时转为绝对路径再交给插件（插件在自己的安装目录运行） |
| ✅ search-20 | `workctl search query --cluster demo-search --index demo-orders --dsl-file demo/scenarios/search/dsl/wrapper_script.json` | INVALID_ARGUMENT | INVALID_ARGUMENT | 2 | 416 |  | wrapper 查询（base64 编码的 script 查询）→ 插件内拒绝；修复前会在集群上执行脚本 |
| ✅ search-21 | `workctl search query --cluster demo-search --index demo-orders --dsl-file demo/scenarios/search/dsl/top_hits_per_bucket.json` | INVALID_ARGUMENT | INVALID_ARGUMENT | 2 | 411 |  | aggs 中的 top_hits 会在聚合结果里返回文档（修复前返回 1000 条未截断文档），绕过 100 条命中上限 → 拒绝 |
| ✅ search-22 | `workctl search query --cluster demo-search --index demo-orders --query status:/pa.*/` | INVALID_ARGUMENT | INVALID_ARGUMENT | 2 | 389 |  | --query 中的正则（/.../）→ 插件内拒绝（确需正则用 DSL regexp，max_determinized_states ≤ 10000） |
| ✅ search-23 | `workctl search query --cluster demo-search --index demo-orders --dsl-file demo/scenarios/search/dsl/leading_wildcard.json` | INVALID_ARGUMENT | INVALID_ARGUMENT | 2 | 454 |  | DSL query_string 设置 allow_leading_wildcard=true（前导通配符扫描整个词典）→ 拒绝 |
| ✅ search-24 | `workctl search query --cluster demo-search --index demo-orders --dsl-file demo/scenarios/search/dsl/huge_automaton.json` | INVALID_ARGUMENT | INVALID_ARGUMENT | 2 | 436 |  | regexp 的 max_determinized_states=1000000 超过上限 10000 → 拒绝 |
| ✅ search-25 | `workctl search query --cluster demo-search --index demo-orders --dsl-file demo/scenarios/search/dsl/nested_terms_explosion.json` | INVALID_ARGUMENT | INVALID_ARGUMENT | 2 | 401 |  | 嵌套 terms size 1000×1000（最坏 100 万桶）超过 10000 桶上限 → 拒绝，而不是输出过大导致 INTERNAL |
| ✅ search-26 | `workctl search query --cluster demo-search --index demo-orders --query path:"/api/v1" OR status:paid --max-hits 1` | success | success | 0 | 448 | opensearch@opensearch 2.19.3 | 双引号短语中的斜杠不是正则，正常查询 |
