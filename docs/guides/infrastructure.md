# 基础设施能力指南：容器、网络、存储

本指南覆盖 `container`、`network`、`storage` 三个领域。命令结构、结果信封和错误码见 `docs/design-principles.md`；每条命令的参数与输出 schema 以 `workctl capability get <name>` 为准。

## 对象模型

```
service (资源绑定 type=service)
  └─ runs_on → container.workload（按容器标签选择）
        └─ container（Docker 实例：状态、健康、重启、限制、端口、卷）
  └─ depends_on → mysql.instance / redis.instance（来自服务配置的明确关系）
  └─ 访问后端（绑定中的 http_port/health_path + 容器发布端口）
volume（Docker 卷）、file（本机文件系统路径）
```

- **服务 → 容器** 只通过真实元数据解析，优先级：资源绑定 `attributes.container_label` → 服务 `runs_on` 的 `container.workload` 的标签 → 约定标签 `workctl.service=<service>`。输出中的 `selector.origin/evidence` 写明依据。**不按名称相似度推断**（名为 `demo-order-like-name` 但没有该标签的容器不会被算进来）。
- `--env` 对应容器标签 `workctl.env`，默认取 profile 的 `env`。标签值不同的容器被排除并在 `coverage.notes` 中列出；没有该标签的容器保留并标注。

## 命令

| 命令 | 操作 | 语义 |
|---|---|---|
| `container workload get --service S [--env E]` | read | inspect 实际状态：state、health、restart_count、started/finished、exit_code、oom_killed、镜像、端口、CPU/内存上限、日志驱动、挂载 |
| `container event list --service S [--window 1h]` | read | Docker 守护进程事件（die/start/kill/oom/health_status…），带窗口 |
| `container stats get --service S` | read | **快照**：CPU（两次守护进程采样间速率）、内存工作集 vs 上限、pids、网络/块 I/O 累计 |
| `capacity summary [--env E]` | read | **快照**：环境内容器上限 vs 当前使用，标出 `no_cpu_limit`、`memory_above_80pct_of_limit`、`oom_killed_last_exit` 等 |
| `container workload restart-plan --service S` | plan | 生成重启计划（目标容器、依赖影响、前置条件、步骤），存入计划库，**不执行** |
| `operation execute --id P --confirm P` | execute | 由核心执行计划；`container.restart` 执行器逐个 `POST /containers/{id}/restart?t=10` 并轮询 inspect 校验已恢复运行 |
| `network dns get --name N` | read | 系统解析器：`lookup`（getaddrinfo，含 /etc/hosts）+ A/AAAA/CNAME（问系统 nameserver） |
| `network backend list --service S` | diagnose | 后端 = 绑定 `http_port` + 容器发布端口；逐个 HTTP（有 `health_path`）或 TCP 探测，结果标为 `sampled` |
| `network connectivity check --target H:P [--count 3]` | diagnose | 解析耗时 + 多次 TCP 建连延迟，失败给出错误码（ECONNREFUSED/ETIMEDOUT…） |
| `storage volume get --id V` | read | 卷驱动、挂载点、标签、作用域、占用大小（`/system/df`）、挂载它的容器 |
| `storage file stat --path P` | read | 本机文件/目录元数据：类型、大小、mtime、权限、当前用户是否可读写；不读内容 |

## 快照与窗口

| 数据 | 性质 | 怎么读 |
|---|---|---|
| `container stats get`、`capacity summary` | 快照（`kind: snapshot`，没有 `coverage.window`） | 只代表采样那一刻；CPU 是约 1s 内的速率 |
| stats 中 network / block_io | 自容器启动以来累计 | 不能当窗口流量；窗口趋势用 `metric query` |
| `container event list` | 窗口（`coverage.window`） | 受守护进程事件缓冲限制，见下 |
| `restart_count` | 累计 | 只统计重启策略触发的自动重启，手动 `docker restart` 不计入 |

**Docker 事件保留**：守护进程只在内存中保留最近约 256 条事件（所有容器共用、重启清空）。健康检查每次产生 `exec_create/exec_start/exec_die` 三条事件，几秒一次的健康检查会在几分钟内把缓冲占满。`container event list` 读取全量缓冲后在本地按标签过滤，并用最早一条事件的时间给出 `visible_since`；缓冲已满时 `daemon_buffer_full=true`、`coverage.complete=false`，窗口中早于 `visible_since` 的部分**不可见**而不是“没有事件”。更长历史需要事件采集（转发到日志平台）。

