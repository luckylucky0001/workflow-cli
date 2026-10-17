import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { resolveSecretRef } from './config';
import { WorkError, type Result } from './output';
import type { CapabilityDef, DomainDef, Registry } from './registry';
import type { Ctx } from './runtime';

export const PLUGIN_API = 'workctl-plugin/1';

const InputSpecSchema = z.object({
  type: z.enum(['string', 'int', 'number', 'bool', 'duration', 'enum', 'file', 'list']),
  description: z.string(),
  required: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
  enum: z.array(z.string()).optional(),
});

const PluginCapabilitySchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/),
  command: z.string(),
  summary: z.string(),
  description: z.string().optional(),
  inputs: z.record(z.string(), InputSpecSchema).default({}),
  output_schema: z.string().optional(),
  adapter: z.string(),
  operation: z.enum(['read', 'diagnose', 'plan', 'execute']),
  auth_provider: z.string(),
  capability_version: z.string(),
  guide: z.string(),
  status: z.enum(['available', 'requires_auth', 'planned']).default('available'),
  notes: z.array(z.string()).optional(),
  examples: z.array(z.string()).optional(),
  prerequisites: z.array(z.string()).optional(),
});

export const PluginManifestSchema = z.object({
  plugin_api: z.literal(PLUGIN_API),
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  // used as a directory name under the plugins dir: no separators, no '..'
  version: z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/),
  description: z.string().optional(),
  backend_mode: z.enum(['live', 'recorded', 'synthetic_fixture']),
  entry: z.string(),
  domain: z.object({
    name: z.string(),
    title: z.string(),
    summary: z.string(),
    pillar: z.enum(['infrastructure', 'middleware', 'offline', 'supporting']),
    guide: z.string(),
    skill: z.string().optional(),
  }),
  endpoint_kinds: z.array(z.string()).default([]),
  compatibility: z.record(z.string(), z.unknown()).optional(),
  capabilities: z.array(PluginCapabilitySchema).min(1),
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export interface InstalledPlugin {
  name: string;
  version: string;
  dir: string;
  installed_at: string;
  backend_mode: string;
  source_file: string;
}

export function workctlHome(): string {
  return process.env.WORKCTL_HOME ?? join(homedir(), '.local', 'share', 'workctl');
}

function pluginsDir(): string {
  return join(workctlHome(), 'plugins');
}

function indexFile(): string {
  return join(pluginsDir(), 'index.json');
}

export function listInstalled(): InstalledPlugin[] {
  if (!existsSync(indexFile())) return [];
  try {
    return JSON.parse(readFileSync(indexFile(), 'utf8')) as InstalledPlugin[];
  } catch {
    return [];
  }
}

function writeIndex(items: InstalledPlugin[]): void {
  mkdirSync(pluginsDir(), { recursive: true });
  writeFileSync(indexFile(), JSON.stringify(items, null, 2));
}

export function readManifest(dir: string): PluginManifest {
  const f = join(dir, 'workctl-plugin.json');
  if (!existsSync(f)) throw new WorkError('INVALID_ARGUMENT', '插件包缺少 workctl-plugin.json');
  const parsed = PluginManifestSchema.safeParse(JSON.parse(readFileSync(f, 'utf8')));
  if (!parsed.success) {
    throw new WorkError('INVALID_ARGUMENT', '插件清单不合法', { details: { issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) } });
  }
  return parsed.data;
}

