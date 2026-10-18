/** skills install / status must not silently discard local edits of an installed skill. */
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installSkills, listSkills, skillsStatus } from '../../src/cli/skills';
import { tempDir } from './helpers';

describe('skills install', () => {
  it('skips a locally modified skill on re-install of the same version unless --force', () => {
    const dir = tempDir();
    const name = listSkills().skills[0].name;
    expect(installSkills(dir, [name], false).results[0].action).toBe('installed');
    const f = join(dir, name, 'SKILL.md');
    appendFileSync(f, '\n<!-- local team note -->\n');
    expect(skillsStatus(dir).skills.find((s) => s.name === name)?.state).toBe('modified');

    const again = installSkills(dir, [name], false).results[0];
    expect(again.action).toBe('skipped');
    expect(readFileSync(f, 'utf8')).toContain('local team note');

    expect(installSkills(dir, [name], true).results[0].action).toBe('updated');
    expect(readFileSync(f, 'utf8')).not.toContain('local team note');
    expect(skillsStatus(dir).skills.find((s) => s.name === name)?.state).toBe('current');
  });

  it('re-installs an unmodified skill of the same version', () => {
    const dir = tempDir();
    const name = listSkills().skills[0].name;
    installSkills(dir, [name], false);
    expect(installSkills(dir, [name], false).results[0].action).toBe('updated');
  });
});
