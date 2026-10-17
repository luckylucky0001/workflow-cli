---
name: resource-capacity-review
description: 评审容器资源上限与实际使用的流程：找出未设上限、接近上限、OOM、频繁重启的容器，用时间序列区分瞬时峰值与持续压力，并结合最近发布判断变化。当用户问“资源够不够”“哪些容器没设限制”“上线/大促前容量检查”“流量翻倍扛不扛得住”“OOM 后上限怎么调”时使用（workctl capacity summary / container ... / metric query）。单个服务变慢改用 service-latency-investigation。
---

# 资源容量评审

对象模型与快照/窗口语义见 `docs/guides/infrastructure.md`。所有命令加 `--json`。

## 原则

- `capacity summary` 与 `container stats get` 是**快照**：只能说明“此刻”。容量结论需要时间序列（`metric query`）或多次快照，并写明观测时间。
- 未设上限（`no_cpu_limit` / `no_memory_limit`）不是“资源充足”，而是“无保护”：一个容器可以挤占整台主机。
- 上限合计 / 主机容量（`cpu_limit_to_host_ratio`、`memory_limit_to_host_ratio`）只统计已设上限的容器；未设上限的单独计数。
- 不预设节省比例或扩容幅度；建议必须给出依据数据和验证方式。

## 流程

### 1. 环境总览（快照）
```bash
workctl capacity summary --env <env>
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
workctl container workload get --service <svc>     # 上限、重启、OOM、started_at
workctl container stats get --service <svc>        # 快照：cores_used、percent_of_limit、working_set
```
多采样几次（间隔几秒）可以看出是否稳定，但仍是快照，要注明。

### 4. 趋势（窗口）
服务暴露了指标时，用 Prometheus 窗口数据：
```bash
workctl metric query --resource <svc> --metric request_rate --window 6h --step 1m
workctl metric query --resource <svc> --promql 'process_resident_memory_bytes{service="<svc>"}' --window 6h --step 1m
```
负载（请求速率）与资源使用一起看：资源上升是否伴随负载上升？没有容器级时序指标（如 cAdvisor）时，明确说明 CPU 趋势不可得。

### 5. 最近发布（解释变化）
使用量或上限在窗口内突变时，先确认是否有发布（镜像/资源配置变更），细节见 `skills/deploy-operations/SKILL.md`：
```bash
workctl deploy release list --service <svc> --window 7d
```
“流量翻倍扛不扛得住”这类问题：只能给出当前负载下的使用量与上限的余量（事实），线性外推是假设，须写明并建议压测验证。

### 6. 卷与磁盘
```bash
workctl storage volume get --id <volume>
```
`usage.size_bytes` 是守护进程本次计算的快照；`unavailable` 时不要估算。

## 输出格式

1. 观测时间与范围（env、主机、容器数）。
2. 风险清单：容器、flag、数据（快照/窗口）、来源。
3. 建议：每条附依据与验证方法（如“设置内存上限 X 前，先观察 7 天 working_set 的 p99”）。容量调整属于变更，走计划与审批流程。
4. 缺口：哪些数据只有快照、哪些指标未采集。
