import type { SqlClient } from '@lw/events';

export type ImportStatus = 'running' | 'paused' | 'done' | 'stopped' | 'failed' | 'reverted';
export type PageState = 'queued' | 'inflight' | 'done' | 'exception' | 'failed' | 'reverted';

export interface ImportStats {
  /** Pages written, read back. */
  written: number;
  /** Images uploaded to the media library. */
  uploads: number;
  /** When pages started being written (after the preflight), ISO. */
  writingSince: string | null;
  /**
   * The first pages, written and checked before the rest: null until they are, then whether they
   * passed and what the checks said.
   */
  canary?: { passed: boolean | null; detail?: string } | null;
}

export interface ImportJob {
  id: string;
  projectId: string;
  /** The agent task that started it: its writes go through the gateway as that task. */
  taskId: string;
  /** The page-templates item's key. */
  template: string;
  crawlId: string;
  status: ImportStatus;
  /** What the preflight read from the example page: what every page is built from. */
  plan: unknown;
  stats: ImportStats;
  message: string | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface ImportPage {
  seq: number;
  url: string;
  path: string;
  state: PageState;
  itemId: string | null;
  /** The import made the page item, so a revert may remove it. */
  created: boolean;
  reason: string | null;
  attempts: number;
}

export const emptyImportStats = (): ImportStats => ({ written: 0, uploads: 0, writingSince: null });

export interface ImportStore {
  create(job: ImportJob): Promise<void>;
  get(id: string): Promise<ImportJob | null>;
  latest(projectId: string, template: string): Promise<ImportJob | null>;
  running(): Promise<ImportJob[]>;
  update(
    id: string,
    patch: Partial<Pick<ImportJob, 'status' | 'stats' | 'message' | 'finishedAt' | 'plan'>>,
  ): Promise<void>;
  lease(id: string, owner: string, ms: number): Promise<boolean>;
  release(id: string, owner: string): Promise<void>;
  enqueue(id: string, pages: { url: string; path: string }[]): Promise<number>;
  claim(id: string, n: number): Promise<ImportPage[]>;
  /** In-flight pages back to queued, and with `states`, those too (a retry of exceptions). */
  requeue(id: string, states?: PageState[]): Promise<number>;
  finish(
    id: string,
    url: string,
    o: {
      state: Exclude<PageState, 'inflight'>;
      itemId?: string | null;
      created?: boolean;
      reason?: string | null;
      attempts?: number;
    },
  ): Promise<void>;
  counts(id: string): Promise<Record<PageState, number>>;
  pages(
    id: string,
    f?: { states?: PageState[]; limit?: number; offset?: number },
  ): Promise<ImportPage[]>;
}

export const emptyCounts = (): Record<PageState, number> => ({
  queued: 0,
  inflight: 0,
  done: 0,
  exception: 0,
  failed: 0,
  reverted: 0,
});

/** For tests and single-process runs: lost on restart. */
export class MemoryImportStore implements ImportStore {
  private readonly jobs = new Map<string, ImportJob>();
  private readonly leases = new Map<string, { owner: string; until: number }>();
  private readonly rows = new Map<string, Map<string, ImportPage>>();
  private seq = 0;

