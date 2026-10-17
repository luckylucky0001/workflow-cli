# Agent 宿主接入（Claude Code 示例）

同一能力底座的两种 Agent 接入方式，可单独或同时使用：

| 方式 | 配置 | Agent 看到的内容 |
| --- | --- | --- |
| Skill + CLI | `workctl skills install --dir .claude/skills` | 入口 Skill（enterprise-infra）按需引导到领域/流程 Skill，Agent 通过 Bash 调用 `workctl --json ...` |
| MCP | `claude --mcp-config demo/agent-host/mcp.json` | `workctl mcp serve` 暴露的工具（由能力定义生成，默认不含 execute 类） |

## 验证 Agent 确实发现并使用了 Skill / 工具

```bash
npm run build
node dist/workctl.js skills install --dir .claude/skills      # 记录版本到 .claude/skills/.workctl-skills.json
./demo/agent-host/run-agent-demo.sh                            # 以无头模式运行三条主线，保存转录到 demo/agent-host/runs/
```

脚本对每条主线记录：Agent 调用了哪些 workctl 命令 / MCP 工具、最终回答、耗时与成本（取自宿主输出），用于 [demo/evaluation.md](../evaluation.md) 的对照记录。转录中只包含合成数据。
