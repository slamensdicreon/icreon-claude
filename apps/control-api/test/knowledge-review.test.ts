import { InForceSnapshot, ProposalReview, type PlaybookSummary } from '@lw/contracts';
import type { ProposalSortInput } from '@lw/agent-runtime';
import { InMemoryEventStore, MemoryKnowledgeStore, MemoryRuleStore, Projections } from '@lw/events';
import type { FastifyInstance } from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { buildApp } from '../src/app';

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

const demo = {
  id: 'sitecoreai-homepage-demo',
  name: 'SitecoreAI homepage demo',
  version: '0.2.0',
  platform: { id: 'sitecoreai', name: 'SitecoreAI' },
  roles: [
    { role: 'content-analyst', name: 'Content Analyst', tier: 'specialist', description: '' },
    { role: 'rendering-registrar', name: 'Sitecore Modeler', tier: 'specialist', description: '' },
  ],
} as unknown as PlaybookSummary;

async function start(sorter?: (input: ProposalSortInput) => Promise<unknown>) {
  const store = new InMemoryEventStore();
  const projections = new Projections(store);
  await projections.start();
  const knowledge = new MemoryKnowledgeStore();
  const rules = new MemoryRuleStore();
  const lesson = (over: Record<string, unknown>) =>
    knowledge.create({
      kind: 'lesson',
      status: 'active',
      scope: { kind: 'platform', id: 'sitecoreai' },
      title: 'A lesson',
      text: 'Do the thing.',
      author: 'director',
      source: null,
      ...over,
    } as never);
  const k = {
    everyone: await lesson({ title: 'Read before you write' }),
    registrar: await lesson({ title: 'Prove the group write', roles: ['rendering-registrar'] }),
    roleScoped: await lesson({
      title: 'Resolve the ID first',
      scope: { kind: 'role', id: 'content-analyst' },
    }),
    otherPlaybook: await lesson({
      title: 'Website only',
      scope: { kind: 'playbook', id: 'sitecoreai-migration' },
    }),
    otherPlatform: await lesson({
      title: 'Optimizely only',
      scope: { kind: 'platform', id: 'optimizely' },
    }),
    project: await lesson({ title: 'One site only', scope: { kind: 'project', id: 'p1' } }),
    gap: await lesson({ kind: 'gap', title: 'No site.create operation' }),
    proposed: await lesson({ status: 'proposed', title: 'Fix your own inventory' }),
    stale: await lesson({ status: 'proposed', title: 'Held components may fail the checks' }),
  };
  const r = {
    active: await rules.create({
      when: 'a source page 404s',
      then: 'drop it',
      category: 'scope',
      scope: { kind: 'playbook', id: 'sitecoreai-homepage-demo' },
      author: 'director',
      status: 'active',
    }),
    proposed: await rules.create({
      when: 'retries ran out on a billing error',
      then: 'retry once service is back',
      category: 'retry',
      scope: { kind: 'platform', id: 'sitecoreai' },
      author: 'cypher',
      status: 'proposed',
    }),
    elsewhere: await rules.create({
      when: 'x',
      then: 'y',
      category: 'retry',
      scope: { kind: 'project', id: 'p1' },
      author: 'director',
      status: 'active',
    }),
  };
  app = await buildApp({
    store,
    projections,
    commands: () => undefined,
    knowledge,
    rules,
    intake: { playbooks: () => [demo] } as never,
    proposalSorter: (sorter as never) ?? null,
  });
  return { k, r, knowledge, rules };
}

const call = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
  const res = await app!.inject({ method, url, payload: payload as object });
  return { status: res.statusCode, body: res.json() as any };
};

it('says what a new project on a playbook starts with, and what reaches no agent', async () => {
  const { k, r } = await start();
  const res = await call('GET', '/playbooks/sitecoreai-homepage-demo/in-force');
  expect(res.status).toBe(200);
  const snap = InForceSnapshot.parse(res.body);
  expect(Object.fromEntries(snap.entries.map((e) => [e.title, e.roles]))).toEqual({
    'Read before you write': [],
    'Prove the group write': ['rendering-registrar'],
    'Resolve the ID first': ['content-analyst'],
  });
  // Other playbooks' and platforms' entries, one project's, and proposals don't reach it.
  expect(snap.entries.map((e) => e.id)).not.toContain(k.project!.id);
  expect(snap.gaps.map((g) => g.title)).toEqual(['No site.create operation']);
  expect(snap.rules.map((x) => x.id)).toEqual([r.active.id]);
  expect(snap.pending).toEqual({ knowledge: 2, rules: 1 });
  expect((await call('GET', '/playbooks/nope/in-force')).status).toBe(404);
});

it('lists every proposal with Cypher’s recommendation, and applies the decisions in one go', async () => {
  const seen: ProposalSortInput[] = [];
  const { k, r, knowledge, rules } = await start(async (input) => {
    seen.push(input);
    return [
      {
        id: k.proposed!.id,
        action: 'edit',
        reason: 'True for every role that writes documents.',
        duplicateOf: null,
        edit: { scope: { kind: 'global', id: '*' } },
      },
      {
        id: k.stale!.id,
        action: 'reject',
        reason: 'Out of date: there are no held components now.',
        duplicateOf: null,
        edit: null,
      },
      // r.proposed is left out: the review says so rather than guessing.
    ];
  });
  const review = ProposalReview.parse((await call('POST', '/proposals/sort', {})).body);
  expect(review.available).toBe(true);
  expect(seen[0]!.proposals.map((p) => p.id).sort()).toEqual(
    [k.proposed!.id, k.stale!.id, r.proposed.id].sort(),
  );
  // Cypher reads what's in force, to catch repeats.
  expect(seen[0]!.active).toEqual(
    expect.arrayContaining([expect.stringContaining('Read before you write')]),
  );
  const by = Object.fromEntries(review.recommendations.map((x) => [x.id, x]));
  expect(by[k.proposed!.id]).toMatchObject({ action: 'edit', edit: { scope: { kind: 'global' } } });
  expect(by[k.stale!.id]).toMatchObject({ action: 'reject' });
  expect(by[r.proposed.id]).toMatchObject({
    action: 'approve',
    reason: expect.stringContaining('no recommendation'),
  });

  const applied = await call('POST', '/proposals/apply', {
    decisions: [
      {
        kind: 'knowledge',
        id: k.proposed!.id,
        action: 'edit',
        edit: { scope: { kind: 'global', id: '*' } },
      },
      { kind: 'knowledge', id: k.stale!.id, action: 'reject' },
      { kind: 'rule', id: r.proposed.id, action: 'approve' },
      // Already active: not a waiting proposal, so it fails on its own and the rest stand.
      { kind: 'knowledge', id: k.everyone!.id, action: 'reject' },
    ],
  });
  expect(applied.body).toMatchObject({
    approved: 1,
    edited: 1,
    rejected: 1,
    failed: [{ id: k.everyone!.id }],
  });
  expect(await knowledge.get(k.proposed!.id)).toMatchObject({
    status: 'active',
    scope: { kind: 'global' },
  });
  expect(await knowledge.get(k.stale!.id)).toMatchObject({ status: 'retired' });
  expect(await knowledge.get(k.everyone!.id)).toMatchObject({ status: 'active' });
  expect((await rules.list({ status: 'active' })).map((x) => x.id)).toContain(r.proposed.id);
});

it('lists the proposals without recommendations when no model is set up', async () => {
  await start();
  const review = ProposalReview.parse((await call('POST', '/proposals/sort', {})).body);
  expect(review).toMatchObject({ available: false });
  expect(review.recommendations).toHaveLength(3);
});
