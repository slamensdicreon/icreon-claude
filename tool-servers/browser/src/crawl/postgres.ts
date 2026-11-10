import {
  emptyCounts,
  summarize,
  type CrawlJob,
  type CrawlStore,
  type CrawlUrl,
  type NewUrl,
  type StoredPage,
  type UrlFilter,
  type UrlOutcome,
  type UrlState,
} from './store';

/** The slice of a Postgres client the store needs. `pg.Pool` and PGlite both fit. */
export interface SqlClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

interface JobRow {
  id: string;
  project_id: string;
  origin: string;
  start_url: string;
  status: CrawlJob['status'];
  options: CrawlJob['options'];
  stats: CrawlJob['stats'];
  sitemap_urls: number;
  message: string | null;
  started_at: Date | string;
  updated_at: Date | string;
  finished_at: Date | string | null;
}

interface UrlRow {
  url: string;
  state: UrlState;
  depth: number;
  source: CrawlUrl['source'];
  lastmod: string | null;
  attempts: number;
  reason: string | null;
  summary: CrawlUrl['summary'];
  seq?: string | number;
  page?: StoredPage | null;
}

const iso = (v: Date | string | null) =>
  v === null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();

const job = (r: JobRow): CrawlJob => ({
  id: r.id,
  projectId: r.project_id,
  origin: r.origin,
  startUrl: r.start_url,
  status: r.status,
  options: r.options,
  stats: r.stats,
  sitemapUrls: r.sitemap_urls,
  message: r.message,
  startedAt: iso(r.started_at)!,
  updatedAt: iso(r.updated_at)!,
  finishedAt: iso(r.finished_at),
});

const url = (r: UrlRow): CrawlUrl => ({
  url: r.url,
  state: r.state,
  depth: r.depth,
  source: r.source,
  lastmod: r.lastmod,
  attempts: r.attempts,
  reason: r.reason,
  summary: r.summary,
});

const URL_COLS = 'url, state, depth, source, lastmod, attempts, reason, summary';

/**
 * Crawls in the shared database (migration 008_crawls.sql), so every worker sees them, a crawl
 * outlives the process that started it, and several workers could share one crawl's queue (claims
 * use SKIP LOCKED).
 */
export class PostgresCrawlStore implements CrawlStore {
  constructor(private readonly sql: SqlClient) {}

  async create(j: CrawlJob) {
    await this.sql.query(
      `INSERT INTO lw_crawls (id, project_id, origin, start_url, status, options, stats,
         sitemap_urls, message, started_at, updated_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12)`,
      [
        j.id,
        j.projectId,
        j.origin,
        j.startUrl,
        j.status,
        JSON.stringify(j.options),
        JSON.stringify(j.stats),
        j.sitemapUrls,
        j.message,
        j.startedAt,
        j.updatedAt,
        j.finishedAt,
      ],
    );
  }

  async get(id: string) {
    const { rows } = await this.sql.query<JobRow>('SELECT * FROM lw_crawls WHERE id = $1', [id]);
    return rows[0] ? job(rows[0]) : null;
  }

  async latest(projectId: string, origin?: string) {
    const { rows } = await this.sql.query<JobRow>(
      `SELECT * FROM lw_crawls WHERE project_id = $1 ${origin ? 'AND origin = $2' : ''}
       ORDER BY started_at DESC LIMIT 1`,
      origin ? [projectId, origin] : [projectId],
    );
    return rows[0] ? job(rows[0]) : null;
  }

  async running() {
    const { rows } = await this.sql.query<JobRow>(
      `SELECT * FROM lw_crawls WHERE status = 'running' ORDER BY started_at`,
    );
    return rows.map(job);
  }

  async update(id: string, patch: Parameters<CrawlStore['update']>[1]) {
    const cols: string[] = [];
    const args: unknown[] = [id];
    const set = (col: string, v: unknown, cast = '') => {
      args.push(v);
      cols.push(`${col} = $${args.length}${cast}`);
    };
    if (patch.status !== undefined) set('status', patch.status);
    if (patch.stats !== undefined) set('stats', JSON.stringify(patch.stats), '::jsonb');
    if (patch.sitemapUrls !== undefined) set('sitemap_urls', patch.sitemapUrls);
    if (patch.message !== undefined) set('message', patch.message);
    if (patch.finishedAt !== undefined) set('finished_at', patch.finishedAt);
    if (patch.origin !== undefined) set('origin', patch.origin);
    if (patch.startUrl !== undefined) set('start_url', patch.startUrl);
    await this.sql.query(
      `UPDATE lw_crawls SET ${[...cols, 'updated_at = now()'].join(', ')} WHERE id = $1`,
      args,
    );
  }

  async lease(id: string, owner: string, ms: number) {
    const { rows } = await this.sql.query(
      `UPDATE lw_crawls SET lease_owner = $2,
         lease_until = now() + ($3::integer * interval '1 millisecond')
       WHERE id = $1 AND (lease_owner IS NULL OR lease_owner = $2 OR lease_until < now())
       RETURNING id`,
      [id, owner, Math.round(ms)],
    );
    return rows.length > 0;
  }

  async release(id: string, owner: string) {
    await this.sql.query(
      'UPDATE lw_crawls SET lease_owner = NULL, lease_until = NULL WHERE id = $1 AND lease_owner = $2',
      [id, owner],
    );
  }

