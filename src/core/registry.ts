import { z } from 'zod';
import type { Ctx } from './runtime';
import type { Result } from './output';
import type { PlanDraft, Plan } from './operations';

export type InputType = 'string' | 'int' | 'number' | 'bool' | 'duration' | 'enum' | 'file' | 'list';
export type Operation = 'read' | 'diagnose' | 'plan' | 'execute';
export type CapabilityStatus = 'available' | 'requires_auth' | 'planned';

export interface InputSpec {
  type: InputType;
  description: string;
  required?: boolean;
  default?: string | number | boolean | string[];
  enum?: string[];
}

export type Handler = (ctx: Ctx, inputs: Record<string, any>) => Promise<Result>;

export interface CapabilityDef {
  name: string;
  command: string;
  summary: string;
  description?: string;
  domain: string;
  inputs: Record<string, InputSpec>;
  /** zod schema for `data`; JSON Schema is generated from it. */
  output?: z.ZodType;
  adapter: string;
  operation: Operation;
  auth_provider: string;
  capability_version: string;
  guide: string;
  status: CapabilityStatus;
  async?: boolean;
  idempotent?: boolean;
  cancellable?: boolean;
  side_effects?: string;
  prerequisites?: string[];
  examples?: string[];
  notes?: string[];
  backend_modes?: Array<'live' | 'recorded' | 'synthetic_fixture'>;
  handler?: Handler;
  origin?: string;
  /** JSON schema supplied directly (plugins), used when `output` is absent. */
  output_json_schema?: Record<string, unknown>;
  /** Where that schema lives (plugins ship schemas inside the plugin directory). */
  output_schema_path?: string;
}

export interface Probe {
  (ctx: Ctx, endpointName: string): Promise<{ ok: boolean; identity?: string; version?: string; detail?: string; privileges?: string[] }>;
}

export interface Planner {
  kind: string;
  summary: string;
  plan: (ctx: Ctx, params: Record<string, string>) => Promise<PlanDraft>;
}

export interface Executor {
  (ctx: Ctx, plan: Plan, report: (note: string) => void): Promise<unknown>;
}

export interface DomainDef {
  name: string;
  title: string;
  summary: string;
  pillar: 'infrastructure' | 'middleware' | 'offline' | 'supporting' | 'core';
  guide: string;
  skill?: string;
  capabilities: CapabilityDef[];
  probes?: Record<string, Probe>;
  planners?: Planner[];
  executors?: Record<string, Executor>;
  /** Map adapter-specific exceptions to WorkError; return undefined if not applicable. */
  mapError?: (e: unknown) => import('./output').WorkError | undefined;
}

export type CapabilityInit = Omit<CapabilityDef, 'status' | 'capability_version' | 'inputs'> &
  Partial<Pick<CapabilityDef, 'status' | 'capability_version' | 'inputs'>>;

export function defineCapability(def: CapabilityInit): CapabilityDef {
  return { status: 'available', capability_version: '1.0.0', inputs: {}, ...def };
}

export function defineDomain(def: DomainDef): DomainDef {
  return def;
}

export class Registry {
  readonly domains = new Map<string, DomainDef>();
  readonly capabilities = new Map<string, CapabilityDef>();
  readonly probes = new Map<string, Probe>();
  readonly planners = new Map<string, Planner>();
  readonly executors = new Map<string, Executor>();
  readonly errorMappers: NonNullable<DomainDef['mapError']>[] = [];

  /**
   * `fulfillPlanned`: a plugin may implement a domain/capabilities that the built-in catalog only
   * lists as planned; those planned entries are replaced instead of being reported as duplicates.
   */
  addDomain(d: DomainDef, opts: { fulfillPlanned?: boolean } = {}): void {
    if (this.domains.has(d.name)) {
      const onlyPlanned = [...this.capabilities.values()].filter((c) => c.domain === d.name).every((c) => c.status === 'planned');
      if (!(opts.fulfillPlanned && onlyPlanned)) throw new Error(`duplicate domain ${d.name}`);
    }
    // Skills are referenced by directory; accept a path to SKILL.md as well.
    if (d.skill?.endsWith('/SKILL.md')) d = { ...d, skill: d.skill.slice(0, -'/SKILL.md'.length) };
    this.domains.set(d.name, d);
    for (const c of d.capabilities) this.addCapability({ ...c, domain: c.domain ?? d.name }, opts);
    for (const [k, p] of Object.entries(d.probes ?? {})) this.probes.set(k, p);
    for (const p of d.planners ?? []) this.planners.set(p.kind, p);
    for (const [k, e] of Object.entries(d.executors ?? {})) this.executors.set(k, e);
    if (d.mapError) this.errorMappers.push(d.mapError);
  }

