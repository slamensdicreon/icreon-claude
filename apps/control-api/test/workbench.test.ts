import { fileURLToPath } from 'node:url';
import { WorkbenchSnapshot, type CreateProject } from '@lw/contracts';
import { InMemoryEventStore, Projections } from '@lw/events';
import { loadPlaybook } from '@lw/playbook-sdk';
import { phaseDefs, roster } from '@lw/playbook-sdk/pure';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';

const PLAYBOOK = fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url));

let app: FastifyInstance;
const intakes: CreateProject[] = [];
const blobs = new Map([['blob://p1/artifacts/page-inventory/v2.json', '{"pages":[]}']]);

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
    createProject: async (input) => {
      intakes.push(input);
      return 'p2';
    },
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
});

describe('intake', () => {
  it('passes the source site through, and refuses a non-web URL', async () => {
    const ok = await app.inject({
      method: 'POST',
      url: '/projects',
      payload: { name: 'Globex site', client: 'Globex', sourceUrl: 'https://globex.example' },
    });
    expect(ok.statusCode).toBe(201);
    expect(intakes).toEqual([
      { name: 'Globex site', client: 'Globex', sourceUrl: 'https://globex.example' },
    ]);

    const bad = await app.inject({
      method: 'POST',
      url: '/projects',
      payload: { name: 'Globex site', client: 'Globex', sourceUrl: 'file:///etc/passwd' },
    });
    expect(bad.statusCode).toBe(400);
    expect(intakes).toHaveLength(1);
  });
});
