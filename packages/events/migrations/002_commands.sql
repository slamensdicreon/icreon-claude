-- Commands for a project runner in another process (the demo runner on a daemon). The API inserts
-- a row and waits for its outcome; the runner claims pending rows with SKIP LOCKED, runs them and
-- records the result or the refusal.

CREATE TABLE IF NOT EXISTS lw_commands (
  id         uuid        PRIMARY KEY,
  project_id text        NOT NULL,
  method     text        NOT NULL,
  args       jsonb       NOT NULL,
  -- pending | running | done | failed | expired
  status     text        NOT NULL DEFAULT 'pending',
  result     jsonb,
  error      jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  done_at    timestamptz
);

CREATE INDEX IF NOT EXISTS lw_commands_pending ON lw_commands (created_at) WHERE status = 'pending';
