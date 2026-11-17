import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MemoryKnowledgeStore,
  MemoryOrganizationStore,
  migrate,
  pitfallSeeds,
  PostgresKnowledgeStore,
  PostgresOrganizationStore,
  type KnowledgeContext,
  type KnowledgeStore,
  type OrganizationStore,
} from '../src';

const ctx = (over: Partial<KnowledgeContext> = {}): KnowledgeContext => ({
  projectId: 'p1',
  playbookId: 'sitecoreai-migration',
  platform: 'sitecoreai',
  role: 'content-migrator',
  operations: ['sitecore-authoring.item.create', 'sitecore-authoring.layout.compose'],
  templateId: 'migrate-page',
  text: 'Migrate page About Us: hero banner, card grid',
  docs: [],
  ...over,
});

function behaves(
  name: string,
  make: () => Promise<{ store: KnowledgeStore; orgs: OrganizationStore }>,
) {
  describe(name, () => {
    let store: KnowledgeStore;
    let orgs: OrganizationStore;
    beforeAll(async () => {
      ({ store, orgs } = await make());
    }, 60_000);

    it('puts an organization’s own lesson in its projects’ briefs only', async () => {
      const acme = await orgs.create({ name: 'Acme', slug: 'acme' });
      await orgs.assignProject('acme-1', acme.id);
      const own = await store.create({
        kind: 'lesson',
        status: 'active',
        scope: { kind: 'playbook', id: 'sitecoreai-migration' },
        title: 'Acme hero banners keep their overlay',
        text: 'On Acme pages the hero banner keeps its dark overlay.',
        roles: ['content-migrator'],
        author: 'director',
        organizationId: acme.id,
      });
      expect(own!.organizationId).toBe(acme.id);
      const ids = async (projectId: string) =>
        (await store.retrieve(ctx({ projectId }))).map((e) => e.id);
      expect(await ids('acme-1')).toContain(own!.id);
      expect(await ids('icreon-1')).not.toContain(own!.id);
      expect((await store.list({ organizationId: acme.id })).map((e) => e.id)).toEqual([own!.id]);
      await store.setStatus(own!.id, 'retired');
    });

    it('gives a task the active entries that apply to it, best first', async () => {
      const base = { kind: 'lesson' as const, author: 'director' as const };
      const hero = await store.create({
        ...base,
        status: 'active',
        scope: { kind: 'platform', id: 'sitecoreai' },
        title: 'Hero banner datasource fields are empty after migration',
        text: 'Fill the datasource item, not standard values, before placing the hero banner.',
        roles: ['content-migrator'],
      });
      await store.create({
        ...base,
        status: 'active',
        scope: { kind: 'platform', id: 'optimizely' },
        title: 'Hero banner on Optimizely',
        text: 'Another platform: never offered here.',
      });
      await store.create({
        ...base,
        status: 'proposed',
        scope: { kind: 'platform', id: 'sitecoreai' },
        title: 'Card grid limits',
        text: 'Proposed: not offered until approved.',
      });
      const ops = await store.create({
        ...base,
        status: 'active',
        scope: { kind: 'global', id: '*' },
        title: 'Layouts need resolved rendering IDs',
        text: 'Read the rendering IDs from the facts before composing a layout.',
        operations: ['layout.compose'],
      });
      await store.create({
        ...base,
        status: 'active',
        scope: { kind: 'global', id: '*' },
        title: 'Publishing jobs',
        text: 'Only for roles that publish.',
        operations: ['publish'],
      });
      const doc = await store.create({
        ...base,
        status: 'active',
        scope: { kind: 'platform', id: 'sitecoreai' },
        title: 'Card grid children are capped',
        text: 'Seeded from a document the role already has.',
        source: { doc: 'known-pitfalls', projectId: null, phase: null },
      });
      // The role carries the pitfalls document in its prompt: its rows aren't repeated.
      const got = await store.retrieve(ctx({ docs: ['known-pitfalls'] }));
      expect(got.map((e) => e.id)).toEqual([hero!.id, ops!.id]);
      // A role without the document gets the seeded row when it fits the task.
      const other = await store.retrieve(
        ctx({ role: 'qa', operations: [], docs: [], text: 'Check the card grid' }),
      );
      expect(other.map((e) => e.id)).toEqual([doc!.id]);
    });

    it('adds a seeded or retrospective entry once, and keeps its history', async () => {
      const input = {
        kind: 'lesson' as const,
        status: 'proposed' as const,
        scope: { kind: 'playbook' as const, id: 'sitecoreai-migration' },
        title: 'Registrars overwrite each other',
        text: 'Add renderings to Available Renderings with add: true.',
        author: 'cypher' as const,
        source: { doc: null, projectId: 'p9', phase: 4 },
        sourceKey: 'p9:phase-4:registrars-overwrite',
      };
      const first = await store.create(input);
      expect(first).not.toBeNull();
      expect(await store.create(input)).toBeNull();
      expect((await store.list({ projectId: 'p9' })).map((e) => e.id)).toEqual([first!.id]);
      expect((await store.list({ q: 'renderings' })).map((e) => e.id)).toContain(first!.id);
      const edited = await store.edit(first!.id, { text: 'Use add: true on ID lists.' });
      expect(edited).toMatchObject({ version: 2, text: 'Use add: true on ID lists.' });
      await store.setStatus(first!.id, 'active');
      await store.used([first!.id], { projectId: 'p1', taskId: 't1' });
      expect((await store.get(first!.id))!.used).toBe(1);
      expect((await store.history(first!.id)).map((h) => h.kind)).toEqual([
        'created',
        'edited',
        'activated',
        'used',
      ]);
    });
  });
}

