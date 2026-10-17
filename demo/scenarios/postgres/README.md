# PostgreSQL 场景脚本

`scenario.mjs` 为 `pg` 领域准备可观测的真实状态（全部为合成数据，库 `demo_orders`）。只依赖仓库已有的 `pg` 驱动，从仓库根目录运行。脚本以 Demo 超级用户 `postgres` 连接（口令读自 `demo/environment/.runtime/secrets/pg_superuser_password`，不会打印），只写 `demo_orders`。可用 `PG_HOST/PG_PORT/PG_DATABASE` 覆盖。

## 前置

```bash
cd demo/environment && SKIP_OFFLINE=1 ./up.sh postgres && cd -      # 或已有环境: docker compose up -d --no-deps postgres && ./postgres/provision-users.sh
export WORKCTL_CONFIG=$PWD/demo/environment/workctl.yaml
```

`provision-users.sh` 是必须的：初始化脚本以 `postgres` OS 用户运行，读不到 0600 的 secret 文件，`workctl_ro` 先以 NOLOGIN 创建，该脚本在容器内以 root 设置口令并开启 LOGIN（幂等，可重复执行）。

初始化数据（`demo/environment/postgres/init/01-schema.sql`）：`customers` 2000 行、`orders` 50000 行（`customer_id` **故意不建索引**）、`order_items` 约 10 万行、`internal_ledger`（**故意不授权**给 `workctl_ro`，用于演示 PERMISSION_DENIED）。

## 模式

| 命令 | 作用 | 之后可以观察 |
|---|---|---|
| `node demo/scenarios/postgres/scenario.mjs reset-stats` | `pg_stat_statements_reset()` + `pg_stat_reset()`，让累计值从现在开始 | `pg statement summary --sample-window 0` 的 `cumulative_since.stats_reset` |
| `node demo/scenarios/postgres/scenario.mjs load [--seconds 20] [--concurrency 4]` | 复现两条查询：`WHERE customer_id=$1`（无索引 → Seq Scan + Sort）与 `WHERE id=$1`（主键） | 同时运行 `pg statement summary --sample-window 10s`、`pg session list`；之后 `pg table get --table orders`（`seq_scan` 增长） |
| `node demo/scenarios/postgres/scenario.mjs churn` | 确定性地更新 10% 的订单（5000 行） | `pg table get --table orders` 的 `n_dead_tup` / `dead_ratio` / `n_mod_since_analyze` |
| `node demo/scenarios/postgres/scenario.mjs lock-wait [--seconds 20]` | 事务 A 锁住 `orders.id=42` 后保持 idle in transaction，事务 B 等待同一行；结束后都回滚 | 期间运行 `pg lock list`（`root_blockers`、`waiting_for` 为 transactionid ShareLock）与 `pg session list`（`idle_in_transaction=1`、`blocked=1`） |

## 端到端示例

```bash
node demo/scenarios/postgres/scenario.mjs load --seconds 25 &
workctl --json --timeout 45s pg statement summary --sample-window 15s --database demo_orders --top 5
workctl --json pg query explain --sql "SELECT id, status, amount, created_at FROM orders WHERE customer_id = 42 ORDER BY created_at DESC LIMIT 20"
workctl --json pg query analyze --sql "SELECT id, status, amount, created_at FROM orders WHERE customer_id = 42 ORDER BY created_at DESC LIMIT 20"
workctl --json pg table get --table orders
```

结论应基于证据：`statement summary` 显示 `customer_id` 查询总耗时最高、`rows_per_call` 低而 `shared_blks_hit` 高；`explain`/`analyze` 显示 `Seq Scan on orders` + `Rows Removed by Filter ≈ 49975`；`table get` 显示 `seq_scan` 持续增长、`orders` 上没有以 `customer_id` 开头的索引。加索引（`CREATE INDEX CONCURRENTLY ... (customer_id, created_at)`）属于变更，workctl 只读角色不执行；`pg index plan` 目前是 planned。
