import { constants as fsc, promises as fs, type Stats } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { source, WorkError, type Result } from '../../core/output';
import { defineCapability, defineDomain } from '../../core/registry';
import { containerName, DOCKER_ADAPTER, dockerClient, filtersParam, type ContainerSummary } from '../container/docker';

const GUIDE = 'docs/guides/infrastructure.md';

// ---------------------------------------------------------------------------
// storage volume get
// ---------------------------------------------------------------------------
interface DockerVolume {
  Name: string;
  Driver: string;
  Mountpoint: string;
  CreatedAt?: string;
  Labels: Record<string, string> | null;
  Scope: string;
  Options: Record<string, string> | null;
  UsageData?: { Size: number; RefCount: number } | null;
}

const volumeGet = defineCapability({
  name: 'storage.volume.get',
  command: 'storage volume get',
  domain: 'storage',
  summary: '查看 Docker 卷的驱动、挂载点、标签、作用域、占用大小和挂载它的容器',
  inputs: { id: { type: 'string', required: true, description: '卷名（如 workctl-demo_mysql-data）' } },
  output: z.object({
    name: z.string(),
    driver: z.string(),
    mountpoint: z.string(),
    scope: z.string(),
    created_at: z.string().nullable(),
    labels: z.record(z.string(), z.string()),
    options: z.record(z.string(), z.string()),
    usage: z.object({
      status: z.enum(['available', 'unavailable']),
      size_bytes: z.number().nullable(),
      ref_count: z.number().nullable(),
      note: z.string().nullable(),
    }),
    used_by: z.array(z.object({ name: z.string(), id: z.string(), state: z.string(), destination: z.string().nullable(), rw: z.boolean().nullable() })),
  }),
  adapter: DOCKER_ADAPTER,
  operation: 'read',
  auth_provider: 'docker-socket',
  guide: GUIDE,
  prerequisites: ['endpoints.docker 可访问'],
  notes: [
    '占用大小来自 /system/df?type=volume（守护进程现场计算，可能较慢）；不可用时 usage.status=unavailable 并说明原因，不推算',
    '对象存储（S3）与 HDFS 是规划中的 provider',
  ],
  examples: ['workctl storage volume get --id workctl-demo_mysql-data'],
  handler: async (ctx, i): Promise<Result> => {
    const docker = dockerClient(ctx);
    const name = String(i.id);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) throw new WorkError('INVALID_ARGUMENT', `卷名不合法: ${name}`);
    const r = await docker.get<DockerVolume>(`/volumes/${encodeURIComponent(name)}`, { allowStatus: [404] });
    if (r.status === 404) {
      const all = await docker.getJson<{ Volumes: DockerVolume[] | null }>('/volumes').catch(() => ({ Volumes: [] as DockerVolume[] }));
      const names = (all.Volumes ?? []).map((v) => v.Name).filter((n) => !/^[0-9a-f]{64}$/.test(n)).slice(0, 10);
      throw new WorkError('NOT_FOUND', `Docker 卷不存在: ${name}`, { hint: names.length ? `该主机上的具名卷（前 10 个）: ${names.join(', ')}` : '该主机上没有具名卷' });
    }
    const v = typeof r.body === 'string' ? (JSON.parse(r.body) as DockerVolume) : r.body;
    const usage: { status: 'available' | 'unavailable'; size_bytes: number | null; ref_count: number | null; note: string | null } = {
      status: 'unavailable',
      size_bytes: null,
      ref_count: null,
      note: null,
    };
    const sources = [await docker.source(`GET /volumes/${name}`)];
    try {
      const df = await docker.get<{ Volumes?: DockerVolume[] | null }>('/system/df?type=volume', { timeoutMs: Math.min(15_000, ctx.remainingMs()) });
      const body = typeof df.body === 'string' ? (JSON.parse(df.body) as { Volumes?: DockerVolume[] | null }) : df.body;
      const hit = (body.Volumes ?? []).find((x) => x.Name === name);
      if (hit?.UsageData && hit.UsageData.Size >= 0) {
        usage.status = 'available';
        usage.size_bytes = hit.UsageData.Size;
        usage.ref_count = hit.UsageData.RefCount;
      } else {
        usage.note = hit ? '守护进程未计算该卷大小（UsageData.Size=-1，常见于非 local 驱动）' : '/system/df 未返回该卷';
        if (hit?.UsageData) usage.ref_count = hit.UsageData.RefCount >= 0 ? hit.UsageData.RefCount : null;
      }
      sources.push(await docker.source('GET /system/df?type=volume'));
    } catch (e) {
      usage.note = `/system/df 不可用: ${e instanceof Error ? e.message : String(e)}`;
    }
    const users = await docker.getJson<ContainerSummary[]>(`/containers/json?all=1&filters=${filtersParam({ volume: [name] })}`);
    const usedBy = [];
    for (const c of users) {
      const insp = await docker.getJson<{ Mounts?: { Name?: string; Destination: string; RW: boolean }[] }>(`/containers/${c.Id}/json`);
      const m = insp.Mounts?.find((x) => x.Name === name);
      usedBy.push({ name: containerName(c), id: c.Id.slice(0, 12), state: c.State, destination: m?.Destination ?? null, rw: m?.RW ?? null });
    }
    sources.push(await docker.source('GET /containers/json?filters={volume}'));
    return {
      data: {
        name: v.Name,
        driver: v.Driver,
        mountpoint: v.Mountpoint,
        scope: v.Scope,
        created_at: v.CreatedAt ?? null,
        labels: v.Labels ?? {},
        options: v.Options ?? {},
        usage,
        used_by: usedBy,
      },
      sources,
      coverage: {
        complete: usage.status === 'available',
        scope: `Docker 主机 ${docker.endpointId}`,
        notes: usage.status === 'available' ? ['size_bytes 为守护进程本次计算的快照'] : [`占用大小不可用: ${usage.note}`],
      },
    };
  },
});