/** Validate a plugin directory against the registry it will join. */
export function validatePlugin(dir: string, registry: Registry, replacing?: string): { manifest: PluginManifest; problems: string[] } {
  const manifest = readManifest(dir);
  const problems: string[] = [];
  // every path in the manifest must stay inside the plugin directory
  const paths: [string, string | undefined][] = [
    ['entry', manifest.entry],
    ['domain.guide', manifest.domain.guide],
    ['domain.skill', manifest.domain.skill],
    ...manifest.capabilities.flatMap((c) => [[`${c.name}.guide`, c.guide], [`${c.name}.output_schema`, c.output_schema]] as [string, string | undefined][]),
  ];
  for (const [field, rel] of paths) {
    if (rel !== undefined && !isInside(dir, rel)) problems.push(`${field} 路径超出插件目录: ${rel}`);
  }
  if (!existsSync(join(dir, manifest.entry))) problems.push(`入口文件不存在: ${manifest.entry}`);
  if (!existsSync(join(dir, manifest.domain.guide))) problems.push(`领域指南不存在: ${manifest.domain.guide}`);
  const ownedBySelf = (origin?: string) => !!replacing && !!origin?.startsWith(`plugin:${replacing}@`);
  const existingDomain = registry.domains.get(manifest.domain.name);
  if (existingDomain && existingDomain.capabilities.some((c) => c.status !== 'planned' && !ownedBySelf(c.origin))) {
    problems.push(`领域 ${manifest.domain.name} 已由其他来源提供`);
  }
  for (const c of manifest.capabilities) {
    if (!c.name.startsWith(`${manifest.domain.name}.`)) problems.push(`能力 ${c.name} 不在领域 ${manifest.domain.name} 下`);
    const clash = registry.get(c.name);
    // a plugin may fulfil a capability the built-in catalog lists as planned
    const fulfilsPlanned = clash?.status === 'planned' && (clash.origin ?? 'builtin') === 'builtin';
    if (clash && !ownedBySelf(clash.origin) && !fulfilsPlanned) problems.push(`能力名冲突: ${c.name}`);
    if (c.status !== 'planned') {
      const cmdClash = [...registry.capabilities.values()].find((o) => o.status !== 'planned' && o.command === c.command && o.name !== c.name && !ownedBySelf(o.origin));
      if (cmdClash) problems.push(`命令冲突: ${c.command}（已由 ${cmdClash.name} 使用）`);
    }
    if (c.output_schema && !existsSync(join(dir, c.output_schema))) problems.push(`输出 Schema 不存在: ${c.output_schema}`);
  }
  return { manifest, problems };
}

/** True when `rel` resolves to a path inside `dir` (no absolute paths, no `..` escapes). */
export function isInside(dir: string, rel: string): boolean {
  const root = resolve(dir);
  const full = resolve(root, rel);
  return full === root || full.startsWith(root + sep);
}

/**
 * Inspect the archive before extracting: only regular files and directories with
 * relative paths that stay inside the extraction directory are accepted (no
 * symlinks, hard links, devices, absolute paths or `..` segments).
 */
export function checkArchiveEntries(archive: string): void {
  const names = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  if (names.status !== 0) throw new WorkError('INVALID_ARGUMENT', `插件包无法读取: ${(names.stderr ?? '').trim() || names.error?.message || 'unknown'}`);
  const verbose = spawnSync('tar', ['-tvzf', archive], { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  if (verbose.status !== 0) throw new WorkError('INVALID_ARGUMENT', `插件包无法读取: ${(verbose.stderr ?? '').trim()}`);
  const bad: string[] = [];
  for (const name of names.stdout.split('\n').filter(Boolean)) {
    const segs = name.split('/');
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || segs.includes('..')) bad.push(name);
  }
  for (const line of verbose.stdout.split('\n').filter(Boolean)) {
    const type = line[0];
    // GNU tar: l = symlink, h = hard link; bsdtar marks hard links with "link to"
    if ((type !== '-' && type !== 'd') || / link to /.test(line)) bad.push(line.trim());
  }
  if (bad.length) {
    throw new WorkError('INVALID_ARGUMENT', '插件包含有不允许的条目（链接、设备文件、绝对路径或 ..）', { details: { entries: bad.slice(0, 10) } });
  }
}

/** Defense in depth after extraction: refuse any symlink or special file in the tree. */
function rejectLinks(dir: string): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = lstatSync(full);
    if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) {
      throw new WorkError('INVALID_ARGUMENT', `插件包含有链接或特殊文件: ${name}`);
    }
    if (st.isDirectory()) rejectLinks(full);
  }
}

