# 命令参考

> 由 `workctl docs generate` 自动生成（workctl 0.1.0）。每个命令的帮助：`workctl <command> --help`。

## 全局选项

| 选项 | 说明 |
| --- | --- |
| `--json` / `-o json\|yaml\|text` | 输出格式；`--json` 输出统一结果信封 |
| `--profile <name>` | 选择 profile（环境、端点、凭据引用、执行授权） |
| `--config <path>` | 配置文件路径 |
| `--timeout <duration>` | 调用时间预算（默认 30s）；采样类命令需大于采样窗口 |
| `--request-id <id>` | 指定请求 ID |
| `--fail-on-partial` | 部分结果以退出码 10 结束 |

## 结果信封

```text
schema_version  契约版本
status          success | partial | error（调用状态；业务状态在 data 中，如 data.state）
capability      能力名
data            领域数据（Schema 见 docs/schemas/<capability>.v1.json）
error           { code, message, hint?, retryable, details? } | null
meta.sources    来源系统、适配器、方法、观测时间、实际版本、关系类型（explicit/inferred/derived/sampled）
meta.coverage   覆盖范围：complete、sampled、truncated、window、notes
meta.warnings   警告
context         request_id、profile、env、data_mode、capability_version、adapter、operation、耗时
```

## 错误码与退出码

| 错误码 | 退出码 | 可重试 | 含义 |
| --- | --- | --- | --- |
| `INVALID_ARGUMENT` | 2 | 否 | 参数缺失、格式错误或取值不合法 |
| `UNAUTHENTICATED` | 3 | 否 | 缺少凭据或认证失败 |
| `PERMISSION_DENIED` | 4 | 否 | 身份已认证，但目标系统拒绝该操作 |
| `NOT_FOUND` | 5 | 否 | 资源、任务或数据对象不存在 |
| `UPSTREAM_UNAVAILABLE` | 6 | 是 | 目标系统不可达或返回异常 |
| `TIMEOUT` | 6 | 是 | 调用超过时间预算 |
| `COLLECTION_DISABLED` | 7 | 否 | 目标系统未启用所需的采集或观测功能 |
| `DATA_UNAVAILABLE` | 7 | 否 | 数据源存在，但请求范围内没有可用数据 |
| `NOT_CONFIGURED` | 8 | 否 | 当前 profile 未配置所需端点或资源 |
| `CAPABILITY_PLANNED` | 8 | 否 | 能力已列入目录但尚未接入 |
| `UNSUPPORTED` | 8 | 否 | 目标引擎、版本或参数组合不受支持 |
| `PRECONDITION_FAILED` | 9 | 否 | 前置条件不满足（如未授权执行、计划已过期） |
| `CONFLICT` | 9 | 否 | 状态冲突（如计划已执行） |
| `INTERNAL` | 1 | 否 | workctl 内部错误 |
| (status=partial) | 0 / 10 | - | 部分结果；`--fail-on-partial` 时退出码 10 |

## 核心（发现、资源、身份、操作）

### `workctl access check`

检查调用某能力的前置条件：能力状态、执行授权、端点配置、凭据可解析、目标系统身份与权限

