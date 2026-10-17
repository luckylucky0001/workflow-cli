# 基础设施能力指南：容器、网络、存储

本指南覆盖 `container`、`network`、`storage` 三个领域，以及 `config`（配置中心与服务发现，见“配置中心与服务发现”一节）。命令结构、结果信封和错误码见 `docs/design-principles.md`；每条命令的参数与输出 schema 以 `workctl capability get <name>` 为准。

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

## 配置中心与服务发现

`config` 领域（`config get`、`config diff`、`discovery list`）只读访问配置中心与服务注册，支持三个 provider：etcd v3 HTTP/JSON 网关（适配器 `etcd-v3-gateway`，认证 `etcd-profile`）、Nacos 2.x Open API（`nacos-open-api`，`nacos-token`）、Consul HTTP API（`consul-http-api`，`consul-acl-token`）。每个能力只有一个输出 schema：`data.provider`、`data.provider_selected_by`、`data.revision_space` 写明实际使用的 provider、选择依据和修订号含义，provider 特有的事实放在可选字段 `nacos` / `consul` 中，`meta.sources` 给出适配器、调用方法和目标系统版本。演示环境：`demo-etcd`（etcd 3.5.21）、`demo-nacos`（Nacos 2.4.3）、`demo-consul`（Consul 1.20.6），种子与演示命令见 `demo/scenarios/config/README.md`。

### Provider 对照

| | etcd | Nacos | Consul |
|---|---|---|---|
| 端点类型 / 适配器 | `etcd` / `etcd-v3-gateway` | `nacos` / `nacos-open-api` | `consul` / `consul-http-api` |
| 配置定位 | 键前缀 `<config_prefix><env>/<service>/` | 配置文档 `<namespace>/<group>/<dataId>`（模板默认 `${env}` / `DEFAULT_GROUP` / `${service}.properties`） | KV 前缀 `<config_prefix><env>/<service>/`（无前导 `/`） |
| 键 | 每个 etcd 键一项 | 文档按类型拆分：properties 按行，yaml / json 展平为 `a.b`、`a[0]`（YAML `<<` 合并键按 Spring 语义展开）；类型为 `text`（Nacos 对未指定类型的发布记录为 text）时按 dataId 扩展名判断；其他类型（xml/html，或无扩展名的 text）或解析失败时整个文档为一项（`nacos.parsed=false`，`parse_error` 说明） | 每个 KV 键一项（目录占位键 `a/` 忽略） |
| 修订空间（`revision_space`） | `etcd-cluster-revision`：集群全局修订；键级 `create/mod_revision`、`version` | `nacos-history-id`：配置历史记录 ID（全局递增 nid）；没有键级修订（null），文档级见 `nacos.latest_history_id` | `consul-raft-index`：`CreateIndex` / `ModifyIndex`，`observed_revision` 为 `X-Consul-Index`；`version` 为 null |
| `config diff` 历史 | 任意两个修订的快照；早于压缩点 → `DATA_UNAVAILABLE`（`compact_revision`） | 由历史记录重建（见下）；早于最早保留记录 → `DATA_UNAVAILABLE`（`oldest_history_id`、`retention_days`，默认保留 30 天） | **不保留历史**：一律 `DATA_UNAVAILABLE`，只给已知索引，不编造旧值 |
| 服务发现 | 前缀注册 JSON，`healthy` 为实例自报，租约 TTL | `/v1/ns/service` + `/v1/ns/catalog/instances`：服务端健康状态，`enabled` / `ephemeral` / `weight` / `cluster`，metadata | `/v1/health/service/<svc>`：检查聚合（任一 critical → false；warning 计为 healthy），`/v1/catalog/services` 区分未注册 |
| 遮蔽 | 键名 / JSON 字段名（同一规则，`values.ts`） | 同左，作用于展平后的键名（`credentials[0]` 按 `credentials` 判断）；不可拆分类型的整文档项只按 dataId 判断；properties / yaml / json 解析失败（如多文档 YAML）时整文档遮蔽；文档含遮蔽值时 `nacos.md5` / `content_bytes` 为 null | 同 etcd；实例 Meta 按字段名遮蔽 |
| 认证 | `username` + `password_ref` → `/v3/auth/authenticate` token | `username` + `password_ref` → `POST /v1/auth/login` 得 `accessToken`（查询参数）；鉴权关闭时不需要（配置了 username 而服务端 `auth_enabled=false` 时忽略并在 notes 说明） | `token_ref` → `X-Consul-Token` 头；ACL 关闭时不需要 |
| 版本来源 / 实测版本 | `GET /version` / 3.5.21 | `GET /v1/console/server/state` / 2.4.3（standalone，内嵌存储） | `GET /v1/agent/self` / 1.20.6（dev agent） |

