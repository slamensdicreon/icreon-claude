import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryRuleStore, migrate, PostgresRuleStore, type RuleStore } from '../src';

const media = {
  when: 'the source refuses a media download (403)',
  then: 'skip the file and log it as a gap',
  category: 'media' as const,
  author: 'director' as const,
};
const ctx = (projectId: string, role = 'media-migrator') => ({
  projectId,
  playbookId: 'sitecoreai-migration',
  platform: 'sitecoreai',
  category: 'media' as const,
  role,
});

function behaves(name: string, make: () => Promise<RuleStore>) {
  describe(name, () => {
    let store: RuleStore;
    beforeAll(async () => {
      store = await make();
    }, 60_000);

    it('applies only active rules, in their scope and for their roles', async () => {
      const proposed = await store.create({
        ...media,
        scope: { kind: 'playbook', id: 'sitecoreai-migration' },
        status: 'proposed',
        sources: [
          {
            projectId: 'p1',
            escalationId: 'e1',
            title: 'Access denied: Upload a.png',
            answer: 'Skip',
          },
        ],
      });
      expect(proposed).toMatchObject({
        ref: expect.stringMatching(/^R-\d+$/),
        version: 1,
        flagged: false,
      });
      expect(await store.matching(ctx('p2'))).toEqual([]);
      await store.setStatus(proposed.id, 'active');
      expect((await store.matching(ctx('p2'))).map((r) => r.id)).toEqual([proposed.id]);
      // A card of another category still gets it, after rules of its own category: a scope rule
      // is often met as a retry card. Another playbook's scope, or a role it isn't for: not this rule.
      const naming = await store.create({
        ...media,
        category: 'naming',
        scope: { kind: 'playbook', id: 'sitecoreai-migration' },
        status: 'active',
      });
      expect((await store.matching({ ...ctx('p2'), category: 'naming' })).map((r) => r.id)).toEqual(
        [naming.id, proposed.id],
      );
      expect((await store.matching(ctx('p2'))).map((r) => r.id)).toEqual([proposed.id, naming.id]);
      await store.setStatus(naming.id, 'retired');
      const onlyMine = await store.create({
        ...media,
        scope: { kind: 'project', id: 'p9' },
        roles: ['content-migrator'],
        status: 'active',
      });
      expect((await store.matching(ctx('p9'))).map((r) => r.id)).not.toContain(onlyMine.id);
      expect((await store.matching(ctx('p9', 'content-migrator'))).map((r) => r.id)).toContain(
        onlyMine.id,
      );
      expect((await store.matching(ctx('p2', 'content-migrator'))).map((r) => r.id)).not.toContain(
        onlyMine.id,
      );
    });

    it('versions edits, counts uses, flags a rule overridden twice, and keeps its history', async () => {
      const r = await store.create({
        ...media,
        scope: { kind: 'platform', id: 'sitecoreai' },
        status: 'active',
      });
      const edited = await store.edit(r.id, {
        then: 'skip it, log the gap, and note the page it was on',
      });
      expect(edited).toMatchObject({ version: 2, when: media.when });
      await expect(store.edit(r.id, { when: '  ' })).rejects.toThrow(/needs both/);
      await store.applied(r.id, { projectId: 'p1', escalationId: 'e2' });
      await store.overridden(r.id, { projectId: 'p1', escalationId: 'e3' });
      expect(await store.get(r.id)).toMatchObject({ applied: 1, overridden: 1, flagged: false });
      await store.overridden(r.id, { projectId: 'p1', escalationId: 'e4' });
      expect(await store.get(r.id)).toMatchObject({ overridden: 2, flagged: true });
      await store.setStatus(r.id, 'retired');
      expect(await store.matching(ctx('p1'))).not.toContainEqual(
        expect.objectContaining({ id: r.id }),
      );
      expect((await store.history(r.id)).map((h) => h.kind)).toEqual([
        'created',
        'edited',
        'applied',
        'overridden',
        'overridden',
        'retired',
      ]);
      expect((await store.list({ status: 'retired' })).map((x) => x.id)).toContain(r.id);
    });
  });
}

let db: PGlite;
afterAll(async () => {
  await db?.close();
});
behaves('PostgresRuleStore', async () => {
  db = new PGlite();
  await migrate(db);
  return new PostgresRuleStore(db);
});
let t = Date.parse('2026-10-29T12:00:00Z');
behaves('MemoryRuleStore', async () => new MemoryRuleStore(() => (t += 1000)));
