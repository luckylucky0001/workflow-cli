import { createServer, type Server } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { Registry } from '../../src/core/registry';
import offline from '../../src/domains/offline';
import { tempDir } from '../core/helpers';

// An endpoint configured as REST v1 that actually points at Airflow 3 answers 404 on /api/v1/*.
// That must surface as a configuration problem, not as "DAG does not exist".
function server(v2: boolean): Promise<{ s: Server; url: string }> {
  return new Promise((res) => {
    const s = createServer((req, rsp) => {
      if (v2 && req.url?.startsWith('/api/v2/version')) {
        rsp.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ version: '3.3.2' }));
        return;
      }
      if (!v2 && req.url?.startsWith('/api/v1/version')) {
        rsp.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ version: '2.10.5' }));
        return;
      }
      rsp.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ detail: 'Not Found' }));
    }).listen(0, '127.0.0.1', () => res({ s, url: `http://127.0.0.1:${(s.address() as any).port}` }));
  });
}

describe('airflow api_version mismatch', () => {
  const servers: Server[] = [];
  const cfg = (url: string) => {
    const dir = tempDir();
    writeFileSync(join(dir, 'pw'), 'x');
    const p = join(dir, 'workctl.yaml');
    writeFileSync(p, YAML.stringify({ current_profile: 't', profiles: { t: { endpoints: { airflow: { a: { url, api_version: 'v1', username: 'u', password_ref: 'file:pw' } } } } } }));
    return p;
  };
  const r = new Registry();
  r.addDomain(offline);
  let v3: string;
  let v2less: string;
  beforeAll(async () => {
    const a = await server(true);
    const b = await server(false);
    servers.push(a.s, b.s);
    v3 = a.url;
    v2less = b.url;
  });
  afterAll(() => servers.forEach((s) => s.close()));

  it('reports NOT_CONFIGURED with a hint when the server speaks REST v2', async () => {
    const env = await invoke(r, 'offline.workflow.get', { id: 'demo-daily-orders' }, { configPath: cfg(v3) });
    expect(env.error?.code).toBe('NOT_CONFIGURED');
    expect(env.error?.hint).toContain('api_version');
  });

  it('keeps NOT_FOUND when the server has no v2 API (object really missing)', async () => {
    const env = await invoke(r, 'offline.workflow.get', { id: 'demo-daily-orders' }, { configPath: cfg(v2less) });
    expect(env.error?.code).toBe('NOT_FOUND');
  });
});
