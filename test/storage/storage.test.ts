import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { Registry } from '../../src/core/registry';
import storage from '../../src/domains/storage';
import { startFakeDocker, writeTestConfig } from '../container/fake-docker';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';

describe('storage capabilities', () => {
  let fake: Awaited<ReturnType<typeof startFakeDocker>>;
  let configPath: string;
  let dir: string;
  const r = new Registry();
  r.addDomain(storage);

  beforeAll(async () => {
    fake = await startFakeDocker({
      containers: [{ Id: 'f1'.padEnd(64, '0'), Name: 'demo-mysql', Labels: { 'uses.volume': 'demo_mysql-data' }, State: 'running' }],
      volumes: [
        { Name: 'demo_mysql-data', Driver: 'local', Mountpoint: '/var/lib/docker/volumes/demo_mysql-data/_data', Size: 1234, RefCount: 1 },
        { Name: 'nosize', Driver: 'nfs', Mountpoint: '/mnt/x' },
      ],
    });
    configPath = writeTestConfig(fake.dir, { socketPath: fake.socketPath });
    dir = mkdtempSync(join(tmpdir(), 'workctl-fs-'));
    writeFileSync(join(dir, 'part-0000.parquet'), 'x'.repeat(42));
    mkdirSync(join(dir, 'dt=2026-10-16'));
    symlinkSync(join(dir, 'missing'), join(dir, 'dangling'));
  });
  afterAll(async () => fake.close());

  it('volume get returns metadata, usage and the containers mounting it', async () => {
    const env = await invoke(r, 'storage.volume.get', { id: 'demo_mysql-data' }, { configPath });
    expect(env.status).toBe('success');
    expect(env.meta.warnings).toEqual([]);
    const d = env.data as any;
    expect(d.usage).toMatchObject({ status: 'available', size_bytes: 1234, ref_count: 1 });
    expect(d.used_by[0].name).toBe('demo-mysql');
  });

  it('volume usage that the daemon did not compute is unavailable, not zero', async () => {
    const env = await invoke(r, 'storage.volume.get', { id: 'nosize' }, { configPath });
    const d = env.data as any;
    expect(d.usage.status).toBe('unavailable');
    expect(d.usage.size_bytes).toBeNull();
    expect(env.meta.coverage?.complete).toBe(false);
  });

  it('unknown volume is NOT_FOUND with the real volume names as hint', async () => {
    const env = await invoke(r, 'storage.volume.get', { id: 'nope' }, { configPath });
    expect(env.error?.code).toBe('NOT_FOUND');
    expect(env.error?.hint).toContain('demo_mysql-data');
  });

  it('file stat reports type, size and readability; directories count entries', async () => {
    const f = await invoke(r, 'storage.file.stat', { path: join(dir, 'part-0000.parquet') }, { configPath });
    expect(f.meta.warnings).toEqual([]);
    expect(f.data).toMatchObject({ type: 'file', size_bytes: 42, readable: true });
    const d = await invoke(r, 'storage.file.stat', { path: dir }, { configPath });
    expect((d.data as any).directory).toEqual({ entries: 3, truncated: false });
    const l = await invoke(r, 'storage.file.stat', { path: join(dir, 'dangling') }, { configPath });
    expect(l.data).toMatchObject({ type: 'symlink', target_type: 'dangling' });
    expect(f.meta.sources[0].system).toBe('local-filesystem');
  });

  it('missing path is NOT_FOUND', async () => {
    const env = await invoke(r, 'storage.file.stat', { path: join(dir, 'nope') }, { configPath });
    expect(env.error?.code).toBe('NOT_FOUND');
  });

  it('S3 / HDFS are planned (catalog only)', async () => {
    const env = await invoke(r, 'storage.object.stat', {}, { configPath });
    expect(env.error?.code).toBe('CAPABILITY_PLANNED');
    expect(r.get('storage.hdfs.stat')?.status).toBe('planned');
  });
});
