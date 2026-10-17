# 隔离演示环境验证记录（config-consul）

> 由 `node scripts/verify-demo.mjs demo/verification/cases.config-consul.json` 生成于 2026-10-17T16:39:31.759Z；原始结果信封见 `demo/verification/envelopes-config-consul/`。全部为合成数据。

通过 12 / 12

| # | 命令 | 期望 | 实际 | 退出码 | 耗时 ms | 来源@版本 | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ✅ consul-01 | `workctl auth status --probe` | success | success | 0 | 1007 | workctl | 端点探测：consul 走 GET /v1/agent/self + /v1/status/leader（版本、数据中心、ACL 开关） |
| ✅ consul-02 | `workctl config get --service demo-inventory --env sandbox` | success | success | 0 | 617 | consul@1.20.6 | provider 由资源绑定 demo-inventory.attributes.config_center=demo-consul 选择；KV ?recurse，Create/ModifyIndex，observed_revision=X-Consul-Index；db.password 遮蔽 |
| ✅ consul-03 | `workctl config get --service demo-inventory --key upstream.order` | success | success | 0 | 686 | consul@1.20.6 | JSON 字段级遮蔽：masked_paths=["$.api_key"] |
| ✅ consul-04 | `workctl config diff --service demo-inventory --key db.password` | DATA_UNAVAILABLE | DATA_UNAVAILABLE | 7 | 555 |  | Consul KV 无历史：DATA_UNAVAILABLE，details 只给 create_index / modify_index，不编造旧值 |
| ✅ consul-05 | `workctl config diff --service demo-inventory --from-rev 249` | DATA_UNAVAILABLE | DATA_UNAVAILABLE | 7 | 582 |  | 索引区间比较同样无历史：DATA_UNAVAILABLE，details.changed_since 列出 ModifyIndex 更大的键 |
| ✅ consul-06 | `workctl config get --service demo-inventory --key no.such.key` | NOT_FOUND | NOT_FOUND | 5 | 535 |  | 键不存在 → NOT_FOUND |
| ✅ consul-07 | `workctl config get --service ghost-svc --endpoint consul/demo-consul` | success | success | 0 | 622 | consul@1.20.6 | 前缀为空：success + 空列表（Consul 404 即“没有键”） |
| ✅ consul-08 | `workctl discovery list --service demo-inventory` | success | success | 0 | 569 | consul@1.20.6 | 健康检查聚合：inventory-1 passing、inventory-2 critical → unhealthy、inventory-3 warning（计为 healthy，注明） |
| ✅ consul-09 | `workctl discovery list --service demo-inventory --env sandbox --healthy-only` | success | success | 0 | 477 | consul@1.20.6 | 过滤 critical |
| ✅ consul-10 | `workctl discovery list --service ghost-svc --endpoint consul/demo-consul` | success | success | 0 | 530 | consul@1.20.6 | 未注册服务：/v1/catalog/services 中不存在 → service_registered=false |
| ✅ consul-11 | `workctl config get --service demo-inventory --endpoint apollo/demo-apollo` | CAPABILITY_PLANNED | CAPABILITY_PLANNED | 8 | 375 |  | 规划中的 provider（Apollo）→ CAPABILITY_PLANNED，不模拟 |
| ✅ consul-12 | `workctl config diff --service demo-inventory --key warehouse.default --from-rev 249` | success | success | 0 | 555 | consul@1.20.6 | 单键的 X-Consul-Index 是该键的 ModifyIndex（不是全局索引）：--from-rev 晚于它 → 区间内没有写入，空差异（不是 INVALID_ARGUMENT） |
