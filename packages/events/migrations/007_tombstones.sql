-- What is left of a deleted project: who it was, who asked for it to go and when, and what each
-- step of the purge removed. The purge writes this row first and finishes it last, so a purge cut
-- off part way resumes from the steps it has not done.

CREATE TABLE IF NOT EXISTS lw_project_tombstones (
  project_id   text        PRIMARY KEY,
  name         text        NOT NULL,
  client       text        NOT NULL,
  requested_by text        NOT NULL,
  requested_at timestamptz NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  purged_by    text,
  -- One entry per step: { "<step>": { "at": "...", "result": { ... } } }
  steps        jsonb       NOT NULL DEFAULT '{}'::jsonb
);