- 能力：`access.check` v1.0.0；操作类型：**read**；适配器：profile；认证：none
- 输出 Schema：[docs/schemas/access.check.v1.json](../docs/schemas/access.check.v1.json)；指南：[docs/quickstart.md](../docs/quickstart.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--capability` | string | 是 |  | 能力名，如 mysql.query.execute |
| `--target` | string | 否 |  | 端点名，如 demo-mysql；缺省使用 profile 默认端点 |
| `--probe` | bool | 否 | `true` | 是否实际连接目标系统 |

口径说明：

- verdict=allowed 只说明 workctl 侧前置条件满足；最终授权由目标系统在调用时校验

### `workctl auth status`

查看当前 profile 的身份配置：各端点的认证方式、凭据引用是否可解析；--probe 时实际连接校验身份

- 能力：`auth.status` v1.0.0；操作类型：**read**；适配器：profile；认证：none
- 输出 Schema：[docs/schemas/auth.status.v1.json](../docs/schemas/auth.status.v1.json)；指南：[docs/quickstart.md](../docs/quickstart.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--probe` | bool | 否 | `false` | 实际连接目标系统校验身份与权限 |

口径说明：

- 只显示凭据引用类型与可解析性，不输出凭据值
- 实际授权仍由目标系统校验

### `workctl capability get`

查看单个能力的定义：参数、输出 Schema、操作类型、认证方式、版本和指南

- 能力：`capability.get` v1.0.0；操作类型：**read**；适配器：registry；认证：none
- 输出 Schema：[docs/schemas/capability.get.v1.json](../docs/schemas/capability.get.v1.json)；指南：[docs/capability-catalog.md](../docs/capability-catalog.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--name` | string | 是 |  | 能力名，如 mysql.table.get |

```bash
workctl capability get --name mysql.table.get
```

### `workctl capability list`

列出能力目录（已支持、需授权、待接入），支持按领域/状态/操作类型过滤

- 能力：`capability.list` v1.0.0；操作类型：**read**；适配器：registry；认证：none
- 输出 Schema：[docs/schemas/capability.list.v1.json](../docs/schemas/capability.list.v1.json)；指南：[docs/capability-catalog.md](../docs/capability-catalog.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--domain` | string | 否 |  | 领域，如 mysql、redis、offline、mq |
| `--status` | enum (available/requires_auth/planned) | 否 |  | 能力状态 |
| `--operation` | enum (read/diagnose/plan/execute) | 否 |  | 操作类型 |
| `--query` | string | 否 |  | 按名称/命令/摘要关键词搜索 |

```bash
workctl --json capability list --domain mysql
workctl capability list --status planned
```

### `workctl doctor`

诊断 workctl 自身环境：配置、profile、资源绑定、凭据引用、端点可达性、插件与 Skill

- 能力：`doctor.run` v1.0.0；操作类型：**diagnose**；适配器：local；认证：none
- 输出 Schema：[docs/schemas/doctor.run.v1.json](../docs/schemas/doctor.run.v1.json)；指南：[docs/quickstart.md](../docs/quickstart.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--skip-network` | bool | 否 | `false` | 跳过端点连通性检查 |

口径说明：

- 端点可达只检查网络连通，不代表认证或授权成功；身份校验用 auth status --probe

### `workctl operation cancel`

取消尚未执行的计划

- 能力：`operation.cancel` v1.0.0；操作类型：**plan**；适配器：plan-store；认证：none
- 输出 Schema：[docs/schemas/operation.cancel.v1.json](../docs/schemas/operation.cancel.v1.json)；指南：[docs/guides/operations.md](../docs/guides/operations.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--id` | string | 是 |  | 计划 ID |

### `workctl operation execute`

执行已生成的操作计划（需要 allow_execute 和与计划 ID 一致的确认）

- 能力：`operation.execute` v1.0.0；操作类型：**execute**；适配器：plan-store；认证：per-plan
- 输出 Schema：[docs/schemas/operation.execute.v1.json](../docs/schemas/operation.execute.v1.json)；指南：[docs/guides/operations.md](../docs/guides/operations.md)
- 幂等：否；可取消：否
- 副作用：按计划对目标系统做变更

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--id` | string | 是 |  | 计划 ID |
| `--confirm` | string | 是 |  | 再次输入计划 ID 以确认执行（防止执行错误的计划；不是人工审批） |

口径说明：

- 只执行状态为 planned 且未过期的计划
- 执行前重新校验 profile 与环境与计划一致
- 执行结果以执行器返回与 operation get 状态为准

### `workctl operation get`

查看操作计划或执行任务的状态、历史和结果

- 能力：`operation.get` v1.0.0；操作类型：**read**；适配器：plan-store；认证：none
- 输出 Schema：[docs/schemas/operation.get.v1.json](../docs/schemas/operation.get.v1.json)；指南：[docs/guides/operations.md](../docs/guides/operations.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--id` | string | 是 |  | 计划/任务 ID（op-...） |

### `workctl operation list`

列出当前 profile 下的操作计划与执行任务

- 能力：`operation.list` v1.0.0；操作类型：**read**；适配器：plan-store；认证：none
- 输出 Schema：[docs/schemas/operation.list.v1.json](../docs/schemas/operation.list.v1.json)；指南：[docs/guides/operations.md](../docs/guides/operations.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--kind` | string | 否 |  | 操作类型 |
| `--status` | enum (planned/running/succeeded/failed/cancelled/expired) | 否 |  | 状态 |

### `workctl operation plan`

为受控操作生成计划：解析实际目标、影响范围、前置条件和步骤（不执行）

- 能力：`operation.plan` v1.0.0；操作类型：**plan**；适配器：plan-store；认证：none
- 输出 Schema：[docs/schemas/operation.plan.v1.json](../docs/schemas/operation.plan.v1.json)；指南：[docs/guides/operations.md](../docs/guides/operations.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--action` | string | 是 |  | 操作类型，如 container.restart、mysql.index.create、offline.backfill |
| `--param` | list | 否 |  | 参数 key=value，可重复或逗号分隔，如 --param service=demo-order --param env=sandbox |

口径说明：

- 计划预览不是执行成功的证据；执行需通过 operation execute 并满足授权条件

```bash
workctl --json operation plan --action container.restart --param service=demo-order --param env=sandbox
```

### `workctl resource get`

查看单个资源及其上下游关系（含关系来源与依据）

- 能力：`resource.get` v1.0.0；操作类型：**read**；适配器：binding-file；认证：none
- 输出 Schema：[docs/schemas/resource.get.v1.json](../docs/schemas/resource.get.v1.json)；指南：[docs/resource-model.md](../docs/resource-model.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--id` | string | 是 |  | 资源 ID |

### `workctl resource list`

检索已绑定资源；指定 --service 时返回该服务及其依赖资源

- 能力：`resource.list` v1.0.0；操作类型：**read**；适配器：binding-file；认证：none
- 输出 Schema：[docs/schemas/resource.list.v1.json](../docs/schemas/resource.list.v1.json)；指南：[docs/resource-model.md](../docs/resource-model.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--service` | string | 否 |  | 服务 ID，如 demo-order |
| `--env` | string | 否 |  | 环境，如 sandbox |
| `--type` | string | 否 |  | 资源类型前缀，如 mysql、offline.workflow |

```bash
workctl --json resource list --service demo-order --env sandbox
```

### `workctl service dependency list`

列出服务的依赖资源（直接与传递）及依赖它的对象，每条关系带来源与依据

- 能力：`service.dependency.list` v1.0.0；操作类型：**read**；适配器：binding-file；认证：none
- 输出 Schema：[docs/schemas/service.dependency.list.v1.json](../docs/schemas/service.dependency.list.v1.json)；指南：[docs/resource-model.md](../docs/resource-model.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--service` | string | 是 |  | 服务 ID |
| `--env` | string | 否 |  | 环境 |
| `--depth` | int | 否 | `2` | 传递依赖深度 |

口径说明：

- 关系只来自绑定文件/服务配置等明确来源；不会根据名称相似性推断依赖

```bash
workctl --json service dependency list --service demo-order --env sandbox
```

## 基础设施

### `workctl config diff`

比较配置项在两个修订之间的差异（etcd 集群修订 / Nacos 配置历史 ID；新增/删除/修改，敏感值遮蔽）；不给 --from-rev 时与 --key 的上一版本比较；Consul KV 无历史

- 能力：`config.diff` v1.0.0；操作类型：**read**；适配器：etcd-v3-gateway|nacos-open-api|consul-http-api；认证：etcd-profile | nacos-token | consul-acl-token
- 输出 Schema：[docs/schemas/config.diff.v1.json](../docs/schemas/config.diff.v1.json)；指南：[docs/guides/infrastructure.md](../docs/guides/infrastructure.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--service` | string | 是 |  | 服务 ID |
| `--env` | string | 否 |  | 环境；默认取 profile 的 env |
| `--key` | string | 否 |  | 只比较一个配置项（相对键名） |
| `--from-rev` | int | 否 |  | 起始修订（etcd 集群修订号；Nacos 配置历史 ID）；省略时须给 --key，取该键上一版本 |
| `--to-rev` | string | 否 | `"current"` | 结束修订：正整数或 current |
| `--endpoint` | string | 否 |  | 配置中心端点：<类型>/<名称> 或名称（etcd / nacos / consul）；默认按资源绑定或 profile 默认选择 |

前置条件：

- profile 配置 etcd / nacos 端点（Consul KV 不保留历史，只能报告 DATA_UNAVAILABLE 与已知索引）
- etcd：起始修订不早于最近一次压缩；Nacos：起始历史 ID 在保留期内（默认 30 天）

口径说明：

- 修订号是 etcd 集群级的全局修订（任意键写入都会递增），不是单个配置项的版本号
- 只比较两个修订时刻的快照：区间内改了又改回的值显示为未变化（计入 rewritten_same_value），中间值不可见
- 历史只保留到最近一次压缩：早于压缩点的修订返回 DATA_UNAVAILABLE，details.compact_revision 为最早可读修订（二分探测得出）
- 修订大于当前集群修订返回 INVALID_ARGUMENT；比较只读，不会触发压缩
- 键名或 JSON 字段名匹配敏感模式（password/passwd/pwd/secret/token/key/dsn/credential 等，按名称判断）的值以 "***" 替代；其他字符串值中内嵌的凭据（URL userinfo 密码如 mysql://u:***@h、token=/password=/secret= 参数、Authorization 头）就地替换，其余文本保留，masked=true，masked_paths 标出位置；有任何遮蔽时 value_bytes=null（不暴露长度）
- provider 由端点类型决定（etcd | nacos | consul）：--endpoint [<类型>/]<名称> > 资源绑定（服务 attributes.config_center 或服务指向 config.center 资源的关系，取该资源的 endpoint）> profile defaults.config（<类型>[/<名称>]）> 默认 etcd 端点（或唯一的配置中心端点）；data.provider / provider_selected_by 写明实际选择
- Nacos：修订空间为配置历史 ID（revision_space=nacos-history-id，全局递增 nid）；历史记录保存变更前的内容（前像），workctl 据此重建“该 ID 生效后”的文档再按键比较；早于最早保留记录 → DATA_UNAVAILABLE（details.oldest_history_id / retention_days）
- Consul：KV 不保留历史，不重建任何旧值：--key 模式返回 DATA_UNAVAILABLE（details 带 create_index / modify_index），--from-rev 模式返回 DATA_UNAVAILABLE（details.changed_since 列出 ModifyIndex 更大的键）；删除的键无法发现

```bash
workctl config diff --service demo-order --env sandbox --from-rev 2
workctl config diff --service demo-order --key cache.ttl_seconds
workctl config diff --service demo-payment --key order.timeout_ms
```

### `workctl config get`

读取配置中心（etcd v3 / Nacos / Consul KV）中某服务某环境的配置项：当前值、修订号与元数据（敏感项遮蔽）

- 能力：`config.get` v1.0.0；操作类型：**read**；适配器：etcd-v3-gateway|nacos-open-api|consul-http-api；认证：etcd-profile | nacos-token | consul-acl-token
- 输出 Schema：[docs/schemas/config.get.v1.json](../docs/schemas/config.get.v1.json)；指南：[docs/guides/infrastructure.md](../docs/guides/infrastructure.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--service` | string | 是 |  | 服务 ID，如 demo-order |
| `--env` | string | 否 |  | 环境；默认取 profile 的 env |
| `--key` | string | 否 |  | 只读取一个配置项（服务前缀下的相对键名，如 cache.ttl_seconds） |
| `--limit` | int | 否 | `200` | 最多返回的键数（1-1000） |
| `--endpoint` | string | 否 |  | 配置中心端点：<类型>/<名称> 或名称（etcd / nacos / consul）；默认按资源绑定或 profile 默认选择 |

前置条件：

- profile 配置 endpoints.etcd（url，可选 config_prefix / username + password_ref）、endpoints.nacos（url，可选 namespace / group / data_id 模板、username + password_ref）或 endpoints.consul（url，可选 config_prefix / datacenter / token_ref）
- 身份对该前缀（Nacos：命名空间）有读权限（开启认证/ACL 时）

口径说明：

- 读的是 etcd 当前已提交的值（线性一致读），observed_revision 是读取时刻的集群修订，不代表应用已加载该值
- 键名或 JSON 字段名匹配敏感模式（password/passwd/pwd/secret/token/key/dsn/credential 等，按名称判断）的值以 "***" 替代；其他字符串值中内嵌的凭据（URL userinfo 密码如 mysql://u:***@h、token=/password=/secret= 参数、Authorization 头）就地替换，其余文本保留，masked=true，masked_paths 标出位置；有任何遮蔽时 value_bytes=null（不暴露长度）
- 值为 JSON（对象/数组/数字/布尔）时返回解析后的值；非 UTF-8 字节以 base64 返回（value_format=binary_base64）
- mod_revision 是最后一次修改的集群修订；可作为 config diff --from-rev 的输入
- provider 由端点类型决定（etcd | nacos | consul）：--endpoint [<类型>/]<名称> > 资源绑定（服务 attributes.config_center 或服务指向 config.center 资源的关系，取该资源的 endpoint）> profile defaults.config（<类型>[/<名称>]）> 默认 etcd 端点（或唯一的配置中心端点）；data.provider / provider_selected_by 写明实际选择
- Nacos：读取 <namespace>/<group>/<dataId> 整个配置文档，properties / yaml / json 拆分为键（嵌套键以 . 和 [i] 展平；类型为 text 时按 dataId 扩展名判断），其他类型时整个文档作为一个值，解析失败时整个文档作为一个值并整体遮蔽；没有键级修订（null）
- Consul：读取 KV 前缀 <config_prefix><env>/<service>/（?recurse），create/mod_revision 为 CreateIndex/ModifyIndex，observed_revision 为 X-Consul-Index；version 不提供
- 键列表被截断（超过 --limit）时 status=partial、coverage.complete=false
- 规划中的 provider（绑定或 --endpoint 指向时返回 CAPABILITY_PLANNED，不做模拟）：apollo / zookeeper

```bash
workctl config get --service demo-order --env sandbox
workctl config get --service demo-order --key cache.ttl_seconds
workctl config get --service demo-payment --env sandbox
workctl config get --service demo-inventory --endpoint consul/demo-consul
```

### `workctl capacity summary`

汇总环境内容器的资源上限与当前使用（快照），标出未设上限、接近上限、OOM 等

- 能力：`container.capacity.summary` v1.0.0；操作类型：**read**；适配器：docker-engine-api | kubernetes-api；认证：docker-socket | kubernetes-bearer
- 输出 Schema：[docs/schemas/container.capacity.summary.v1.json](../docs/schemas/container.capacity.summary.v1.json)；指南：[docs/guides/infrastructure.md](../docs/guides/infrastructure.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--env` | string | 否 |  | 环境（容器标签 workctl.env）；默认取 profile 的 env |
| `--provider` | enum (auto/docker/kubernetes) | 否 | `"auto"` | auto：环境有 Kubernetes 资源绑定且 profile 没有 docker 端点时用 Kubernetes，否则 Docker |

前置条件：

- Docker（默认）：profile 配置 endpoints.docker.<name>.socket（或 url），运行 workctl 的用户可访问 Docker socket
- Kubernetes：资源绑定中服务 runs_on 的 container.workload 声明 endpoint {kind: kubernetes}；profile 配置 endpoints.kubernetes.<name>（server + token_ref 或 kubeconfig）

口径说明：

- 快照：上限来自 inspect，使用量来自单次 stats 采样；容量趋势需结合 metric query 的窗口数据
- 未设置上限的容器在合计中单独计数（cpu_unlimited / memory_unlimited），不计入上限合计
- Docker：只统计带 workctl.env=<env> 标签的容器
- Kubernetes：范围是该环境 Kubernetes 资源绑定涉及的 namespace 的全部 Pod；上限/requests 来自 Pod spec，使用量来自 metrics-server（缺失时 status=partial、usage=null），host 为节点 allocatable 合计（需 list nodes 权限）

```bash
workctl capacity summary --env sandbox
```

### `workctl container event list`

列出服务容器在时间窗口内的事件（Docker：启动、退出、OOM、重启、健康状态变化；Kubernetes：Pod/工作负载事件）

- 能力：`container.event.list` v1.0.0；操作类型：**read**；适配器：docker-engine-api | kubernetes-api；认证：docker-socket | kubernetes-bearer
- 输出 Schema：[docs/schemas/container.event.list.v1.json](../docs/schemas/container.event.list.v1.json)；指南：[docs/guides/infrastructure.md](../docs/guides/infrastructure.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--service` | string | 是 |  | 服务 ID（资源绑定中的 service；Docker 按容器标签、Kubernetes 按绑定的 Pod 标签选择器解析） |
| `--env` | string | 否 |  | 环境（容器标签 workctl.env）；默认取 profile 的 env |
| `--window` | duration | 否 | `"1h"` | 回看窗口，如 15m、1h、6h |
| `--include-exec` | bool | 否 | `false` | 是否包含 exec_* 事件（健康检查会产生大量 exec 事件） |

前置条件：

- Docker（默认）：profile 配置 endpoints.docker.<name>.socket（或 url），运行 workctl 的用户可访问 Docker socket
- Kubernetes：资源绑定中服务 runs_on 的 container.workload 声明 endpoint {kind: kubernetes}；profile 配置 endpoints.kubernetes.<name>（server + token_ref 或 kubeconfig）

口径说明：

- provider 由资源绑定决定：服务（或其 runs_on 的 container.workload）绑定 kubernetes 端点时走 Kubernetes API，否则走 Docker（默认）
- Docker 守护进程只在内存中保留最近有限条事件（守护进程重启后清空），窗口早期的事件可能已不可见
- Kubernetes 事件由 API server 按 event-ttl 保留（默认 1h），窗口超过 TTL 时 coverage.complete=false；action 为事件 reason（如 BackOff、Killing、OOMKilling），type 为对象类型（pod/deployment/replicaset）
- 事件按时间正序返回

```bash
workctl container event list --service demo-order --window 1h
```

### `workctl container stats get`

获取服务容器的资源使用快照：CPU、内存（相对上限）、进程数、网络与块设备 I/O 累计值（Kubernetes 来自 metrics-server）

- 能力：`container.stats.get` v1.0.0；操作类型：**read**；适配器：docker-engine-api | kubernetes-api；认证：docker-socket | kubernetes-bearer
- 输出 Schema：[docs/schemas/container.stats.get.v1.json](../docs/schemas/container.stats.get.v1.json)；指南：[docs/guides/infrastructure.md](../docs/guides/infrastructure.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--service` | string | 是 |  | 服务 ID（资源绑定中的 service；Docker 按容器标签、Kubernetes 按绑定的 Pod 标签选择器解析） |
| `--env` | string | 否 |  | 环境（容器标签 workctl.env）；默认取 profile 的 env |

前置条件：

- Docker（默认）：profile 配置 endpoints.docker.<name>.socket（或 url），运行 workctl 的用户可访问 Docker socket
- Kubernetes：资源绑定中服务 runs_on 的 container.workload 声明 endpoint {kind: kubernetes}；profile 配置 endpoints.kubernetes.<name>（server + token_ref 或 kubeconfig）

口径说明：

- provider 由资源绑定决定：服务（或其 runs_on 的 container.workload）绑定 kubernetes 端点时走 Kubernetes API，否则走 Docker（默认）
- 这是快照（snapshot），不是时间窗口统计：CPU 为守护进程两次采样（约 1s）间的速率，内存为当前值
- 网络与块设备 I/O 是自容器启动以来的累计值，不能当作窗口流量；窗口趋势请用 metric query
- Kubernetes：依赖 metrics.k8s.io（metrics-server），API 不存在返回 COLLECTION_DISABLED；CPU 为 metrics window 内平均速率，内存为工作集，pids/网络/块 I/O 为 null；online_cpus 取节点容量（无 get nodes 权限时为 0，表示未知）

```bash
workctl container stats get --service demo-order
```

### `workctl container workload get`

查看服务对应容器的运行状态、健康、重启、退出码、OOM、镜像、端口和资源限制

按容器标签（资源绑定或 workctl.service 约定）解析服务的容器，返回 Docker inspect 的实际状态；服务绑定到 Kubernetes 时按标签选择器解析 Deployment/StatefulSet 的 Pod，每个容器一条。

- 能力：`container.workload.get` v1.0.0；操作类型：**read**；适配器：docker-engine-api | kubernetes-api；认证：docker-socket | kubernetes-bearer
- 输出 Schema：[docs/schemas/container.workload.get.v1.json](../docs/schemas/container.workload.get.v1.json)；指南：[docs/guides/infrastructure.md](../docs/guides/infrastructure.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--service` | string | 是 |  | 服务 ID（资源绑定中的 service；Docker 按容器标签、Kubernetes 按绑定的 Pod 标签选择器解析） |
| `--env` | string | 否 |  | 环境（容器标签 workctl.env）；默认取 profile 的 env |

前置条件：

- Docker（默认）：profile 配置 endpoints.docker.<name>.socket（或 url），运行 workctl 的用户可访问 Docker socket
- Kubernetes：资源绑定中服务 runs_on 的 container.workload 声明 endpoint {kind: kubernetes}；profile 配置 endpoints.kubernetes.<name>（server + token_ref 或 kubeconfig）

口径说明：

- provider 由资源绑定决定：服务（或其 runs_on 的 container.workload）绑定 kubernetes 端点时走 Kubernetes API，否则走 Docker（默认）
- Docker：RestartCount 只统计重启策略触发的自动重启；手动 docker restart 不计入，需结合 container event list
- Kubernetes：restart_count 为 kubelet 统计的容器重启（含存活探针失败、OOM），Pod 被替换后归零；oom_killed 来自 state/lastState.terminated.reason=OOMKilled；容器名为 <pod>/<container>
- 服务与容器的关系只来自标签/资源绑定，不按名称相似度推断

```bash
workctl container workload get --service demo-order --env sandbox
```

### `workctl container workload restart-plan`

为重启服务容器生成计划：实际目标容器（Kubernetes 为工作负载）、依赖影响、前置条件与步骤（不执行）

- 能力：`container.workload.restart_plan` v1.0.0；操作类型：**plan**；适配器：docker-engine-api | kubernetes-api；认证：docker-socket | kubernetes-bearer
- 输出 Schema：[docs/schemas/container.workload.restart_plan.v1.json](../docs/schemas/container.workload.restart_plan.v1.json)；指南：[docs/guides/infrastructure.md](../docs/guides/infrastructure.md)
- 幂等：是；可取消：否

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--service` | string | 是 |  | 服务 ID（资源绑定中的 service；Docker 按容器标签、Kubernetes 按绑定的 Pod 标签选择器解析） |
| `--env` | string | 否 |  | 环境（容器标签 workctl.env）；默认取 profile 的 env |

前置条件：

- Docker（默认）：profile 配置 endpoints.docker.<name>.socket（或 url），运行 workctl 的用户可访问 Docker socket
- Kubernetes：资源绑定中服务 runs_on 的 container.workload 声明 endpoint {kind: kubernetes}；profile 配置 endpoints.kubernetes.<name>（server + token_ref 或 kubeconfig）

口径说明：

- 计划预览不是执行成功的证据；执行用 workctl operation execute --id <plan> --confirm <plan>（需要 profile allow_execute）
- 等价于 workctl operation plan --action container.restart --param service=<service>
- Docker：执行时逐个重启并轮询 inspect 校验已重新运行（及健康检查状态）；计划 idempotent=true
- Kubernetes：等价于 kubectl rollout restart（PATCH Pod 模板注解 kubectl.kubernetes.io/restartedAt），轮询 observedGeneration/updatedReplicas/availableReplicas 直到 rollout 完成或超时；计划 idempotent=false（每次执行都会触发新的滚动更新），需要 patch deployments 权限
- provider 由资源绑定决定：服务（或其 runs_on 的 container.workload）绑定 kubernetes 端点时走 Kubernetes API，否则走 Docker（默认）

```bash
workctl container workload restart-plan --service demo-order --env sandbox
```

### `workctl deploy release get`

查看一次发布的详情：Kubernetes 修订的镜像/变更原因/副本数/与当前差异；Jenkins 构建参数/结果/耗时/原因/控制台日志末尾（遮蔽）

- 能力：`deploy.release.get` v1.0.0；操作类型：**read**；适配器：kubernetes-api | jenkins-rest；认证：kubernetes-bearer | jenkins-basic
- 输出 Schema：[docs/schemas/deploy.release.get.v1.json](../docs/schemas/deploy.release.get.v1.json)；指南：[docs/guides/deploy.md](../docs/guides/deploy.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--service` | string | 是 |  | 服务 ID（资源绑定中 deploy.target 的 attributes.service） |
| `--env` | string | 否 |  | 环境；默认取 profile 的 env |
| `--id` | string | 是 |  | 发布 ID：Kubernetes 为 ReplicaSet 名或修订号；Jenkins 为构建号 |
| `--tail` | int | 否 | `30` | Jenkins 控制台日志返回的末尾行数 |

前置条件：

- 资源绑定中有 type: deploy.target 的资源：attributes.service=<服务>，endpoint {kind: kubernetes|jenkins}
- Kubernetes：attributes.namespace + attributes.deployment；身份需要 get/list deployments、replicasets、pods（回滚执行另需 patch deployments）
- Jenkins：attributes.job（文件夹写 folder/job）；profile endpoints.jenkins.<name>（url、user、token_ref 或 password_ref），身份需要 Overall/Read + Job/Read（回滚执行另需 Job/Build）

口径说明：

- provider 由资源绑定的 deploy.target 决定（kubernetes 或 jenkins），两者输出同一 schema；Argo CD / Spinnaker / 内部发布平台尚未接入
- 发布 ID 不在保留范围内时返回 NOT_FOUND（Kubernetes 已按 revisionHistoryLimit 清理 / Jenkins 已按构建丢弃策略清理）
- 环境变量/构建参数中名称像凭据的值、控制台日志中的 password/token/secret=… 均遮蔽

```bash
workctl deploy release get --service demo-order --env sandbox --id 3
workctl deploy release get --service demo-order --id demo-order-7b48cf7b44
```

### `workctl deploy release list`

列出服务最近的发布/rollout（新→旧）：版本/镜像、修订、开始/结束时间、状态、触发人/原因

Kubernetes：Deployment 保留的 ReplicaSet 修订（kubectl rollout history）；Jenkins：部署 job 的构建。同一输出 schema。

- 能力：`deploy.release.list` v1.0.0；操作类型：**read**；适配器：kubernetes-api | jenkins-rest；认证：kubernetes-bearer | jenkins-basic
- 输出 Schema：[docs/schemas/deploy.release.list.v1.json](../docs/schemas/deploy.release.list.v1.json)；指南：[docs/guides/deploy.md](../docs/guides/deploy.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--service` | string | 是 |  | 服务 ID（资源绑定中 deploy.target 的 attributes.service） |
| `--env` | string | 否 |  | 环境；默认取 profile 的 env |
| `--window` | duration | 否 | `"7d"` | 只看该时间窗口内开始的发布（Kubernetes 当前修订总是包含） |
| `--limit` | int | 否 | `20` | 最多返回条数 |

前置条件：

- 资源绑定中有 type: deploy.target 的资源：attributes.service=<服务>，endpoint {kind: kubernetes|jenkins}
- Kubernetes：attributes.namespace + attributes.deployment；身份需要 get/list deployments、replicasets、pods（回滚执行另需 patch deployments）
- Jenkins：attributes.job（文件夹写 folder/job）；profile endpoints.jenkins.<name>（url、user、token_ref 或 password_ref），身份需要 Overall/Read + Job/Read（回滚执行另需 Job/Build）

口径说明：

- provider 由资源绑定的 deploy.target 决定（kubernetes 或 jenkins），两者输出同一 schema；Argo CD / Spinnaker / 内部发布平台尚未接入
- Kubernetes：只保留 revisionHistoryLimit 个旧 ReplicaSet；started_at 为 ReplicaSet creationTimestamp（derived），没有精确的 rollout 完成时间；被替代修订的 status 为 unknown（API 不保存当时结果）；回滚会复用旧 ReplicaSet 并给它新的修订号
- Jenkins：构建 timestamp/duration 为 explicit；只保留构建丢弃策略允许的构建（策略从 config.xml 读取，需要 Job/ExtendedRead）；current 为最近一次成功构建，不代表目标环境实际运行版本

```bash
workctl deploy release list --service demo-order --env sandbox --window 7d
```

### `workctl deploy rollback plan`

为回滚发布生成计划：目标版本、当前与目标镜像/版本、依赖影响、前置条件（目标仍保留等）与步骤（不执行）

- 能力：`deploy.rollback.plan` v1.0.0；操作类型：**plan**；适配器：kubernetes-api | jenkins-rest；认证：kubernetes-bearer | jenkins-basic
- 输出 Schema：[docs/schemas/deploy.rollback.plan.v1.json](../docs/schemas/deploy.rollback.plan.v1.json)；指南：[docs/guides/deploy.md](../docs/guides/deploy.md)
- 幂等：是；可取消：否

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--service` | string | 是 |  | 服务 ID（资源绑定中 deploy.target 的 attributes.service） |
| `--env` | string | 否 |  | 环境；默认取 profile 的 env |
| `--to` | string | 否 |  | 目标发布 ID（Kubernetes ReplicaSet 名或修订号；Jenkins 构建号）；缺省为上一修订 / 上一个不同版本的成功构建 |

前置条件：

- 资源绑定中有 type: deploy.target 的资源：attributes.service=<服务>，endpoint {kind: kubernetes|jenkins}
- Kubernetes：attributes.namespace + attributes.deployment；身份需要 get/list deployments、replicasets、pods（回滚执行另需 patch deployments）
- Jenkins：attributes.job（文件夹写 folder/job）；profile endpoints.jenkins.<name>（url、user、token_ref 或 password_ref），身份需要 Overall/Read + Job/Read（回滚执行另需 Job/Build）

口径说明：

- 计划预览不是执行成功的证据；执行用 workctl operation execute --id <plan> --confirm <plan>（需要 profile allow_execute）
- 等价于 workctl operation plan --action deploy.rollback --param service=<service> [--param to=<id>]
- Kubernetes：执行等价于 kubectl rollout undo --to-revision（JSON patch 把 Pod 模板替换为目标 ReplicaSet 的模板），执行前复核 uid 与当前修订，轮询 rollout 直到完成或超时；需要 patch deployments 权限
- Jenkins：执行即用目标构建的参数（凭据类参数除外）重新触发部署 job（buildWithParameters，密码认证时附带 crumb），轮询队列与构建直到结束，结果 SUCCESS 才算成功；执行前复核当前成功构建未变、没有进行中的部署；需要 Job/Build 权限。目标构建含凭据类参数时前置条件 parameters_replayable 不满足
- 回滚只回滚 Pod 模板 / 部署版本；配置中心、数据库结构等不随之回滚

```bash
workctl deploy rollback plan --service demo-order --env sandbox
workctl deploy rollback plan --service demo-order --to 3
```

### `workctl deploy status get`

查看服务当前的发布状态：Kubernetes rollout 条件与副本数；Jenkins 是否有部署构建在运行/排队

- 能力：`deploy.status.get` v1.0.0；操作类型：**read**；适配器：kubernetes-api | jenkins-rest；认证：kubernetes-bearer | jenkins-basic
- 输出 Schema：[docs/schemas/deploy.status.get.v1.json](../docs/schemas/deploy.status.get.v1.json)；指南：[docs/guides/deploy.md](../docs/guides/deploy.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--service` | string | 是 |  | 服务 ID（资源绑定中 deploy.target 的 attributes.service） |
| `--env` | string | 否 |  | 环境；默认取 profile 的 env |

前置条件：

- 资源绑定中有 type: deploy.target 的资源：attributes.service=<服务>，endpoint {kind: kubernetes|jenkins}
- Kubernetes：attributes.namespace + attributes.deployment；身份需要 get/list deployments、replicasets、pods（回滚执行另需 patch deployments）
- Jenkins：attributes.job（文件夹写 folder/job）；profile endpoints.jenkins.<name>（url、user、token_ref 或 password_ref），身份需要 Overall/Read + Job/Read（回滚执行另需 Job/Build）

口径说明：

- provider 由资源绑定的 deploy.target 决定（kubernetes 或 jenkins），两者输出同一 schema；Argo CD / Spinnaker / 内部发布平台尚未接入
- Kubernetes：state 按 kubectl rollout status 语义（observedGeneration、updated/available 副本、Progressing=ProgressDeadlineExceeded → failed、spec.paused → paused）；pods 列出各修订 Pod 的就绪与等待原因（如 ImagePullBackOff）
- Jenkins：progressing=有构建在运行，queued=队列中有该 job 的构建，否则按最近一次构建结果给出 complete/failed/aborted

```bash
workctl deploy status get --service demo-order --env sandbox
```

### `workctl discovery list`

从服务注册中心（etcd v3 前缀注册 / Nacos 命名服务 / Consul 目录与健康检查）列出某服务的实例：地址、版本、健康与注册元数据

- 能力：`discovery.list` v1.0.0；操作类型：**read**；适配器：etcd-v3-gateway|nacos-open-api|consul-http-api；认证：etcd-profile | nacos-token | consul-acl-token
- 输出 Schema：[docs/schemas/discovery.list.v1.json](../docs/schemas/discovery.list.v1.json)；指南：[docs/guides/infrastructure.md](../docs/guides/infrastructure.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--service` | string | 是 |  | 服务 ID，如 demo-order |
| `--env` | string | 否 |  | 按注册内容中的 env 字段过滤（不给则不过滤） |
| `--healthy-only` | bool | 否 | `false` | 只返回自报 healthy=true 的实例 |
| `--endpoint` | string | 否 |  | 配置中心端点：<类型>/<名称> 或名称（etcd / nacos / consul）；默认按资源绑定或 profile 默认选择 |

前置条件：

- etcd：endpoints.etcd（可选 discovery_prefix），实例以 <discovery_prefix><service>/<instance-id> → JSON 注册
- Nacos：endpoints.nacos（可选 discovery_namespace / discovery_group）
- Consul：endpoints.consul（token 需 service/node read）

口径说明：

- healthy 来自实例写入的注册内容（自报），不是 workctl 的探测结果；要验证可达性用 network connectivity check
- 带租约的注册在实例停止续约后按 TTL 自动删除；没有租约的注册永不过期，实例下线后可能残留
- remaining_ttl_s 为本次 /v3/lease/timetolive 的读数（采样），续约后会重置
- provider 由端点类型决定（etcd | nacos | consul）：--endpoint [<类型>/]<名称> > 资源绑定（服务 attributes.config_center 或服务指向 config.center 资源的关系，取该资源的 endpoint）> profile defaults.config（<类型>[/<名称>]）> 默认 etcd 端点（或唯一的配置中心端点）；data.provider / provider_selected_by 写明实际选择
- Nacos：GET /v1/ns/service + /v1/ns/catalog/instances（含 enabled=false 实例），healthy 为服务端健康状态，nacos 字段给出 cluster / weight / enabled / ephemeral；enabled=false（已下线）不计入 summary.healthy（见 summary.disabled），--healthy-only 时排除；--env 按 metadata.env 过滤
- Consul：GET /v1/health/service/<svc>，healthy 由检查聚合（任一 critical → false，warning 计为 healthy），consul 字段给出各检查（检查输出中的 URL 密码 / token= / Authorization 等凭据先遮蔽再截断到 300 字符）；服务不在 /v1/catalog/services 时 summary.service_registered=false
- Eureka / Kubernetes Endpoints / 规划中的 provider（绑定或 --endpoint 指向时返回 CAPABILITY_PLANNED，不做模拟）：apollo / zookeeper

```bash
workctl discovery list --service demo-order
workctl discovery list --service demo-order --env sandbox --healthy-only
workctl discovery list --service demo-payment
workctl discovery list --service demo-inventory
```

### `workctl network backend list`

列出服务的访问后端（资源绑定 + 容器发布端口）并逐个做健康探测

- 能力：`network.backend.list` v1.0.0；操作类型：**diagnose**；适配器：docker-engine-api + http-probe；认证：docker-socket
- 输出 Schema：[docs/schemas/network.backend.list.v1.json](../docs/schemas/network.backend.list.v1.json)；指南：[docs/guides/infrastructure.md](../docs/guides/infrastructure.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--service` | string | 是 |  | 服务 ID |
| `--env` | string | 否 |  | 环境；默认取 profile 的 env |
| `--timeout-ms` | int | 否 | `2000` | 单次探测超时（毫秒） |

前置条件：

- 资源绑定中服务的 http_port / health_path 属性，或带 workctl.service 标签且发布了端口的容器

口径说明：

- 探测结果（probe）是 workctl 所在主机此刻的真实请求结果，不代表其他网络位置的可达性
- 绑定只给端口时按本机 127.0.0.1 探测；Docker 发布到 0.0.0.0/:: 的端口同样按 127.0.0.1 探测
- 负载均衡器/网关后端（如 Nginx、云 LB）是规划中的 provider

```bash
workctl network backend list --service demo-order
```

### `workctl network connectivity check`

从 workctl 所在主机对 host:port 做多次 TCP 建连采样（解析耗时、建连延迟、失败原因）

- 能力：`network.connectivity.check` v1.0.0；操作类型：**diagnose**；适配器：node-net；认证：none
- 输出 Schema：[docs/schemas/network.connectivity.check.v1.json](../docs/schemas/network.connectivity.check.v1.json)；指南：[docs/guides/infrastructure.md](../docs/guides/infrastructure.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--target` | string | 是 |  | host:port，如 127.0.0.1:13306 |
| `--count` | int | 否 | `3` | 采样次数（1-20） |
| `--timeout-ms` | int | 否 | `2000` | 单次建连超时（毫秒） |
| `--interval-ms` | int | 否 | `200` | 采样间隔（毫秒） |

口径说明：

- 只验证 TCP 层可建连，不代表应用协议可用或认证通过
- 结果是本机视角的采样（sampled）

```bash
workctl network connectivity check --target 127.0.0.1:13306 --count 3
```

### `workctl network dns get`

用系统解析器解析域名：getaddrinfo 结果（含 hosts 文件）与 DNS A/AAAA/CNAME 记录

- 能力：`network.dns.get` v1.0.0；操作类型：**read**；适配器：node-dns；认证：none
- 输出 Schema：[docs/schemas/network.dns.get.v1.json](../docs/schemas/network.dns.get.v1.json)；指南：[docs/guides/infrastructure.md](../docs/guides/infrastructure.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--name` | string | 是 |  | 要解析的主机名 |

口径说明：

- lookup 走 getaddrinfo（与应用进程一致，含 /etc/hosts）；records 直接询问系统配置的 nameserver
- 结果反映运行 workctl 的主机视角；容器内/其他网络的解析结果可能不同

```bash
workctl network dns get --name localhost
```

### `workctl log query`

查询服务容器在时间窗口内的日志（解析结构化 JSON，按级别/关键字/trace_id 过滤）

- 能力：`observability.log.query` v1.0.0；操作类型：**read**；适配器：docker-engine-api|loki-http-api；认证：docker-socket
- 输出 Schema：[docs/schemas/observability.log.query.v1.json](../docs/schemas/observability.log.query.v1.json)；指南：[docs/guides/observability.md](../docs/guides/observability.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--service` | string | 是 |  | 服务 ID（按容器标签解析容器） |
| `--env` | string | 否 |  | 环境；默认取 profile 的 env |
| `--window` | duration | 否 | `"15m"` | 回看窗口 |
| `--level` | enum (debug/info/warn/error/fatal) | 否 |  | 最低级别（error 返回 error 和 fatal） |
| `--contains` | string | 否 |  | 原始行包含的子串（区分大小写） |
| `--trace-id` | string | 否 |  | 只返回该 trace 的日志 |
| `--include-spans` | bool | 否 | `false` | 是否返回 kind=span 的 span 记录（默认省略，用 trace get 查看） |
| `--order` | enum (newest/oldest) | 否 | `"newest"` | newest：返回最新的 N 条并按时间倒序；oldest：返回最早的 N 条并按时间正序 |
| `--limit` | int | 否 | `200` | 最多返回条数（1-2000） |

前置条件：

- 容器日志驱动支持读取（json-file / local / journald）
- endpoints.docker 可访问

口径说明：

- 日志来自 Docker /containers/{id}/logs（stdout+stderr 多路复用流已解帧）；保留期取决于日志驱动与轮转配置，容器重建后旧日志不可见
- 默认 order=newest：返回窗口内最新的 limit 条，按时间倒序；coverage.truncated=true 表示匹配条数超过 limit
- 单条日志中超过 8192 字符的文本（msg、raw、字段值）会被截断，该条 entries[].truncated=true，并在 coverage.notes 说明（Docker / Loki 相同）
- provider 由资源绑定 attributes.log_provider 或 profile defaults.logs 决定（docker 默认 | loki）；Loki 经 LogQL query_range 查询，输出契约相同，差异（入库延迟、保留期、limit 口径）见指南

```bash
workctl log query --service demo-order --window 15m --level error
workctl log query --service demo-order --trace-id <trace_id> --include-spans
```

### `workctl metric list`

列出 profile 中配置的指标目录（名称、含义、单位、渲染后的 PromQL）

- 能力：`observability.metric.list` v1.0.0；操作类型：**read**；适配器：prometheus-http-api；认证：none
- 输出 Schema：[docs/schemas/observability.metric.list.v1.json](../docs/schemas/observability.metric.list.v1.json)；指南：[docs/guides/observability.md](../docs/guides/observability.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--resource` | string | 否 |  | 资源 ID，用于渲染 $service 模板 |
| `--endpoint` | string | 否 |  | Prometheus 端点名 |

口径说明：

- 目录来自 workctl 配置，不代表 Prometheus 中一定有数据；用 metric query 验证

```bash
workctl metric list --resource demo-order
```

### `workctl metric query`

查询资源的时间序列指标（Prometheus query_range），返回数据点与窗口内 min/max/avg/last

--metric 通过 profile 中 Prometheus 端点的 metrics 目录解析为 PromQL（$service 替换为资源 ID）；也可用 --promql 直接查询。

- 能力：`observability.metric.query` v1.0.0；操作类型：**read**；适配器：prometheus-http-api；认证：none
- 输出 Schema：[docs/schemas/observability.metric.query.v1.json](../docs/schemas/observability.metric.query.v1.json)；指南：[docs/guides/observability.md](../docs/guides/observability.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--resource` | string | 否 |  | 资源 ID（如服务 demo-order），替换指标模板中的 $service |
| `--metric` | string | 否 |  | 指标目录中的名称，如 request_latency、cache_hit_ratio（见 metric list） |
| `--promql` | string | 否 |  | 直接给出 PromQL（与 --metric 二选一） |
| `--window` | duration | 否 | `"15m"` | 查询窗口（截至当前） |
| `--step` | duration | 否 | `"15s"` | 采样步长 |
| `--endpoint` | string | 否 |  | Prometheus 端点名（默认取 profile defaults.prometheus） |

前置条件：

- profile 配置 endpoints.prometheus.<name>.url
- 指标目录 endpoints.prometheus.<name>.metrics（使用 --metric 时）

口径说明：

- 窗口内没有样本时返回 success + 空 series（empty=true），与 Prometheus 不可达（UPSTREAM_UNAVAILABLE）区分
- 比率类指标在分母为零（窗口内无请求）时 Prometheus 返回 NaN，输出为 null 并计入 nan_points
- rate() 已处理计数器重置；目录中的查询窗口（如 [1m]）决定平滑程度

```bash
workctl metric query --resource demo-order --metric request_latency --window 15m
workctl metric query --resource demo-order --promql 'sum by (route) (rate(http_requests_total{service="demo-order"}[1m]))'
```

### `workctl trace get`

按 trace_id 从结构化日志重建调用链（span 树、总耗时、各 span 自身耗时占比）

扫描资源绑定中服务的容器日志，收集 kind=span 记录与带 trace_id 的日志行，重建父子关系。这是日志派生视图，不是追踪后端。

- 能力：`observability.trace.get` v1.0.0；操作类型：**diagnose**；适配器：docker-engine-api|loki-http-api；认证：docker-socket
- 输出 Schema：[docs/schemas/observability.trace.get.v1.json](../docs/schemas/observability.trace.get.v1.json)；指南：[docs/guides/observability.md](../docs/guides/observability.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--id` | string | 是 |  | trace_id（32 位十六进制，见响应头 x-trace-id 或日志） |
| `--window` | duration | 否 | `"1h"` | 扫描日志的回看窗口 |
| `--service` | string | 否 |  | 只扫描该服务的容器（默认扫描资源绑定中全部 service） |

前置条件：

- 服务输出结构化 span 日志（kind=span, trace_id, span_id, parent_span_id, start, duration_ms）
- 容器日志仍在保留期内

口径说明：

- relation=derived：由日志重建，只包含被记录且仍保留的 span；未打点的耗时体现为父 span 的 self_ms
- 找不到时返回 NOT_FOUND；可扩大 --window 或确认 trace_id
- 日志来源按服务的日志 provider（docker 默认 | loki）；Loki 下以 |= "<trace_id>" 拉取后用同一逻辑重建
- Jaeger / Tempo 等追踪后端是规划中的 provider

```bash
workctl trace get --id 0d9ae006bb776f65c5bcca19759fce81 --window 1h
```

### `workctl storage file stat`

查看本机文件或目录的类型、大小、修改时间、权限与可读性（不读取内容）

- 能力：`storage.file.stat` v1.0.0；操作类型：**read**；适配器：node-fs；认证：local-user
- 输出 Schema：[docs/schemas/storage.file.stat.v1.json](../docs/schemas/storage.file.stat.v1.json)；指南：[docs/guides/infrastructure.md](../docs/guides/infrastructure.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--path` | string | 是 |  | 文件或目录路径（相对路径按当前目录解析） |

口径说明：

- 只读元数据（lstat/stat/access），不读取文件内容
- readable/writable 反映运行 workctl 的用户权限，不代表其他服务账号的权限
- 数据产出检查（分区/文件是否存在、可读）与调度成功是不同检查项

```bash
workctl storage file stat --path demo/environment/workctl.yaml
```

### `workctl storage volume get`

查看 Docker 卷的驱动、挂载点、标签、作用域、占用大小和挂载它的容器

- 能力：`storage.volume.get` v1.0.0；操作类型：**read**；适配器：docker-engine-api；认证：docker-socket
- 输出 Schema：[docs/schemas/storage.volume.get.v1.json](../docs/schemas/storage.volume.get.v1.json)；指南：[docs/guides/infrastructure.md](../docs/guides/infrastructure.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--id` | string | 是 |  | 卷名（如 workctl-demo_mysql-data） |

前置条件：

- endpoints.docker 可访问

口径说明：

- 占用大小来自 /system/df?type=volume（守护进程现场计算，可能较慢）；不可用时 usage.status=unavailable 并说明原因，不推算
- 对象存储（S3）与 HDFS 是规划中的 provider

```bash
workctl storage volume get --id workctl-demo_mysql-data
```

## 中间件

### `workctl mysql index list`

列出表的索引（按索引分组的列顺序、唯一性、基数估计），附自启动以来的索引访问计数

- 能力：`mysql.index.list` v1.0.0；操作类型：**read**；适配器：mysql-driver；认证：database-profile
- 输出 Schema：[docs/schemas/mysql.index.list.v1.json](../docs/schemas/mysql.index.list.v1.json)；指南：[docs/guides/mysql.md](../docs/guides/mysql.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--instance` | string | 否 |  | MySQL 端点名（profile 中 endpoints.mysql 的键；缺省取 defaults.mysql） |
| `--database` | string | 是 |  | 库名（schema） |
| `--table` | string | 是 |  | 表名 |

前置条件：

- profile 中配置 endpoints.mysql.<name>（host/port/user/password_ref）
- 只读诊断账号（如 workctl_ro）：SELECT on 业务库与 performance_schema.*、SELECT on mysql.slow_log、PROCESS

口径说明：

- cardinality_estimate 是统计估计值（ANALYZE TABLE 后更新），不是精确去重计数
- io_by_index 是累计值（自启动或 performance_schema 重置以来），不能当作窗口值；index=null 行代表不走索引的行读取（全表扫描）

```bash
workctl mysql index list --instance demo-mysql --database demo --table orders
```

### `workctl mysql index plan`

生成新增索引的变更计划（解析目标表、DDL、影响语句、前置条件、回滚），不执行

- 能力：`mysql.index.plan` v1.0.0；操作类型：**plan**；适配器：mysql-driver；认证：database-profile
- 输出 Schema：[docs/schemas/mysql.index.plan.v1.json](../docs/schemas/mysql.index.plan.v1.json)；指南：[docs/guides/mysql.md](../docs/guides/mysql.md)
- 幂等：否；可取消：否

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--instance` | string | 否 |  | MySQL 端点名（profile 中 endpoints.mysql 的键；缺省取 defaults.mysql） |
| `--database` | string | 是 |  | 库名（schema） |
| `--table` | string | 是 |  | 表名 |
| `--columns` | list | 是 |  | 索引列（按顺序，逗号分隔），如 customer_id,created_at |
| `--name` | string | 否 |  | 索引名（缺省 idx_<列名>） |

前置条件：

- profile 中配置 endpoints.mysql.<name>（host/port/user/password_ref）
- 只读诊断账号（如 workctl_ro）：SELECT on 业务库与 performance_schema.*、SELECT on mysql.slow_log、PROCESS
- 生成计划只需只读权限；执行需要单独的变更账号与 DBA 流程

口径说明：

- 计划预览不是执行成功的证据；mysql.index.create 没有执行器（executable=false），执行属于 DBA 变更流程
- 索引大小与构建成本是启发式估计；受影响语句来自累计摘要统计的文本匹配（inferred）
- 等价于 workctl operation plan --action mysql.index.create --param instance=... --param database=... --param table=... --param columns=...

```bash
workctl mysql index plan --instance demo-mysql --database demo --table orders --columns customer_id
```

### `workctl mysql instance get`

查看 MySQL 实例概况：版本、运行时长、关键参数与状态计数，并附平台绑定元数据

- 能力：`mysql.instance.get` v1.0.0；操作类型：**read**；适配器：mysql-driver；认证：database-profile
- 输出 Schema：[docs/schemas/mysql.instance.get.v1.json](../docs/schemas/mysql.instance.get.v1.json)；指南：[docs/guides/mysql.md](../docs/guides/mysql.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--instance` | string | 否 |  | MySQL 端点名（profile 中 endpoints.mysql 的键；缺省取 defaults.mysql） |

前置条件：

- profile 中配置 endpoints.mysql.<name>（host/port/user/password_ref）
- 只读诊断账号（如 workctl_ro）：SELECT on 业务库与 performance_schema.*、SELECT on mysql.slow_log、PROCESS

口径说明：

- binding 来自资源绑定文件（平台元数据，relation=explicit），engine/variables/status 来自引擎实时查询，两者分开标注
- Questions、Slow_queries、Aborted_connects 等是自启动以来的累计值，不是窗口值；窗口速率用 mysql statement summary

```bash
workctl mysql instance get --instance demo-mysql
```

### `workctl mysql lock list`

列出 InnoDB 行锁等待（谁在等、被谁阻塞）及元数据锁等待

- 能力：`mysql.lock.list` v1.0.0；操作类型：**read**；适配器：mysql-driver；认证：database-profile
- 输出 Schema：[docs/schemas/mysql.lock.list.v1.json](../docs/schemas/mysql.lock.list.v1.json)；指南：[docs/guides/mysql.md](../docs/guides/mysql.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--instance` | string | 否 |  | MySQL 端点名（profile 中 endpoints.mysql 的键；缺省取 defaults.mysql） |

前置条件：

- profile 中配置 endpoints.mysql.<name>（host/port/user/password_ref）
- 只读诊断账号（如 workctl_ro）：SELECT on 业务库与 performance_schema.*、SELECT on mysql.slow_log、PROCESS
- performance_schema 开启（data_locks / data_lock_waits，MySQL 8.0+）

口径说明：

- 没有锁等待时返回空列表（success），不是错误
- 阻塞方 sql_text 是其当前语句，不一定是持锁语句；空闲事务持锁时为空
- 瞬时快照；SQL 字面量已替换为 ?

```bash
workctl mysql lock list --instance demo-mysql
```

### `workctl mysql query analyze`

用 EXPLAIN ANALYZE 实际执行 SELECT 并返回各算子的实际耗时与行数（只读事务 + 执行时间上限）

- 能力：`mysql.query.analyze` v1.0.0；操作类型：**diagnose**；适配器：mysql-driver；认证：database-profile
- 输出 Schema：[docs/schemas/mysql.query.analyze.v1.json](../docs/schemas/mysql.query.analyze.v1.json)；指南：[docs/guides/mysql.md](../docs/guides/mysql.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--instance` | string | 否 |  | MySQL 端点名（profile 中 endpoints.mysql 的键；缺省取 defaults.mysql） |
| `--database` | string | 是 |  | 库名（schema） |
| `--sql` | string | 否 |  | 直接给出单条 SQL 语句（≤256KB，适合 Agent/MCP 调用）；与 --sql-file 二选一 |
| `--sql-file` | file | 否 |  | 包含单条 SQL 语句的文件路径（≤256KB）；与 --sql 二选一 |

前置条件：

- profile 中配置 endpoints.mysql.<name>（host/port/user/password_ref）
- 只读诊断账号（如 workctl_ro）：SELECT on 业务库与 performance_schema.*、SELECT on mysql.slow_log、PROCESS

口径说明：

- EXPLAIN ANALYZE 会实际执行语句（消耗实例资源、读取数据），只允许 SELECT；在只读事务中执行并受 MAX_EXECUTION_TIME 约束
- actual time 单位为毫秒，是每次 loop 的平均值；rows 也是每次 loop 的平均值
- 结果集本身不返回，只返回计划与实际统计
- SQL 来源二选一：--sql（内联，≤256KB）或 --sql-file；拒绝 MAX_EXECUTION_TIME / SET_VAR / RESOURCE_GROUP 优化器提示

```bash
workctl mysql query analyze --instance demo-mysql --database demo --sql "SELECT * FROM orders WHERE customer_id = 42"
workctl mysql query analyze --instance demo-mysql --database demo --sql-file ./q.sql
```

### `workctl mysql query execute`

受限只读查询：单条 SELECT/WITH/SHOW/DESCRIBE/EXPLAIN，只读事务 + 执行时间上限 + 行数上限 + 敏感列脱敏

- 能力：`mysql.query.execute` v1.0.0；操作类型：**read**；适配器：mysql-driver；认证：database-profile
- 输出 Schema：[docs/schemas/mysql.query.execute.v1.json](../docs/schemas/mysql.query.execute.v1.json)；指南：[docs/guides/mysql.md](../docs/guides/mysql.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--instance` | string | 否 |  | MySQL 端点名（profile 中 endpoints.mysql 的键；缺省取 defaults.mysql） |
| `--database` | string | 是 |  | 库名（schema） |
| `--sql` | string | 否 |  | 直接给出单条 SQL 语句（≤256KB，适合 Agent/MCP 调用）；与 --sql-file 二选一 |
| `--sql-file` | file | 否 |  | 包含单条 SQL 语句的文件路径（≤256KB）；与 --sql 二选一 |
| `--max-rows` | int | 否 | `20` | 最多返回行数（上限 1000）；超出时 coverage.truncated=true |

前置条件：

- profile 中配置 endpoints.mysql.<name>（host/port/user/password_ref）
- 只读诊断账号（如 workctl_ro）：SELECT on 业务库与 performance_schema.*、SELECT on mysql.slow_log、PROCESS
- 端点 max_execution_time_ms（默认 5000）与 sensitive_columns 配置

口径说明：

- 实际权限边界是数据库账号（workctl_ro 只有 SELECT）；程序层静态检查、只读事务、MAX_EXECUTION_TIME、行数上限是额外防线
- 静态检查：只允许单条 SELECT / WITH...SELECT / SHOW / DESCRIBE / EXPLAIN；拒绝 INTO OUTFILE/DUMPFILE、FOR UPDATE/SHARE、LOCK IN SHARE MODE、变量赋值、可执行注释、EXPLAIN ANALYZE；SHOW 中不允许 SLEEP/BENCHMARK/子查询（SHOW 不受 MAX_EXECUTION_TIME 约束）
- MAX_EXECUTION_TIME 只约束 SELECT；SHOW 等语句只受客户端超时约束
- 敏感列按列名/原始列名匹配端点 sensitive_columns 脱敏；选择列表中引用敏感列的表达式/别名、UNION 对应位置、引用敏感列的派生表/CTE、非首个 UNION 分支或派生表/CTE 中的 * 会保守地整列脱敏；语句可能读取敏感列时，服务端错误信息与 EXPLAIN 条件中的字面量替换为 ?；仍不能替代数据库侧的列权限或脱敏视图
- SQL 来源二选一：--sql（内联，≤256KB）或 --sql-file；两者走同一静态检查；拒绝 MAX_EXECUTION_TIME / SET_VAR / RESOURCE_GROUP 优化器提示

```bash
workctl mysql query execute --instance demo-mysql --database demo --sql "SELECT id, status FROM orders WHERE customer_id = 42" --max-rows 20
workctl mysql query execute --instance demo-mysql --database demo --sql-file ./q.sql --max-rows 20
```

### `workctl mysql query explain`

查看语句的执行计划（EXPLAIN FORMAT=JSON，不执行语句），附扁平化摘要

- 能力：`mysql.query.explain` v1.0.0；操作类型：**read**；适配器：mysql-driver；认证：database-profile
- 输出 Schema：[docs/schemas/mysql.query.explain.v1.json](../docs/schemas/mysql.query.explain.v1.json)；指南：[docs/guides/mysql.md](../docs/guides/mysql.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--instance` | string | 否 |  | MySQL 端点名（profile 中 endpoints.mysql 的键；缺省取 defaults.mysql） |
| `--database` | string | 是 |  | 库名（schema） |
| `--sql` | string | 否 |  | 直接给出单条 SQL 语句（≤256KB，适合 Agent/MCP 调用）；与 --sql-file 二选一 |
| `--sql-file` | file | 否 |  | 包含单条 SQL 语句的文件路径（≤256KB）；与 --sql 二选一 |

前置条件：

- profile 中配置 endpoints.mysql.<name>（host/port/user/password_ref）
- 只读诊断账号（如 workctl_ro）：SELECT on 业务库与 performance_schema.*、SELECT on mysql.slow_log、PROCESS
- EXPLAIN 需要与执行该语句相同的权限（只读账号 EXPLAIN UPDATE/DELETE 会被拒绝）

口径说明：

- 优化器估计，非实际执行：rows_examined_per_scan / filtered / cost 都是估计值；实际耗时用 mysql query analyze（会执行语句）
- 只接受单条语句；带 EXPLAIN ANALYZE 前缀的输入会被拒绝
- SQL 来源二选一：--sql（内联，≤256KB）或 --sql-file

```bash
workctl mysql query explain --instance demo-mysql --database demo --sql "SELECT * FROM orders WHERE customer_id = 42"
workctl mysql query explain --instance demo-mysql --database demo --sql-file ./q.sql
```

### `workctl mysql session list`

列出当前会话与事务（processlist + INNODB_TRX），默认只含活跃会话或持有事务的会话

- 能力：`mysql.session.list` v1.0.0；操作类型：**read**；适配器：mysql-driver；认证：database-profile
- 输出 Schema：[docs/schemas/mysql.session.list.v1.json](../docs/schemas/mysql.session.list.v1.json)；指南：[docs/guides/mysql.md](../docs/guides/mysql.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--instance` | string | 否 |  | MySQL 端点名（profile 中 endpoints.mysql 的键；缺省取 defaults.mysql） |
| `--include-idle` | bool | 否 | `false` | 包含空闲 (Sleep) 且无事务的会话 |

前置条件：

- profile 中配置 endpoints.mysql.<name>（host/port/user/password_ref）
- 只读诊断账号（如 workctl_ro）：SELECT on 业务库与 performance_schema.*、SELECT on mysql.slow_log、PROCESS
- 没有 PROCESS 权限时只能看到本账号的会话（结果标记为 partial）

口径说明：

- SQL 文本中的字面量替换为 ?（避免输出敏感值）并截断到 512 字符
- 这是瞬时快照：会话状态在毫秒级变化，不代表一段时间内的情况
- 已排除 workctl 自身的连接

```bash
workctl mysql session list --instance demo-mysql
workctl mysql session list --instance demo-mysql --include-idle
```

### `workctl mysql slowlog list`

读取慢查询日志（mysql.slow_log 表），区分“未开启/不可读”与“窗口内没有慢查询”

- 能力：`mysql.slowlog.list` v1.0.0；操作类型：**read**；适配器：mysql-driver；认证：database-profile
- 输出 Schema：[docs/schemas/mysql.slowlog.list.v1.json](../docs/schemas/mysql.slowlog.list.v1.json)；指南：[docs/guides/mysql.md](../docs/guides/mysql.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--instance` | string | 否 |  | MySQL 端点名（profile 中 endpoints.mysql 的键；缺省取 defaults.mysql） |
| `--since` | duration | 否 | `"1h"` | 时间范围（从现在往前） |
| `--limit` | int | 否 | `20` | 最多返回条数（按开始时间倒序） |

前置条件：

- profile 中配置 endpoints.mysql.<name>（host/port/user/password_ref）
- 只读诊断账号（如 workctl_ro）：SELECT on 业务库与 performance_schema.*、SELECT on mysql.slow_log、PROCESS
- slow_query_log=ON 且 log_output 含 TABLE；账号有 SELECT on mysql.slow_log

口径说明：

- slow_query_log=OFF 或 log_output 不含 TABLE 时返回 COLLECTION_DISABLED（不是“没有慢查询”）
- 只记录超过 long_query_time 的语句（及开启 log_queries_not_using_indexes 时未用索引的语句）；query_time 含锁等待时间
- SQL 文本中的字面量替换为 ?，避免输出敏感值

```bash
workctl mysql slowlog list --instance demo-mysql --since 1h --limit 20
```

### `workctl mysql statement summary`

按语句摘要统计窗口内的执行次数、耗时、扫描行数和未用索引次数（performance_schema 两次快照差分）

- 能力：`mysql.statement.summary` v1.0.0；操作类型：**diagnose**；适配器：mysql-driver；认证：database-profile
- 输出 Schema：[docs/schemas/mysql.statement.summary.v1.json](../docs/schemas/mysql.statement.summary.v1.json)；指南：[docs/guides/mysql.md](../docs/guides/mysql.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--instance` | string | 否 |  | MySQL 端点名（profile 中 endpoints.mysql 的键；缺省取 defaults.mysql） |
| `--sample-window` | string | 否 | `"10s"` | 采样窗口，如 5s、30s；0 表示返回累计值（不是窗口值）。窗口须小于 --timeout |
| `--top` | int | 否 | `10` | 按总耗时取前 N 个摘要 |
| `--database` | string | 否 |  | 只看该默认库（SCHEMA_NAME）下的语句 |

前置条件：

- profile 中配置 endpoints.mysql.<name>（host/port/user/password_ref）
- 只读诊断账号（如 workctl_ro）：SELECT on 业务库与 performance_schema.*、SELECT on mysql.slow_log、PROCESS
- performance_schema=ON 且 statements_digest consumer 启用

口径说明：

- 窗口值 = t1 快照 − t0 快照（按 SCHEMA_NAME + DIGEST）；采样期间命令会等待整个窗口，窗口须小于 --timeout（默认 30s）
- --sample-window 0 返回自服务启动/摘要表重置（或该摘要首次出现）以来的累计值，aggregation=cumulative_since，不能当作窗口值
- 摘要表满（performance_schema_digests_size）或被 TRUNCATE 时结果标记为 partial；计数回退的摘要只计入重置后的部分
- 耗时单位为毫秒（由皮秒换算）；no_index_used_count 是未使用索引（全表扫描）的执行次数

```bash
workctl mysql statement summary --instance demo-mysql --sample-window 5s --top 10
workctl --timeout 60s mysql statement summary --instance demo-mysql --sample-window 30s --database demo
workctl mysql statement summary --instance demo-mysql --sample-window 0
```

### `workctl mysql table get`

查看表结构与表级统计（information_schema.TABLES / COLUMNS），行数为估计值

- 能力：`mysql.table.get` v1.0.0；操作类型：**read**；适配器：mysql-driver；认证：database-profile
- 输出 Schema：[docs/schemas/mysql.table.get.v1.json](../docs/schemas/mysql.table.get.v1.json)；指南：[docs/guides/mysql.md](../docs/guides/mysql.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--instance` | string | 否 |  | MySQL 端点名（profile 中 endpoints.mysql 的键；缺省取 defaults.mysql） |
| `--database` | string | 是 |  | 库名（schema） |
| `--table` | string | 是 |  | 表名 |

前置条件：

- profile 中配置 endpoints.mysql.<name>（host/port/user/password_ref）
- 只读诊断账号（如 workctl_ro）：SELECT on 业务库与 performance_schema.*、SELECT on mysql.slow_log、PROCESS
- 对目标表有任一权限（information_schema 只显示有权限的对象）

口径说明：

- rows_estimate、data_length 等来自 InnoDB 统计信息，是估计值；且受 information_schema_stats_expiry 缓存影响（默认 86400 秒）
- 表不可见时会区分“不存在”(NOT_FOUND) 与“无权限”(PERMISSION_DENIED)

```bash
workctl mysql table get --instance demo-mysql --database demo --table orders
```

### `workctl pg database list`

列出实例中的数据库：大小、连接数、事务/缓存/死锁累计计数与统计重置时间、事务 ID 年龄

- 能力：`postgres.database.list` v1.0.0；操作类型：**read**；适配器：pg-driver；认证：database-profile
- 输出 Schema：[docs/schemas/postgres.database.list.v1.json](../docs/schemas/postgres.database.list.v1.json)；指南：[docs/guides/postgres.md](../docs/guides/postgres.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--instance` | string | 否 |  | PostgreSQL 端点名（profile 中 endpoints.postgres 的键；缺省取 defaults.postgres） |
| `--include-templates` | bool | 否 | `false` | 包含 template0 / template1 |

前置条件：

- profile 中配置 endpoints.postgres.<name>（host/port/user/password_ref/database）
- 只读诊断角色（如 workctl_ro）：LOGIN、CONNECT on 目标库、pg_read_all_stats、业务表 SELECT；建议 default_transaction_read_only=on

口径说明：

- xact_commit / blks_hit / deadlocks / temp_bytes 等来自 pg_stat_database，是自 stats_reset（或 initdb）以来的累计值，不是窗口值
- backends 是瞬时值；size_bytes 是调用时的实际大小

```bash
workctl pg database list --instance demo-postgres
```

### `workctl pg instance get`

查看 PostgreSQL 实例概况：版本、运行时长、关键参数、连接使用、主备角色、已安装扩展，并附平台绑定元数据

- 能力：`postgres.instance.get` v1.0.0；操作类型：**read**；适配器：pg-driver；认证：database-profile
- 输出 Schema：[docs/schemas/postgres.instance.get.v1.json](../docs/schemas/postgres.instance.get.v1.json)；指南：[docs/guides/postgres.md](../docs/guides/postgres.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--instance` | string | 否 |  | PostgreSQL 端点名（profile 中 endpoints.postgres 的键；缺省取 defaults.postgres） |

前置条件：

- profile 中配置 endpoints.postgres.<name>（host/port/user/password_ref/database）
- 只读诊断角色（如 workctl_ro）：LOGIN、CONNECT on 目标库、pg_read_all_stats、业务表 SELECT；建议 default_transaction_read_only=on

口径说明：

- binding 来自资源绑定文件（平台元数据，relation=explicit），engine/settings/connections 来自引擎实时查询，两者分开标注
- 扩展按库安装：extensions 只反映当前连接的库（--instance 端点配置的 database）
- 连接数是瞬时快照；累计计数（提交/回滚/死锁）见 pg database list，是自统计重置以来的累计值
- statement_timeout、default_transaction_read_only 等会话级参数反映 workctl 自身会话（source=client/user 表示由连接或角色设置），不一定等于应用会话的取值

```bash
workctl pg instance get --instance demo-postgres
```

### `workctl pg lock list`

列出锁等待与阻塞链：谁在等（等什么锁）、被谁阻塞（pg_blocking_pids），以及链条源头

- 能力：`postgres.lock.list` v1.0.0；操作类型：**read**；适配器：pg-driver；认证：database-profile
- 输出 Schema：[docs/schemas/postgres.lock.list.v1.json](../docs/schemas/postgres.lock.list.v1.json)；指南：[docs/guides/postgres.md](../docs/guides/postgres.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--instance` | string | 否 |  | PostgreSQL 端点名（profile 中 endpoints.postgres 的键；缺省取 defaults.postgres） |

前置条件：

- profile 中配置 endpoints.postgres.<name>（host/port/user/password_ref/database）
- 只读诊断角色（如 workctl_ro）：LOGIN、CONNECT on 目标库、pg_read_all_stats、业务表 SELECT；建议 default_transaction_read_only=on
- pg_locks 对所有角色可见；阻塞方语句需 pg_read_all_stats

口径说明：

- 没有锁等待时返回空列表（success），不是错误
- 阻塞方 query 是其当前/最后一条语句，不一定是持锁语句；idle in transaction 的阻塞方需要应用提交/回滚或由 DBA 处理
- 瞬时快照；锁等待可能在毫秒内结束。行锁等待在 pg_locks 中表现为 transactionid 锁（等待持锁事务结束）

```bash
workctl pg lock list --instance demo-postgres
```

### `workctl pg query analyze`

用 EXPLAIN ANALYZE 实际执行 SELECT 并返回各节点的实际耗时、行数与缓冲区命中（READ ONLY 事务 + statement_timeout，结束后回滚）

- 能力：`postgres.query.analyze` v1.0.0；操作类型：**diagnose**；适配器：pg-driver；认证：database-profile
- 输出 Schema：[docs/schemas/postgres.query.analyze.v1.json](../docs/schemas/postgres.query.analyze.v1.json)；指南：[docs/guides/postgres.md](../docs/guides/postgres.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--instance` | string | 否 |  | PostgreSQL 端点名（profile 中 endpoints.postgres 的键；缺省取 defaults.postgres） |
| `--database` | string | 否 |  | 要连接的库名；缺省取端点配置的 database（再缺省为 postgres） |
| `--sql` | string | 否 |  | 直接给出单条 SQL 语句（≤256KB，适合 Agent/MCP 调用）；与 --sql-file 二选一 |
| `--sql-file` | file | 否 |  | 包含单条 SQL 语句的文件路径（≤256KB）；与 --sql 二选一 |

前置条件：

- profile 中配置 endpoints.postgres.<name>（host/port/user/password_ref/database）
- 只读诊断角色（如 workctl_ro）：LOGIN、CONNECT on 目标库、pg_read_all_stats、业务表 SELECT；建议 default_transaction_read_only=on
- 端点 statement_timeout_ms（默认 10000）

口径说明：

- EXPLAIN ANALYZE 会实际执行语句（消耗实例资源、读取数据），只允许 SELECT / WITH...SELECT / VALUES / TABLE；在 READ ONLY 事务中执行、受 statement_timeout 约束，结束后 ROLLBACK
- actual_total_ms / actual_rows 是每次 loop 的平均值；节点总量 ≈ 值 × loops
- 结果集本身不返回，只返回计划与实际统计；实际耗时受缓存（shared_buffers / OS cache）影响，重复执行可能更快
- SQL 来源二选一：--sql（内联，≤256KB）或 --sql-file

```bash
workctl pg query analyze --instance demo-postgres --sql "SELECT * FROM orders WHERE customer_id = 42"
workctl pg query analyze --instance demo-postgres --database demo_orders --sql-file ./q.sql
```

### `workctl pg query explain`

查看语句的执行计划（EXPLAIN (FORMAT JSON)，不执行语句，只是优化器估计），附扁平化摘要

- 能力：`postgres.query.explain` v1.0.0；操作类型：**read**；适配器：pg-driver；认证：database-profile
- 输出 Schema：[docs/schemas/postgres.query.explain.v1.json](../docs/schemas/postgres.query.explain.v1.json)；指南：[docs/guides/postgres.md](../docs/guides/postgres.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--instance` | string | 否 |  | PostgreSQL 端点名（profile 中 endpoints.postgres 的键；缺省取 defaults.postgres） |
| `--database` | string | 否 |  | 要连接的库名；缺省取端点配置的 database（再缺省为 postgres） |
| `--sql` | string | 否 |  | 直接给出单条 SQL 语句（≤256KB，适合 Agent/MCP 调用）；与 --sql-file 二选一 |
| `--sql-file` | file | 否 |  | 包含单条 SQL 语句的文件路径（≤256KB）；与 --sql 二选一 |

前置条件：

- profile 中配置 endpoints.postgres.<name>（host/port/user/password_ref/database）
- 只读诊断角色（如 workctl_ro）：LOGIN、CONNECT on 目标库、pg_read_all_stats、业务表 SELECT；建议 default_transaction_read_only=on
- EXPLAIN 需要对涉及的表有相应权限（只读角色 EXPLAIN UPDATE/DELETE 会因缺 UPDATE/DELETE 权限被拒绝）

口径说明：

- 优化器估计，非实际执行：cost / plan_rows 都是基于统计信息的估计；实际耗时与行数用 pg query analyze（会执行语句）
- 只接受单条语句，不要带 EXPLAIN 前缀；含 $1 等占位符（如 pg_stat_statements 中的归一化语句）时在 PG16+ 使用 GENERIC_PLAN
- 在 READ ONLY 事务中执行并随后回滚；SQL 来源二选一：--sql（内联，≤256KB）或 --sql-file

```bash
workctl pg query explain --instance demo-postgres --sql "SELECT * FROM orders WHERE customer_id = 42"
workctl pg query explain --instance demo-postgres --database demo_orders --sql-file ./q.sql
```

### `workctl pg query run`

受限只读查询：单条 SELECT/WITH/VALUES/TABLE，READ ONLY 事务 + statement_timeout + 游标取行上限 + 敏感列脱敏

- 能力：`postgres.query.run` v1.0.0；操作类型：**read**；适配器：pg-driver；认证：database-profile
- 输出 Schema：[docs/schemas/postgres.query.run.v1.json](../docs/schemas/postgres.query.run.v1.json)；指南：[docs/guides/postgres.md](../docs/guides/postgres.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--instance` | string | 否 |  | PostgreSQL 端点名（profile 中 endpoints.postgres 的键；缺省取 defaults.postgres） |
| `--database` | string | 否 |  | 要连接的库名；缺省取端点配置的 database（再缺省为 postgres） |
| `--sql` | string | 否 |  | 直接给出单条 SQL 语句（≤256KB，适合 Agent/MCP 调用）；与 --sql-file 二选一 |
| `--sql-file` | file | 否 |  | 包含单条 SQL 语句的文件路径（≤256KB）；与 --sql 二选一 |
| `--max-rows` | int | 否 | `20` | 最多返回行数（上限 1000）；超出时 truncated=true |

前置条件：

- profile 中配置 endpoints.postgres.<name>（host/port/user/password_ref/database）
- 只读诊断角色（如 workctl_ro）：LOGIN、CONNECT on 目标库、pg_read_all_stats、业务表 SELECT；建议 default_transaction_read_only=on
- 端点 statement_timeout_ms（默认 10000）与 sensitive_columns 配置

口径说明：

- 真正的权限边界是数据库角色（workctl_ro 只有 SELECT，且 default_transaction_read_only=on）；程序层静态检查、READ ONLY 事务、statement_timeout、行数上限是额外防线，不能替代只读角色
- 静态检查：只允许单条 SELECT / WITH...SELECT / VALUES / TABLE；拒绝多语句、数据修改型 CTE、SELECT INTO、FOR UPDATE/SHARE，以及终止会话/读写文件/咨询锁/序列/重置统计/执行任意 SQL 文本的函数（不穷尽：自定义函数仍可能有副作用，由角色权限兜底）
- 通过游标（DECLARE CURSOR + FETCH）只取 max_rows+1 行，不缓冲完整结果集
- 敏感列：输出列名或其来源列（按系统目录解析，覆盖别名）命中端点 sensitive_columns 时脱敏；表达式列在语句引用了敏感列时、或语句涉及含敏感列的表且该列为非数值类型（整行引用、row_to_json 等）时保守脱敏；不能替代数据库侧列权限或脱敏视图

```bash
workctl pg query run --instance demo-postgres --sql "SELECT id, status, amount FROM orders WHERE customer_id = 42" --max-rows 20
workctl pg query run --instance demo-postgres --database demo_orders --sql-file ./q.sql --max-rows 50
```

### `workctl pg session list`

列出当前会话（pg_stat_activity）：状态、等待事件、事务/语句时长、阻塞方，默认只含非 idle 的客户端会话

- 能力：`postgres.session.list` v1.0.0；操作类型：**read**；适配器：pg-driver；认证：database-profile
- 输出 Schema：[docs/schemas/postgres.session.list.v1.json](../docs/schemas/postgres.session.list.v1.json)；指南：[docs/guides/postgres.md](../docs/guides/postgres.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--instance` | string | 否 |  | PostgreSQL 端点名（profile 中 endpoints.postgres 的键；缺省取 defaults.postgres） |
| `--include-idle` | bool | 否 | `false` | 包含 state=idle 的会话 |
| `--include-background` | bool | 否 | `false` | 包含后台进程（autovacuum、walwriter、checkpointer 等） |

前置条件：

- profile 中配置 endpoints.postgres.<name>（host/port/user/password_ref/database）
- 只读诊断角色（如 workctl_ro）：LOGIN、CONNECT on 目标库、pg_read_all_stats、业务表 SELECT；建议 default_transaction_read_only=on
- 没有 pg_read_all_stats 时其他角色会话的语句、等待事件等字段被隐藏（结果标记为 partial）

口径说明：

- 瞬时快照：会话状态在毫秒级变化，不代表一段时间内的情况
- 语句文本中的字面量替换为 ?（避免输出敏感值）并截断到 512 字符；原文本身受 track_activity_query_size 截断
- 已排除 workctl 自身的连接（pg_backend_pid()）

```bash
workctl pg session list --instance demo-postgres
workctl pg session list --instance demo-postgres --include-idle
```

### `workctl pg statement summary`

按语句（pg_stat_statements）统计调用次数、执行耗时、返回行数和缓存命中；默认两次快照差分得到窗口值

- 能力：`postgres.statement.summary` v1.0.0；操作类型：**diagnose**；适配器：pg-driver；认证：database-profile
- 输出 Schema：[docs/schemas/postgres.statement.summary.v1.json](../docs/schemas/postgres.statement.summary.v1.json)；指南：[docs/guides/postgres.md](../docs/guides/postgres.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--instance` | string | 否 |  | PostgreSQL 端点名（profile 中 endpoints.postgres 的键；缺省取 defaults.postgres） |
| `--sample-window` | string | 否 | `"10s"` | 采样窗口，如 5s、30s；0 表示返回自 stats_reset 以来的累计值（不是窗口值）。窗口须小于 --timeout |
| `--top` | int | 否 | `10` | 取前 N 条 |
| `--order-by` | enum (total_time/calls/mean_time/rows/shared_blks_read) | 否 | `"total_time"` | 排序：total_time（总耗时）/ calls / mean_time / rows / shared_blks_read |
| `--database` | string | 否 |  | 只看该库的语句（pg_stat_statements.dbid）；缺省为全部库 |

前置条件：

- profile 中配置 endpoints.postgres.<name>（host/port/user/password_ref/database）
- 只读诊断角色（如 workctl_ro）：LOGIN、CONNECT on 目标库、pg_read_all_stats、业务表 SELECT；建议 default_transaction_read_only=on
- shared_preload_libraries 含 pg_stat_statements（需重启）且在连接库中 CREATE EXTENSION pg_stat_statements；pg_stat_statements.track ≠ none

口径说明：

- pg_stat_statements 的值是自 stats_reset（扩展创建或 pg_stat_statements_reset()；默认 save=on 时正常重启不清空）以来的累计值；--sample-window 0 直接返回累计值（aggregation=cumulative_since），不能当作窗口值
- 窗口值 = t1 快照 − t0 快照（按 userid+dbid+queryid+toplevel）；采样期间命令会等待整个窗口，窗口须小于 --timeout（默认 30s）
- 单条语句被重置（PG17+ 看 stats_since；更早版本看计数/耗时回退、max 下降或 min 上升）时只计入重置后的部分（reset_detected=true）并标记 partial；窗口内有条目被淘汰（dealloc 增加）或消失时也标记为 partial
- 耗时单位毫秒（total_exec_time，不含规划时间）；扩展未安装/未加载/track=none 时返回 COLLECTION_DISABLED，而不是空结果

```bash
workctl pg statement summary --instance demo-postgres --sample-window 10s --top 10
workctl pg statement summary --instance demo-postgres --sample-window 0 --order-by mean_time --database demo_orders
```

### `workctl pg table get`

查看表结构、索引、大小与表级统计（扫描次数、活/死元组估计、最近 vacuum/analyze）

- 能力：`postgres.table.get` v1.0.0；操作类型：**read**；适配器：pg-driver；认证：database-profile
- 输出 Schema：[docs/schemas/postgres.table.get.v1.json](../docs/schemas/postgres.table.get.v1.json)；指南：[docs/guides/postgres.md](../docs/guides/postgres.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--instance` | string | 否 |  | PostgreSQL 端点名（profile 中 endpoints.postgres 的键；缺省取 defaults.postgres） |
| `--database` | string | 否 |  | 要连接的库名；缺省取端点配置的 database（再缺省为 postgres） |
| `--schema` | string | 否 | `"public"` | schema 名（区分大小写，按实际名称给出） |
| `--table` | string | 是 |  | 表名（区分大小写，按实际名称给出，不加双引号） |

前置条件：

- profile 中配置 endpoints.postgres.<name>（host/port/user/password_ref/database）
- 只读诊断角色（如 workctl_ro）：LOGIN、CONNECT on 目标库、pg_read_all_stats、业务表 SELECT；建议 default_transaction_read_only=on
- CONNECT on 目标库；系统目录对所有角色可见，所以没有 SELECT 权限也能看到结构（access.select=false）

口径说明：

- n_live_tup / n_dead_tup / reltuples 是估计值；seq_scan / idx_scan / n_tup_* 是自统计重置以来的累计值，不是窗口值
- 名称区分大小写，按实际对象名给出（不加双引号）；表不存在返回 NOT_FOUND
- seq_scan 远大于 idx_scan 且表不小，常见于缺索引；结合 pg query explain 确认

```bash
workctl pg table get --instance demo-postgres --database demo_orders --table orders
workctl pg table get --instance demo-postgres --schema public --table order_items
```

### `workctl redis config get`

读取 Redis 配置项（CONFIG GET），口令类配置自动隐藏

- 能力：`redis.config.get` v1.0.0；操作类型：**read**；适配器：redis-client；认证：redis-profile
- 输出 Schema：[docs/schemas/redis.config.get.v1.json](../docs/schemas/redis.config.get.v1.json)；指南：[docs/guides/redis.md](../docs/guides/redis.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--instance` | string | 否 |  | Redis 端点名（profile 中 endpoints.redis 的键；缺省取 defaults.redis） |
| `--pattern` | string | 是 |  | 配置名或通配模式，如 maxmemory*、slowlog-* |

前置条件：

- profile 中配置 endpoints.redis.<name>（host/port，可选 username/password_ref/db）
- 账号需允许 INFO（ACL +info）
- ACL +config|get；托管 Redis 可能禁用 CONFIG

口径说明：

- requirepass、masterauth 等口令类配置只显示为 <redacted>
- ACL 拒绝（NOPERM）返回 PERMISSION_DENIED；命令被禁用/重命名返回 UNSUPPORTED

```bash
workctl redis config get --instance demo-redis --pattern "maxmemory*"
```

### `workctl redis info get`

读取并解析 INFO 指定分区，逐项标注累计值/瞬时值/静态值

- 能力：`redis.info.get` v1.0.0；操作类型：**read**；适配器：redis-client；认证：redis-profile
- 输出 Schema：[docs/schemas/redis.info.get.v1.json](../docs/schemas/redis.info.get.v1.json)；指南：[docs/guides/redis.md](../docs/guides/redis.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--instance` | string | 否 |  | Redis 端点名（profile 中 endpoints.redis 的键；缺省取 defaults.redis） |
| `--section` | enum (server/clients/memory/persistence/stats/replication/cpu/modules/commandstats/errorstats/latencystats/cluster/keyspace/all/default/everything) | 否 | `"default"` | INFO 分区；all/everything 返回全部 |

前置条件：

- profile 中配置 endpoints.redis.<name>（host/port，可选 username/password_ref/db）
- 账号需允许 INFO（ACL +info）

口径说明：

- cumulative_since_start：自启动（或 CONFIG RESETSTAT）以来的累计值，不是窗口值；窗口差分用 redis stats sample
- instantaneous_estimate：服务端对最近约 1.6 秒的抽样估算，不是精确窗口值

```bash
workctl redis info get --instance demo-redis --section stats
```

### `workctl redis instance get`

查看 Redis 实例概况：版本、角色、连接数、内存与淘汰策略、持久化状态，并附平台绑定元数据

- 能力：`redis.instance.get` v1.0.0；操作类型：**read**；适配器：redis-client；认证：redis-profile
- 输出 Schema：[docs/schemas/redis.instance.get.v1.json](../docs/schemas/redis.instance.get.v1.json)；指南：[docs/guides/redis.md](../docs/guides/redis.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--instance` | string | 否 |  | Redis 端点名（profile 中 endpoints.redis 的键；缺省取 defaults.redis） |

前置条件：

- profile 中配置 endpoints.redis.<name>（host/port，可选 username/password_ref/db）
- 账号需允许 INFO（ACL +info）

口径说明：

- binding 来自资源绑定文件（平台元数据），其余来自 INFO 实时查询；connected_clients 等为瞬时值，命中率等窗口指标用 redis stats sample

```bash
workctl redis instance get --instance demo-redis
```

### `workctl redis key hot`

在 LFU 淘汰策略下按 OBJECT FREQ 找访问频度最高的键（对数计数器，不是 QPS）

- 能力：`redis.key.hot` v1.0.0；操作类型：**diagnose**；适配器：redis-client；认证：redis-profile
- 输出 Schema：[docs/schemas/redis.key.hot.v1.json](../docs/schemas/redis.key.hot.v1.json)；指南：[docs/guides/redis.md](../docs/guides/redis.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--instance` | string | 否 |  | Redis 端点名（profile 中 endpoints.redis 的键；缺省取 defaults.redis） |
| `--pattern` | string | 否 | `"*"` | SCAN MATCH 模式，如 demo:order:* |
| `--max-keys` | int | 否 | `100` | 最多采样的不同键数（上限 10000） |
| `--max-scan-calls` | int | 否 | `50` | 最多 SCAN 调用次数（预算） |
| `--scan-count` | int | 否 | `100` | SCAN COUNT 提示值（只是提示，不保证每次返回数量） |
| `--top` | int | 否 | `10` | 返回前 N 个 |

前置条件：

- profile 中配置 endpoints.redis.<name>（host/port，可选 username/password_ref/db）
- 账号需允许 INFO（ACL +info）
- maxmemory-policy 为 allkeys-lfu 或 volatile-lfu；ACL +scan +object|freq

口径说明：

- OBJECT FREQ 是 0–255 的对数概率计数器（受 lfu-log-factor 影响），随时间衰减（lfu-decay-time），不是 QPS，也不能跨实例比较
- 非 LFU 策略时返回 COLLECTION_DISABLED（Redis 没有在跟踪访问频度）
- 热度与内存大小是不同维度：大键用 redis key sample
- 基于 SCAN 采样，可能遗漏热键

```bash
workctl redis key hot --instance demo-redis --pattern "demo:*" --max-keys 500
```

### `workctl redis key inspect`

查看单个键的类型、TTL、编码、近似内存、长度与 LFU 计数；可选读取截断后的值

- 能力：`redis.key.inspect` v1.0.0；操作类型：**read**；适配器：redis-client；认证：redis-profile
- 输出 Schema：[docs/schemas/redis.key.inspect.v1.json](../docs/schemas/redis.key.inspect.v1.json)；指南：[docs/guides/redis.md](../docs/guides/redis.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--instance` | string | 否 |  | Redis 端点名（profile 中 endpoints.redis 的键；缺省取 defaults.redis） |
| `--key` | string | 是 |  | 键名 |
| `--include-value` | bool | 否 | `false` | 读取值（字符串 ≤1KB，集合前 20 个元素）；会更新该键的 LFU/LRU 访问信息 |

前置条件：

- profile 中配置 endpoints.redis.<name>（host/port，可选 username/password_ref/db）
- 账号需允许 INFO（ACL +info）
- ACL +type +pttl +object +memory|usage 与对应长度命令；--include-value 需要读命令权限

口径说明：

- 键不存在返回 NOT_FOUND（PTTL=-2）；PTTL=-1 表示没有过期时间（ttl_ms=null）
- MEMORY USAGE 为近似值（SAMPLES 5）；内存大小不是访问热度
- lfu_counter 仅在 maxmemory-policy 为 *-lfu 时有意义，否则为 null 并说明原因
- --include-value 会读取值（计入 keyspace_hits，并更新 LFU/LRU），值可能含业务数据，按需开启

```bash
workctl redis key inspect --instance demo-redis --key demo:order:1
workctl redis key inspect --instance demo-redis --key demo:customer:1:recent --include-value
```

### `workctl redis key sample`

按模式有预算地 SCAN 采样键，统计类型与内存占用分布（p50/p90/p99/max）和最大键候选

- 能力：`redis.key.sample` v1.0.0；操作类型：**diagnose**；适配器：redis-client；认证：redis-profile
- 输出 Schema：[docs/schemas/redis.key.sample.v1.json](../docs/schemas/redis.key.sample.v1.json)；指南：[docs/guides/redis.md](../docs/guides/redis.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--instance` | string | 否 |  | Redis 端点名（profile 中 endpoints.redis 的键；缺省取 defaults.redis） |
| `--pattern` | string | 否 | `"*"` | SCAN MATCH 模式，如 demo:order:* |
| `--max-keys` | int | 否 | `100` | 最多采样的不同键数（上限 10000） |
| `--max-scan-calls` | int | 否 | `50` | 最多 SCAN 调用次数（预算） |
| `--scan-count` | int | 否 | `100` | SCAN COUNT 提示值（只是提示，不保证每次返回数量） |

前置条件：

- profile 中配置 endpoints.redis.<name>（host/port，可选 username/password_ref/db）
- 账号需允许 INFO（ACL +info）
- ACL +scan +type +memory|usage +dbsize，且对匹配的键有读权限

口径说明：

- 这是采样，不是一致性全量快照：SCAN 可能重复返回键（已去重）、COUNT 只是提示，遍历期间增删的键可能遗漏
- MEMORY USAGE 使用 SAMPLES 5 估算集合类型，是近似值；内存大小不是访问热度（热度用 redis key hot）
- coverage.complete=true 仅表示游标在预算内回到 0

```bash
workctl redis key sample --instance demo-redis --pattern "demo:*" --max-keys 200
```

### `workctl redis slowlog list`

读取 Redis 慢日志（SLOWLOG GET），参数脱敏，只保留命令与键名

- 能力：`redis.slowlog.list` v1.0.0；操作类型：**read**；适配器：redis-client；认证：redis-profile
- 输出 Schema：[docs/schemas/redis.slowlog.list.v1.json](../docs/schemas/redis.slowlog.list.v1.json)；指南：[docs/guides/redis.md](../docs/guides/redis.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--instance` | string | 否 |  | Redis 端点名（profile 中 endpoints.redis 的键；缺省取 defaults.redis） |
| `--limit` | int | 否 | `10` | 最多返回条数（最新在前） |

前置条件：

- profile 中配置 endpoints.redis.<name>（host/port，可选 username/password_ref/db）
- 账号需允许 INFO（ACL +info）
- ACL +slowlog；读取阈值需要 +config|get（无权限时阈值显示为 unknown）

口径说明：

- 慢日志只含命令执行时间，不含网络往返、排队等待与 I/O；客户端看到的延迟可能远大于 duration_us
- 只保留最近 slowlog-max-len 条，更早的已被覆盖；slowlog-log-slower-than 为负数时表示关闭
- 参数中只保留命令（含子命令）与键名，其余值替换为 ?

```bash
workctl redis slowlog list --instance demo-redis --limit 10
```

### `workctl redis stats sample`

在同一连接上两次采样 INFO，计算窗口内命中率、命令数、淘汰/过期等增量与速率（处理重启与计数器重置）

- 能力：`redis.stats.sample` v1.0.0；操作类型：**diagnose**；适配器：redis-client；认证：redis-profile
- 输出 Schema：[docs/schemas/redis.stats.sample.v1.json](../docs/schemas/redis.stats.sample.v1.json)；指南：[docs/guides/redis.md](../docs/guides/redis.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--instance` | string | 否 |  | Redis 端点名（profile 中 endpoints.redis 的键；缺省取 defaults.redis） |
| `--duration` | duration | 否 | `"10s"` | 采样窗口（须小于 --timeout，默认 30s） |

前置条件：

- profile 中配置 endpoints.redis.<name>（host/port，可选 username/password_ref/db）
- 账号需允许 INFO（ACL +info）

口径说明：

- 窗口值 = 第二次 INFO − 第一次 INFO；命令会等待整个窗口，窗口须小于 --timeout
- run_id 变化或 uptime 回退视为重启：增量为 null 且结果标记 partial；计数器回退（CONFIG RESETSTAT）同样处理，绝不输出负数
- hit_ratio = hits/(hits+misses)；窗口内没有键查找时为 null（不是 0）
- total_commands_processed 包含 workctl 自身的 1 条 INFO 命令

```bash
workctl redis stats sample --instance demo-redis --duration 10s
workctl --timeout 60s redis stats sample --instance demo-redis --duration 30s
```

## 离线链路

### `workctl compute job get`

查看 Spark 应用：尝试、持续时间、状态、作业与 executor 汇总（Spark history server REST）

- 能力：`compute.job.get` v1.0.0；操作类型：**read**；适配器：spark-history-rest；认证：none
- 输出 Schema：[docs/schemas/compute.job.get.v1.json](../docs/schemas/compute.job.get.v1.json)；指南：[docs/guides/compute.md](../docs/guides/compute.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--id` | string | 是 |  | Spark application id（如 local-1792239950565） |

前置条件：

- spark 端点配置 history_url
- 应用提交时开启事件日志（spark.eventLog.enabled=true），且 history server 读取同一目录

口径说明：

- history server 不记录 local 模式驱动的退出码：status 由 attempt.completed 与作业状态推导（derived），依据见 status_basis
- 未在 history 中找到：事件日志存在但未加载 → DATA_UNAVAILABLE；只有 driver 日志没有事件日志 → COLLECTION_DISABLED；都没有 → NOT_FOUND

```bash
workctl compute job get --id local-1792239950565
```

### `workctl compute log get`

读取 Spark 应用 driver 日志尾部（来自 driver 日志目录）

- 能力：`compute.log.get` v1.0.0；操作类型：**read**；适配器：spark-driver-log-dir；认证：filesystem
- 输出 Schema：[docs/schemas/compute.log.get.v1.json](../docs/schemas/compute.log.get.v1.json)；指南：[docs/guides/compute.md](../docs/guides/compute.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--job-id` | string | 是 |  | Spark application id |
| `--limit-lines` | int | 否 | `200` | 返回末尾行数（上限 2000） |

前置条件：

- spark 端点配置 driver_log_dir；提交脚本把 driver 输出落盘为 <driver_log_dir>/<app_id>.log

口径说明：

- driver 日志不是 Spark REST 接口提供的：演示环境由 spark-submit 包装脚本（tee）落盘；YARN/K8s 环境应改用对应的日志聚合适配器

```bash
workctl compute log get --job-id local-1792239950565 --limit-lines 100
```

### `workctl compute queue get`

查看计算资源队列/池的容量与占用（当前接入 Airflow pool）

- 能力：`compute.queue.get` v1.0.0；操作类型：**read**；适配器：airflow-pool；认证：airflow-basic|airflow-jwt
- 输出 Schema：[docs/schemas/compute.queue.get.v1.json](../docs/schemas/compute.queue.get.v1.json)；指南：[docs/guides/compute.md](../docs/guides/compute.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--id` | string | 是 |  | 队列/池 ID，如 demo-batch-pool |

前置条件：

- airflow 端点（pool 读权限）

口径说明：

- Airflow pool 只限制并发槽，不代表 CPU/内存；reschedule 模式的传感器等待时不占槽
- YARN 队列（容量、已用、挂起应用）为待接入能力 compute.yarn-queue.get

```bash
workctl compute queue get --id demo-batch-pool
```

### `workctl compute stage list`

列出 Spark 应用的阶段：状态、任务数/失败数、耗时、输入输出与 shuffle 字节、失败原因

- 能力：`compute.stage.list` v1.0.0；操作类型：**read**；适配器：spark-history-rest；认证：none
- 输出 Schema：[docs/schemas/compute.stage.list.v1.json](../docs/schemas/compute.stage.list.v1.json)；指南：[docs/guides/compute.md](../docs/guides/compute.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--job-id` | string | 是 |  | Spark application id |
| `--status` | enum (active/complete/pending/failed/skipped) | 否 |  | 只看某种状态的阶段 |
| `--limit` | int | 否 | `100` | 最多返回的阶段数 |

前置条件：

- spark 端点配置 history_url；应用开启事件日志

口径说明：

- duration_ms = completionTime - submissionTime（墙钟时间）；executor_run_time_ms 为所有任务执行时间之和

```bash
workctl compute stage list --job-id local-1792239950565
workctl compute stage list --job-id local-1792239950565 --status failed
```

### `workctl data lineage get`

查询表的上游或下游血缘：区分目录声明（explicit）与 SQL 推断（inferred），并标出两者一致的边

explicit 来自目录元数据的 upstream/consumers；inferred 来自产出 SQL 文件的正则解析（INSERT 目标、FROM/JOIN 来源）。未限定库名的表名不按相似名称匹配目录表。

- 能力：`data.lineage.get` v1.0.0；操作类型：**read**；适配器：file-catalog；认证：filesystem
- 输出 Schema：[docs/schemas/data.lineage.get.v1.json](../docs/schemas/data.lineage.get.v1.json)；指南：[docs/guides/data.md](../docs/guides/data.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--catalog` | string | 否 |  | 目录端点名（profile endpoints.catalog），默认取 profile defaults.catalog |
| `--table` | string | 是 |  | 表名 <database>.<table>，如 analytics.daily_orders |
| `--direction` | enum (upstream/downstream) | 否 | `"upstream"` | 方向 |
| `--depth` | int | 否 | `2` | 遍历深度 1..5 |

口径说明：

- SQL 推断基于正则，可能遗漏动态 SQL、程序中注册的临时视图和 DataFrame 读写
- 没有足够依据时不根据相似名称认定依赖关系

```bash
workctl data lineage get --catalog demo --table analytics.daily_orders --direction upstream
workctl data lineage get --catalog demo --table ods.orders --direction downstream --depth 3
```

### `workctl data partition get`

检查单个分区：是否符合分区定义、目录是否存在、数据文件、完成标记、更新时间、文件是否可读

分区不存在不是错误：返回 success 且 state=missing，便于链路检查推理；表不存在返回 NOT_FOUND。state 汇总: missing|empty|incomplete(无完成标记)|unreadable|present。

- 能力：`data.partition.get` v1.0.0；操作类型：**read**；适配器：file-catalog；认证：filesystem
- 输出 Schema：[docs/schemas/data.partition.get.v1.json](../docs/schemas/data.partition.get.v1.json)；指南：[docs/guides/data.md](../docs/guides/data.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--catalog` | string | 否 |  | 目录端点名（profile endpoints.catalog），默认取 profile defaults.catalog |
| `--table` | string | 是 |  | 表名 <database>.<table>，如 analytics.daily_orders |
| `--partition` | string | 是 |  | 分区，如 'dt=2026-10-16'（dt 为业务日期） |
| `--sample-records` | int | 否 | `20` | 每个文件实际解析的前 N 条记录（可读性抽查） |

口径说明：

- 表存在 ≠ 分区存在 ≠ 文件可读 ≠ 质量规则通过；质量规则用 data quality check
- 更新时间取完成标记或最新数据文件的 mtime（本地文件系统）

```bash
workctl data partition get --catalog demo --table analytics.daily_orders --partition 'dt=2026-10-16'
```

### `workctl data partition list`

列出表的分区目录：文件数、字节数、最后修改时间、是否有完成标记

只列目录与文件属性，不读取文件内容；可读性用 data partition get 检查。按分区值倒序，--limit 截断时标注 truncated。

- 能力：`data.partition.list` v1.0.0；操作类型：**read**；适配器：file-catalog；认证：filesystem
- 输出 Schema：[docs/schemas/data.partition.list.v1.json](../docs/schemas/data.partition.list.v1.json)；指南：[docs/guides/data.md](../docs/guides/data.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--catalog` | string | 否 |  | 目录端点名（profile endpoints.catalog），默认取 profile defaults.catalog |
| `--table` | string | 是 |  | 表名 <database>.<table>，如 analytics.daily_orders |
| `--from` | string | 否 |  | 起始分区值（含），针对第一个分区键，如 2026-10-01 |
| `--to` | string | 否 |  | 结束分区值（含） |
| `--limit` | int | 否 | `100` | 最多返回的分区数（最新的优先） |

```bash
workctl data partition list --catalog demo --table ods.orders --from 2026-10-10 --to 2026-10-16
```

### `workctl data quality check`

对单个分区执行质量规则集（行数、非空、唯一、取值、范围、结构、时效、分区存在），返回逐条结果与违规样本

--dataset 接受 <catalog>.<db>.<table>；或 <catalog>.<table>（目录中表名唯一时解析，如 demo.daily_orders → demo / analytics.daily_orders）；带 --catalog 时按 <db>.<table> 解析。分区不存在时除 partition_exists 外的规则均 skipped，总体 fail。最新结果写入状态目录供其他能力读取。

- 能力：`data.quality.check` v1.0.0；操作类型：**diagnose**；适配器：file-catalog；认证：filesystem
- 输出 Schema：[docs/schemas/data.quality.check.v1.json](../docs/schemas/data.quality.check.v1.json)；指南：[docs/guides/data.md](../docs/guides/data.md)
- 幂等：是；可取消：否
- 副作用：把最新结果写入 <state_dir>/quality/<table>/<partition>.json（本地状态，不修改数据）

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--dataset` | string | 是 |  | 数据集: <catalog>.<db>.<table> 或 <catalog>.<table>，如 demo.daily_orders |
| `--partition` | string | 是 |  | 分区，如 'dt=2026-10-16' |
| `--ruleset` | string | 否 |  | 规则集名（<rules_dir>/<name>.yaml）；默认取表元数据 quality_ruleset |
| `--sample-rows` | int | 否 |  | 只读取前 N 行做内容规则（行数规则仍全量计数）；不填则全量扫描 |
| `--catalog` | string | 否 |  | 目录端点名；指定后 --dataset 按 <db>.<table> 解析 |

口径说明：

- 抽样模式下 pass 不是结论性的（conclusive=false）；fail 总是结论性的
- 违规样本最多 5 条，敏感列脱敏
- freshness 以本地文件 mtime 为依据

```bash
workctl data quality check --dataset demo.daily_orders --partition 'dt=2026-10-16' --ruleset demo-daily-rules
```

### `workctl data table get`

查看表的目录元数据（分区语义、列、产出任务、上下游声明）与物理位置检查

元数据来自目录（explicit）；物理位置、分区数来自本地文件系统列目录（derived）。表存在不代表某个分区存在或可读。

- 能力：`data.table.get` v1.0.0；操作类型：**read**；适配器：file-catalog；认证：filesystem
- 输出 Schema：[docs/schemas/data.table.get.v1.json](../docs/schemas/data.table.get.v1.json)；指南：[docs/guides/data.md](../docs/guides/data.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--catalog` | string | 否 |  | 目录端点名（profile endpoints.catalog），默认取 profile defaults.catalog |
| `--table` | string | 是 |  | 表名 <database>.<table>，如 analytics.daily_orders |

前置条件：

- profile 配置 catalog 端点（provider/metadata_dir/warehouse_root/storage）

口径说明：

- storage 当前只支持 local-filesystem；不代表对象存储或 HDFS 已验证
- Hive Metastore 等 provider 尚未接入，见指南

```bash
workctl data table get --catalog demo --table analytics.daily_orders
```

### `workctl offline backfill get`

查看补数计划及其已触发运行的实时状态

- 能力：`offline.backfill.get` v1.0.0；操作类型：**read**；适配器：airflow-rest-v1|v2；认证：airflow-basic|airflow-jwt
- 输出 Schema：[docs/schemas/offline.backfill.get.v1.json](../docs/schemas/offline.backfill.get.v1.json)；指南：[docs/guides/offline.md](../docs/guides/offline.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--id` | string | 是 |  | 计划 ID（op-YYYYMMDD-xxxxxx） |

前置条件：

- profile 配置 airflow 端点（url、api_version v1|v2、username、password_ref）
- Airflow 2（v1）启用 basic_auth API 后端；Airflow 3（v2）由 auth manager 提供 POST /auth/token；账号具备 DAG 读权限

```bash
workctl offline backfill get --id op-20261017-abc123
```

### `workctl offline backfill plan`

生成补数计划：逐个业务日期给出现有运行、目标分区状态、动作、写入幂等性、下游影响、代码版本与并发预算（不执行）

- 能力：`offline.backfill.plan` v1.0.0；操作类型：**plan**；适配器：airflow-rest-v1|v2；认证：airflow-basic|airflow-jwt
- 输出 Schema：[docs/schemas/offline.backfill.plan.v1.json](../docs/schemas/offline.backfill.plan.v1.json)；指南：[docs/guides/offline.md](../docs/guides/offline.md)
- 幂等：否；可取消：否

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--workflow` | string | 是 |  | 工作流 ID（dag_id） |
| `--from` | string | 是 |  | 起始业务日期 YYYY-MM-DD（含） |
| `--to` | string | 是 |  | 结束业务日期 YYYY-MM-DD（含），最多 31 天 |
| `--timezone` | string | 否 |  | 业务时区（默认 airflow 端点 timezone） |
| `--rerun-succeeded` | bool | 否 | `false` | 对已成功的业务日期也重跑（清理全部任务实例） |
| `--max-active-runs` | int | 否 |  | 执行时同时在途的 run 上限（默认 min(DAG max_active_runs, 2)） |
| `--allow-append-duplicates` | bool | 否 | `false` | 目标表为 append 写入时，明确接受重跑可能产生重复数据 |

前置条件：

- profile 配置 airflow 端点（url、api_version v1|v2、username、password_ref）
- Airflow 2（v1）启用 basic_auth API 后端；Airflow 3（v2）由 auth manager 提供 POST /auth/token；账号具备 DAG 读权限
- 执行需要 profile allow_execute=true，并通过 workctl operation execute --id <plan> 确认

口径说明：

- 计划只做预览，不触发任何运行；计划预览不是执行成功的证据
- 动作：skip_succeeded（已成功且未要求重跑）、skip_in_progress（在途）、trigger_new（无 run，POST dagRuns 并显式传 data_interval）、clear_failed（只清理失败任务实例）、rerun（清理全部任务实例）
- overwrite_partition 表重跑为幂等覆盖；append 表重跑有重复风险，未显式允许时前置条件失败
- 重跑使用调度器当前解析的 DAG 代码（code_version），不是原始 run 当时的代码

```bash
workctl offline backfill plan --workflow demo-daily-orders --from 2026-10-14 --to 2026-10-16 --timezone Asia/Shanghai
```

### `workctl offline dependency list`

列出一次运行的上游/下游依赖：DAG 内任务、输入/输出数据分区、跨工作流关系，并标注每条边的来源

- 能力：`offline.dependency.list` v1.0.0；操作类型：**diagnose**；适配器：airflow-rest-v1|v2；认证：airflow-basic|airflow-jwt
- 输出 Schema：[docs/schemas/offline.dependency.list.v1.json](../docs/schemas/offline.dependency.list.v1.json)；指南：[docs/guides/offline.md](../docs/guides/offline.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--run-id` | string | 是 |  | run_id |
| `--direction` | enum (upstream/downstream) | 否 | `"upstream"` | 方向 |
| `--workflow` | string | 否 |  | 工作流 ID；省略时查找 |

前置条件：

- profile 配置 airflow 端点（url、api_version v1|v2、username、password_ref）
- Airflow 2（v1）启用 basic_auth API 后端；Airflow 3（v2）由 auth manager 提供 POST /auth/token；账号具备 DAG 读权限
- 数据依赖需要 catalog 端点（upstream/consumers）；跨工作流关系来自 resources_file 绑定

口径说明：

- 只报告平台显式记录的关系（调度元数据、目录元数据、绑定文件），不根据相似名称推断依赖

```bash
workctl offline dependency list --workflow demo-daily-orders --run-id demo__2026-10-14__missing_upstream --direction upstream
```

### `workctl offline freshness check`

按目录约定的产出时限检查数据集某业务日期是否准时：on_time / late / missing / not_due

- 能力：`offline.freshness.check` v1.0.0；操作类型：**diagnose**；适配器：file-catalog+airflow-rest-v1|v2；认证：airflow-basic|airflow-jwt
- 输出 Schema：[docs/schemas/offline.freshness.check.v1.json](../docs/schemas/offline.freshness.check.v1.json)；指南：[docs/guides/offline.md](../docs/guides/offline.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--dataset` | string | 是 |  | 数据集（目录表名 db.table），如 analytics.daily_orders |
| `--data-date` | string | 是 |  | 业务日期 YYYY-MM-DD |
| `--timezone` | string | 否 |  | 业务时区（默认取目录 freshness.timezone / 分区键时区） |

前置条件：

- catalog 端点，表元数据含 freshness.expected_by
- data 域的 data.partition.get
- （可选）airflow 端点，用于附带产出工作流的 run 状态

口径说明：

- expected_by 为业务日期 + day_offset 天在业务时区的 HH:MM；分区更新时间取 data.partition.get 返回的写入证据（成功标记或最新数据文件）
- present 以外的分区状态（empty/incomplete/unreadable）不算准时产出

```bash
workctl offline freshness check --dataset analytics.daily_orders --data-date 2026-10-16
```

### `workctl offline log get`

读取任务某次尝试的日志尾部（Airflow 任务日志）

- 能力：`offline.log.get` v1.0.0；操作类型：**read**；适配器：airflow-rest-v1|v2；认证：airflow-basic|airflow-jwt
- 输出 Schema：[docs/schemas/offline.log.get.v1.json](../docs/schemas/offline.log.get.v1.json)；指南：[docs/guides/offline.md](../docs/guides/offline.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--run-id` | string | 是 |  | run_id |
| `--task` | string | 是 |  | 任务 ID |
| `--try` | int | 否 |  | 尝试序号（默认取任务实例当前 try_number） |
| `--workflow` | string | 否 |  | 工作流 ID；省略时查找 |
| `--limit-lines` | int | 否 | `200` | 返回末尾行数（上限 2000） |

前置条件：

- profile 配置 airflow 端点（url、api_version v1|v2、username、password_ref）
- Airflow 2（v1）启用 basic_auth API 后端；Airflow 3（v2）由 auth manager 提供 POST /auth/token；账号具备 DAG 读权限

口径说明：

- 日志由 Airflow webserver 从任务日志存储读取；reschedule 模式的传感器每次 poke 都追加到同一 try 的日志
- 日志为目标系统原文，可能包含业务路径等信息，按需裁剪后再转述
- Airflow 3（REST v2）的日志接口只返回结构化 JSON：每条消息转为一行“[时间] 级别 logger - 内容”

```bash
workctl offline log get --workflow demo-daily-orders --run-id demo__2026-10-16__wrong_partition --task aggregate_orders --limit-lines 50
```

### `workctl offline run get`

查看一次运行：任务实例状态，并分层汇总调度、计算、数据产出、质量四个检查项

- 能力：`offline.run.get` v1.0.0；操作类型：**diagnose**；适配器：airflow-rest-v1|v2；认证：airflow-basic|airflow-jwt
- 输出 Schema：[docs/schemas/offline.run.get.v1.json](../docs/schemas/offline.run.get.v1.json)；指南：[docs/guides/offline.md](../docs/guides/offline.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--id` | string | 是 |  | run_id（如 manual__2026-10-16T00:00:00+08:00） |
| `--workflow` | string | 否 |  | 工作流 ID；省略时在活跃 DAG 中查找（有上限） |

前置条件：

- profile 配置 airflow 端点（url、api_version v1|v2、username、password_ref）
- Airflow 2（v1）启用 basic_auth API 后端；Airflow 3（v2）由 auth manager 提供 POST /auth/token；账号具备 DAG 读权限
- 计算层需要 Spark history server 与事件日志；产出层需要 catalog 端点与 data 域；质量层读取 data quality check 的最近结果

口径说明：

- 四个检查项分别验证：scheduler（Airflow run 状态）、compute（Spark 应用，通过任务记录的 application id 关联）、output（目标分区，经 data.partition.get）、quality（最近一次质量检查结果）
- 目标表与分区由目录元数据 produced_by 推导，分区值取 data_interval_start 在分区时区的日期

```bash
workctl offline run get --workflow demo-daily-orders --id demo__2026-10-16__wrong_partition
```

### `workctl offline run list`

按业务日期查找工作流的运行（DAG run）：业务日期映射为业务时区的数据区间并按 data_interval 匹配

- 能力：`offline.run.list` v1.0.0；操作类型：**read**；适配器：airflow-rest-v1|v2；认证：airflow-basic|airflow-jwt
- 输出 Schema：[docs/schemas/offline.run.list.v1.json](../docs/schemas/offline.run.list.v1.json)；指南：[docs/guides/offline.md](../docs/guides/offline.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--workflow` | string | 是 |  | 工作流 ID（dag_id） |
| `--data-date` | string | 是 |  | 业务日期 YYYY-MM-DD（不是启动日期） |
| `--timezone` | string | 否 |  | 业务时区（默认取 airflow 端点 timezone） |
| `--limit` | int | 否 | `20` | 最多返回的 run 数 |

前置条件：

- profile 配置 airflow 端点（url、api_version v1|v2、username、password_ref）
- Airflow 2（v1）启用 basic_auth API 后端；Airflow 3（v2）由 auth manager 提供 POST /auth/token；账号具备 DAG 读权限

口径说明：

- 业务日期 D 映射为业务时区内的半开区间 [D 00:00, D+1 00:00)；DAG run 的 data_interval 与该区间相交即纳入：exact=区间完全相同（日调度），contained=run 区间落在当天内（小时级调度），covers=run 区间覆盖当天（周/月调度），overlaps=部分重叠。run 的业务日期取 data_interval_start 在业务时区的日期，而不是 run 的启动时间。
- 手动触发且未显式传 data_interval 的 run，Airflow 按时间表推断为“logical_date 之前最近一个完整区间”，其业务日期可能比 logical_date 早一天

```bash
workctl offline run list --workflow demo-daily-orders --data-date 2026-10-16 --timezone Asia/Shanghai
```

### `workctl offline task get`

查看工作流中任务的定义：算子、重试、资源池、上下游、触发规则与超时

- 能力：`offline.task.get` v1.0.0；操作类型：**read**；适配器：airflow-rest-v1|v2；认证：airflow-basic|airflow-jwt
- 输出 Schema：[docs/schemas/offline.task.get.v1.json](../docs/schemas/offline.task.get.v1.json)；指南：[docs/guides/offline.md](../docs/guides/offline.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--workflow` | string | 是 |  | 工作流 ID（dag_id） |
| `--task` | string | 是 |  | 任务 ID（task_id） |

前置条件：

- profile 配置 airflow 端点（url、api_version v1|v2、username、password_ref）
- Airflow 2（v1）启用 basic_auth API 后端；Airflow 3（v2）由 auth manager 提供 POST /auth/token；账号具备 DAG 读权限

口径说明：

- upstream_task_ids 由同一 DAG 所有任务的 downstream_task_ids 反推（derived）
- SLA、传感器 mode/poke_interval/timeout 不在 REST 任务接口中，见 not_exposed

```bash
workctl offline task get --workflow demo-daily-orders --task aggregate_orders
```

### `workctl offline workflow get`

查看工作流（Airflow DAG）定义：调度、时区、负责人、暂停状态、代码版本、并发与参数

- 能力：`offline.workflow.get` v1.0.0；操作类型：**read**；适配器：airflow-rest-v1|v2；认证：airflow-basic|airflow-jwt
- 输出 Schema：[docs/schemas/offline.workflow.get.v1.json](../docs/schemas/offline.workflow.get.v1.json)；指南：[docs/guides/offline.md](../docs/guides/offline.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--id` | string | 是 |  | 工作流 ID（Airflow dag_id），如 demo-daily-orders |

前置条件：

- profile 配置 airflow 端点（url、api_version v1|v2、username、password_ref）
- Airflow 2（v1）启用 basic_auth API 后端；Airflow 3（v2）由 auth manager 提供 POST /auth/token；账号具备 DAG 读权限

口径说明：

- 代码版本取调度器保存的 DAG 源码（v1 GET /dagSources/{file_token}，v2 GET /dagSources/{dag_id}）内容的 sha256 与 last_parsed_time；file_token 只标识文件位置
- outputs 来自目录元数据 produced_by（catalog-metadata），不是调度器事实

```bash
workctl offline workflow get --id demo-daily-orders
```

### `workctl sql query cancel`

取消正在运行的查询（Spark：终止 spark-submit 进程组；Trino：DELETE nextUri / /v1/query/{id}）

- 能力：`sql.query.cancel` v1.0.0；操作类型：**execute**；适配器：spark-submit-local|trino-http；认证：none|trino-basic
- 输出 Schema：[docs/schemas/sql.query.cancel.v1.json](../docs/schemas/sql.query.cancel.v1.json)；指南：[docs/guides/compute.md](../docs/guides/compute.md)
- 幂等：是；可取消：是
- 副作用：Spark：向查询的 spark-submit 进程组发送 SIGTERM（5 秒后 SIGKILL）；Trino：取消协调节点上的查询

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--id` | string | 是 |  | 查询 ID |

前置条件：

- profile allow_execute=true

口径说明：

- 已结束的查询返回 CONFLICT；被终止的 Spark 应用在 history server 中显示为未完成（incomplete）
- Trino：发送 DELETE 后查询 GET /v1/query/{id} 确认 USER_CANCELED；未确认时 state=cancel_requested，如查询已先结束则如实报告

```bash
workctl sql query cancel --id q-20261017-1a2b3c
```

### `workctl sql query get`

查看已提交查询的状态、引擎侧 ID（Spark 应用 / Trino 查询）、统计、结果预览（≤ 20 行）与结果位置

- 能力：`sql.query.get` v1.0.0；操作类型：**read**；适配器：spark-submit-local|trino-http；认证：none|trino-basic
- 输出 Schema：[docs/schemas/sql.query.get.v1.json](../docs/schemas/sql.query.get.v1.json)；指南：[docs/guides/compute.md](../docs/guides/compute.md)

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--id` | string | 是 |  | 查询 ID（q-YYYYMMDD-xxxxxx） |
| `--preview-rows` | int | 否 | `20` | 预览行数（上限 20） |

前置条件：

- spark 端点配置 query_state_dir；trino 查询读取 trino 端点的状态目录

口径说明：

- state=lost 表示提交进程已退出但没有写入终态，与 failed（运行器捕获到错误）区分；Trino 下表示协调节点已不记得该查询或结果页未取完就失效
- 结果预览只是前 N 行，完整结果在 result_location（JSON lines）
- Trino：get 会继续跟随 nextUri 拉取结果页（每次最多 poll_budget_ms，默认 5 秒），succeeded 表示 Trino 报告 FINISHED 且全部结果页已取回；engine_state 为 Trino 原始状态，stats 为 Trino 统计

```bash
workctl sql query get --id q-20261017-1a2b3c
```

### `workctl sql query submit`

异步提交只读 SQL 查询到计算引擎（Spark SQL local 模式 / Trino），返回查询 ID

- 能力：`sql.query.submit` v1.0.0；操作类型：**read**（异步）；适配器：spark-submit-local|trino-http；认证：none|trino-basic
- 输出 Schema：[docs/schemas/sql.query.submit.v1.json](../docs/schemas/sql.query.submit.v1.json)；指南：[docs/guides/compute.md](../docs/guides/compute.md)
- 副作用：Spark：启动一个 Spark 应用；Trino：在协调节点创建一个查询（消耗集群资源）。结果写入本地结果目录，不写入数仓表

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--engine` | enum (spark/trino/hive) | 否 | `"spark"` | 查询引擎（hive 待接入） |
| `--file` | file | 是 |  | 只含一条 SELECT / WITH 查询的 SQL 文件 |
| `--output` | string | 否 |  | 结果目录（须不存在，且不在 warehouse_root 内；默认 <状态目录>/<id>/result） |
| `--preview-rows` | int | 否 | `20` | 状态中保留的预览行数（上限 20） |
| `--catalog` | string | 否 |  | 仅 trino：默认 catalog（X-Trino-Catalog，缺省取端点配置） |
| `--schema` | string | 否 |  | 仅 trino：默认 schema（X-Trino-Schema，缺省取端点配置） |

前置条件：

- spark 端点配置 spark_home、python、query_state_dir、warehouse_root、event_log_dir、driver_log_dir
- trino 端点配置 url、user（可选 password_ref、catalog、schema、source、query_state_dir）

口径说明：

- 只接受单条 SELECT/WITH；含 INSERT/CREATE/DROP/SET 等关键字的文件在提交前被拒绝（INVALID_ARGUMENT）
- Spark：演示环境中 warehouse_root 下每个 <db>/<table> 目录注册为临时视图 <db>_<table>（如 analytics_daily_orders），dt 分区目录成为 dt 列
- Spark：提交成功只代表进程已启动；用 sql query get 查看状态，running 表示仍在执行
- Trino：另外拒绝 EXECUTE/PREPARE/事务语句、WITH FUNCTION 内联函数和透传类表函数（如 system.query）；提交时在短时间窗口内跟随 nextUri，语法/语义错误直接返回 INVALID_ARGUMENT（表/schema/catalog 不存在为 NOT_FOUND，ACCESS_DENIED 为 PERMISSION_DENIED）
- Trino：结果页由 sql query get 继续拉取；超过 query.client.timeout（默认 5 分钟）没有客户端拉取，Trino 会以 ABANDONED_QUERY 结束查询

```bash
workctl sql query submit --engine spark --file demo/offline-workflows/sql/examples/daily_orders_by_status.sql
workctl sql query submit --engine trino --file q.sql --catalog tpch --schema tiny
```
