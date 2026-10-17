import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { CLI_VERSION, kebab } from '../core/engine';
import { EnvelopeSchema, ERROR_CODES } from '../core/output';
import { describeCapability, outputSchemaPath, type CapabilityDef, type Registry } from '../core/registry';

const PILLARS: Record<string, string> = {
  infrastructure: '基础设施',
  middleware: '中间件',
  offline: '离线链路',
  supporting: '辅助协同',
  core: '核心（发现、资源、身份、操作）',
};
const PILLAR_ORDER = ['core', 'infrastructure', 'middleware', 'offline', 'supporting'];
const STATUS_LABEL: Record<string, string> = { available: '已支持', requires_auth: '需授权', planned: '待接入' };

function esc(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function inputsTable(c: CapabilityDef): string[] {
  const rows = Object.entries(c.inputs);
  if (!rows.length) return ['无参数。', ''];
  return [
    '| 参数 | 类型 | 必填 | 默认 | 说明 |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map(([k, v]) => `| \`--${kebab(k)}\` | ${v.type}${v.enum ? ` (${v.enum.join('/')})` : ''} | ${v.required ? '是' : '否'} | ${v.default !== undefined ? `\`${JSON.stringify(v.default)}\`` : ''} | ${esc(v.description)} |`),
    '',
  ];
}

/** Generate catalog, command reference and JSON Schemas from the single source of truth (capability definitions). */
export function generateDocs(registry: Registry, outDir: string): { files: string[]; capabilities: number; planned: number } {
  const files: string[] = [];
  const write = (rel: string, content: string) => {
    const full = join(outDir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content.endsWith('\n') ? content : `${content}\n`);
    files.push(join(outDir, rel));
  };
  const caps = registry.list();
  const domains = [...registry.domains.values()];
  const byDomain = (d: string) => caps.filter((c) => c.domain === d);

  // ---- capability catalog ----
  const cat: string[] = [
    '# 能力目录',
    '',
    `> 由 \`workctl docs generate\` 从能力定义自动生成（workctl ${CLI_VERSION}），请勿手工编辑。运行时目录：\`workctl --json capability list\`。`,
    '',
    '状态说明：**已支持** = 有适配器实现、可调用；**需授权** = 可调用但需要额外授权；**待接入** = 列入能力全景、尚无适配器，不生成可调用命令。插件提供的能力在安装后出现在运行时目录中。',
    '',
    `| 板块 | 已支持 | 待接入 |`,
    '| --- | --- | --- |',
  ];
  for (const p of PILLAR_ORDER) {
    const ds = domains.filter((d) => d.pillar === p).map((d) => d.name);
    const cs = caps.filter((c) => ds.includes(c.domain));
    if (!cs.length) continue;
    cat.push(`| ${PILLARS[p]} | ${cs.filter((c) => c.status !== 'planned').length} | ${cs.filter((c) => c.status === 'planned').length} |`);
  }
  cat.push('');
  for (const p of PILLAR_ORDER) {
    const ds = domains.filter((d) => d.pillar === p && byDomain(d.name).length);
    if (!ds.length) continue;
    cat.push(`## ${PILLARS[p]}`, '');
    for (const d of ds) {
      cat.push(`### ${d.title}（\`${d.name}\`）`, '', `${d.summary}。指南：[${d.guide}](../${d.guide})${d.skill ? `；Skill：\`${d.skill}\`` : ''}`, '');
      cat.push('| 能力 | 命令 | 操作 | 状态 | 适配器 | 版本 |', '| --- | --- | --- | --- | --- | --- |');
      for (const c of byDomain(d.name)) {
        cat.push(`| \`${c.name}\` | \`workctl ${c.command}\` | ${c.operation} | ${STATUS_LABEL[c.status]} | ${esc(c.adapter)} | ${c.capability_version} |`);
      }
      cat.push('');
    }
  }
  write('capability-catalog.md', cat.join('\n'));

  // ---- command reference ----
  const ref: string[] = [
    '# 命令参考',
    '',
    `> 由 \`workctl docs generate\` 自动生成（workctl ${CLI_VERSION}）。每个命令的帮助：\`workctl <command> --help\`。`,
    '',
    '## 全局选项',
    '',
    '| 选项 | 说明 |',
    '| --- | --- |',
    '| `--json` / `-o json\\|yaml\\|text` | 输出格式；`--json` 输出统一结果信封 |',
    '| `--profile <name>` | 选择 profile（环境、端点、凭据引用、执行授权） |',
    '| `--config <path>` | 配置文件路径 |',
    '| `--timeout <duration>` | 调用时间预算（默认 30s）；采样类命令需大于采样窗口 |',
    '| `--request-id <id>` | 指定请求 ID |',
    '| `--fail-on-partial` | 部分结果以退出码 10 结束 |',
    '',
    '## 结果信封',
    '',
    '```text',
    'schema_version  契约版本',
    'status          success | partial | error（调用状态；业务状态在 data 中，如 data.state）',
    'capability      能力名',
    'data            领域数据（Schema 见 docs/schemas/<capability>.v1.json）',
    'error           { code, message, hint?, retryable, details? } | null',
    'meta.sources    来源系统、适配器、方法、观测时间、实际版本、关系类型（explicit/inferred/derived/sampled）',
    'meta.coverage   覆盖范围：complete、sampled、truncated、window、notes',
    'meta.warnings   警告',
    'context         request_id、profile、env、data_mode、capability_version、adapter、operation、耗时',
    '```',
    '',
    '## 错误码与退出码',
    '',
    '| 错误码 | 退出码 | 可重试 | 含义 |',
    '| --- | --- | --- | --- |',
    ...Object.entries(ERROR_CODES).map(([k, v]) => `| \`${k}\` | ${v.exit} | ${v.retryable ? '是' : '否'} | ${v.summary} |`),
    '| (status=partial) | 0 / 10 | - | 部分结果；`--fail-on-partial` 时退出码 10 |',
    '',
  ];
  const available = caps.filter((c) => c.status !== 'planned');
  for (const p of PILLAR_ORDER) {
    const ds = domains.filter((d) => d.pillar === p).map((d) => d.name);
    const cs = available.filter((c) => ds.includes(c.domain));
    if (!cs.length) continue;
    ref.push(`## ${PILLARS[p]}`, '');
    for (const c of cs) {
      const d = describeCapability(c);
      ref.push(`### \`workctl ${c.command}\``, '', c.summary, '');
      if (c.description) ref.push(c.description, '');
      ref.push(
        `- 能力：\`${c.name}\` v${c.capability_version}；操作类型：**${c.operation}**${c.async ? '（异步）' : ''}；适配器：${c.adapter}；认证：${c.auth_provider}`,
        `- 输出 Schema：${outputSchemaPath(c) ? `[${outputSchemaPath(c)}](../${outputSchemaPath(c)})` : '无'}；指南：[${c.guide}](../${c.guide})`,
      );
      if (d.idempotent !== undefined) ref.push(`- 幂等：${d.idempotent ? '是' : '否'}；可取消：${c.cancellable ? '是' : '否'}`);
      if (c.side_effects) ref.push(`- 副作用：${c.side_effects}`);
      ref.push('', ...inputsTable(c));
      if (c.prerequisites?.length) ref.push('前置条件：', '', ...c.prerequisites.map((x) => `- ${x}`), '');
      if (c.notes?.length) ref.push('口径说明：', '', ...c.notes.map((x) => `- ${x}`), '');
      if (c.examples?.length) ref.push('```bash', ...c.examples, '```', '');
    }
  }
  write('command-reference.md', ref.join('\n'));

  // ---- schemas ----
  write('schemas/envelope.v1.json', JSON.stringify(z.toJSONSchema(EnvelopeSchema, { unrepresentable: 'any' }), null, 2));
  for (const c of caps) {
    const s = registry.outputJsonSchema(c);
    const path = outputSchemaPath(c);
    if (s && path) write(path.replace(/^docs\//, ''), JSON.stringify({ $id: path, title: `${c.name} data`, ...s }, null, 2));
  }
  write('capabilities.json', JSON.stringify({ cli_version: CLI_VERSION, capabilities: caps.map(describeCapability), domains: domains.map(({ name, title, summary, pillar, guide, skill }) => ({ name, title, summary, pillar, guide, skill: skill ?? null })) }, null, 2));
  return { files, capabilities: available.length, planned: caps.length - available.length };
}
