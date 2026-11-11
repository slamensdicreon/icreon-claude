-- When an organization's data was purged, 90 days after its license ended (export closed).
ALTER TABLE lw_licenses ADD COLUMN IF NOT EXISTS purged_at timestamptz;
