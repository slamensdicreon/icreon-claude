-- An organization's own rules and lessons: its variant of a playbook. They reach that
-- organization's projects only; null is Icreon's, for every project in scope.
ALTER TABLE lw_rules ADD COLUMN IF NOT EXISTS organization_id text;
ALTER TABLE lw_knowledge ADD COLUMN IF NOT EXISTS organization_id text;
CREATE INDEX IF NOT EXISTS lw_rules_organization ON lw_rules (organization_id);
CREATE INDEX IF NOT EXISTS lw_knowledge_organization ON lw_knowledge (organization_id);
