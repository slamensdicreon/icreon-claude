-- The per-project, append-only event log. Everything the Control Center shows is folded from it.

CREATE TABLE IF NOT EXISTS lw_events (
  project_id text        NOT NULL,
  seq        integer     NOT NULL,
  id         uuid        NOT NULL UNIQUE,
  ts         timestamptz NOT NULL,
  type       text        NOT NULL,
  severity   text        NOT NULL,
  actor      jsonb       NOT NULL,
  subject    jsonb       NOT NULL,
  data       jsonb       NOT NULL,
  PRIMARY KEY (project_id, seq)
);

-- One row per project. Appends bump `head` and insert in the same statement, so seqs are
-- gap-free and the row lock serializes concurrent appends to one project.
CREATE TABLE IF NOT EXISTS lw_project_heads (
  project_id text    PRIMARY KEY,
  head       integer NOT NULL
);

-- Live tail across processes: one notification per insert statement, delivered on commit,
-- carrying "project:lastSeq" for every project the statement touched.
CREATE OR REPLACE FUNCTION lw_notify_events() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'lw_events',
    (SELECT string_agg(project_id || ':' || last_seq, ',')
       FROM (SELECT project_id, max(seq) AS last_seq FROM new_rows GROUP BY project_id) AS t)
  );
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER lw_events_notify
  AFTER INSERT ON lw_events
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION lw_notify_events();
