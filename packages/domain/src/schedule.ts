import type { ScheduleSnapshot, ScheduledTask, TaskState, TaskView } from '@lw/contracts';
import type { ProjectState } from './projector';
import {
  addWorkingHours,
  clockTime,
  localDate,
  localParts,
  longDay,
  nextWorkingMoment,
  sameDayAt,
  shortDay,
  workingDays,
  workingHoursBetween,
} from './time';

/**
 * The forecast behind the Plan surface. Finished tasks sit at their actual times; running tasks
 * keep their start and run to their planned or estimated end; everything else is placed after its
 * dependencies, one task at a time per agent, in working hours. A Lead's planned window is kept
 * whenever it still fits.
 */

const DEFAULT_HOURS = 1;
const PLACEHOLDER_HOURS = 8;
const MIN_REMAINING_MS = 15 * 60_000;
const SETTLED: ReadonlySet<TaskState> = new Set(['done', 'cancelled', 'rolled_back']);
const STARTED: ReadonlySet<TaskState> = new Set(['running', 'validating', 'rejected', 'paused']);

export interface Window {
  start: number;
  end: number;
  basis: ScheduledTask['basis'];
}

const ms = (iso: string | null) => (iso ? Date.parse(iso) : null);
const hoursOf = (t: TaskView) =>
  t.kind === 'checkpoint'
    ? 0
    : (t.estimateHours ?? (t.kind === 'placeholder' ? PLACEHOLDER_HOURS : DEFAULT_HOURS));

/** Dependencies first; ties keep plan order. Cycles (never valid) fall back to plan order. */
function ordered(tasks: TaskView[]): TaskView[] {
  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  const seen = new Set<string>();
  const out: TaskView[] = [];
  const visit = (t: TaskView, depth: number) => {
    if (seen.has(t.taskId) || depth > tasks.length) return;
    seen.add(t.taskId);
    for (const d of t.dependsOn) {
      const dep = byId.get(d);
      if (dep) visit(dep, depth + 1);
    }
    out.push(t);
  };
  for (const t of tasks) visit(t, 0);
  return out;
}

export function forecast(s: ProjectState, now: number): Map<string, Window> {
  const tz = s.timezone;
  const tasks = Object.values(s.tasks);
  const out = new Map<string, Window>();
  const laneFree = new Map<string, number>();
  const work = (start: number, hours: number) =>
    hours ? addWorkingHours(start, hours, tz) : start;

  // Settled and started tasks first: they fix the lanes everything else queues behind.
  for (const t of tasks) {
    const started = ms(t.startedAt);
    const ended = ms(t.endedAt);
    if (SETTLED.has(t.state)) {
      const end = ended ?? ms(t.plannedEnd) ?? now;
      const start = started ?? ms(t.plannedStart) ?? end - hoursOf(t) * 3_600_000;
      out.set(t.taskId, { start, end, basis: 'actual' });
    } else if (STARTED.has(t.state)) {
      const start = started ?? ms(t.plannedStart) ?? now;
      const planned = ms(t.plannedEnd);
      const end = Math.max(planned ?? work(start, hoursOf(t)), now + MIN_REMAINING_MS);
      out.set(t.taskId, { start, end, basis: planned && planned > now ? 'planned' : 'forecast' });
      laneFree.set(t.agentId, Math.max(laneFree.get(t.agentId) ?? 0, end));
    }
  }

  for (const t of ordered(tasks)) {
    if (out.has(t.taskId)) continue;
    const depsEnd = Math.max(0, ...t.dependsOn.map((d) => out.get(d)?.end ?? 0));
    const pStart = ms(t.plannedStart);
    const pEnd = ms(t.plannedEnd);
    let w: Window;
    // A Lead's window stands while it is still ahead and after its dependencies. Leads may plan
    // one agent's activities in parallel on purpose, so the agent's lane does not move it.
    if (pStart !== null && pEnd !== null && pStart >= Math.max(now, depsEnd) - 60_000) {
      w = { start: pStart, end: pEnd, basis: 'planned' };
    } else {
      const earliest = Math.max(
        now,
        depsEnd,
        t.kind === 'checkpoint' ? 0 : (laneFree.get(t.agentId) ?? 0),
      );
      const start = t.kind === 'checkpoint' ? earliest : nextWorkingMoment(earliest, tz);
      const hours =
        pStart !== null && pEnd !== null
          ? Math.max(0.25, workingHoursBetween(pStart, pEnd, tz))
          : hoursOf(t);
      w = { start, end: work(start, hours), basis: 'forecast' };
    }
    out.set(t.taskId, w);
    if (t.kind !== 'checkpoint')
      laneFree.set(t.agentId, Math.max(laneFree.get(t.agentId) ?? 0, w.end));
  }
  return out;
}

