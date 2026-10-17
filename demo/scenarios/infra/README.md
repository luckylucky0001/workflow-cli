# 场景：基础设施检查与受控重启

在隔离 demo 环境中演示 `skills/infra-operations` 与 `skills/resource-capacity-review` 的流程。所有命令只读，重启除外；重启走 计划 → 确认 → 执行 → 复核。

```bash
cd demo/environment && SKIP_OFFLINE=1 ./up.sh mysql redis demo-order prometheus
export WORKCTL_CONFIG=$PWD/workctl.yaml

# 1. 状态与容量（快照）
workctl container workload get --service demo-order
workctl container stats get --service demo-order
workctl capacity summary --env sandbox            # demo 中只有 demo-order 设置了 CPU/内存上限，其余会标 no_*_limit

# 2. 事件（注意 daemon_buffer_full / visible_since：健康检查 exec 事件会在几分钟内占满守护进程的事件缓冲）
workctl container event list --service demo-order --window 1h

# 3. 网络与存储
workctl network backend list --service demo-order
workctl network connectivity check --target 127.0.0.1:13306 --count 3
workctl network dns get --name localhost
workctl storage volume get --id workctl-demo_mysql-data
workctl storage file stat --path ./workctl.yaml

# 4. 受控重启
workctl container workload restart-plan --service demo-order --env sandbox    # 记下 plan id，复核 targets/impact/preconditions
workctl operation execute --id <plan> --confirm <plan>                         # profile demo 已开启 allow_execute
workctl operation get --id <plan>
workctl container event list --service demo-order --window 10m                 # 可见 kill/die/start/restart 事件
workctl container workload get --service demo-order                            # started_at 已更新
workctl network backend list --service demo-order
```

重启后 demo-order 的进程内状态（如通过 `/admin/cache-mode` 注入的 bypass）恢复为启动配置 `CACHE_MODE=normal`。