  addCapability(c: CapabilityDef, opts: { fulfillPlanned?: boolean } = {}): void {
    const existing = this.capabilities.get(c.name);
    if (existing) {
      if (!(opts.fulfillPlanned && existing.status === 'planned' && (existing.origin ?? 'builtin') === 'builtin')) throw new Error(`duplicate capability ${c.name}`);
      this.capabilities.delete(c.name);
    }
    if (c.status !== 'planned' && !c.handler) throw new Error(`capability ${c.name} is ${c.status} but has no handler`);
    for (const other of this.capabilities.values()) {
      if (other.status !== 'planned' && c.status !== 'planned' && other.command === c.command) {
        throw new Error(`duplicate command "${c.command}" (${other.name}, ${c.name})`);
      }
    }
    this.capabilities.set(c.name, c);
  }

  get(name: string): CapabilityDef | undefined {
    return this.capabilities.get(name);
  }

  list(filter: { domain?: string; status?: string; operation?: string; query?: string } = {}): CapabilityDef[] {
    const q = filter.query?.toLowerCase();
    return [...this.capabilities.values()]
      .filter((c) => !filter.domain || c.domain === filter.domain)
      .filter((c) => !filter.status || c.status === filter.status)
      .filter((c) => !filter.operation || c.operation === filter.operation)
      .filter((c) => !q || `${c.name} ${c.command} ${c.summary} ${c.description ?? ''}`.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** JSON Schema of the `data` field, generated from the zod definition. */
  outputJsonSchema(c: CapabilityDef): Record<string, unknown> | undefined {
    if (c.output) return z.toJSONSchema(c.output, { unrepresentable: 'any', io: 'output' }) as Record<string, unknown>;
    return c.output_json_schema;
  }
}

export function outputSchemaPath(c: CapabilityDef): string | undefined {
  if (c.output_schema_path) return c.output_schema_path;
  if (!c.output && !c.output_json_schema) return undefined;
  return `docs/schemas/${c.name}.v${c.capability_version.split('.')[0]}.json`;
}

/** The public, serialisable view of a capability (what `capability get` prints). */
export function describeCapability(c: CapabilityDef): Record<string, unknown> {
  return {
    name: c.name,
    command: c.command,
    summary: c.summary,
    ...(c.description ? { description: c.description } : {}),
    domain: c.domain,
    status: c.status,
    inputs: Object.fromEntries(
      Object.entries(c.inputs).map(([k, v]) => [
        k,
        {
          type: v.type,
          required: v.required ?? false,
          ...(v.default !== undefined ? { default: v.default } : {}),
          ...(v.enum ? { enum: v.enum } : {}),
          description: v.description,
        },
      ]),
    ),
    output_schema: outputSchemaPath(c) ?? null,
    adapter: c.adapter,
    operation: c.operation,
    auth_provider: c.auth_provider,
    capability_version: c.capability_version,
    guide: c.guide,
    ...(c.async !== undefined ? { async: c.async } : {}),
    ...(c.idempotent !== undefined ? { idempotent: c.idempotent } : {}),
    ...(c.cancellable !== undefined ? { cancellable: c.cancellable } : {}),
    ...(c.side_effects ? { side_effects: c.side_effects } : {}),
    ...(c.prerequisites?.length ? { prerequisites: c.prerequisites } : {}),
    ...(c.backend_modes?.length ? { backend_modes: c.backend_modes } : {}),
    ...(c.notes?.length ? { notes: c.notes } : {}),
    ...(c.examples?.length ? { examples: c.examples } : {}),
    origin: c.origin ?? 'builtin',
  };
}
