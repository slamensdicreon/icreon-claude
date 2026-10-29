import { RuleHistoryItem, RuleView } from '@lw/contracts';
import { InMemoryEventStore, MemoryRuleStore, Projections } from '@lw/events';
import type { FastifyInstance } from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { buildApp } from '../src/app';

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function start(withRules = true) {
  const store = new InMemoryEventStore();
  const projections = new Projections(store);
  await projections.start();
  app = await buildApp({
    store,
    projections,
    commands: () => undefined,
    rules: withRules ? new MemoryRuleStore() : undefined,
  });
}

const call = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => {
  const r = await app!.inject({ method, url, payload: payload as object });
  return { status: r.statusCode, body: r.json() as any };
};

const media = {
  when: 'the source refuses a media download (403)',
  then: 'skip the file and log it as a gap',
  category: 'media',
  scope: { kind: 'playbook', id: 'sitecoreai-migration' },
  sources: [{ projectId: 'p1', escalationId: 'e1', title: 'Access denied: Upload a.png' }],
};

it('saves, edits, retires and lists rules, with each one’s history', async () => {
  await start();
  const made = await call('POST', '/rules', media);
  expect(made.status).toBe(201);
  const r = RuleView.parse(made.body);
  expect(r).toMatchObject({ ref: 'R-1', status: 'active', author: 'director', version: 1 });
  expect(r.sources[0]).toMatchObject({ escalationId: 'e1', answer: null });

  const proposed = RuleView.parse(
    (await call('POST', '/rules', { ...media, category: 'tool', status: 'proposed' })).body,
  );
  expect((await call('GET', '/rules?status=proposed')).body.map((x: RuleView) => x.id)).toEqual([
    proposed.id,
  ]);
  expect((await call('POST', `/rules/${proposed.id}/activate`)).body.status).toBe('active');

  const edited = RuleView.parse(
    (await call('PUT', `/rules/${r.id}`, { then: 'skip it and log the gap with the page' })).body,
  );
  expect(edited).toMatchObject({ version: 2, then: 'skip it and log the gap with the page' });
  expect((await call('POST', `/rules/${r.id}/retire`)).body.status).toBe('retired');
  const history = RuleHistoryItem.array().parse((await call('GET', `/rules/${r.id}/history`)).body);
  expect(history.map((h) => h.kind)).toEqual(['created', 'edited', 'retired']);
  expect((await call('GET', '/rules')).body).toHaveLength(2);
});

it('refuses a rule without both halves, an unknown rule, and runs without a store', async () => {
  await start();
  expect((await call('POST', '/rules', { ...media, then: '' })).status).toBe(400);
  expect((await call('POST', '/rules', { ...media, category: 'vibes' })).status).toBe(400);
  expect((await call('PUT', '/rules/nope', { then: 'x x x' })).status).toBe(404);
  expect((await call('POST', '/rules/nope/explode')).status).toBe(404);
  await app!.close();
  await start(false);
  const r = await call('GET', '/rules');
  expect(r.status).toBe(501);
  expect(r.body.error.message).toMatch(/database/);
});

it('tells a rule how it did: agreeing on a shadowed card applies it, overriding counts against it', async () => {
  const store = new InMemoryEventStore();
  const projections = new Projections(store);
  await projections.start();
  const rulesStore = new MemoryRuleStore();
  const r = await rulesStore.create({
    when: 'a component has several layouts',
    then: 'one rendering with variants',
    category: 'naming',
    scope: { kind: 'playbook', id: 'pb' },
    author: 'director',
    status: 'active',
  });
  const sys = { actor: { kind: 'system', id: 'sys' }, severity: 'routine' } as const;
  const card = (id: string, mode: 'shadow' | 'decided') =>
    ({
      ...sys,
      type: 'escalation.raised',
      subject: { kind: 'escalation', id },
      data: {
        escalationId: id,
        type: 'decision',
        title: 'Hero: variants or renderings?',
        context: '',
        impact: '',
        options: [
          { id: 'opt-1', label: 'Variants', recommended: true },
          { id: 'opt-2', label: 'Renderings' },
        ],
        defaultOptionId: 'opt-1',
        deadline: null,
        sourceTaskId: 'port-hero',
        triage: {
          leadId: 'engineering-lead',
          mode,
          optionId: 'opt-1',
          reasoning: 'R-1',
          ruleIds: [r.id],
        },
      },
    }) as never;
  await store.append('p1', [
    {
      ...sys,
      type: 'project.created',
      subject: { kind: 'project', id: 'p1' },
      data: {
        name: 'P',
        client: 'C',
        playbook: { id: 'pb', version: '1.0.0' },
        budgets: { tokens: 1, usd: 1, hours: 1 },
        phases: [{ number: 4, name: 'Components', gate: 'none', exitCriteria: '' }],
        roster: [],
        timezone: 'UTC',
      },
    } as never,
    {
      ...sys,
      type: 'project.status',
      subject: { kind: 'project', id: 'p1' },
      data: { status: 'running' },
    } as never,
    card('x1', 'shadow'),
    card('x2', 'shadow'),
    card('x3', 'decided'),
  ]);
  const noop = async () => undefined;
  app = await buildApp({
    store,
    projections,
    commands: () => ({ resolve: noop, rerunTask: noop }) as never,
    rules: rulesStore,
  });
  const post = (url: string, payload: unknown) =>
    app!.inject({ method: 'POST', url, payload: payload as object });
  await post('/projects/p1/escalations/x1/resolve', { optionId: 'opt-1' });
  expect(await rulesStore.get(r.id)).toMatchObject({ applied: 1, overridden: 0 });
  await post('/projects/p1/escalations/x2/resolve', { optionId: 'opt-2' });
  expect(await rulesStore.get(r.id)).toMatchObject({ applied: 1, overridden: 1, flagged: false });
  // Override in the Decision Log: the task runs again with another option.
  const rerun = await post('/projects/p1/tasks/port-hero/rerun', {
    instructions: 'Decision on "Hero": Renderings.',
    overriding: 'x3',
  });
  expect(rerun.statusCode).toBe(200);
  expect(await rulesStore.get(r.id)).toMatchObject({ overridden: 2, flagged: true });
});

