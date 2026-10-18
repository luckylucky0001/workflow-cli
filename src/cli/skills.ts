import { createHash } from 'node:crypto';
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { CLI_VERSION } from '../core/engine';
import { WorkError } from '../core/output';

/** Skills ship next to the bundle (dist/../skills) and in the repo root during development. */
export function skillsRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [join(here, '..', 'skills'), join(here, '..', '..', 'skills'), resolve('skills')]) {
    if (existsSync(c)) return c;
  }
  throw new WorkError('NOT_FOUND', '找不到随 CLI 发布的 skills 目录');
}

interface SkillInfo {
  name: string;
  description: string;
  path: string;
}

export function listSkills(): { version: string; root: string; skills: SkillInfo[] } {
  const root = skillsRoot();
  const skills: SkillInfo[] = [];
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const f = join(root, d.name, 'SKILL.md');
    if (!existsSync(f)) continue;
    const m = /^---\n([\s\S]*?)\n---/.exec(readFileSync(f, 'utf8'));
    const fm = m ? (YAML.parse(m[1]) as { name?: string; description?: string }) : {};
    skills.push({ name: fm.name ?? d.name, description: String(fm.description ?? '').trim(), path: join(root, d.name) });
  }
  return { version: CLI_VERSION, root, skills: skills.sort((a, b) => a.name.localeCompare(b.name)) };
}

/** Content hash of an installed skill directory (relative paths + file bytes), to detect local edits. */
export function skillDirHash(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) h.update(relative(dir, f)).update('\0').update(readFileSync(f)).update('\0');
    }
  };
  walk(dir);
  return h.digest('hex');
}

type SkillLock = Record<string, { version: string; installed_at: string; sha256?: string }>;

/** An installed copy whose content no longer matches what workctl wrote (only knowable when the lock has a hash). */
function locallyModified(lock: SkillLock, name: string, dest: string): boolean {
  const recorded = lock[name]?.sha256;
  return !!recorded && existsSync(dest) && skillDirHash(dest) !== recorded;
}

export function installSkills(targetDir: string, names: string[] | undefined, force: boolean) {
  const { skills, version } = listSkills();
  const chosen = names?.length ? skills.filter((s) => names.includes(s.name)) : skills;
  const missing = (names ?? []).filter((n) => !skills.some((s) => s.name === n));
  if (missing.length) throw new WorkError('NOT_FOUND', `Skill 不存在: ${missing.join(', ')}`);
  mkdirSync(targetDir, { recursive: true });
  const lockFile = join(targetDir, '.workctl-skills.json');
  const lock: SkillLock = existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, 'utf8')) : {};
  const results = [];
  for (const s of chosen) {
    const dest = join(targetDir, s.name);
    const prev = lock[s.name]?.version ?? (existsSync(dest) ? 'unmanaged' : null);
    if (prev && prev !== version && !force) {
      results.push({ name: s.name, action: 'skipped', reason: `已存在版本 ${prev}，使用 --force 覆盖`, previous_version: prev });
      continue;
    }
    // same version re-install must not silently discard local edits
    if (!force && locallyModified(lock, s.name, dest)) {
      results.push({ name: s.name, action: 'skipped', reason: '已安装的 Skill 有本地修改，使用 --force 覆盖', previous_version: prev });
      continue;
    }
    cpSync(s.path, dest, { recursive: true });
    lock[s.name] = { version, installed_at: new Date().toISOString(), sha256: skillDirHash(dest) };
    results.push({ name: s.name, action: prev ? 'updated' : 'installed', previous_version: prev });
  }
  writeFileSync(lockFile, JSON.stringify(lock, null, 2));
  return {
    target: resolve(targetDir),
    version,
    results,
    verify: '在 Agent 宿主中确认 Skill 已被发现，例如询问“列出可用的 skills”，或检查宿主的 skills 列表',
  };
}

/** Compare skills installed in a project directory with the ones shipped by this CLI version. */
export function skillsStatus(targetDir: string) {
  const { skills, version } = listSkills();
  const lockFile = join(targetDir, '.workctl-skills.json');
  const lock: SkillLock = existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, 'utf8')) : {};
  return {
    target: resolve(targetDir),
    cli_version: version,
    skills: skills.map((s) => {
      const installed = lock[s.name]?.version ?? (existsSync(join(targetDir, s.name)) ? 'unmanaged' : null);
      const state = installed === null ? 'not_installed' : installed !== version ? 'outdated' : locallyModified(lock, s.name, join(targetDir, s.name)) ? 'modified' : 'current';
      return { name: s.name, installed_version: installed, state };
    }),
    hint: '版本不一致时运行 workctl skills install --dir <dir> --force；回退：安装对应版本的 workctl 后再执行同一命令',
  };
}
