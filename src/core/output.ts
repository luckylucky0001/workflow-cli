import { z } from 'zod';
import YAML from 'yaml';

export const SCHEMA_VERSION = '1.0';

/**
 * Stable error codes. Exit codes describe the invocation outcome; business state
 * (e.g. a task that is still running) is always read from `data`.
 */
export const ERROR_CODES = {
  INVALID_ARGUMENT: { exit: 2, retryable: false, summary: '参数缺失、格式错误或取值不合法' },
  UNAUTHENTICATED: { exit: 3, retryable: false, summary: '缺少凭据或认证失败' },
  PERMISSION_DENIED: { exit: 4, retryable: false, summary: '身份已认证，但目标系统拒绝该操作' },
  NOT_FOUND: { exit: 5, retryable: false, summary: '资源、任务或数据对象不存在' },
  UPSTREAM_UNAVAILABLE: { exit: 6, retryable: true, summary: '目标系统不可达或返回异常' },
  TIMEOUT: { exit: 6, retryable: true, summary: '调用超过时间预算' },
  COLLECTION_DISABLED: { exit: 7, retryable: false, summary: '目标系统未启用所需的采集或观测功能' },
  DATA_UNAVAILABLE: { exit: 7, retryable: false, summary: '数据源存在，但请求范围内没有可用数据' },
  NOT_CONFIGURED: { exit: 8, retryable: false, summary: '当前 profile 未配置所需端点或资源' },
  CAPABILITY_PLANNED: { exit: 8, retryable: false, summary: '能力已列入目录但尚未接入' },
  UNSUPPORTED: { exit: 8, retryable: false, summary: '目标引擎、版本或参数组合不受支持' },
  PRECONDITION_FAILED: { exit: 9, retryable: false, summary: '前置条件不满足（如未授权执行、计划已过期）' },
  CONFLICT: { exit: 9, retryable: false, summary: '状态冲突（如计划已执行）' },
  INTERNAL: { exit: 1, retryable: false, summary: 'workctl 内部错误' },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;
export const PARTIAL_EXIT_CODE = 10;

export class WorkError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly details?: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, opts: { hint?: string; details?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'WorkError';
    this.code = code;
    this.hint = opts.hint;
    this.details = opts.details;
  }
}

export const SourceSchema = z.object({
  system: z.string().describe('来源系统，如 mysql、redis、airflow、docker'),
  adapter: z.string(),
  endpoint: z.string().optional().describe('不含凭据的端点标识'),
  method: z.string().optional().describe('具体调用，如 SQL 视图、REST 路径、命令'),
  observed_at: z.string(),
  version: z.string().optional().describe('目标系统实际版本'),
  relation: z.enum(['explicit', 'inferred', 'derived', 'sampled']).optional(),
});
export type Source = z.infer<typeof SourceSchema>;

export const CoverageSchema = z.object({
  complete: z.boolean(),
  scope: z.string().optional(),
  sampled: z.boolean().optional(),
  truncated: z.boolean().optional(),
  limit: z.number().optional(),
  window: z.object({ start: z.string(), end: z.string() }).optional(),
  notes: z.array(z.string()).optional(),
});
export type Coverage = z.infer<typeof CoverageSchema>;

export const ErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  hint: z.string().optional(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const EnvelopeSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  status: z.enum(['success', 'partial', 'error']),
  capability: z.string(),
  data: z.unknown(),
  error: ErrorSchema.nullable(),
  meta: z.object({
    sources: z.array(SourceSchema),
    coverage: CoverageSchema.nullable(),
    warnings: z.array(z.string()),
  }),
  context: z.object({
    request_id: z.string(),
    profile: z.string().nullable(),
    env: z.string().nullable(),
    data_mode: z.string().nullable(),
    capability_version: z.string().nullable(),
    adapter: z.string().nullable(),
    operation: z.string().nullable(),
    cli_version: z.string(),
    started_at: z.string(),
    duration_ms: z.number(),
  }),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

/** What a capability handler returns. Only `data` is required. */
export interface Result<T = unknown> {
  data: T;
  status?: 'success' | 'partial';
  sources?: Source[];
  coverage?: Coverage;
  warnings?: string[];
}

export function source(system: string, adapter: string, extra: Partial<Omit<Source, 'system' | 'adapter'>> = {}): Source {
  return { system, adapter, observed_at: new Date().toISOString(), ...extra };
}

export function exitCodeFor(env: Envelope, failOnPartial = false): number {
  if (env.status === 'error') {
    const code = env.error?.code as ErrorCode | undefined;
    return code && ERROR_CODES[code] ? ERROR_CODES[code].exit : 1;
  }
  if (env.status === 'partial' && failOnPartial) return PARTIAL_EXIT_CODE;
  return 0;
}

export function render(env: Envelope, format: 'json' | 'yaml' | 'text'): string {
  if (format === 'json') return JSON.stringify(env, null, 2);
  if (format === 'yaml') return YAML.stringify(env, { lineWidth: 0 });
  // text: compact human view; full contract stays available through --json
  const lines: string[] = [];
  if (env.status === 'error' && env.error) {
    lines.push(`error ${env.error.code}: ${env.error.message}`);
    if (env.error.hint) lines.push(`hint: ${env.error.hint}`);
    if (env.error.details) lines.push(YAML.stringify({ details: env.error.details }, { lineWidth: 0 }).trimEnd());
  } else {
    if (env.status === 'partial') lines.push('# status: partial (结果不完整，见 meta.coverage / warnings)');
    lines.push(YAML.stringify(env.data, { lineWidth: 0 }).trimEnd());
  }
  if (env.meta.coverage && !env.meta.coverage.complete) {
    lines.push(`# coverage: incomplete${env.meta.coverage.scope ? ` (${env.meta.coverage.scope})` : ''}`);
    for (const n of env.meta.coverage.notes ?? []) lines.push(`#   - ${n}`);
  }
  for (const w of env.meta.warnings) lines.push(`# warning: ${w}`);
  if (env.meta.sources.length) {
    lines.push(`# sources: ${env.meta.sources.map((s) => `${s.system}${s.method ? `:${s.method}` : ''}${s.relation ? ` [${s.relation}]` : ''}`).join(', ')}`);
  }
  return lines.join('\n');
}
