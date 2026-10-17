import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { invoke } from '../../src/core/engine';
import { WorkError } from '../../src/core/output';
import { Registry } from '../../src/core/registry';
import mysqlDomain from '../../src/domains/mysql';
import { diffDigests, maskValue, parseAnalyzeTree, type DigestRow } from '../../src/domains/mysql/analysis';
import { sqlText } from '../../src/domains/mysql/capabilities/query';
import { guardSql, lex, sensitiveOutputPlan } from '../../src/domains/mysql/sql-guard';

process.env.WORKCTL_VALIDATE_OUTPUT = '1';

function rejects(sql: string, mode: Parameters<typeof guardSql>[1], re?: RegExp) {
  try {
    guardSql(sql, mode);
  } catch (e) {
    expect(e).toBeInstanceOf(WorkError);
    expect((e as WorkError).code).toBe('INVALID_ARGUMENT');
    if (re) expect((e as WorkError).message).toMatch(re);
    return;
  }
  throw new Error(`expected rejection: ${sql}`);
}

describe('review: guard bypasses', () => {
  it('rejects optimizer hints that override MAX_EXECUTION_TIME / session variables (verified live: hint let SLEEP(7) run past the 5s limit)', () => {
    rejects('SELECT /*+ MAX_EXECUTION_TIME(20000) */ SLEEP(7)', 'execute', /MAX_EXECUTION_TIME/);
    rejects('SELECT /*+ SET_VAR(sql_select_limit=100000) */ * FROM t', 'execute', /SET_VAR/);
    rejects('SELECT /*+ RESOURCE_GROUP(rg) */ * FROM t', 'analyze', /RESOURCE_GROUP/);
    // harmless hints stay allowed; explain does not execute
    expect(() => guardSql('SELECT /*+ NO_INDEX_MERGE(t) */ * FROM t', 'execute')).not.toThrow();
    expect(() => guardSql('SELECT /*+ MAX_EXECUTION_TIME(1) */ 1', 'explain')).not.toThrow();
  });

  it('rejects deny-listed functions called through quoted names (verified live: `IS_FREE_LOCK`(...) executes)', () => {
    rejects("SELECT `GET_LOCK`('x', 100)", 'execute', /GET_LOCK/);
    rejects("SELECT `load_file`('/etc/passwd')", 'execute', /LOAD_FILE/);
    rejects('SELECT "GET_LOCK"(\'x\', 1)', 'execute', /GET_LOCK/); // ANSI_QUOTES servers
    expect(() => guardSql('SELECT `get_lock_count` FROM t', 'execute')).not.toThrow();
  });

  it('treats only ASCII whitespace as the "-- " comment separator, like the MySQL lexer', () => {
    // U+00A0 after -- is not a comment for MySQL, so the rest must still be checked
    rejects('SELECT * FROM t WHERE a = 1 --\u00a0x FOR UPDATE', 'execute', /FOR UPDATE/);
    expect(lex('SELECT 1 --\tcomment FOR UPDATE').sql).toBe('SELECT 1');
    expect(lex('SELECT 1 --\u0001comment').sql).toBe('SELECT 1');
  });

  it('checks backslash escapes under NO_BACKSLASH_ESCAPES as well', () => {
    // with NO_BACKSLASH_ESCAPES the string ends at \' and INTO OUTFILE is real SQL
    rejects("SELECT 'a\\' INTO OUTFILE '/tmp/x' -- '", 'execute', /NO_BACKSLASH_ESCAPES|OUTFILE/);
    rejects("SELECT 'it\\'s'", 'execute', /NO_BACKSLASH_ESCAPES/);
    expect(() => guardSql("SELECT 'it''s', 'C:\\\\dir' AS p", 'execute')).not.toThrow();
  });
});

describe('review: sensitive output analysis', () => {
  const sens = new Set(['phone', 'email']);
  const plan = (sql: string) => sensitiveOutputPlan(guardSql(sql, 'execute').tokens, sens);

  it('taints expression / alias columns built from sensitive columns', () => {
    const p = plan("SELECT id, CONCAT(phone, '') AS x, UPPER(name) FROM customers");
    expect(p.all).toBe(false);
    expect([...p.positions]).toEqual([1]);
  });
  it('taints UNION positions from any branch', () => {
    expect([...plan("SELECT 'x' AS a, id FROM t UNION SELECT c.phone, id FROM customers c").positions]).toEqual([0]);
  });
  it('taints everything for derived tables / CTEs referencing sensitive columns', () => {
    expect(plan("SELECT x FROM (SELECT CONCAT(phone,'') AS x FROM customers) d").all).toBe(true);
    expect(plan('WITH d AS (SELECT email AS e FROM customers) SELECT e FROM d').all).toBe(true);
    expect(plan('SELECT *, LOWER(email) FROM customers').all).toBe(true);
  });
  it('does not taint filters / counts', () => {
    const p = plan("SELECT COUNT(*) FROM customers WHERE email IS NULL AND id IN (SELECT id FROM customers WHERE phone LIKE '138%')");
    expect(p.all).toBe(false);
    expect(p.positions.size).toBe(0);
  });
});

