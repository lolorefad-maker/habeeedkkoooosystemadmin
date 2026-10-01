import { DateTime } from 'luxon';

export const SECOND = 1_000;
export const MINUTE = 60_000;
export const HOUR = 3_600_000;

/** "HH:mm" → minutes since midnight. Accepts "24:00" as 1440 (end of day). */
export function parseHHmm(value: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) throw new Error(`Invalid time "${value}", expected HH:mm`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) throw new Error(`Invalid time "${value}"`);
  return h * 60 + min;
}

export function toLocal(t: number, tz: string): DateTime {
  return DateTime.fromMillis(t, { zone: tz });
}

/** Minutes since local midnight, with sub-minute precision. */
export function minutesOfDay(dt: DateTime): number {
  return dt.hour * 60 + dt.minute + dt.second / 60 + dt.millisecond / 60_000;
}

/** Local wall-clock time `minutes` after midnight of `day`'s date (DST-safe). */
export function atLocalMinutes(day: DateTime, minutes: number): DateTime {
  const base = day.startOf('day');
  if (minutes >= 1440) return base.plus({ days: 1 });
  return base.set({ hour: Math.floor(minutes / 60), minute: minutes % 60, second: 0, millisecond: 0 });
}

/**
 * The shop's "business day" for an instant. A lounge open until 03:00 still belongs to
 * the previous day, so anything before `cutoff` counts toward the day before.
 */
export function businessDayOf(t: number, tz: string, cutoff: string): string {
  const dt = toLocal(t, tz);
  const shifted = minutesOfDay(dt) < parseHHmm(cutoff) ? dt.minus({ days: 1 }) : dt;
  return shifted.toISODate()!;
}

/** [start, end) instants of a business day. */
export function businessDayRange(day: string, tz: string, cutoff: string): { start: number; end: number } {
  const date = DateTime.fromISO(day, { zone: tz });
  if (!date.isValid) throw new Error(`Invalid business day "${day}"`);
  const cut = parseHHmm(cutoff);
  const start = atLocalMinutes(date, cut);
  const end = atLocalMinutes(date.plus({ days: 1 }), cut);
  return { start: start.toMillis(), end: end.toMillis() };
}

/** "1:05:09" for ≥ 1h, otherwise "05:09". Negative values are formatted by magnitude. */
export function formatDuration(ms: number): string {
  const total = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
