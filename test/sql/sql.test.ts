import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../../src/core/registry';
import { invoke } from '../../src/core/engine';
import sql, { checkReadOnlySql } from '../../src/domains/sql';
import { tempConfig } from '../offline/fake';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';
const r = new Registry();
r.addDomain(sql);

describe('read-only SQL guard', () => {
  it('accepts single SELECT / WITH statements', () => {
    expect(checkReadOnlySql('SELECT 1').ok).toBe(true);
    expect(checkReadOnlySql('-- c\nWITH a AS (SELECT 1) SELECT * FROM a;').ok).toBe(true);
    expect(checkReadOnlySql("SELECT 'drop table x; insert' AS s").ok).toBe(true);
  });
  it('rejects DDL/DML, multiple statements and session changes', () => {
    expect(checkReadOnlySql('INSERT INTO t SELECT 1').ok).toBe(false);
    expect(checkReadOnlySql('SELECT 1; DROP TABLE t').ok).toBe(false);
    expect(checkReadOnlySql('CREATE TABLE t AS SELECT 1').ok).toBe(false);
    expect(checkReadOnlySql('WITH a AS (SELECT 1) INSERT OVERWRITE TABLE t SELECT * FROM a').ok).toBe(false);
    expect(checkReadOnlySql('SET spark.sql.x=1').ok).toBe(false);
    expect(checkReadOnlySql('/* only comment */').ok).toBe(false);
  });
});

describe('sql query capabilities (no Spark needed)', () => {
  const cfg = tempConfig({ allowExecute: true });
  const call = (cap: string, inputs: Record<string, unknown>) => invoke(r, cap, inputs, { configPath: cfg.path, timeoutMs: 10_000 });
  const dir = mkdtempSync(join(tmpdir(), 'workctl-sql-'));

  it('refuses unsupported engines and write statements before launching anything', async () => {
    const f = join(dir, 'q.sql');
    writeFileSync(f, 'SELECT 1');
    expect((await call('sql.query.submit', { engine: 'hive', file: f })).error?.code).toBe('UNSUPPORTED');
    // trino is implemented (test/sql/trino.test.ts); this profile has no trino endpoint
    expect((await call('sql.query.submit', { engine: 'trino', file: f })).error?.code).toBe('NOT_CONFIGURED');
    expect((await call('sql.query.submit', { engine: 'spark', file: f, catalog: 'tpch' })).error?.code).toBe('INVALID_ARGUMENT');
    const w = join(dir, 'w.sql');
    writeFileSync(w, 'DROP TABLE analytics_daily_orders');
    expect((await call('sql.query.submit', { engine: 'spark', file: w })).error?.code).toBe('INVALID_ARGUMENT');
  });

  it('reports lost when the submit process died without a final state', async () => {
    const id = 'q-20261017-abcdef';
    writeFileSync(join(cfg.dir, 'queries', `${id}.json`), JSON.stringify({ query_id: id, engine: 'spark', state: 'running', pid: 2 ** 22 + 12345, submitted_at: '2026-10-17T00:00:00Z' }));
    const env = await call('sql.query.get', { id });
    expect(env.meta.warnings).toEqual([]);
    expect(env.data).toMatchObject({ state: 'lost' });
    expect((await call('sql.query.cancel', { id })).error?.code).toBe('CONFLICT');
  });

  it('cancel does not overwrite a query that succeeded between the state check and the signal', async () => {
    const id = 'q-20261017-c0ffee';
    const stateFile = join(cfg.dir, 'queries', `${id}.json`);
    // stands in for the runner: on SIGTERM it has just finished, writes succeeded and exits
    const script = `const fs=require('fs');process.on('SIGTERM',()=>{const s=JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)},'utf8'));fs.writeFileSync(${JSON.stringify(stateFile)},JSON.stringify({...s,state:'succeeded',row_count:3,result_location:'/r'}));process.exit(0)});setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['-e', script, id], { detached: true, stdio: 'ignore' });
    try {
      writeFileSync(stateFile, JSON.stringify({ query_id: id, engine: 'spark', state: 'running', pid: child.pid, app_id: 'local-9', submitted_at: '2026-10-17T00:00:00Z' }));
      await new Promise((ok) => setTimeout(ok, 300));
      const env = await call('sql.query.cancel', { id });
      expect(env.data).toMatchObject({ state: 'succeeded', previous_state: 'running' });
      const st = JSON.parse(readFileSync(stateFile, 'utf8'));
      expect(st.state).toBe('succeeded');
      expect((await call('sql.query.get', { id })).data).toMatchObject({ state: 'succeeded', result_location: '/r' });
    } finally {
      try {
        process.kill(child.pid!, 'SIGKILL');
      } catch {
        /* exited */
      }
    }
  });

  it('returns preview (≤ 20 rows) for succeeded queries', async () => {
    const id = 'q-20261017-123456';
    const preview = Array.from({ length: 25 }, (_, i) => ({ n: i }));
    writeFileSync(join(cfg.dir, 'queries', `${id}.json`), JSON.stringify({ query_id: id, engine: 'spark', state: 'succeeded', pid: 1, app_id: 'local-1', row_count: 25, preview, result_location: '/x', result_format: 'json-lines' }));
    const env = await call('sql.query.get', { id });
    expect(env.meta.warnings).toEqual([]);
    expect((env.data as any).preview).toHaveLength(20);
    expect((env.data as any).preview_truncated).toBe(true);
    expect((await call('sql.query.get', { id: 'bad' })).error?.code).toBe('INVALID_ARGUMENT');
  });
});