## 受控重启流程

```bash
workctl container workload restart-plan --service demo-order --env sandbox   # 或 operation plan --action container.restart --param service=demo-order
workctl operation get --id <plan>            # 复核目标、影响、前置条件
workctl operation execute --id <plan> --confirm <plan>
workctl container workload get --service demo-order   # 独立复核
workctl network backend list --service demo-order     # 业务探测
```

- 计划中的 `targets` 是生成时实际解析出的容器 ID；执行器执行前重新 inspect，确认容器仍匹配选择器，否则拒绝。
- `preconditions` 包括 `containers_found`、`profile_allow_execute`；任一为 false 时核心拒绝执行。
- 执行结果 `verified` 的依据是 inspect：`Running=true`、`StartedAt` 晚于重启前、配置了健康检查时健康状态不是 `starting`。它不代表业务可用，业务可用性用 `network backend list` 探测。
- `rollback`：重启不可回滚；`cancellable=false`；对同一服务重复执行结果相同，但每次都会中断服务。

## 前置条件

- profile 中 `endpoints.docker.<name>.socket: /var/run/docker.sock`（或 `url: http://host:2375`）。运行 workctl 的用户需要访问 socket 的权限；无权限返回 `PERMISSION_DENIED`，socket 不存在/守护进程未运行返回 `UPSTREAM_UNAVAILABLE`。
- 版本：`meta.sources[].version` 写入 `/version` 返回的实际 Docker 版本与 API 版本。
- 探测（backend/connectivity/dns）都从 **workctl 所在主机** 发起，结论只代表该网络位置。

## 结果解读要点

- 空结果（选择器没匹配到容器）是 `success` + 空数组 + warning，不是错误。
- `storage volume get` 的 `usage.status=unavailable` 表示守护进程没算出大小（如非 local 驱动），不是 0 字节。
- `storage file stat` 只说明文件存在、大小和可读性；“任务成功”“分区存在”“数据质量通过”是不同检查项。
- 未设上限的容器：stats 中内存 `limit_source=host`（上限为宿主机内存），`capacity summary` 中单独计数，不计入上限合计。

## Kubernetes provider

`container workload get`、`container event list`、`container stats get`、`capacity summary` 和 `container.restart` 计划/执行器也可以作用于 Kubernetes，**命令与输出契约不变**（同一 zod schema，Kubernetes 特有信息只放在可选字段 `kubernetes` / `retention` / `provider` / `requests` 中）。实现直接调用 Kubernetes REST API（适配器 `kubernetes-api`，不依赖 client 库）。

> 状态：已实现；除模拟 API 单元测试（`test/container/fake-k8s.ts`）外，已在单节点 k3s v1.31.4 上真实验证（`demo/verification/report.k8s.md`、`test/container/k8s-live.test.ts`，含真实滚动重启）。尚未在多节点或托管集群验证。演示集群：`K3S_EXTRA_CA=... K3S_OOM_WORKAROUND=1 demo/environment/k8s/k3s-up.sh`（后者仅用于不允许调低 oom_score_adj 的沙箱内核）。

### 如何选择 provider

由**资源绑定**决定，不按名称猜测：

- 服务 `runs_on` 的 `container.workload`（或服务资源本身）声明了 `endpoint: {kind: kubernetes, name: <端点>}` → Kubernetes；
- 否则 → Docker（默认，行为不变）。
- `capacity summary` 没有服务参数：`--provider auto`（默认）在该环境存在 Kubernetes 绑定且 profile 没有 docker 端点时用 Kubernetes，否则 Docker；可用 `--provider kubernetes|docker` 指定。

```yaml
# bindings
resources:
  - { id: demo-order, type: service, env: sandbox }
  - id: demo-order-k8s
    type: container.workload
    env: sandbox
    endpoint: { kind: kubernetes, name: k3s }
    labels: { app: demo-order }                  # Pod 标签选择器
    attributes: { namespace: workctl-demo }      # 或 attributes.deployment / attributes.statefulset
relations:
  - { from: demo-order, to: demo-order-k8s, type: runs_on, source: binding-file }
```

