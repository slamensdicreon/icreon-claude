import { randomUUID } from 'node:crypto';
import type { SqlClient } from './postgres';

/** Organization #1: Icreon. It owns every project from before organizations existed. */
export const DEFAULT_ORGANIZATION = 'org-icreon';

export type MemberRole = 'director' | 'watcher';
export const MEMBER_ROLES: readonly MemberRole[] = ['director', 'watcher'];

export interface Organization {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface Membership {
  organizationId: string;
  /** The signed-in identity, qualified by its source: `github:<login>`. */
  subject: string;
  role: MemberRole;
  addedBy: string;
  createdAt: string;
  /** How the member is shown: their email or GitHub login. */
  label: string | null;
}

/** An open invitation: someone asked, by email, to join an organization in a role. */
export interface Invitation {
  id: string;
  organizationId: string;
  /** Lower case. */
  email: string;
  role: MemberRole;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
}

/**
 * Organizations, who belongs to them, and which organization owns each project. A project's
 * owner never changes: its events, documents and credentials are keyed by project, so the
 * project's owner scopes all of them.
 */
export interface OrganizationStore {
  list(): Promise<Organization[]>;
  get(id: string): Promise<Organization | null>;
  create(input: { name: string; slug: string; id?: string }): Promise<Organization>;
  /** The organizations a person belongs to, oldest organization first. */
  membershipsOf(subject: string): Promise<(Membership & { organization: Organization })[]>;
  members(organizationId: string): Promise<Membership[]>;
  /** Adds a person, or changes their role (and label, when given). */
  setMember(
    organizationId: string,
    subject: string,
    role: MemberRole,
    addedBy: string,
    label?: string,
  ): Promise<void>;
  removeMember(organizationId: string, subject: string): Promise<void>;
  /** Invites an email address; an open invitation for the same address is replaced. */
  invite(input: {
    organizationId: string;
    email: string;
    role: MemberRole;
    invitedBy: string;
    expiresAt: Date;
  }): Promise<Invitation>;
  /** An organization's open invitations: not accepted, withdrawn or expired. */
  invitations(organizationId: string): Promise<Invitation[]>;
  /** Withdraws an open invitation; false if there was none. */
  revokeInvitation(organizationId: string, id: string): Promise<boolean>;
  /**
   * Turns every open invitation for a verified email address into a membership for the person
   * who signed in with it. Returns the invitations accepted.
   */
  acceptInvitations(email: string, subject: string): Promise<Invitation[]>;
  /** Records a project's owner. Refuses to move a project that another organization owns. */
  assignProject(projectId: string, organizationId: string): Promise<void>;
  /**
   * The owner of each project. A project with no row (a demo or seed written without one) is
   * Icreon's, as the migration made every earlier project.
   */
  ownersOf(projectIds: string[]): Promise<Map<string, string>>;
}

/** `github:<login>`, lower case: GitHub logins are case-insensitive. */
export const githubSubject = (login: string) => `github:${login.toLowerCase()}`;
/** `workos:<user id>`: someone WorkOS signed in. */
export const workosSubject = (userId: string) => `workos:${userId}`;

export class OrganizationError extends Error {}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const checkSlug = (slug: string) => {
  if (!SLUG.test(slug))
    throw new OrganizationError(
      `"${slug}" is not a usable slug: lower-case letters, digits and dashes, up to 40.`,
    );
};
const checkRole = (role: string) => {
  if (!MEMBER_ROLES.includes(role as MemberRole))
    throw new OrganizationError(`"${role}" is not a role.`);
};

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  created_at: string | Date;
}
interface MemberRow {
  organization_id: string;
  subject: string;
  role: MemberRole;
  added_by: string;
  created_at: string | Date;
  label?: string | null;
}
interface InvitationRow {
  id: string;
  organization_id: string;
  email: string;
  role: MemberRole;
  invited_by: string;
  created_at: string | Date;
  expires_at: string | Date;
}
const iso = (t: string | Date) => new Date(t).toISOString();
const org = (r: OrgRow): Organization => ({
  id: r.id,
  name: r.name,
  slug: r.slug,
  createdAt: iso(r.created_at),
});
const member = (r: MemberRow): Membership => ({
  organizationId: r.organization_id,
  subject: r.subject,
  role: r.role,
  addedBy: r.added_by,
  createdAt: iso(r.created_at),
  label: r.label ?? null,
});
const invitation = (r: InvitationRow): Invitation => ({
  id: r.id,
  organizationId: r.organization_id,
  email: r.email,
  role: r.role,
  invitedBy: r.invited_by,
  createdAt: iso(r.created_at),
  expiresAt: iso(r.expires_at),
});
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normalEmail = (email: string) => {
  const e = email.trim().toLowerCase();
  if (!EMAIL.test(e) || e.length > 254)
    throw new OrganizationError(`"${email}" is not an email address.`);
  return e;
};
const INVITATION_COLUMNS = 'id, organization_id, email, role, invited_by, created_at, expires_at';

