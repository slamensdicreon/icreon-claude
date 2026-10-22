/**
 * Working-time arithmetic in a project's time zone, without a date library. The working day is
 * 08:00–18:00 local, Monday to Friday: ten hours, which is also how the Engagement view lays out
 * days.
 */

export const WORK_START = 8;
export const WORK_END = 18;
const HOUR = 3_600_000;

export interface LocalParts {
  year: number;
  month: number; // 1–12
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday. */
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function localParts(t: number, tz: string): LocalParts {
  const parts = Object.fromEntries(
    formatter(tz)
      .formatToParts(new Date(t))
      .map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAYS.indexOf(parts.weekday!),
  };
}

/** Milliseconds the zone is ahead of UTC at instant `t`. */
function offsetAt(t: number, tz: string): number {
  const p = localParts(t, tz);
  // Every zone in use is offset by whole minutes, so compare at minute precision.
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(t / 60_000) * 60_000;
}

/** The instant a local wall-clock time occurs in `tz` (hours may be fractional). */
export function zonedTime(
  year: number,
  month: number,
  day: number,
  hours: number,
  tz: string,
): number {
  const guess = Date.UTC(year, month - 1, day) + hours * HOUR;
  const first = guess - offsetAt(guess, tz);
  // Correct once for a DST change between the guess and the answer.
  return guess - offsetAt(first, tz);
}

const isWorkday = (p: LocalParts) => p.weekday >= 1 && p.weekday <= 5;
const hourOf = (p: LocalParts, t: number) =>
  p.hour + p.minute / 60 + new Date(t).getUTCSeconds() / 3600;

/** Local midnight-based calendar step: the same wall-clock hour `days` days later. */
function dayAt(p: LocalParts, plusDays: number, hours: number, tz: string): number {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + plusDays));
  return zonedTime(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hours, tz);
}

/** The first working moment at or after `t`. */
export function nextWorkingMoment(t: number, tz: string): number {
  for (let i = 0; i < 14; i++) {
    const p = localParts(t, tz);
    const h = hourOf(p, t);
    if (isWorkday(p) && h >= WORK_START && h < WORK_END) return t;
    if (isWorkday(p) && h < WORK_START) return dayAt(p, 0, WORK_START, tz);
    t = dayAt(p, 1, WORK_START, tz);
  }
  return t;
}

/** `t` plus `hours` of working time. */
export function addWorkingHours(t: number, hours: number, tz: string): number {
  let at = nextWorkingMoment(t, tz);
  let left = hours;
  for (let i = 0; i < 400 && left > 1e-9; i++) {
    const p = localParts(at, tz);
    const room = WORK_END - hourOf(p, at);
    if (left <= room) return at + left * HOUR;
    left -= room;
    at = nextWorkingMoment(dayAt(p, 1, WORK_START, tz), tz);
  }
  return at;
}

/** Working hours between two instants (0 when `b` ≤ `a`). */
export function workingHoursBetween(a: number, b: number, tz: string): number {
  if (b <= a) return 0;
  let at = nextWorkingMoment(a, tz);
  let total = 0;
  for (let i = 0; i < 400 && at < b; i++) {
    const p = localParts(at, tz);
    const dayEnd = dayAt(p, 0, WORK_END, tz);
    total += (Math.min(dayEnd, b) - at) / HOUR;
    at = nextWorkingMoment(dayAt(p, 1, WORK_START, tz), tz);
  }
  return Math.max(0, total);
}

export const localDate = (t: number, tz: string) => {
  const p = localParts(t, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
};

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const DAYNAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Mon 19". */
export const shortDay = (t: number, tz: string) => {
  const p = localParts(t, tz);
  return `${WEEKDAYS[p.weekday]} ${p.day}`;
};

/** "Thursday, October 22". */
export const longDay = (t: number, tz: string) => {
  const p = localParts(t, tz);
  return `${DAYNAMES[p.weekday]}, ${MONTHS[p.month - 1]} ${p.day}`;
};

/** "2:30 PM". */
export const clockTime = (t: number, tz: string) => {
  const p = localParts(t, tz);
  return `${p.hour % 12 || 12}:${String(p.minute).padStart(2, '0')} ${p.hour < 12 ? 'AM' : 'PM'}`;
};

/** Working days from the day of `from` to the day of `to`, inclusive, as local noon instants. */
export function workingDays(from: number, to: number, tz: string): number[] {
  const out: number[] = [];
  const start = localParts(from, tz);
  for (let i = 0; i < 400; i++) {
    const noon = dayAt(start, i, 12, tz);
    if (noon > to && localDate(noon, tz) > localDate(to, tz)) break;
    if (isWorkday(localParts(noon, tz))) out.push(noon);
  }
  return out;
}

/** Local `hours` on the day of `t`. */
export const sameDayAt = (t: number, hours: number, tz: string) =>
  dayAt(localParts(t, tz), 0, hours, tz);
