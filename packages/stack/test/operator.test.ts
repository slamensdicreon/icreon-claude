import type { NewEvent } from '@lw/contracts';
import type { ProjectState } from '@lw/domain';
import type { EventStore, Projections } from '@lw/events';
import { expect, it } from 'vitest';
import { noticeFor, operatorSweep, webhookNotifier, type OperatorNotice } from '../src/operator';

const at = (iso: string) => new Date(iso);

/** Just what the operator reads of a project. */
function project(over: Partial<ProjectState> = {}): ProjectState {
  return {
    projectId: 'p1',
    name: 'Ervin Cable',
    mode: 'live',
    status: 'running',
    startedAt: '2026-11-04T10:00:00.000Z',
    tasks: {
      'migrate-pages-about': { taskId: 'migrate-pages-about', state: 'waiting' },
      'audit-parity': { taskId: 'audit-parity', state: 'planned' },
      'port-hero': { taskId: 'port-hero', state: 'done' },
    },
    escalations: {},
    conversation: [],
    latest: [{ ts: '2026-11-04T11:00:00.000Z' }],
    ...over,
  } as unknown as ProjectState;
}

const card = (id: string, raisedAt: string, title = `Card ${id}`) => ({
  escalationId: id,
  status: 'open',
  type: 'decision',
  title,
  raisedAt,
});

it('tells the Director once about a card no Lead settled, after a grace period', () => {
  const s = project({
    escalations: {
      a: card(
        'a',
        '2026-11-04T11:00:00.000Z',
        'Migrate About: how should the team section render?',
      ),
    },
  } as never);
  // Raised five minutes ago: the Lead still has time.
  expect(noticeFor(s, at('2026-11-04T11:05:00.000Z'))).toBeNull();
  const n = noticeFor(s, at('2026-11-04T11:12:00.000Z'))!;
  expect(n).toMatchObject({ kind: 'attention', title: 'A decision waits on you' });
  expect(n.body).toContain('Migrate About: how should the team section render?');
  expect(n.needs).toEqual([
    {
      escalationId: 'a',
      type: 'decision',
      title: 'Migrate About: how should the team section render?',
    },
  ]);
  // Told already: not again.
  s.conversation.push({
    label: 'Operator',
    needs: n.needs,
    ts: '2026-11-04T11:12:00.000Z',
  } as never);
  expect(noticeFor(s, at('2026-11-04T12:00:00.000Z'))).toBeNull();
});

it('flags a stall once: work left, nothing waiting on the Director, nothing happening', () => {
  const s = project();
  expect(noticeFor(s, at('2026-11-04T11:20:00.000Z'))).toBeNull();
  const n = noticeFor(s, at('2026-11-04T11:45:00.000Z'))!;
  expect(n).toMatchObject({ kind: 'stalled', title: 'Nothing has moved' });
  expect(n.body).toContain(
    '45 minutes, with 2 tasks left (1 waiting on other tasks, 1 not started)',
  );
  expect(n.body).toContain('open Diagnostics');
  s.conversation.push({ label: 'Operator', needs: [], ts: '2026-11-04T11:45:00.000Z' } as never);
  expect(noticeFor(s, at('2026-11-04T12:30:00.000Z'))).toBeNull();
  // Something happened, then it stalled again: a new notice.
  s.latest = [{ ts: '2026-11-04T12:40:00.000Z' }] as never;
  expect(noticeFor(s, at('2026-11-04T13:20:00.000Z'))?.kind).toBe('stalled');
});

it('stays quiet when the project waits on the Director, is paused, or has nothing left', () => {
  const waiting = project({
    escalations: { a: card('a', '2026-11-04T09:00:00.000Z') },
    conversation: [
      { label: 'Operator', needs: [{ escalationId: 'a' }], ts: '2026-11-04T09:10:00.000Z' },
    ],
  } as never);
  expect(noticeFor(waiting, at('2026-11-04T13:00:00.000Z'))).toBeNull();
  const finished = project({
    tasks: { 'port-hero': { taskId: 'port-hero', state: 'done' } },
  } as never);
  expect(noticeFor(finished, at('2026-11-04T13:00:00.000Z'))).toBeNull();
});

it('posts each notice to the project and the webhook, for live running projects only', async () => {
  const live = project({ escalations: { a: card('a', '2026-11-04T11:00:00.000Z') } } as never);
  const paused = project({ projectId: 'p2', status: 'paused' } as never);
  const demo = project({ projectId: 'p3', mode: 'demo' } as never);
  const appended: { projectId: string; events: NewEvent[] }[] = [];
  const sent: OperatorNotice[] = [];
  const notices = await operatorSweep({
    projections: {
      catchUpAll: async () => {},
      all: () => [live, paused, demo],
    } as unknown as Projections,
    store: {
      append: async (projectId: string, events: NewEvent[]) =>
        void appended.push({ projectId, events }),
    } as unknown as EventStore,
    notify: async (n) => void sent.push(n),
    now: () => at('2026-11-04T11:30:00.000Z'),
  });
  expect(notices.map((n) => n.projectId)).toEqual(['p1']);
  expect(sent).toHaveLength(1);
  expect(appended[0]!.events[0]).toMatchObject({
    type: 'cos.message',
    data: { label: 'Operator', needs: [{ escalationId: 'a' }] },
  });

  const posts: { url: string; body: string }[] = [];
  await webhookNotifier('https://hooks.example/x', (async (url: string, init: RequestInit) => {
    posts.push({ url, body: String(init.body) });
    return new Response('ok');
  }) as typeof fetch)(notices[0]!);
  expect(JSON.parse(posts[0]!.body).text).toMatch(
    /^\*A decision waits on you\*: Ervin Cable: Card a/,
  );
});
