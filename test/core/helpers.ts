import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { source, WorkError } from '../../src/core/output';
import { defineCapability, defineDomain, Registry } from '../../src/core/registry';
import coreDomain from '../../src/domains/core';
import planned, { PLANNED_DOMAINS } from '../../src/domains/planned';

export function tempDir(prefix = 'workctl-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function writeConfig(dir: string, profile: Record<string, unknown> = {}): string {
  const bindings = {
    resources: [
      { id: 'svc-a', type: 'service', env: 'sandbox' },
      { id: 'db-a', type: 'mysql.instance', env: 'sandbox', endpoint: { kind: 'mysql', name: 'db-a' } },
      { id: 'cache-a', type: 'redis.instance', env: 'sandbox' },
      { id: 'job-a', type: 'offline.workflow', env: 'sandbox' },
    ],
    relations: [
      { from: 'svc-a', to: 'db-a', type: 'depends_on', source: 'service-config', evidence: 'DB_HOST' },
      { from: 'svc-a', to: 'cache-a', type: 'depends_on', source: 'service-config' },
      { from: 'job-a', to: 'db-a', type: 'reads_from', source: 'scheduler-metadata' },
    ],
  };
  writeFileSync(join(dir, 'bindings.yaml'), YAML.stringify(bindings));
  writeFileSync(join(dir, 'secret.txt'), 's3cr3t\n');
  const cfg = {
    current_profile: 'test',
    profiles: {
      test: {
        env: 'sandbox',
        resources_file: './bindings.yaml',
        state_dir: './state',
        endpoints: { mysql: { 'db-a': { host: '127.0.0.1', port: 1, user: 'ro', password_ref: 'file:secret.txt' } } },
        ...profile,
      },
    },
  };
  const path = join(dir, 'workctl.yaml');
  writeFileSync(path, YAML.stringify(cfg));
  return path;
}

/** A small fake domain exercising the engine paths without external systems. */
export const fakeDomain = defineDomain({
  name: 'fake',
  title: 'Fake',
  summary: 'test',
  pillar: 'supporting',
  guide: 'docs/x.md',
  capabilities: [
    defineCapability({
      name: 'fake.echo',
      command: 'fake echo',
      summary: 'echo',
      domain: 'fake',
      inputs: { text: { type: 'string', required: true, description: 't' }, window: { type: 'duration', default: '30s', description: 'w' }, n: { type: 'int', description: 'n' } },
      output: z.object({ text: z.string(), window_ms: z.number() }),
      adapter: 'fake',
      operation: 'read',
      auth_provider: 'none',
      guide: 'docs/x.md',
      handler: async (_ctx, i) => ({ data: { text: i.text, window_ms: i.window }, sources: [source('fake', 'fake')] }),
    }),
    defineCapability({
      name: 'fake.slow',
      command: 'fake slow',
      summary: 'slow',
      domain: 'fake',
      output: z.object({}),
      adapter: 'fake',
      operation: 'read',
      auth_provider: 'none',
      guide: 'docs/x.md',
      handler: () => new Promise((r) => setTimeout(() => r({ data: {} }), 5000)),
    }),
    defineCapability({
      name: 'fake.refused',
      command: 'fake refused',
      summary: 'refused',
      domain: 'fake',
      output: z.object({}),
      adapter: 'fake',
      operation: 'read',
      auth_provider: 'none',
      guide: 'docs/x.md',
      handler: async () => {
        throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
      },
    }),
    defineCapability({
      name: 'fake.write',
      command: 'fake write',
      summary: 'write',
      domain: 'fake',
      output: z.object({ done: z.boolean() }),
      adapter: 'fake',
      operation: 'execute',
      auth_provider: 'none',
      guide: 'docs/x.md',
      handler: async () => ({ data: { done: true } }),
    }),
    defineCapability({
      name: 'fake.collect',
      command: 'fake collect',
      summary: 'collect',
      domain: 'fake',
      output: z.object({}),
      adapter: 'fake',
      operation: 'read',
      auth_provider: 'none',
      guide: 'docs/x.md',
      handler: async () => {
        throw new WorkError('COLLECTION_DISABLED', 'slow log off');
      },
    }),
  ],
  planners: [
    {
      kind: 'fake.restart',
      summary: 'restart',
      plan: async (_ctx, params) => ({
        kind: 'fake.restart',
        title: `restart ${params.target}`,
        params,
        targets: [{ id: params.target }],
        impact: { dependents: [] },
        preconditions: [{ check: 'target_exists', ok: params.target !== 'missing' }],
        steps: [{ name: 'restart', detail: 'restart it' }],
        idempotent: true,
        cancellable: false,
      }),
    },
  ],
  executors: { 'fake.restart': async (_ctx, plan, report) => { report('restarting'); return { restarted: plan.targets.length }; } },
});

export function testRegistry(): Registry {
  const r = new Registry();
  r.addDomain(coreDomain);
  r.addDomain(planned);
  for (const d of PLANNED_DOMAINS) r.addDomain(d);
  r.addDomain(fakeDomain);
  return r;
}
