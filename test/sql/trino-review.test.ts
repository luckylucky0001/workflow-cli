/** Regression tests for the second cross-review of the Trino engine. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { Registry } from '../../src/core/registry';
import sql from '../../src/domains/sql';
import { parseTrinoJson } from '../../src/domains/sql/trino';
import { save } from '../../src/domains/sql/trino-engine';
import { fakeServer, tempConfig } from '../offline/fake';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';
const r = new Registry();
r.addDomain(sql);

describe('BIGINT precision', () => {
  it('keeps integers beyond 2^53 exact (as decimal strings) and leaves safe numbers alone', () => {
    const text = '{"id":"q1","data":[[9007199254740993, 42, 1.5, "x"]]}';
    const parsed = parseTrinoJson(text, JSON.parse(text)) as any;
    expect(parsed.data[0]).toEqual(['9007199254740993', 42, 1.5, 'x']);
    const small = '{"id":"q2","data":[[1,2]]}';
    expect(parseTrinoJson(small, JSON.parse(small))).toEqual(JSON.parse(small));
  });
});

describe('state file writes', () => {
  it('does not use a shared temp path (concurrent writers would clobber each other)', () => {
    const cfg = tempConfig({});
    const p = join(cfg.dir, 'q-20261017-aaaaaa.json');
    mkdirSync(`${p}.tmp`); // the old fixed temp path is unusable: a shared name would fail here
    save(p, { query_id: 'q-20261017-aaaaaa', state: 'running' });
    expect(JSON.parse(readFileSync(p, 'utf8')).state).toBe('running');
  });
});

describe('cancel vs a concurrent get', () => {
  let srv: Awaited<ReturnType<typeof fakeServer>>;
  let cfgPath: string;
  let stateDir: string;
  beforeAll(async () => {
    srv = await fakeServer((req, url) => {
      if (url.pathname === '/v1/info') return { json: { nodeVersion: { version: '476-fake' }, environment: 't', coordinator: true, starting: false } };
      if (req.method === 'DELETE') return { status: 204, text: '' };
      if (url.pathname === '/v1/query/q1_fake') return { json: { state: 'FAILED', errorCode: { name: 'USER_CANCELED', type: 'USER_ERROR', code: 3 }, failureInfo: { message: 'Query was canceled' }, queryStats: {} } };
      return undefined;
    });
    const cfg = tempConfig({});
    stateDir = join(cfg.dir, 'tq');
    mkdirSync(stateDir);
    cfgPath = join(cfg.dir, 'trino.yaml');
    writeFileSync(cfgPath, ['current_profile: t', 'profiles:', '  t:', '    env: test', '    allow_execute: true', '    endpoints:', '      trino:', '        t1:', `          url: ${srv.url}`, '          user: analyst', '          query_state_dir: ./tq', ''].join('\n'));
  });
  afterAll(() => srv.close());

  const seed = (id: string) => {
    const p = join(stateDir, `${id}.json`);
    writeFileSync(p, JSON.stringify({ query_id: id, engine: 'trino', state: 'running', engine_query_id: 'q1_fake', next_uri: '/v1/statement/executing/q1_fake/y/3', submitted_at: '2026-10-17T00:00:00Z', preview: [], row_count: 7 }));
    return p;
  };

  it('records the cancel under the query lock when no get is running', async () => {
    const p = seed('q-20261017-bbbbbb');
    const env = await invoke(r, 'sql.query.cancel', { id: 'q-20261017-bbbbbb' }, { configPath: cfgPath, timeoutMs: 10_000 });
    expect(env.error).toBeNull();
    expect(env.data).toMatchObject({ state: 'cancelled', confirmed: true });
    const st = JSON.parse(readFileSync(p, 'utf8'));
    expect(st).toMatchObject({ state: 'cancelled', row_count: 7 });
    expect(st.cancelled_by_request).toBeTruthy();
    expect(existsSync(`${p}.lock`)).toBe(false);
  });

  it('does not overwrite the state owned by a get that holds the lock', async () => {
    const p = seed('q-20261017-cccccc');
    writeFileSync(`${p}.lock`, ''); // a concurrent `sql query get` is paging
    const env = await invoke(r, 'sql.query.cancel', { id: 'q-20261017-cccccc' }, { configPath: cfgPath, timeoutMs: 7000 });
    expect(env.error).toBeNull();
    expect(env.meta.coverage?.notes?.join('')).toMatch(/未取得查询锁/);
    expect(JSON.parse(readFileSync(p, 'utf8')).state).toBe('running'); // left for the lock holder
    expect(existsSync(`${p}.lock`)).toBe(true); // someone else's lock is not removed
  });
});
