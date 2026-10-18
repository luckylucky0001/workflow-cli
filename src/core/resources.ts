import { existsSync, readFileSync } from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import { yamlErrorSummary } from './config';
import { WorkError } from './output';

export const ResourceSchema = z.object({
  id: z.string(),
  type: z.string().describe('如 service、container.workload、mysql.instance、redis.instance、offline.workflow、data.table'),
  env: z.string().optional(),
  name: z.string().optional(),
  owner: z.string().optional(),
  region: z.string().optional(),
  endpoint: z.object({ kind: z.string(), name: z.string() }).optional().describe('对应 profile 中的端点'),
  labels: z.record(z.string(), z.string()).default({}),
  attributes: z.record(z.string(), z.unknown()).default({}),
});
export type Resource = z.infer<typeof ResourceSchema>;

export const RelationSchema = z.object({
  from: z.string(),
  to: z.string(),
  type: z.enum(['depends_on', 'reads_from', 'writes_to', 'runs_on', 'exposed_by', 'produces', 'consumes', 'scheduled_by', 'stores_in']),
  source: z.string().describe('关系来源，如 binding-file、service-config、scheduler-metadata'),
  evidence: z.string().optional(),
});
export type Relation = z.infer<typeof RelationSchema>;

export const BindingsSchema = z.object({
  schema_version: z.string().default('1.0'),
  resources: z.array(ResourceSchema).default([]),
  relations: z.array(RelationSchema).default([]),
});

export class ResourceStore {
  private constructor(
    readonly path: string | null,
    readonly resources: Resource[],
    readonly relations: Relation[],
  ) {}

  static load(path: string | null): ResourceStore {
    if (!path) return new ResourceStore(null, [], []);
    if (!existsSync(path)) throw new WorkError('NOT_CONFIGURED', `资源绑定文件不存在: ${path}`);
    let raw: unknown;
    try {
      raw = YAML.parse(readFileSync(path, 'utf8')) ?? {};
    } catch (e) {
      throw new WorkError('INVALID_ARGUMENT', `资源绑定文件无法解析: ${path}`, { details: { reason: yamlErrorSummary(e) } });
    }
    const parsed = BindingsSchema.safeParse(raw);
    if (!parsed.success) {
      throw new WorkError('INVALID_ARGUMENT', `资源绑定文件不合法: ${path}`, {
        details: { issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
      });
    }
    const ids = new Set<string>();
    for (const r of parsed.data.resources) {
      if (ids.has(r.id)) throw new WorkError('INVALID_ARGUMENT', `资源绑定文件中资源 ID 重复: ${r.id}`);
      ids.add(r.id);
    }
    return new ResourceStore(path, parsed.data.resources, parsed.data.relations);
  }

  get configured(): boolean {
    return this.path !== null;
  }

  get(id: string): Resource | undefined {
    return this.resources.find((r) => r.id === id);
  }

  require(id: string, type?: string): Resource {
    const r = this.get(id);
    if (!r || (type && r.type !== type)) {
      throw new WorkError('NOT_FOUND', `资源绑定中没有${type ? ` ${type}` : ''} ${id}`, {
        hint: this.configured ? '用 workctl resource list 查看已绑定资源' : '当前 profile 未配置 resources_file',
      });
    }
    return r;
  }

  list(filter: { type?: string; env?: string } = {}): Resource[] {
    return this.resources.filter((r) => (!filter.type || r.type === filter.type || r.type.startsWith(`${filter.type}.`)) && (!filter.env || !r.env || r.env === filter.env));
  }

  relationsOf(id: string, direction: 'downstream' | 'upstream' | 'both' = 'downstream'): Relation[] {
    return this.relations.filter((r) => (direction !== 'upstream' && r.from === id) || (direction !== 'downstream' && r.to === id));
  }

  /** Transitive dependencies reachable from `id` following `from -> to`. */
  closure(id: string, maxDepth = 4): { resource: Resource | undefined; relation: Relation; depth: number }[] {
    const out: { resource: Resource | undefined; relation: Relation; depth: number }[] = [];
    const seen = new Set<string>([id]);
    let frontier = [id];
    for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
      const next: string[] = [];
      for (const cur of frontier) {
        for (const rel of this.relationsOf(cur, 'downstream')) {
          out.push({ resource: this.get(rel.to), relation: rel, depth });
          if (!seen.has(rel.to)) {
            seen.add(rel.to);
            next.push(rel.to);
          }
        }
      }
      frontier = next;
    }
    return out;
  }

  /** Find the bound resource for an endpoint (e.g. kind=mysql name=demo-mysql). */
  forEndpoint(kind: string, name: string): Resource | undefined {
    return this.resources.find((r) => r.endpoint?.kind === kind && r.endpoint?.name === name) ?? this.get(name);
  }
}
