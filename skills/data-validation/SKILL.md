---
name: data-validation
description: 验证离线数据产出与质量：表元数据与分区语义、某个业务日期的分区是否存在/完整/可读、质量规则是否通过、上下游血缘与影响范围。当用户提到分区缺失、数据没产出、数据不对、重复/空值、质量检查、数据延迟、血缘、上游/下游影响、dt 分区、ods/analytics 表时使用（workctl data ...）。
---

# 数据产出与质量验证（workctl data）

## 能力

| 目的 | 命令 |
|---|---|
| 表定义、分区语义、产出任务、物理位置 | `workctl --json data table get --catalog demo --table <db.table>` |
| 列出分区（文件数、字节、修改时间、_SUCCESS） | `workctl --json data partition list --table <db.table> [--from D1 --to D2]` |
| 单个分区逐项检查 | `workctl --json data partition get --table <db.table> --partition 'dt=YYYY-MM-DD'` |
| 质量规则 | `workctl --json data quality check --dataset demo.<db>.<table> --partition 'dt=YYYY-MM-DD' [--ruleset <name>] [--sample-rows N]` |
| 血缘 / 影响范围 | `workctl --json data lineage get --table <db.table> --direction upstream\|downstream [--depth N]` |
| 同步任务状态 | `data.transfer.get` 为 planned，不可调用；如实告知未接入 |

`--catalog` 是 profile 中 `endpoints.catalog` 的名字（演示环境 `demo`），缺省用 profile 默认值。

## 先确认业务日期

- `dt` 是**业务日期**（表元数据 `partition_keys[].semantics`，demo 为 Asia/Shanghai 自然日），不是任务启动日期，也不是 UTC 日期。
- 用户说“昨天的数据”时，按业务时区换算后再查；Airflow 日调度的 run 通常在 D+1 处理业务日期 D。
- `partition get` 的 `checks.defined.business_date` 给出业务时区的今天、该日是否结束、产出期限 `expected_ready_by` 及是否已过。

## 排查流程：“某天的数据没出来 / 数据不对”

1. `data partition get` 读 `state` 和各检查项，**逐项**报告，不要合并成“正常/不正常”：
   - `missing`：目录不存在。先看 `business_date.day_ended` / `deadline_passed`——还没到期限通常只是尚未产出。
     看 `nearby_partitions`：若 D 缺失而 D+1 存在，怀疑写错分区（如误用 next_ds），用第 2 步的 `partition_value_match` 结果佐证。
   - `incomplete`：有数据文件但无 `_SUCCESS`，可能仍在写或写入中断；查调度/计算状态（offline/compute 领域）后再下结论。
   - `empty`：目录在但没有记录；可能上游当天确实无数据，也可能抽取失败——查上游分区。
   - `unreadable`：`checks.readable.files[].parse_errors` 给出行号与错误。
   - `present`：只说明存在、完整、抽查可解析，**不代表内容正确**。
2. `data quality check` 看 `quality_state`、`precondition`、`summary`，再逐条看 `results[]` 的 `status / observed / samples`：
   - 前置条件不满足（分区 missing/incomplete）时其余规则都是 `skipped`——这不是“规则通过”。
   - `conclusive=false`（抽样）时，pass 只说明样本内没发现问题；需要结论时去掉 `--sample-rows` 全量重跑。
   - `severity: warn` 的失败（如 freshness 晚于期限）不改变总体结论，但要单独告知。
   - `partition_value_match` 失败 = 数据内容的业务日期与分区不一致（写错分区或取数口径错）。
3. 影响范围：`data lineage get --direction downstream`，列出受影响的表、报表、工作流；
   上游原因：`--direction upstream` 后对上游表的同一业务日期重复第 1–2 步。

## 口径（回答时必须遵守）

- 调度成功、计算成功、分区存在、文件可读、质量规则通过是**五个不同检查项**，各自引用证据；本领域只覆盖后三项。
- 血缘边区分 `explicit`（目录声明）与 `inferred`（SQL 正则推断）；`confirmed_by_both` 才是两方面都支持。
  `unresolved` 节点表示 SQL 中的名字无法对应到目录表，不要按相似名称补全。SQL 推断看不到动态 SQL 和程序内读写（见 `coverage.notes`）。
- 存储只验证了本地文件系统（`storage.type=local-filesystem`）；不要声称对象存储或 HDFS 上的数据已验证。
- 更新时间来自文件 mtime（`basis` 字段），不是调度系统记录。
- 违规样本已对敏感列脱敏（`***`）；不要试图还原或要求输出原值。
- 演示环境数据全部是合成数据（`demo/synthetic-data`）；`ods.orders` 的 MySQL 上游是声明的业务来源，演示中并未实际读取 MySQL。
- 引用历史质量结果（状态目录中的最近一次结果）时必须给出 `checked_at`，旧结果不代表当前数据。

## 错误处理

| code | 含义 | 下一步 |
|---|---|---|
| `NOT_FOUND` | 表或规则集不在目录中 | 从 `hint` 的已登记表中确认，不要猜相近表名 |
| `INVALID_ARGUMENT` | 分区格式/键名/日期不对；短名有歧义；规则集与表不匹配 | 按 `hint` 修正，如 `--partition dt=2026-10-16`、写全 `demo.<db>.<table>` |
| `NOT_CONFIGURED` | profile 没有 catalog 端点 | 请用户补配置 |
| `UNSUPPORTED` | provider / storage 未接入（如 Hive Metastore、s3） | 如实说明未接入 |

## 边界

- 全部只读：不重写分区、不修复数据。补数/重跑走 offline 领域的计划（plan）与授权执行。
- 详细契约与规则参考见 `docs/guides/data.md`。
