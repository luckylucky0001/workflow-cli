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

## Provider 路线

| 能力 | 当前 | 规划 |
|---|---|---|
| 容器工作负载 | Docker Engine API | Kubernetes（`kubernetes workload get`，planned） |
| 负载均衡/网关后端 | 绑定 + 发布端口 + 探测 | Nginx / 云 LB / Ingress（`network loadbalancer get`，planned） |
| 存储 | Docker 卷、本机文件系统 | S3 兼容对象存储（`object stat`）、HDFS（`hdfs path stat`），planned |
| 配额 | — | `quota get`（Kubernetes ResourceQuota / 云配额，planned） |

规划中的能力只出现在目录（`workctl capability list --status planned`），调用返回 `CAPABILITY_PLANNED`。