// ---------------------------------------------------------------------------
// storage file stat
// ---------------------------------------------------------------------------
function fileType(s: Stats): string {
  if (s.isFile()) return 'file';
  if (s.isDirectory()) return 'directory';
  if (s.isSymbolicLink()) return 'symlink';
  if (s.isSocket()) return 'socket';
  if (s.isFIFO()) return 'fifo';
  if (s.isBlockDevice()) return 'block_device';
  if (s.isCharacterDevice()) return 'char_device';
  return 'unknown';
}

async function can(path: string, mode: number): Promise<boolean> {
  try {
    await fs.access(path, mode);
    return true;
  } catch {
    return false;
  }
}

const MAX_ENTRIES = 10_000;

const fileStat = defineCapability({
  name: 'storage.file.stat',
  command: 'storage file stat',
  domain: 'storage',
  summary: '查看本机文件或目录的类型、大小、修改时间、权限与可读性（不读取内容）',
  inputs: { path: { type: 'string', required: true, description: '文件或目录路径（相对路径按当前目录解析）' } },
  output: z.object({
    path: z.string(),
    absolute_path: z.string(),
    type: z.string(),
    size_bytes: z.number(),
    mode: z.string().describe('八进制权限，如 0644'),
    uid: z.number(),
    gid: z.number(),
    mtime: z.string(),
    ctime: z.string(),
    readable: z.boolean().describe('当前进程身份是否可读'),
    writable: z.boolean(),
    symlink_target: z.string().nullable(),
    target_type: z.string().nullable().describe('符号链接指向对象的类型'),
    directory: z.object({ entries: z.number(), truncated: z.boolean() }).nullable().describe('目录的直接子项数量（不递归）'),
  }),
  adapter: 'node-fs',
  operation: 'read',
  auth_provider: 'local-user',
  guide: GUIDE,
  notes: [
    '只读元数据（lstat/stat/access），不读取文件内容',
    'readable/writable 反映运行 workctl 的用户权限，不代表其他服务账号的权限',
    '数据产出检查（分区/文件是否存在、可读）与调度成功是不同检查项',
  ],
  examples: ['workctl storage file stat --path demo/environment/workctl.yaml'],
  handler: async (_ctx, i): Promise<Result> => {
    const path = String(i.path);
    const abs = resolve(path);
    let st: Stats;
    try {
      st = await fs.lstat(abs);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') throw new WorkError('NOT_FOUND', `路径不存在: ${abs}`);
      if (code === 'EACCES' || code === 'EPERM') throw new WorkError('PERMISSION_DENIED', `无权访问路径: ${abs}`, { hint: '检查父目录的执行权限' });
      throw e;
    }
    let symlinkTarget: string | null = null;
    let targetType: string | null = null;
    if (st.isSymbolicLink()) {
      symlinkTarget = await fs.readlink(abs);
      try {
        targetType = fileType(await fs.stat(abs));
      } catch {
        targetType = 'dangling';
      }
    }
    let directory: { entries: number; truncated: boolean } | null = null;
    const notes: string[] = [];
    if (st.isDirectory()) {
      try {
        const dir = await fs.opendir(abs);
        let n = 0;
        let truncated = false;
        for await (const _ of dir) {
          // truncated only when an entry beyond the budget actually exists
          if (n >= MAX_ENTRIES) {
            truncated = true;
            break;
          }
          n++;
        }
        if (truncated) await dir.close().catch(() => undefined);
        directory = { entries: n, truncated };
        if (truncated) notes.push(`目录子项超过 ${MAX_ENTRIES}，计数已截断`);
      } catch (e) {
        notes.push(`无法列出目录: ${(e as NodeJS.ErrnoException).code}`);
      }
    }
    return {
      data: {
        path,
        absolute_path: abs,
        type: fileType(st),
        size_bytes: st.size,
        mode: `0${(st.mode & 0o7777).toString(8)}`,
        uid: st.uid,
        gid: st.gid,
        mtime: st.mtime.toISOString(),
        ctime: st.ctime.toISOString(),
        readable: await can(abs, fsc.R_OK),
        writable: await can(abs, fsc.W_OK),
        symlink_target: symlinkTarget,
        target_type: targetType,
        directory,
      },
      sources: [source('local-filesystem', 'node-fs', { method: 'lstat/stat/access', endpoint: 'local-filesystem', relation: 'explicit' })],
      coverage: { complete: !directory?.truncated, scope: 'storage: local-filesystem（运行 workctl 的主机）', notes },
    };
  },
});

// ---------------------------------------------------------------------------
// planned providers
// ---------------------------------------------------------------------------
const objectStat = defineCapability({
  name: 'storage.object.stat',
  command: 'object stat',
  domain: 'storage',
  summary: '查看对象存储（S3 兼容）对象的大小、ETag、修改时间与存储类型（规划中）',
  adapter: 's3-api (待接入)',
  operation: 'read',
  auth_provider: 'access-key-ref',
  guide: GUIDE,
  status: 'planned',
});

const hdfsStat = defineCapability({
  name: 'storage.hdfs.stat',
  command: 'hdfs path stat',
  domain: 'storage',
  summary: '查看 HDFS 路径的大小、副本数、修改时间与配额（规划中：WebHDFS）',
  adapter: 'webhdfs (待接入)',
  operation: 'read',
  auth_provider: 'kerberos',
  guide: GUIDE,
  status: 'planned',
});

export default defineDomain({
  name: 'storage',
  title: '存储',
  summary: 'Docker 卷与本机文件系统元数据；对象存储与 HDFS 规划中',
  pillar: 'infrastructure',
  guide: GUIDE,
  skill: 'skills/resource-capacity-review/SKILL.md',
  capabilities: [volumeGet, fileStat, objectStat, hdfsStat],
});
