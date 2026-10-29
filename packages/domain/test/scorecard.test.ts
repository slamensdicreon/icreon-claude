import { EventBody, Scorecard, type LwEvent } from '@lw/contracts';
import { expect, it } from 'vitest';
import { applyEvent, createProjectState, scorecard } from '../src';

const T0 = Date.parse('2026-10-01T12:00:00Z');
const H = 3_600_000;

/** Folds events into a project the way the store numbers and stamps them. */
function project(events: { at: number; type: string; data: unknown }[]) {
  const s = createProjectState('p1');
  events.forEach(({ at, ...e }, i) =>
    applyEvent(s, {
      ...e,
      ...EventBody.parse({ type: e.type, data: e.data } as never),
      id: `e${i}`,
      projectId: 'p1',
      seq: i + 1,
      ts: new Date(at).toISOString(),
      actor: { kind: 'system', id: 'sys' },
      subject: { kind: 'project', id: 'p1' },
      severity: 'routine',
    } as unknown as LwEvent),
  );
  return s;
}

const created = {
  type: 'project.created',
  data: {
    name: 'Globex',
    client: 'Globex',
    playbook: { id: 'pb', version: '1.0.0' },
    budgets: { tokens: 1, usd: 1, hours: 1 },
    phases: [
      { number: 1, name: 'Discovery', gate: 'none', exitCriteria: '' },
      { number: 4, name: 'Components', gate: 'none', exitCriteria: '' },
    ],
    roster: [],
    timezone: 'UTC',
  },
};
const task = (
  taskId: string,
  phase: number,
  group: string | null = null,
  itemKeys: string[] = [],
) => ({
  type: 'task.planned',
  data: {
    taskId,
    phase,
    workstream: 'engineering',
    role: 'r',
    title: taskId,
    dependsOn: [],
    group,
    itemKeys,
  },
});
const move = (taskId: string, from: string, to: string) => ({
  type: 'task.state',
  data: { taskId, from, to, attempt: 1 },
});
const review = (taskId: string, verdict: 'accept' | 'reject') => ({
  type: 'review.recorded',
  data: { reviewerId: 'lead', agentId: 'a', taskId, verdict, subject: taskId, tokens: 100 },
});
const step = (taskId: string, tokens: number) => ({
  type: 'step.recorded',
  data: {
    stepId: `s-${taskId}-${tokens}`,
    agentId: 'a',
    taskId,
    toolServer: 'x',
    operation: 'y',
    resultCode: 200,
    durationMs: 1,
    tokens,
    summary: '',
  },
});
const card = (
  id: string,
  taskId: string | null,
  title: string,
  type = 'decision',
  recommended = 'a',
) => ({
  type: 'escalation.raised',
  data: {
    escalationId: id,
    type,
    title,
    context: '',
    impact: '',
    options: [
      { id: 'a', label: 'A', recommended: recommended === 'a' },
      { id: 'b', label: 'B', recommended: recommended === 'b' },
    ],
    defaultOptionId: 'a',
    deadline: null,
    sourceTaskId: taskId,
  },
});
const settle = (id: string, by: 'director' | 'default' | 'chief_of_staff', optionId: string) => ({
  type: 'escalation.updated',
  data: { escalationId: id, status: 'resolved', resolution: { optionId, by } },
});
const expire = (id: string) => ({
  type: 'escalation.updated',
  data: { escalationId: id, status: 'expired' },
});

