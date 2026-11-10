-- Organizations: who owns each project, and who belongs to each organization in which role.
-- A project belongs to one organization for good; its events stay keyed by project, so the
-- project's row here is what scopes them.

CREATE TABLE IF NOT EXISTS lw_organizations (
  id         text        PRIMARY KEY,
  name       text        NOT NULL,
  slug       text        NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per person per organization. `subject` is the signed-in identity, qualified by where it
-- comes from (`github:<login>` today).
CREATE TABLE IF NOT EXISTS lw_memberships (
  organization_id text        NOT NULL REFERENCES lw_organizations (id) ON DELETE CASCADE,
  subject         text        NOT NULL,
  role            text        NOT NULL CHECK (role IN ('director', 'watcher')),
  added_by        text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, subject)
);
CREATE INDEX IF NOT EXISTS lw_memberships_subject ON lw_memberships (subject);

-- Kept after a purge, like the tombstone, so a deleted project's record stays in its organization.
CREATE TABLE IF NOT EXISTS lw_project_organizations (
  project_id      text        PRIMARY KEY,
  organization_id text        NOT NULL REFERENCES lw_organizations (id),
  assigned_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lw_project_organizations_org ON lw_project_organizations (organization_id);

-- Organization #1, Icreon, owns every project that existed before organizations. Projects are
-- assigned before their first event, so after this runs nothing in the log is unowned, and any
-- project a process wrote without one (a demo, a seed) is Icreon's too.
INSERT INTO lw_organizations (id, name, slug) VALUES ('org-icreon', 'Icreon', 'icreon')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO lw_project_organizations (project_id, organization_id)
  SELECT project_id, 'org-icreon' FROM lw_project_heads
  ON CONFLICT (project_id) DO NOTHING;
