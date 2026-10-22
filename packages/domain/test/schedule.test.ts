import { EventBody, type LwEvent } from '@lw/contracts';
import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  clockTime,
  createProjectState,
  longDay,
  nextForAgents,
  scheduleSnapshot,
  zonedTime,
} from '../src';

const TZ = 'America/New_York';
const at = (day: number, hours: number) => zonedTime(2026, 10, day, hours, TZ);

/** Folds events into a project the way the store would number and stamp them. */
function project(events: { at: number; type: string; data: unknown }[]) {
  const s = createProjectState('p1');
  events.forEach(({ at: t, ...e }, i) =>
    applyEvent(s, {
      ...e,
      ...EventBody.parse({ type: e.type, data: e.data } as never),
      id: `e${i}`,
      projectId: 'p1',
      seq: i + 1,
      ts: new Date(t).toISOString(),
    } as unknown as LwEvent),
  );
  return s;
}

const sys = { actor: { kind: 'system', id: 'sys' }, severity: 'routine' } as const;
const created = {
  ...sys,
  type: 'project.created',
  subject: { kind: 'project', id: 'p1' },
  data: {
    name: 'Ansell',
    client: 'Ansell',
    playbook: { id: 'x', version: '1.0.0' },
    budgets: { tokens: 1, usd: 1, hours: 1 },
    phases: [{ number: 4, name: 'Components', gate: 'none', exitCriteria: '' }],
    roster: ['component-engineer', 'rendering-registrar'].map((r) => ({
      agentId: r,
      role: r,
      name: r,
      tier: 'specialist',
      reportsTo: null,
      workstream: 'engineering',
      activePhases: [4],
      model: 'claude-sonnet-5-5',
    })),
    timezone: TZ,
  },
} as const;
const task = (taskId: string, role: string, dependsOn: string[] = [], estimateHours = 2) => ({
  ...sys,
  type: 'task.planned' as const,
  subject: { kind: 'task' as const, id: taskId },
  data: {
    taskId,
    phase: 4,
    workstream: 'engineering' as const,
    role,
    title: taskId,
    dependsOn,
    estimateHours,
  },
});
const move = (taskId: string, from: string, to: string) => ({
  ...sys,
  type: 'task.state' as const,
  subject: { kind: 'task' as const, id: taskId },
  data: { taskId, from, to, attempt: 1 } as never,
});

describe('forecast', () => {
  const s = project([
    { ...created, at: at(19, 9) },
    { ...task('port-a', 'component-engineer'), at: at(19, 9) },
    { ...task('port-b', 'component-engineer', ['port-a'], 3), at: at(19, 9) },
    { ...task('register-a', 'rendering-registrar', ['port-a']), at: at(19, 9) },
    { ...task('register-b', 'rendering-registrar', ['port-b'], 5), at: at(19, 9) },
    { ...move('port-a', 'planned', 'ready'), at: at(22, 9) },
    { ...move('port-a', 'ready', 'running'), at: at(22, 9) },
    { ...move('port-a', 'running', 'validating'), at: at(22, 11) },
    { ...move('port-a', 'validating', 'done'), at: at(22, 11) },
    { ...move('port-b', 'planned', 'ready'), at: at(22, 11) },
    { ...move('port-b', 'ready', 'running'), at: at(22, 11) },
  ]);
  const now = at(22, 14 + 2 / 60);
  const snap = scheduleSnapshot(s, now);
  const w = (id: string) => {
    const t = snap.tasks.find((x) => x.taskId === id)!;
    return `${longDay(Date.parse(t.start), TZ)} ${clockTime(Date.parse(t.start), TZ)}–${clockTime(Date.parse(t.end), TZ)} ${t.basis}`;
  };

  it('places done tasks at their actual times and running ones from their start', () => {
    expect(w('port-a')).toBe('Thursday, October 22 9:00 AM–11:00 AM actual');
    expect(w('port-b')).toBe('Thursday, October 22 11:00 AM–2:17 PM forecast');
  });

  it('queues the rest after dependencies and the agent’s own work, in working hours', () => {
    // register-a could start at 11 AM (port-a done) but the forecast never schedules in the past.
    expect(w('register-a')).toBe('Thursday, October 22 2:02 PM–4:02 PM forecast');
    // register-b waits for port-b (ends 2:17 PM): 5 working hours runs into Friday morning.
    const rb = snap.tasks.find((x) => x.taskId === 'register-b')!;
    expect(longDay(Date.parse(rb.end), TZ)).toBe('Friday, October 23');
  });

  it('rolls tasks up into phases, days and each agent’s next task', () => {
    expect(snap.today.label).toBe('Thursday, October 22');
    expect(snap.days.map((d) => d.label)).toEqual([
      'Mon 19',
      'Tue 20',
      'Wed 21',
      'Thu 22',
      'Fri 23',
    ]);
    expect(snap.days.find((d) => d.today)!.label).toBe('Thu 22');
    expect(snap.phases[0]!.activities.map((a) => a.state)).toEqual([
      'done',
      'running',
      'planned',
      'planned',
    ]);
    expect(nextForAgents(s, now).get('rendering-registrar')).toMatchObject({
      title: 'register-a',
      when: '2:02 PM today',
    });
  });
});
