-- Crawls of a project's source site, run in the background (browser.crawl.start): the job, and
-- every URL it found with the page read from it. Agents read pages from here, a page at a time or
-- by template, instead of one tool result that has to fit their context; a crawl survives a
-- restart, and a worker picks up a crawl whose worker died once its lease runs out.

CREATE TABLE IF NOT EXISTS lw_crawls (
  id            text        PRIMARY KEY,
  project_id    text        NOT NULL,
  origin        text        NOT NULL,
  start_url     text        NOT NULL,
  status        text        NOT NULL,
  options       jsonb       NOT NULL,
  stats         jsonb       NOT NULL DEFAULT '{}',
  sitemap_urls  integer     NOT NULL DEFAULT -1,
  message       text,
  lease_owner   text,
  lease_until   timestamptz,
  started_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);

CREATE INDEX IF NOT EXISTS lw_crawls_project ON lw_crawls (project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS lw_crawls_running ON lw_crawls (status) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS lw_crawl_urls (
  seq         bigserial,
  crawl_id    text        NOT NULL REFERENCES lw_crawls (id) ON DELETE CASCADE,
  url         text        NOT NULL,
  -- queued, inflight, done, excluded, failed
  state       text        NOT NULL,
  depth       integer     NOT NULL,
  -- start, sitemap, link, redirect
  source      text        NOT NULL,
  lastmod     text,
  attempts    integer     NOT NULL DEFAULT 0,
  reason      text,
  -- A page's few fields for listing and grouping into templates; the full extract is in page.
  summary     jsonb,
  page        jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (crawl_id, url)
);

CREATE INDEX IF NOT EXISTS lw_crawl_urls_queue ON lw_crawl_urls (crawl_id, state, seq);
CREATE INDEX IF NOT EXISTS lw_crawl_urls_order ON lw_crawl_urls (crawl_id, seq);
