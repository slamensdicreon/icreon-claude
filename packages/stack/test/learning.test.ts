import type { LwEvent } from '@lw/contracts';
import type { ProjectState } from '@lw/domain';
import {
  MemoryKnowledgeStore,
  MemoryRuleStore,
  type EventStore,
  type Projections,
} from '@lw/events';
import { expect, it } from 'vitest';
import { learnAsCardsSettle } from '../src/learning';

it('learns every few settled cards on live projects, one project at a time', async () => {
  let listener: ((e: LwEvent) => void) | null = null;
  const live = {
    projectId: 'p1',
    mode: 'live',
    intake: { platform: 'sitecoreai' },
    phases: { 5: { status: 'done' }, 6: { status: 'current' } },
    escalations: {},
    tasks: {},
    ledger: {},
    knowledgeUse: {},
    decisions: [],
    conversation: [],
    facts: {},
    capabilityGaps: {},
  } as unknown as ProjectState;
  const demo = { ...live, projectId: 'p2', mode: 'demo' } as ProjectState;
  const logs: string[] = [];
  const stop = learnAsCardsSettle(
    {
      projections: {
        get: (id: string) => (id === 'p1' ? live : id === 'p2' ? demo : undefined),
        catchUp: async () => {},
      } as unknown as Projections,
      store: {
        subscribe: (cb: (e: LwEvent) => void) => {
          listener = cb;
          return () => (listener = null);
        },
        read: async () => [],
      } as unknown as EventStore,
      knowledge: new MemoryKnowledgeStore(),
      rules: new MemoryRuleStore(),
      playbookOf: () => {
        throw new Error('no retrospective needed: the phase cost nothing');
      },
      retrospect: async () => {
        throw new Error('not called');
      },
      every: 3,
    },
    (m, err) => logs.push(err ? `${m}: ${(err as Error).message}` : m),
  );
  const settle = (projectId: string, status = 'resolved') =>
    listener!({
      type: 'escalation.updated',
      projectId,
      data: { status },
    } as unknown as LwEvent);
  settle('p1');
  settle('p1', 'open');
  settle('p2');
  settle('p2');
  settle('p2');
  settle('p1');
  expect(logs).toEqual([]);
  settle('p1');
  await new Promise((r) => setTimeout(r, 20));
  expect(logs).toEqual([
    'Learning on p1: 0 rule(s) and 0 lesson(s) proposed after 3 settled cards',
  ]);
  stop();
  expect(listener).toBeNull();
});
