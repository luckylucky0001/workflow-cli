# 数据目录、分区、血缘与质量（data 领域）

`data` 领域回答离线链路里“数据本身”的问题：表的定义和分区语义是什么、某个业务日期的分区是否真的产出且可读、
数据从哪里来又流向哪里、分区内容是否满足质量规则。调度是否成功、计算是否成功由 `offline` / `compute` 领域回答，
**它们与本领域的检查是不同的检查项，必须分别验证**。

| 能力 | 命令 | 操作 | 说明 |
|---|---|---|---|
| `data.table.get` | `data table get --catalog demo --table analytics.daily_orders` | read | 目录元数据 + 物理位置 + 分区数 |
| `data.partition.list` | `data partition list --table ods.orders [--from --to --limit]` | read | 分区目录、文件数、字节、修改时间、完成标记 |
| `data.partition.get` | `data partition get --table analytics.daily_orders --partition 'dt=2026-10-16'` | read | 单分区逐项检查，`state` 汇总 |
| `data.lineage.get` | `data lineage get --table analytics.daily_orders --direction upstream [--depth 2]` | read | explicit / inferred 血缘 |
| `data.quality.check` | `data quality check --dataset demo.daily_orders --partition 'dt=2026-10-16' --ruleset demo-daily-rules` | diagnose | 规则逐条结果 + 违规样本 |
| `data.transfer.get` | `data transfer get` | — | **planned**，未接入 |

所有命令都支持 `--catalog`（profile 中 `endpoints.catalog` 的名字，缺省取 `defaults.catalog`）。

## 1. 目录模型（provider `file`）

profile 配置：

```yaml
endpoints:
  catalog:
    demo:
      provider: file                 # 当前唯一已接入的 provider
      metadata_dir: ../catalog       # 其下 tables/<db>.<table>.yaml
      warehouse_root: ./.runtime/warehouse
      storage: local-filesystem      # 只接受 local-filesystem
      # rules_dir: ../quality-rules  # 可选；默认 <metadata_dir>/../quality-rules
```

每张表一个 YAML（`demo/catalog/tables/analytics.daily_orders.yaml`），由 `TableMetaSchema`（`src/domains/data/catalog.ts`）校验，
文件名必须等于 `name`。不合法的文件被跳过并在 `coverage.notes` 中列出；被查询的表本身不合法时返回 `INVALID_ARGUMENT`。

| 字段 | 含义 |
|---|---|
| `name` / `description` / `owner` | `db.table`、说明、负责团队 |
| `format` | `json`（JSON lines，Spark `df.write.json`）或 `csv`（带表头；空字段视为 null） |
| `location` | 相对 `warehouse_root` 的表目录，不允许越出 warehouse_root |
| `partition_keys[]` | `name`、`type: date\|string`、`timezone`、`semantics`。`dt` 是**业务日期**（Asia/Shanghai 自然日），不是任务启动日期 |
| `columns[]` | `name`、`type`、`nullable`、`description`、`sensitive`（违规样本中脱敏为 `***`） |
| `write_mode` | `overwrite_partition` 或 `append` |
| `success_marker` | 完成标记文件名，默认 `_SUCCESS`；`null` 表示该表不写标记 |
| `produced_by` | `scheduler`、`workflow`、`task`、`sql_file`、`input_views`、`status: active\|planned` |
| `upstream[]` | 平台声明的上游（explicit）：目录表 `db.table` 或外部来源 URI（如 `mysql://demo-mysql/demo.orders`） |
| `consumers[]` | `type: workflow\|report\|service` + `id` |
| `quality_ruleset` | 默认规则集名 |
| `freshness` | `expected_by: "HH:MM"`（业务时区）、`day_offset`（默认 1 = 业务日期次日） |

`sql_file` 为相对路径时依次在 `metadata_dir` 及其上级目录中解析（demo 中写作仓库相对路径 `demo/offline-workflows/sql/daily_orders.sql`）。
`input_views` 声明调度任务注册给 SQL 的视图名与目录表的对应关系（`ods_orders: ods.orders`），见第 4 节。

演示目录：`ods.orders`（贴源层，上游 MySQL `demo.orders`，由 `demo-ods-orders/extract_orders` 产出——演示环境中实际是合成数据生成器）、
`analytics.daily_orders`（`demo-daily-orders/aggregate_orders` 用 Spark SQL 聚合产出）、`report.daily_summary`（产出流程 `demo-report-workflow` 为 planned，用于下游影响分析）。

## 2. 存储标识

物理检查通过 Node 的本地文件系统调用完成，输出中 `storage.type` 固定为 `local-filesystem`，`meta.sources[].system` 为 `local-filesystem`。
**这不代表对象存储或 HDFS 已验证**：配置成其它 `storage` 值会返回 `UNSUPPORTED`，而不是用本地结果冒充。
更新时间来自文件 mtime（完成标记优先，否则取最新数据文件）。

## 3. 分区检查项

