import { describe, expect, it } from 'vitest';
import { WorkError } from '../../src/core/output';
import { guardSql, lex, maskLiterals } from '../../src/domains/mysql/sql-guard';

function rejects(sql: string, mode: Parameters<typeof guardSql>[1], re?: RegExp) {
  try {
    guardSql(sql, mode);
  } catch (e) {
    expect(e).toBeInstanceOf(WorkError);
    expect((e as WorkError).code).toBe('INVALID_ARGUMENT');
    if (re) expect((e as WorkError).message + ((e as WorkError).hint ?? '')).toMatch(re);
    return;
  }
  throw new Error(`expected rejection: ${sql}`);
}

describe('mysql sql-guard: lexing', () => {
  it('strips comments and a trailing semicolon, keeps optimizer hints', () => {
    const l = lex("-- leading comment\n/* block */ SELECT /*+ MAX_EXECUTION_TIME(10) */ a FROM t # tail\n;");
    expect(l.statements).toBe(1);
    expect(l.sql).toContain('/*+ MAX_EXECUTION_TIME(10) */');
    expect(l.sql).not.toContain('leading comment');
    expect(l.sql.endsWith(';')).toBe(false);
  });

  it('does not split on semicolons inside strings, identifiers or comments', () => {
    expect(lex("SELECT 'a;b', `c;d` FROM t -- x;y\n").statements).toBe(1);
    expect(lex('SELECT 1; SELECT 2').statements).toBe(2);
    expect(lex('SELECT 1;;').statements).toBe(1);
  });

  it('rejects executable comments and unterminated quotes', () => {
    rejects('SELECT /*!50000 SLEEP(1) */ 1', 'execute', /可执行注释/);
    rejects("SELECT 'abc", 'execute', /引号/);
  });
});

describe('mysql sql-guard: execute mode', () => {
  it.each([
    'SELECT * FROM orders WHERE id = 1',
    'select id from orders limit 5;',
    'WITH r AS (SELECT 1 AS x) SELECT * FROM r',
    'SHOW TABLES',
    'DESCRIBE orders',
    'EXPLAIN SELECT * FROM orders',
    '(SELECT 1) UNION (SELECT 2)',
    "SELECT 'INTO OUTFILE' AS s, `for update` FROM t",
  ])('allows %s', (sql) => {
    expect(() => guardSql(sql, 'execute')).not.toThrow();
  });

  it.each([
    ['UPDATE orders SET status = 1', /只允许/],
    ['DELETE FROM orders', /只允许/],
    ['INSERT INTO t VALUES (1)', /只允许/],
    ['DROP TABLE orders', /只允许/],
    ['SET @a = 1', /只允许/],
    ['CALL p()', /只允许/],
    ['SELECT 1; DROP TABLE t', /单条/],
    ["SELECT * FROM t INTO OUTFILE '/tmp/x'", /OUTFILE/],
    ["SELECT * INTO DUMPFILE '/tmp/x' FROM t", /DUMPFILE/],
    ['SELECT id INTO @x FROM t LIMIT 1', /变量/],
    ['SELECT * FROM t FOR UPDATE', /FOR UPDATE/],
    ['SELECT * FROM t FOR SHARE', /FOR SHARE/],
    ['SELECT * FROM t LOCK IN SHARE MODE', /LOCK IN SHARE MODE/],
    ['SELECT @a := 1', /赋值/],
    ["SELECT GET_LOCK('x', 10)", /GET_LOCK/],
    ["SELECT LOAD_FILE('/etc/passwd')", /LOAD_FILE/],
    ['EXPLAIN ANALYZE SELECT 1', /query analyze/],
    ['WITH x AS (SELECT 1) DELETE FROM t', /SELECT/],
    ['-- only a comment', /为空/],
  ])('rejects %s', (sql, re) => rejects(sql, 'execute', re));
});

describe('mysql sql-guard: explain / analyze modes', () => {
  it('explain accepts DML targets (EXPLAIN does not execute)', () => {
    expect(guardSql('UPDATE orders SET status = 1 WHERE id = 1', 'explain').statement_type).toBe('UPDATE');
    expect(guardSql('WITH r AS (SELECT 1) SELECT * FROM r', 'explain').statement_type).toBe('SELECT');
  });
  it('explain rejects EXPLAIN prefixes and EXPLAIN ANALYZE', () => {
    rejects('EXPLAIN SELECT 1', 'explain', /前缀/);
    rejects('EXPLAIN ANALYZE SELECT 1', 'explain', /query analyze/);
    rejects('DROP TABLE t', 'explain');
  });
  it('analyze only accepts SELECT', () => {
    expect(guardSql('SELECT * FROM orders WHERE customer_id = 42', 'analyze').statement_type).toBe('SELECT');
    rejects('UPDATE orders SET status = 1', 'analyze', /只允许 SELECT/);
    rejects('SELECT * FROM t FOR UPDATE', 'analyze', /FOR UPDATE/);
  });
});

describe('mysql sql-guard: literal masking', () => {
  it('replaces string and numeric literals, keeps identifiers', () => {
    expect(maskLiterals("SELECT * FROM t1 WHERE phone = '13800001111' AND id = 42 AND `col2` = \"x\"")).toBe(
      'SELECT * FROM t1 WHERE phone = ? AND id = ? AND `col2` = ?',
    );
    expect(maskLiterals("SELECT 'it''s', 3.14, 0x1F FROM t")).toBe('SELECT ?, ?, ? FROM t');
  });
});
