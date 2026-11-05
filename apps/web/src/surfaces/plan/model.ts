/*
 * Plan's model: what each task state is called and how it looks, the time axes the timelines
 * share, and the small derivations the views need. No geometry in pixels lives here: the views
 * place things in percentages of their track, and the CSS module owns every length.
 */
import type {
  AgentView,
  Face,
  ScheduleActivity,
  ScheduleSnapshot,
  TaskState,
  Workstream,
} from '@lw/contracts';
import type { CSSProperties } from 'react';
import { fmt, initials } from '../../lib/fmt';

/** How a state is drawn; each look also carries a glyph, so a state never rests on color alone. */
export type Look = 'done' | 'running' | 'ready' | 'planned' | 'waiting' | 'blocked';

export const STATE: Record<TaskState, { word: string; look: Look }> = {
  planned: { word: 'Planned', look: 'planned' },
  ready: { word: 'Ready', look: 'ready' },
  running: { word: 'Running', look: 'running' },
  validating: { word: 'Checking', look: 'running' },
  done: { word: 'Done', look: 'done' },
  rejected: { word: 'Sent back', look: 'waiting' },
  blocked: { word: 'Blocked', look: 'blocked' },
  paused: { word: 'Paused', look: 'waiting' },
  cancelled: { word: 'Cancelled', look: 'planned' },
  rolled_back: { word: 'Rolled back', look: 'planned' },
  waiting: { word: 'Waiting', look: 'waiting' },
};
export const stateOf = (s: TaskState) => STATE[s] ?? { word: s, look: 'planned' as const };

/** The legend: one entry per look, in the order a task moves through them. */
export const LOOKS: { look: Look; word: string }[] = [
  { look: 'planned', word: 'Planned' },
  { look: 'ready', word: 'Ready' },
  { look: 'running', word: 'Running' },
  { look: 'waiting', word: 'Waiting' },
  { look: 'blocked', word: 'Blocked' },
  { look: 'done', word: 'Done' },
];

export const LANES: [Workstream, string][] = [
  ['engineering', 'Engineering'],
  ['quality', 'Quality'],
  ['discovery', 'Discovery'],
  ['content', 'Content'],
];

export type PlanView = 'today' | 'engagement' | 'list';
export const VIEWS: { value: PlanView; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'engagement', label: 'Engagement' },
  { value: 'list', label: 'Activity list' },
];

/**
 * The working day the scheduler plans in (packages/domain/src/time.ts): the Engagement view's
 * day columns run from its start to its end.
 */
export const WORKDAY = { start: 8, end: 18 } as const;
export const WORK_HOURS = WORKDAY.end - WORKDAY.start;

const HOUR_MS = 3_600_000;

/** Hours since local midnight in the project's zone (9:30 AM is 9.5). */
export function hourOf(t: string | number, tz: string): number {
  const parts = fmt(tz, { hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(
    new Date(t),
  );
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h + m / 60;
}

/** "8 AM" in the project's zone. */
export const hourLabel = (t: number, tz: string) => fmt(tz, { hour: 'numeric' }).format(t);

/** Position on a track as CSS custom properties: left (and width) in percent of the track. */
export const at = (x: number, w?: number, extra?: Record<string, string | number>) =>
  ({ '--x': x, ...(w === undefined ? {} : { '--w': w }), ...extra }) as CSSProperties;

/** Custom properties for the CSS module to read (zoom, grid cells, a hue). */
export const vars = (v: Record<string, string | number>) => v as CSSProperties;

/** A hue for a mark, as a custom property its CSS reads. */
export const hueVar = (hue: string) => vars({ '--hue': hue });

export const clampPct = (n: number) => Math.max(0, Math.min(100, n));

/** The Today axis: the snapshot's own span (8 AM to 8 PM local), as percentages of the track. */
export function todayAxis(s: ScheduleSnapshot) {
  const from = Date.parse(s.today.from);
  const to = Date.parse(s.today.to);
  const span = Math.max(1, to - from);
  return {
    from,
    to,
    hours: span / HOUR_MS,
    x: (t: string | number) =>
      clampPct(((Number(typeof t === 'string' ? Date.parse(t) : t) - from) / span) * 100),
    /** Tick marks every `step` hours, as times. */
    ticks: (step: number) =>
      Array.from(
        { length: Math.floor(span / (step * HOUR_MS)) + 1 },
        (_, i) => from + i * step * HOUR_MS,
      ),
  };
}

/** The Engagement axis: the day's index plus its fraction of the working day, over all days. */
export function engagementAxis(s: ScheduleSnapshot) {
  const tz = s.timezone;
  const index = new Map(s.days.map((d, i) => [d.date, i]));
  const n = s.days.length || 1;
  const first = s.days[0]?.date ?? '';
  return {
    days: n,
    x: (t: string | number) => {
      const date = fmt(tz, {}, 'en-CA').format(new Date(t));
      const i = index.get(date) ?? (date < first ? 0 : n - 1);
      const h = Math.max(WORKDAY.start, Math.min(WORKDAY.end, hourOf(t, tz)));
      return clampPct(((i + (h - WORKDAY.start) / WORK_HOURS) / n) * 100);
    },
    /** Hour marks inside each day, every `step` hours, as percentages and the hour they mark. */
    hourTicks: (step: number) =>
      step
        ? s.days.flatMap((d, i) =>
            Array.from({ length: WORK_HOURS / step - 1 }, (_, k) => {
              const h = WORKDAY.start + (k + 1) * step;
              return {
                key: `${d.date}-${h}`,
                h,
                x: ((i + (h - WORKDAY.start) / WORK_HOURS) / n) * 100,
              };
            }),
          )
        : [],
    cellsPerDay: (step: number) => (step ? WORK_HOURS / step : 1),
  };
}

/** "10a", "2p": an hour mark inside a day. */
export const shortHour = (h: number) => `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`;

export const byStart = <T extends { start: string }>(list: readonly T[]) =>
  list.toSorted((a, b) => a.start.localeCompare(b.start));

export const phaseState = (a: ScheduleActivity[]) =>
  a.every((x) => x.state === 'done')
    ? 'done'
    : a.some((x) => ['running', 'waiting', 'blocked'].includes(x.state))
      ? 'running'
      : 'planned';

export const PHASE_WORD = { done: 'Done', running: 'Under way', planned: 'Planned' } as const;

/** A person's face, in their team's hue. */
export function faceOf(a: AgentView | undefined, id: string, working = false): Face {
  const name = a?.persona ?? a?.name ?? id;
  return {
    agentId: id,
    name,
    firstName: name.split(' ')[0] ?? name,
    initials: a ? initials(a) : name.slice(0, 2).toUpperCase(),
    workstream: a?.workstream ?? null,
    working,
  };
}

/** "Content Writer" or "Chief of Staff": the line under a person's name. */
export const roleOf = (a: AgentView | undefined) =>
  a?.tier === 'chief_of_staff' ? 'Chief of Staff' : (a?.name ?? '');

/** The team that owns most of a phase's activities, for its hue. */
export function ownerOf(
  activities: ScheduleActivity[],
  byId: (id: string) => AgentView | undefined,
): Workstream | null {
  const n = new Map<Workstream, number>();
  for (const a of activities) {
    const w = byId(a.agentId)?.workstream;
    if (w) n.set(w, (n.get(w) ?? 0) + 1);
  }
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