const iso = (t: number) => new Date(t).toISOString();

function rollup(states: TaskState[]): TaskState {
  if (states.every((x) => x === 'done' || x === 'cancelled')) return 'done';
  if (states.some((x) => x === 'blocked')) return 'blocked';
  if (states.some((x) => x === 'running' || x === 'validating' || x === 'rejected'))
    return 'running';
  if (states.some((x) => x === 'waiting')) return 'waiting';
  if (states.some((x) => x === 'done')) return 'running';
  return states.some((x) => x === 'ready') ? 'ready' : 'planned';
}

export function scheduleSnapshot(s: ProjectState, now: number): ScheduleSnapshot {
  const tz = s.timezone;
  const windows = forecast(s, now);
  const tasks = Object.values(s.tasks).filter((t) => t.state !== 'cancelled');

  const scheduled: ScheduledTask[] = tasks.map((t) => {
    const w = windows.get(t.taskId)!;
    return {
      taskId: t.taskId,
      title: t.title,
      agentId: t.agentId,
      workstream: t.workstream,
      phase: t.phase,
      state: t.state,
      dependsOn: t.dependsOn,
      start: iso(w.start),
      end: iso(w.end),
      basis: w.basis,
    };
  });

  const phases = Object.values(s.phases)
    .sort((a, b) => a.number - b.number)
    .map((p) => {
      const mine = tasks.filter((t) => t.phase === p.number && t.kind !== 'checkpoint');
      const groups = new Map<string, TaskView[]>();
      for (const t of mine) {
        const key = t.groupTitle ?? t.title;
        groups.set(key, [...(groups.get(key) ?? []), t]);
      }
      const activities = [...groups.entries()].map(([title, ts]) => {
        const ws = ts.map((t) => windows.get(t.taskId)!);
        return {
          key: `${p.number}:${title}`,
          title,
          agentId: ts[0]!.agentId,
          start: iso(Math.min(...ws.map((w) => w.start))),
          end: iso(Math.max(...ws.map((w) => w.end))),
          state: rollup(ts.map((t) => t.state)),
          taskIds: ts.map((t) => t.taskId),
        };
      });
      activities.sort((a, b) => a.start.localeCompare(b.start));
      const start = activities.length ? activities.map((a) => a.start).sort()[0]! : null;
      const end = activities.length
        ? activities
            .map((a) => a.end)
            .sort()
            .at(-1)!
        : null;
      const approvedAt = s.gateApprovals[p.number] ?? null;
      return {
        phase: p.number,
        name: p.shortName ?? p.name,
        state: (p.status === 'done' ? 'done' : p.status === 'current' ? 'running' : 'planned') as
          'done' | 'running' | 'planned',
        start,
        end,
        gateAt: p.gate === 'director' ? (approvedAt ?? end) : null,
        gateLabel: p.gate === 'director' ? (p.gateLabel ?? `Gate: ${p.shortName ?? p.name}`) : null,
        activities,
      };
    });

  const ends = [...windows.values()].map((w) => w.end);
  const starts = [...windows.values()].map((w) => w.start);
  const finishAt = ends.length ? Math.max(...ends) : null;
  const first = Math.min(ms(s.startedAt) ?? ms(s.createdAt) ?? now, ...starts);
  const days = workingDays(first, Math.max(finishAt ?? now, now), tz).map((t, i) => {
    const p = localParts(t, tz);
    return {
      date: localDate(t, tz),
      label: shortDay(t, tz),
      weekStart: i > 0 && p.weekday === 1,
      today: localDate(t, tz) === localDate(now, tz),
    };
  });

  return {
    seq: s.seq,
    timezone: tz,
    now: iso(now),
    today: {
      date: localDate(now, tz),
      label: longDay(now, tz),
      from: iso(sameDayAt(now, 8, tz)),
      to: iso(sameDayAt(now, 20, tz)),
    },
    tasks: scheduled,
    days,
    phases,
    finishAt: finishAt ? iso(finishAt) : null,
  };
}

