import { describe, expect, it } from 'vitest';
import { WorkError } from '../../src/core/output';
import { guardPg, lexPg, maskPgLiterals, maskValue } from '../../src/domains/postgres/sql-guard';

const code = (fn: () => unknown) => {
  try {
    fn();
    return 'ok';
  } catch (e) {
    return e instanceof WorkError ? e.code : String(e);
  }
};

describe('postgres SQL lexer', () => {
  it('counts statements outside quotes, dollar quotes and nested comments', () => {
    expect(lexPg("SELECT ';' AS a").statements).toBe(1);
    expect(lexPg('SELECT $$;$$, $tag$ ; $$ ; $tag$').statements).toBe(1);
    expect(lexPg('SELECT 1 /* a /* nested ; */ still comment ; */').statements).toBe(1);
    expect(lexPg('SELECT 1; SELECT 2').statements).toBe(2);
    expect(lexPg('SELECT 1;  ;').statements).toBe(1);
    expect(lexPg('SELECT "a;b" FROM t -- ; comment').statements).toBe(1);
  });

  it('treats E-strings with backslash escapes and keeps $n as parameters', () => {
    const l = lexPg("SELECT E'it\\'s; DELETE' , $1");
    expect(l.statements).toBe(1);
    expect(l.tokens.filter((t) => t.kind === 'word').map((t) => t.upper)).toEqual(['SELECT', 'E']);
    expect(l.tokens.some((t) => t.kind === 'param' && t.text === '$1')).toBe(true);
  });

  it('rejects unterminated quotes and comments', () => {
    expect(code(() => lexPg("SELECT 'abc"))).toBe('INVALID_ARGUMENT');
    expect(code(() => lexPg('SELECT 1 /* x'))).toBe('INVALID_ARGUMENT');
    expect(code(() => lexPg('SELECT $a$ x'))).toBe('INVALID_ARGUMENT');
  });
});

describe('postgres guardPg', () => {
  it.each([
    'SELECT * FROM orders WHERE customer_id = 42',
    'WITH x AS (SELECT 1 AS a) SELECT a FROM x',
    '(SELECT 1) UNION ALL (SELECT 2)',
    'VALUES (1), (2)',
    'TABLE orders',
    "SELECT 'DELETE FROM orders; DROP TABLE x' AS harmless",
    'SELECT "update" FROM t',
    'SELECT CASE WHEN true THEN 1 END',
    'SELECT pg_sleep(0.1)',
  ])('run accepts %s', (sql) => {
    expect(code(() => guardPg(sql, 'run'))).toBe('ok');
  });

  it.each([
    ['DELETE FROM orders', 'DELETE'],
    ['UPDATE orders SET status = 1', 'UPDATE'],
    ['INSERT INTO t VALUES (1)', 'INSERT'],
    ['CREATE TABLE x (a int)', 'CREATE'],
    ['SELECT 1; SELECT 2', '单条'],
    ['SELECT 1; DROP TABLE orders', '单条'],
    ['WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d', 'DELETE'],
    ['SELECT * INTO new_table FROM orders', 'INTO'],
    ['SELECT * FROM orders FOR SHARE', 'FOR'],
    ['SELECT * FROM orders FOR NO KEY UPDATE', 'UPDATE'],
    ['SELECT pg_terminate_backend(123)', 'pg_terminate_backend'],
    ['SELECT set_config(\'statement_timeout\', \'0\', false)', 'set_config'],
    ['SELECT pg_advisory_lock(1)', 'pg_advisory_lock'],
    ["SELECT query_to_xml('delete from orders', true, true, '')", 'query_to_xml'],
    ['SELECT nextval(\'orders_id_seq\')', 'nextval'],
    ["SELECT pg_read_file('/etc/passwd')", 'pg_read_file'],
    ['EXPLAIN ANALYZE SELECT 1', 'EXPLAIN'],
    ['SET statement_timeout = 0', 'SET'],
    ['COPY orders TO STDOUT', 'COPY'],
    ['', '为空'],
    ['-- only a comment', '为空'],
  ])('run rejects %s', (sql, fragment) => {
    let msg = '';
    try {
      guardPg(sql, 'run');
    } catch (e) {
      expect(e).toBeInstanceOf(WorkError);
      expect((e as WorkError).code).toBe('INVALID_ARGUMENT');
      msg = (e as WorkError).message;
    }
    expect(msg).toContain(fragment);
  });

  it('explain accepts DML (not executed) but not an EXPLAIN prefix', () => {
    expect(guardPg('UPDATE orders SET status = 1 WHERE id = 2', 'explain').statement_type).toBe('UPDATE');
    expect(guardPg('WITH x AS (SELECT 1) DELETE FROM orders', 'explain').statement_type).toBe('DELETE');
    expect(code(() => guardPg('EXPLAIN SELECT 1', 'explain'))).toBe('INVALID_ARGUMENT');
    expect(code(() => guardPg('DROP TABLE orders', 'explain'))).toBe('INVALID_ARGUMENT');
    expect(code(() => guardPg('SELECT pg_terminate_backend(1)', 'explain'))).toBe('INVALID_ARGUMENT');
  });

  it('analyze only accepts pure queries', () => {
    expect(guardPg('SELECT 1', 'analyze').statement_type).toBe('SELECT');
    expect(code(() => guardPg('DELETE FROM orders', 'analyze'))).toBe('INVALID_ARGUMENT');
    expect(code(() => guardPg('WITH d AS (UPDATE orders SET status = 1 RETURNING 1) SELECT * FROM d', 'analyze'))).toBe('INVALID_ARGUMENT');
  });

  it('strips comments and the trailing semicolon, flags $n placeholders', () => {
    const g = guardPg('SELECT id /* c */ FROM orders WHERE id = $1; -- tail', 'explain');
    expect(g.sql).toBe('SELECT id   FROM orders WHERE id = $1');
    expect(g.has_params).toBe(true);
  });
});