**provider 选择**（端点类型决定 provider）：`--endpoint <类型>/<名称>`（或在 etcd/nacos/consul 中唯一的名称）> 资源绑定（服务的 `attributes.config_center` 指向一个 `config.center` 资源，或服务到 `config.center` 资源的关系；取该资源的 `endpoint {kind, name}`）> profile `defaults.config`（如 `nacos` 或 `nacos/demo-nacos`）> 默认 etcd 端点（或唯一的配置中心端点）。多个候选且无法决定时 `NOT_CONFIGURED`。Apollo、ZooKeeper 是规划中的 provider：绑定或 `--endpoint` 指向这两种端点类型时返回 `CAPABILITY_PLANNED`，不做任何模拟。

```yaml
# bindings.yaml（演示环境）
resources:
  - { id: demo-nacos, type: config.center, env: sandbox, endpoint: { kind: nacos, name: demo-nacos } }
  - { id: demo-payment, type: service, env: sandbox, attributes: { config_center: demo-nacos } }
```

### Nacos：文档、历史前像与发现

- `config get` 读 `GET /v1/cs/configs?show=all`（内容 + `type` + md5 + 修改时间）。历史不可读（无权限等）时 `nacos.latest_history_id=null` 并在 notes 说明原因。`show=all` 下文档不存在返回 200 空体，workctl 报告为 success + 空列表 + `nacos.exists=false`（与无权限 `PERMISSION_DENIED`、不可达 `UPSTREAM_UNAVAILABLE` 区分）。
- 历史：优先 `GET /v2/cs/history/list`（2.2+ 的 v2 Open API；2.4.3 上 v1 `?search=accurately` 列表不可用），不存在时回退 v1；单条用 `/v2/cs/history?nid=`。**Nacos 历史记录保存的是变更前的内容（前像）**：`I` 记录存新内容，`U` / `D` 记录存修改/删除前的内容（2.4.3 实测）。因此“历史 ID X 生效后的文档” = X 之后下一条记录的前像，X 为最后一条时即当前内容。
- `config diff --from-rev A [--to-rev B]`：A、B 是历史 ID；因为 nid 全局递增（不同配置共用），取“不晚于该 ID 的最后一次变更生效后”的文档，与 etcd 修订的语义一致（晚于该配置最近一次变更的 ID 即当前内容）。重建两侧文档后按键比较；`nacos.from_history` / `to_history` 给出对应记录（`op_type`、时间、操作人）。
- `config diff --key K`：从最新记录往回找最近一次改变 K 的变更，用其前像比较；保留期内 K 从未变化 → `DATA_UNAVAILABLE`。
- `discovery list`：`/v1/ns/service` 判断服务是否存在（未注册返回 400 `service not found` → success + `service_registered=false`），逐集群读 `/v1/ns/catalog/instances`（每集群一页 1000 个，超过时 `status=partial`；含 `enabled=false` 的已下线实例；Open API `/v1/ns/instance/list` 不返回它们，目录接口不可用时回退并在 notes 说明）。`healthy` 是服务端记录的状态：临时实例靠心跳/连接，持久实例（`ephemeral=false`）靠服务端 TCP/HTTP 探测且不会自动删除。

### Consul：KV 无历史

- `config get` 读 `GET /v1/kv/<prefix>?recurse`（base64 值），`create_revision` / `mod_revision` 为 `CreateIndex` / `ModifyIndex`；404 即前缀下没有键（success + 空列表）。单键读取时 `X-Consul-Index` 即该键的 `ModifyIndex`。
- `config diff`：Consul KV 不保留任何历史版本，也不保留删除记录。`--key` 模式返回 `DATA_UNAVAILABLE`，`details` 只有 `create_index`、`modify_index`、`changed_since_creation`；`--from-rev N` 返回 `DATA_UNAVAILABLE`，`details.changed_since` 列出 `ModifyIndex > N` 的键（旧值不可知），删除的键无法发现；`--from-rev` 不早于 `X-Consul-Index`（该前缀/键最近一次写入的索引，不是全局索引）时返回空差异，大于 KV 当前索引 → `INVALID_ARGUMENT`；早于最近写入的 `--to-rev` → `DATA_UNAVAILABLE`。列表结果带 `X-Consul-Results-Filtered-By-ACLs: true`（token 无权读取部分键/实例）时 `status=partial`。需要历史请在写入侧留痕（git2consul、配置仓库、审计日志）或使用 etcd / Nacos。
- `discovery list`：`/v1/health/service/<svc>` 中每个实例的全部检查（含节点级 `serfHealth`）取最差状态写入 `consul.status`；`healthy = status != critical`（warning 计为 healthy，与 Consul DNS 默认一致，notes 中说明）；没有任何检查的实例 Consul 视为 passing。`version` / `env` 取自 `Service.Meta`。

