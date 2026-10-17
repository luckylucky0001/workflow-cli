import { Command, CommanderError, Option } from 'commander';
import { CLI_VERSION, invoke, kebab, newRequestId } from '../core/engine';
import { ERROR_CODES, exitCodeFor, render, SCHEMA_VERSION, WorkError, type Envelope } from '../core/output';
import { describeCapability, outputSchemaPath, type CapabilityDef, type Registry } from '../core/registry';
import { checkTimeoutBudget, parseDuration } from '../core/runtime';
import { installPlugin, listInstalled, loadPlugins, removePlugin, validatePlugin } from '../core/plugins';
import { builtinRegistry } from '../domains';
import { generateDocs } from './docsgen';
import { installSkills, listSkills, skillsStatus } from './skills';

interface GlobalOpts {
  json?: boolean;
  output?: 'json' | 'yaml' | 'text';
  profile?: string;
  config?: string;
  timeout?: string;
  requestId?: string;
  debug?: boolean;
  failOnPartial?: boolean;
}

function camel(s: string): string {
  return s.replace(/[-_]([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function formatOf(g: GlobalOpts): 'json' | 'yaml' | 'text' {
  if (g.json) return 'json';
  return g.output ?? 'text';
}

function emit(env: Envelope, g: GlobalOpts): void {
  process.stdout.write(render(env, formatOf(g)) + '\n');
  process.exitCode = exitCodeFor(env, g.failOnPartial);
}

/** Envelope for CLI-level failures (bad flags, local management commands). */
function localEnvelope(capability: string, data: unknown, error: WorkError | null, startedAt: number, requestId = newRequestId()): Envelope {
  return {
    schema_version: SCHEMA_VERSION,
    status: error ? 'error' : 'success',
    capability,
    data: error ? null : data,
    error: error
      ? { code: error.code, message: error.message, ...(error.hint ? { hint: error.hint } : {}), retryable: ERROR_CODES[error.code].retryable, ...(error.details ? { details: error.details } : {}) }
      : null,
    meta: { sources: [], coverage: null, warnings: [] },
    context: {
      request_id: requestId,
      profile: null,
      env: null,
      data_mode: null,
      capability_version: null,
      adapter: null,
      operation: null,
      cli_version: CLI_VERSION,
      started_at: new Date(startedAt).toISOString(),
      duration_ms: Date.now() - startedAt,
    },
  };
}

/** Descriptions for command groups that are not a domain name. */
const GROUP_DESCRIPTIONS: Record<string, string> = {
  access: '授权检查：调用某能力前的前置条件（执行授权、端点、凭据、目标系统身份）',
  auth: '身份：当前 profile 的认证方式与凭据引用状态',
  capability: '能力发现：能力目录、单个能力定义与输出 Schema',
  capacity: '容量盘点：容器资源限制与当前使用（快照）',
  log: '日志：按服务和时间窗口查询结构化日志',
  metric: '指标：按资源和指标名查询时间序列（Prometheus）',
  trace: '调用链：按 trace ID 重建请求调用树',
  operation: '受控操作：生成计划、查看状态、执行与取消',
  resource: '资源目录：已绑定资源及其关系',
  service: '服务：依赖资源与被依赖关系',
};

function capabilityHelp(c: CapabilityDef): string {
  const d = describeCapability(c);
  const lines = [
    '',
    `能力: ${c.name}  (v${c.capability_version}, ${c.status})`,
    `操作类型: ${c.operation}${c.async ? ' / 异步' : ''}    适配器: ${c.adapter}    认证: ${c.auth_provider}`,
    `输出 Schema: ${outputSchemaPath(c) ?? '(无)'}    指南: ${c.guide}`,
  ];
  if (c.prerequisites?.length) lines.push('前置条件:', ...c.prerequisites.map((p) => `  - ${p}`));
  if (c.notes?.length) lines.push('口径说明:', ...c.notes.map((n) => `  - ${n}`));
  if (c.examples?.length) lines.push('示例:', ...c.examples.map((e) => `  ${e}`));
  if (d.side_effects) lines.push(`副作用: ${d.side_effects}`);
  lines.push('', '输出为统一信封（--json）：status / data / error / meta{sources,coverage,warnings} / context');
  return lines.join('\n');
}

/**
 * Long flags of the global options. Commander recognises program options anywhere on
 * the command line, so a capability input with the same name (e.g. sql query submit
 * --output <dir>) would be swallowed by the global option. Such inputs are registered
 * as `--input-<flag>` and `--<flag>` after the subcommand is rewritten to it.
 */
const GLOBAL_LONG_FLAGS = new Set(['output', 'profile', 'config', 'timeout', 'json', 'debug', 'request-id', 'fail-on-partial', 'version', 'help']);

export function inputFlag(name: string): string {
  const f = kebab(name);
  return GLOBAL_LONG_FLAGS.has(f) ? `input-${f}` : f;
}

/** Rewrite `--<flag>` tokens that follow a capability command when the flag is one of its shadowed inputs. */
export function rewriteShadowedFlags(argv: string[], registry: Registry): string[] {
  const head = argv.slice(0, 2);
  const tokens = argv.slice(2);
  for (const c of registry.list()) {
    if (c.status === 'planned' || !c.handler) continue;
    const shadowed = Object.keys(c.inputs).map(kebab).filter((f) => GLOBAL_LONG_FLAGS.has(f));
    if (!shadowed.length) continue;
    const words = c.command.split(' ');
    for (let i = 0; i + words.length <= tokens.length; i++) {
      if (!words.every((w, k) => tokens[i + k] === w)) continue;
      const start = i + words.length;
      const out = tokens.slice(0, start);
      for (let k = start; k < tokens.length; k++) {
        const t = tokens[k];
        if (t === '--') {
          out.push(...tokens.slice(k));
          break;
        }
        const m = /^--([a-z][a-z0-9-]*)(=.*)?$/.exec(t);
        out.push(m && shadowed.includes(m[1]) ? `--input-${m[1]}${m[2] ?? ''}` : t);
      }
      return [...head, ...out];
    }
  }
  return argv;
}

function addCapabilityCommand(root: Command, registry: Registry, c: CapabilityDef, groups: Map<string, Command>): void {
  const parts = c.command.split(' ');
  let parent = root;
  for (let idx = 0; idx < parts.length - 1; idx++) {
    const key = parts.slice(0, idx + 1).join(' ');
    let g = groups.get(key);
    if (!g) {
      const domain = idx === 0 ? registry.domains.get(parts[0]) : undefined;
      g = parent.command(parts[idx]).description(domain ? `${domain.title}：${domain.summary}` : GROUP_DESCRIPTIONS[key] ?? `${key} 相关命令`);
      g.helpCommand(false);
      groups.set(key, g);
    }
    parent = g;
  }
  const cmd = parent.command(parts[parts.length - 1]).description(c.summary);
  for (const [name, spec] of Object.entries(c.inputs)) {
    const flag = inputFlag(name);
    const shadowNote = flag !== kebab(name) ? `（写在子命令之后的 --${kebab(name)} 即此参数）` : '';
    const desc = `${spec.description}${spec.required ? '（必填）' : ''}${spec.default !== undefined ? ` [默认 ${JSON.stringify(spec.default)}]` : ''}${shadowNote}`;
    if (spec.type === 'bool') {
      if (spec.default === true) cmd.addOption(new Option(`--no-${flag}`, `关闭: ${desc}`));
      else cmd.addOption(new Option(`--${flag}`, desc));
    } else if (spec.type === 'list') {
      cmd.addOption(new Option(`--${flag} <value>`, `${desc}（可重复）`).argParser((v: string, prev?: string[]) => [...(prev ?? []), v]));
    } else {
      const o = new Option(`--${flag} <value>`, desc);
      if (spec.enum) o.choices(spec.enum);
      cmd.addOption(o);
    }
  }
  cmd.addHelpText('after', capabilityHelp(c));
  cmd.action(async (_opts: Record<string, unknown>, command: Command) => {
    const g = command.optsWithGlobals() as GlobalOpts & Record<string, unknown>;
    const raw: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(c.inputs)) {
      const v = g[camel(inputFlag(name))];
      if (spec.type === 'bool' && spec.default === true) {
        raw[name] = v === false ? false : undefined;
      } else raw[name] = v;
    }
    let timeoutMs = 30_000;
    try {
      if (g.timeout) timeoutMs = parseDuration(g.timeout);
    } catch (e) {
      emit(localEnvelope(c.name, null, e as WorkError, Date.now()), g);
      return;
    }
    const env = await invoke(registry, c.name, raw, { configPath: g.config, profile: g.profile, timeoutMs, requestId: g.requestId, debug: g.debug });
    emit(env, g);
  });
}

export function buildProgram(registry: Registry, pluginErrors: string[] = [], quietErrors = false): Command {
  const program = new Command('workctl');
  // Set before subcommands are created so every nested command inherits them.
  program.exitOverride();
  program.configureOutput({
    writeErr: (s) => {
      if (!quietErrors) process.stderr.write(s);
    },
  });
  program
    .description('企业基础设施、中间件与离线链路的统一 Agent 能力 CLI（能力目录: workctl capability list）')
    .version(CLI_VERSION, '-V, --version')
    .option('--json', '以 JSON 信封输出（等价于 -o json）')
    .addOption(new Option('-o, --output <format>', '输出格式').choices(['json', 'yaml', 'text']))
    .option('--profile <name>', '使用的 profile（默认取配置中的 current_profile）')
    .option('--config <path>', '配置文件路径（默认 $WORKCTL_CONFIG、./workctl.yaml、~/.config/workctl/config.yaml）')
    .option('--timeout <duration>', '调用时间预算，如 30s、2m', '30s')
    .option('--request-id <id>', '指定请求 ID，便于跨系统追踪')
    .option('--fail-on-partial', '结果不完整（status=partial）时以退出码 10 结束')
    .option('--debug', '向 stderr 输出调试信息');
  program.helpCommand(false);
  program.addHelpText(
    'after',
    [
      '',
      '三大能力板块：基础设施（container/network/storage/metric/log/trace）、中间件（mysql/redis/mq 插件）、离线链路（offline/compute/sql/data）',
      '发现能力:  workctl capability list [--domain mysql]    查看定义: workctl capability get --name mysql.table.get',
      '退出码:    0 成功  2 参数  3 认证  4 权限  5 不存在  6 上游不可用/超时  7 未采集/无数据  8 未配置/待接入/不支持  9 前置条件/冲突  10 部分结果(--fail-on-partial)',
    ].join('\n'),
  );
  if (pluginErrors.length) program.addHelpText('after', `\n插件加载问题:\n${pluginErrors.map((e) => `  - ${e}`).join('\n')}`);

  const groups = new Map<string, Command>();
  for (const c of registry.list()) {
    if (c.status === 'planned' || !c.handler) continue;
    addCapabilityCommand(program, registry, c, groups);
  }

  // --- local management commands (not capabilities: they only change workctl's own installation) ---
  const plugin = groups.get('plugin') ?? program.command('plugin').description('插件管理：安装、列出、校验、移除扩展能力');
  plugin.helpCommand(false);
  plugin
    .command('install')
    .description('安装插件包（.tgz），校验清单、入口、Schema 与命名冲突后加入能力目录')
    .requiredOption('--file <path>', '插件包路径')
    .action((o: { file: string }, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      const t = Date.now();
      try {
        const { plugin: p, manifest, replaced } = installPlugin(o.file, registry);
        emit(
          localEnvelope('plugin.install', {
            name: p.name,
            version: p.version,
            replaced_version: replaced,
            backend_mode: p.backend_mode,
            dir: p.dir,
            domain: manifest.domain.name,
            capabilities: manifest.capabilities.map((c) => ({ name: c.name, command: c.command, status: c.status })),
            next: [`workctl --json capability list --domain ${manifest.domain.name}`],
          }, null, t),
          g,
        );
      } catch (e) {
        emit(localEnvelope('plugin.install', null, e instanceof WorkError ? e : new WorkError('INTERNAL', String(e)), t), g);
      }
    });
  plugin
    .command('list')
    .description('列出已安装插件（版本、后端模式、来源包）')
    .action((_o: unknown, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      emit(localEnvelope('plugin.list', { plugins: listInstalled(), load_errors: pluginErrors }, null, Date.now()), g);
    });
  plugin
    .command('validate')
    .description('校验一个已解压的插件目录（开发插件时使用）')
    .requiredOption('--dir <path>', '插件目录')
    .action((o: { dir: string }, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      const t = Date.now();
      try {
        const { manifest, problems } = validatePlugin(o.dir, registry, o.dir);
        emit(localEnvelope('plugin.validate', { name: manifest.name, version: manifest.version, valid: problems.length === 0, problems }, null, t), g);
      } catch (e) {
        emit(localEnvelope('plugin.validate', null, e instanceof WorkError ? e : new WorkError('INTERNAL', String(e)), t), g);
      }
    });
  plugin
    .command('remove')
    .description('移除插件')
    .requiredOption('--name <name>', '插件名')
    .action((o: { name: string }, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      const t = Date.now();
      try {
        emit(localEnvelope('plugin.remove', { removed: removePlugin(o.name) }, null, t), g);
      } catch (e) {
        emit(localEnvelope('plugin.remove', null, e instanceof WorkError ? e : new WorkError('INTERNAL', String(e)), t), g);
      }
    });

  const skills = program.command('skills').description('Skill 分发：列出随 CLI 版本发布的 Skill，安装到项目目录');
  skills.helpCommand(false);
  skills
    .command('list')
    .description('列出随当前 CLI 版本发布的 Skill')
    .action((_o: unknown, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      const t = Date.now();
      try {
        emit(localEnvelope('skills.list', listSkills(), null, t), g);
      } catch (e) {
        emit(localEnvelope('skills.list', null, e instanceof WorkError ? e : new WorkError('INTERNAL', String(e)), t), g);
      }
    });
  skills
    .command('install')
    .description('把 Skill 安装到项目目录（如 .claude/skills），记录版本以便检查更新与回退')
    .requiredOption('--dir <path>', '目标目录，如 .claude/skills')
    .option('--name <name>', '只安装指定 Skill（可重复）', (v: string, prev?: string[]) => [...(prev ?? []), v])
    .option('--force', '覆盖已存在且版本不同的 Skill')
    .action((o: { dir: string; name?: string[]; force?: boolean }, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      const t = Date.now();
      try {
        emit(localEnvelope('skills.install', installSkills(o.dir, o.name, !!o.force), null, t), g);
      } catch (e) {
        emit(localEnvelope('skills.install', null, e instanceof WorkError ? e : new WorkError('INTERNAL', String(e)), t), g);
      }
    });

  skills
    .command('status')
    .description('检查项目目录中已安装 Skill 与当前 CLI 版本是否一致')
    .requiredOption('--dir <path>', '目标目录，如 .claude/skills')
    .action((o: { dir: string }, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      const t = Date.now();
      try {
        emit(localEnvelope('skills.status', skillsStatus(o.dir), null, t), g);
      } catch (e) {
        emit(localEnvelope('skills.status', null, e instanceof WorkError ? e : new WorkError('INTERNAL', String(e)), t), g);
      }
    });

  program
    .command('docs')
    .description('文档工具')
    .command('generate')
    .description('从能力定义生成能力目录、命令参考和输出 Schema（docs/）')
    .option('--out <dir>', '输出目录', 'docs')
    .action((o: { out: string }, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      const t = Date.now();
      const docsRegistry = builtinRegistry();
      emit(localEnvelope('docs.generate', generateDocs(docsRegistry, o.out), null, t), g);
    });

  program
    .command('mcp')
    .description('MCP 接入层')
    .command('serve')
    .description('以 stdio 方式启动 MCP 服务，把能力目录暴露为工具（默认不开放 execute 类操作）')
    .option('--allow-execute', '开放 execute 类工具（仍需 profile allow_execute）')
    .option('--domain <name>', '只暴露指定领域（可重复）', (v: string, prev?: string[]) => [...(prev ?? []), v])
    .action(async (o: { allowExecute?: boolean; domain?: string[] }, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      let timeoutMs = 60_000;
      try {
        // a bad budget is a usage error before the server starts, not an uncaught exception
        if (g.timeout) timeoutMs = checkTimeoutBudget(parseDuration(g.timeout));
      } catch (e) {
        emit(localEnvelope('mcp.serve', null, e instanceof WorkError ? e : new WorkError('INVALID_ARGUMENT', String(e)), Date.now()), g);
        return;
      }
      const { serveMcp } = await import('../mcp/server');
      await serveMcp(registry, { allowExecute: !!o.allowExecute, domains: o.domain, configPath: g.config, profile: g.profile, timeoutMs });
    });

  return program;
}

/** Whether usage errors must be reported as a JSON envelope (every spelling commander accepts for -o json). */
export function wantsJsonOutput(argv: string[]): boolean {
  return argv.includes('--json') || argv.some((a, i) => (a === '-o' || a === '--output') && argv[i + 1] === 'json') || argv.includes('--output=json') || argv.includes('-ojson');
}

export async function main(rawArgv = process.argv): Promise<void> {
  const registry = builtinRegistry();
  const { errors } = loadPlugins(registry);
  const argv = rewriteShadowedFlags(rawArgv, registry);
  const wantsJson = wantsJsonOutput(argv);
  const program = buildProgram(registry, errors, wantsJson);
  try {
    await program.parseAsync(argv);
  } catch (e) {
    if (e instanceof CommanderError) {
      if (e.code === 'commander.helpDisplayed' || e.code === 'commander.version' || e.code === 'commander.help') {
        process.exitCode = 0;
        return;
      }
      if (wantsJson) {
        const env = localEnvelope('cli', null, new WorkError('INVALID_ARGUMENT', e.message.replace(/^error: /, ''), { hint: '运行 workctl <command> --help 查看用法' }), Date.now());
        process.stdout.write(render(env, 'json') + '\n');
      }
      process.exitCode = e.code === 'commander.executeSubCommandAsync' ? 1 : 2;
      return;
    }
    throw e;
  }
}
