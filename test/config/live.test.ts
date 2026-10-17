// Live tests against the demo etcd (demo-etcd, 127.0.0.1:12379). WORKCTL_IT=1.
// Compaction is cluster-wide, so it is exercised only on a throwaway etcd container started here —
// never on demo-etcd, whose history the demo uses.
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { builtinRegistry } from '../../src/domains';
import { writeEtcdConfig } from './fake-etcd';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';
const configPath = 'demo/environment/workctl.yaml';
const IMAGE = 'bitnamilegacy/etcd:3.5';
const live = process.env.WORKCTL_IT === '1';

interface Seed {
  steps: { label: string; revision: number }[];
  leases: string[];
}

describe.skipIf(!live)('config domain (live, demo-etcd)', () => {
  const r = builtinRegistry();
  let seed: Seed;
  const rev = (label: string) => seed.steps.find((s) => s.label.startsWith(label))!.revision;

  beforeAll(() => {
    const out = spawnSync(process.execPath, ['demo/scenarios/config/seed.mjs'], { encoding: 'utf8' });
    expect(out.status, out.stderr).toBe(0);
    seed = JSON.parse(out.stdout);
  });

  it('config get reads the seeded keys with revisions; secrets masked', async () => {
    const env = await invoke(r, 'config.get', { service: 'demo-order', env: 'sandbox' }, { configPath });
    expect(env.status).toBe('success');
    expect(env.meta.warnings).toEqual([]);
    const d = env.data as any;
    expect(d.observed_revision).toBeGreaterThanOrEqual(rev('registrations'));
    const by = Object.fromEntries(d.items.map((x: any) => [x.name, x]));
    expect(by['cache.ttl_seconds']).toMatchObject({ value: 60, version: 2 });
    expect(by['db.password']).toMatchObject({ value: '***', masked: true });
    expect(by['upstream.payment'].value.token).toBe('***');
    expect(JSON.stringify(env)).not.toContain('synthetic-demo-password');
    expect(env.meta.sources[0].version).toMatch(/^3\.5\./);
  });

  it('config diff between real revisions (v1 → v3)', async () => {
    const env = await invoke(r, 'config.diff', { service: 'demo-order', from_rev: rev('v1'), to_rev: String(rev('v3')) }, { configPath });
    expect(env.status).toBe('success');
    expect(env.meta.warnings).toEqual([]);
    const d = env.data as any;
    expect(d.summary).toMatchObject({ added: 1, removed: 1, changed: 5 });
    const by = Object.fromEntries(d.changes.map((c: any) => [c.name, c]));
    expect(by['cache.ttl_seconds']).toMatchObject({ old: { value: 300 }, new: { value: 60 } });
    expect(by['feature.legacy_mode'].change).toBe('removed');
    expect(by['cache.max_entries'].change).toBe('added');
    const prev = await invoke(r, 'config.diff', { service: 'demo-order', key: 'cache.mode' }, { configPath });
    expect((prev.data as any).changes).toEqual([]);
    expect((prev.data as any).summary.rewritten_same_value).toBe(1);
    const fut = await invoke(r, 'config.diff', { service: 'demo-order', from_rev: 10_000_000 }, { configPath });
    expect(fut.error!.code).toBe('INVALID_ARGUMENT');
  });

  it('discovery list shows leased and leaseless registrations with remaining TTL', async () => {
    const env = await invoke(r, 'discovery.list', { service: 'demo-order' }, { configPath });
    expect(env.status).toBe('success');
    expect(env.meta.warnings).toEqual([]);
    const d = env.data as any;
    expect(d.instances.map((x: any) => x.instance_id)).toEqual(['order-1', 'order-2', 'order-legacy']);
    expect(d.instances[0].lease.id).toBe(seed.leases[0]);
    expect(d.instances[0].lease.remaining_ttl_s).toBeGreaterThan(0);
    expect(d.instances[2].lease).toBeNull();
    const h = await invoke(r, 'discovery.list', { service: 'demo-order', healthy_only: true }, { configPath });
    expect((h.data as any).instances.map((x: any) => x.instance_id)).toEqual(['order-1', 'order-legacy']);
  });

  it('auth status --probe reaches etcd', async () => {
    const env = await invoke(r, 'auth.status', { probe: true }, { configPath });
    const e = (env.data as any).endpoints.find((x: any) => x.kind === 'etcd');
    expect(e).toMatchObject({ auth_provider: 'etcd-profile', probe: { ok: true, version: expect.stringMatching(/^3\.5\./) } });
  });
});

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
    s.on('error', rej);
  });
}

const hasImage = (() => {
  if (!live) return false;
  try {
    execFileSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// Separate throwaway etcd: compaction is cluster-wide and irreversible.
describe.skipIf(!live || !hasImage)('config diff vs. a compacted revision (throwaway etcd container)', () => {
  const r = builtinRegistry();
  const name = `workctl-it-etcd-${process.pid}`;
  let url = '';

  const call = async (path: string, body: unknown) => (await fetch(`${url}${path}`, { method: 'POST', body: JSON.stringify(body) })).json() as Promise<any>;
  const b64 = (s: string) => Buffer.from(s).toString('base64');

  beforeAll(async () => {
    const port = await freePort();
    execFileSync('docker', ['run', '-d', '--rm', '--name', name, '-e', 'ALLOW_NONE_AUTHENTICATION=yes', '-p', `127.0.0.1:${port}:2379`, IMAGE], { stdio: 'ignore' });
    url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${url}/version`)).ok) return;
      } catch {
        /* starting */
      }
      await new Promise((res) => setTimeout(res, 500));
    }
    throw new Error('throwaway etcd did not start');
  });
  afterAll(() => {
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  });

  it('returns DATA_UNAVAILABLE with the real compact revision; later revisions still diff', async () => {
    const p = '/config/sandbox/demo-order/';
    const revs: number[] = [];
    for (const v of ['1', '2', '3', '4']) revs.push(Number((await call('/v3/kv/put', { key: b64(`${p}cache.ttl_seconds`), value: b64(v) })).header.revision));
    const compactAt = revs[2];
    await call('/v3/kv/compaction', { revision: String(compactAt), physical: true });
    const cfg = writeEtcdConfig(url);
    const env = await invoke(r, 'config.diff', { service: 'demo-order', from_rev: revs[0] }, { configPath: cfg });
    expect(env.error).toMatchObject({ code: 'DATA_UNAVAILABLE', details: { requested_revision: revs[0], compact_revision: compactAt } });
    expect(String(env.error!.details!.etcd_message)).toContain('required revision has been compacted');
    const ok = await invoke(r, 'config.diff', { service: 'demo-order', from_rev: compactAt }, { configPath: cfg });
    expect(ok.status).toBe('success');
    expect(ok.meta.warnings).toEqual([]);
    expect((ok.data as any).changes[0]).toMatchObject({ change: 'changed', old: { value: 3 }, new: { value: 4 } });
  });
});
