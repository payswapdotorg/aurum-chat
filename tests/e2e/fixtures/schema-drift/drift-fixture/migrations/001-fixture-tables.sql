-- W102 test fixture — a miniature module whose two tables back the
-- schema-drift unit tests (tests/e2e/platform/schema-reconciliation.test.ts).
-- This directory is NEVER migrated by the application's migration
-- runner; it exists only so verifyMigratedSchema can be driven against
-- a tiny known migration set with a fake (stub) database.
CREATE TABLE drift_alpha (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL
);

CREATE TABLE IF NOT EXISTS drift_beta (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL
);