表存在 ≠ 分区存在 ≠ 文件可读 ≠ 质量规则通过。`data partition get` 把它们拆成独立检查项：

| 检查项 | 内容 |
|---|---|
| `defined` | 分区键与表定义一致（键名、顺序、date 值合法）；不一致直接返回 `INVALID_ARGUMENT`。`business_date` 给出业务时区下的今天、该业务日是否已结束、按 freshness 推出的产出期限及是否已过 |
| `exists` | 分区目录是否存在 |
| `files` | 数据文件数与字节数；排除 `_SUCCESS`、`*.crc`、`.`/`_` 开头的文件；`_temporary`、`.spark-staging*` 记入 `in_progress_markers` |
| `success_marker` | 完成标记是否存在及其时间 |
| `updated_at` | UTC 与业务时区本地时间，注明依据（标记或数据文件 mtime） |
| `readable` | **实际打开并解析**每个文件前 N 条记录（`--sample-records`，默认 20），报告解析错误行号、观测到的列和未在元数据中声明的列 |

`state` 汇总（按优先级）：`missing`（目录不存在）→ `empty`（无数据文件、文件为 0 字节或没有记录）→ `incomplete`（有数据但缺完成标记）→ `unreadable`（抽查解析失败）→ `present`。

- **分区缺失不是错误**：返回 `success` + `state=missing`，并给出相邻已存在分区 `nearby_partitions`（便于发现写成 D+1 之类的错位）。
  业务日尚未结束或尚未到产出期限时，`explanation` 会说明“可能只是还没到产出时间”。
- 表不存在 → `NOT_FOUND`；分区格式/键名/日期不合法 → `INVALID_ARGUMENT`。
- `present` 只说明“抽查可解析”，不说明内容正确；内容用 `data quality check`。
- `data partition list` 只列目录和文件属性，不读内容；表目录不存在时返回空列表 + 警告（不是“分区为空”）。

## 4. 血缘：explicit 与 inferred

`data lineage get` 输出 `nodes` 与 `edges`，每条边带 `relations`、`confirmed_by_both` 和逐条 `evidence`：

- **explicit**：来自目录元数据——表的 `upstream`（上游 → 本表）与 `consumers`（本表 → 工作流/报表/服务）。下游方向还会找出所有在 `upstream` 中声明了本表的表。
- **inferred**：解析产出表的 `sql_file`（正则，非完整 SQL 解析器）：
  - 写入目标：`INSERT INTO|OVERWRITE [TABLE] x`、`CREATE [OR REPLACE] TABLE x AS`、`MERGE INTO x`；与元数据不一致时给出警告；SQL 只有 SELECT（目标由程序写入）时注明“写入目标只能取自元数据”。
  - 来源：`FROM` / `JOIN` 后的标识符及逗号连接；跳过 CTE 名、同文件内创建的临时视图、子查询、`EXTRACT(.. FROM ..)` 等函数内的 FROM、注释和字符串；Spark 文件源 `json.\`/path\`` 按表 `location` 匹配。
  - SQL 里的视图名（如 `ods_orders`）只通过 `produced_by.input_views` 的**声明**解析到目录表；没有声明时保持 `unresolved`，**不按相似名称推断**。
- 同一条边同时有两种依据时 `confirmed_by_both: true`。
- 覆盖范围：`coverage.notes` 写明扫描了多少元数据文件和 SQL 文件；SQL 文件缺失时该表只有 explicit 关系且 `coverage.complete=false`；`--depth` 之外还有关系时 `truncated=true`。动态 SQL、程序里注册的临时视图、DataFrame API 读写都看不到。
- `via` 标出产出该边的工作流/任务及其 `status`（`planned` 表示流程尚未接入调度）。

## 5. 质量规则

### 数据集解析（`--dataset`）

| 输入 | 解析 |
|---|---|
| `demo.analytics.daily_orders` | 目录 `demo`、表 `analytics.daily_orders` |
| `demo.daily_orders` | 首段是已配置的目录名 → 在该目录中找表名为 `daily_orders` 的表，**唯一**时采用；多个时 `INVALID_ARGUMENT` 要求写全名 |
| `analytics.daily_orders --catalog demo` | 指定目录后按 `<db>.<table>` 解析 |
| `analytics.daily_orders`（首段不是目录名） | 默认目录中的 `<db>.<table>` |

解析方式写在 `data.dataset.method` 中。

### 规则集

`<rules_dir>/<name>.yaml`（demo：`demo/quality-rules/demo-daily-rules.yaml`、`demo-ods-rules.yaml`）。`table` 字段设置后必须与数据集一致；
`--ruleset` 缺省时用表元数据的 `quality_ruleset`。每条规则可设 `id`、`description`、`severity: error|warn`（warn 级失败不改变总体结论，计入 `summary.warn_failures`）。

