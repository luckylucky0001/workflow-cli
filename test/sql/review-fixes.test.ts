/** Regression tests for cross-review fixes in the sql domain. */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config';
import { invoke } from '../../src/core/engine';
import { Registry } from '../../src/core/registry';
import { Ctx } from '../../src/core/runtime';
import sql, { checkReadOnlySql, childEnv, ownsPid } from '../../src/domains/sql';
import { tempConfig } from '../offline/fake';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';
const r = new Registry();
r.addDomain(sql);

describe('read-only SQL guard: bypasses through SELECT', () => {
  it.each([
    ["SELECT TRANSFORM(id) USING 'touch /tmp/pwned' AS (x) FROM analytics_daily_orders", /脚本转换/],
    ["SELECT MAP(id) USING 'cat /etc/passwd' FROM v", /脚本转换/],
    ["SELECT reflect('java.lang.System', 'getenv', 'AIRFLOW_PASSWORD')", /reflect/],
    ["SELECT java_method('java.lang.System', 'getProperty', 'user.home')", /java_method/],
    ['SELECT * FROM text.`/home/user/demo/environment/.runtime/secrets/mysql_root_password`', /直接查询文件/],
    ["SELECT * FROM json.`file:///etc/hosts`", /直接查询文件/],
    ['SELECT * FROM parquet . secrets', /直接查询文件/],
  ])('rejects %s', (q, re) => {
    const g = checkReadOnlySql(q);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toMatch(re);
  });

  it.each([
    'SELECT transform(arr, x -> x + 1) AS t FROM v',
    'SELECT a.id FROM analytics_daily_orders a JOIN ods_orders b USING (id)',
    "SELECT from_json(payload, 'a INT') AS j, t.text FROM v t",
    "SELECT 'reflect(' AS s, 'json.`x`' AS f",
  ])('still accepts %s', (q) => {
    expect(checkReadOnlySql(q).ok).toBe(true);
  });
});

describe('read-only SQL guard: lexing follows the engine (statements hidden from the guard)', () => {
  it.each([
    // Spark: no backslash escape inside `identifiers` — the backtick closes, INSERT is real
    ["WITH a AS (SELECT 1 AS `x\\`) INSERT OVERWRITE DIRECTORY '/tmp/pwn' USING json SELECT * FROM a -- `", 'spark'],
    // Spark: bracketed comments nest — the first */ does not end the comment
    ["WITH a AS (SELECT 1) /* /* */ ' */ INSERT OVERWRITE DIRECTORY '/tmp/pwn' USING json SELECT * FROM a --'", 'spark'],
    // Spark 3.5 raw string literals: r'x\' ends at the quote after the backslash
    ["WITH a AS (SELECT r'x\\' AS c) INSERT OVERWRITE DIRECTORY '/tmp/pwn' USING json SELECT * FROM a --'", 'spark'],
    ['WITH a AS (SELECT R"x\\" AS c) INSERT OVERWRITE DIRECTORY \'/tmp/pwn\' USING json SELECT * FROM a --"', 'spark'],
    // Trino: no backslash escape in '…' — the string ends at \'
    ["SELECT 'a\\', * FROM TABLE(system.query(query => 'select 1')) -- '", 'trino'],
    // Trino: quoted table-function names
    ['SELECT * FROM TABLE("system"."query"(query => \'select 1\'))', 'trino'],
    ['SELECT * FROM TABLE(pg.system."query"(query => \'select 1\'))', 'trino'],
  ] as const)('rejects %s (%s)', (q, engine) => {
    expect(checkReadOnlySql(q, engine).ok).toBe(false);
  });

  it.each([
    ["SELECT 'it\\'s' AS s, `a``b` FROM v /* c /* nested */ still comment */", 'spark'],
    ["SELECT r'C:\\' AS p, attr'x' AS q FROM v", 'spark'],
    ["SELECT 'C:\\' AS p, 'it''s' AS q FROM tpch.tiny.nation", 'trino'],
    ['SELECT * FROM TABLE(sequence(start => 1, stop => 3)) /* a /* b */', 'trino'],
  ] as const)('still accepts %s (%s)', (q, engine) => {
    expect(checkReadOnlySql(q, engine).ok).toBe(true);
  });
});