  async create(job: ImportJob) {
    this.jobs.set(job.id, structuredClone(job));
    this.rows.set(job.id, new Map());
  }
  async get(id: string) {
    const j = this.jobs.get(id);
    return j ? structuredClone(j) : null;
  }
  async latest(projectId: string, template: string) {
    const all = [...this.jobs.values()]
      .filter((j) => j.projectId === projectId && j.template === template)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return all[0] ? structuredClone(all[0]) : null;
  }
  async running() {
    return [...this.jobs.values()]
      .filter((j) => j.status === 'running')
      .map((j) => structuredClone(j));
  }
  async update(id: string, patch: Parameters<ImportStore['update']>[1]) {
    const j = this.jobs.get(id);
    if (j) Object.assign(j, structuredClone(patch), { updatedAt: new Date().toISOString() });
  }
  async lease(id: string, owner: string, ms: number) {
    const l = this.leases.get(id);
    if (l && l.owner !== owner && l.until > Date.now()) return false;
    this.leases.set(id, { owner, until: Date.now() + ms });
    return true;
  }
  async release(id: string, owner: string) {
    if (this.leases.get(id)?.owner === owner) this.leases.delete(id);
  }
  async enqueue(id: string, pages: { url: string; path: string }[]) {
    const rows = this.rows.get(id)!;
    let n = 0;
    for (const p of pages) {
      if (rows.has(p.url)) continue;
      rows.set(p.url, {
        ...p,
        seq: ++this.seq,
        state: 'queued',
        itemId: null,
        created: false,
        reason: null,
        attempts: 0,
      });
      n++;
    }
    return n;
  }
  async claim(id: string, n: number) {
    const out: ImportPage[] = [];
    for (const r of [...this.rows.get(id)!.values()].sort((a, b) => a.seq - b.seq)) {
      if (out.length >= n) break;
      if (r.state !== 'queued') continue;
      r.state = 'inflight';
      out.push({ ...r });
    }
    return out;
  }
  async requeue(id: string, states: PageState[] = []) {
    let n = 0;
    for (const r of this.rows.get(id)?.values() ?? [])
      if (r.state === 'inflight' || states.includes(r.state)) {
        r.state = 'queued';
        n++;
      }
    return n;
  }
  async finish(id: string, url: string, o: Parameters<ImportStore['finish']>[2]) {
    const r = this.rows.get(id)?.get(url);
    if (!r) return;
    r.state = o.state;
    r.reason = o.reason ?? null;
    if (o.itemId !== undefined) r.itemId = o.itemId;
    if (o.created) r.created = true;
    if (o.attempts !== undefined) r.attempts = o.attempts;
  }
  async counts(id: string) {
    const c = emptyCounts();
    for (const r of this.rows.get(id)?.values() ?? []) c[r.state]++;
    return c;
  }
  async pages(id: string, f: { states?: PageState[]; limit?: number; offset?: number } = {}) {
    const list = [...(this.rows.get(id)?.values() ?? [])]
      .filter((r) => !f.states || f.states.includes(r.state))
      .sort((a, b) => a.seq - b.seq);
    const start = f.offset ?? 0;
    return list
      .slice(start, f.limit === undefined ? undefined : start + f.limit)
      .map((r) => ({ ...r }));
  }
}

interface JobRow {
  id: string;
  project_id: string;
  task_id: string;
  template: string;
  crawl_id: string;
  status: ImportStatus;
  plan: unknown;
  stats: ImportStats;
  message: string | null;
  started_at: Date | string;
  updated_at: Date | string;
  finished_at: Date | string | null;
}

interface PageRow {
  seq: string | number;
  url: string;
  path: string;
  state: PageState;
  item_id: string | null;
  created: boolean;
  reason: string | null;
  attempts: number;
}

const iso = (v: Date | string | null) =>
  v === null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();
const job = (r: JobRow): ImportJob => ({
  id: r.id,
  projectId: r.project_id,
  taskId: r.task_id,
  template: r.template,
  crawlId: r.crawl_id,
  status: r.status,
  plan: r.plan,
  stats: r.stats,
  message: r.message,
  startedAt: iso(r.started_at)!,
  updatedAt: iso(r.updated_at)!,
  finishedAt: iso(r.finished_at),
});
const page = (r: PageRow): ImportPage => ({
  seq: Number(r.seq),
  url: r.url,
  path: r.path,
  state: r.state,
  itemId: r.item_id,
  created: r.created,
  reason: r.reason,
  attempts: r.attempts,
});
const PAGE_COLS = 'seq, url, path, state, item_id, created, reason, attempts';

/** Imports in the shared database (migration 008_imports.sql). */
export class PostgresImportStore implements ImportStore {
  constructor(private readonly sql: SqlClient) {}

