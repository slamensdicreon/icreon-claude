import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { LwEvent, type NewEvent } from '@lw/contracts';
import { systemClock, type Clock, type EventStore, type Listener, type ReadOptions } from './store';

/** The slice of a Postgres client the store needs. `pg.Pool` and PGlite both fit. */
export interface SqlClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** LISTEN for one channel; resolves to an unlisten function. */
export type Listen = (
  channel: string,
  onPayload: (payload: string) => void,
) => Promise<() => Promise<void>>;

const CHANNEL = 'lw_events';
const MIGRATIONS = ['001_event_log.sql', '002_commands.sql'];

/**
 * Applies the migrations. They are idempotent, so this runs on every start. Multi-statement SQL
 * goes through `exec` where the client has one (PGlite); node-postgres runs it via `query`.
 */
export async function migrate(
  sql: SqlClient & {
    exec?(text: string): Promise<unknown>;
    connect?(): Promise<SqlClient & { release(): void }>;
  },
): Promise<void> {
  const texts = await Promise.all(
    MIGRATIONS.map((file) => readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8')),
  );
  if (!sql.connect) {
    for (const text of texts) await (sql.exec ? sql.exec(text) : sql.query(text));
    return;
  }
  // A shared database: processes that start together (cold-starting API instances) take turns,
  // because concurrent CREATE ... IF NOT EXISTS and CREATE OR REPLACE can still collide.
  const client = await sql.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('launchworks.migrate'))`);
    for (const text of texts) await client.query(text);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

interface Row {
  project_id: string;
  seq: number;
  id: string;
  ts: Date | string;
  type: string;
  severity: string;
  actor: unknown;
  subject: unknown;
  data: unknown;
}

const toEvent = (r: Row): LwEvent =>
  ({
    id: r.id,
    projectId: r.project_id,
    seq: Number(r.seq),
    ts: new Date(r.ts).toISOString(),
    type: r.type,
    severity: r.severity,
    actor: r.actor,
    subject: r.subject,
    data: r.data,
  }) as LwEvent;

/**
 * Event store on Postgres. Appends allocate seqs atomically in a single statement; subscribers in
 * any process receive events in seq order through LISTEN/NOTIFY, read back from the table so a
 * missed or coalesced notification never loses an event.
 */
export class PostgresEventStore implements EventStore {
  private readonly listeners = new Set<Listener>();
  /** Last seq delivered to listeners, per project. */
  private readonly cursors = new Map<string, number>();
  private readonly chains = new Map<string, Promise<void>>();
  private unlisten: (() => Promise<void>) | null = null;

  private constructor(
    private readonly sql: SqlClient,
    private readonly clock: Clock,
  ) {}

  /** Connects the live tail. Call `close()` to stop listening. */
  static async connect(sql: SqlClient, listen: Listen, clock: Clock = systemClock) {
    const store = new PostgresEventStore(sql, clock);
    // Listen first, then take the heads: nothing appended in between can be missed. Listeners
    // only see events appended after they subscribe, as with the in-memory store.
    store.unlisten = await listen(CHANNEL, (payload) => store.onNotify(payload));
    const heads = await sql.query<{ project_id: string; head: number }>(
      'SELECT project_id, head FROM lw_project_heads',
    );
    for (const h of heads.rows) {
      store.cursors.set(
        h.project_id,
        Math.max(store.cursors.get(h.project_id) ?? 0, Number(h.head)),
      );
    }
    return store;
  }

  async close(): Promise<void> {
    await this.unlisten?.();
    await Promise.all(this.chains.values());
  }

  async append(projectId: string, events: NewEvent[]): Promise<LwEvent[]> {
    if (!events.length) return [];
    const ts = this.clock.now().toISOString();
    // Validate the whole batch against the contract before touching the database.
    const validated = events.map(({ at, ...e }, i) =>
      LwEvent.parse({ ...e, id: randomUUID(), projectId, seq: i + 1, ts: at ?? ts }),
    ) as LwEvent[];
    const records = validated.map((e, i) => ({
      ord: i + 1,
      ts: e.ts,
      id: e.id,
      type: e.type,
      severity: e.severity,
      actor: e.actor,
      subject: e.subject,
      data: e.data,
    }));
    const { rows } = await this.sql.query<{ seq: number }>(
      `WITH h AS (
         INSERT INTO lw_project_heads (project_id, head) VALUES ($1, $2)
         ON CONFLICT (project_id) DO UPDATE SET head = lw_project_heads.head + EXCLUDED.head
         RETURNING head
       )
       INSERT INTO lw_events (project_id, seq, id, ts, type, severity, actor, subject, data)
       SELECT $1, (SELECT head FROM h) - $2 + e.ord, e.id, e.ts, e.type, e.severity,
              e.actor, e.subject, e.data
         FROM jsonb_to_recordset($3::jsonb)
           AS e(ord int, ts timestamptz, id uuid, type text, severity text, actor jsonb,
                subject jsonb, data jsonb)
       RETURNING seq`,
      [projectId, records.length, JSON.stringify(records)],
    );
    const seqs = rows.map((r) => Number(r.seq)).sort((a, b) => a - b);
    return validated.map((e, i) => ({ ...e, seq: seqs[i]! }));
  }

  async read(projectId: string, opts: ReadOptions = {}): Promise<LwEvent[]> {
    const { after = 0, before = 2_147_483_647, limit, order = 'asc' } = opts;
    const { rows } = await this.sql.query<Row>(
      `SELECT project_id, seq, id, ts, type, severity, actor, subject, data
         FROM lw_events
        WHERE project_id = $1 AND seq > $2 AND seq < $3
        ORDER BY seq ${order === 'asc' ? 'ASC' : 'DESC'}
        ${limit !== undefined && Number.isFinite(limit) ? 'LIMIT $4' : ''}`,
      limit !== undefined && Number.isFinite(limit)
        ? [projectId, after, Math.min(before, 2_147_483_647), limit]
        : [projectId, after, Math.min(before, 2_147_483_647)],
    );
    return rows.map(toEvent);
  }

  async head(projectId: string): Promise<number> {
    const { rows } = await this.sql.query<{ head: number }>(
      'SELECT head FROM lw_project_heads WHERE project_id = $1',
      [projectId],
    );
    return Number(rows[0]?.head ?? 0);
  }

  async projectIds(): Promise<string[]> {
    const { rows } = await this.sql.query<{ project_id: string }>(
      'SELECT project_id FROM lw_project_heads ORDER BY project_id',
    );
    return rows.map((r) => r.project_id);
  }

  async reset(projectId: string): Promise<void> {
    await this.sql.query(
      `WITH gone AS (DELETE FROM lw_events WHERE project_id = $1)
       DELETE FROM lw_project_heads WHERE project_id = $1`,
      [projectId],
    );
    this.cursors.delete(projectId);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Delivers everything appended since the last notification seen, for every project. Call after
   * the LISTEN connection drops and comes back: notifications sent in between are gone.
   */
  async resync(): Promise<void> {
    const heads = await this.sql.query<{ project_id: string; head: number }>(
      'SELECT project_id, head FROM lw_project_heads',
    );
    this.onNotify(heads.rows.map((h) => `${h.project_id}:${Number(h.head)}`).join(','));
  }

  private onNotify(payload: string) {
    for (const part of payload.split(',')) {
      if (!part) continue;
      const i = part.lastIndexOf(':');
      const projectId = part.slice(0, i);
      const upTo = Number(part.slice(i + 1));
      // Deliver per project strictly in order: chain reads so they never overlap.
      const prev = this.chains.get(projectId) ?? Promise.resolve();
      const next = prev.then(() => this.deliver(projectId, upTo)).catch(() => {});
      this.chains.set(projectId, next);
    }
  }

  private async deliver(projectId: string, upTo: number) {
    let from = this.cursors.get(projectId) ?? 0;
    // A head below the cursor means the log was reset and is being written again from seq 1.
    if (upTo < from) from = 0;
    if (upTo <= from) return;
    const events = await this.read(projectId, { after: from, before: upTo + 1 });
    for (const e of events) {
      for (const l of this.listeners) l(e);
      this.cursors.set(projectId, e.seq);
    }
  }
}

/** Adapters for the two clients we use: node-postgres in services, PGlite in tests and local dev. */
export const listenWithPglite =
  (db: {
    listen(channel: string, cb: (payload: string) => void): Promise<() => Promise<void>>;
  }): Listen =>
  (channel, cb) =>
    db.listen(channel, cb);

export const listenWithPg =
  (client: {
    query(text: string): Promise<unknown>;
    on(event: 'notification', cb: (msg: { channel: string; payload?: string }) => void): unknown;
  }): Listen =>
  async (channel, cb) => {
    client.on('notification', (msg) => {
      if (msg.channel === channel && msg.payload) cb(msg.payload);
    });
    await client.query(`LISTEN ${channel}`);
    return async () => void (await client.query(`UNLISTEN ${channel}`));
  };
