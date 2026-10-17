---
name: infra-operations
description: 容器、网络、存储的日常检查与受控操作：查看服务容器状态/事件/资源快照，探测后端与连通性，检查卷和文件，并按 计划 → 确认 → 执行 → 复核 的流程重启服务容器。适用于“服务挂了吗”“容器为什么重启”“端口通不通”“帮我重启某服务”。
---

# 基础设施操作

所有命令加 `--json`。对象模型与语义见 `docs/guides/infrastructure.md`。

## 原则

- 服务与容器的关系只来自标签/资源绑定（输出中的 `selector.evidence`）。没有匹配就是没有匹配，不要按名称去找“看起来像”的容器。
- 区分快照与窗口：`container stats get`、`capacity summary` 是快照；`container event list` 有窗口但受守护进程事件缓冲限制。
- 只读检查不需要授权；任何变更都先 plan，人工确认后 `operation execute`，执行后独立复核。计划预览不是执行成功的证据。
- 探测结果代表 workctl 所在主机的视角。

## 场景 1：服务是否正常

```bash
workctl container workload get --service <svc>
workctl network backend list --service <svc>
```
判断：`state=running` 且 `health` 不是 `unhealthy`，且后端探测 `ok=true`。三者不一致时如实报告（如进程在跑但健康接口 5xx）。

## 场景 2：容器为什么重启/退出

```bash
workctl container workload get --service <svc>          # exit_code、oom_killed、finished_at、started_at、restart_count
workctl container event list --service <svc> --window 6h
workctl log query --service <svc> --window 30m --level error
```
- `oom_killed=true` 或 exit_code 137 + 事件 `oom` → 内存超限（事实）；接着看 `container stats get` 与上限。
- `restart_count` 不含手动重启；手动重启要看事件或 `started_at`。
- 事件 `daemon_buffer_full=true` 时，早于 `visible_since` 的事件不可见，不能得出“没有重启”。

## 场景 3：连通性

```bash
workctl network dns get --name <host>
workctl network connectivity check --target <host:port> --count 5
```
- `lookup` 成功但 DNS 记录为空 → 来自 hosts 文件或本地配置。
- `ECONNREFUSED`：主机可达但端口没监听；`ETIMEDOUT`：网络/防火墙丢包。TCP 通不代表应用协议或认证可用。

## 场景 4：存储

```bash
workctl storage volume get --id <volume>      # 驱动、挂载点、占用（usage.status）、挂载它的容器
workctl storage file stat --path <path>       # 存在性、大小、mtime、可读性
```
`usage.status=unavailable` 表示守护进程没有计算大小，不是 0。文件存在 ≠ 数据正确 ≠ 任务成功。

## 场景 5：受控重启

```bash
workctl container workload restart-plan --service <svc> --env <env>
```
向用户展示并确认：
- `targets`：实际容器 ID/名称（不是服务名的猜测）；
- `impact.dependents_of_service`（谁依赖它，重启期间会失败）与 `impact.service_dependencies`；
- `preconditions` 全部 `ok`（含 `profile_allow_execute`）；
- `rollback`：重启不可回滚；`cancellable=false`。

用户明确确认后：
```bash
workctl operation execute --id <plan_id> --confirm <plan_id>
workctl operation get --id <plan_id>                    # status、result.restarted[].verified、history
workctl container workload get --service <svc>          # 独立复核 started_at 已更新、state=running
workctl network backend list --service <svc>            # 业务探测
```
执行器的 `verified` 只基于 inspect（进程运行、启动时间更新、健康检查状态）；业务恢复以探测与指标为准。失败时用 `container event list` 和 `log query` 查看原因，不要自动重试。

## 场景 6：配置与服务发现（etcd / Nacos / Consul，只读）

```bash
workctl config get --service <svc> [--key <name>]                 # 当前值与修订；敏感值为 ***（整值遮蔽时 value_bytes=null）
workctl config diff --service <svc> --from-rev <rev>              # 或 --key <name> 与上一版本比较
workctl discovery list --service <svc> [--healthy-only]           # 注册实例与健康
```
- provider 由服务绑定的配置中心端点类型决定（`data.provider`、`provider_selected_by`）；`--endpoint <类型>/<名称>` 可显式指定。先看 `data.revision_space` 再解读修订号：etcd 集群修订、Nacos 历史 ID、Consul raft 索引，三者不可互换。
- etcd：`DATA_UNAVAILABLE` = 修订已被压缩（`details.compact_revision` 起可读），不是“没有改过”。Nacos：历史默认只保留 30 天，早于最早记录同样是 `DATA_UNAVAILABLE`；properties/yaml/json 拆成键，其他类型整篇一项。Consul：KV **没有历史**，`config diff` 总是 `DATA_UNAVAILABLE`（只给 ModifyIndex），不要推测旧值。
- `healthy` 的依据见 `health_basis`：etcd 为实例自报（`lease=null` 的注册永不过期，可能是残留）；Nacos 为服务端状态（`enabled=false` 已下线仍在列表）；Consul 为检查聚合（critical → false，warning 计为 healthy）。`service_registered=false` 表示服务未注册，与“0 个实例”不同。
- 不要输出或猜测被遮蔽的值；Apollo / ZooKeeper 返回 `CAPABILITY_PLANNED`，属于未接入。

## Docker 与 Kubernetes

同一组命令按资源绑定自动选择 provider（`data.provider`、`selector.matched_by` 说明依据）。Kubernetes 下注意：

- 工作负载 = Deployment/StatefulSet + Pod；`containers[]` 每项为 `<pod>/<container>`，OOM 来自 `lastState.terminated.reason`。
- `container event list` 受 apiserver `event-ttl`（默认 1h）限制，窗口更长时 `coverage.complete=false`，不能说“没有事件”。
- `container stats get` / `capacity summary` 依赖 metrics-server；未部署返回 `COLLECTION_DISABLED`，刚启动无样本时为 partial。
- 重启是滚动重启（`restartedAt` 注解），执行器等待 rollout 完成；`TIMEOUT` 表示 rollout 仍在进行，先 `operation get` / `container workload get` 复核，不要盲目重试。
- 403 的 `details.rbac` 给出缺少的 verb/resource，按此申请最小权限。

## 报告格式

- 状态结论（事实）+ 证据（命令、观测时间、来源版本）。
- 不可见/不完整的部分（事件缓冲、日志保留、partial）。
- 若有变更：计划 ID、确认人、执行结果、复核结果。
