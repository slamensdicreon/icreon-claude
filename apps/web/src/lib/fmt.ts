import type { AgentView } from '@lw/contracts';

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = tz + JSON.stringify(opts);
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts });
    fmtCache.set(key, f);
  }
  return f;
}

const at = (t: string | number | Date) => (t instanceof Date ? t : new Date(t));

/** "2:02 PM". */
export const clock = (t: string | number | Date, tz: string) =>
  fmt(tz, { hour: 'numeric', minute: '2-digit' }).format(at(t));

/** "Mon 19". */
export function shortDay(t: string | number | Date, tz: string): string {
  const parts = fmt(tz, { weekday: 'short', day: 'numeric' }).formatToParts(at(t));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('weekday')} ${part('day')}`;
}

/** "Thursday, October 22". */
export const longDay = (t: string | number | Date, tz: string) =>
  fmt(tz, { weekday: 'long', month: 'long', day: 'numeric' }).format(at(t));

export const localDate = (t: string | number | Date, tz: string) =>
  fmt(tz, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(at(t));

/** "Mon 9:12 AM", or just "2:02 PM" when it is today. */
export function stamp(t: string | number | Date, tz: string, now = Date.now()): string {
  return localDate(t, tz) === localDate(now, tz)
    ? clock(t, tz)
    : `${fmt(tz, { weekday: 'short' }).format(at(t))} ${clock(t, tz)}`;
}

/** The zone's abbreviation ("ET" for New York). */
export function zoneLabel(tz: string): string {
  if (tz === 'America/New_York') return 'ET';
  if (tz === 'America/Chicago') return 'CT';
  if (tz === 'America/Denver') return 'MT';
  if (tz === 'America/Los_Angeles') return 'PT';
  const p = fmt(tz, { timeZoneName: 'short' }).formatToParts(new Date());
  return p.find((x) => x.type === 'timeZoneName')?.value ?? tz;
}

/** "just now", "12 min ago", "1 h 5 min ago". */
export function age(t: string | number, now = Date.now()): string {
  const m = Math.max(0, Math.floor((now - at(t).getTime()) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)} h ${m % 60} min ago`;
}

/** "Day 4, 5h in" (or "5h 02m" on the first day). */
export function elapsed(since: string | null, now = Date.now()): string {
  if (!since) return 'Not started';
  const m = Math.max(0, Math.floor((now - Date.parse(since)) / 60_000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return d
    ? `Day ${d + 1}, ${h}h in`
    : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

export function duration(ms: number | null): string {
  if (ms === null || ms === 0) return '–';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${Number.isInteger(s) ? s : s.toFixed(1)} s`;
  return `${Math.floor(s / 60)} m ${Math.round(s % 60)} s`;
}

export function tokens(n: number | null): string {
  if (!n) return '–';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${n >= 1e5 ? Math.round(n / 1e3) : (n / 1e3).toFixed(1)}k`;
  return String(n);
}

export function initials(a: Pick<AgentView, 'persona' | 'name' | 'tier'>): string {
  if (a.tier === 'chief_of_staff') return 'C';
  const w = (a.persona ?? a.name).split(' ');
  return (w[0]![0]! + (w.length > 1 ? w[w.length - 1]![0]! : '')).toUpperCase();
}

export const firstName = (a: Pick<AgentView, 'persona' | 'name'>) =>
  (a.persona ?? a.name).split(' ')[0]!;

/** Role names in prose ("the Solution Architect") as people, with the role on hover. */
export interface Mention {
  text: string;
  /** Set for a person: full name and role, for the hover title. */
  title?: string;
}

export function whoize(text: string, agents: AgentView[]): Mention[] {
  const roles = agents
    .filter((a) => a.tier !== 'chief_of_staff' && a.persona)
    .sort((x, y) => y.name.length - x.name.length);
  if (!roles.length) return [{ text }];
  const rx = new RegExp(
    `\\b([Tt]he )?(${roles.map((a) => a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
    'g',
  );
  const out: Mention[] = [];
  let last = 0;
  for (const m of text.matchAll(rx)) {
    const a = roles.find((r) => r.name === m[2])!;
    out.push({ text: text.slice(last, m.index) });
    out.push({ text: firstName(a), title: `${a.persona}, ${a.name}` });
    if (!m[1]) out.push({ text: ` (${a.name})` });
    last = m.index! + m[0].length;
  }
  out.push({ text: text.slice(last) });
  return out.filter((x) => x.text);
}
