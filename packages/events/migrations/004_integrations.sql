-- App-wide integrations (the Launchworks GitHub App), one row each. Secrets in `config` are vault
-- references into lw_secrets, never values.

CREATE TABLE IF NOT EXISTS lw_integrations (
  name       text        PRIMARY KEY,
  config     jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