### etcd 模型与键约定

```
<config_prefix><env>/<service>/<name>        → 配置项值（文本或 JSON）   默认 /config/sandbox/demo-order/cache.ttl_seconds
<discovery_prefix><service>/<instance-id>    → 注册内容 JSON              默认 /services/demo-order/order-1
```

- 每个键带 `create_revision`（创建时的集群修订）、`mod_revision`（最后修改的集群修订）、`version`（创建以来的修改次数，删除后重建从 1 开始）、`lease`（租约 ID，十进制字符串；无租约为 `null`）。
- 键和值在网关上是 base64；workctl 解码为 UTF-8，能解析为 JSON 的返回解析后的值（`value_format=json`），否则为文本；非 UTF-8 字节以 base64 返回（`binary_base64`）。
- 前缀与服务/环境由端点 `config_prefix`、`discovery_prefix` 决定；不同的组织约定（如 `/<app>/<env>/`）通过配置调整，不靠名称猜测。
- 结果中的 `observed_revision` 是读取时刻的集群修订：说明“etcd 在这个修订上的值是什么”，**不代表应用进程已经加载了这个值**。
- 键数超过 `--limit`（默认 200）时只返回按键名排序的前 N 个：`status=partial`、`coverage.complete=false`、`data.truncated=true`，`data.count` 为总数（三个 provider 一致）。

### 修订与压缩（revision / compaction）

- 修订是**集群级**全局计数：任何键的写入都会让它加 1，所以两个修订之间的差值不是某个配置项的修改次数。
- `config diff --from-rev A [--to-rev B|current]` 在修订 A 和 B 各读一次前缀快照（range 请求带 `revision`）后比较：`added` / `removed` / `changed`，旧值新值各自带 `mod_revision`、`version`。只比较两个时刻：区间内改了又改回的值显示为未变化，以相同值重写的键计入 `summary.rewritten_same_value`。
- 只给 `--key` 不给 `--from-rev`：与该键的上一版本比较（起点为 `mod_revision - 1`）；`version=1` 时没有更早版本，结果为 `added` 并在 `coverage.notes` 说明。
- etcd 只保留最近一次**压缩**之后的历史。早于压缩点的修订 → `DATA_UNAVAILABLE`，`details.compact_revision` 是最早可读修订（etcd 报错不带该值，workctl 用二分 range 探测得出），`details.etcd_message` 保留原文 `required revision has been compacted`。是否自动压缩取决于 etcd 的 `--auto-compaction-*` 配置；看不到历史 ≠ 没有发生过修改。
- 大于当前集群修订 → `INVALID_ARGUMENT`（`details.current_revision`）；修订号格式错误 → `INVALID_ARGUMENT`。workctl 不执行压缩，压缩是集群级不可逆操作。

### 敏感值遮蔽

- 键名（相对名）或 JSON 字段名按分段匹配 `password/passwd/pwd/secret/token/key/apikey/dsn/credential/private_key/access_key` 等时，值替换为 `"***"`，`masked=true`，`masked_paths` 标出位置（`$` 为整个值，`$.token` 为字段）。只按名称判断，不分析值内容；宁可多遮（如 `cache.key_prefix` 也会被遮）。
- `config diff` 中被遮蔽的项两侧都显示 `***`，`changed` 依据原始字节判断，所以“密码轮换过”可见而值不可见。`value_bytes` 是原始字节数；**整个值或其中任一 JSON 字段被遮蔽时为 `null`**（否则会泄露密钥长度及轮换前后的长度变化：其余字段明文可见时，整个值的字节数减去其余部分即密钥长度）。
- 遮蔽是展示层保护，不替代 etcd 的权限控制：只读账号应只授予所需前缀（`etcdctl role grant-permission --prefix <role> read <prefix>`）。
- 已知限制（审查记录，未修复）：值内容里嵌着的凭据（如名为 `db.url` 的 `jdbc:...user:pass@host`）不会被遮蔽；Consul 健康检查的 `Output`（最多 300 字符）原样返回，若检查 URL 含 token 会被带出；Nacos 的 `--healthy-only` / `summary.healthy` 把 `enabled=false`（已下线但健康）的实例计为健康；xml/html 或无扩展名的整段文本文档不做内容级遮蔽。

### 服务注册与租约

