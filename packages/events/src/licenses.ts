import type { SqlClient } from './postgres';

/** What an organization may run, and for how long. */
export interface License {
  organizationId: string;
  /** Platform ids: 'sitecoreai', 'optimizely'. */
  entities: string[];
  /** Playbook ids. */
  playbooks: string[];
  /** Projects that may exist at once; a deleted one frees its place. */
  projectsIncluded: number;
  startsAt: string;
  endsAt: string;
  /** The term ended and these projects were paused; a renewal resumes them. */
  suspended: { at: string; projects: string[] } | null;
  /** When its data was purged, after export closed; the license is kept as the record. */
  purgedAt: string | null;
  updatedAt: string;
  updatedBy: string;
}

export type LicenseTerms = Pick<
  License,
  'entities' | 'playbooks' | 'projectsIncluded' | 'startsAt' | 'endsAt'
>;

export interface LicenseChange {
  at: string;
  by: string;
  kind: 'granted' | 'changed' | 'suspended' | 'resumed' | 'purged';
  license: LicenseTerms & { suspended: License['suspended'] };
}

export interface LicenseStore {
  get(organizationId: string): Promise<License | null>;
  list(): Promise<License[]>;
  /** Grants or changes the terms (a suspension stays until `suspend`/`resume` changes it). */
  set(organizationId: string, terms: LicenseTerms, by: string): Promise<License>;
  /** Records the projects the end of the term paused, or clears them (`null`) on renewal. */
  setSuspended(
    organizationId: string,
    suspended: License['suspended'],
    by: string,
  ): Promise<License | null>;
  /** Records that the organization's data is gone (export closed, every project purged). */
  setPurged(organizationId: string, by: string): Promise<License | null>;
  /** Every change, oldest first. */
  history(organizationId: string): Promise<LicenseChange[]>;
}

export class LicenseError extends Error {}

/** Terms that make sense: an end after the start, ids without blanks, a count of zero or more. */
export function checkTerms(t: LicenseTerms): LicenseTerms {
  const start = Date.parse(t.startsAt);
  const end = Date.parse(t.endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end))
    throw new LicenseError('The term needs a start and an end date.');
  if (end <= start) throw new LicenseError('The term must end after it starts.');
  if (!Number.isInteger(t.projectsIncluded) || t.projectsIncluded < 0)
    throw new LicenseError('Projects included is a whole number, zero or more.');
  const ids = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
  return {
    entities: ids(t.entities),
    playbooks: ids(t.playbooks),
    projectsIncluded: t.projectsIncluded,
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(end).toISOString(),
  };
}

const terms = (l: License) => ({
  entities: l.entities,
  playbooks: l.playbooks,
  projectsIncluded: l.projectsIncluded,
  startsAt: l.startsAt,
  endsAt: l.endsAt,
  suspended: l.suspended,
});

interface Row {
  organization_id: string;
  entities: string[];
  playbooks: string[];
  projects_included: number;
  starts_at: string | Date;
  ends_at: string | Date;
  suspended: License['suspended'];
  purged_at?: string | Date | null;
  updated_at: string | Date;
  updated_by: string;
}
const iso = (t: string | Date) => new Date(t).toISOString();
const view = (r: Row): License => ({
  organizationId: r.organization_id,
  entities: r.entities ?? [],
  playbooks: r.playbooks ?? [],
  projectsIncluded: Number(r.projects_included),
  startsAt: iso(r.starts_at),
  endsAt: iso(r.ends_at),
  suspended: r.suspended ?? null,
  purgedAt: r.purged_at ? iso(r.purged_at) : null,
  updatedAt: iso(r.updated_at),
  updatedBy: r.updated_by,
});
const COLUMNS =
  'organization_id, entities, playbooks, projects_included, starts_at, ends_at, suspended, purged_at, updated_at, updated_by';

export class PostgresLicenseStore implements LicenseStore {
  constructor(private readonly sql: SqlClient) {}

  async get(organizationId: string): Promise<License | null> {
    const { rows } = await this.sql.query<Row>(
      `SELECT ${COLUMNS} FROM lw_licenses WHERE organization_id = $1`,
      [organizationId],
    );
    return rows[0] ? view(rows[0]) : null;
  }

  async list(): Promise<License[]> {
    const { rows } = await this.sql.query<Row>(`SELECT ${COLUMNS} FROM lw_licenses`);
    return rows.map(view);
  }