describe('read-only SQL guard: rejection does not echo file content', () => {
  it('a non-SQL file (e.g. a password file) is rejected without quoting its first word', () => {
    const g = checkReadOnlySql('Kq9secretPW\n');
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason.toUpperCase()).not.toContain('KQ');
    const t = checkReadOnlySql('hunterTwo', 'trino');
    if (!t.ok) expect(t.reason.toUpperCase()).not.toContain('HUNTER');
  });
  it('still names real statement keywords', () => {
    const g = checkReadOnlySql('DROP TABLE t');
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toContain('DROP');
  });
});

describe('sql query submit process handling', () => {
  it('does not pass profile secrets referenced via env: to the Spark child process', () => {
    const cfg = tempConfig({});
    appendFileSync(cfg.path, '      mysql:\n        m:\n          host: 127.0.0.1\n          user: u\n          password_ref: env:WORKCTL_TEST_DB_PW\n');
    process.env.WORKCTL_TEST_DB_PW = 'super-secret';
    process.env.WORKCTL_TEST_HARMLESS = 'ok';
    const ctx = new Ctx({ registry: r, loaded: loadConfig(cfg.path), profileName: 't', requestId: 'x', timeoutMs: 5000 });
    const env = childEnv(ctx, { WORKCTL_SPARK_HOME: '/opt/spark', UNSET: undefined });
    expect(env.WORKCTL_TEST_DB_PW).toBeUndefined();
    expect(env.WORKCTL_TEST_HARMLESS).toBe('ok');
    expect(env.WORKCTL_SPARK_HOME).toBe('/opt/spark');
    expect('UNSET' in env).toBe(false);
  });

  it('a spawn failure is an error envelope (no crash) and the query is marked failed', async () => {
    const cfg = tempConfig({});
    writeFileSync(join(cfg.dir, 'notexec.sh'), '#!/bin/sh\necho hi\n', { mode: 0o644 });
    appendFileSync(cfg.path, '          submit_script: ./notexec.sh\n');
    const q = join(cfg.dir, 'q.sql');
    writeFileSync(q, 'SELECT 1');
    const env = await invoke(r, 'sql.query.submit', { engine: 'spark', file: q }, { configPath: cfg.path, timeoutMs: 10_000 });
    expect(env.error?.code).toBe('INTERNAL');
    expect(env.error?.message).toMatch(/EACCES|未能启动/);
    const id = /q-\d{8}-[a-f0-9]{6}/.exec(readFileSync(join(cfg.dir, 'queries', (await import('node:fs')).readdirSync(join(cfg.dir, 'queries')).find((f) => f.endsWith('.json'))!), 'utf8'))![0];
    const got = await invoke(r, 'sql.query.get', { id }, { configPath: cfg.path, timeoutMs: 10_000 });
    expect(got.data).toMatchObject({ state: 'failed', error: { type: 'SpawnError' } });
  });

  it('a live pid that does not belong to the query (pid reuse) is not treated as running', () => {
    const cfg = tempConfig({});
    const proc = join(cfg.dir, 'proc');
    mkdirSync(join(proc, String(process.pid)), { recursive: true });
    writeFileSync(join(proc, String(process.pid), 'cmdline'), 'node\0/some/other/program\0');
    expect(ownsPid(process.pid, 'q-20261017-abcdef', proc)).toBe(false);
    writeFileSync(join(proc, String(process.pid), 'cmdline'), 'bash\0spark-submit.sh\0workctl-sql.q-20261017-abcdef\0');
    expect(ownsPid(process.pid, 'q-20261017-abcdef', proc)).toBe(true);
    expect(ownsPid(2 ** 22 + 12345, 'q-20261017-abcdef', proc)).toBe(false);
  });
});
