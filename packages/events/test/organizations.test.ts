import { PGlite } from '@electric-sql/pglite';
import type { NewEvent } from '@lw/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_ORGANIZATION,
  MemoryOrganizationStore,
  migrate,
  PostgresEventStore,
  PostgresOrganizationStore,
  githubSubject,
  listenWithPglite,
  type OrganizationStore,
} from '../src';

const created: NewEvent = {
  type: 'project.status',
  actor: { kind: 'system', id: 't' },
  subject: { kind: 'project', id: 'p' },
  severity: 'routine',
  data: { status: 'running' },
};

function behaves(name: string, make: () => Promise<OrganizationStore>) {
  describe(name, () => {
    it('starts with Icreon, organization #1', async () => {
      const orgs = await make();
      expect((await orgs.get(DEFAULT_ORGANIZATION))?.name).toBe('Icreon');
    });

    it('creates organizations with unique slugs', async () => {
      const orgs = await make();
      const a = await orgs.create({ name: 'Acme Corp', slug: 'acme' });
      expect(a).toMatchObject({ name: 'Acme Corp', slug: 'acme' });
      await expect(orgs.create({ name: 'Acme again', slug: 'acme' })).rejects.toThrow(
        /already exists/,
      );
      await expect(orgs.create({ name: 'Bad', slug: 'Not A Slug' })).rejects.toThrow(/slug/);
      expect((await orgs.list()).map((o) => o.id)).toEqual([DEFAULT_ORGANIZATION, a.id]);
    });

    it('keeps memberships per organization, and changes a role in place', async () => {
      const orgs = await make();
      const acme = await orgs.create({ name: 'Acme', slug: 'acme-m' });
      const me = githubSubject('SomeOne');
      expect(me).toBe('github:someone');
      await orgs.setMember(DEFAULT_ORGANIZATION, me, 'director', 'test');
      await orgs.setMember(acme.id, me, 'watcher', 'test');
      await orgs.setMember(acme.id, me, 'director', 'test');
      const mine = await orgs.membershipsOf(me);
      expect(mine.map((m) => [m.organization.id, m.role])).toEqual([
        [DEFAULT_ORGANIZATION, 'director'],
        [acme.id, 'director'],
      ]);
      await expect(orgs.setMember(acme.id, me, 'owner' as never, 'test')).rejects.toThrow(/role/);
      await orgs.removeMember(acme.id, me);
      expect((await orgs.membershipsOf(me)).map((m) => m.organizationId)).toEqual([
        DEFAULT_ORGANIZATION,
      ]);
      expect(await orgs.members(acme.id)).toEqual([]);
    });

    it('gives each project one owner for good; unassigned projects are Icreon’s', async () => {
      const orgs = await make();
      const acme = await orgs.create({ name: 'Acme', slug: 'acme-p' });
      await orgs.assignProject('prj-a', acme.id);
      await orgs.assignProject('prj-a', acme.id);
      await expect(orgs.assignProject('prj-a', DEFAULT_ORGANIZATION)).rejects.toThrow(
        /another organization/,
      );
      const owners = await orgs.ownersOf(['prj-a', 'prj-never-assigned']);
      expect(owners.get('prj-a')).toBe(acme.id);
      expect(owners.get('prj-never-assigned')).toBe(DEFAULT_ORGANIZATION);
    });
  });
}

behaves('MemoryOrganizationStore', async () => new MemoryOrganizationStore());

describe('on Postgres', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await migrate(db);
  }, 60_000);
  afterAll(async () => {
    await db.close();
  });

  // One database for every case: each creates its own slugs and projects.
  behaves('PostgresOrganizationStore', async () => new PostgresOrganizationStore(db));

  it('gives every project already in the log to Icreon when the migration runs', async () => {
    const store = await PostgresEventStore.connect(db, listenWithPglite(db));
    await store.append('prj-before-orgs', [created]);
    await store.append('prj-acme-own', [created]);
    const orgs = new PostgresOrganizationStore(db);
    const acme = await orgs.create({ name: 'Acme', slug: 'acme-migrated' });
    await db.query(`DELETE FROM lw_project_organizations WHERE project_id = 'prj-before-orgs'`);
    await orgs.assignProject('prj-acme-own', acme.id);
    // Migrations run on every start: the backfill only fills the gaps.
    await migrate(db);
    const { rows } = await db.query<{ project_id: string; organization_id: string }>(
      `SELECT project_id, organization_id FROM lw_project_organizations
        WHERE project_id IN ('prj-before-orgs', 'prj-acme-own') ORDER BY project_id`,
    );
    expect(rows).toEqual([
      { project_id: 'prj-acme-own', organization_id: acme.id },
      { project_id: 'prj-before-orgs', organization_id: DEFAULT_ORGANIZATION },
    ]);
    await store.close();
  });
});
