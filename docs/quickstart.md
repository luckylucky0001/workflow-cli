# Quickstart

## 1. 安装

```bash
npm install -g workctl            # 或在仓库内: npm ci && npm run build && npm link
workctl --version
workctl capability list           # 能力目录：三大板块 + 待接入能力
```

需要 Node.js ≥ 20。CLI 是单文件 ESM 包（esbuild 打包），Skill 与文档随包发布（`skills/`、`docs/`）。

## 2. 配置 profile

配置文件查找顺序：`--config` → `$WORKCTL_CONFIG` → `./workctl.yaml` → `~/.config/workctl/config.yaml`。

```yaml
schema_version: "1.0"
current_profile: demo
profiles:
  demo:
    env: sandbox
    data_mode: live              # live | synthetic_fixture | recorded，会写进每个结果的 context
    allow_execute: false         # execute 类操作默认关闭
    resources_file: ./bindings.yaml
    defaults: { mysql: demo-mysql, redis: demo-redis }
    endpoints:
      mysql:
        demo-mysql:
          host: 127.0.0.1
          port: 13306
          user: workctl_ro
          password_ref: file:.runtime/secrets/mysql_ro_password   # 或 env:MYSQL_RO_PASSWORD
      redis:
        demo-redis: { host: 127.0.0.1, port: 16379 }
```

凭据只能写成 `*_ref` 引用（`env:` / `file:`），写成明文 `password:` 会被拒绝。

```bash
workctl --json auth status --probe       # 每个端点的凭据引用是否可解析、实际身份与版本
workctl --json access check --capability mysql.query.execute --target demo-mysql
```

## 3. 第一次查询

```bash
workctl --json mysql table get --instance demo-mysql --database demo --table orders
workctl --json redis info get --instance demo-redis --section memory
workctl --json offline run list --workflow demo-daily-orders --data-date 2026-10-16 --timezone Asia/Shanghai
```

所有命令输出同一信封：

```json
{
  "schema_version": "1.0",
  "status": "success",
  "capability": "mysql.table.get",
  "data": { "...": "..." },
  "error": null,
  "meta": { "sources": [{ "system": "mysql", "method": "information_schema.COLUMNS", "version": "8.4.x", "observed_at": "..." }], "coverage": { "complete": true }, "warnings": [] },
  "context": { "request_id": "req-...", "profile": "demo", "env": "sandbox", "data_mode": "live", "capability_version": "1.0.0", "...": "..." }
}
```

## 4. 给 Agent 使用

- **Skill**：`workctl skills install --dir .claude/skills`，把入口 Skill（enterprise-infra）、领域 Skill 和流程 Skill 安装到项目目录，并记录版本（`.workctl-skills.json`）。
- **MCP**：`workctl mcp serve` 以 stdio 暴露同一能力目录（默认不开放 execute）。Claude Code 配置示例见 [demo/agent-host/](../demo/agent-host/)。
- **脚本**：`import { createClient } from 'workctl'`，或直接调用 CLI 的 `--json` 输出。

## 5. 演示环境

```bash
cd demo/environment && ./up.sh          # MySQL、Redis、Kafka、Prometheus、demo-order、Airflow、Spark history
export WORKCTL_CONFIG=$PWD/workctl.yaml
./reset.sh                              # 复位（删除容器、卷和运行时状态）
```

完整演示步骤见 [demo/walkthrough.md](../demo/walkthrough.md)。
