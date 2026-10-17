import { existsSync, readFileSync } from 'node:fs';
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
}

const INLINE_SECRET_KEY = /^(password|passwd|secret|token|api_key|apikey|access_key|secret_key|dsn)$/i;

export function defaultConfigCandidates(cwd = process.cwd()): string[] {
  const out: string[] = [];
  if (process.env.WORKCTL_CONFIG) out.push(resolve(process.env.WORKCTL_CONFIG));
  out.push(join(cwd, 'workctl.yaml'));
  out.push(join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'workctl', 'config.yaml'));
  return out;
}

export function loadConfig(explicitPath?: string): LoadedConfig {
  const candidates = explicitPath ? [resolve(explicitPath)] : defaultConfigCandidates();
  const path = candidates.find((p) => existsSync(p)) ?? null;
  if (explicitPath && !path) {
    throw new WorkError('NOT_CONFIGURED', `配置文件不存在: ${explicitPath}`);
  }
  if (!path) {
    return { path: null, baseDir: process.cwd(), config: ConfigSchema.parse({}) };
  }
  let raw: unknown;
  try {
    raw = YAML.parse(readFileSync(path, 'utf8')) ?? {};
  } catch (e) {
    throw new WorkError('INVALID_ARGUMENT', `配置文件无法解析: ${path}`, { details: { reason: String(e) } });
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
        for (const key of Object.keys(ep)) {
          if (INLINE_SECRET_KEY.test(key)) {
            throw new WorkError('INVALID_ARGUMENT', `profiles.${pname}.endpoints.${kind}.${name}.${key} 不允许直接写入凭据`, {
              hint: `改用 ${key}_ref: env:VAR_NAME 或 ${key}_ref: file:/path/to/secret`,
            });
          }
        }
      }
    }
  }
  return { path, baseDir: dirname(path), config: parsed.data };
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
    if (v === undefined) {
      throw new WorkError('UNAUTHENTICATED', `凭据引用未解析: 环境变量 ${name} 未设置`, { hint: `设置 ${name} 或修改 profile 中的 *_ref` });
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