  async enqueue(id: string, urls: NewUrl[]) {
    let added = 0;
    // In slices, so a 50,000-URL sitemap isn't one statement.
    for (let i = 0; i < urls.length; i += 1000) {
      const part = urls.slice(i, i + 1000);
      const { rows } = await this.sql.query(
        `INSERT INTO lw_crawl_urls (crawl_id, url, state, depth, source, lastmod)
         SELECT $1, u.url, 'queued', u.depth, u.source, u.lastmod
         FROM unnest($2::text[], $3::integer[], $4::text[], $5::text[])
           WITH ORDINALITY AS u(url, depth, source, lastmod, n)
         ORDER BY u.n
         ON CONFLICT (crawl_id, url) DO NOTHING RETURNING url`,
        [
          id,
          part.map((u) => u.url),
          part.map((u) => u.depth),
          part.map((u) => u.source),
          part.map((u) => u.lastmod),
        ],
      );
      added += rows.length;
    }
    return added;
  }

  async reuse(fromId: string, toId: string, entries: { url: string; lastmod: string }[]) {
    const out: string[] = [];
    for (let i = 0; i < entries.length; i += 1000) {
      const part = entries.slice(i, i + 1000);
      const { rows } = await this.sql.query<{ url: string }>(
        `INSERT INTO lw_crawl_urls (crawl_id, url, state, depth, source, lastmod, attempts, reason,
           summary, page)
         SELECT $2, p.url, 'done', p.depth, 'sitemap', p.lastmod, p.attempts, p.reason, p.summary,
           jsonb_set(p.page, '{via}', '"reused"')
         FROM lw_crawl_urls p
         JOIN unnest($3::text[], $4::text[]) AS e(url, lastmod)
           ON p.url = e.url AND p.lastmod = e.lastmod
         WHERE p.crawl_id = $1 AND p.state = 'done' AND p.page IS NOT NULL
         ON CONFLICT (crawl_id, url) DO NOTHING RETURNING url`,
        [fromId, toId, part.map((e) => e.url), part.map((e) => e.lastmod)],
      );
      out.push(...rows.map((r) => r.url));
    }
    return out;
  }

  async claim(id: string, n: number) {
    const { rows } = await this.sql.query<UrlRow>(
      `WITH picked AS MATERIALIZED (
         SELECT url FROM lw_crawl_urls WHERE crawl_id = $1 AND state = 'queued'
         ORDER BY seq LIMIT $2 FOR UPDATE SKIP LOCKED)
       UPDATE lw_crawl_urls u SET state = 'inflight', updated_at = now()
       FROM picked
       WHERE u.crawl_id = $1 AND u.url = picked.url
       RETURNING u.seq, u.url, u.state, u.depth, u.source, u.lastmod, u.attempts, u.reason, u.summary`,
      [id, n],
    );
    return rows.sort((a, b) => Number(a.seq) - Number(b.seq)).map(url);
  }

  async requeue(id: string) {
    const { rows } = await this.sql.query(
      `UPDATE lw_crawl_urls SET state = 'queued' WHERE crawl_id = $1 AND state = 'inflight'
       RETURNING url`,
      [id],
    );
    return rows.length;
  }

  async finish(id: string, u: string, o: UrlOutcome) {
    await this.sql.query(
      `UPDATE lw_crawl_urls SET state = $3, reason = $4, attempts = COALESCE($5, attempts),
         summary = COALESCE($6::jsonb, summary), page = COALESCE($7::jsonb, page),
         updated_at = now()
       WHERE crawl_id = $1 AND url = $2`,
      [
        id,
        u,
        o.state,
        o.reason ?? null,
        o.attempts ?? null,
        o.page ? JSON.stringify(summarize(o.page)) : null,
        o.page ? JSON.stringify(o.page) : null,
      ],
    );
  }

  async counts(id: string) {
    const { rows } = await this.sql.query<{ state: UrlState; n: string | number }>(
      'SELECT state, count(*) AS n FROM lw_crawl_urls WHERE crawl_id = $1 GROUP BY state',
      [id],
    );
    const c = emptyCounts();
    for (const r of rows) c[r.state] = Number(r.n);
    return c;
  }

  async urls(id: string, f: UrlFilter = {}) {
    const where = ['crawl_id = $1'];
    const args: unknown[] = [id];
    const add = (clause: string, v: unknown) => {
      args.push(v);
      where.push(clause.replace('?', `$${args.length}`));
    };
    if (f.states) add('state = ANY(?::text[])', f.states);
    if (f.prefix) add('starts_with(url, ?)', f.prefix);
    if (f.urls) add('url = ANY(?::text[])', f.urls);
    let tail = '';
    if (f.limit !== undefined) {
      args.push(f.limit);
      tail += ` LIMIT $${args.length}`;
    }
    if (f.offset) {
      args.push(f.offset);
      tail += ` OFFSET $${args.length}`;
    }
    const { rows } = await this.sql.query<UrlRow>(
      `SELECT ${URL_COLS} FROM lw_crawl_urls WHERE ${where.join(' AND ')} ORDER BY seq${tail}`,
      args,
    );
    return rows.map(url);
  }

  async page(id: string, u: string) {
    const { rows } = await this.sql.query<UrlRow>(
      `SELECT ${URL_COLS}, page FROM lw_crawl_urls WHERE crawl_id = $1 AND url = $2`,
      [id, u],
    );
    const r = rows[0];
    return r ? { url: url(r), page: r.page ?? null } : null;
  }
}
