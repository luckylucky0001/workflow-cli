import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';
import { loadConfig, loadConfigForDiagnosis, resolveProfileName, type LoadedConfig } from './config';
import { ERROR_CODES, SCHEMA_VERSION, WorkError, type Envelope, type Result } from './output';
import type { CapabilityDef, InputSpec, Registry } from './registry';
import { checkTimeoutBudget, Ctx, parseDuration } from './runtime';

export const CLI_VERSION = '0.1.0';

export interface InvokeOptions {
  configPath?: string;
  profile?: string;
  timeoutMs?: number;
  requestId?: string;
  debug?: boolean;
  /** MCP and other agent hosts pass false: execute operations are refused unless explicitly allowed. */
  allowExecute?: boolean;
  /** Domain allow-list (`mcp serve --domain`): capabilities of other domains are refused; `core` stays callable. */
  allowedDomains?: string[];
  loaded?: LoadedConfig;
}

export function newRequestId(): string {
  return `req-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

function inputZod(name: string, spec: InputSpec): z.ZodType {
  let s: z.ZodType;
  switch (spec.type) {
    case 'int':
      // strict: numbers or numeric strings only (no booleans, blank strings or arrays coerced to numbers)
      s = z.union([z.number(), z.string().trim().regex(/^[+-]?\d+$/, { message: '须为整数' }).transform(Number)]).pipe(z.number().int().refine(Number.isSafeInteger, { message: '超出整数范围' }));
      break;
    case 'number':
      s = z.union([z.number(), z.string().trim().regex(/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/, { message: '须为数值' }).transform(Number)]).pipe(z.number().finite());
      break;
    case 'bool':
      s = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]);
      break;
    case 'duration':
      s = z.union([z.number().int().nonnegative(), z.string().transform((v, ctx) => {
        try {
          return parseDuration(v);
        } catch {
          ctx.addIssue({ code: 'custom', message: `无法解析时长 ${v}（示例: 30s、15m）` });
          return z.NEVER;
        }
      })]);
      break;
    case 'enum':
      s = z.enum(spec.enum as [string, ...string[]]);
      break;
    case 'list':
      // repeated flags (array from the CLI / MCP) and comma-separated values are equivalent
      s = z.union([z.array(z.string()), z.string()]).transform((v) => (Array.isArray(v) ? v : [v]).flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean));
      break;
    case 'file':
      s = z
        .string()
        .min(1)
        // shells expand `~`, MCP clients and config-driven callers do not
        .transform((p) => (p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p))
        .refine((p) => existsSync(p), { message: `文件不存在 (${name})` })
        .refine((p) => !existsSync(p) || statSync(p).isFile(), { message: `不是普通文件 (${name})` })
        // absolute from here on: plugins run in their own directory, adapters may chdir
        .transform((p) => resolve(p));
      break;
    default:
      s = z.string().min(1);
  }
  return s;
}

export function validateInputs(cap: CapabilityDef, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const [name, spec] of Object.entries(cap.inputs)) {
    let v = raw[name];
    if (v === undefined || v === null || v === '') {
      if (spec.default !== undefined) v = spec.default;
      else if (spec.required) {
        problems.push(`缺少必填参数 --${kebab(name)}`);
        continue;
      } else continue;
    }
    const r = inputZod(name, spec).safeParse(v);
    if (!r.success) problems.push(`--${kebab(name)}: ${r.error.issues.map((i) => i.message).join('; ')}`);
    else out[name] = r.data;
  }
  const unknown = Object.keys(raw).filter((k) => !(k in cap.inputs) && raw[k] !== undefined);
  if (unknown.length) problems.push(`未知参数: ${unknown.join(', ')}`);
  if (problems.length) {
    throw new WorkError('INVALID_ARGUMENT', problems.join('；'), { hint: `运行 workctl ${cap.command} --help 查看参数` });
  }
  return out;
}

export function kebab(s: string): string {
  return s.replace(/_/g, '-');
}

/** Read a SQL/text file input; kept here so every adapter enforces the same size budget. */
export function readInputFile(path: string, maxBytes = 256 * 1024): string {
  const buf = readFileSync(path);
  if (buf.length > maxBytes) throw new WorkError('INVALID_ARGUMENT', `文件超过 ${maxBytes} 字节上限: ${path}`);
  return buf.toString('utf8');
}

export function mapUnknownError(registry: Registry, e: unknown, domain?: string): WorkError {
  if (e instanceof WorkError) return e;
  // The capability's own domain names its system first. Other domains' mappers come only after
  // the generic network/timeout mapping: a mapper that claims any ECONNREFUSED would otherwise
  // attribute e.g. an unreachable Airflow to "PostgreSQL 不可达".
  const own = domain ? registry.domains.get(domain)?.mapError : undefined;
  const ownMapped = own?.(e);
  if (ownMapped) return ownMapped;
  const err = e as NodeJS.ErrnoException & { name?: string };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return new WorkError('TIMEOUT', '调用超过时间预算', { hint: '增大 --timeout 或缩小查询范围' });
  }
  const code = err?.code ?? (err?.cause as NodeJS.ErrnoException | undefined)?.code;
  if (code && ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOENT_SOCKET'].includes(code)) {
    return new WorkError('UPSTREAM_UNAVAILABLE', `目标系统不可达 (${code})`, { details: { reason: err.message } });
  }
  // a path-like input longer than the OS allows is a usage error (and its message would echo the whole input)
  if (code === 'ENAMETOOLONG') {
    return new WorkError('INVALID_ARGUMENT', '路径或名称超过系统长度上限 (ENAMETOOLONG)', { hint: '缩短路径类参数' });
  }
  for (const m of registry.errorMappers) {
    if (m === own) continue;
    const mapped = m(e);
    if (mapped) return mapped;
  }
  return new WorkError('INTERNAL', err?.message ?? String(e), { details: { name: err?.name } });
}

export async function invoke(registry: Registry, capName: string, rawInputs: Record<string, unknown>, opts: InvokeOptions = {}): Promise<Envelope> {
  const started = Date.now();
  // an empty id (e.g. --request-id "") would make the envelope untraceable
  const requestId = opts.requestId || newRequestId();
  const cap = registry.get(capName);
  let ctx: Ctx | undefined;
  const base = (): Envelope['context'] => ({
    request_id: requestId,
    profile: ctx?.profileName ?? null,
    env: ctx?.env ?? null,
    data_mode: ctx?.dataMode ?? null,
    capability_version: cap?.capability_version ?? null,
    adapter: cap?.adapter ?? null,
    operation: cap?.operation ?? null,
    cli_version: CLI_VERSION,
    started_at: new Date(started).toISOString(),
    duration_ms: Date.now() - started,
  });
  try {
    if (!cap) throw new WorkError('NOT_FOUND', `能力不存在: ${capName}`, { hint: '用 workctl capability list 查看可用能力' });
    if (cap.status === 'planned' || !cap.handler) {
      throw new WorkError('CAPABILITY_PLANNED', `能力 ${cap.name} 已列入目录，尚未接入`, { hint: `参考 ${cap.guide}` });
    }
    if (opts.allowedDomains?.length && cap.domain !== 'core' && !opts.allowedDomains.includes(cap.domain)) {
      throw new WorkError('PERMISSION_DENIED', `能力 ${cap.name} 属于领域 ${cap.domain}，不在当前入口开放的领域（${opts.allowedDomains.join(', ')}）内`, {
        hint: '用包含该领域的 --domain 启动 MCP 服务，或在终端调用',
      });
    }
    const timeoutMs = checkTimeoutBudget(opts.timeoutMs ?? 30_000);
    // doctor diagnoses a config that fails to load instead of being blocked by it
    const diagnosing = cap.name === 'doctor.run';
    const loaded = opts.loaded ?? (diagnosing ? loadConfigForDiagnosis(opts.configPath) : loadConfig(opts.configPath));
    const profileName = loaded.load_error ? null : resolveProfileName(loaded, opts.profile);
    ctx = new Ctx({
      registry,
      loaded,
      profileName,
      requestId,
      timeoutMs,
      capability: cap,
      debug: opts.debug,
      allowExecute: opts.allowExecute,
      allowedDomains: opts.allowedDomains,
    });
    const inputs = validateInputs(cap, rawInputs);
    if (cap.operation === 'execute') {
      if (opts.allowExecute === false) {
        throw new WorkError('PRECONDITION_FAILED', `${cap.name} 是执行类操作，当前入口未开放执行`, { hint: '在终端由授权人员执行，或以 --allow-execute 启动 MCP 服务' });
      }
      if (!ctx.profile?.allow_execute) {
        throw new WorkError('PRECONDITION_FAILED', `profile ${profileName ?? '(无)'} 未开启 allow_execute，拒绝执行类操作`, {
          hint: '执行操作只应在隔离或已授权环境中开启 allow_execute',
        });
      }
    }
    let timer: NodeJS.Timeout | undefined;
    const handlerRun = cap.handler(ctx, inputs);
    // if the budget wins the race the handler keeps running; observe its outcome so a
    // late rejection never surfaces as an unhandled rejection
    handlerRun.catch(() => undefined);
    let result: Result;
    try {
      result = await Promise.race([
        handlerRun,
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => {
            const hint =
              cap.operation === 'execute'
                ? '执行可能仍在进行或已部分完成；用 workctl operation get 查看实际状态，不要直接重试'
                : '增大 --timeout 或缩小查询范围';
            rej(new WorkError('TIMEOUT', `调用超过 ${ctx!.timeoutMs}ms 时间预算`, { hint }));
          }, ctx!.timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const warnings = [...ctx.warnings, ...(result.warnings ?? [])];
    if (process.env.WORKCTL_VALIDATE_OUTPUT === '1' && cap.output) {
      const check = cap.output.safeParse(result.data);
      if (!check.success) {
        warnings.push(`输出与 schema 不一致: ${check.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      }
    }
    return {
      schema_version: SCHEMA_VERSION,
      status: result.status ?? 'success',
      capability: cap.name,
      data: result.data ?? null,
      error: null,
      meta: { sources: result.sources ?? [], coverage: result.coverage ?? null, warnings },
      context: base(),
    };
  } catch (e) {
    const we = mapUnknownError(registry, e, cap?.domain);
    return {
      schema_version: SCHEMA_VERSION,
      status: 'error',
      capability: cap?.name ?? capName,
      data: null,
      error: {
        code: we.code,
        message: we.message,
        ...(we.hint ? { hint: we.hint } : {}),
        retryable: ERROR_CODES[we.code].retryable,
        ...(we.details ? { details: we.details } : {}),
      },
      meta: { sources: [], coverage: null, warnings: ctx?.warnings ?? [] },
      context: base(),
    };
  }
}