- 绑定写 `labels`：用它作为 `labelSelector` 列 Pod；所属工作负载 = 同 namespace 中 Pod 模板标签满足该选择器的 Deployment/StatefulSet。
- 绑定写 `attributes.deployment`（或 `statefulset`）：先 GET 该对象，用它的 `spec.selector` 选 Pod；对象不存在时返回空结果 + warning。
- 输出 `selector.label` 是实际使用的 labelSelector，`selector.matched_by` 写明来源（如 `label selector app=demo-order（Deployment workctl-demo/demo-order 的 spec.selector，binding demo-order-k8s.attributes.deployment）`）。Pod 上的 `workctl.env` 标签与 `--env` 不同则排除并在 `coverage.notes` 列出。
- Docker 的标签约定（`workctl.service=<id>`）不会用到 Kubernetes 绑定的 `labels` 上。

### 端点配置

```yaml
endpoints:
  kubernetes:
    k3s:
      server: https://127.0.0.1:16443
      token_ref: file:../.runtime/k8s/workctl-token   # Bearer token（ServiceAccount token），只能用 *_ref
      ca_file: ../.runtime/k8s/ca.crt                 # 或 insecure_skip_tls_verify: true（默认 false，开启时有 warning）
      namespace: workctl-demo                         # 绑定未写 attributes.namespace 时使用
      # event_ttl: 1h                                 # 集群改过 kube-apiserver --event-ttl 时声明
    k3s-admin:
      kubeconfig: ../.runtime/k8s/kubeconfig.yaml     # 最小支持：所选 context 的 server、CA、token / 客户端证书
      context: default
```

- 端点键优先于 kubeconfig 中的值。kubeconfig 中 `exec` / `auth-provider` 插件不支持（返回 `UNSUPPORTED`），请改用 ServiceAccount token。
- `auth status --probe` / `access check` 的 `kubernetes` 探测：`GET /version`（版本）→ `SelfSubjectReview`（身份）→ `SelfSubjectRulesReview`（当前 namespace 中与 pods/deployments/statefulsets/events/nodes/metrics 相关的权限）。

### 需要的 RBAC

| 用途 | apiGroup | 资源 | 动词 | 范围 |
|---|---|---|---|---|
| workload get / event list / stats / restart 计划 | `""` | pods、events | get、list | namespace |
| 同上 | `apps` | deployments、statefulsets | get、list | namespace |
| stats get、capacity summary 的使用量 | `metrics.k8s.io` | pods | get、list | namespace |
| 重启执行（rollout restart） | `apps` | deployments（StatefulSet 绑定时还需 statefulsets） | patch | namespace |
| 可选：节点容量（capacity 的 host、stats 的 online_cpus） | `""` | nodes | get、list | 集群 |

示例 Role 见 `demo/environment/k8s/demo-order.yaml`。缺权限返回 `PERMISSION_DENIED`，`error.message` 写出被拒绝的动词与资源（解析自 API 返回的 Status，如 `patch deployments.apps（namespace workctl-demo）`），`error.details.rbac` 含 user/verb/resource/group/namespace。认证失败 `UNAUTHENTICATED`；对象/API 不存在 `NOT_FOUND`；连接失败、TLS 校验失败 `UPSTREAM_UNAVAILABLE`。

### 字段映射与语义差异

