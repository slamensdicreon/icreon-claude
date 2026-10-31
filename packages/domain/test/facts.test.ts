import { EventBody, type LwEvent } from '@lw/contracts';
import { expect, it } from 'vitest';
import { applyEvent, createProjectState, factChanges, factId, isLogEvent } from '../src';

const fact = (seq: number, data: Record<string, unknown>): LwEvent =>
  ({
    ...EventBody.parse({ type: 'fact.published', data }),
    id: `e${seq}`,
    projectId: 'p1',
    seq,
    ts: new Date(Date.UTC(2026, 9, 1, 12, seq)).toISOString(),
    actor: { kind: 'agent', id: 'rendering-registrar' },
    subject: { kind: 'task', id: 't1' },
    severity: 'routine',
  }) as LwEvent;

it('keeps the latest value of each fact, with the one it replaced', () => {
  const s = createProjectState('p1');
  const base = { kind: 'rendering', key: 'Hero Banner', taskId: 't1', by: 'rendering-registrar' };
  applyEvent(s, fact(1, { ...base, value: { id: 'a' }, summary: 'first' }));
  // The same value again (a create that found the item there) changes nothing but the time.
  applyEvent(s, fact(2, { ...base, key: 'hero  banner', value: { id: 'a' } }));
  expect(s.facts[factId('rendering', 'Hero Banner')]).toMatchObject({ version: 1, previous: null });
  applyEvent(s, fact(3, { ...base, taskId: 't9', value: { id: 'b' }, source: 'agent' }));
  const f = s.facts[factId('rendering', 'HERO BANNER')]!;
  expect(f).toMatchObject({
    value: { id: 'b' },
    version: 2,
    taskId: 't9',
    source: 'agent',
    previous: { value: { id: 'a' }, taskId: 't1' },
  });
  expect(Object.keys(s.facts)).toHaveLength(1);
  // Facts are records, not Activity rows: the tool call that made them already is one.
  expect(isLogEvent(fact(4, { ...base, value: {} }))).toBe(false);
});

it('flags finished tasks that built on a fact before it changed', () => {
  const s = createProjectState('p1');
  let seq = 0;
  const at = (min: number) => new Date(Date.UTC(2026, 9, 1, 12, min)).toISOString();
  const ev = (type: string, data: Record<string, unknown>, min: number) =>
    applyEvent(s, {
      ...EventBody.parse({ type, data } as never),
      id: `e${++seq}`,
      projectId: 'p1',
      seq,
      ts: at(min),
      actor: { kind: 'system', id: 'sys' },
      subject: { kind: 'project', id: 'p1' },
      severity: 'routine',
    } as LwEvent);
  const plan = (taskId: string, dependsOn: string[], itemKeys: string[] = [], kind = 'work') =>
    ev(
      'task.planned',
      {
        taskId,
        phase: 5,
        workstream: null,
        role: 'content-migrator',
        title: `Task ${taskId}`,
        kind,
        group: null,
        dependsOn,
        agentId: 'content-migrator',
        itemKeys,
      },
      0,
    );
  const finish = (taskId: string, min: number) => {
    ev('task.state', { taskId, from: 'ready', to: 'running', attempt: 1 }, min - 1);
    ev('task.state', { taskId, from: 'running', to: 'validating', attempt: 1 }, min);
    ev('task.state', { taskId, from: 'validating', to: 'done', attempt: 1 }, min);
  };
  plan('register-hero', []);
  plan('components-done', ['register-hero'], [], 'checkpoint');
  plan('page-home', ['components-done']);
  plan('page-about', ['components-done']);
  plan('page-early', ['components-done']);
  plan('media-x', []);
  const hero = { kind: 'rendering', key: 'Hero', by: 'rendering-registrar' };
  finish('page-early', 5);
  ev('fact.published', { ...hero, value: { id: 'old' }, taskId: 'register-hero' }, 10);
  finish('page-home', 20);
  finish('media-x', 25);
  ev('fact.published', { ...hero, value: { id: 'new' }, taskId: 'register-hero' }, 30);
  finish('page-about', 40);
  expect(factChanges(s)).toEqual([
    {
      kind: 'rendering',
      key: 'Hero',
      from: { id: 'old' },
      to: { id: 'new' },
      at: at(30),
      by: 'rendering-registrar',
      // Not page-early (before the old value), media-x (unrelated), or page-about (after).
      tasks: [{ taskId: 'page-home', title: 'Task page-home' }],
    },
  ]);
});
