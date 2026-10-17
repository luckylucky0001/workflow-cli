# 合成订单数据（demo）

**本目录产生的所有数据都是合成数据**：由固定种子的伪随机数生成，不来自任何真实用户、订单或生产系统。
`order_id`、`customer_id`、金额、时间都只在演示环境内有意义。

## generate_orders.py

只依赖 Python 3 标准库。为一个业务日期（Asia/Shanghai 自然日）生成一个 `ods.orders` 分区：

```bash
python3 demo/synthetic-data/generate_orders.py --date 2026-10-16 \
  --out demo/environment/.runtime/warehouse/ods/orders/dt=2026-10-16 [--rows 5000] [--seed N] [--format json|csv]
```

| 输出 | 说明 |
|---|---|
| `part-00000.json` | JSON lines，每行一笔订单（`--format csv` 时为带表头的 `part-00000.csv`） |
| `_SUCCESS` | 最后写入的完成标记，与 Spark `df.write.json` 一致 |
| stdout | 一行 JSON 摘要：`synthetic: true`、行数、种子、注入的缺陷数 |

- 字段：`order_id, customer_id, status, amount, item_count, created_at, updated_at`，与演示 MySQL 表 `demo.orders` 结构一致（`id` → `order_id`）。
- `created_at` 落在 `[D 00:00, D+1 00:00) +08:00`，带 `+08:00` 偏移；`updated_at` 可能跨到次日。
- 确定性：默认种子由日期推出（`20261016`），同一日期、同一参数重跑结果逐字节相同。
- 原子性：先写到隐藏的兄弟目录 `.dt=...tmp-<pid>`，再整体 rename 到目标目录；已有分区被整体替换（overwrite_partition 语义）。读取方不会看到写了一半的分区。

## 演示用质量缺陷

`--inject` 可重复指定，每种约影响 0.5% 的行（至少 1 行）：

| 选项 | 效果 | 会失败的规则（`demo-ods-rules`） |
|---|---|---|
| `duplicates` | 追加重复的订单行（同一 `order_id`） | `order_id_unique` |
| `nulls` | `customer_id` 或 `amount` 置为 null | `required_not_null` |
| `bad_status` | `status` 改成 `UNKNOWN` / `paid` / 空串 | `known_status` |

```bash
python3 demo/synthetic-data/generate_orders.py --date 2026-10-15 --out <warehouse>/ods/orders/dt=2026-10-15 --inject duplicates --inject nulls
workctl --json data quality check --dataset demo.ods.orders --partition 'dt=2026-10-15'
```

在离线链路中，`demo-ods-orders` DAG 的 `extract_orders` 任务调用本脚本代替真实抽取；目录元数据
`ods.orders` 中声明的上游 `mysql://demo-mysql/demo.orders` 是平台层面的业务来源，演示环境并未实际读取 MySQL。
