-- Time-limited memberships: Icreon's support access to a customer organization ends on its own.
ALTER TABLE lw_memberships ADD COLUMN IF NOT EXISTS expires_at timestamptz;