describe('postgres literal masking', () => {
  it.each([
    ["SELECT * FROM customers WHERE phone = '+86-13800001111'", 'SELECT * FROM customers WHERE phone = ?'],
    ["UPDATE orders SET status = 'paid' WHERE id = 42", 'UPDATE orders SET status = ? WHERE id = ?'],
    ["SELECT E'a\\'b', 'it''s', 3.14, x1", 'SELECT ?, ?, ?, x1'],
    ['SELECT $body$secret$body$, $1, "Col 1"', 'SELECT ?, $1, "Col 1"'],
    ['SELECT a FROM t2 WHERE b > 10e3', 'SELECT a FROM t2 WHERE b > ?'],
    // comment contents are data too (sqlcommenter tags, pasted phone numbers, tokens)
    ["/* user=alice phone=13800001111 */ SELECT 1 -- token abc123\nFROM t", '/* ? */ SELECT ? -- ?\nFROM t'],
    ['SELECT /* a /* nested 13800001111 */ still */ x', 'SELECT /* ? */ x'],
    ["SELECT '--not a comment', x -- trailing", 'SELECT ?, x -- ?'],
    ['SELECT x /* truncated by track_activity_query_size', 'SELECT x /* ? */'],
  ])('%s', (input, expected) => {
    expect(maskPgLiterals(input)).toBe(expected);
  });

  it('never throws on truncated text', () => {
    expect(maskPgLiterals("SELECT 'unterminated")).toBe('SELECT ?');
    expect(maskPgLiterals('SELECT $x$ cut')).toBe('SELECT ?');
  });

  it('masks sensitive values keeping a little shape', () => {
    expect(maskValue('+86-13800001111')).toBe('+86****1111');
    expect(maskValue('c42@example.invalid')).toBe('c***@example.invalid');
    expect(maskValue('abc')).toBe('***');
    expect(maskValue('(1,customer-1,+86-13800007919,c1@example.invalid)')).toBe('***');
    expect(maskValue('{a@b.c,d@e.f}')).toBe('***');
    expect(maskValue(null)).toBeNull();
  });
});

describe('postgres guardPg deny-list bypasses (review regressions)', () => {
  it.each([
    // U&"\0071uery_to_xml" is query_to_xml after server-side decoding: the name check cannot see it
    ["SELECT U&\"\\0071uery_to_xml\"('select 1', true, true, '')", 'Unicode'],
    ['SELECT u&"\\0070g_terminate_backend"(1)', 'Unicode'],
    ["SELECT pg_catalog.U&\"\\006Eextval\"('orders_id_seq')", 'Unicode'],
    // ts_rewrite(tsquery, text) executes the text as a query (like query_to_xml)
    ["SELECT ts_rewrite('a & b'::tsquery, 'SELECT ''a''::tsquery, ''c''::tsquery')", 'ts_rewrite'],
    // assign a transaction ID even inside a READ ONLY transaction
    ['SELECT txid_current()', 'txid_current'],
    ['SELECT pg_current_xact_id()', 'pg_current_xact_id'],
  ])('run rejects %s', (sql, fragment) => {
    for (const mode of ['run', 'analyze', 'explain'] as const) {
      let msg = '';
      try {
        guardPg(sql, mode);
      } catch (e) {
        expect((e as WorkError).code).toBe('INVALID_ARGUMENT');
        msg = (e as WorkError).message;
      }
      expect(msg, mode).toContain(fragment);
    }
  });

  it('keeps accepting U& strings, the U & operator spelling and non-assigning xact functions', () => {
    expect(code(() => guardPg("SELECT U&'d\\0061ta'", 'run'))).toBe('ok');
    expect(code(() => guardPg('SELECT xu&"a" FROM t', 'run'))).toBe('ok');
    expect(code(() => guardPg('SELECT txid_current_if_assigned(), pg_current_xact_id_if_assigned()', 'run'))).toBe('ok');
  });
});
