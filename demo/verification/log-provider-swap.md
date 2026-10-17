# 日志 provider 替换对照：Docker 容器日志 ↔ Loki（Promtail 采集）

生成时间 2026-10-17T15:06:29.329Z，命令 `node demo/scenarios/reuse/log-provider-swap.mjs`（真实调用：同一个 demo-order 容器，同一批请求）。
docker = `demo/environment/workctl.yaml`（profile demo，默认 provider，Docker Engine API 读 json-file 日志）；loki = `demo/environment/workctl.loki.yaml`（profile demo，`defaults.logs: loki`，Loki @ 127.0.0.1:13100，Promtail docker_sd_configs 推送）。
实际版本：Docker Engine 29.8.2 (API 1.56)；Loki 3.5.5（/loki/api/v1/status/buildinfo）；Promtail 3.5.5（promtail -version）。
流量：loadgen.mjs --rps 10 --duration 15（2026-10-17T15:06:10.449Z 起，退出码 0）。入库等待：流量结束后 Docker 最新 access 日志 2026-10-17T15:06:25.671001200Z；开始等待后 871ms（含查询耗时）Loki 最新 access 日志为 2026-10-17T15:06:25.671001200Z，已追上；之后再等 1.5s。两边每个用例同时调用，窗口同为“截至当前”。

| 用例 | 状态 docker / loki | 适配器 · 实际版本 | schema 均通过 | 顶层 data 键一致 | 条目数 docker / loki | 统计 docker/loki | 重合 | 截断/完整 docker / loki |
|---|---|---|---|---|---|---|---|---|
| `log.query` window 10m, oldest, limit 2000 | success / success | docker-engine-api · 29.8.2 (API 1.56) / loki-http-api · 3.5.5 | yes | yes | 604 / 604 | scanned 1991/1991, matched 604/604, spans_skipped 1387/1387 | trace_id 590/590；同 ts+msg 条目 604 | false / false |
| `log.query` newest, limit 20（截断） | success / success | docker-engine-api · 29.8.2 (API 1.56) / loki-http-api · 3.5.5 | yes | yes | 20 / 20 | scanned 1991/1991, matched 604/604, spans_skipped 1387/1387 | trace_id 20/20；同 ts+msg 条目 20 | true / true |
| `log.query` --contains "request completed" | success / success | docker-engine-api · 29.8.2 (API 1.56) / loki-http-api · 3.5.5 | yes | yes | 590 / 590 | scanned 1991/1991, matched 590/590, spans_skipped 1387/1387 | trace_id 590/590；同 ts+msg 条目 590 | false / false |
| `log.query` --level warn | success / success | docker-engine-api · 29.8.2 (API 1.56) / loki-http-api · 3.5.5 | yes | yes | 3 / 3 | scanned 1991/1991, matched 3/3, spans_skipped 1387/1387 | trace_id 0/0；同 ts+msg 条目 3 | false / false |
| `log.query` --trace-id --include-spans | success / success | docker-engine-api · 29.8.2 (API 1.56) / loki-http-api · 3.5.5 | yes | yes | 6 / 6 | scanned 1991/1991, matched 6/6, spans_skipped 0/0 | trace_id 1/1；同 ts+msg 条目 6 | false / false |
| `trace.get` trace b7eb31fc… | success / success | docker-engine-api · 29.8.2 (API 1.56) / loki-http-api · 3.5.5 | yes | yes | spans 5 / 5 | duration_ms 471.616/471.616, lines_scanned 1991/1991 | span 树相同（span_id/parent/depth/self_ms）；roots ["df58acef428c1551"] / ["df58acef428c1551"] | complete true / true |
| `trace.get` trace af613938…（不指定 --service） | success / success | docker-engine-api · 29.8.2 (API 1.56) / loki-http-api · 3.5.5 | yes | yes | spans 2 / 2 | duration_ms 1.202/1.202, lines_scanned 1991/1991 | span 树相同（span_id/parent/depth/self_ms）；roots ["e136869a9a873993"] / ["e136869a9a873993"] | complete true / true |

## 口径差异（同一契约内）

- 入库延迟：Loki 只能看到 Promtail 已推送的日志（demo batchwait=1s）；窗口末尾刚写入的行 Docker 能读到、Loki 可能还没有，条目数可能差几行。
- `stats.lines_scanned / unparsed_lines / spans_skipped`：Docker 是逐行扫描计数；Loki 来自 `count_over_time` 统计查询（同一窗口），窗口边界（Loki 区间 (end-w, end]，query_range [start, end)）可能差一两行。
- `containers[]`：Loki 按流（container + container_id 标签）给出，`created_at` 为空、`log_driver` 为 null（Loki 不含容器元数据）；容器被重建后 Loki 仍保留旧容器的日志（Docker 直读看不到），会出现同名不同 id 的行。
- `limit`：两边都返回窗口内最新/最早的 limit 条；Loki 用 `limit+1` 判断截断，截断时 `matched` 与 `by_level` 来自统计查询。
- 保留期：Docker 取决于 json-file 轮转（demo-order max-size=20m × 5）；Loki 取决于 retention_period / max_query_lookback（demo 72h），超出时写入 coverage.notes。

**结论：所有用例在两个 provider 下输出同一契约（状态、schema、顶层字段一致），差异只在适配器、来源（meta.sources）与 provider 相关的 coverage 说明。**