export class PostgresOrganizationStore implements OrganizationStore {
  /** Owners never change, so a known owner is kept for the life of the process. */
  private readonly owners = new Map<string, string>();

  constructor(private readonly sql: SqlClient) {}

  async list(): Promise<Organization[]> {
    const { rows } = await this.sql.query<OrgRow>(
      'SELECT id, name, slug, created_at FROM lw_organizations ORDER BY created_at, id',
    );
    return rows.map(org);
  }

  async get(id: string): Promise<Organization | null> {
    const { rows } = await this.sql.query<OrgRow>(
      'SELECT id, name, slug, created_at FROM lw_organizations WHERE id = $1',
      [id],
    );
    return rows[0] ? org(rows[0]) : null;
  }

  async create(input: { name: string; slug: string; id?: string }): Promise<Organization> {
    checkSlug(input.slug);
    const { rows } = await this.sql.query<OrgRow>(
      `INSERT INTO lw_organizations (id, name, slug) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING RETURNING id, name, slug, created_at`,
      [input.id ?? `org-${randomUUID().slice(0, 8)}`, input.name.trim(), input.slug],
    );
    if (!rows[0]) throw new OrganizationError(`An organization "${input.slug}" already exists.`);
    return org(rows[0]);
  }

  async membershipsOf(subject: string) {
    const { rows } = await this.sql.query<
      MemberRow & { name: string; slug: string; org_created_at: string | Date }
    >(
      `SELECT m.organization_id, m.subject, m.role, m.added_by, m.created_at, m.label,
              o.name, o.slug, o.created_at AS org_created_at
         FROM lw_memberships m JOIN lw_organizations o ON o.id = m.organization_id
        WHERE m.subject = $1
        ORDER BY o.created_at, o.id`,
      [subject],
    );
    return rows.map((r) => ({
      ...member(r),
      organization: org({
        id: r.organization_id,
        name: r.name,
        slug: r.slug,
        created_at: r.org_created_at,
      }),
    }));
  }

  async members(organizationId: string): Promise<Membership[]> {
    const { rows } = await this.sql.query<MemberRow>(
      `SELECT organization_id, subject, role, added_by, created_at, label FROM lw_memberships
        WHERE organization_id = $1 ORDER BY created_at, subject`,
      [organizationId],
    );
    return rows.map(member);
  }

  async setMember(
    organizationId: string,
    subject: string,
    role: MemberRole,
    addedBy: string,
    label?: string,
  ) {
    checkRole(role);
    await this.sql.query(
      `INSERT INTO lw_memberships (organization_id, subject, role, added_by, label)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (organization_id, subject) DO UPDATE
         SET role = EXCLUDED.role, label = COALESCE(EXCLUDED.label, lw_memberships.label)`,
      [organizationId, subject, role, addedBy, label ?? null],
    );
  }

