-- Organizations Icreon deleted: what is left of one once its people, projects and license are gone
-- (like a project's tombstone), so the record says who deleted which customer, and when.
CREATE TABLE IF NOT EXISTS lw_organization_deletions (
  organization_id text        PRIMARY KEY,
  name            text        NOT NULL,
  slug            text        NOT NULL,
  deleted_by      text        NOT NULL,
  deleted_at      timestamptz NOT NULL DEFAULT now(),
  detail          jsonb       NOT NULL
);
