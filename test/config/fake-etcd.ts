// Minimal in-memory etcd v3 JSON gateway for unit tests: MVCC history with revisions, compaction,
// leases, optional auth. Mirrors the real gateway's wire format (base64 keys/values, int64 as
// strings, zero values omitted, gRPC code + message on errors).
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Event {
  rev: number;
  key: Buffer;
  value: Buffer | null;
  lease: string;
}

const enc = (b: Buffer) => b.toString('base64');
const dec = (s: string | undefined) => Buffer.from(s ?? '', 'base64');

export class FakeEtcd {
  rev = 1;
  compactRev = 0;
  events: Event[] = [];
  leases = new Map<string, { granted: number; expiresAt: number }>();
  auth: { users: Record<string, string>; denyPrefix?: Record<string, string> } | null = null;
  tokens = new Map<string, string>();
  calls: string[] = [];
  server!: Server;
  url = '';

  put(key: string | Buffer, value: string | Buffer, lease = '0'): number {
    this.rev += 1;
    this.events.push({ rev: this.rev, key: Buffer.isBuffer(key) ? key : Buffer.from(key), value: Buffer.isBuffer(value) ? value : Buffer.from(value), lease });
    return this.rev;
  }

  del(key: string): number {
    this.rev += 1;
    this.events.push({ rev: this.rev, key: Buffer.from(key), value: null, lease: '0' });
    return this.rev;
  }

  grant(id: string, ttl: number, remaining = ttl): void {
    this.leases.set(id, { granted: ttl, expiresAt: Date.now() + remaining * 1000 });
  }

  compact(rev: number): void {
    this.compactRev = rev;
  }

  private snapshot(at: number): Map<string, { key: Buffer; value: Buffer; create: number; mod: number; version: number; lease: string }> {
    const out = new Map<string, { key: Buffer; value: Buffer; create: number; mod: number; version: number; lease: string }>();
    for (const e of this.events) {
      if (e.rev > at) break;
      const k = e.key.toString('hex');
      if (e.value === null) out.delete(k);
      else {
        const prev = out.get(k);
        out.set(k, { key: e.key, value: e.value, create: prev?.create ?? e.rev, mod: e.rev, version: (prev?.version ?? 0) + 1, lease: e.lease });
      }
    }
    return out;
  }

  private header() {
    return { cluster_id: '1', member_id: '42', revision: String(this.rev), raft_term: '2' };
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const send = (status: number, j: unknown) => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(j));
        };
        const err = (status: number, code: number, message: string) => send(status, { error: message, code, message });
        const path = req.url ?? '/';
        this.calls.push(path);
        const b = body ? JSON.parse(body) : {};
        if (path === '/version') return send(200, { etcdserver: '3.5.99-fake', etcdcluster: '3.5.0' });
        if (path === '/v3/auth/authenticate') {
          if (!this.auth) return err(400, 9, 'etcdserver: authentication is not enabled');
          if (this.auth.users[b.name] !== b.password) return err(400, 3, 'etcdserver: authentication failed, invalid user ID or password');
          const tok = `tok-${b.name}.${this.tokens.size + 1}`;
          this.tokens.set(tok, b.name);
          return send(200, { header: this.header(), token: tok });
        }
        let user: string | null = null;
        if (this.auth) {
          const t = req.headers.authorization;
          if (!t) return err(400, 3, 'etcdserver: user name is empty');
          user = this.tokens.get(String(t)) ?? null;
          if (!user) return err(401, 16, 'etcdserver: invalid auth token');
        }
        if (path === '/v3/maintenance/status') return send(200, { header: this.header(), version: '3.5.99-fake', dbSize: '24576', leader: '42', dbSizeInUse: '16384' });
        if (path === '/v3/auth/status') return send(200, { header: this.header(), enabled: !!this.auth });
        if (path === '/v3/kv/range') {
          const key = dec(b.key);
          const deny = user && this.auth?.denyPrefix?.[user];
          if (deny && key.toString().startsWith(deny)) return err(403, 7, 'etcdserver: permission denied');
          const at = b.revision ? Number(b.revision) : this.rev;
          if (b.revision && at < this.compactRev) return err(400, 11, 'etcdserver: mvcc: required revision has been compacted');
          if (at > this.rev) return err(400, 11, 'etcdserver: mvcc: required revision is a future revision');
          const end = b.range_end ? dec(b.range_end) : null;
          const all = [...this.snapshot(at).values()]
            .filter((x) => (end ? Buffer.compare(x.key, key) >= 0 && (end.equals(Buffer.from([0])) || Buffer.compare(x.key, end) < 0) : x.key.equals(key)))
            .sort((x, y) => Buffer.compare(x.key, y.key));
          const limit = b.limit ? Number(b.limit) : 0;
          const page = limit ? all.slice(0, limit) : all;
          const out: Record<string, unknown> = { header: this.header() };
          if (!b.count_only && page.length) {
            out.kvs = page.map((x) => ({
              key: enc(x.key),
              create_revision: String(x.create),
              mod_revision: String(x.mod),
              version: String(x.version),
              ...(x.value.length ? { value: enc(x.value) } : {}),
              ...(x.lease !== '0' ? { lease: x.lease } : {}),
            }));
          }
          if (limit && all.length > limit) out.more = true;
          if (all.length) out.count = String(all.length);
          return send(200, out);
        }
        if (path === '/v3/lease/timetolive') {
          const l = this.leases.get(String(b.ID));
          if (!l) return send(200, { header: this.header(), ID: String(b.ID), TTL: '-1' });
          return send(200, { header: this.header(), ID: String(b.ID), TTL: String(Math.max(0, Math.round((l.expiresAt - Date.now()) / 1000))), grantedTTL: String(l.granted) });
        }
        return send(404, 'Not Found');
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  stop(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()));
  }
}

/** Write a profile with one etcd endpoint; returns the config path. */
export function writeEtcdConfig(url: string, extra: Record<string, unknown> = {}, secret?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'workctl-etcd-'));
  if (secret !== undefined) writeFileSync(join(dir, 'etcd_pw'), secret);
  const cfg = {
    schema_version: '1.0',
    current_profile: 't',
    profiles: {
      t: {
        env: 'sandbox',
        allow_execute: false,
        state_dir: './state',
        defaults: { etcd: 'e1' },
        endpoints: { etcd: { e1: { url, config_prefix: '/config/', discovery_prefix: '/services/', ...extra } } },
      },
    },
  };
  const p = join(dir, 'workctl.yaml');
  writeFileSync(p, JSON.stringify(cfg));
  return p;
}