export function installPlugin(file: string, registry: Registry): { plugin: InstalledPlugin; manifest: PluginManifest; replaced: string | null } {
  const abs = resolve(file);
  if (!existsSync(abs)) throw new WorkError('NOT_FOUND', `插件包不存在: ${file}`);
  checkArchiveEntries(abs);
  const staging = mkdtempSync(join(tmpdir(), 'workctl-plugin-'));
  try {
    const tar = spawnSync('tar', ['-xzf', abs, '-C', staging, '--no-same-owner'], { encoding: 'utf8', timeout: 60_000 });
    if (tar.status !== 0) throw new WorkError('INVALID_ARGUMENT', `插件包解压失败: ${(tar.stderr ?? '').trim() || tar.error?.message || 'unknown'}`);
    rejectLinks(staging);
    const pre = readManifest(staging);
    const previous = listInstalled().find((p) => p.name === pre.name) ?? null;
    const { manifest, problems } = validatePlugin(staging, registry, previous ? pre.name : undefined);
    if (problems.length) throw new WorkError('INVALID_ARGUMENT', `插件校验失败: ${problems.join('；')}`);
    const dest = join(pluginsDir(), manifest.name, manifest.version);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    cpSync(staging, dest, { recursive: true });
    const plugin: InstalledPlugin = { name: manifest.name, version: manifest.version, dir: dest, installed_at: new Date().toISOString(), backend_mode: manifest.backend_mode, source_file: abs };
    writeIndex([...listInstalled().filter((p) => p.name !== manifest.name), plugin]);
    return { plugin, manifest, replaced: previous ? previous.version : null };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function removePlugin(name: string): InstalledPlugin {
  const items = listInstalled();
  const p = items.find((x) => x.name === name);
  if (!p) throw new WorkError('NOT_FOUND', `插件未安装: ${name}`);
  rmSync(join(pluginsDir(), name), { recursive: true, force: true });
  writeIndex(items.filter((x) => x.name !== name));
  return p;
}

/** Register installed plugins; a broken plugin is reported, never fatal for the CLI. */
export function loadPlugins(registry: Registry): { loaded: string[]; errors: string[] } {
  const loaded: string[] = [];
  const errors: string[] = [];
  for (const p of listInstalled()) {
    try {
      const manifest = readManifest(p.dir);
      registry.addDomain(pluginDomain(p, manifest), { fulfillPlanned: true });
      loaded.push(`${p.name}@${p.version}`);
    } catch (e) {
      errors.push(`${p.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { loaded, errors };
}

function pluginDomain(p: InstalledPlugin, m: PluginManifest): DomainDef {
  const capabilities: CapabilityDef[] = m.capabilities.map((c) => {
    const schemaFile = c.output_schema ? join(p.dir, c.output_schema) : undefined;
    return {
      name: c.name,
      command: c.command,
      summary: c.summary,
      description: c.description,
      domain: m.domain.name,
      inputs: c.inputs,
      adapter: c.adapter,
      operation: c.operation,
      auth_provider: c.auth_provider,
      capability_version: c.capability_version,
      guide: join(p.dir, c.guide),
      status: c.status,
      notes: c.notes,
      examples: c.examples,
      prerequisites: c.prerequisites,
      backend_modes: [m.backend_mode],
      origin: `plugin:${m.name}@${m.version}`,
      output_json_schema: schemaFile && existsSync(schemaFile) ? JSON.parse(readFileSync(schemaFile, 'utf8')) : undefined,
      output_schema_path: schemaFile,
      handler: c.status === 'planned' ? undefined : (ctx: Ctx, inputs: Record<string, any>) => execPlugin(ctx, p, m, c.name, inputs),
    };
  });
  return {
    name: m.domain.name,
    title: m.domain.title,
    summary: m.domain.summary,
    pillar: m.domain.pillar,
    guide: join(p.dir, m.domain.guide),
    skill: m.domain.skill ? join(p.dir, m.domain.skill) : undefined,
    capabilities,
  };
}

const PluginResponseSchema = z.object({
  status: z.enum(['success', 'partial', 'error']),
  data: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional(), details: z.record(z.string(), z.unknown()).optional() }).nullable().optional(),
  meta: z.object({ sources: z.array(z.any()).default([]), coverage: z.any().nullable().optional(), warnings: z.array(z.string()).default([]) }).default({ sources: [], warnings: [] }),
});

const MAX_PLUGIN_OUTPUT = 32 * 1024 * 1024;
const PLUGIN_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'SYSTEMROOT', 'NODE_EXTRA_CA_CERTS', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'WORKCTL_DEBUG'];

/** Minimal environment for plugin processes (no inherited secrets). */
export function pluginEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of PLUGIN_ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k] as string;
  return env;
}

/** Endpoint configs for the plugin's kinds, with credential references resolved (passed only via stdin). */
function pluginEndpoints(ctx: Ctx, kinds: string[], secrets: string[] = []): Record<string, Record<string, Record<string, unknown>>> {
  const out: Record<string, Record<string, Record<string, unknown>>> = {};
  const profile = ctx.profile;
  if (!profile) return out;
  for (const kind of kinds) {
    for (const [name, cfg] of Object.entries(profile.endpoints[kind] ?? {})) {
      const resolved: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(cfg)) {
        if (k.endsWith('_ref')) {
          const value = resolveSecretRef(String(v), ctx.loaded.baseDir);
          resolved[k.slice(0, -4)] = value;
          if (value) secrets.push(value);
        } else resolved[k] = v;
      }
      (out[kind] ??= {})[name] = resolved;
    }
  }
  return out;
}

/**
 * Replace credential values a plugin echoes back (in data, errors or its raw output)
 * so they never reach the envelope, logs or a model context.
 */
export function redactSecrets<T>(value: T, secrets: string[]): T {
  const list = [...new Set(secrets.filter((x) => x.length > 0))].sort((a, b) => b.length - a.length);
  if (!list.length) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      let out = v;
      for (const sec of list) {
        if (sec.length >= 4) out = out.split(sec).join('***');
        else if (out === sec) out = '***';
      }
      return out;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

async function execPlugin(ctx: Ctx, p: InstalledPlugin, m: PluginManifest, capability: string, inputs: Record<string, unknown>): Promise<Result> {
  const secrets: string[] = [];
  const request = {
    protocol: PLUGIN_API,
    capability,
    inputs,
    endpoints: pluginEndpoints(ctx, m.endpoint_kinds, secrets),
    defaults: Object.fromEntries(m.endpoint_kinds.map((k) => [k, ctx.profile?.defaults[k]]).filter(([, v]) => v)),
    profile: ctx.profileName,
    env: ctx.env,
    request_id: ctx.requestId,
    timeout_ms: ctx.remainingMs(),
  };
  const { stdout, stderr, code, timedOut, overflow } = await new Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean; overflow: boolean }>((res, rej) => {
    // Credentials travel only in the stdin request: the child does not inherit
    // workctl's environment (which may hold env:-referenced secrets of other endpoints).
    const child = spawn(process.execPath, [join(p.dir, m.entry)], { cwd: p.dir, stdio: ['pipe', 'pipe', 'pipe'], env: pluginEnv() });
    let out = '';
    let err = '';
    let timedOut = false;
    let overflow = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, ctx.remainingMs());
    child.stdout.on('data', (d) => {
      out += d;
      if (out.length > MAX_PLUGIN_OUTPUT && !overflow) {
        overflow = true;
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (d) => {
      if (err.length < 64 * 1024) err += d;
    });
    // a plugin that exits without reading stdin must not crash workctl with EPIPE
    child.stdin.on('error', () => undefined);
    child.on('error', (e) => {
      clearTimeout(timer);
      rej(e);
    });
    child.on('close', (c) => {
      clearTimeout(timer);
      res({ stdout: out, stderr: err, code: c, timedOut, overflow });
    });
    child.stdin.end(JSON.stringify(request));
  });
  if (stderr.trim()) ctx.debug(`plugin ${p.name} stderr: ${redactSecrets(stderr.trim().slice(0, 2000), secrets)}`);
  if (timedOut) throw new WorkError('TIMEOUT', `插件 ${p.name} 超过时间预算被终止`, { hint: '增大 --timeout 或缩小查询范围' });
  if (overflow) throw new WorkError('INTERNAL', `插件 ${p.name} 输出超过 ${MAX_PLUGIN_OUTPUT} 字节上限`);
  let parsed: z.infer<typeof PluginResponseSchema>;
  try {
    parsed = PluginResponseSchema.parse(JSON.parse(stdout));
  } catch {
    throw new WorkError('INTERNAL', `插件 ${p.name} 返回了不符合协议的输出 (exit ${code})`, {
      details: { stdout: redactSecrets(stdout.slice(0, 500), secrets), stderr: redactSecrets(stderr.slice(-500), secrets) },
    });
  }
  parsed = redactSecrets(parsed, secrets);
  if (parsed.status === 'error') {
    const e = parsed.error ?? { code: 'INTERNAL', message: '插件返回错误但未提供详情' };
    const known = ['INVALID_ARGUMENT', 'UNAUTHENTICATED', 'PERMISSION_DENIED', 'NOT_FOUND', 'UPSTREAM_UNAVAILABLE', 'TIMEOUT', 'COLLECTION_DISABLED', 'DATA_UNAVAILABLE', 'NOT_CONFIGURED', 'UNSUPPORTED', 'PRECONDITION_FAILED', 'CONFLICT', 'INTERNAL'];
    throw new WorkError((known.includes(e.code) ? e.code : 'INTERNAL') as never, e.message, { hint: e.hint, details: e.details });
  }
  const warnings = [...parsed.meta.warnings];
  if (m.backend_mode !== 'live') warnings.unshift(`插件后端模式为 ${m.backend_mode}，结果不是实时系统数据`);
  return {
    data: parsed.data ?? null,
    status: parsed.status,
    sources: parsed.meta.sources,
    coverage: parsed.meta.coverage ?? undefined,
    warnings,
  };
}