| type | 参数 | 判定 | 读数据 |
|---|---|---|---|
| `partition_exists` | `require_success_marker`（默认 true） | 目录存在且（需要时）有完成标记 | 否 |
| `row_count_min` / `row_count_max` | `min` / `max` | 行数（JSON 非空行，含无法解析的行；CSV 数据记录） | 全量计数 |
| `not_null` | `columns` | JSON 的 null 和字段缺失、CSV 空字段都算空 | 是 |
| `unique` | `columns` | 组合键重复；任一键列为空的行跳过并计数 | 是 |
| `accepted_values` | `column`、`values` | 字符串比较；空值跳过 | 是 |
| `value_range` | `column`、`min?`、`max?` | 闭区间；非数值计为违规 | 是 |
| `partition_value_match` | `column`、`key?` | 列值与分区值一致；date 键时时间戳按业务时区换算日期（发现写错分区） | 是 |
| `schema_match` | `expected_columns?`（默认元数据列）、`allow_extra` | 缺列/多列；分区键列不算多出；JSON 中缺失的**可空**列记为 `absent_nullable`（Spark 默认省略 null 字段），不判失败 | 是 |
| `freshness` | `expected_by?`、`day_offset?`、`timezone?`、`max_age?` | 更新时间 ≤ 业务日期 + day_offset 天的 expected_by（业务时区）；或距今 ≤ max_age。缺省取表 `freshness` | 否（mtime） |

检查器自动加入的规则带 `implicit: true`：规则集没写 `partition_exists` 时自动加入；读取记录时加入 `records_parseable`（有解析失败的行即 fail）。

### 结果语义

- 每条结果：`status` = `pass|fail|error|skipped`、`evaluated_on` = `full|sample|filesystem|none`、`conclusive`、`expected`、`observed`、`samples`（≤5 条，含文件与行号，敏感列脱敏，长字符串截断）。
- **前置条件**：分区 `missing`，或需要完成标记却 `incomplete` 时，除 `partition_exists`（fail）外所有规则 `skipped`，`quality_state=fail`。
- 总体 `quality_state`：任一 error 级规则 fail → `fail`；否则任一 error 级规则 error → `error`；否则 `pass`。
- **抽样**：`--sample-rows N` 只读前 N 行做内容规则，行数规则仍全量计数；此时内容规则的 pass `conclusive=false`，`coverage.sampled=true, complete=false`；fail 总是结论性的。全量扫描超过 2,000,000 行时同样按抽样标注。
- 来源：目录元数据、规则集（explicit），目录/文件属性（derived），记录读取（全量为 derived，抽样为 sampled）。

### 结果持久化

最近一次结果写入 `<state_dir>/quality/<db.table>/<partition>.json`（如 `quality/analytics.daily_orders/dt=2026-10-16.json`），
含 `checked_at`、`request_id`、`sources`、`coverage`。其它能力可用 `readLatestQualityResult(stateDir, table, partition)`
（`src/domains/data/quality.ts`，从 `src/domains/data` 导出）读取而不重跑规则；引用时必须同时给出 `checked_at`，旧结果不代表当前数据。

## 6. 错误码

| code | 场景 |
|---|---|
| `NOT_FOUND` | 表不在目录中；规则集不存在；`<catalog>.<table>` 找不到表 |
| `INVALID_ARGUMENT` | 表名/分区格式不对、分区键与定义不一致、日期非法、规则集与表不匹配、短名有歧义、元数据或规则集文件不合法 |
| `NOT_CONFIGURED` | profile 没有 catalog 端点，或缺 `metadata_dir` / `warehouse_root`，或元数据目录不存在 |
| `UNSUPPORTED` | provider 不是 `file`，或 storage 不是 `local-filesystem` |
| `CAPABILITY_PLANNED` | `data transfer get` |

## 7. 接入其它目录 / 表格式 provider（待接入）

Hive Metastore、Iceberg/Hudi/Delta 等表格式目录尚未接入；**不另注册重复命令**，而是作为 `catalog` 端点的新 `provider` 实现同一组能力：

1. 在 `openCatalog` 中按 `provider` 分派：`hive-metastore` 通过 Thrift/REST 读取库表、`StorageDescriptor.location`、分区键与分区列表，映射到 `TableMetaSchema`（分区语义、负责人、上下游等平台元数据仍可来自补充 YAML）。
2. 分区存在性以 Metastore 分区记录（explicit）和存储列举（derived）**分别**报告，两者不一致时如实给出两边结果，不合并成一个结论。
3. 表格式（Iceberg 等）以快照/manifest 为准，文件列举只能作为辅助；`success_marker` 对这类表通常为 `null`。
4. 对象存储 / HDFS 需要独立的存储适配器并在 `storage` 中标识（如 `s3`、`hdfs`），验证前不得复用 `local-filesystem` 的结果。
5. 认证走 profile 的 `*_ref` 凭据引用；provider 版本写入 `meta.sources[].version`；在验证前，provider 状态标为 planned / 未验证。

`data transfer get`（DataX、CDC、跨集群拷贝等同步任务）同样为 planned：同步任务成功不等于目标分区可读或质量通过。
