import { KnowledgeEntry, KnowledgeList, LessonsSnapshot } from '@lw/contracts';
import { InMemoryEventStore, MemoryKnowledgeStore, Projections } from '@lw/events';
import type { FastifyInstance } from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { buildApp } from '../src/app';

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function start(opts: { retrospective?: boolean } = {}) {
  const store = new InMemoryEventStore();
  await store.append('p1', [
    {
      type: 'project.created',
      actor: { kind: 'system', id: 'sys' },
      subject: { kind: 'project', id: 'p1' },
      severity: 'routine',
      data: {
        name: 'Lambert',
        client: 'Lambert',
        playbook: { id: 'sitecoreai-migration', version: '0.8.0' },
        budgets: { tokens: 1, usd: 1, hours: 1 },
        phases: [{ number: 4, name: 'Components', gate: 'none', exitCriteria: '' }],
        roster: [],
      },
    },
  ]);
  const projections = new Projections(store);
  await projections.start();
  const knowledge = new MemoryKnowledgeStore();
  const ran: number[] = [];
  app = await buildApp({
    store,
    projections,
    commands: () => undefined,
    knowledge,
    retrospective: opts.retrospective
      ? async (projectId, phase) => {
          ran.push(phase);
          const e = await knowledge.create({
            kind: 'lesson',
            status: 'proposed',
            scope: { kind: 'platform', id: 'sitecoreai' },
            title: 'Registrars overwrite a shared list',
            text: 'Add with add: true.',
            author: 'cypher',
            source: { doc: null, projectId, phase },
          });
          return { phase, summary: 'One cause.', proposed: [e!] };
        }
      : null,
  });
  return { ran };
}

const call = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => {
  const r = await app!.inject({ method, url, payload: payload as object });
  return {
    status: r.statusCode,
    body: r.headers['content-type']?.includes('json') ? (r.json() as any) : r.body,
  };
};

it('writes, edits, retires and lists knowledge, and exports a platform as Markdown', async () => {
  await start();
  const made = await call('POST', '/knowledge', {
    title: 'Hero datasource fields empty',
    text: 'Fill the datasource item, not standard values.',
    scope: { kind: 'platform', id: 'sitecoreai' },
    roles: ['content-migrator'],
  });
  expect(made.status).toBe(201);
  const e = KnowledgeEntry.parse(made.body);
  expect(e).toMatchObject({ ref: 'K-1', status: 'active', author: 'director', kind: 'lesson' });
  const edited = KnowledgeEntry.parse(
    (await call('PUT', `/knowledge/${e.id}`, { text: 'Fill the datasource item first.' })).body,
  );
  expect(edited.version).toBe(2);
  const list = KnowledgeList.parse((await call('GET', '/knowledge?q=datasource')).body);
  expect(list.entries.map((x) => x.id)).toEqual([e.id]);
  const md = await call('GET', '/knowledge/export?platform=sitecoreai');
  expect(md.body).toContain(
    '| K-1 | Hero datasource fields empty | Fill the datasource item first. |',
  );
  expect((await call('POST', `/knowledge/${e.id}/retire`)).body.status).toBe('retired');
  expect(
    (await call('GET', `/knowledge/${e.id}/history`)).body.map((h: { kind: string }) => h.kind),
  ).toEqual(['created', 'edited', 'retired']);
  expect(
    (await call('POST', '/knowledge', { title: 'x', text: '', scope: { kind: 'global', id: '*' } }))
      .status,
  ).toBe(400);
  expect((await call('POST', `/knowledge/${e.id}/explode`)).status).toBe(404);
});

it("runs a phase's retrospective and lists what it proposed, for approval", async () => {
  const { ran } = await start({ retrospective: true });
  const before = LessonsSnapshot.parse((await call('GET', '/projects/p1/lessons')).body);
  expect(before).toMatchObject({
    available: true,
    entries: [],
    phases: [{ phase: 4, proposed: 0 }],
  });
  const r = await call('POST', '/projects/p1/retrospectives', { phase: 4 });
  expect(r.status).toBe(200);
  expect(r.body.proposed[0]).toMatchObject({ status: 'proposed' });
  expect(ran).toEqual([4]);
  const after = LessonsSnapshot.parse((await call('GET', '/projects/p1/lessons')).body);
  expect(after.phases[0]!.proposed).toBe(1);
  const id = after.entries[0]!.id;
  expect((await call('POST', `/knowledge/${id}/approve`)).body.status).toBe('active');
  expect((await call('POST', '/projects/p1/retrospectives', { phase: 9 })).status).toBe(404);
});

it('says so when retrospectives or knowledge are unavailable', async () => {
  await start();
  expect((await call('POST', '/projects/p1/retrospectives', { phase: 4 })).status).toBe(501);
  await app!.close();
  const store = new InMemoryEventStore();
  const projections = new Projections(store);
  await projections.start();
  app = await buildApp({ store, projections, commands: () => undefined });
  expect((await call('GET', '/knowledge')).status).toBe(501);
});
