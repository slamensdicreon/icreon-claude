import { fileURLToPath } from 'node:url';
import { WorkbenchSnapshot } from '@lw/contracts';
import { InMemoryEventStore, Projections } from '@lw/events';
import { loadPlaybook } from '@lw/playbook-sdk';
import { phaseDefs, roster } from '@lw/playbook-sdk/pure';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';

const PLAYBOOK = fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url));

let app: FastifyInstance;
const blobs = new Map([
  ['blob://p1/artifacts/page-inventory/v2.json', '{"pages":[]}'],
  [
    'blob://p1/assets/logo.svg',
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  ],
  ['blob://p1/assets/shot.png', 'png'],
]);

beforeAll(async () => {
  const store = new InMemoryEventStore();
  const projections = new Projections(store);
  await projections.start();
  const playbook = await loadPlaybook(PLAYBOOK);
  const agent = { kind: 'agent' as const, id: 'content-analyst' };
  const version = (version: number, ref: string | null, title = 'Page inventory') => ({
    type: 'artifact.versioned' as const,
    actor: agent,
    subject: { kind: 'artifact' as const, id: 'page-inventory' },
    severity: 'notable' as const,
    data: {
      artifactId: 'page-inventory',
      kind: 'inventory' as const,
      title,
      version,
      ref,
      format: 'json' as const,
    },
  });
  await store.append('p1', [
    {
      type: 'project.created',
      actor: { kind: 'system', id: 'intake' },
      subject: { kind: 'project', id: 'p1' },
      severity: 'notable',
      data: {
        name: 'Acme corporate site',
        client: 'Acme Corp',
        playbook: { id: playbook.manifest.id, version: playbook.manifest.version },
        budgets: playbook.manifest.defaults.budgets,
        phases: phaseDefs(playbook),
        roster: roster(playbook),
        site: { sourceUrl: 'https://www.acme.example' },
      },
    },
    version(1, null),
    version(2, 'blob://p1/artifacts/page-inventory/v2.json'),
  ]);
  await projections.waitFor('p1', await store.head('p1'));
  app = await buildApp({
    store,
    projections,
    commands: () => undefined,
    artifactContent: async (_id, ref) => {
      const s = blobs.get(ref);
      return s ? new TextEncoder().encode(s) : null;
    },
  });
});

afterAll(() => app.close());

describe('workbench', () => {
  it('lists artifacts with their versions', async () => {
    const r = await app.inject('/projects/p1/workbench');
    const wb = WorkbenchSnapshot.parse(r.json());
    expect(wb.artifacts).toEqual([
      expect.objectContaining({
        artifactId: 'page-inventory',
        latest: 2,
        versions: expect.any(Array),
      }),
    ]);
    expect((await app.inject('/projects/p1/artifacts/page-inventory')).json()).toMatchObject({
      latest: 2,
    });
    expect((await app.inject('/projects/p1/artifacts/nope')).statusCode).toBe(404);
  });

  it('serves stored content by version or latest, and names versions without content', async () => {
    for (const v of ['2', 'latest']) {
      const r = await app.inject(`/projects/p1/artifacts/page-inventory/versions/${v}/content`);
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toMatch(/^application\/json/);
      expect(r.json()).toEqual({ pages: [] });
    }
    const none = await app.inject('/projects/p1/artifacts/page-inventory/versions/1/content');
    expect(none.statusCode).toBe(404);
    expect(none.json().error.code).toBe('no_content');
    expect(
      (await app.inject('/projects/p1/artifacts/page-inventory/versions/9/content')).json().error
        .code,
    ).toBe('unknown_version');
  });

  it('serves stored blobs so none can run as the app, and refuses keys that climb out', async () => {
    const svg = await app.inject('/projects/p1/blobs/assets/logo.svg');
    expect(svg.statusCode).toBe(200);
    expect(svg.headers['content-disposition']).toBe('attachment');
    expect(svg.headers['x-content-type-options']).toBe('nosniff');
    expect(svg.headers['content-security-policy']).toMatch(/default-src 'none'.*sandbox/);
    const png = await app.inject('/projects/p1/blobs/assets/shot.png');
    expect(png.headers['content-disposition']).toBe('inline');
    expect(png.headers['content-security-policy']).toMatch(/sandbox/);
    expect((await app.inject('/projects/p1/blobs/assets/..%2Fx.svg')).statusCode).toBe(400);
    expect((await app.inject('/projects/p1/blobs/assets//x.svg')).statusCode).toBe(400);
    // Every other answer is never framed or sniffed either.
    const list = await app.inject('/projects/p1/artifacts');
    expect(list.headers['x-frame-options']).toBe('DENY');
    expect(list.headers['content-security-policy']).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
  });

  it('tells the story, even for documents saved before phases and plain titles existed', async () => {
    const wb = WorkbenchSnapshot.parse((await app.inject('/projects/p1/workbench')).json());
    const doc = wb.artifacts.find((a) => a.artifactId === 'page-inventory')!;
    // No headline or audience in the events: the rules supply them.
    expect(doc).toMatchObject({
      headline: 'Every page on the site',
      audience: 'director',
      phase: null,
      changedSinceApproval: false,
      readMinutes: 1,
      author: { agentId: 'content-analyst', role: 'Content Analyst' },
    });
    const story = wb.story!;
    // Saved before any phase began: grouped as such, not lost.
    expect(story.phases.map((p) => p.name)).toEqual(['Before the phases']);
    expect(story.phases[0]!.docs).toEqual(['page-inventory']);
    expect(story.startHere[0]).toMatchObject({ artifactId: 'page-inventory' });
    expect(story.authors[0]).toMatchObject({ agentId: 'content-analyst', count: 1 });
    expect(story.voice.text).toMatch(/one document, one of them for you/);
    expect(story.voice.emphasis).toBe('Start with “Every page on the site”.');
    expect(story.next).toMatchObject({ number: 0 });
  });
});