const UPCOMING: ReadonlySet<TaskState> = new Set(['planned', 'ready', 'waiting', 'blocked']);

/** What an agent picks up next, and when, in the words the Team cards use. */
export function nextForAgents(
  s: ProjectState,
  now: number,
): Map<string, { title: string; when: string; taskId: string | null }> {
  const tz = s.timezone;
  const windows = forecast(s, now);
  const current = Object.values(s.phases)
    .filter((p) => p.status === 'current')
    .map((p) => p.number);
  const out = new Map<string, { title: string; when: string; taskId: string | null }>();
  const upcoming = Object.values(s.tasks)
    .filter((t) => UPCOMING.has(t.state) && t.kind !== 'checkpoint')
    .sort((a, b) => windows.get(a.taskId)!.start - windows.get(b.taskId)!.start);
  for (const t of upcoming) {
    if (out.has(t.agentId)) continue;
    const start = windows.get(t.taskId)!.start;
    const when =
      localDate(start, tz) === localDate(now, tz)
        ? `${clockTime(start, tz)} today`
        : current.includes(t.phase)
          ? `${shortDay(start, tz)}, ${clockTime(start, tz)}`
          : `Phase ${t.phase}, ${shortDay(start, tz)}`;
    out.set(t.agentId, { title: t.title, when, taskId: t.taskId });
  }
  // Leads without work of their own review what their team hands in next.
  for (const lead of Object.values(s.agents).filter((a) => a.tier === 'lead')) {
    if (out.has(lead.agentId)) continue;
    const reports = new Set(
      Object.values(s.agents)
        .filter((a) => a.reportsTo === lead.agentId)
        .map((a) => a.agentId),
    );
    const handIn = Object.values(s.tasks)
      .filter((t) => reports.has(t.agentId) && (UPCOMING.has(t.state) || t.state === 'running'))
      .filter((t) => t.kind === 'work')
      .map((t) => ({ t, end: windows.get(t.taskId)!.end }))
      .sort((a, b) => a.end - b.end)[0];
    if (!handIn) continue;
    const end = handIn.end;
    out.set(lead.agentId, {
      title: `Review ${handIn.t.title}`,
      when:
        localDate(end, tz) === localDate(now, tz)
          ? `${clockTime(end, tz)} today`
          : `${shortDay(end, tz)}, ${clockTime(end, tz)}`,
      taskId: handIn.t.taskId,
    });
  }
  return out;
}

/** The next activities across the team, soonest first ("What is next?"). */
export function upNext(s: ProjectState, now: number, limit = 5) {
  const windows = forecast(s, now);
  return Object.values(s.tasks)
    .filter((t) => UPCOMING.has(t.state) && t.kind !== 'checkpoint')
    .map((t) => ({ t, start: windows.get(t.taskId)!.start }))
    .sort((a, b) => a.start - b.start)
    .slice(0, limit)
    .map(({ t, start }) => ({
      taskId: t.taskId,
      title: t.title,
      agentId: t.agentId,
      start: iso(start),
      state: t.state,
    }));
}
