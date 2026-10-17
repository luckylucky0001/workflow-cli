// Live tests against the demo environment. WORKCTL_IT=1.
import { describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { Registry } from '../../src/core/registry';
import storage from '../../src/domains/storage';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';
const configPath = 'demo/environment/workctl.yaml';

describe.skipIf(process.env.WORKCTL_IT !== '1')('storage domain (live)', () => {
  const r = new Registry();
  r.addDomain(storage);

  it('volume get reads the demo MySQL volume and who mounts it', async () => {
    const env = await invoke(r, 'storage.volume.get', { id: 'workctl-demo_mysql-data' }, { configPath });
    expect(env.status).toBe('success');
    expect(env.meta.warnings).toEqual([]);
    expect((env.data as any).used_by.map((c: any) => c.name)).toContain('demo-mysql');
  });

  it('file stat on the demo profile', async () => {
    const env = await invoke(r, 'storage.file.stat', { path: 'demo/environment/workctl.yaml' }, { configPath });
    expect(env.data).toMatchObject({ type: 'file', readable: true });
  });
});
