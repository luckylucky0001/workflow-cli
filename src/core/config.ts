import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { WorkError } from './output';

/**
 * Endpoint configs are free-form per kind (mysql, redis, airflow, ...).
 * Credentials are never stored inline: a key such as `password` must be written
 * as `password_ref: env:NAME` or `password_ref: file:/path`.
 */
const EndpointSchema = z.record(z.string(), z.unknown());

export const ProfileSchema = z.object({
  description: z.string().optional(),
  env: z.string().default('default'),
  data_mode: z.enum(['live', 'synthetic_fixture', 'recorded']).default('live'),
  allow_execute: z.boolean().default(false).describe('是否允许 execute 类操作；默认关闭'),
  resources_file: z.string().optional(),
  state_dir: z.string().optional(),
  endpoints: z.record(z.string(), z.record(z.string(), EndpointSchema)).default({}),
  defaults: z.record(z.string(), z.string()).default({}),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const ConfigSchema = z.object({
  schema_version: z.string().default('1.0'),
  current_profile: z.string().optional(),
  profiles: z.record(z.string(), ProfileSchema).default({}),
});
export type Config = z.infer<typeof ConfigSchema>;

export interface LoadedConfig {
  path: string | null;
  baseDir: string;
  config: Config;
  /** Problems that do not stop loading (e.g. unknown keys the schema drops); surfaced as envelope warnings. */
  warnings?: string[];
  /**
   * Set only by loadConfigForDiagnosis: the file exists but could not be loaded (parse error,
   * invalid structure, inline credentials). `config` is then the empty default.
   */
  load_error?: { message: string; reason?: string; issues?: string[]; paths?: string[] };
}

/** Keys the schema would silently drop: a typo such as `resource_file` must not just disappear (`x-*` keys hold YAML anchors). */
function unknownConfigKeys(raw: unknown): string[] {
  const extra = (v: unknown, known: string[], at: string) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).filter((k) => !known.includes(k) && !k.startsWith('x-')).map((k) => `${at}${k}`) : [];
  const out = extra(raw, Object.keys(ConfigSchema.shape), '');
  const profiles = (raw as { profiles?: unknown } | null)?.profiles;
  if (profiles && typeof profiles === 'object') {
    for (const [name, prof] of Object.entries(profiles)) out.push(...extra(prof, Object.keys(ProfileSchema.shape), `profiles.${name}.`));
  }
  return out;
}

// exact names and suffixed forms such as client_secret, auth_token, secret_access_key, private_key
const INLINE_SECRET_KEY = /(^|_)(password|passwd|pwd|passphrase|secret|token|api_key|apikey|access_key|secret_key|private_key|dsn|credentials?|authorization|cookie)$/i;
/** An HTTP Authorization value (e.g. under a plugin endpoint's `headers`), whatever its key. */
const AUTH_HEADER_VALUE = /^(bearer|basic|token|digest)\s+\S{6,}/i;
/** scheme://user:password@host — credentials embedded in a URL value. */
const URL_WITH_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s:]*:[^/@\s]+@/i;

/** Paths of inline credentials in an endpoint config (nested objects and URL values included). */
export function findInlineSecrets(value: unknown, path: string): string[] {
  if (typeof value === 'string') return URL_WITH_PASSWORD.test(value) || AUTH_HEADER_VALUE.test(value) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => findInlineSecrets(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
      ...(INLINE_SECRET_KEY.test(k) && v !== null && v !== undefined && v !== '' ? [`${path}.${k}`] : []),
      ...findInlineSecrets(v, `${path}.${k}`),
    ]);
  }
  return [];
}

/**
 * A YAML parse error without the parser's code frame: the frame quotes the lines around the
 * error, which may hold credentials (or other file content) that must not reach the output.
 */
export function yamlErrorSummary(e: unknown): string {
  const err = e as { name?: string; code?: string; linePos?: { line: number; col: number }[]; message?: string };
  const first = String(err?.message ?? e).split('\n')[0].replace(/:\s*$/, '');
  return `${err?.name ?? 'Error'}${err?.code ? ` (${err.code})` : ''}: ${first}`;
}

/** YAML 1.2 drops `<<` merge keys unless asked; configs commonly share endpoint blocks with `<<: *base`. */
export const YAML_OPTIONS = { merge: true } as const;

export function defaultConfigCandidates(cwd = process.cwd()): string[] {
  const out: string[] = [];
  if (process.env.WORKCTL_CONFIG) out.push(resolve(process.env.WORKCTL_CONFIG));
  out.push(join(cwd, 'workctl.yaml'));
  out.push(join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'workctl', 'config.yaml'));
  return out;
}

