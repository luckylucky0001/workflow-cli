# MySQL / Redis 场景脚本

`scenario.mjs` 为 `mysql`、`redis` 领域准备可观测的真实数据（全部为合成数据）。只依赖仓库已有的 `mysql2`、`ioredis`，从仓库根目录运行。MySQL 以应用账号 `demo_app` 连接（口令读自 `demo/environment/.runtime/secrets/mysql_app_password`，不会打印）；Redis 连接 `127.0.0.1:16379`。可用 `MYSQL_HOST/MYSQL_PORT/REDIS_HOST/REDIS_PORT` 覆盖。

## 前置

```bash
cd demo/environment && SKIP_OFFLINE=1 ./up.sh mysql redis && ./mysql/provision-users.sh && cd -
export WORKCTL_CONFIG=$PWD/demo/environment/workctl.yaml
```

`provision-users.sh` 是必须的：MySQL 初始化脚本以 `mysql` 用户运行，读不到 0600 的 secret 文件，`workctl_ro` / `demo_app` 会先以 LOCKED 状态创建，该脚本在容器内以 root 设置口令并解锁（幂等，可重复执行）。

## 模式

| 命令 | 作用 | 之后可以观察 |
|---|---|---|
| `node demo/scenarios/mysql-redis/scenario.mjs warm-cache [--flush]` | 按 demo-order 的缓存格式写入 `demo:order:<id>`（3000 个，约 10% 无 TTL）、`demo:customer:<id>:recent`；大键候选 `demo:customer:<1..20>:history`（list）、`demo:leaderboard:amount:2026-10-16`（zset）、`demo:export:orders:2026-10-16T00`（string）；`demo:customer:<id>:profile`（hash，无 TTL）；随后制造倾斜读流量和几条 >1ms 的慢命令。`--flush` 先删除 `demo:*` | `redis key sample --pattern "demo:*" --max-keys 5000 --max-scan-calls 200`、`redis key hot --pattern "demo:*"`、`redis key inspect --key demo:customer:1:history`、`redis slowlog list` |
| `node demo/scenarios/mysql-redis/scenario.mjs redis-traffic [--seconds 10]` | 持续的热键读 + 缺失键读 | 另开终端 `redis stats sample --duration 5s`（命中率、ops/s） |
| `node demo/scenarios/mysql-redis/scenario.mjs mysql-load [--seconds 20] [--concurrency 4]` | 复现 demo-order 的两条查询：`WHERE customer_id=?`（无索引，扫描 `idx_created_at`）与 `WHERE id=?` | 同时运行 `mysql statement summary --sample-window 10s`、`mysql slowlog list --since 10m`、`mysql session list` |
| `node demo/scenarios/mysql-redis/scenario.mjs lock-wait [--seconds 20]` | 一个事务锁住 `orders.id=42` 后保持空闲，另一个事务等待该行 | 期间运行 `mysql lock list`（`root_blockers`）与 `mysql session list`（`idle_in_trx=1`） |

## 端到端示例

```bash
node demo/scenarios/mysql-redis/scenario.mjs mysql-load --seconds 25 &
workctl --json --timeout 45s mysql statement summary --sample-window 15s --database demo --top 5
workctl --json mysql query explain --database demo --sql-file <(echo "SELECT id,status,amount,created_at FROM orders WHERE customer_id=4242 ORDER BY created_at DESC LIMIT 20")
workctl --json mysql index plan --database demo --table orders --columns customer_id
```

计划只是预览（`executable=false`）；在 Demo 中如需验证收益，可由 DBA 角色用 root 手动执行计划中的 DDL，再用 `mysql index list` / `mysql query explain` / `mysql statement summary` 复核，最后按 `rollback` 删除索引以复位场景（或 `demo/environment/reset.sh` 全量复位）。