  async create(j: ImportJob) {
    await this.sql.query(
      `INSERT INTO lw_imports (id, project_id, task_id, template, crawl_id, status, plan, stats,
         message, started_at, updated_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12)`,
      [
        j.id,
        j.projectId,
        j.taskId,
        j.template,
        j.crawlId,
        j.status,
        JSON.stringify(j.plan),
        JSON.stringify(j.stats),
        j.message,
        j.startedAt,
        j.updatedAt,
        j.finishedAt,
      ],
    );
  }
  async get(id: string) {
    const { rows } = await this.sql.query<JobRow>('SELECT * FROM lw_imports WHERE id = $1', [id]);
    return rows[0] ? job(rows[0]) : null;
  }
  async latest(projectId: string, template: string) {
    const { rows } = await this.sql.query<JobRow>(
      `SELECT * FROM lw_imports WHERE project_id = $1 AND template = $2
       ORDER BY started_at DESC LIMIT 1`,
      [projectId, template],
    );
    return rows[0] ? job(rows[0]) : null;
  }
  async running() {
    const { rows } = await this.sql.query<JobRow>(
      `SELECT * FROM lw_imports WHERE status = 'running' ORDER BY started_at`,
    );
    return rows.map(job);
  }
  async update(id: string, patch: Parameters<ImportStore['update']>[1]) {
    const cols: string[] = [];
    const args: unknown[] = [id];
    const set = (col: string, v: unknown, cast = '') => {
      args.push(v);
      cols.push(`${col} = $${args.length}${cast}`);
    };
    if (patch.status !== undefined) set('status', patch.status);
    if (patch.stats !== undefined) set('stats', JSON.stringify(patch.stats), '::jsonb');
    if (patch.message !== undefined) set('message', patch.message);
    if (patch.finishedAt !== undefined) set('finished_at', patch.finishedAt);
    if (patch.plan !== undefined) set('plan', JSON.stringify(patch.plan), '::jsonb');
    await this.sql.query(
      `UPDATE lw_imports SET ${[...cols, 'updated_at = now()'].join(', ')} WHERE id = $1`,
      args,
    );
  }
  async lease(id: string, owner: string, ms: number) {
    const { rows } = await this.sql.query(
      `UPDATE lw_imports SET lease_owner = $2,
         lease_until = now() + ($3::integer * interval '1 millisecond')
       WHERE id = $1 AND (lease_owner IS NULL OR lease_owner = $2 OR lease_until < now())
       RETURNING id`,
      [id, owner, Math.round(ms)],
    );
    return rows.length > 0;
  }
  async release(id: string, owner: string) {
    await this.sql.query(
      'UPDATE lw_imports SET lease_owner = NULL, lease_until = NULL WHERE id = $1 AND lease_owner = $2',
      [id, owner],
    );
  }
  async enqueue(id: string, pages: { url: string; path: string }[]) {
    let n = 0;
    for (let i = 0; i < pages.length; i += 1000) {
      const part = pages.slice(i, i + 1000);
      const { rows } = await this.sql.query(
        `INSERT INTO lw_import_pages (import_id, url, path, state)
         SELECT $1, u.url, u.path, 'queued'
         FROM unnest($2::text[], $3::text[]) WITH ORDINALITY AS u(url, path, n)
         ORDER BY u.n
         ON CONFLICT (import_id, url) DO NOTHING RETURNING url`,
        [id, part.map((p) => p.url), part.map((p) => p.path)],
      );
      n += rows.length;
    }
    return n;
  }
  async claim(id: string, n: number) {
    const { rows } = await this.sql.query<PageRow>(
      `WITH picked AS MATERIALIZED (
         SELECT url FROM lw_import_pages WHERE import_id = $1 AND state = 'queued'
         ORDER BY seq LIMIT $2 FOR UPDATE SKIP LOCKED)
       UPDATE lw_import_pages p SET state = 'inflight', updated_at = now()
       FROM picked WHERE p.import_id = $1 AND p.url = picked.url
       RETURNING p.seq, p.url, p.path, p.state, p.item_id, p.created, p.reason, p.attempts`,
      [id, n],
    );
    return rows.map(page).sort((a, b) => a.seq - b.seq);
  }
  async requeue(id: string, states: PageState[] = []) {
    const { rows } = await this.sql.query(
      `UPDATE lw_import_pages SET state = 'queued'
       WHERE import_id = $1 AND (state = 'inflight' OR state = ANY($2::text[])) RETURNING url`,
      [id, states],
    );
    return rows.length;
  }
  async finish(id: string, url: string, o: Parameters<ImportStore['finish']>[2]) {
    await this.sql.query(
      `UPDATE lw_import_pages SET state = $3, reason = $4, item_id = COALESCE($5, item_id),
         attempts = COALESCE($6, attempts), created = created OR $7, updated_at = now()
       WHERE import_id = $1 AND url = $2`,
      [
        id,
        url,
        o.state,
        o.reason ?? null,
        o.itemId ?? null,
        o.attempts ?? null,
        o.created === true,
      ],
    );
  }
  async counts(id: string) {
    const { rows } = await this.sql.query<{ state: PageState; n: string | number }>(
      'SELECT state, count(*) AS n FROM lw_import_pages WHERE import_id = $1 GROUP BY state',
      [id],
    );
    const c = emptyCounts();
    for (const r of rows) c[r.state] = Number(r.n);
    return c;
  }
  async pages(id: string, f: { states?: PageState[]; limit?: number; offset?: number } = {}) {
    const args: unknown[] = [id];
    let where = 'import_id = $1';
    if (f.states) {
      args.push(f.states);
      where += ` AND state = ANY($${args.length}::text[])`;
    }
    let tail = '';
    if (f.limit !== undefined) {
      args.push(f.limit);
      tail += ` LIMIT $${args.length}`;
    }
    if (f.offset) {
      args.push(f.offset);
      tail += ` OFFSET $${args.length}`;
    }
    const { rows } = await this.sql.query<PageRow>(
      `SELECT ${PAGE_COLS} FROM lw_import_pages WHERE ${where} ORDER BY seq${tail}`,
      args,
    );
    return rows.map(page);
  }
}
