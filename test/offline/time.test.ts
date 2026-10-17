import { describe, expect, it } from 'vitest';
import { businessInterval, dateRange, formatInZone, matchInterval, zonedToInstant } from '../../src/domains/offline/time';
import { decideAction, writeModeCheck } from '../../src/domains/offline/backfill';
import { sparkAppIds } from '../../src/domains/offline/airflow';

describe('business date mapping', () => {
  it('maps a business date to [D 00:00, D+1 00:00) in Asia/Shanghai', () => {
    const iv = businessInterval('2026-10-16', 'Asia/Shanghai');
    expect(iv.start_utc).toBe('2026-10-15T16:00:00.000Z');
    expect(iv.end_utc).toBe('2026-10-16T16:00:00.000Z');
    expect(iv.start_local).toBe('2026-10-16T00:00:00+08:00');
    expect(iv.end_local).toBe('2026-10-17T00:00:00+08:00');
  });

  it('handles DST days (America/New_York 2026-11-01 is 25h long)', () => {
    const iv = businessInterval('2026-11-01', 'America/New_York');
    expect((iv.endMs - iv.startMs) / 3_600_000).toBe(25);
    expect(iv.start_local).toBe('2026-11-01T00:00:00-04:00');
    expect(iv.end_local).toBe('2026-11-02T00:00:00-05:00');
  });

  it('classifies run intervals against the business day', () => {
    const d = businessInterval('2026-10-16', 'Asia/Shanghai');
    const h = 3_600_000;
    expect(matchInterval(d.startMs, d.endMs, d.startMs, d.endMs)).toBe('exact');
    expect(matchInterval(d.startMs + h, d.startMs + 2 * h, d.startMs, d.endMs)).toBe('contained');
    expect(matchInterval(d.startMs - 24 * h, d.endMs + 24 * h, d.startMs, d.endMs)).toBe('covers');
    expect(matchInterval(d.startMs - 12 * h, d.startMs + 12 * h, d.startMs, d.endMs)).toBe('overlaps');
    // a manual run triggered at D 00:00 without explicit interval covers D-1 → no match for D
    expect(matchInterval(d.startMs - 24 * h, d.startMs, d.startMs, d.endMs)).toBeNull();
  });

  it('builds bounded inclusive date ranges', () => {
    expect(dateRange('2026-10-14', '2026-10-16')).toEqual(['2026-10-14', '2026-10-15', '2026-10-16']);
    expect(() => dateRange('2026-10-16', '2026-10-14')).toThrow();
    expect(() => dateRange('2026-01-01', '2026-03-01', 31)).toThrow();
  });

  it('formats instants with offsets', () => {
    expect(formatInZone(zonedToInstant('2026-10-17', '06:00', 'Asia/Shanghai'), 'UTC')).toBe('2026-10-16T22:00:00+00:00');
  });
});

describe('backfill decisions', () => {
  it('chooses actions per business date', () => {
    expect(decideAction({ existing: [], rerunSucceeded: false }).action).toBe('trigger_new');
    expect(decideAction({ existing: [{ run_id: 'a', state: 'success', run_type: 'manual', match: 'exact' }], rerunSucceeded: false }).action).toBe('skip_succeeded');
    expect(decideAction({ existing: [{ run_id: 'a', state: 'success', run_type: 'manual', match: 'exact' }], rerunSucceeded: true }).action).toBe('rerun');
    expect(decideAction({ existing: [{ run_id: 'a', state: 'failed', run_type: 'manual', match: 'exact' }], rerunSucceeded: false })).toMatchObject({ action: 'clear_failed', run_id: 'a' });
    expect(decideAction({ existing: [{ run_id: 'a', state: 'running', run_type: 'scheduled', match: 'exact' }], rerunSucceeded: true }).action).toBe('skip_in_progress');
  });

  it('blocks append rewrites unless explicitly allowed', () => {
    expect(writeModeCheck('overwrite_partition', [{ action: 'rerun', partition_state: 'present' }], false).ok).toBe(true);
    expect(writeModeCheck('append', [{ action: 'rerun', partition_state: 'present' }], false).ok).toBe(false);
    expect(writeModeCheck('append', [{ action: 'rerun', partition_state: 'present' }], true).ok).toBe(true);
    expect(writeModeCheck('append', [{ action: 'trigger_new', partition_state: 'missing' }], false).ok).toBe(true);
  });

  it('extracts spark application ids from task output', () => {
    expect(sparkAppIds('x\nWORKCTL_SPARK_APP_ID=local-1792240678198\n')).toEqual(['local-1792240678198']);
    expect(sparkAppIds('INFO Client: Submitted application application_1700000000000_0042')).toEqual(['application_1700000000000_0042']);
  });
});