describe('seeding', () => {
  it('adds only rows not seeded before, without using up reference numbers', async () => {
    const db2 = new PGlite();
    await migrate(db2);
    const store = new PostgresKnowledgeStore(db2);
    const md =
      '| Symptom | Likely cause | What to do |\n| --- | --- | --- |\n| A | B | C |\n| D | E | F |';
    expect(await store.seed(pitfallSeeds('sitecoreai', md))).toBe(2);
    expect(await store.seed(pitfallSeeds('sitecoreai', md))).toBe(0);
    expect(await store.seed(pitfallSeeds('sitecoreai', `${md}\n| G | H | I |`))).toBe(1);
    expect((await store.list()).map((e) => e.ref).sort()).toEqual(['K-1', 'K-2', 'K-3']);
    await db2.close();
    // A fresh PGlite takes seconds to start when the machine is busy.
  }, 60_000);
});

describe('pitfall seeds', () => {
  it('turns every row of the SitecoreAI pitfalls table into one lesson', async () => {
    const md = await readFile(
      new URL('../../../platforms/sitecoreai/knowledge/known-pitfalls.md', import.meta.url),
      'utf8',
    );
    const rows = md.split('\n').filter((l) => l.trim().startsWith('|')).length - 2;
    const seeds = pitfallSeeds('sitecoreai', md);
    expect(seeds).toHaveLength(rows);
    expect(new Set(seeds.map((s) => s.sourceKey)).size).toBe(rows);
    expect(seeds[0]).toMatchObject({
      title: 'A page exists and publishes, but its URL is a 404',
      scope: { kind: 'platform', id: 'sitecoreai' },
      status: 'active',
      source: { doc: 'known-pitfalls' },
    });
    expect(seeds[0]!.text).toMatch(/^Likely cause: .+\. What to do: Create routes beneath Home/);
  });
});

let db: PGlite;
afterAll(async () => {
  await db?.close();
});
behaves('PostgresKnowledgeStore', async () => {
  db = new PGlite();
  await migrate(db);
  return { store: new PostgresKnowledgeStore(db), orgs: new PostgresOrganizationStore(db) };
});
let t = Date.parse('2026-10-31T12:00:00Z');
behaves('MemoryKnowledgeStore', async () => {
  const store = new MemoryKnowledgeStore(() => (t += 1000));
  const orgs = new MemoryOrganizationStore();
  store.setProjectOwner(async (id) => (await orgs.ownersOf([id])).get(id) ?? null);
  return { store, orgs };
});
