import { describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { tempDir, testRegistry, writeConfig } from './helpers';

describe('core capabilities', () => {
  const dir = tempDir();
  const configPath = writeConfig(dir, { allow_execute: true });
  const reg = testRegistry();
  const call = (cap: string, inputs: Record<string, unknown> = {}) => invoke(reg, cap, inputs, { configPath });

  it('lists capabilities with planned ones marked', async () => {
    const env = await call('capability.list', {});
    const data = env.data as any;
    expect(data.capabilities.find((c: any) => c.name === 'search.query').status).toBe('planned');
    expect(data.domains.find((d: any) => d.name === 'search').planned).toBeGreaterThan(0);
    const filtered = await call('capability.list', { domain: 'fake' });
    expect((filtered.data as any).capabilities.every((c: any) => c.domain === 'fake')).toBe(true);
  });

  it('describes a capability with its JSON schema', async () => {
    const env = await call('capability.get', { name: 'fake.echo' });
    const d = env.data as any;
    expect(d.definition.command).toBe('fake echo');
    expect(d.output_json_schema.type).toBe('object');
    expect((await call('capability.get', { name: 'nope' })).error?.code).toBe('NOT_FOUND');
  });

  it('resolves service dependencies with source and evidence', async () => {
    const env = await call('service.dependency.list', { service: 'svc-a', env: 'sandbox' });
    const d = env.data as any;
    expect(d.dependencies.map((x: any) => x.resource_id).sort()).toEqual(['cache-a', 'db-a']);
    expect(d.dependencies.find((x: any) => x.resource_id === 'db-a').evidence).toBe('DB_HOST');
    const res = await call('resource.get', { id: 'db-a' });
    expect((res.data as any).upstream.map((r: any) => r.from).sort()).toEqual(['job-a', 'svc-a']);
  });

  it('rejects --depth < 1 instead of returning an empty dependency list that reads as "none"', async () => {
    for (const depth of [0, -1]) {
      const env = await call('service.dependency.list', { service: 'svc-a', depth });
      expect(env.error?.code).toBe('INVALID_ARGUMENT');
    }
  });

  it('reports credential refs without values', async () => {
    const env = await call('auth.status', {});
    const text = JSON.stringify(env);
    expect(text).not.toContain('s3cr3t');
    expect((env.data as any).endpoints[0].credential_refs[0]).toMatchObject({ key: 'password_ref', ref_type: 'file', resolvable: true });
  });

  it('access check explains each precondition', async () => {
    const env = await call('access.check', { capability: 'search.query', probe: false });
    expect((env.data as any).verdict).toBe('denied');
  });

  it('plans, executes and records operation state', async () => {
    const planned = await call('operation.plan', { action: 'fake.restart', param: ['target=svc-a'] });
    expect(planned.status).toBe('success');
    const plan = planned.data as any;
    expect(plan.status).toBe('planned');
    expect(plan.executable).toBe(true);
    const wrong = await call('operation.execute', { id: plan.id, confirm: 'op-00000000-aaaaaa' });
    expect(wrong.error?.code).toBe('PRECONDITION_FAILED');
    const done = await call('operation.execute', { id: plan.id, confirm: plan.id });
    expect((done.data as any).status).toBe('succeeded');
    expect((done.data as any).result).toEqual({ restarted: 1 });
    expect((done.data as any).history.map((h: any) => h.status)).toEqual(['planned', 'running', 'running', 'succeeded']);
    const again = await call('operation.execute', { id: plan.id, confirm: plan.id });
    expect(again.error?.code).toBe('CONFLICT');
    const bad = await call('operation.plan', { action: 'fake.restart', param: ['target=missing'] });
    const exec = await call('operation.execute', { id: (bad.data as any).id, confirm: (bad.data as any).id });
    expect(exec.error?.code).toBe('PRECONDITION_FAILED');
    const list = await call('operation.list', {});
    expect((list.data as any).operations.length).toBe(2);
  });
});