- `discovery list --service S` 列出 `<discovery_prefix>S/` 下的注册，解析 JSON 中的 `address`、`port`、`version`、`env`、`healthy`、`registered_at`。
- `healthy` 是实例写进注册内容的**自报**状态，不是 workctl 的探测；要验证可达性用 `network connectivity check`。
- 带租约的注册：`lease.remaining_ttl_s` 来自本次 `POST /v3/lease/timetolive`（`relation: sampled`），续约会重置；实例停止续约后 etcd 在 TTL 到期时删除键。`-1` 表示租约已过期/已撤销。
- **没有租约的注册永不过期**：实例下线后可能残留，输出中 `lease=null`、`summary.without_lease` 计数并在 `coverage.notes` 提示。
- `--env` 按注册内容的 `env` 字段过滤（缺字段的注册被排除并计入 `excluded.env_missing`）；`--healthy-only` 只保留 `healthy=true`。没有注册时返回 success + 空列表 + 说明。

### 端点配置与错误

```yaml
defaults: { etcd: demo-etcd }            # 可选 config: nacos | consul | <类型>/<名称>
endpoints:
  etcd:
    demo-etcd:
      url: http://127.0.0.1:12379        # 客户端端口（JSON 网关 /v3/*）
      config_prefix: /config/
      discovery_prefix: /services/
      # username: workctl_ro               # 开启认证时：POST /v3/auth/authenticate 换 token
      # password_ref: file:.runtime/secrets/etcd_ro_password
  nacos:
    demo-nacos:
      url: http://127.0.0.1:18848
      context_path: /nacos
      namespace: ${env}                  # 命名空间 ID 模板；public 表示公共命名空间
      group: DEFAULT_GROUP
      data_id: ${service}.properties
      # discovery_namespace / discovery_group  # 发现使用的命名空间与分组（默认同上 / DEFAULT_GROUP）
      # username: workctl_ro + password_ref    # 开启鉴权时
  consul:
    demo-consul:
      url: http://127.0.0.1:18500
      config_prefix: config/
      # datacenter: dc1
      # token_ref: file:.runtime/secrets/consul_ro_token   # ACL 开启时，以 X-Consul-Token 发送
```

| 情况 | 错误码 |
|---|---|
| 连接失败 / 网关路径不存在 / 5xx | `UPSTREAM_UNAVAILABLE` |
| 请求超时 | `TIMEOUT` |
| 开启认证但未配置凭据、密码错误、token 无效（etcd 401/`invalid auth token`；Nacos 401、403 `user not found`/`token invalid`/登录失败；Consul 403 `ACL not found`） | `UNAUTHENTICATED` |
| 身份有效但无权限（etcd `permission denied`；Nacos 403 `authorization failed`；Consul 403 `Permission denied`） | `PERMISSION_DENIED` |
| etcd 修订已被压缩；Nacos 历史 ID 早于保留期；Consul 任何历史比较 | `DATA_UNAVAILABLE` |
| 绑定或 `--endpoint` 指向 Apollo / ZooKeeper | `CAPABILITY_PLANNED` |
| 未来修订、格式错误的修订、非法服务/环境/键名 | `INVALID_ARGUMENT` |
| `config get --key` 指定的键不存在 | `NOT_FOUND`（hint 列出前缀下已有键） |

`auth status --probe` / `access check` 对 etcd 端点调用 `GET /version`、`POST /v3/maintenance/status`（leader、db 大小）与 `/v3/auth/status`；对 Nacos 调用 `GET /v1/console/server/state`（版本、模式、鉴权开关、历史保留天数）；对 Consul 调用 `GET /v1/agent/self` 与 `/v1/status/leader`（版本、数据中心、ACL 开关）。TLS 客户端证书、Apollo / ZooKeeper / Eureka provider 尚未接入。

## Provider 路线

| 能力 | 当前 | 规划 |
|---|---|---|
| 容器工作负载 | Docker Engine API；Kubernetes API（按资源绑定选择，见上节；k3s v1.31.4 实测） | — |
| 负载均衡/网关后端 | 绑定 + 发布端口 + 探测 | Nginx / 云 LB / Ingress（`network loadbalancer get`，planned） |
| 存储 | Docker 卷、本机文件系统 | S3 兼容对象存储（`object stat`）、HDFS（`hdfs path stat`），planned |
| 配额 | — | `quota get`（Kubernetes ResourceQuota / 云配额，planned） |
| 配置中心 / 服务注册 | etcd v3 JSON 网关、Nacos 2.x Open API、Consul HTTP API（`config get` / `config diff` / `discovery list`，按端点类型选择；etcd 3.5.21、Nacos 2.4.3、Consul 1.20.6 实测） | Apollo、ZooKeeper（选中时 `CAPABILITY_PLANNED`）、Eureka、Kubernetes Endpoints |

规划中的能力只出现在目录（`workctl capability list --status planned`），调用返回 `CAPABILITY_PLANNED`。
