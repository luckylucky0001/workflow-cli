import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Skills are distributed with the CLI and chosen by description alone: run the same static lint as
 * `node scripts/skill-lint.mjs` (frontmatter/description, every `workctl …` command and flag resolved
 * against the built CLI, planned capabilities labelled, referenced paths exist, no secret literals).
 */
const root = join(__dirname, '../..');
const cli = join(root, 'dist/workctl.js');

describe('skills contract', () => {
  it.skipIf(!existsSync(cli))('every SKILL.md passes scripts/skill-lint.mjs against the built CLI', () => {
    let out: string;
    try {
      out = execFileSync('node', [join(root, 'scripts/skill-lint.mjs'), '--json'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, WORKCTL_CONFIG: join(root, 'demo/environment/workctl.yaml') },
      });
    } catch (e) {
      out = (e as { stdout?: string }).stdout ?? '';
    }
    const { findings } = JSON.parse(out) as { findings: { skill: string; type: string; detail: string }[] };
    expect(findings.map((f) => `${f.skill} [${f.type}] ${f.detail}`)).toEqual([]);
  }, 180_000);
});
