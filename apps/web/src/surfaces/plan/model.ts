/*
 * Plan's model. The plan is one list of activities, read at two depths: every activity in
 * Everything, and what needs the Director, what is moving and what comes next in Bliss. This file
 * holds what both faces derive from the schedule: what each state is called, which decisions hold
 * which activity, what an activity waits on, how its time reads, and where its window sits on the
 * engagement. No pixel lengths live here: the window bar is placed in percent of its track.
 */
import type {
  AgentView,
  EscalationView,
  Face,
  ScheduleActivity,
  ScheduledTask,
  ScheduleSnapshot,
  TaskState,
  Workstream,
} from '@lw/contracts';
import type { CSSProperties } from 'react';
import { clock, fmt, initials, localDate, shortDay } from '../../lib/fmt';

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

/** An activity with the phase it belongs to. */
export type Activity = ScheduleActivity & { phase: number; phaseName: string };

/** Every activity of the engagement, phase by phase, each phase in start order. */
export function activitiesOf(s: ScheduleSnapshot): Activity[] {
  return s.phases.flatMap((p) =>
    p.activities
      .map((a) => ({ ...a, phase: p.phase, phaseName: p.name }))
      .sort((a, b) => a.start.localeCompare(b.start)),
  );
}

const ENDED: ReadonlySet<TaskState> = new Set(['done', 'cancelled', 'rolled_back']);
export const isOpen = (a: { state: TaskState }) => !ENDED.has(a.state);
export const isMoving = (a: { state: TaskState }) =>
  a.state === 'running' || a.state === 'validating';
export const isHeld = (a: { state: TaskState }) =>
  a.state === 'waiting' || a.state === 'blocked' || a.state === 'paused' || a.state === 'rejected';

/**
 * The open decisions that hold each activity: a card whose task (`sourceTaskId`) is one of the
 * activity's tasks. A card with no task holds no row; it still shows in Needs you.
 */
export function holdsOf(
  activities: Activity[],
  cards: readonly EscalationView[],
): Map<string, EscalationView[]> {
  const byTask = new Map<string, EscalationView[]>();
  for (const c of cards)
    if (c.status === 'open' && c.sourceTaskId)
      byTask.set(c.sourceTaskId, [...(byTask.get(c.sourceTaskId) ?? []), c]);
  const out = new Map<string, EscalationView[]>();
  for (const a of activities) {
    const held = a.taskIds.flatMap((id) => byTask.get(id) ?? []);
    if (held.length) out.set(a.key, held);
  }
  return out;
}

type Tasks = ReadonlyMap<string, ScheduledTask>;

/** The task an activity is on: the one moving or held, else the next one not finished. */
export function currentTask(a: Activity, tasks: Tasks): ScheduledTask | undefined {
  const list = a.taskIds.map((id) => tasks.get(id)).filter((t): t is ScheduledTask => !!t);
  return list.find((t) => isMoving(t) || isHeld(t)) ?? list.find((t) => isOpen(t)) ?? list.at(-1);
}

/** The first unfinished task the activity's next step depends on, from another step. */
export function waitingOn(a: Activity, tasks: Tasks): ScheduledTask | undefined {
  const t = a.taskIds.map((id) => tasks.get(id)).find((x) => x && isOpen(x));
  return t?.dependsOn.map((id) => tasks.get(id)).find((d) => d && isOpen(d));
}

/** Finished tasks out of all, for the progress pips. */
export const progressOf = (a: Activity, tasks: Tasks) => ({
  done: a.taskIds.filter((id) => tasks.get(id)?.state === 'done').length,
  total: a.taskIds.length,
});

/** True when the times shown are the scheduler's estimate rather than recorded or planned. */
export const isForecast = (a: Activity, tasks: Tasks) =>
  a.taskIds.some((id) => {
    const t = tasks.get(id);
    return t && isOpen(t) && t.basis === 'forecast';
  });

/** "today 2:30 PM" or "Mon 23, 9 AM", in the project's zone. */
export function moment(t: string, tz: string, now: number): string {
  const time = clock(t, tz).replace(/:00(?=\s)/, '');
  return localDate(t, tz) === localDate(now, tz) ? `today ${time}` : `${shortDay(t, tz)}, ${time}`;
}

/** How an activity's time reads: "Done Fri 20, 12:45 PM", "Ends ~today 4 PM", "Starts ~Mon 23, 9 AM". */
export function whenOf(a: Activity, tasks: Tasks, tz: string, now: number): string {
  if (!isOpen(a)) return `Done ${moment(a.end, tz, now)}`;
  const about = isForecast(a, tasks) ? '~' : '';
  return Date.parse(a.start) <= now
    ? `Ends ${about}${moment(a.end, tz, now)}`
    : `Starts ${about}${moment(a.start, tz, now)}`;
}

/**
 * The working day the scheduler plans in (packages/domain/src/time.ts): each listed day spans
 * 8 AM to 6 PM on the window bar's track.
 */
const WORKDAY = { start: 8, end: 18 } as const;

/** Hours since local midnight in the project's zone (9:30 AM is 9.5). */
function hourOf(t: string | number, tz: string): number {
  const parts = fmt(tz, { hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(
    new Date(t),
  );
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h + m / 60;
}

/**
 * The engagement's working days as one track, in percent: a time on a day off sits at the end of
 * the working day before it, so a weekend takes no room.
 */
export function windowAxis(s: ScheduleSnapshot) {
  const tz = s.timezone;
  const days = s.days.map((d) => d.date);
  const n = days.length || 1;
  return (t: string | number) => {
    const date = fmt(tz, {}, 'en-CA').format(new Date(t));
    const i = days.findIndex((d) => d >= date);
    let pos: number;
    if (i === -1) pos = n;
    else if (days[i] !== date) pos = i;
    else {
      const h = Math.max(WORKDAY.start, Math.min(WORKDAY.end, hourOf(t, tz)));
      pos = i + (h - WORKDAY.start) / (WORKDAY.end - WORKDAY.start);
    }
    return Math.max(0, Math.min(100, (pos / n) * 100));
  };
}

/** Custom properties for the CSS module to read (a position, a width, a hue). */
export const vars = (v: Record<string, string | number>) => v as CSSProperties;

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
