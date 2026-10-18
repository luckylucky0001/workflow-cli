# 隔离演示环境验证记录（deploy）

> 由 `node scripts/verify-demo.mjs demo/verification/cases.deploy.json` 生成于 2026-10-18T06:34:55.782Z；原始结果信封见 `demo/verification/envelopes-deploy/`。全部为合成数据。

通过 15 / 15

| # | 命令 | 期望 | 实际 | 退出码 | 耗时 ms | 来源@版本 | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ✅ deploy-01 | `workctl access check --capability deploy.release.list --target demo-jenkins` | success | success | 0 | 547 | workctl | Jenkins 端点：password_ref 可解析，探测 /me（身份 admin）与 X-Jenkins 版本；kubernetes 端点未配置（deploy 域两种 provider 之一） |
| ✅ deploy-02 | `workctl deploy release list --service demo-order --env sandbox` | success | success | 0 | 576 | jenkins@2.541.3 | seed-jenkins.mjs 的 4 个构建（新→旧）：#4 v1.4.1 current、#3 v1.4.2-bad failed、#2 v1.4.1、#1 v1.4.0；时间 explicit；按 SERVICE/ENV 参数过滤；构建丢弃策略 20 |
| ✅ deploy-03 | `workctl deploy release get --service demo-order --env sandbox --id 3` | success | success | 0 | 746 | jenkins@2.541.3 | 失败构建：参数、原因 admin、控制台日志末尾（registry token 已遮蔽） |
| ✅ deploy-04 | `workctl deploy release get --service demo-order --env sandbox --id 4 --tail 5` | success | success | 0 | 704 | jenkins@2.541.3 | 当前版本（重新部署 v1.4.1），控制台只取末尾 5 行 |
| ✅ deploy-05 | `workctl deploy release get --service demo-order --env sandbox --id 999` | NOT_FOUND | NOT_FOUND | 5 | 459 |  | 构建不存在 / 已被丢弃：NOT_FOUND |
| ✅ deploy-06 | `workctl deploy release get --service demo-order --env sandbox --id abc` | INVALID_ARGUMENT | INVALID_ARGUMENT | 2 | 358 |  | Jenkins 发布 ID 须为构建号 |
| ✅ deploy-07 | `workctl deploy status get --service demo-order --env sandbox` | success | success | 0 | 630 | jenkins@2.541.3 | 没有运行/排队的部署构建：state=complete，current_release=#4 |
| ✅ deploy-08 | `workctl deploy release list --service demo-mysql --env sandbox` | NOT_CONFIGURED | NOT_CONFIGURED | 8 | 370 |  | 资源存在但没有 deploy.target 绑定：NOT_CONFIGURED |
| ✅ deploy-09 | `workctl deploy release list --service demo-order --env sandbox --window 1m` | success | success | 0 | 552 | jenkins@2.541.3 | 窗口内没有发布：success + 空 releases（retained 不受窗口影响），不是错误 |
| ✅ deploy-10 | `workctl deploy rollback plan --service demo-order --env sandbox --to 3` | success | success | 0 | 573 | jenkins, workctl | 目标是失败构建 #3：前置条件 target_succeeded=false |
| ✅ deploy-11 | `workctl operation execute --id op-20261018-ef5536 --confirm op-20261018-ef5536` | PRECONDITION_FAILED | PRECONDITION_FAILED | 9 | 425 |  | 前置条件不满足的计划拒绝执行 |
| ✅ deploy-12 | `workctl deploy rollback plan --service demo-order --env sandbox` | success | success | 0 | 581 | jenkins, workctl | 默认目标：上一个不同版本的成功构建（首次运行为 #1 v1.4.0）；参数可原样重放，前置条件全部满足 |
| ✅ deploy-13 | `workctl --timeout 120s operation execute --id op-20261018-350dcf --confirm op-20261018-350dcf` | success | success | 0 | 13496 | workctl | 执行回滚：crumb + 会话 cookie 调 buildWithParameters，轮询队列项与构建直到 SUCCESS |
| ✅ deploy-14 | `workctl deploy status get --service demo-order --env sandbox` | success | success | 0 | 630 | jenkins@2.541.3 | 回滚构建完成后 state=complete，current_release 为新构建（版本 = ${target}） |
| ✅ deploy-15 | `workctl deploy release list --service demo-order --env sandbox --limit 2` | success | success | 0 | 514 | jenkins@2.541.3 | 新构建在最前（current，cause Started by user admin） |
