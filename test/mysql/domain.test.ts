import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { Registry, describeCapability } from '../../src/core/registry';
import mysqlDomain from '../../src/domains/mysql';
import { mapMysqlError } from '../../src/domains/mysql/client';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';

function registry(): Registry {
  const r = new Registry();
  r.addDomain(mysqlDomain);
  return r;
}

describe('mysql domain definition', () => {
  const r = registry();
  const caps = r.list({ domain: 'mysql' });

  it('registers the designed commands', () => {
    const commands = caps.filter((c) => c.status === 'available').map((c) => c.command).sort();
    expect(commands).toEqual(
      [
        'mysql index list',
        'mysql index plan',
        'mysql instance get',
        'mysql lock list',
        'mysql query analyze',
        'mysql query execute',
        'mysql query explain',
        'mysql session list',
        'mysql slowlog list',
        'mysql statement summary',
        'mysql table get',
      ].sort(),
    );
    expect(r.planners.has('mysql.index.create')).toBe(true);
    expect(r.executors.has('mysql.index.create')).toBe(false);
    expect(r.probes.has('mysql')).toBe(true);
  });

  it('every capability carries the full contract metadata', () => {
    for (const c of caps) {
      expect(c.name.startsWith('mysql.')).toBe(true);
      expect(c.command).toBe(c.name.replace(/\./g, ' ').replace(/^mysql /, 'mysql '));
      expect(c.summary).toMatch(/[一-龥]/);
      expect(c.guide).toBe('docs/guides/mysql.md');
      if (c.status === 'planned') continue;
      expect(c.output).toBeDefined();
      expect(c.adapter).toBe('mysql-driver');
      expect(c.auth_provider).toBe('database-profile');
      expect(c.examples?.length).toBeGreaterThan(0);
      expect(c.notes?.length).toBeGreaterThan(0);
      expect(c.prerequisites?.length).toBeGreaterThan(0);
      for (const k of Object.keys(c.inputs)) expect(k).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(() => r.outputJsonSchema(c)).not.toThrow();
      expect(describeCapability(c).output_schema).toBe(`docs/schemas/${c.name}.v1.json`);
    }
  });

  it('marks EXPLAIN ANALYZE as diagnose and index plan as plan', () => {
    expect(r.get('mysql.query.analyze')!.operation).toBe('diagnose');
    expect(r.get('mysql.query.analyze')!.notes!.join('')).toContain('实际执行');
    expect(r.get('mysql.query.explain')!.operation).toBe('read');
    expect(r.get('mysql.index.plan')!.operation).toBe('plan');
    expect(r.get('mysql.statement.summary')!.inputs.sample_window.default).toBe('10s');
  });
});

describe('mysql error mapping', () => {
  const err = (code: string, errno: number, sqlState: string, msg = code) => Object.assign(new Error(msg), { code, errno, sqlState, sqlMessage: msg });

  it.each([
    ['ER_ACCESS_DENIED_ERROR', 1045, '28000', 'UNAUTHENTICATED'],
    ['ER_ACCOUNT_HAS_BEEN_LOCKED', 3118, 'HY000', 'UNAUTHENTICATED'],
    ['ER_TABLEACCESS_DENIED_ERROR', 1142, '42000', 'PERMISSION_DENIED'],
    ['ER_SPECIFIC_ACCESS_DENIED_ERROR', 1227, '42000', 'PERMISSION_DENIED'],
    ['ER_NO_SUCH_TABLE', 1146, '42S02', 'NOT_FOUND'],
    ['ER_PARSE_ERROR', 1064, '42000', 'INVALID_ARGUMENT'],
    ['ER_NON_UNIQ_ERROR', 1052, '23000', 'INVALID_ARGUMENT'],
    ['ER_QUERY_TIMEOUT', 3024, 'HY000', 'TIMEOUT'],
    ['ER_LOCK_WAIT_TIMEOUT', 1205, 'HY000', 'TIMEOUT'],
    ['ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION', 1792, '25006', 'PERMISSION_DENIED'],
    ['ER_CON_COUNT_ERROR', 1040, '08004', 'UPSTREAM_UNAVAILABLE'],
  ])('%s → %s', (code, errno, state, expected) => {
    const we = mapMysqlError(err(code, errno, state));
    expect(we?.code).toBe(expected);
    expect(we?.details?.errno).toBe(errno);
  });

  it('maps connection refusal and ignores errors from other systems', () => {
    expect(mapMysqlError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED', fatal: true }))?.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(mapMysqlError(Object.assign(new Error('docker socket'), { code: 'ECONNREFUSED' }))).toBeUndefined();
    expect(mapMysqlError(new Error('random'))).toBeUndefined();
  });
});

describe('mysql capabilities without a live server', () => {
  let configPath: string;
  let sqlFile: string;
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'workctl-mysql-'));
    writeFileSync(join(dir, 'pw'), 'not-a-real-password\n');
    configPath = join(dir, 'workctl.yaml');
    writeFileSync(
      configPath,
      [
        'current_profile: t',
        'profiles:',
        '  t:',
        '    env: test',
        `    state_dir: ${join(dir, 'state')}`,
        '    endpoints:',
        '      mysql:',
        '        down:',
        '          host: 127.0.0.1',
        '          port: 1',
        '          user: workctl_ro',
        '          password_ref: file:pw',
      ].join('\n'),
    );
    sqlFile = join(dir, 'q.sql');
    writeFileSync(sqlFile, 'DELETE FROM orders');
  });

  it('unreachable instance → UPSTREAM_UNAVAILABLE (retryable)', async () => {
    const env = await invoke(registry(), 'mysql.instance.get', { instance: 'down' }, { configPath });
    expect(env.status).toBe('error');
    expect(env.error?.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(env.error?.retryable).toBe(true);
    expect(JSON.stringify(env)).not.toContain('not-a-real-password');
  });

  it('static guard rejects writes before connecting', async () => {
    const env = await invoke(registry(), 'mysql.query.execute', { instance: 'down', database: 'demo', sql_file: sqlFile }, { configPath });
    expect(env.error?.code).toBe('INVALID_ARGUMENT');
    expect(env.error?.message).toContain('DELETE');
  });

  it('unknown endpoint → NOT_FOUND with available names', async () => {
    const env = await invoke(registry(), 'mysql.session.list', { instance: 'nope' }, { configPath });
    expect(env.error?.code).toBe('NOT_FOUND');
    expect(env.error?.hint).toContain('down');
  });

  it('sample window larger than the time budget is refused up front', async () => {
    const env = await invoke(registry(), 'mysql.statement.summary', { instance: 'down', sample_window: '45s' }, { configPath, timeoutMs: 30_000 });
    expect(env.error?.code).toBe('INVALID_ARGUMENT');
    expect(env.error?.hint).toContain('--timeout');
  });
});
