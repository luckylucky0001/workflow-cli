# 隔离演示环境验证记录（config）

> 由 `node scripts/verify-demo.mjs demo/verification/cases.config.json` 生成于 2026-10-18T05:52:51.001Z；原始结果信封见 `demo/verification/envelopes-config/`。全部为合成数据。

通过 16 / 16

| # | 命令 | 期望 | 实际 | 退出码 | 耗时 ms | 来源@版本 | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ✅ config-01 | `workctl auth status --probe` | success | success | 0 | 714 | workctl | etcd 端点探测：GET /version + POST /v3/maintenance/status（leader、db 大小）+ /v3/auth/status |
| ✅ config-02 | `workctl config get --service demo-order --env sandbox` | success | success | 0 | 440 | etcd@3.5.21 | 前缀 /config/sandbox/demo-order/ 全部键：JSON 解析、db.password 与 upstream.payment.token 遮蔽、create/mod_revision、version |
| ✅ config-03 | `workctl config get --service demo-order --key upstream.payment` | success | success | 0 | 425 | etcd@3.5.21 | 单键读取；捕获 v1（种子第 1 步末修订）与 v3（第 3 步末修订） |
| ✅ config-04 | `workctl config diff --service demo-order --from-rev 79 --to-rev 86` | success | success | 0 | 406 | etcd@3.5.21 | 真实修订间差异：added cache.max_entries、removed feature.legacy_mode、changed ×5（含遮蔽值） |
| ✅ config-05 | `workctl config diff --service demo-order --env sandbox --from-rev 79` | success | success | 0 | 383 | etcd@3.5.21 | v1 → current：含 cache.mode 同值重写（rewritten_same_value=1，不计为变化） |
| ✅ config-06 | `workctl config diff --service demo-order --key cache.ttl_seconds` | success | success | 0 | 451 | etcd@3.5.21 | 省略 --from-rev：与该键上一版本（mod_revision-1）比较，300 → 60 |
| ✅ config-07 | `workctl config diff --service demo-order --key cache.mode` | success | success | 0 | 365 | etcd@3.5.21 | 上一版本同值重写：changes 为空，summary.rewritten_same_value=1 |
| ✅ config-08 | `workctl config get --service demo-order --key cache.not_exist` | NOT_FOUND | NOT_FOUND | 5 | 367 |  | 单键不存在：NOT_FOUND，hint 列出前缀下已有键 |
| ✅ config-09 | `workctl config get --service demo-order --env prod` | success | success | 0 | 398 | etcd@3.5.21 | 空前缀：success + 空 items + coverage 说明（不是错误） |
| ✅ config-10 | `workctl config diff --service demo-order --from-rev 99999999` | INVALID_ARGUMENT | INVALID_ARGUMENT | 2 | 425 |  | 未来修订：INVALID_ARGUMENT，details.current_revision |
| ✅ config-11 | `workctl config diff --service demo-order --from-rev abc` | INVALID_ARGUMENT | INVALID_ARGUMENT | 2 | 376 |  | 修订号格式错误 |
| ✅ config-12 | `workctl config diff --service demo-order` | INVALID_ARGUMENT | INVALID_ARGUMENT | 2 | 340 |  | 既无 --from-rev 也无 --key |
| ✅ config-13 | `workctl discovery list --service demo-order` | success | success | 0 | 363 | etcd@3.5.21 | 3 个注册：2 个带租约（POST /v3/lease/timetolive 剩余 TTL）、1 个无租约（不会自动过期） |
| ✅ config-14 | `workctl discovery list --service demo-order --env sandbox --healthy-only` | success | success | 0 | 364 | etcd@3.5.21 | 按注册内容 env 与自报 healthy 过滤，excluded 计数 |
| ✅ config-15 | `workctl discovery list --service demo-payment` | success | success | 0 | 420 | nacos@2.4.3 | 未注册的服务：success + 空 instances + 说明 |
| ✅ config-16 | `workctl access check --capability config.diff` | success | success | 0 | 396 | workctl | 前置条件检查：endpoint:etcd + identity 探测 |
