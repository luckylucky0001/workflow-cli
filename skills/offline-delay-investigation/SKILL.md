---
name: offline-delay-investigation
description: 排查离线数据延迟或缺失的流程：当用户说某个业务日期的表没按时产出、日报/报表数据没更新、任务一直在等、跑成功了但没数据、写错分区时使用。按产出时效 → 运行分层状态 → 上游依赖 → 计算日志的顺序取证，区分事实与假设（workctl offline freshness check / run get / dependency list / log get / compute ...）。只核对分区/质量改用 data-validation；查看 DAG、补数等日常操作改用 offline-operations。
---

# 离线数据延迟 / 缺失排查

> **调用约定**：profile/端点已由环境（`WORKCTL_CONFIG` / `--profile`）给定，直接以 `workctl` 开头调用，全局参数紧跟其后：`workctl --json <命令> ...`；不要加环境变量前缀、`cd`、管道或 `node dist/workctl.js`。命令被宿主拒绝时不要换写法绕过，说明需要授权的只读命令。

目标：回答“业务日期 D 的 <表> 为什么没按时产出”，每个结论都有证据，事实与假设分开写。

## 步骤

1. **确认是否真的延迟**
   `workctl --json offline freshness check --dataset <db.table> --data-date D`
   - `verdict`: `on_time` / `late` / `missing` / `not_due` / `unknown`；引用 `expected_by.local`（业务时区）与 `partition_updated_at`。
   - `not_due` → 还没到约定时限，告知时限即可，不要当成故障。
   - `producer.runs` 给出产出工作流该业务日期的 run：没有 run / 失败 / 成功。

2. **看产出工作流这一次运行的分层状态**
   `workctl --json offline run get --workflow <dag> --id <run_id>`（run_id 来自上一步或 `offline run list --data-date D`）

   | scheduler | compute | output | 典型解读（先作为假设） |
   |---|---|---|---|
   | 无 run | — | missing | 没有调度/没有触发：查 `workflow get` 的 `is_paused`、`next_run`、start_date/catchup |
   | running，传感器 `up_for_reschedule` | unknown | missing | 等上游：转第 3 步 |
   | running，任务 queued/scheduled | — | missing | 排队：`compute queue get --id <pool>` 看 `open_slots`、`waiting_slots` |
   | failed | failed/unknown | missing/incomplete | 任务失败：转第 4 步 |
   | success | succeeded | missing | 跑成功但目标分区没有：怀疑写错分区/路径，转第 5 步 |
   | success | succeeded | present | 已产出：若 freshness 为 late，比较 run 的 start/end 与时限，延迟来自启动晚还是运行慢 |

3. **上游是否就绪**
   `workctl --json offline dependency list --run-id <run_id> --direction upstream`
   - `data_dependencies[].state` 为 missing/incomplete 的输入分区就是阻塞点（`edge_source=catalog-metadata`）。
   - `workflow_dependencies[].run` 为 null → 上游工作流该业务日期没有 run；有 run 则对上游 run 递归执行第 2 步。
   - 传感器日志：`offline log get --run-id <run_id> --task <sensor_task> --limit-lines 50`（每次 poke 打印检查的路径）。

4. **任务或计算失败**
   - `offline log get --run-id <run_id> --task <task>`：找异常栈与 `WORKCTL_SPARK_APP_ID=`。
   - `compute job get --id <app_id>` → `compute stage list --job-id <app_id> --status failed` 看 `failure_reason`；
     `compute log get --job-id <app_id> --limit-lines 200` 看 driver 日志（来源是 driver 日志目录，不是 Spark REST）。

5. **成功但分区缺失（写错分区）**
   - `data partition get --table <db.table> --partition dt=D` 看 `nearby_partitions`；D+1 存在而 D 缺失是写错分区的迹象。
   - 对疑似被写入的分区做质量检查：`data quality check --dataset <catalog>.<table> --partition dt=D+1`，`partition_value_match` 类规则失败（业务日期列与 `dt` 不一致）即事实证据。
   - 用只读查询取证：`sql query submit --engine spark --file <按 dt 汇总 order_date 的 SQL>`，`dt` 与业务日期列不一致即事实证据。
   - `offline log get` 中 spark-submit 的 `--output` 路径、`run get` 的 `run.conf`（如 fault 参数）是原因线索。

6. **影响范围**：`data lineage get --table <db.table> --direction downstream` 或 `offline dependency list --direction downstream`。

## 报告模板

1. **事实**：每条写 命令 + 来源（`meta.sources` 的 system/method，`relation`）+ 窗口或观测时间。先写结论行：D 的 <表> 当前 `<verdict>`（时限 `expected_by.local`，业务时区 + UTC）；再按 调度层 / 计算层 / 产出层 / 质量层 / 上游 逐层列出。
2. **判断与假设**：标注“已验证”或“假设”，写出依据、不确定性与验证命令。如“输出路径使用了 data_interval_end 导致写入 dt=D+1”。
3. **下一步**：可复现的只读命令；涉及变更时只给计划 ID（计划 → 确认 → 执行 → 复核，执行须用户明确确认且 `allow_execute`）。修复后用 `workctl --json offline backfill plan ...` 生成补数计划，见 offline-operations。
4. **覆盖缺口**：未采集（`COLLECTION_DISABLED`）、无权限、`partial`、保留期外/缓冲不可见、只有快照的数据。如某层 `unknown`、日志已轮转、血缘只有 inferred。

## 注意

- 业务日期 ≠ 启动日期；同时给出业务时区与 UTC。
- 调度成功 ≠ 计算成功 ≠ 分区存在 ≠ 质量通过；任何一层 `unknown` 都要说明，不要补全。
- reschedule 传感器等待不占 pool 槽，“pool 满”不能解释传感器等待。
