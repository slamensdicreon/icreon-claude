import type { SqlClient } from './postgres';

/** A purge step's record: when it finished and what it removed. */
export interface TombstoneStep {
  at: string;
  result: Record<string, unknown>;
}

/** What is left of a deleted project, and how far its purge got. */
export interface Tombstone {
  projectId: string;
  name: string;
  client: string;
  requestedBy: string;
  requestedAt: string;
  startedAt: string;
  /** Null while the purge is under way (or was cut off). */
  finishedAt: string | null;
  purgedBy: string | null;
  steps: Record<string, TombstoneStep>;
}

export type TombstoneStart = Pick<
  Tombstone,
  'projectId' | 'name' | 'client' | 'requestedBy' | 'requestedAt'
>;

/** Deletion records: written when a purge starts, finished when it ends, kept for good. */
export interface TombstoneStore {
  get(projectId: string): Promise<Tombstone | null>;
  /** Starts a purge's record, or returns the one a cut-off purge left. */
  begin(start: TombstoneStart): Promise<Tombstone>;
  step(projectId: string, step: string, result: Record<string, unknown>): Promise<void>;
  finish(projectId: string, purgedBy: string): Promise<void>;
  list(): Promise<Tombstone[]>;
}

interface Row {
  project_id: string;
  name: string;
  client: string;
  requested_by: string;
  requested_at: string | Date;
  started_at: string | Date;
  finished_at: string | Date | null;
  purged_by: string | null;
  steps: Record<string, TombstoneStep>;
}

const iso = (t: string | Date) => new Date(t).toISOString();
const view = (r: Row): Tombstone => ({
  projectId: r.project_id,
  name: r.name,
  client: r.client,
  requestedBy: r.requested_by,
  requestedAt: iso(r.requested_at),
  startedAt: iso(r.started_at),
  finishedAt: r.finished_at ? iso(r.finished_at) : null,
  purgedBy: r.purged_by,
  steps: r.steps ?? {},
});

export class PostgresTombstoneStore implements TombstoneStore {
  constructor(private readonly sql: SqlClient) {}

  async get(projectId: string): Promise<Tombstone | null> {
    const { rows } = await this.sql.query<Row>(
      'SELECT * FROM lw_project_tombstones WHERE project_id = $1',
      [projectId],
    );
    return rows[0] ? view(rows[0]) : null;
  }

  async begin(t: TombstoneStart): Promise<Tombstone> {
    await this.sql.query(
      `INSERT INTO lw_project_tombstones (project_id, name, client, requested_by, requested_at)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (project_id) DO NOTHING`,
      [t.projectId, t.name, t.client, t.requestedBy, t.requestedAt],
    );
    return (await this.get(t.projectId))!;
  }

  async step(projectId: string, step: string, result: Record<string, unknown>): Promise<void> {
    await this.sql.query(
      `UPDATE lw_project_tombstones SET steps = steps || jsonb_build_object($2::text, $3::jsonb)
        WHERE project_id = $1`,
      [projectId, step, JSON.stringify({ at: new Date().toISOString(), result })],
    );
  }

  async finish(projectId: string, purgedBy: string): Promise<void> {
    await this.sql.query(
      'UPDATE lw_project_tombstones SET finished_at = now(), purged_by = $2 WHERE project_id = $1',
      [projectId, purgedBy],
    );
  }

  async list(): Promise<Tombstone[]> {
    const { rows } = await this.sql.query<Row>(
      'SELECT * FROM lw_project_tombstones ORDER BY started_at DESC',
    );
    return rows.map(view);
  }
}

/** In memory: tests, and local runs on the memory store. */
export class MemoryTombstoneStore implements TombstoneStore {
  private readonly rows = new Map<string, Tombstone>();

  async get(projectId: string): Promise<Tombstone | null> {
    const t = this.rows.get(projectId);
    return t ? structuredClone(t) : null;
  }

  async begin(t: TombstoneStart): Promise<Tombstone> {
    if (!this.rows.has(t.projectId))
      this.rows.set(t.projectId, {
        ...t,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        purgedBy: null,
        steps: {},
      });
    return (await this.get(t.projectId))!;
  }

  async step(projectId: string, step: string, result: Record<string, unknown>): Promise<void> {
    const t = this.rows.get(projectId);
    if (t) t.steps[step] = { at: new Date().toISOString(), result };
  }

  async finish(projectId: string, purgedBy: string): Promise<void> {
    const t = this.rows.get(projectId);
    if (t) Object.assign(t, { finishedAt: new Date().toISOString(), purgedBy });
  }

  async list(): Promise<Tombstone[]> {
    return [...this.rows.values()].reverse().map((t) => structuredClone(t));
  }
}
