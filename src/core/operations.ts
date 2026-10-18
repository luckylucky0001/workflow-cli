import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { WorkError } from './output';

export const PlanStatus = z.enum(['planned', 'running', 'succeeded', 'failed', 'cancelled', 'expired']);

export const PlanSchema = z.object({
  id: z.string(),
  kind: z.string().describe('如 container.restart、mysql.index.create、offline.backfill'),
  title: z.string(),
  status: PlanStatus,
  created_at: z.string(),
  expires_at: z.string(),
  profile: z.string().nullable(),
  env: z.string().nullable(),
  params: z.record(z.string(), z.unknown()),
  targets: z.array(z.record(z.string(), z.unknown())).describe('计划生成时实际解析出的目标对象'),
  impact: z.record(z.string(), z.unknown()).describe('影响范围预览'),
  preconditions: z.array(z.object({ check: z.string(), ok: z.boolean(), detail: z.string().optional() })),
  steps: z.array(z.object({ name: z.string(), detail: z.string() })),
  rollback: z.string().optional(),
  idempotent: z.boolean(),
  cancellable: z.boolean(),
  executable: z.boolean().describe('是否已有对应执行器；为 false 时只能作为方案参考'),
  history: z.array(z.object({ at: z.string(), status: PlanStatus, note: z.string() })),
  result: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  digest: z.string().optional().describe('sha256（规范化 JSON，不含 digest 本身）；由计划存储写入时封存、读取时校验，用于发现计划文件被手工改动'),
});
export type Plan = z.infer<typeof PlanSchema>;

export type PlanDraft = Pick<Plan, 'kind' | 'title' | 'params' | 'targets' | 'impact' | 'preconditions' | 'steps' | 'idempotent' | 'cancellable'> & {
  rollback?: string;
  ttlMs?: number;
};

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  return v;
}

/** Content digest of a plan: sha256 over canonical JSON (sorted keys, JSON round-trip) of every field but `digest`. */
export function planDigest(plan: Plan): string {
  const { digest: _d, ...rest } = plan;
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(JSON.parse(JSON.stringify(rest))))).digest('hex')}`;
}

export class PlanStore {
  constructor(readonly dir: string) {}

  private file(id: string): string {
    if (!/^op-[0-9]{8}-[a-z0-9]{6}$/.test(id)) throw new WorkError('INVALID_ARGUMENT', `计划 ID 格式不正确: ${id}`);
    return join(this.dir, `${id}.json`);
  }

  create(draft: PlanDraft, meta: { profile: string | null; env: string | null; executable: boolean }): Plan {
    mkdirSync(this.dir, { recursive: true });
    const now = new Date();
    const id = `op-${now.toISOString().slice(0, 10).replaceAll('-', '')}-${randomBytes(4).toString('hex').slice(0, 6)}`;
    const { ttlMs, ...rest } = draft;
    const plan: Plan = {
      id,
      ...rest,
      status: 'planned',
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + (ttlMs ?? 3_600_000)).toISOString(),
      profile: meta.profile,
      env: meta.env,
      executable: meta.executable,
      history: [{ at: now.toISOString(), status: 'planned', note: '计划已生成，未执行' }],
    };
    this.save(plan);
    return plan;
  }

  save(plan: Plan): void {
    mkdirSync(this.dir, { recursive: true });
    const f = this.file(plan.id);
    const tmp = `${f}.tmp`;
    // (re)sealed on every store write: status/history updates go through here, edits on disk do not
    plan.digest = planDigest(plan);
    writeFileSync(tmp, JSON.stringify(plan, null, 2));
    renameSync(tmp, f);
  }

  get(id: string): Plan {
    const f = this.file(id);
    if (!existsSync(f)) throw new WorkError('NOT_FOUND', `计划不存在: ${id}`, { hint: '用 workctl operation list 查看当前 profile 的计划' });
    let plan: Plan;
    try {
      plan = PlanSchema.parse(JSON.parse(readFileSync(f, 'utf8')));
    } catch {
      throw new WorkError('PRECONDITION_FAILED', `计划文件已损坏或结构不合法: ${id}`, { hint: '重新生成计划（operation plan）' });
    }
    // a file renamed/copied to another id would be locked under one id but written under another
    if (plan.id !== id) throw new WorkError('PRECONDITION_FAILED', `计划文件 ${id}.json 中的 ID 为 ${plan.id}，与文件名不一致`, { hint: '计划文件被改动过；重新生成计划' });
    // preconditions, params, targets, status... must be what the planner/store wrote
    if (!plan.digest || plan.digest !== planDigest(plan)) {
      throw new WorkError('PRECONDITION_FAILED', `plan file was modified: 计划文件 ${id}.json 的内容与封存摘要不一致（不是由 workctl 写入）`, { hint: '不要手工编辑计划文件；重新生成计划（operation plan）' });
    }
    if (plan.status === 'planned' && Date.parse(plan.expires_at) < Date.now()) {
      plan.status = 'expired';
      plan.history.push({ at: new Date().toISOString(), status: 'expired', note: '超过有效期未执行' });
      this.save(plan);
    }
    return plan;
  }

  transition(id: string, status: Plan['status'], note: string, patch: Partial<Pick<Plan, 'result' | 'error'>> = {}): Plan {
    const plan = this.get(id);
    plan.status = status;
    plan.history.push({ at: new Date().toISOString(), status, note });
    Object.assign(plan, patch);
    this.save(plan);
    return plan;
  }

  /**
   * Exclusive claim on a plan for execution (O_EXCL lock file), so two processes
   * (two terminals, concurrent MCP calls) cannot both run the same plan.
   * Returns a release function.
   */
  lock(id: string): () => void {
    const lockFile = `${this.file(id)}.lock`;
    mkdirSync(this.dir, { recursive: true });
    let fd: number;
    try {
      fd = openSync(lockFile, 'wx');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new WorkError('CONFLICT', `计划 ${id} 正在被另一个执行请求处理`, {
          hint: `用 workctl operation get --id ${id} 查看状态；若确认没有进程在执行，删除锁文件 ${lockFile}`,
        });
      }
      throw e;
    }
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    closeSync(fd);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        unlinkSync(lockFile);
      } catch {
        /* already gone */
      }
    };
  }

  list(filter: { kind?: string; status?: string } = {}): Plan[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => /^op-[0-9]{8}-[a-z0-9]{6}\.json$/.test(f))
      .flatMap((f) => {
        try {
          return [this.get(f.slice(0, -5))];
        } catch {
          return [];
        }
      })
      .filter((p) => (!filter.kind || p.kind === filter.kind) && (!filter.status || p.status === filter.status))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
}
