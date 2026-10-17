import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

export type Route = (req: IncomingMessage, url: URL, body: string) => { status?: number; json?: unknown; text?: string } | undefined;

/** Minimal fake HTTP server: routes return JSON or text; unknown paths 404. */
export async function fakeServer(route: Route): Promise<{ url: string; close: () => Promise<void>; calls: string[] }> {
  const calls: string[] = [];
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      calls.push(`${req.method} ${url.pathname}${url.search}`);
      const r = route(req, url, body);
      if (!r) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ detail: 'not found', status: 404 }));
        return;
      }
      if (r.text !== undefined) {
        res.writeHead(r.status ?? 200, { 'content-type': 'text/plain' });
        res.end(r.text);
      } else {
        res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.json));
      }
    });
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  const port = (srv.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, calls, close: () => new Promise((ok) => srv.close(() => ok())) };
}

/** Temp workctl config with airflow/spark endpoints pointing at fake servers. */
export function tempConfig(opts: { airflowUrl?: string; historyUrl?: string; allowExecute?: boolean }): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'workctl-offline-'));
  mkdirSync(join(dir, 'secrets'));
  writeFileSync(join(dir, 'secrets', 'airflow'), 'fake-password');
  for (const d of ['driver-logs', 'events', 'queries', 'warehouse', 'state']) mkdirSync(join(dir, d));
  const yaml = `schema_version: "1.0"
current_profile: t
profiles:
  t:
    env: test
    allow_execute: ${opts.allowExecute ? 'true' : 'false'}
    state_dir: ./state
    endpoints:
      airflow:
        a:
          url: ${opts.airflowUrl ?? 'http://127.0.0.1:9'}
          api_version: v1
          username: admin
          password_ref: file:secrets/airflow
          timezone: Asia/Shanghai
      spark:
        s:
          history_url: ${opts.historyUrl ?? 'http://127.0.0.1:9'}
          driver_log_dir: ./driver-logs
          event_log_dir: ./events
          query_state_dir: ./queries
          warehouse_root: ./warehouse
`;
  const path = join(dir, 'workctl.yaml');
  writeFileSync(path, yaml);
  return { path, dir };
}
