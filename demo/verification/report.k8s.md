# 隔离演示环境验证记录（k8s）

> 由 `node scripts/verify-demo.mjs demo/verification/cases.k8s.json` 生成于 2026-10-17T16:38:48.526Z；原始结果信封见 `demo/verification/envelopes-k8s/`。全部为合成数据。

通过 10 / 10

| # | 命令 | 期望 | 实际 | 退出码 | 耗时 ms | 来源@版本 | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ✅ k8s-01 | `workctl auth status --probe` | success | success | 0 | 754 | workctl | Kubernetes 身份：ServiceAccount token（最小权限 Role） |
| ✅ k8s-02 | `workctl access check --capability container.workload.get --target k3s` | success | success | 0 | 775 | workctl |  |
| ✅ k8s-03 | `workctl container workload get --service demo-order --env sandbox` | success | success | 0 | 847 | kubernetes@v1.31.4+k3s1, workctl | 按绑定的 label selector 匹配 Pod |
| ✅ k8s-04 | `workctl container event list --service demo-order --env sandbox --window 30m` | success | success | 0 | 958 | kubernetes@v1.31.4+k3s1, workctl | core/v1 events；event-ttl 覆盖说明 |
| ✅ k8s-05 | `workctl container stats get --service demo-order --env sandbox` | success/partial | success | 0 | 839 | kubernetes@v1.31.4+k3s1, workctl | metrics-server 快照 |
| ✅ k8s-06 | `workctl capacity summary --env sandbox` | success/partial | success | 0 | 626 | kubernetes@v1.31.4+k3s1 | requests/limits 与使用量 |
| ✅ k8s-07 | `workctl container workload restart-plan --service demo-order --env sandbox` | success | success | 0 | 657 | kubernetes@v1.31.4+k3s1, workctl |  |
| ✅ k8s-08 | `workctl --timeout 240s operation execute --id op-20261017-54a4f7 --confirm op-20261017-54a4f7` | success | success | 0 | 4923 | workctl | 真实滚动重启（restartedAt 注解）并等待 rollout 完成 |
| ✅ k8s-09 | `workctl operation get --id op-20261017-54a4f7` | success | success | 0 | 882 | workctl |  |
| ✅ k8s-10 | `workctl container workload get --service no-such-service --env sandbox` | NOT_CONFIGURED | NOT_CONFIGURED | 8 | 692 |  | 服务不在绑定中，且该 profile 无 Docker 端点可按标签约定查询 |
