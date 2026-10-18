/**
 * Business-timezone helpers built on Intl (no external tz library).
 * Partition values such as `dt=2026-10-16` are business dates in the table's
 * timezone; file mtimes are UTC instants. These helpers convert between them.
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDate(v: string): boolean {
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
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
  for (const p of fmt.formatToParts(new Date(instantMs))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out;
}

/** Offset of `tz` from UTC at the given instant, in ms (Asia/Shanghai → +8h). */
export function tzOffsetMs(instantMs: number, tz: string): number {
  const p = partsIn(instantMs, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** The UTC instant of local wall-clock time `date` + `hh:mm` in `tz`. */
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

/** ISO-8601 local time with numeric offset, e.g. 2026-10-17T05:12:03+08:00. */
export function formatInZone(instantMs: number, tz: string): string {
  const p = partsIn(instantMs, tz);
  const off = Math.round(tzOffsetMs(instantMs, tz) / 60000);
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Calendar date (YYYY-MM-DD) of an instant in `tz`. */
export function dateInZone(instantMs: number, tz: string): string {
  return formatInZone(instantMs, tz).slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
