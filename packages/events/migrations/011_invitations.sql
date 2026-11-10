-- Invitations: a Director asks someone, by email, to join their organization in a role. The first
-- time that person signs in with the address verified, every pending invitation for it becomes a
-- membership.

CREATE TABLE IF NOT EXISTS lw_invitations (
  id              text        PRIMARY KEY,
  organization_id text        NOT NULL REFERENCES lw_organizations (id) ON DELETE CASCADE,
  email           text        NOT NULL,
  role            text        NOT NULL CHECK (role IN ('director', 'watcher')),
  invited_by      text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  accepted_at     timestamptz,
  accepted_by     text,
  revoked_at      timestamptz
);
-- One open invitation per person per organization; inviting again replaces it.
CREATE UNIQUE INDEX IF NOT EXISTS lw_invitations_open
  ON lw_invitations (organization_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS lw_invitations_email ON lw_invitations (email);

-- How a member is shown: their email or GitHub login (the subject is an opaque id).
ALTER TABLE lw_memberships ADD COLUMN IF NOT EXISTS label text;