it('harvests a project’s answers into proposed rules, one per cause, once', async () => {
  const store = new InMemoryEventStore();
  const projections = new Projections(store);
  await projections.start();
  const rulesStore = new MemoryRuleStore();
  const sys = { actor: { kind: 'system', id: 'sys' }, severity: 'routine' } as const;
  const task = (taskId: string, item: string) =>
    ({
      ...sys,
      type: 'task.planned',
      subject: { kind: 'task', id: taskId },
      data: {
        taskId,
        phase: 6,
        workstream: 'content',
        role: 'media-migrator',
        title: `Upload ${item}`,
        dependsOn: [],
        group: 'upload-{key}',
        itemKeys: [item],
      },
    }) as never;
  const answered = (
    id: string,
    taskId: string,
    item: string,
    type = 'decision',
    optionId = 'skip',
  ) => [
    {
      ...sys,
      type: 'escalation.raised',
      subject: { kind: 'escalation', id },
      data: {
        escalationId: id,
        type,
        title: `Access denied: Upload ${item}`,
        context: 'The source answered 403.',
        impact: '',
        options: [
          { id: 'skip', label: 'Skip it and log the gap', recommended: true },
          { id: 'retry', label: 'Retry later' },
        ],
        defaultOptionId: 'skip',
        deadline: null,
        sourceTaskId: taskId,
      },
    },
    {
      ...sys,
      type: 'escalation.updated',
      subject: { kind: 'escalation', id },
      data: { escalationId: id, status: 'resolved', resolution: { optionId, by: 'director' } },
    },
  ];
  await store.append('p1', [
    {
      ...sys,
      type: 'project.created',
      subject: { kind: 'project', id: 'p1' },
      data: {
        name: 'Ansco',
        client: 'Dycom',
        playbook: { id: 'sitecoreai-migration', version: '0.3.0' },
        budgets: { tokens: 1, usd: 1, hours: 1 },
        phases: [{ number: 6, name: 'Content', gate: 'none', exitCriteria: '' }],
        roster: [],
        timezone: 'UTC',
      },
    } as never,
    task('upload-a', 'a.png'),
    task('upload-b', 'b.png'),
    task('upload-c', 'c.png'),
    ...(answered('x1', 'upload-a', 'a.png') as never[]),
    ...(answered('x2', 'upload-b', 'b.png') as never[]),
    // The same cause answered differently: its own group of one, not proposed.
    ...(answered('x3', 'upload-c', 'c.png', 'decision', 'retry') as never[]),
  ]);
  app = await buildApp({
    store,
    projections,
    commands: () => undefined,
    rules: rulesStore,
    ruleDrafter: async (input) => ({
      when: 'the source site refuses a media download',
      then: input.answer.toLowerCase(),
    }),
  });
  const harvest = async () =>
    (await app!.inject({ method: 'POST', url: '/projects/p1/rules/harvest' })).json() as {
      proposed: RuleView[];
    };
  const first = await harvest();
  expect(first.proposed).toHaveLength(1);
  expect(first.proposed[0]).toMatchObject({
    status: 'proposed',
    author: 'cypher',
    category: 'media',
    scope: { kind: 'playbook', id: 'sitecoreai-migration' },
    when: 'the source site refuses a media download',
    then: 'skip it and log the gap',
  });
  expect(first.proposed[0]!.sources.map((x) => x.escalationId)).toEqual(['x1', 'x2']);
  // Run again: the cause already has a rule.
  expect((await harvest()).proposed).toEqual([]);
});
