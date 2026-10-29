-- Rules from the Director's answers (when this happens, do that), applied by Lead triage. The
-- current version of each rule, and an append-only history of what happened to it.

CREATE SEQUENCE IF NOT EXISTS lw_rule_ref;

CREATE TABLE IF NOT EXISTS lw_rules (
  id          text        PRIMARY KEY,
  ref         text        NOT NULL UNIQUE,
  status      text        NOT NULL,
  category    text        NOT NULL,
  scope_kind  text        NOT NULL,
  scope_id    text        NOT NULL,
  body        jsonb       NOT NULL,
  version     integer     NOT NULL DEFAULT 1,
  applied     integer     NOT NULL DEFAULT 0,
  overridden  integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lw_rules_scope ON lw_rules (status, category, scope_kind, scope_id);

CREATE TABLE IF NOT EXISTS lw_rule_history (
  seq      bigserial   PRIMARY KEY,
  rule_id  text        NOT NULL,
  at       timestamptz NOT NULL DEFAULT now(),
  kind     text        NOT NULL,
  detail   jsonb       NOT NULL
);

CREATE INDEX IF NOT EXISTS lw_rule_history_rule ON lw_rule_history (rule_id, seq);