| 方面 | Docker | Kubernetes |
|---|---|---|
| 一条 `containers[]` | 一个容器 | 一个 Pod 中的一个容器，`name` = `<pod>/<container>`，`id` = 运行时容器 ID 前 12 位 |
| `state` | inspect `State.Status` | running / exited（terminated）/ restarting（CrashLoopBackOff）/ waiting（其他等待原因，见 `kubernetes.state_reason`） |
| `health` | 健康检查状态 | 未配置任何探针为 `none`；容器 ready → healthy，运行但未 ready → unhealthy，startup 未完成 → starting |
| `restart_count` | 只计重启策略触发的自动重启 | kubelet 计数，含存活探针失败与 OOM；Pod 被替换（rollout）后归零 |
| `oom_killed` / `exit_code` | `State.OOMKilled` / `State.ExitCode` | `state.terminated` 或 `lastState.terminated` 的 `reason=OOMKilled` / `exitCode` |
| `limits` | HostConfig | `resources.limits`；`requests` 在 `kubernetes.requests`（不当作 Docker 的 memory reservation） |
| 事件保留 | 守护进程内存中约 256 条 | API server 按 **event-ttl（默认 1h）** 删除；窗口超过 TTL 时 `coverage.complete=false`、`visible_since` 为 TTL 起点；同类事件聚合（`attributes.count` 为自 `first_timestamp` 起累计）；已被替换的旧 Pod 的事件不按名称推断归属，不包含 |
| `event.type` / `action` | `container` / Docker action | 对象类型（pod/replicaset/deployment）/ 事件 `reason`（BackOff、Killing、ScalingReplicaSet…）；`attributes.event_type` 为 Normal/Warning |
| `stats get` | 守护进程两次采样（约 1s） | **依赖 metrics-server**（`metrics.k8s.io`）：API 不存在返回 `COLLECTION_DISABLED`（不会返回 0）；CPU 为 metrics window（约 15s）内平均速率，内存为工作集；`pids` / `network` / `block_io` 为 null；`online_cpus` 取节点容量，无 get nodes 权限时为 0（表示未知，见 notes） |
| `capacity summary` | `workctl.env=<env>` 标签的容器，host = Docker 主机 | 该环境 Kubernetes 绑定涉及 namespace 的全部 Pod；host = 节点 allocatable 合计，`docker_version` 为节点容器运行时版本；无 metrics-server 或无 list nodes 权限时 `status=partial` 并说明（`host.kubernetes.capacity_known=false` 时 ncpu/mem 为 0 表示未知）；另给 `requests` 合计与 `no_cpu_request` / `no_memory_request` 标记 |
| 重启 | `POST /containers/{id}/restart`，逐个容器，计划 `idempotent=true` | 等价 `kubectl rollout restart`：对每个 Deployment/StatefulSet 发 strategic merge patch 写 `spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"]`，触发滚动更新；计划 `idempotent=false`（每次执行都会再触发一次滚动更新） |
| 重启校验 | inspect：运行、StartedAt 更新、健康、稳定 3s | 轮询工作负载：`observedGeneration ≥ 新 generation`、`updatedReplicas = replicas`、旧副本已终止、`availableReplicas`（StatefulSet 为 `readyReplicas` 且 `currentRevision = updateRevision`）= replicas；`Progressing=ProgressDeadlineExceeded` → 失败（`UPSTREAM_UNAVAILABLE`）；预算内未完成 → `TIMEOUT`（注解已写入，rollout 可能仍在进行，**不要直接重试**） |
| 版本来源 | `/version` 的 Docker 版本 | `/version` 的 `gitVersion`（如 `v1.31.4+k3s1`），写入 `meta.sources[].version`；`meta.sources[].method` 为实际 REST 路径 |

- 重启计划的前置条件：`workloads_found`、`profile_allow_execute`、`kubernetes_reachable`、`no_rollout_in_progress`（计划时已有未完成的 rollout 则拒绝执行）；StatefulSet 使用 `OnDelete` 策略时 `rolling_update_strategy=false`。执行前重新 GET 工作负载，`uid` 或 `spec.selector` 与计划不一致则拒绝（`PRECONDITION_FAILED`）。
- 执行的时间预算取 `min(300s, 调用 --timeout)`；rollout 较慢时用 `operation execute ... --timeout 5m`。
- `network backend list`、`log query` 等其他领域仍只走 Docker（按容器标签），对 Kubernetes 绑定的服务不适用。

## Provider 路线

| 能力 | 当前 | 规划 |
|---|---|---|
| 容器工作负载 | Docker Engine API；Kubernetes API（按资源绑定选择，见上节；k3s v1.31.4 实测） | — |
| 负载均衡/网关后端 | 绑定 + 发布端口 + 探测 | Nginx / 云 LB / Ingress（`network loadbalancer get`，planned） |
| 存储 | Docker 卷、本机文件系统 | S3 兼容对象存储（`object stat`）、HDFS（`hdfs path stat`），planned |
| 配额 | — | `quota get`（Kubernetes ResourceQuota / 云配额，planned） |

规划中的能力只出现在目录（`workctl capability list --status planned`），调用返回 `CAPABILITY_PLANNED`。
