-- Project credentials (Sitecore automation clients, Edge Context IDs), sealed with AES-256-GCM.
-- The event log only ever holds a reference ("vault:<id>") and a hint; the plaintext exists only in
-- the process that opens a secret to use it.

CREATE TABLE IF NOT EXISTS lw_secrets (
  id         uuid        PRIMARY KEY,
  project_id text        NOT NULL,
  name       text        NOT NULL,
  -- Which master key sealed it, so keys can be rotated.
  key_id     text        NOT NULL,
  iv         bytea       NOT NULL,
  ciphertext bytea       NOT NULL,
  tag        bytea       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lw_secrets_project ON lw_secrets (project_id);
