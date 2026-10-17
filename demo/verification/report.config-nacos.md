# 隔离演示环境验证记录（config-nacos）

> 由 `node scripts/verify-demo.mjs demo/verification/cases.config-nacos.json` 生成于 2026-10-17T16:20:37.540Z；原始结果信封见 `demo/verification/envelopes-config-nacos/`。全部为合成数据。

通过 13 / 13

| # | 命令 | 期望 | 实际 | 退出码 | 耗时 ms | 来源@版本 | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ✅ nacos-01 | `workctl auth status --probe` | success | success | 0 | 1209 | workctl | 端点探测：nacos 走 GET /nacos/v1/console/server/state（版本、standalone、鉴权开关、历史保留天数） |
| ✅ nacos-02 | `workctl config get --service demo-payment --env sandbox` | success | success | 0 | 614 | nacos@2.4.3 | provider 由资源绑定 demo-payment.attributes.config_center=demo-nacos 选择；properties 文档拆为键；db.password / callback.token 遮蔽且 value_bytes=null |
| ✅ nacos-03 | `workctl config get --service demo-payment --key db.password` | success | success | 0 | 777 | nacos@2.4.3 | 单键读取：整值遮蔽，不暴露长度 |
| ✅ nacos-04 | `workctl config diff --service demo-payment --key order.timeout_ms` | success | success | 0 | 1066 | nacos@2.4.3 | 与该键上一值比较（800 → 1500）：沿历史前像回溯，from_history 为变更前的记录 |
| ✅ nacos-05 | `workctl config diff --service demo-payment --from-rev 32 --to-rev 34` | success | success | 0 | 1024 | nacos@2.4.3 | 真实历史 ID 间差异：added risk.max_amount / callback.token、removed legacy.callback、changed ×3（含遮蔽的 db.password） |
| ✅ nacos-06 | `workctl config diff --service demo-payment --key db.password` | success | success | 0 | 789 | nacos@2.4.3 | 密码轮换：两侧均 ***，changed 依据原始内容判断 |
| ✅ nacos-07 | `workctl config diff --service demo-payment --from-rev 0` | DATA_UNAVAILABLE | DATA_UNAVAILABLE | 7 | 659 |  | 早于保留的最早历史记录 → DATA_UNAVAILABLE（details.oldest_history_id、retention_days=30） |
| ✅ nacos-08 | `workctl config diff --service demo-payment` | INVALID_ARGUMENT | INVALID_ARGUMENT | 2 | 765 |  | 既无 --from-rev 也无 --key → INVALID_ARGUMENT |
| ✅ nacos-09 | `workctl config get --service demo-payment --key no.such.key` | NOT_FOUND | NOT_FOUND | 5 | 771 |  | 键不存在 → NOT_FOUND（hint 列出文档中的键） |
| ✅ nacos-10 | `workctl config get --service demo-refund --endpoint nacos/demo-nacos` | success | success | 0 | 783 | nacos@2.4.3 | 文档不存在：success + 空列表 + nacos.exists=false（与“无权限/不可达”区分） |
| ✅ nacos-11 | `workctl discovery list --service demo-payment` | success | success | 0 | 1009 | nacos@2.4.3 | 持久实例：127.0.0.1:9 服务端 TCP 探测失败 healthy=false；127.0.0.2 enabled=false 仍在注册表 |
| ✅ nacos-12 | `workctl discovery list --service demo-payment --env sandbox --healthy-only` | success | success | 0 | 1053 | nacos@2.4.3 | 按 metadata.env 与健康过滤 |
| ✅ nacos-13 | `workctl discovery list --service ghost-svc --endpoint demo-nacos` | success | success | 0 | 669 | nacos@2.4.3 | 未注册服务：success + 空列表，summary.service_registered=false |
