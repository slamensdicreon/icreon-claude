-- What the team knows across projects: lessons, procedures and gaps, searched by text and
-- filtered by where they apply. The current version of each entry, and its history.

CREATE SEQUENCE IF NOT EXISTS lw_knowledge_ref;

CREATE TABLE IF NOT EXISTS lw_knowledge (
  id          text        PRIMARY KEY,
  ref         text        NOT NULL UNIQUE,
  kind        text        NOT NULL,
  status      text        NOT NULL,
  scope_kind  text        NOT NULL,
  scope_id    text        NOT NULL,
  title       text        NOT NULL,
  body        jsonb       NOT NULL,
  -- Seeds and retrospectives name what they came from, so running them twice adds nothing.
  source_key  text        UNIQUE,
  version     integer     NOT NULL DEFAULT 1,
  used        integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  search      tsvector    GENERATED ALWAYS AS (
                to_tsvector('english', title || ' ' || coalesce(body->>'text', '') || ' ' ||
                  coalesce(body->>'tags', ''))
              ) STORED
);

CREATE INDEX IF NOT EXISTS lw_knowledge_scope ON lw_knowledge (status, scope_kind, scope_id);
CREATE INDEX IF NOT EXISTS lw_knowledge_search ON lw_knowledge USING gin (search);

CREATE TABLE IF NOT EXISTS lw_knowledge_history (
  seq       bigserial   PRIMARY KEY,
  entry_id  text        NOT NULL,
  at        timestamptz NOT NULL DEFAULT now(),
  kind      text        NOT NULL,
  detail    jsonb       NOT NULL
);

CREATE INDEX IF NOT EXISTS lw_knowledge_history_entry ON lw_knowledge_history (entry_id, seq);