  async set(organizationId: string, input: LicenseTerms, by: string): Promise<License> {
    const t = checkTerms(input);
    const had = await this.get(organizationId);
    const { rows } = await this.sql.query<Row>(
      `INSERT INTO lw_licenses
         (organization_id, entities, playbooks, projects_included, starts_at, ends_at, updated_by)
       VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, $6, $7)
       ON CONFLICT (organization_id) DO UPDATE SET
         entities = EXCLUDED.entities, playbooks = EXCLUDED.playbooks,
         projects_included = EXCLUDED.projects_included, starts_at = EXCLUDED.starts_at,
         ends_at = EXCLUDED.ends_at, purged_at = NULL, updated_at = now(),
         updated_by = EXCLUDED.updated_by
       RETURNING ${COLUMNS}`,
      [
        organizationId,
        JSON.stringify(t.entities),
        JSON.stringify(t.playbooks),
        t.projectsIncluded,
        t.startsAt,
        t.endsAt,
        by,
      ],
    );
    const l = view(rows[0]!);
    await this.record(organizationId, by, had ? 'changed' : 'granted', l);
    return l;
  }

  async setSuspended(
    organizationId: string,
    suspended: License['suspended'],
    by: string,
  ): Promise<License | null> {
    const { rows } = await this.sql.query<Row>(
      `UPDATE lw_licenses SET suspended = $2::jsonb, updated_at = now(), updated_by = $3
        WHERE organization_id = $1 RETURNING ${COLUMNS}`,
      [organizationId, suspended ? JSON.stringify(suspended) : null, by],
    );
    if (!rows[0]) return null;
    const l = view(rows[0]);
    await this.record(organizationId, by, suspended ? 'suspended' : 'resumed', l);
    return l;
  }

  async setPurged(organizationId: string, by: string): Promise<License | null> {
    const { rows } = await this.sql.query<Row>(
      `UPDATE lw_licenses SET purged_at = now(), updated_at = now(), updated_by = $2
        WHERE organization_id = $1 RETURNING ${COLUMNS}`,
      [organizationId, by],
    );
    if (!rows[0]) return null;
    const l = view(rows[0]);
    await this.record(organizationId, by, 'purged', l);
    return l;
  }

  async history(organizationId: string): Promise<LicenseChange[]> {
    const { rows } = await this.sql.query<{
      at: string | Date;
      by: string;
      kind: LicenseChange['kind'];
      license: LicenseChange['license'];
    }>(
      `SELECT at, by, kind, license FROM lw_license_changes
        WHERE organization_id = $1 ORDER BY at, id`,
      [organizationId],
    );
    return rows.map((r) => ({ ...r, at: iso(r.at) }));
  }

  private async record(organizationId: string, by: string, kind: string, l: License) {
    await this.sql.query(
      `INSERT INTO lw_license_changes (organization_id, by, kind, license)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [organizationId, by, kind, JSON.stringify(terms(l))],
    );
  }
}

/** In memory: tests and local runs on the memory store. */
export class MemoryLicenseStore implements LicenseStore {
  private readonly licenses = new Map<string, License>();
  private readonly changes = new Map<string, LicenseChange[]>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async get(organizationId: string): Promise<License | null> {
    return this.licenses.get(organizationId) ?? null;
  }

  async list(): Promise<License[]> {
    return [...this.licenses.values()];
  }

  async set(organizationId: string, input: LicenseTerms, by: string): Promise<License> {
    const t = checkTerms(input);
    const had = this.licenses.get(organizationId);
    const l: License = {
      organizationId,
      ...t,
      suspended: had?.suspended ?? null,
      // A renewal after a purge starts the organization again.
      purgedAt: null,
      updatedAt: this.now().toISOString(),
      updatedBy: by,
    };
    this.licenses.set(organizationId, l);
    this.record(organizationId, by, had ? 'changed' : 'granted', l);
    return l;
  }

  async setSuspended(
    organizationId: string,
    suspended: License['suspended'],
    by: string,
  ): Promise<License | null> {
    const had = this.licenses.get(organizationId);
    if (!had) return null;
    const l = { ...had, suspended, updatedAt: this.now().toISOString(), updatedBy: by };
    this.licenses.set(organizationId, l);
    this.record(organizationId, by, suspended ? 'suspended' : 'resumed', l);
    return l;
  }

  async setPurged(organizationId: string, by: string): Promise<License | null> {
    const had = this.licenses.get(organizationId);
    if (!had) return null;
    const l = {
      ...had,
      purgedAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      updatedBy: by,
    };
    this.licenses.set(organizationId, l);
    this.record(organizationId, by, 'purged', l);
    return l;
  }

  async history(organizationId: string): Promise<LicenseChange[]> {
    return this.changes.get(organizationId) ?? [];
  }

  private record(organizationId: string, by: string, kind: LicenseChange['kind'], l: License) {
    const list = this.changes.get(organizationId) ?? [];
    list.push({ at: this.now().toISOString(), by, kind, license: terms(l) });
    this.changes.set(organizationId, list);
  }
}
