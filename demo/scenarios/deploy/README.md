# 部署系统场景（deploy）

两种 provider，同一组命令（`workctl deploy ...`），见 `docs/guides/deploy.md`。

## Jenkins（docker demo，profile `demo/environment/workctl.yaml`）

```bash
cd demo/environment && docker compose up -d --no-deps jenkins && cd -   # 主机端口 18091，admin 密码在 .runtime/secrets/jenkins_admin_password
node demo/scenarios/deploy/seed-jenkins.mjs                            # #1 v1.4.0 成功、#2 v1.4.1 成功、#3 v1.4.2-bad 失败、#4 v1.4.1 重新部署成功
WORKCTL_CONFIG=demo/environment/workctl.yaml node scripts/verify-demo.mjs demo/verification/cases.deploy.json
```
套件最后会真实执行一次回滚（用目标构建参数重新触发 `deploy-demo-order`），因此每次运行都会多一个构建；可重复运行。

## Kubernetes（k3s demo，profile `demo/environment/k8s/workctl.k8s.yaml`）

```bash
demo/scenarios/deploy/k8s-rollouts.sh break     # v1.4.0、v1.4.1、失败的 v1.4.2-bad（ImagePullBackOff → ProgressDeadlineExceeded），保留失败状态
WORKCTL_CONFIG=demo/environment/k8s/workctl.k8s.yaml node scripts/verify-demo.mjs demo/verification/cases.deploy-k8s.json   # 含 workctl 回滚执行
demo/scenarios/deploy/k8s-rollouts.sh recover   # 恢复 progressDeadlineSeconds=120 并确认健康
```
`k8s-rollouts.sh`（不带参数）会自行用 `kubectl rollout undo` 恢复，结束时健康。旧修订 Pod 在失败的 rollout 期间一直可用（maxUnavailable=0）。
