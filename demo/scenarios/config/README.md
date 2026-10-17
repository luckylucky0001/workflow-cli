# 场景：配置中心与服务发现（etcd v3）

在隔离 demo 环境中演示 `config get` / `config diff` / `discovery list`。后端是真实的 etcd 3.5（容器 `demo-etcd`，`bitnamilegacy/etcd:3.5`，端口 12379，无认证），workctl 通过 etcd v3 HTTP/JSON 网关（`POST /v3/kv/range`、`/v3/lease/timetolive` 等）读取。**所有键值都是合成数据**（包括 `db.password`、`upstream.payment.token` 这类“看起来像凭据”的值，用来演示遮蔽）。

```bash
cd demo/environment && docker compose up -d --no-deps etcd
export WORKCTL_CONFIG=$PWD/workctl.yaml
cd ../..
node demo/scenarios/config/seed.mjs            # 可重复执行；打印每一步写入后的集群修订号（steps[].revision）
```

## 种子内容

| 步骤 | 写入 | 用途 |
| --- | --- | --- |
| reset | 删除 `/config/sandbox/demo-order/`、`/services/demo-order/`，撤销旧注册的租约 | 可重复执行 |
| v1 | `cache.mode`、`cache.ttl_seconds=300`、`db.pool_size=10`、`db.password`、`feature.flags`（JSON）、`feature.legacy_mode`、`upstream.payment`（JSON，含 `token` 字段） | 初始配置 |
| v2 | `feature.flags` 打开 `new_checkout`、`db.pool_size=20`、删除 `feature.legacy_mode` | 有新增/修改/删除 |
| v3 | `cache.ttl_seconds=60`、新增 `cache.max_entries`、轮换 `db.password` 与 `upstream.payment.token` | 敏感值变化只显示 `***` |
| v4 | 以相同值重写 `cache.mode` | 区分“重写”与“变化” |
| 注册 | `/services/demo-order/order-1`（healthy=true，租约）、`order-2`（healthy=false，租约）、`order-legacy`（无租约） | 租约 TTL 默认 86400 秒（`--ttl` 可改），没有续约进程，过期后重新执行种子即可 |

修订号是 etcd **集群级**全局修订，每次执行种子都会变；用输出里的 `steps[].revision`，或从 `config get` 的 `create_revision` / `mod_revision` 取。

## 演示

```bash
workctl config get --service demo-order                               # observed_revision、各键 mod_revision/version，敏感值 ***
workctl config get --service demo-order --key upstream.payment        # JSON 字段级遮蔽：masked_paths=["$.token"]
workctl config diff --service demo-order --from-rev <v1> --to-rev <v3>
workctl config diff --service demo-order --key cache.ttl_seconds      # 与该键上一版本比较（300 → 60）
workctl config diff --service demo-order --key cache.mode             # 同值重写：changes 为空，rewritten_same_value=1
workctl config diff --service demo-order --from-rev 99999999          # 未来修订 → INVALID_ARGUMENT
workctl discovery list --service demo-order                           # 租约剩余 TTL；order-legacy 无租约，不会自动过期
workctl discovery list --service demo-order --env sandbox --healthy-only
workctl auth status --probe                                           # etcd 版本、leader、db 大小
```

## 压缩（compaction）

压缩是**整个集群**的、不可逆的操作。不要压缩 `demo-etcd`（会丢掉上面的演示历史）。早于压缩点的 `config diff --from-rev` 返回 `DATA_UNAVAILABLE`、`details.compact_revision` 为最早可读修订；这一路径由 `test/config/live.test.ts` 在测试自行启动并删除的临时 etcd 容器上验证（`WORKCTL_IT=1`）。

验证记录：`node scripts/verify-demo.mjs demo/verification/cases.config.json` → `demo/verification/report.config.md`。
