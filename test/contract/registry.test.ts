import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateDocs } from '../../src/cli/docsgen';
import { builtinRegistry } from '../../src/domains';
import { toolsFor } from '../../src/mcp/server';
import { tempDir } from '../core/helpers';

/** Every command named in the design document must exist (available or planned). */
const DESIGN_COMMANDS = [
  'resource list', 'service dependency list', 'compute instance get', 'container workload get', 'network dns get', 'network backend list',
  'storage volume get', 'storage file stat', 'object stat', 'config get', 'config diff', 'discovery list', 'metric query', 'log query', 'trace get',
  'auth status', 'access check', 'quota get', 'capacity summary', 'operation plan', 'operation get',
  'mysql table get', 'mysql query explain', 'redis info get', 'redis key inspect', 'search index get', 'search query', 'document collection get', 'kv query',
  'analytics query get', 'analytics table get', 'middleware operation plan',
  'offline workflow get', 'offline task get', 'offline dependency list', 'offline run get', 'offline run list', 'sql query submit', 'sql query get',
  'compute job get', 'compute stage list', 'compute log get', 'compute queue get', 'data table get', 'data partition list', 'data partition get',
  'data lineage get', 'data quality check', 'offline backfill plan', 'offline backfill get', 'data transfer get', 'offline freshness check',
  'mysql instance get', 'mysql index list', 'mysql session list', 'mysql lock list', 'mysql statement summary', 'mysql query execute',
  'redis instance get', 'redis stats sample', 'redis slowlog list', 'redis key sample', 'container event list',
];

describe('capability registry contract', () => {
  const reg = builtinRegistry();
  const caps = reg.list();
  const available = caps.filter((c) => c.status !== 'planned');
  const commands = new Map(caps.map((c) => [c.command, c]));

  it('covers every command from the design (available or planned)', () => {
    const missing = DESIGN_COMMANDS.filter((c) => !commands.has(c));
    expect(missing).toEqual([]);
  });

  it('gives every available capability a handler, output schema, guide and summary', () => {
    const problems: string[] = [];
    for (const c of available) {
      if (!c.handler) problems.push(`${c.name}: no handler`);
      if (!c.output) problems.push(`${c.name}: no output schema`);
      if (!c.summary) problems.push(`${c.name}: no summary`);
      if (!existsSync(c.guide)) problems.push(`${c.name}: guide missing ${c.guide}`);
      if (!/^\d+\.\d+\.\d+$/.test(c.capability_version)) problems.push(`${c.name}: bad version`);
      for (const k of Object.keys(c.inputs)) if (!/^[a-z][a-z0-9_]*$/.test(k)) problems.push(`${c.name}: input ${k} not snake_case`);
      if (c.output) expect(() => reg.outputJsonSchema(c)).not.toThrow();
    }
    expect(problems).toEqual([]);
  });

  it('has domain guides and skills that exist', () => {
    const problems: string[] = [];
    for (const d of reg.domains.values()) {
      if (!caps.some((c) => c.domain === d.name)) continue;
      if (!existsSync(d.guide)) problems.push(`${d.name}: guide ${d.guide}`);
      if (d.skill && !existsSync(join(d.skill, 'SKILL.md'))) problems.push(`${d.name}: skill ${d.skill}`);
    }
    expect(problems).toEqual([]);
  });

  it('only uses registered commands and flags in examples', () => {
    const problems: string[] = [];
    for (const c of available) {
      for (const ex of c.examples ?? []) {
        const tokens = ex.split(/\s+/).filter((t) => t !== 'workctl');
        const words: string[] = [];
        // skip global options (with their values) that may precede the command
        const globalsWithValue = new Set(['--timeout', '--profile', '--config', '-o', '--output', '--request-id']);
        for (let k = 0; k < tokens.length; k++) {
          const t = tokens[k];
          if (globalsWithValue.has(t)) {
            k++;
            continue;
          }
          if (['--json', '--debug', '--fail-on-partial'].includes(t)) continue;
          if (t.startsWith('-')) break;
          words.push(t);
        }
        const target = commands.get(words.join(' '));
        if (!target) {
          problems.push(`${c.name}: example uses unknown command "${words.join(' ')}"`);
          continue;
        }
        const flags = [...ex.matchAll(/--([a-z][a-z0-9-]*)/g)].map((m) => m[1]).filter((f) => !['json', 'profile', 'timeout', 'config', 'output', 'request-id', 'debug', 'fail-on-partial'].includes(f));
        for (const f of flags) {
          const key = f.replace(/^no-/, '').replace(/-/g, '_');
          if (!(key in target.inputs)) problems.push(`${c.name}: example flag --${f} unknown for ${target.name}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('keeps generated docs in sync with capability definitions', () => {
    const out = tempDir('workctl-docs-');
    generateDocs(reg, out);
    for (const f of ['capability-catalog.md', 'command-reference.md', 'capabilities.json']) {
      const committed = join('docs', f);
      expect(existsSync(committed), `${committed} missing; run npm run docs`).toBe(true);
      expect(readFileSync(committed, 'utf8'), `${committed} out of date; run npm run docs`).toBe(readFileSync(join(out, f), 'utf8'));
    }
  });

  it('exposes read/diagnose/plan capabilities as MCP tools and hides execute by default', () => {
    const tools = toolsFor(reg, { allowExecute: false });
    const names = new Set(tools.map((t) => t._capability));
    for (const c of available) {
      expect(names.has(c.name)).toBe(c.operation !== 'execute');
    }
    for (const t of tools) expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });
});
