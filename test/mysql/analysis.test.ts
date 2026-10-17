import { describe, expect, it } from 'vitest';
import { cell, diffDigests, flattenExplain, maskValue, parseAnalyzeTree, psToMs, type DigestRow } from '../../src/domains/mysql/analysis';

function row(digest: string | null, count: number, waitMs: number, extra: Partial<DigestRow> = {}): DigestRow {
  return {
    schema: 'demo',
    digest,
    digest_text: digest ? `SELECT ${digest}` : null,
    count_star: String(count),
    sum_timer_wait: (BigInt(Math.round(waitMs * 1000)) * 1_000_000n).toString(),
    sum_rows_examined: String(count * 1000),
    sum_rows_sent: String(count),
    sum_rows_affected: '0',
    sum_no_index_used: String(count),
    sum_no_good_index_used: '0',
    sum_errors: '0',
    first_seen: '2026-10-17 00:00:00.000000',
    last_seen: '2026-10-17 12:00:00.000000',
    ...extra,
  };
}

describe('statement digest window diff', () => {
  const start = '2026-10-17T12:00:00.000Z';

  it('computes per-digest deltas and sorts by total latency', () => {
    const t0 = [row('a', 10, 100), row('b', 5, 50)];
    const t1 = [row('a', 15, 400), row('b', 5, 50), row('c', 2, 20, { first_seen: '2026-10-17 12:00:05.000000' })];
    const d = diffDigests(t0, t1, start);
    expect(d.stats.map((s) => s.digest)).toEqual(['a', 'c']); // b had no activity in the window
    expect(d.stats[0]).toMatchObject({ count: 5, total_latency_ms: 300, avg_latency_ms: 60, rows_examined: 5000, no_index_used_count: 5 });
    expect(d).toMatchObject({ disappeared: 0, reset: 0, reappeared: 0 });
  });

  it('never returns negative values: decreasing counters are flagged as reset', () => {
    const d = diffDigests([row('a', 100, 1000)], [row('a', 3, 30)], start);
    expect(d.reset).toBe(1);
    expect(d.stats[0]).toMatchObject({ count: 3, reset_detected: true });
    expect(d.stats.every((s) => s.count >= 0 && s.total_latency_ms >= 0)).toBe(true);
  });

  it('reports digests that disappeared (evicted / truncated) and old digests that reappeared', () => {
    const d = diffDigests([row('a', 1, 1), row('gone', 1, 1)], [row('a', 2, 2), row('old', 4, 4)], start);
    expect(d.disappeared).toBe(1);
    expect(d.reappeared).toBe(1);
  });

  it('counts activity folded into the NULL digest row (digest table full)', () => {
    const d = diffDigests([row(null, 10, 10)], [row(null, 25, 30)], start);
    expect(d.null_digest_count).toBe(15);
  });

  it('converts picoseconds without losing precision on large sums', () => {
    expect(psToMs(123_456_789_000_000_000n)).toBeCloseTo(123_456_789, 3);
    expect(psToMs(1_500_000_000n)).toBe(1.5);
  });
});

describe('EXPLAIN FORMAT=JSON flattening', () => {
  it('extracts tables, access types and inherited filesort/temporary flags', () => {
    const plan = {
      query_block: {
        select_id: 1,
        cost_info: { query_cost: '30227.25' },
        ordering_operation: {
          using_filesort: true,
          grouping_operation: {
            using_temporary_table: true,
            nested_loop: [
              { table: { table_name: 'o', access_type: 'ALL', rows_examined_per_scan: 299145, filtered: '10.00', attached_condition: '(`o`.`customer_id` = 42)', cost_info: { prefix_cost: '30227.25' } } },
              { table: { table_name: 'c', access_type: 'eq_ref', key: 'PRIMARY', used_key_parts: ['id'], rows_examined_per_scan: 1, filtered: '100.00', using_index: true } },
            ],
          },
        },
      },
    };
    const s = flattenExplain(plan);
    expect(s.query_cost).toBe(30227.25);
    expect(s.full_scans).toEqual(['o']);
    expect(s.using_filesort).toBe(true);
    expect(s.using_temporary_table).toBe(true);
    expect(s.tables).toHaveLength(2);
    expect(s.tables[0]).toMatchObject({ table: 'o', access_type: 'ALL', filtered: 10, using_filesort: true, using_temporary_table: true, prefix_cost: 30227.25 });
    expect(s.tables[1]).toMatchObject({ table: 'c', key: 'PRIMARY', using_index: true });
  });

  it('flags full index scans separately', () => {
    const s = flattenExplain({ query_block: { table: { table_name: 'orders', access_type: 'index', key: 'idx_created_at' } } });
    expect(s.full_scans).toEqual([]);
    expect(s.full_index_scans).toEqual(['orders (idx_created_at)']);
  });
});

describe('EXPLAIN ANALYZE tree parsing', () => {
  it('parses estimated vs actual per node (real MySQL 8.4 output)', () => {
    const tree = [
      '-> Limit: 20 row(s)  (cost=1.82 rows=2) (actual time=1.46..122 rows=20 loops=1)',
      '    -> Filter: (orders.customer_id = 42)  (cost=1.82 rows=2) (actual time=1.46..122 rows=20 loops=1)',
      '        -> Index scan on orders using idx_created_at (reverse)  (cost=1.82 rows=20) (actual time=0.0811..115 rows=18590 loops=1)',
      '            -> Covering index lookup on x  (cost=0.25 rows=1) (never executed)',
    ].join('\n');
    const nodes = parseAnalyzeTree(tree);
    expect(nodes).toHaveLength(4);
    expect(nodes[2]).toMatchObject({ depth: 2, operation: 'Index scan on orders using idx_created_at (reverse)', estimated_rows: 20, actual_rows: 18590, actual_last_row_ms: 115, loops: 1 });
    expect(nodes[3]).toMatchObject({ never_executed: true, actual_rows: null });
  });
});

describe('value masking', () => {
  it('masks phones, emails and short values', () => {
    expect(maskValue('13800001111')).toBe('138****1111');
    expect(maskValue('user00001@example.com')).toBe('u***@example.com');
    expect(maskValue('abc')).toBe('***');
    expect(maskValue(null)).toBeNull();
  });
  it('makes cells JSON-safe and caps long text', () => {
    expect(cell(Buffer.from('hello')).value).toBe('hello');
    expect(cell(Buffer.from([0, 1, 2, 255])).value).toBe('0x000102ff');
    expect(cell('x'.repeat(3000)).truncated).toBe(true);
  });
});
