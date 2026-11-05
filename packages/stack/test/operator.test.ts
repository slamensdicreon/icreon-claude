import type { NewEvent } from '@lw/contracts';
import type { ProjectState } from '@lw/domain';
import type { EventStore, Projections } from '@lw/events';
import { expect, it } from 'vitest';
import {
  noticeFor,
  operatorSweep,
  reviewNotice,
  webhookNotifier,
  type OperatorNotice,
} from '../src/operator';

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
    '45 minutes, with two tasks left (one waiting on other tasks, one not started)',
  );
  expect(n.body).toContain('open Diagnostics');
  s.conversation.push({
    label: 'Operator',
    title: 'Nothing has moved',
    needs: [],
    ts: '2026-11-04T11:45:00.000Z',
  } as never);
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

it('says once that proposals wait for review, and again only when there are more', () => {
  const s = project();
  expect(reviewNotice(s, { rules: 0, lessons: 0 })).toBeNull();
  const n = reviewNotice(s, { rules: 2, lessons: 1 })!;
  expect(n).toMatchObject({ kind: 'review', proposals: 3 });
  expect(n.body).toContain('2 rules and 1 lesson drafted from settled cards wait for your review');
  s.conversation.push({
    label: 'Operator',
    title: n.title,
    needs: [],
    rows: [{ label: 'proposals', value: '3' }],
    ts: '2026-11-04T11:00:00.000Z',
  } as never);
  expect(reviewNotice(s, { rules: 2, lessons: 1 })).toBeNull();
  expect(reviewNotice(s, { rules: 3, lessons: 1 })?.proposals).toBe(4);
  // A review notice doesn't count as a stall notice.
  expect(noticeFor(s, at('2026-11-04T11:45:00.000Z'))?.kind).toBe('stalled');
});

it('names why a project stalled: a failing or stopped workflow, a missing capability', async () => {
  const now = at('2026-11-04T11:45:00.000Z');
  const failing = noticeFor(
    project(),
    now,
    {},
    {
      status: 'RUNNING',
      failures: [
        {
          at: '2026-11-04T11:02:00.000Z',
          message: 'Unhandled rejection: external workflow not found',
        },
      ],
    },
  )!;
  expect(failing.body).toContain(
    'Its workflow fails every step it takes, since 11:02 UTC: "Unhandled rejection: external workflow not found". That needs an engineering fix',
  );
  // A failure from before the project last moved isn't why it stopped.
  const old = noticeFor(
    project(),
    now,
    {},
    {
      status: 'RUNNING',
      failures: [{ at: '2026-11-04T10:30:00.000Z', message: 'old' }],
    },
  )!;
  expect(old.body).not.toContain('old');
  expect(old.body).toContain('Its workflow is running and not failing, so a wait may have no task');

  expect(noticeFor(project(), now, {}, { status: 'FAILED', failures: [] })!.body).toContain(
    'Its workflow is no longer running (failed)',
  );

  const gap = noticeFor(
    project({
      capabilityGaps: {
        g: {
          capability: 'view screenshot images',
          firstAt: '2026-11-04T11:00:00.000Z',
          tasks: { 'crawl-site': { agentId: 'a', summary: 's', at: '2026-11-04T11:00:00.000Z' } },
          closedAt: null,
        },
      },
    } as never),
    now,
    {},
    { status: 'RUNNING', failures: [] },
  )!;
  expect(gap.body).toContain(
    "1 task waits on what the team can't do yet: view screenshot images. That needs engineering",
  );

  // The sweep reads the workflow only when a stall is due.
  const read: string[] = [];
  const [n] = await operatorSweep({
    projections: { catchUpAll: async () => {}, all: () => [project()] } as unknown as Projections,
    store: { append: async () => {} } as unknown as EventStore,
    now: () => now,
    health: async (id) => {
      read.push(id);
      return { status: 'RUNNING', failures: [{ at: '2026-11-04T11:10:00.000Z', message: 'boom' }] };
    },
  });
  expect(read).toEqual(['p1']);
  expect(n!.body).toContain('"boom"');
  await operatorSweep({
    projections: { catchUpAll: async () => {}, all: () => [project()] } as unknown as Projections,
    store: { append: async () => {} } as unknown as EventStore,
    now: () => at('2026-11-04T11:05:00.000Z'),
    health: async (id) => {
      read.push(id);
      return null;
    },
  });
  expect(read).toEqual(['p1']);
});