export function loadConfig(explicitPath?: string): LoadedConfig {
  // $WORKCTL_CONFIG names a file as explicitly as --config: a typo must not silently fall back
  // to ./workctl.yaml or ~/.config/workctl/config.yaml (possibly another environment's profiles)
  const namedPath = explicitPath ?? (process.env.WORKCTL_CONFIG || undefined);
  const candidates = explicitPath ? [resolve(explicitPath)] : defaultConfigCandidates();
  const path = candidates.find((p) => existsSync(p)) ?? null;
  if (namedPath && path !== resolve(namedPath)) {
    throw new WorkError('NOT_CONFIGURED', `配置文件不存在: ${namedPath}`, explicitPath ? undefined : { hint: '检查环境变量 WORKCTL_CONFIG' });
  }
  if (path && statSync(path).isDirectory()) {
    throw new WorkError('NOT_CONFIGURED', `配置路径是目录而不是文件: ${path}`, { hint: '指向其中的 YAML 文件，如 workctl.yaml' });
  }
  if (!path) {
    return { path: null, baseDir: process.cwd(), config: ConfigSchema.parse({}) };
  }
  let raw: unknown;
  try {
    raw = YAML.parse(readFileSync(path, 'utf8'), YAML_OPTIONS) ?? {};
  } catch (e) {
    throw new WorkError('INVALID_ARGUMENT', `配置文件无法解析: ${path}`, { details: { reason: yamlErrorSummary(e) } });
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new WorkError('INVALID_ARGUMENT', `配置文件结构不合法: ${path}`, {
      details: { issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
    });
  }
  for (const [pname, prof] of Object.entries(parsed.data.profiles)) {
    for (const [kind, named] of Object.entries(prof.endpoints)) {
      for (const [name, ep] of Object.entries(named)) {
        const found = findInlineSecrets(ep, `profiles.${pname}.endpoints.${kind}.${name}`);
        if (found.length) {
          const key = found[0].split('.').pop()!.replace(/\[\d+\]$/, '');
          throw new WorkError('INVALID_ARGUMENT', `${found[0]} 不允许直接写入凭据`, {
            hint: `改用 ${key}_ref: env:VAR_NAME 或 ${key}_ref: file:/path/to/secret；URL 中不要包含密码`,
            details: { paths: found },
          });
        }
      }
    }
  }
  const unknown = unknownConfigKeys(raw);
  const warnings = unknown.length ? [`配置文件中有未识别的键（已忽略，检查拼写）: ${unknown.join(', ')}`] : [];
  return { path, baseDir: dirname(path), config: parsed.data, warnings };
}

/**
 * For `doctor` only: like loadConfig, but a config file that exists and fails to load is
 * returned as `load_error` (with the empty default config) instead of thrown, so the problem
 * can be reported as a failed check. Missing files etc. still throw as in loadConfig.
 */
export function loadConfigForDiagnosis(explicitPath?: string): LoadedConfig {
  try {
    return loadConfig(explicitPath);
  } catch (e) {
    if (!(e instanceof WorkError) || e.code !== 'INVALID_ARGUMENT') throw e;
    const candidates = explicitPath ? [resolve(explicitPath)] : defaultConfigCandidates();
    const path = candidates.find((p) => existsSync(p)) ?? null;
    const d = (e.details ?? {}) as { reason?: string; issues?: string[]; paths?: string[] };
    return {
      path,
      baseDir: path ? dirname(path) : process.cwd(),
      config: ConfigSchema.parse({}),
      load_error: { message: e.message, ...(d.reason ? { reason: d.reason } : {}), ...(d.issues ? { issues: d.issues } : {}), ...(d.paths ? { paths: d.paths } : {}) },
    };
  }
}

export function resolveProfileName(loaded: LoadedConfig, requested?: string): string | null {
  const name = requested ?? process.env.WORKCTL_PROFILE ?? loaded.config.current_profile;
  if (name) {
    if (!loaded.config.profiles[name]) {
      throw new WorkError('NOT_CONFIGURED', `profile 不存在: ${name}`, {
        hint: `可用 profile: ${Object.keys(loaded.config.profiles).join(', ') || '(无)'}`,
      });
    }
    return name;
  }
  const names = Object.keys(loaded.config.profiles);
  return names.length === 1 ? names[0] : null;
}

/** Resolve a credential reference (`env:NAME` or `file:PATH`). The value never enters output. */
export function resolveSecretRef(ref: string, baseDir: string): string {
  if (ref.startsWith('env:')) {
    const name = ref.slice(4);
    const v = process.env[name];
    if (v === undefined || v === '') {
      // an empty variable is an unset credential, not an empty password
      throw new WorkError('UNAUTHENTICATED', `凭据引用未解析: 环境变量 ${name} ${v === undefined ? '未设置' : '为空'}`, { hint: `设置 ${name} 或修改 profile 中的 *_ref` });
    }
    return v;
  }
  if (ref.startsWith('file:')) {
    const p = ref.slice(5);
    const full = isAbsolute(p) ? p : resolve(baseDir, p);
    if (!existsSync(full)) {
      throw new WorkError('UNAUTHENTICATED', `凭据引用未解析: 文件 ${p} 不存在`);
    }
    return readFileSync(full, 'utf8').trim();
  }
  throw new WorkError('INVALID_ARGUMENT', `不支持的凭据引用格式: ${ref.split(':')[0]}:`, { hint: '使用 env:NAME 或 file:PATH' });
}

export function secretRefStatus(ref: string, baseDir: string): { ref_type: string; resolvable: boolean; reason?: string } {
  const refType = ref.split(':')[0];
  try {
    resolveSecretRef(ref, baseDir);
    return { ref_type: refType, resolvable: true };
  } catch (e) {
    return { ref_type: refType, resolvable: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
