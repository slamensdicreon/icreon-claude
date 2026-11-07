-- Bulk imports of a large site's page templates (import.start): the job, and every page of the
-- template with what became of it. A page that doesn't fit the template's proven mapping is an
-- exception, left for an agent; an import survives a restart and resumes where it was.

CREATE TABLE IF NOT EXISTS lw_imports (
  id            text        PRIMARY KEY,
  project_id    text        NOT NULL,
  task_id       text        NOT NULL,
  template      text        NOT NULL,
  crawl_id      text        NOT NULL,
  status        text        NOT NULL,
  plan          jsonb       NOT NULL,
  stats         jsonb       NOT NULL DEFAULT '{}',
  message       text,
  lease_owner   text,
  lease_until   timestamptz,
  started_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);

CREATE INDEX IF NOT EXISTS lw_imports_project ON lw_imports (project_id, template, started_at DESC);
CREATE INDEX IF NOT EXISTS lw_imports_running ON lw_imports (status) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS lw_import_pages (
  seq         bigserial,
  import_id   text        NOT NULL REFERENCES lw_imports (id) ON DELETE CASCADE,
  url         text        NOT NULL,
  path        text        NOT NULL,
  -- queued, inflight, done, exception, failed, reverted
  state       text        NOT NULL,
  item_id     text,
  -- The import made this page item (not one an agent built before it): a revert may remove it.
  created     boolean     NOT NULL DEFAULT false,
  reason      text,
  attempts    integer     NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (import_id, url)
);

CREATE INDEX IF NOT EXISTS lw_import_pages_queue ON lw_import_pages (import_id, state, seq);
