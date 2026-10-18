import { WorkError } from '../../core/output';

/**
 * Business-date helpers for offline scheduling (Intl based, no tz library).
 * A business date D in timezone TZ maps to the half-open interval [D 00:00, D+1 00:00) in TZ.
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDate(v: string): boolean {
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

export function requireDate(v: string, flag: string): string {
  if (!isValidDate(v)) throw new WorkError('INVALID_ARGUMENT', `${flag} 须为有效日期 YYYY-MM-DD: ${v}`);
  return v;
}

export function requireTimeZone(tz: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    throw new WorkError('INVALID_ARGUMENT', `不是有效的 IANA 时区: ${tz}`, { hint: '示例: --timezone Asia/Shanghai' });
  }
}

function partsIn(instantMs: number, tz: string): Record<string, number> {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(instantMs))) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out;
}

export function tzOffsetMs(instantMs: number, tz: string): number {
  const p = partsIn(instantMs, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instantMs / 1000) * 1000;
}

/** UTC instant of wall-clock `date hh:mm` in `tz`. */
export function zonedToInstant(date: string, hhmm: string, tz: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  // candidates from the offsets in force a day before / after: the wall-clock time maps back
  // to one instant (normal), two (DST fall-back: take the earlier, like fold=0) or none (DST
  // gap, e.g. America/Santiago skips 00:00 → 01:00: shift forward by the gap, as pendulum /
  // zoneinfo do, so a business day never starts inside the previous day)
  const before = tzOffsetMs(guess - 86_400_000, tz);
  const after = tzOffsetMs(guess + 86_400_000, tz);
  const valid = [guess - before, guess - after].filter((i) => i + tzOffsetMs(i, tz) === guess).sort((a, b) => a - b);
  return valid.length ? valid[0] : guess - before;
}

/** 2026-10-16T00:00:00+08:00 */
export function formatInZone(instantMs: number, tz: string): string {
  const p = partsIn(instantMs, tz);
  const off = Math.round(tzOffsetMs(instantMs, tz) / 60000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const abs = Math.abs(off);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${off >= 0 ? '+' : '-'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function dateInZone(instantMs: number, tz: string): string {
  return formatInZone(instantMs, tz).slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Inclusive date range; refuses more than `max` days. */
export function dateRange(from: string, to: string, max = 31): string[] {
  if (from > to) throw new WorkError('INVALID_ARGUMENT', `--from ${from} 晚于 --to ${to}`);
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    out.push(d);
    if (out.length > max) throw new WorkError('INVALID_ARGUMENT', `日期范围超过 ${max} 天上限`, { hint: '分批生成计划' });
  }
  return out;
}

export interface BusinessInterval {
  business_date: string;
  timezone: string;
  start_local: string;
  end_local: string;
  start_utc: string;
  end_utc: string;
  startMs: number;
  endMs: number;
}

export function businessInterval(date: string, tz: string): BusinessInterval {
  const startMs = zonedToInstant(date, '00:00', tz);
  const endMs = zonedToInstant(addDays(date, 1), '00:00', tz);
  return {
    business_date: date,
    timezone: tz,
    start_local: formatInZone(startMs, tz),
    end_local: formatInZone(endMs, tz),
    start_utc: new Date(startMs).toISOString(),
    end_utc: new Date(endMs).toISOString(),
    startMs,
    endMs,
  };
}

export type IntervalMatch = 'exact' | 'contained' | 'covers' | 'overlaps';

/**
 * Relation of a run's data interval [rs, re) to the business-day interval [ds, de).
 * exact: same interval; contained: run interval inside the day (e.g. hourly runs);
 * covers: run interval strictly contains the day (e.g. weekly runs); overlaps: partial overlap.
 * null when they do not intersect.
 */
export function matchInterval(rs: number, re: number, ds: number, de: number): IntervalMatch | null {
  if (!(rs < de && re > ds)) {
    // zero-length run intervals (e.g. schedule=None manual runs) count if the instant falls in the day
    if (rs === re && rs >= ds && rs < de) return 'contained';
    return null;
  }
  if (rs === ds && re === de) return 'exact';
  if (rs >= ds && re <= de) return 'contained';
  if (rs <= ds && re >= de) return 'covers';
  return 'overlaps';
}

export const MAPPING_RULE =
  '业务日期 D 映射为业务时区内的半开区间 [D 00:00, D+1 00:00)；DAG run 的 data_interval 与该区间相交即纳入：' +
  'exact=区间完全相同（日调度），contained=run 区间落在当天内（小时级调度），covers=run 区间覆盖当天（周/月调度），overlaps=部分重叠。' +
  'run 的业务日期取 data_interval_start 在业务时区的日期，而不是 run 的启动时间。';

/** {utc, local} pair for an ISO instant (null-safe). */
export function timePair(iso: string | null | undefined, tz: string): { utc: string; local: string } | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return { utc: new Date(ms).toISOString(), local: formatInZone(ms, tz) };
}

export function durationSeconds(start?: string | null, end?: string | null): number | null {
  if (!start || !end) return null;
  const s = Date.parse(start);
  const e = Date.parse(end);
  return Number.isFinite(s) && Number.isFinite(e) ? Math.round((e - s) / 1000) : null;
}
