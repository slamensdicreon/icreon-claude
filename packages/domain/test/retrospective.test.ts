import { EventBody, type LwEvent } from '@lw/contracts';
import { expect, it } from 'vitest';
import { applyEvent, createProjectState, knowledgeEffects, retroEvidence } from '../src';

function build() {
  const s = createProjectState('p1');
  const log: LwEvent[] = [];
  let seq = 0;
  const ev = (type: string, data: Record<string, unknown>) => {
    const e = {
      ...EventBody.parse({ type, data } as never),
      id: `e${++seq}`,
      projectId: 'p1',
      seq,
      ts: new Date(Date.UTC(2026, 9, 1, 12, seq)).toISOString(),
      actor: { kind: 'system', id: 'sys' },
      subject: { kind: 'project', id: 'p1' },
      severity: 'routine',
    } as LwEvent;
    applyEvent(s, e);
    log.push(e);
  };
  return { s, log, ev };
}

const planned = (taskId: string, phase: number, role = 'rendering-registrar') => ({
  taskId,
  phase,
  workstream: null,
  role,
  title: `Register ${taskId}`,
  kind: 'work',
  group: 'register-rendering',
  dependsOn: [],
});

it("gathers what a phase cost and the tasks that took several tries, and leaves other phases' out", () => {
  const { s, log, ev } = build();
  ev('task.planned', planned('hero', 4));
  ev('task.planned', planned('cards', 4));
  ev('task.planned', planned('home', 5, 'content-migrator'));
  const run = (taskId: string, from: string) =>
    ev('task.state', { taskId, from, to: 'running', attempt: 1 });
  run('hero', 'ready');
  ev('step.recorded', {
    stepId: 's1',
    agentId: 'rendering-registrar',
    taskId: 'hero',
    toolServer: 'sitecore-authoring',
    operation: 'rendering.create',
    resultCode: 200,
    durationMs: 1,
    tokens: 0,
    summary: 'Created Hero',
  });
  ev('task.state', { taskId: 'hero', from: 'running', to: 'validating', attempt: 1 });
  ev('step.recorded', {
    stepId: 's2',
    agentId: 'engineering-lead',
    taskId: 'hero',
    toolServer: 'validators',
    operation: 'structural.renderings',
    resultCode: 422,
    durationMs: 0,
    tokens: 0,
    summary: 'Hero has no datasource template',
  });
  ev('review.recorded', {
    reviewerId: 'engineering-lead',
    agentId: 'rendering-registrar',
    taskId: 'hero',
    verdict: 'reject',
    subject: 'Register hero',
    note: 'No datasource template.',
    grounds: 'failed-check',
  });
  ev('task.state', { taskId: 'hero', from: 'validating', to: 'rejected', attempt: 1 });
  ev('task.state', { taskId: 'hero', from: 'rejected', to: 'running', attempt: 2 });
  ev('step.recorded', {
    stepId: 's3',
    agentId: 'rendering-registrar',
    taskId: 'hero',
    toolServer: 'sitecore-authoring',
    operation: 'item.update',
    resultCode: 200,
    durationMs: 1,
    tokens: 0,
    summary: 'Set Datasource Template on Hero',
  });
  ev('task.state', { taskId: 'hero', from: 'running', to: 'validating', attempt: 2 });
  ev('task.state', { taskId: 'hero', from: 'validating', to: 'done', attempt: 2 });
  run('cards', 'ready');
  ev('task.state', {
    taskId: 'cards',
    from: 'running',
    to: 'waiting',
    attempt: 1,
    reason: 'Waits on hero for the shared Available Renderings list',
  });
  run('home', 'ready');
  ev('task.state', { taskId: 'home', from: 'running', to: 'waiting', attempt: 1, reason: 'x' });

  const r = retroEvidence(s, log, 4);
  expect(r).toMatchObject({ phase: 4, tasks: 2 });
  expect(r.items.map((i) => i.kind).sort()).toEqual(['failed-check', 'rejection', 'wait']);
  expect(r.items.find((i) => i.kind === 'wait')).toMatchObject({
    taskId: 'cards',
    detail: 'Waits on hero for the shared Available Renderings list',
  });
  // The attempt that worked, not the one that was rejected.
  expect(r.procedures).toEqual([
    expect.objectContaining({
      ref: 'task:hero',
      rejections: 1,
      steps: ['sitecore-authoring.item.update: Set Datasource Template on Hero'],
    }),
  ]);
});

it("counts how tasks that carried an entry went, and flags one that isn't helping", () => {
  const { s, ev } = build();
  for (const t of ['a', 'b', 'c', 'd']) ev('task.planned', planned(t, 5));
  for (const t of ['a', 'b', 'c', 'd'])
    ev('knowledge.used', { taskId: t, entries: ['k1', 'k2'], refs: ['K-1', 'K-2'] });
  ev('knowledge.used', { taskId: 'a', entries: ['k1'], refs: ['K-1'] });
  for (const t of ['a', 'b', 'c'])
    ev('review.recorded', {
      reviewerId: 'lead',
      agentId: 'x',
      taskId: t,
      verdict: 'reject',
      subject: t,
    });
  const fx = knowledgeEffects([s]);
  expect(fx).toEqual([
    { id: 'k1', tasks: 4, failed: 3, flagged: true },
    { id: 'k2', tasks: 4, failed: 3, flagged: true },
  ]);
});
