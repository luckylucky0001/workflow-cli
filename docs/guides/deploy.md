# 部署系统能力指南

本指南覆盖 `deploy` 领域的 4 个命令（适配器 `kubernetes-api` / `jenkins-rest`，认证 `kubernetes-bearer` / `jenkins-basic`）以及 3 个待接入能力。结果信封与错误码见 `docs/design-principles.md`；Agent 使用流程见 `skills/deploy-operations/SKILL.md`。

> 已在隔离 Demo 环境验证：**Kubernetes v1.31.4+k3s1**（k3s，ServiceAccount token，最小权限 Role）与 **Jenkins 2.541.3**（`jenkins/jenkins:lts-jdk17`，仅核心插件，freestyle job，basic 认证 + crumb）。其他 Kubernetes 1.2x 版本预期可用（只用 apps/v1 与 core/v1）；Jenkins Pipeline job 的构建 API 形状相同（未验证）；Argo CD、Spinnaker、内部发布平台未接入。

## 对象模型

```
资源绑定 deploy.target（attributes.service=<服务>，endpoint {kind, name}）
   ├─ kind: kubernetes → Deployment <namespace>/<deployment>
   │     发布 = 该 Deployment 控制的 ReplicaSet（ownerReferences），修订号 deployment.kubernetes.io/revision
   └─ kind: jenkins    → 部署 job（folder/job）
         发布 = job 的构建；按构建参数（service_param / env_param）过滤出该服务/环境的构建
```

同一能力、两个 provider、一个输出 schema：`release` 统一包含 `id`、`version`、`images`、`revision`、`started_at`、`finished_at`、`timestamps`（explicit/derived）、`status`（succeeded / failed / running / aborted / unknown）、`status_basis`、`current`、`triggered_by`、`cause`、`source_ref`。

绑定示例：

```yaml
# Kubernetes（demo/environment/k8s/bindings.k8s.yaml）
- id: demo-order-deploy
  type: deploy.target
  env: sandbox
  endpoint: { kind: kubernetes, name: k3s }
  attributes: { service: demo-order, namespace: workctl-demo, deployment: demo-order }
# Jenkins（demo/environment/bindings.yaml）
- id: demo-order-deploy
  type: deploy.target
  env: sandbox
  endpoint: { kind: jenkins, name: demo-jenkins }
  attributes: { service: demo-order, job: deploy-demo-order, version_param: VERSION, service_param: SERVICE, env_param: ENV }
```

profile 端点：`endpoints.kubernetes.<name>`（与容器域共用：server + token_ref 或 kubeconfig，见 `docs/guides/infrastructure.md`）；`endpoints.jenkins.<name>`：`url`、`user`、`token_ref`（推荐 API token）或 `password_ref`。凭据只通过 `*_ref: env:|file:` 引用。

## 命令

| 命令 | 操作 | 语义要点 |
| --- | --- | --- |
| `deploy release list --service --env [--window 7d] [--limit 20]` | read | 新→旧；Kubernetes 当前修订总是包含；`retained` 为 provider 当前保留的发布总数 |
| `deploy release get --service --env --id [--tail 30]` | read | Kubernetes：ReplicaSet 名或修订号；镜像、环境变量（凭据遮蔽）、change-cause、副本数、与当前修订的差异。Jenkins：构建号；参数、结果、耗时、触发原因、控制台末尾 N 行（遮蔽） |
| `deploy status get --service --env` | read | Kubernetes：rollout 条件、updated/ready/available/desired、observedGeneration、各修订 Pod 的等待原因；Jenkins：运行中/排队中的部署构建 |
| `deploy rollback plan --service --env [--to <id>]` | plan | 计划存储；执行用 `operation execute --id --confirm`（需要 allow_execute） |
| `deploy app sync-status` / `deploy app history` | planned | Argo CD Application 同步状态 / 历史（待接入） |
| `deploy pipeline execution list` | planned | Spinnaker / 内部发布平台流水线执行（待接入） |

## Provider 对比：暴露什么、保留什么

| | Kubernetes（Deployment） | Jenkins（部署 job） |
| --- | --- | --- |
| 发布 ID | ReplicaSet 名（稳定，回滚复用）；也接受修订号 | 构建号 |
| 版本 | Pod 模板首个容器镜像 tag；`images` 为全部镜像 | 构建参数 `version_param`（默认 VERSION） |
| 开始时间 | ReplicaSet `creationTimestamp`（**derived**；回滚复用的 ReplicaSet 为首次创建时间） | 构建 `timestamp`（**explicit**） |
| 结束时间 | 仅当前修订：Progressing=`NewReplicaSetAvailable` 的 `lastUpdateTime`（derived）；旧修订为 null | `timestamp + duration`（explicit） |
| 状态 | 当前修订按 rollout 语义（完成/进行中/ProgressDeadlineExceeded/暂停）；被替代修订 `unknown`（API 不保存当时结果） | 构建 result：SUCCESS→succeeded，FAILURE/UNSTABLE→failed，ABORTED→aborted，building→running |
| 触发人/原因 | 无操作人（看 API 审计日志）；`kubernetes.io/change-cause` 注解；仅有 restartedAt 变化时识别为 rollout restart，并标注沿用的 change-cause | CauseAction（userId / shortDescription） |
| 保留 | `revisionHistoryLimit`（默认 10）个旧 ReplicaSet | job 构建丢弃策略（从 config.xml 读取 numToKeep，需要 Job/ExtendedRead）；JSON API 最多 100 个构建 |
| current | 修订号等于 Deployment 的 revision 注解 | 最近一次成功的匹配构建（不代表目标环境实际运行版本） |

