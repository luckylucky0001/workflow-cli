import { z } from 'zod';

/** Exec protocol shared with workctl core (src/core/plugins.ts). */
export const PROTOCOL = 'workctl-plugin/1';

export const RequestSchema = z.object({
  protocol: z.string(),
  capability: z.string().min(1),
  inputs: z.record(z.string(), z.unknown()).default({}),
  endpoints: z.record(z.string(), z.record(z.string(), z.record(z.string(), z.unknown()))).default({}),
  defaults: z.record(z.string(), z.string()).default({}),
  profile: z.string().nullable().optional(),
  env: z.string().nullable().optional(),
  request_id: z.string().optional(),
  timeout_ms: z.number().positive().optional(),
});
export type PluginRequest = z.infer<typeof RequestSchema>;

export type ErrorCode =
  | 'INVALID_ARGUMENT'
  | 'UNAUTHENTICATED'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'UPSTREAM_UNAVAILABLE'
  | 'TIMEOUT'
  | 'COLLECTION_DISABLED'
  | 'DATA_UNAVAILABLE'
  | 'NOT_CONFIGURED'
  | 'UNSUPPORTED'
  | 'INTERNAL';

export class PluginError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly details?: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, opts: { hint?: string; details?: Record<string, unknown> } = {}) {
    super(message);
    this.name = 'PluginError';
    this.code = code;
    this.hint = opts.hint;
    this.details = opts.details;
  }
}

export interface Source {
  system: string;
  adapter: string;
  endpoint?: string;
  method?: string;
  observed_at: string;
  version?: string;
  relation?: 'explicit' | 'inferred' | 'derived' | 'sampled';
}

export interface Coverage {
  complete: boolean;
  scope?: string;
  sampled?: boolean;
  truncated?: boolean;
  limit?: number;
  notes?: string[];
}

export interface HandlerResult<T = unknown> {
  status?: 'success' | 'partial';
  data: T;
  sources: Source[];
  coverage: Coverage | null;
  warnings?: string[];
}

export interface PluginResponse {
  status: 'success' | 'partial' | 'error';
  data: unknown;
  error: null | { code: ErrorCode; message: string; hint?: string; details?: Record<string, unknown> };
  meta: { sources: Source[]; coverage: Coverage | null; warnings: string[] };
}

export function successResponse(r: HandlerResult): PluginResponse {
  return {
    status: r.status ?? 'success',
    data: r.data ?? null,
    error: null,
    meta: { sources: r.sources, coverage: r.coverage, warnings: r.warnings ?? [] },
  };
}

export function errorResponse(e: PluginError, sources: Source[] = []): PluginResponse {
  return {
    status: 'error',
    data: null,
    error: {
      code: e.code,
      message: e.message,
      ...(e.hint ? { hint: e.hint } : {}),
      ...(e.details ? { details: e.details } : {}),
    },
    meta: { sources, coverage: null, warnings: [] },
  };
}