function row(count: number, waitMs: number, firstSeen = '2026-10-17 00:00:00.000000'): DigestRow {
  return {
    schema: 'demo',
    digest: 'a',
    digest_text: 'SELECT a',
    count_star: String(count),
    sum_timer_wait: (BigInt(Math.round(waitMs * 1000)) * 1_000_000n).toString(),
    sum_rows_examined: String(count * 10),
    sum_rows_sent: String(count),
    sum_rows_affected: '0',
    sum_no_index_used: '0',
    sum_no_good_index_used: '0',
    sum_errors: '0',
    first_seen: firstSeen,
    last_seen: '2026-10-17 12:00:00.000000',
  };
}

describe('review: digest window reset detection', () => {
  it('detects a reset when COUNT_STAR re-grew past t0 but FIRST_SEEN moved (no negative/understated deltas)', () => {
    const d = diffDigests([row(5, 1000)], [row(8, 200, '2026-10-17 12:00:03.000000')], '2026-10-17T12:00:00.000Z');
    expect(d.reset).toBe(1);
    expect(d.stats[0]).toMatchObject({ count: 8, total_latency_ms: 200, reset_detected: true });
  });
  it('detects a reset when any counter decreased even if COUNT_STAR did not', () => {
    const d = diffDigests([row(5, 1000)], [{ ...row(6, 300) }], '2026-10-17T12:00:00.000Z');
    expect(d.reset).toBe(1);
    expect(d.stats.every((s) => s.total_latency_ms >= 0 && s.rows_examined >= 0)).toBe(true);
  });
});

describe('review: EXPLAIN ANALYZE numbers and masking', () => {
  it('parses scientific notation with negative exponents (verified live on 8.4: actual time=880e-6..0.00105)', () => {
    const [n] = parseAnalyzeTree('-> Rows fetched before execution  (cost=0..0 rows=1) (actual time=880e-6..0.00105 rows=1 loops=1)\n');
    expect(n).toMatchObject({ estimated_cost: 0, estimated_rows: 1, actual_first_row_ms: 0.00088, actual_last_row_ms: 0.00105, actual_rows: 1, loops: 1 });
  });
  it('never reveals most of a short sensitive value', () => {
    expect(maskValue('1234567')).toBe('1****7');
    expect(maskValue('13800001111')).toBe('138****1111');
    expect(maskValue('12345')).toBe('***');
  });
});

describe('review: inline --sql input', () => {
  let configPath: string;
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'workctl-mysql-inline-'));
    writeFileSync(join(dir, 'pw'), 'not-a-real-password\n');
    configPath = join(dir, 'workctl.yaml');
    writeFileSync(
      configPath,
      ['current_profile: t', 'profiles:', '  t:', '    env: test', `    state_dir: ${join(dir, 'state')}`, '    endpoints:', '      mysql:', '        down:', '          host: 127.0.0.1', '          port: 1', '          user: workctl_ro', '          password_ref: file:pw'].join('\n'),
    );
  });
  const reg = () => {
    const r = new Registry();
    r.addDomain(mysqlDomain);
    return r;
  };

  it('requires exactly one of --sql / --sql-file', async () => {
    const f = join(dir, 'q.sql');
    writeFileSync(f, 'SELECT 1');
    for (const cap of ['mysql.query.execute', 'mysql.query.explain', 'mysql.query.analyze']) {
      const none = await invoke(reg(), cap, { instance: 'down', database: 'demo' }, { configPath });
      expect(none.error?.code).toBe('INVALID_ARGUMENT');
      expect(none.error?.message).toMatch(/--sql 或 --sql-file/);
      const both = await invoke(reg(), cap, { instance: 'down', database: 'demo', sql: 'SELECT 1', sql_file: f }, { configPath });
      expect(both.error?.code).toBe('INVALID_ARGUMENT');
      expect(both.error?.message).toMatch(/只能提供一个/);
    }
  });

  it('applies the same guard to inline SQL (rejected before connecting) and passes valid SQL through', async () => {
    const w = await invoke(reg(), 'mysql.query.execute', { instance: 'down', database: 'demo', sql: 'DELETE FROM orders' }, { configPath });
    expect(w.error?.code).toBe('INVALID_ARGUMENT');
    const a = await invoke(reg(), 'mysql.query.analyze', { instance: 'down', database: 'demo', sql: 'SELECT /*+ MAX_EXECUTION_TIME(99999) */ 1' }, { configPath });
    expect(a.error?.code).toBe('INVALID_ARGUMENT');
    const ok = await invoke(reg(), 'mysql.query.explain', { instance: 'down', database: 'demo', sql: 'SELECT * FROM orders WHERE id = 1' }, { configPath });
    expect(ok.error?.code).toBe('UPSTREAM_UNAVAILABLE'); // got past validation, endpoint is down
  });

  it('enforces the 256 KiB budget for inline SQL', () => {
    expect(() => sqlText({ sql: `SELECT '${'x'.repeat(256 * 1024)}'` })).toThrow(/字节上限/);
    expect(sqlText({ sql: 'SELECT 1' })).toEqual({ text: 'SELECT 1', origin: 'inline' });
  });

  it('sql_file is no longer required in the input spec, sql is offered', () => {
    const c = reg().get('mysql.query.explain')!;
    expect(c.inputs.sql_file.required ?? false).toBe(false);
    expect(c.inputs.sql.type).toBe('string');
  });
});
