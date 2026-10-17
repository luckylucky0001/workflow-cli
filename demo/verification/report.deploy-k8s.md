# 隔离演示环境验证记录（deploy-k8s）

> 由 `node scripts/verify-demo.mjs demo/verification/cases.deploy-k8s.json` 生成于 2026-10-17T16:43:38.875Z；原始结果信封见 `demo/verification/envelopes-deploy-k8s/`。全部为合成数据。

通过 14 / 14

| # | 命令 | 期望 | 实际 | 退出码 | 耗时 ms | 来源@版本 | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ✅ deploy-k8s-01 | `workctl access check --capability deploy.release.list --target k3s` | success | success | 0 | 510 | workctl | deploy 域端点 kubernetes/jenkins：k8s profile 只配置 kubernetes，探测 API server 身份与 RBAC |
| ✅ deploy-k8s-02 | `workctl deploy status get --service demo-order --env sandbox` | success | success | 0 | 575 | kubernetes@v1.31.4+k3s1 | k8s-rollouts.sh break 之后：state=failed（Progressing=False ProgressDeadlineExceeded），新修订 Pod ImagePullBackOff，旧修订 Pod 仍就绪 |
| ✅ deploy-k8s-03 | `workctl deploy release list --service demo-order --env sandbox --window 7d` | success | success | 0 | 767 | kubernetes@v1.31.4+k3s1 | 保留的 ReplicaSet 修订（新→旧）：v1.4.2-bad 当前且 failed、v1.4.1/v1.4.0 change-cause；started_at derived；coverage 说明 revisionHistoryLimit |
| ✅ deploy-k8s-04 | `workctl deploy release get --service demo-order --env sandbox --id demo-order-7d7f69f6bc` | success | success | 0 | 589 | kubernetes@v1.31.4+k3s1 | 失败修订详情：镜像 nginx:1.27-alpine-workctl-missing、change-cause、副本数、与当前差异为空（自身即当前） |
| ✅ deploy-k8s-05 | `workctl deploy release get --service demo-order --env sandbox --id demo-order-6f447f6944` | success | success | 0 | 518 | kubernetes@v1.31.4+k3s1 | 上一修订详情：diff_vs_current 列出镜像与 RELEASE_VERSION 变化 |
| ✅ deploy-k8s-06 | `workctl deploy release get --service demo-order --env sandbox --id demo-order-0000000000` | NOT_FOUND | NOT_FOUND | 5 | 707 |  | 不在保留范围内的发布 ID：NOT_FOUND，hint 列出保留的修订 |
| ✅ deploy-k8s-07 | `workctl deploy release list --service demo-payment --env sandbox` | NOT_CONFIGURED | NOT_CONFIGURED | 8 | 504 |  | 服务没有 deploy.target 绑定：NOT_CONFIGURED |
| ✅ deploy-k8s-08 | `workctl deploy rollback plan --service demo-order --env sandbox --to demo-order-7d7f69f6bc` | success | success | 0 | 700 | kubernetes@v1.31.4+k3s1, workctl | 回滚到当前修订：计划生成但前置条件 target_differs_from_current=false |
| ✅ deploy-k8s-09 | `workctl operation execute --id op-20261017-eeda22 --confirm op-20261017-eeda22` | PRECONDITION_FAILED | PRECONDITION_FAILED | 9 | 430 |  | 前置条件不满足的计划拒绝执行 |
| ✅ deploy-k8s-10 | `workctl deploy rollback plan --service demo-order --env sandbox --to 999` | success | success | 0 | 415 | kubernetes@v1.31.4+k3s1, workctl | 目标修订不再保留：前置条件 target_release_retained=false（计划不可执行） |
| ✅ deploy-k8s-11 | `workctl deploy rollback plan --service demo-order --env sandbox` | success | success | 0 | 518 | kubernetes@v1.31.4+k3s1, workctl | 默认回滚到上一修订（v1.4.1）：当前/目标镜像、依赖影响、前置条件全部满足 |
| ✅ deploy-k8s-12 | `workctl --timeout 240s operation execute --id op-20261017-c9fd0b --confirm op-20261017-c9fd0b` | success | success | 0 | 2766 | workctl | 执行回滚（kubectl rollout undo 语义的 JSON patch），轮询 rollout 直到完成 |
| ✅ deploy-k8s-13 | `workctl deploy status get --service demo-order --env sandbox` | success | success | 0 | 853 | kubernetes@v1.31.4+k3s1 | 回滚后 state=complete，2/2 副本更新并可用 |
| ✅ deploy-k8s-14 | `workctl deploy release list --service demo-order --env sandbox --limit 3` | success | success | 0 | 641 | kubernetes@v1.31.4+k3s1 | 回滚复用 v1.4.1 的 ReplicaSet：修订号递增、change-cause 为 workctl 回滚、revision-history 说明 |
