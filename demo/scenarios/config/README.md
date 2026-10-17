# 场景：配置中心与服务发现（etcd v3 / Nacos / Consul）

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

## Nacos 与 Consul provider

同一组命令按**服务绑定的配置中心端点类型**选择 provider（`bindings.yaml`）：`demo-order` 未绑定 → 默认 etcd；`demo-payment.attributes.config_center=demo-nacos` → Nacos；`demo-inventory.attributes.config_center=demo-consul` → Consul。这两个服务只存在于配置中心里（合成数据，没有容器）。输出中 `data.provider` / `provider_selected_by` / `revision_space` 写明选择依据与修订号含义。

```bash
cd demo/environment && docker compose up -d --no-deps nacos consul   # Nacos 启动约 20-40 秒
cd ../..
node demo/scenarios/config/seed-nacos.mjs     # 可重复执行；打印各步的 Nacos 历史 ID（steps[].history_id）
node demo/scenarios/config/seed-consul.mjs    # 可重复执行；打印各键 CreateIndex / ModifyIndex
```

| 后端 | 容器 / 端口 | 种子内容 |
| --- | --- | --- |
| Nacos 2.4.3（standalone，内嵌存储，鉴权关闭） | `demo-nacos`，18848→8848 | 命名空间 `sandbox`，`DEFAULT_GROUP/demo-payment.properties` 三个版本：v1 初始（`order.timeout_ms=800`、`db.password`、`legacy.callback`…）→ v2（超时 1500、`feature.refund_v2=true`、删除 `legacy.callback`、新增 `risk.max_amount`）→ v3（轮换 `db.password`、新增 `callback.token`）。每次执行先删除再发布，历史记录持续累积（删除也是一条 `D` 记录）。服务 `demo-payment` 三个**持久**实例：`127.0.0.1:8848`（服务端 TCP 探测可达 → healthy）、`127.0.0.1:9`（无监听 → unhealthy）、`127.0.0.2:8848`（`enabled=false`，已下线但仍注册）。 |
| Consul 1.20.6（dev agent，ACL 关闭，内存存储） | `demo-consul`，18500→8500 | KV `config/sandbox/demo-inventory/`：`cache.ttl_seconds`（120→30）、`db.password`（轮换）、`db.pool_size`、`warehouse.default`、`upstream.order`（JSON，含 `api_key`）、`feature.flags`。**Consul 不保留旧值**，只有最终值与 Create/ModifyIndex。服务 `demo-inventory` 三个实例，TTL 检查分别为 passing / critical / warning。dev agent 重启后数据清空，重新执行种子即可。 |

```bash
workctl config get --service demo-payment                         # Nacos：properties 拆键，db.password / callback.token 遮蔽
workctl config diff --service demo-payment --key order.timeout_ms # 沿历史前像找到上一值：800 → 1500
workctl config diff --service demo-payment --from-rev <v1> --to-rev <v3>   # 历史 ID（seed 输出 / config get 的 nacos.latest_history_id）
workctl config diff --service demo-payment --from-rev 0           # 早于最早保留记录 → DATA_UNAVAILABLE
workctl discovery list --service demo-payment                     # healthy / enabled / ephemeral / weight
workctl config get --service demo-inventory                       # Consul：Create/ModifyIndex，observed_revision=X-Consul-Index
workctl config diff --service demo-inventory --key db.password    # KV 无历史 → DATA_UNAVAILABLE（只给 modify_index）
workctl discovery list --service demo-inventory --healthy-only    # critical 被排除，warning 计为 healthy
workctl config get --service demo-inventory --endpoint apollo/x   # 规划中的 provider → CAPABILITY_PLANNED
```

Nacos 历史记录保存的是**变更前的内容**（`U`/`D` 为前像，`I` 为新内容），workctl 据此重建“某历史 ID 生效后”的文档再按键比较；历史默认保留 30 天（`GET /nacos/v1/console/server/state` 的 `config_retention_days`）。

验证记录：`node scripts/verify-demo.mjs demo/verification/cases.config-nacos.json` → `report.config-nacos.md`；`cases.config-consul.json` → `report.config-consul.md`。活体测试：`WORKCTL_IT=1 npx vitest run test/config/live-providers.test.ts`。
