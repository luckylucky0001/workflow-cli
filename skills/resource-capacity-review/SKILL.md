---
name: resource-capacity-review
description: 评审容器资源上限与实际使用的流程：找出未设上限、接近上限、OOM、频繁重启的容器，用时间序列区分瞬时峰值与持续压力，并结合最近发布判断变化。当用户问“资源够不够”“哪些容器没设限制”“上线/大促前容量检查”“流量翻倍扛不扛得住”“OOM 后上限怎么调”时使用（workctl capacity summary / container ... / metric query）。单个服务变慢改用 service-latency-investigation。
---

# 资源容量评审

> **调用约定**：profile/端点已由环境（`WORKCTL_CONFIG` / `--profile`）给定，直接以 `workctl` 开头调用，全局参数紧跟其后：`workctl --json <命令> ...`；不要加环境变量前缀、`cd`、管道或 `node dist/workctl.js`。命令被宿主拒绝时不要换写法绕过，说明需要授权的只读命令。

对象模型与快照/窗口语义见 `docs/guides/infrastructure.md`。

## 原则

- `capacity summary` 与 `container stats get` 是**快照**：只能说明“此刻”。容量结论需要时间序列（`metric query`）或多次快照，并写明观测时间。
- 未设上限（`no_cpu_limit` / `no_memory_limit`）不是“资源充足”，而是“无保护”：一个容器可以挤占整台主机。
- 上限合计 / 主机容量（`cpu_limit_to_host_ratio`、`memory_limit_to_host_ratio`）只统计已设上限的容器；未设上限的单独计数。
- 不预设节省比例或扩容幅度；建议必须给出依据数据和验证方式。
- 通用读结果规则见 `skills/enterprise-infra/SKILL.md` 第 4 步（快照/窗口、`COLLECTION_DISABLED`、partial）。

## 流程

### 1. 环境总览（快照）
```bash
workctl --json capacity summary --env <env>
```
记录 `host`（NCPU、内存、Docker 版本、cgroup 版本）、`totals`、每个容器的 `limits`、`usage`、`flags`。

### 2. 风险分类（事实）
| flag | 含义 | 下一步 |
|---|---|---|
| `no_cpu_limit` / `no_memory_limit` | 未设上限 | 结合用途判断是否需要限制 |
| `memory_above_80pct_of_limit` | 工作集接近内存上限 | 看趋势，确认是否持续 |
| `cpu_above_80pct_of_limit` | 采样时 CPU 接近上限 | 快照可能是瞬时值，看趋势/延迟 |
| `oom_killed_last_exit` | 上次退出因 OOM | `container event list`、`log query` 找时间与原因 |
| `auto_restarted` | 重启策略触发过重启 | 查事件与退出码 |

### 3. 单个服务的细节
```bash
workctl --json container workload get --service <svc>     # 上限、重启、OOM、started_at
workctl --json container stats get --service <svc>        # 快照：cores_used、percent_of_limit、working_set
```
多采样几次（间隔几秒）可以看出是否稳定，但仍是快照，要注明。

### 4. 趋势（窗口）
服务暴露了指标时，用 Prometheus 窗口数据：
```bash
workctl --json metric query --resource <svc> --metric request_rate --window 6h --step 1m
workctl --json metric query --resource <svc> --promql 'process_resident_memory_bytes{service="<svc>"}' --window 6h --step 1m
```
负载（请求速率）与资源使用一起看：资源上升是否伴随负载上升？没有容器级时序指标（如 cAdvisor）时，明确说明 CPU 趋势不可得。

### 5. 最近发布（解释变化）
使用量或上限在窗口内突变时，先确认是否有发布（镜像/资源配置变更），细节见 `skills/deploy-operations/SKILL.md`：
```bash
workctl --json deploy release list --service <svc> --window 7d
```
“流量翻倍扛不扛得住”这类问题：只能给出当前负载下的使用量与上限的余量（事实），线性外推是假设，须写明并建议压测验证。

### 6. 卷与磁盘
```bash
workctl --json storage volume get --id <volume>
```
`usage.size_bytes` 是守护进程本次计算的快照；`unavailable` 时不要估算。

## 报告模板

1. **事实**：每条写 命令 + 来源（`meta.sources` 的 system/method，`relation`）+ 窗口或观测时间。先写观测时间与范围（env、主机、容器数），再列风险清单：容器、flag、数值、快照还是窗口。
2. **判断与假设**：标注“已验证”或“假设”，写出依据、不确定性与验证命令。建议也属于判断：每条附依据与验证方法（如“设置内存上限 X 前，先观察 7 天 working_set 的 p99”）；线性外推是假设。
3. **下一步**：可复现的只读命令；涉及变更时只给计划 ID（计划 → 确认 → 执行 → 复核，执行须用户明确确认且 `allow_execute`）。workctl 没有调整资源上限的计划器：容量调整交既有变更/审批流程，不要声称已调整。
4. **覆盖缺口**：未采集（`COLLECTION_DISABLED`）、无权限、`partial`、保留期外/缓冲不可见、只有快照的数据。如没有容器级时序指标、metrics-server 未部署。