  async invite(input: {
    organizationId: string;
    email: string;
    role: MemberRole;
    invitedBy: string;
    expiresAt: Date;
  }): Promise<Invitation> {
    checkRole(input.role);
    const email = normalEmail(input.email);
    // Two statements: in one, Postgres doesn't order the withdrawal before the insert.
    await this.sql.query(
      `UPDATE lw_invitations SET revoked_at = now()
        WHERE organization_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [input.organizationId, email],
    );
    const { rows } = await this.sql.query<InvitationRow>(
      `INSERT INTO lw_invitations (id, organization_id, email, role, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${INVITATION_COLUMNS}`,
      [
        `inv-${randomUUID().slice(0, 12)}`,
        input.organizationId,
        email,
        input.role,
        input.invitedBy,
        input.expiresAt.toISOString(),
      ],
    );
    return invitation(rows[0]!);
  }

  async invitations(organizationId: string): Promise<Invitation[]> {
    const { rows } = await this.sql.query<InvitationRow>(
      `SELECT ${INVITATION_COLUMNS} FROM lw_invitations
        WHERE organization_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
          AND expires_at > now()
        ORDER BY created_at`,
      [organizationId],
    );
    return rows.map(invitation);
  }

  async revokeInvitation(organizationId: string, id: string): Promise<boolean> {
    const { rows } = await this.sql.query<{ id: string }>(
      `UPDATE lw_invitations SET revoked_at = now()
        WHERE organization_id = $1 AND id = $2 AND accepted_at IS NULL AND revoked_at IS NULL
        RETURNING id`,
      [organizationId, id],
    );
    return rows.length > 0;
  }

  async acceptInvitations(email: string, subject: string): Promise<Invitation[]> {
    const { rows } = await this.sql.query<InvitationRow>(
      `WITH acc AS (
         UPDATE lw_invitations SET accepted_at = now(), accepted_by = $2
          WHERE email = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
          RETURNING ${INVITATION_COLUMNS}
       ), joined AS (
         INSERT INTO lw_memberships (organization_id, subject, role, added_by, label)
         SELECT organization_id, $2, role, invited_by, email FROM acc
         ON CONFLICT (organization_id, subject) DO UPDATE
           SET role = EXCLUDED.role, label = EXCLUDED.label
       )
       SELECT * FROM acc`,
      [normalEmail(email), subject],
    );
    return rows.map(invitation);
  }

  async removeMember(organizationId: string, subject: string): Promise<void> {
    await this.sql.query('DELETE FROM lw_memberships WHERE organization_id = $1 AND subject = $2', [
      organizationId,
      subject,
    ]);
  }

  async assignProject(projectId: string, organizationId: string): Promise<void> {
    const { rows } = await this.sql.query<{ organization_id: string }>(
      `WITH ins AS (
         INSERT INTO lw_project_organizations (project_id, organization_id) VALUES ($1, $2)
         ON CONFLICT (project_id) DO NOTHING RETURNING organization_id
       )
       SELECT organization_id FROM ins
       UNION ALL
       SELECT organization_id FROM lw_project_organizations WHERE project_id = $1`,
      [projectId, organizationId],
    );
    const owner = rows[0]?.organization_id;
    if (owner !== organizationId)
      throw new OrganizationError(`Project ${projectId} belongs to another organization.`);
    this.owners.set(projectId, owner);
  }

  async ownersOf(projectIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const unknown: string[] = [];
    for (const id of new Set(projectIds)) {
      const o = this.owners.get(id);
      if (o) out.set(id, o);
      else unknown.push(id);
    }
    if (unknown.length) {
      const { rows } = await this.sql.query<{ project_id: string; organization_id: string }>(
        `SELECT project_id, organization_id FROM lw_project_organizations
          WHERE project_id = ANY($1::text[])`,
        [unknown],
      );
      for (const r of rows) {
        this.owners.set(r.project_id, r.organization_id);
        out.set(r.project_id, r.organization_id);
      }
      // Not cached: a project could still be assigned (by the process that is creating it).
      for (const id of unknown) if (!out.has(id)) out.set(id, DEFAULT_ORGANIZATION);
    }
    return out;
  }
}

/** In memory: tests and local runs on the memory store. Starts with organization #1. */
export class MemoryOrganizationStore implements OrganizationStore {
  private readonly orgs = new Map<string, Organization>();
  private readonly memberships = new Map<string, Membership>();
  private readonly owners = new Map<string, string>();
  private readonly invites = new Map<string, Invitation & { closed: boolean }>();

  constructor(private readonly now: () => Date = () => new Date()) {
    this.orgs.set(DEFAULT_ORGANIZATION, {
      id: DEFAULT_ORGANIZATION,
      name: 'Icreon',
      slug: 'icreon',
      createdAt: new Date(0).toISOString(),
    });
  }

  async list(): Promise<Organization[]> {
    return [...this.orgs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async get(id: string): Promise<Organization | null> {
    return this.orgs.get(id) ?? null;
  }

  async create(input: { name: string; slug: string; id?: string }): Promise<Organization> {
    checkSlug(input.slug);
    const id = input.id ?? `org-${randomUUID().slice(0, 8)}`;
    if (this.orgs.has(id) || [...this.orgs.values()].some((o) => o.slug === input.slug))
      throw new OrganizationError(`An organization "${input.slug}" already exists.`);
    const o = {
      id,
      name: input.name.trim(),
      slug: input.slug,
      createdAt: this.now().toISOString(),
    };
    this.orgs.set(id, o);
    return o;
  }

  async membershipsOf(subject: string) {
    const orgs = await this.list();
    return orgs.flatMap((o) => {
      const m = this.memberships.get(`${o.id}\n${subject}`);
      return m ? [{ ...m, organization: o }] : [];
    });
  }

  async members(organizationId: string): Promise<Membership[]> {
    return [...this.memberships.values()].filter((m) => m.organizationId === organizationId);
  }

  async setMember(
    organizationId: string,
    subject: string,
    role: MemberRole,
    addedBy: string,
    label?: string,
  ) {
    checkRole(role);
    if (!this.orgs.has(organizationId))
      throw new OrganizationError(`No organization "${organizationId}".`);
    const key = `${organizationId}\n${subject}`;
    const was = this.memberships.get(key);
    this.memberships.set(key, {
      organizationId,
      subject,
      role,
      addedBy: was?.addedBy ?? addedBy,
      createdAt: was?.createdAt ?? this.now().toISOString(),
      label: label ?? was?.label ?? null,
    });
  }

  private open(i: Invitation & { closed: boolean }) {
    return !i.closed && i.expiresAt > this.now().toISOString();
  }

  async invite(input: {
    organizationId: string;
    email: string;
    role: MemberRole;
    invitedBy: string;
    expiresAt: Date;
  }): Promise<Invitation> {
    checkRole(input.role);
    if (!this.orgs.has(input.organizationId))
      throw new OrganizationError(`No organization "${input.organizationId}".`);
    const email = normalEmail(input.email);
    for (const i of this.invites.values())
      if (i.organizationId === input.organizationId && i.email === email) i.closed = true;
    const inv: Invitation = {
      id: `inv-${randomUUID().slice(0, 12)}`,
      organizationId: input.organizationId,
      email,
      role: input.role,
      invitedBy: input.invitedBy,
      createdAt: this.now().toISOString(),
      expiresAt: input.expiresAt.toISOString(),
    };
    this.invites.set(inv.id, { ...inv, closed: false });
    return inv;
  }

  async invitations(organizationId: string): Promise<Invitation[]> {
    return [...this.invites.values()]
      .filter((i) => i.organizationId === organizationId && this.open(i))
      .map(({ closed: _, ...i }) => i);
  }

  async revokeInvitation(organizationId: string, id: string): Promise<boolean> {
    const i = this.invites.get(id);
    if (!i || i.organizationId !== organizationId || i.closed) return false;
    i.closed = true;
    return true;
  }

  async acceptInvitations(email: string, subject: string): Promise<Invitation[]> {
    const e = normalEmail(email);
    const accepted: Invitation[] = [];
    for (const i of this.invites.values()) {
      if (i.email !== e || !this.open(i)) continue;
      i.closed = true;
      await this.setMember(i.organizationId, subject, i.role, i.invitedBy, e);
      const { closed: _, ...inv } = i;
      accepted.push(inv);
    }
    return accepted;
  }

  async removeMember(organizationId: string, subject: string): Promise<void> {
    this.memberships.delete(`${organizationId}\n${subject}`);
  }

  async assignProject(projectId: string, organizationId: string): Promise<void> {
    if (!this.orgs.has(organizationId))
      throw new OrganizationError(`No organization "${organizationId}".`);
    const owner = this.owners.get(projectId);
    if (owner && owner !== organizationId)
      throw new OrganizationError(`Project ${projectId} belongs to another organization.`);
    this.owners.set(projectId, organizationId);
  }

  async ownersOf(projectIds: string[]): Promise<Map<string, string>> {
    return new Map(projectIds.map((id) => [id, this.owners.get(id) ?? DEFAULT_ORGANIZATION]));
  }
}
