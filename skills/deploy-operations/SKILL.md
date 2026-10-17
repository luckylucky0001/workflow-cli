---
name: deploy-operations
description: 查看服务的发布/变更：最近有没有发布、发布到了哪个版本、是否成功、rollout 是否卡住，并按 计划 → 确认 → 执行 → 复核 回滚到历史版本（Kubernetes Deployment 修订、Jenkins 部署 job）。当用户提到发布、上线、部署、rollout、版本、回滚、Jenkins 部署任务，或“发布后报错/延迟升高”、排查故障需确认“最近是否有变更”时使用（workctl deploy ...）。配置中心里的配置变更改用 infra-operations；容器重启改用 infra-operations。
---

# 部署系统操作

所有命令加 `--json`。对象模型、provider 差异与权限见 `docs/guides/deploy.md`。

## 原则

- 服务的部署系统只来自资源绑定（`deploy.target`，输出 `target.binding`）。没有绑定返回 `NOT_CONFIGURED`：说明“未接入部署系统”，不要推断“没有发布”。
- 区分 explicit 与 derived 时间（`release.timestamps`）：Jenkins 构建时间是系统记录的；Kubernetes 的 `started_at` 是 ReplicaSet 创建时间，`finished_at` 只有当前修订才有（由 Progressing 条件推得），被回滚复用的 ReplicaSet 的创建时间是首次创建时间。
- 状态有依据（`status_basis`）：Kubernetes 被替代的旧修订是 `unknown`——API 不保存当时 rollout 的结果，不能说成“成功过”。
- 保留范围有限（`meta.coverage.notes`）：Kubernetes 只保留 `revisionHistoryLimit` 个旧修订，Jenkins 只保留构建丢弃策略内的构建。列表里没有 ≠ 没发布过。
- Jenkins 的 `current` 是“最近一次成功的部署构建”，不是目标环境实际运行的版本；需要时用 `container workload get` 核对镜像。
- 回滚只走 plan → 人工确认 → `operation execute`；计划预览不是执行成功的证据，执行后独立复核。

## 场景 1：最近有没有发布 / 发布到了哪个版本

```bash
workctl deploy release list --service <svc> --window 24h
workctl deploy status get --service <svc>
```
回答时给出：当前版本（`current=true` 的 `version`/`images`）、最近几次发布的开始时间与状态、时间是 explicit 还是 derived。

## 场景 2：某次发布改了什么、为什么失败

```bash
workctl deploy release get --service <svc> --id <release id>
```
- Kubernetes：`kubernetes.containers`（镜像、环境变量，凭据值已遮蔽）、`change_cause`、`diff_vs_current`（与当前修订的镜像/环境变量差异）、副本数。
- Jenkins：`jenkins.parameters`、`causes`（谁触发）、`result`、`console.lines`（末尾若干行，已遮蔽）。

## 场景 3：rollout 卡住了吗

```bash
workctl deploy status get --service <svc>
```
- `state=failed`：Kubernetes `Progressing=False ProgressDeadlineExceeded`；看 `kubernetes.pods[].waiting_reasons`（如 `ImagePullBackOff`、`CrashLoopBackOff`）与哪个修订的 Pod 未就绪。旧修订 Pod 仍就绪时服务通常仍可用（maxUnavailable=0）。
- `state=progressing`：仍在滚动，对比 `replicas.updated/available/desired`；`paused`：Deployment 被暂停。
- Jenkins：`progressing`=有部署构建在跑，`queued`=在队列中（`why` 说明原因）。

## 场景 4：回滚

```bash
workctl deploy rollback plan --service <svc> [--to <release id>]   # 缺省：上一修订 / 上一个不同版本的成功构建
# 人工确认 targets（当前 → 目标版本/镜像）、impact、preconditions 全部 ok 后：
workctl operation execute --id <plan> --confirm <plan>
workctl deploy status get --service <svc>                          # 复核
```
- 前置条件不满足（目标已不保留、目标就是当前、目标构建失败、有进行中的发布、参数含凭据无法重放）时执行会被拒绝（`PRECONDITION_FAILED`）。
- 执行前会复核当前版本未变；计划生成后有新发布则 `CONFLICT`，重新生成计划。
- 回滚只回滚部署版本（Pod 模板 / 部署参数）；配置中心、数据库结构不随之回滚，需要单独评估。

## 发布与故障关联

1. 先确定故障起点 T（`metric query` 的突变点或告警时间）。
2. `deploy release list --window` 覆盖 T 之前一段时间；找开始时间早于且接近 T 的发布。注意 Kubernetes 时间是 derived，误差可到一次 rollout 的时长。
3. 用 `deploy release get` 看变更内容；用指标对比发布前后（同一窗口长度），而不是只凭时间接近下结论。
4. 结论分级：
   - “发布后指标突变，且变更内容与现象吻合（如缓存 TTL、连接池参数）”→ 高可信，可建议回滚计划；
   - “时间接近但变更内容无关”→ 只是线索，继续查配置变更（`config diff`）、依赖（Redis/MySQL）；
   - 窗口内没有可见发布 → 说明保留范围（coverage notes），不要断言“没有变更”。
5. 回滚建议只给计划；执行由授权人员确认。

## 常见错误

- 把 Kubernetes 旧修订的 `unknown` 当成“成功”，或把 `started_at` 当成精确上线时间。
- 把 Jenkins 构建成功当成服务健康：部署 job 成功只说明 job 跑完了。
- 回滚后不复核：执行结果之外，再看 `deploy status get`、`container workload get` 和关键指标。
