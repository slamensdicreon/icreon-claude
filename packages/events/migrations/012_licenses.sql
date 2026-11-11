-- Licenses: what each organization may run, for how long. Icreon (organization #1) needs none.
-- Every change is kept, for billing disputes.

CREATE TABLE IF NOT EXISTS lw_licenses (
  organization_id   text        PRIMARY KEY REFERENCES lw_organizations (id) ON DELETE CASCADE,
  -- Platform ids ('sitecoreai', 'optimizely') and playbook ids the organization may run.
  entities          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  playbooks         jsonb       NOT NULL DEFAULT '[]'::jsonb,
  -- How many projects may exist at once (a deleted one frees its place).
  projects_included integer     NOT NULL CHECK (projects_included >= 0),
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz NOT NULL,
  -- Set when the term ended and the organization's running projects were paused: which ones, so
  -- a renewal resumes exactly those.
  suspended         jsonb,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        text        NOT NULL
);

CREATE TABLE IF NOT EXISTS lw_license_changes (
  id              bigserial   PRIMARY KEY,
  organization_id text        NOT NULL,
  at              timestamptz NOT NULL DEFAULT now(),
  by              text        NOT NULL,
  -- 'granted', 'changed', 'suspended', 'resumed'
  kind            text        NOT NULL,
  license         jsonb       NOT NULL
);
CREATE INDEX IF NOT EXISTS lw_license_changes_org ON lw_license_changes (organization_id, at);
