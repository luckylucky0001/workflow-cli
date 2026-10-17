# demo/agent-host/runs/A-infra.k8s.json

- 工具调用次数：6；workctl 调用：5
- 耗时：25327 ms；宿主报告成本：0.2586793 USD；轮次：7；结束状态：success

## 调用序列

1. `ToolSearch: {"query":"select:mcp__workctl__resource_get,mcp__workctl__service_dependency_list,mcp__workctl__container_workload_get,mcp__workctl__container_event_list,mcp__w`
1. `MCP: resource_list {"service":"demo-order","env":"sandbox"}`
1. `MCP: service_dependency_list {"service":"demo-order","env":"sandbox","depth":3}`
1. `MCP: container_workload_get {"service":"demo-order","env":"sandbox"}`
1. `MCP: container_event_list {"service":"demo-order","env":"sandbox","window":"6h"}`
1. `MCP: container_stats_get {"service":"demo-order","env":"sandbox"}`

## 最终回答

demo-order(sandbox)运行在 k3s 集群上,2 个 Pod 都健康,没有重启或 OOM。以下都是只读查询,没做任何变更。

## 运行位置
- **服务**:`demo-order`,env=sandbox,owner=team-demo。
- **绑定关系**:`demo-order` 通过 `runs_on` 指向 `demo-order-k8s`(container.workload)。依据是绑定文件 `demo/environment/k8s/bindings.k8s.yaml`,标签是 `app=demo-order`。
- **集群**:k3s v1.31.4+k3s1,节点 `vm`,命名空间 `workctl-demo`,工作负载是 Deployment `demo-order`。
- **镜像**:`nginx:1.27-alpine`,通过 ConfigMap `demo-order-html` 挂载静态页。

## 依赖
- 下游依赖(深度 3):只有 `demo-order-k8s` 一项。
- 上游依赖方:没有。
- **没有任何 MySQL、Redis 或 MQ 依赖。** 绑定文件里没有声明,工具也不会按名称推断。运行时的真实调用关系需要用 trace 或日志另行验证。

## 实例状态
Deployment 期望 2 副本,2 个就绪、2 个可用、2 个已更新。

| Pod | IP | 状态 | 重启次数 | OOM |
|---|---|---|---|---|
| demo-order-6fd6cc6545-7jcmp | 10.42.0.9 | Running / Ready / healthy | 0 | 否 |
| demo-order-6fd6cc6545-ccbg4 | 10.42.0.10 | Running / Ready / healthy | 0 | 否 |

两个 Pod 都是 Burstable,启动于 14:06:55–57Z。

## 近期事件
查询窗口是 6h,但 Kubernetes 事件只保留 1h,所以只覆盖到 13:28Z 之后,窗口并不完整。

- 14:05:44Z:旧 ReplicaSet `5f6b55b9d8` 扩到 2 个副本。
- 14:06:33–57Z:发生一次滚动更新,先经过 `78c648487c`,最终换成 `6fd6cc6545`。旧副本逐步缩到 0,新 Pod 完成调度、拉取、创建和启动。
- 事件全部是 Normal 类型,没有 BackOff、Killing、Unhealthy 或 OOM。

滚动更新之前的历史事件已经过了保留期,看不到。

## 资源使用
这是 metrics-server 的快照,不代表一段时间内的趋势。

| Pod | CPU | 内存 |
|---|---|---|
| 7jcmp | 约 0.0001 核,限额 0.5 核的 0.01% | 4.75 MB,限额 128 MiB 的 3.5% |
| ccbg4 | 约 0.0001 核,限额 0.5 核的 0.02% | 4.51 MB,限额 128 MiB 的 3.4% |

- 每个容器 requests 是 0.1 核 / 32 MiB,limits 是 0.5 核 / 128 MiB。
- 进程数、网络和块 I/O 在 Kubernetes 下不提供,所以没有这几项数据。

## 结论
没有发现异常。资源基本空闲,上限也有设置。如果还想看延迟或错误率趋势,可以再查 metric 和日志。
