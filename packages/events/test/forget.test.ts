import { PGlite } from '@electric-sql/pglite';
import { afterAll, describe, expect, it } from 'vitest';
import {
  masterKey,
  MemoryKnowledgeStore,
  MemoryRuleStore,
  MemoryTombstoneStore,
  MemoryVault,
  migrate,
  PostgresKnowledgeStore,
  PostgresRuleStore,
  PostgresTombstoneStore,
  PostgresVault,
  type KnowledgeStore,
  type RuleStore,
  type SecretVault,
  type TombstoneStore,
} from '../src';

interface Stores {
  rules: RuleStore;
  knowledge: KnowledgeStore;
  vault: SecretVault;
  tombstones: TombstoneStore;
}

const card = (projectId: string) => ({
  projectId,
  escalationId: 'esc-1',
  title: 'Globex: hero video is 157 MB',
  answer: 'Use the poster image for Globex',
});

function behaves(name: string, make: () => Promise<Stores>) {
  describe(name, () => {
    it('forgets a deleted project: its own rules and lessons go, the ones it taught stay without its words', async () => {
      const { rules, knowledge } = await make();
      const own = await rules.create({
        when: 'w',
        then: 't',
        category: 'media',
        scope: { kind: 'project', id: 'prj-gone' },
        sources: [card('prj-gone')],
        author: 'director',
        status: 'active',
      });
      const taught = await rules.create({
        when: 'a hero video is too large',
        then: 'use its poster image',
        category: 'media',
        scope: { kind: 'playbook', id: 'sitecoreai-migration' },
        sources: [card('prj-gone'), card('prj-stays')],
        author: 'director',
        status: 'active',
      });
      await rules.applied(taught.id, { projectId: 'prj-gone', escalationId: 'esc-9' });
      await rules.applied(taught.id, { projectId: 'prj-stays', escalationId: 'esc-8' });

      const lesson = (scope: { kind: 'project' | 'platform'; id: string }, title: string) =>
        knowledge.create({
          kind: 'lesson',
          status: 'active',
          scope,
          title,
          text: 'Fill the datasource first.',
          evidence: [{ projectId: 'prj-gone', ref: 'artifact://x', label: 'Globex hero report' }],
          author: 'cypher',
          source: { doc: null, projectId: 'prj-gone', phase: 4 },
        });
      const ownLesson = (await lesson({ kind: 'project', id: 'prj-gone' }, 'Globex only'))!;
      const shared = (await lesson({ kind: 'platform', id: 'sitecoreai' }, 'Datasource first'))!;
      await knowledge.used([shared.id], { projectId: 'prj-gone', taskId: 't1' });

      expect(await rules.forgetProject('prj-gone')).toEqual({ deleted: 1, deidentified: 1 });
      expect(await rules.get(own.id)).toBeNull();
      const kept = (await rules.get(taught.id))!;
      expect(kept.sources).toEqual([
        {
          projectId: 'prj-gone',
          escalationId: '',
          title: 'A card on a deleted project',
          answer: null,
        },
        card('prj-stays'),
      ]);
      expect(kept.applied).toBe(2);
      const history = await rules.history(taught.id);
      expect(JSON.stringify(history)).not.toContain('esc-9');
      expect(history.filter((h) => h.kind === 'applied')).toHaveLength(2);

      expect(await knowledge.forgetProject('prj-gone')).toEqual({ deleted: 1, deidentified: 1 });
      expect(await knowledge.get(ownLesson.id)).toBeNull();
      const k = (await knowledge.get(shared.id))!;
      expect(k.evidence).toEqual([
        { projectId: 'prj-gone', ref: '', label: 'Evidence from a deleted project' },
      ]);
      expect(k.used).toBe(1);
      expect(JSON.stringify(await knowledge.history(shared.id))).not.toContain('"t1"');
    });

    it('deletes only the project’s secrets', async () => {
      const { vault } = await make();
      await vault.seal('prj-gone', 'a', 'secret-a');
      await vault.seal('prj-gone', 'b', 'secret-b');
      const kept = await vault.seal('prj-stays', 'a', 'secret-c');
      expect(await vault.deleteProject('prj-gone')).toBe(2);
      expect(await vault.deleteProject('prj-gone')).toBe(0);
      expect(await vault.open(kept.reference)).toBe('secret-c');
    });

    it('keeps a purge’s record and resumes it', async () => {
      const { tombstones } = await make();
      const start = {
        projectId: 'prj-gone',
        name: 'Globex site',
        client: 'Globex',
        requestedBy: 'steve',
        requestedAt: '2026-11-07T12:00:00.000Z',
      };
      await tombstones.begin(start);
      await tombstones.step('prj-gone', 'blobs', { deleted: 3 });
      const again = await tombstones.begin({ ...start, requestedBy: 'someone-else' });
      expect(again).toMatchObject({ requestedBy: 'steve', finishedAt: null });
      expect(again.steps.blobs?.result).toEqual({ deleted: 3 });
      await tombstones.finish('prj-gone', 'vercel-cron');
      expect((await tombstones.list())[0]).toMatchObject({ purgedBy: 'vercel-cron' });
      expect((await tombstones.get('prj-gone'))?.finishedAt).toBeTruthy();
    });
  });
}

const dbs: PGlite[] = [];
afterAll(async () => {
  await Promise.all(dbs.map((d) => d.close()));
});
behaves('Postgres', async () => {
  const db = new PGlite();
  dbs.push(db);
  await migrate(db);
  return {
    rules: new PostgresRuleStore(db),
    knowledge: new PostgresKnowledgeStore(db),
    vault: new PostgresVault(db, [masterKey(Buffer.alloc(32, 7).toString('base64'))]),
    tombstones: new PostgresTombstoneStore(db),
  };
});
behaves('memory', async () => ({
  rules: new MemoryRuleStore(),
  knowledge: new MemoryKnowledgeStore(),
  vault: new MemoryVault(),
  tombstones: new MemoryTombstoneStore(),
}));
