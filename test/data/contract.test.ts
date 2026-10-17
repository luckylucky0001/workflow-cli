import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Registry } from '../../src/core/registry';
import dataDomain from '../../src/domains/data';

/** Same checks as test/contract/registry.test.ts, scoped to the data domain. */
describe('data domain contract', () => {
  const reg = new Registry();
  reg.addDomain(dataDomain);
  const caps = reg.list();
  const commands = new Map(caps.map((c) => [c.command, c]));

  it('registers the design commands (transfer get planned)', () => {
    for (const c of ['data table get', 'data partition list', 'data partition get', 'data lineage get', 'data quality check', 'data transfer get']) expect(commands.has(c)).toBe(true);
    expect(commands.get('data transfer get')?.status).toBe('planned');
  });

  it('available capabilities have handler, output schema, guide, snake_case inputs and valid examples', () => {
    const problems: string[] = [];
    for (const c of caps.filter((x) => x.status !== 'planned')) {
      if (!c.handler || !c.output) problems.push(`${c.name}: handler/output`);
      if (!existsSync(c.guide)) problems.push(`${c.name}: guide`);
      for (const k of Object.keys(c.inputs)) if (!/^[a-z][a-z0-9_]*$/.test(k)) problems.push(`${c.name}: ${k}`);
      expect(() => reg.outputJsonSchema(c)).not.toThrow();
      for (const ex of c.examples ?? []) {
        const words: string[] = [];
        for (const t of ex.split(/\s+/).filter((t) => t !== 'workctl' && t !== '--json')) {
          if (t.startsWith('-')) break;
          words.push(t);
        }
        const target = commands.get(words.join(' '));
        if (!target) problems.push(`${c.name}: example command ${words.join(' ')}`);
        for (const m of ex.matchAll(/--([a-z][a-z0-9-]*)/g)) if (target && !(m[1].replace(/-/g, '_') in target.inputs)) problems.push(`${c.name}: flag --${m[1]}`);
      }
    }
    expect(problems).toEqual([]);
    const d = reg.domains.get('data')!;
    expect(existsSync(d.guide)).toBe(true);
    expect(existsSync(join(d.skill!, 'SKILL.md'))).toBe(true);
  });
});
