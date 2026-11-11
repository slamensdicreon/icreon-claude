import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MemoryLicenseStore,
  migrate,
  PostgresLicenseStore,
  PostgresOrganizationStore,
  type LicenseStore,
} from '../src';

const terms = {
  entities: ['sitecoreai', ' sitecoreai '],
  playbooks: ['sitecoreai-migration'],
  projectsIncluded: 10,
  startsAt: '2026-11-01T00:00:00Z',
  endsAt: '2027-11-01T00:00:00Z',
};

function behaves(name: string, make: () => Promise<{ store: LicenseStore; org: string }>) {
  describe(name, () => {
    it('grants, changes and keeps every change', async () => {
      const { store, org } = await make();
      expect(await store.get(org)).toBeNull();
      const l = await store.set(org, terms, 'github:steve');
      expect(l).toMatchObject({
        entities: ['sitecoreai'],
        playbooks: ['sitecoreai-migration'],
        projectsIncluded: 10,
        startsAt: '2026-11-01T00:00:00.000Z',
        endsAt: '2027-11-01T00:00:00.000Z',
        suspended: null,
        updatedBy: 'github:steve',
      });
      await store.set(org, { ...terms, projectsIncluded: 12 }, 'github:steve');
      await store.setSuspended(org, { at: '2027-11-01T00:00:00Z', projects: ['prj-1'] }, 'system');
      expect((await store.get(org))?.suspended).toEqual({
        at: '2027-11-01T00:00:00Z',
        projects: ['prj-1'],
      });
      // A change to the terms keeps the suspension; resuming clears it.
      await store.set(org, { ...terms, endsAt: '2028-11-01T00:00:00Z' }, 'github:steve');
      expect((await store.get(org))?.suspended?.projects).toEqual(['prj-1']);
      await store.setSuspended(org, null, 'system');
      const history = await store.history(org);
      expect(history.map((h) => h.kind)).toEqual([
        'granted',
        'changed',
        'suspended',
        'changed',
        'resumed',
      ]);
      expect(history[1]!.license.projectsIncluded).toBe(12);
      expect((await store.list()).map((x) => x.organizationId)).toContain(org);
    });

    it('refuses terms that make no sense', async () => {
      const { store, org } = await make();
      await expect(store.set(org, { ...terms, endsAt: terms.startsAt }, 'x')).rejects.toThrow(
        /end after/,
      );
      await expect(store.set(org, { ...terms, projectsIncluded: -1 }, 'x')).rejects.toThrow(
        /whole number/,
      );
      await expect(store.set(org, { ...terms, startsAt: 'soon' }, 'x')).rejects.toThrow(/dates?/);
    });
  });
}

behaves('MemoryLicenseStore', async () => ({ store: new MemoryLicenseStore(), org: 'org-a' }));

describe('on Postgres', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await migrate(db);
  }, 60_000);
  afterAll(async () => {
    await db.close();
  });
  behaves('PostgresLicenseStore', async () => {
    const org = await new PostgresOrganizationStore(db).create({
      name: 'Acme',
      slug: `acme-${Math.random().toString(36).slice(2, 8)}`,
    });
    return { store: new PostgresLicenseStore(db), org: org.id };
  });
});