it('counts cards by category and who settled them, reviews, waits, re-runs, repeats and spend', () => {
  const at = (h: number) => T0 + h * H;
  const s = project(
    [
      created,
      { type: 'project.status', data: { status: 'running' } },
      task('inventory', 1),
      task('upload-hero', 4, 'upload-{key}', ['hero']),
      task('upload-logo', 4, 'upload-{key}', ['logo']),
      move('inventory', 'planned', 'ready'),
      move('inventory', 'ready', 'running'),
      step('inventory', 1000),
      review('inventory', 'reject'),
      move('inventory', 'running', 'running'),
      review('inventory', 'accept'),
      move('inventory', 'running', 'done'),
      // Sent back once: it runs again.
      move('inventory', 'done', 'ready'),
      move('inventory', 'ready', 'running'),
      move('inventory', 'running', 'done'),
      move('upload-hero', 'planned', 'running'),
      move('upload-hero', 'running', 'waiting'),
      // Same cause on two sibling tasks: one repeat.
      card('x1', 'upload-hero', 'Source URL for hero.png?'),
      card('x2', 'upload-logo', 'Source URL for logo.png?'),
      settle('x1', 'director', 'a'),
      expire('x2'),
      card('x3', 'inventory', 'Lead rejected 3 times: retry or accept?', 'decision', 'b'),
      settle('x3', 'director', 'a'),
      card('x4', null, 'Approve Blueprint summary v1', 'gate'),
      { type: 'budget.updated', data: { spent: { tokens: 1300, usd: 12.345, hours: 0 } } },
    ].map((e, i) => ({ ...e, at: at(i) })),
  );
  const card_ = Scorecard.parse(scorecard(s, at(30)));
  expect(card_.totals).toMatchObject({
    tasks: 3,
    done: 1,
    cards: 4,
    cardsPerTask: 1.33,
    settledWithoutDirector: 1,
    settledWithoutDirectorPct: 33.3,
    recommendedTakenPct: 66.7,
    reviews: 2,
    rejections: 1,
    rejectionRate: 50,
    repeats: 1,
    waits: 1,
    reruns: 1,
    tokens: 1200,
    usd: 12.35,
  });
  expect(card_.categories).toEqual([
    {
      category: 'media',
      raised: 2,
      open: 0,
      settled: { director: 1, chief_of_staff: 0, default: 1, lead: 0, rule: 0 },
      recommendedTaken: 2,
      withRecommendation: 2,
      shadowAnswered: 0,
      shadowAgreed: 0,
    },
    {
      category: 'retry',
      raised: 1,
      open: 0,
      settled: { director: 1, chief_of_staff: 0, default: 0, lead: 0, rule: 0 },
      recommendedTaken: 0,
      withRecommendation: 1,
      shadowAnswered: 0,
      shadowAgreed: 0,
    },
    {
      category: 'release',
      raised: 1,
      open: 1,
      settled: { director: 0, chief_of_staff: 0, default: 0, lead: 0, rule: 0 },
      recommendedTaken: 0,
      withRecommendation: 0,
      shadowAnswered: 0,
      shadowAgreed: 0,
    },
  ]);
  expect(
    card_.phases.map((p) => [p.phase, p.tasks, p.cards, p.reviews, p.reruns, p.tokens]),
  ).toEqual([
    [1, 1, 1, 2, 1, 1200],
    [4, 2, 2, 0, 0, 0],
  ]);
  expect(card_.repeats).toEqual([
    { category: 'media', title: 'Source URL for hero.png?', count: 2 },
  ]);
});

it('measures how often the Director answered as the Lead would have, in shadow', () => {
  const shadowed = (id: string, leadSays: string) => ({
    ...card(id, 'inventory', `Rename the Hero ${id} variant?`),
    data: {
      ...card(id, 'inventory', `Rename the Hero ${id} variant?`).data,
      triage: { leadId: 'lead', mode: 'shadow', optionId: leadSays, reasoning: 'x', ruleIds: [] },
    },
  });
  const s = project(
    [
      created,
      task('inventory', 1),
      shadowed('y1', 'a'),
      settle('y1', 'director', 'a'),
      shadowed('y2', 'a'),
      settle('y2', 'director', 'b'),
      // Settled by its default: nothing to compare.
      shadowed('y3', 'a'),
      expire('y3'),
    ].map((e, i) => ({ ...e, at: T0 + i * H })),
  );
  const naming = scorecard(s).categories.find((c) => c.category === 'naming')!;
  expect(naming).toMatchObject({ raised: 3, shadowAnswered: 2, shadowAgreed: 1 });
});