`change-cause` 注解属于 Deployment，并被复制到之后每个新 ReplicaSet：没有更新注解的 rollout（如 `rollout restart`）会沿用上一次的文字，workctl 会在 `cause` 中注明“沿用自修订 N”。

## 回滚语义

- **Kubernetes**（可执行）：等价于 `kubectl rollout undo --to-revision`。执行器先复核 Deployment uid、当前修订未变（否则 `CONFLICT`）、目标 ReplicaSet 仍存在且受该 Deployment 控制；然后发 JSON patch（`test /metadata/uid`、`replace /spec/template` 为目标 ReplicaSet 模板去掉 `pod-template-hash` 标签、写 `kubernetes.io/change-cause`），轮询直到 observedGeneration ≥ 新 generation 且 updated/available 副本达标；`ProgressDeadlineExceeded` 视为失败。目标 ReplicaSet 获得新的修订号（原修订号从历史消失，记录在 `revision-history`）。
- **Jenkins**（可执行）：用目标构建的参数（凭据类参数除外）调用 `buildWithParameters`（密码认证时先取 crumb 并带会话 cookie；API token 认证无需 crumb），轮询队列项得到构建号，再轮询构建直到结束，结果 SUCCESS 才算成功。执行前复核当前成功构建未变、没有进行中的部署构建。目标构建含 Password 参数时前置条件 `parameters_replayable` 不满足（API 不返回其值）。部署 job 的成功不等于服务健康。
- 前置条件：`target_release_retained`、`target_differs_from_current`、（Kubernetes）`deployment_not_paused`、`no_rollout_in_progress`；（Jenkins）`target_succeeded`、`no_deploy_in_progress`、`parameters_replayable`；`profile_allow_execute`。任一不满足，`operation execute` 返回 `PRECONDITION_FAILED`。
- 回滚只回滚部署版本；配置中心、数据库结构、特性开关不随之回滚。

## 权限

| Provider | 只读（list/get/status/plan） | 回滚执行 |
| --- | --- | --- |
| Kubernetes | `get,list deployments, replicasets`（apps）、`list pods`（core） | `patch deployments` |
| Jenkins | Overall/Read + Job/Read；读取保留策略需 Job/ExtendedRead（可选） | Job/Build |

Demo 的 k3s Role `workctl-container`（`demo/environment/k8s/demo-order.yaml`）已包含以上权限，未做修改。Demo Jenkins 只有核心插件（无 matrix-auth），使用“登录用户完全控制、匿名无权限”；生产应为 workctl 建只读用户 + API token，回滚执行用单独的身份。

错误码：401 → `UNAUTHENTICATED`，403 → `PERMISSION_DENIED`（Kubernetes 给出缺少的 verb/resource），404（构建/ReplicaSet/Deployment）→ `NOT_FOUND`，5xx/不可达 → `UPSTREAM_UNAVAILABLE`，超时 → `TIMEOUT`；没有 `deploy.target` 绑定 → `NOT_CONFIGURED`。

## Demo 与验证

- Jenkins：`cd demo/environment && docker compose up -d --no-deps jenkins`（主机端口 18091；`init.groovy.d` 创建 admin 与 freestyle job `deploy-demo-order`，参数 SERVICE/VERSION/ENV，VERSION 含 `bad` 时失败），`node demo/scenarios/deploy/seed-jenkins.mjs` 生成 v1.4.0 成功、v1.4.1 成功、v1.4.2-bad 失败、v1.4.1 重新部署成功。验证：`WORKCTL_CONFIG=demo/environment/workctl.yaml node scripts/verify-demo.mjs demo/verification/cases.deploy.json`。
- Kubernetes：`demo/scenarios/deploy/k8s-rollouts.sh break` 产生 v1.4.0、v1.4.1 与一次失败的 v1.4.2-bad（不存在的镜像 tag，progressDeadlineSeconds=30 → ProgressDeadlineExceeded），验证套件用 workctl 回滚：`WORKCTL_CONFIG=demo/environment/k8s/workctl.k8s.yaml node scripts/verify-demo.mjs demo/verification/cases.deploy-k8s.json`，之后 `k8s-rollouts.sh recover` 恢复 progressDeadlineSeconds。不带参数运行 `k8s-rollouts.sh` 则用 `kubectl rollout undo` 自行恢复。
- 单元测试 `test/deploy/deploy.test.ts`（假 Jenkins / 假 Kubernetes API）；实时测试 `WORKCTL_IT=1 [WORKCTL_K8S=1] npx vitest run test/deploy/live.test.ts`。
