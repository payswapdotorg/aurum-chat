-- W103 · api module — extend the api_keys scope vocabulary with the
-- channels family (J16 unblock: v1 public API channel-family operations).
--
-- The scopes CHECK constraint installed by 001-api-keys.sql pins the
-- closed capability-scope vocabulary at the STORAGE level (defense in
-- depth behind src/modules/api/scopes.ts). W103 adds 'channels:read'
-- and 'channels:write' to the contract vocabulary, so the constraint
-- must accept them — applied migrations are immutable history (the W102
-- discipline), so this file REPLACES the constraint in place:
--
--   * every environment (fresh or long-lived) carries the 001-era
--     constraint under its deterministic PostgreSQL name
--     `api_keys_scopes_check`, which is dropped here and immediately
--     re-added with the EXTENDED scope list;
--   * the ledger records this file by name, so it applies exactly once
--     per environment;
--   * existing rows stay valid untouched: the constraint only widens
--     the accepted vocabulary (no key ever held — or needs — a scope
--     outside either list); the migration is a pure constraint swap.
--
-- No table is created, dropped or renamed: the W102 drift-guard census
-- (scripts/migrate.ts + /api/health EXPECTED_TABLE_CENSUS) is unaffected.

ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_scopes_check;

ALTER TABLE api_keys ADD CONSTRAINT api_keys_scopes_check CHECK (
  cardinality(scopes) >= 1
  AND scopes <@ ARRAY[
    'goals:read', 'missions:read', 'missions:write', 'epistemics:read',
    'knowledge:read', 'evidence:read', 'capabilities:read', 'agents:read',
    'approvals:read', 'approvals:write', 'channels:read', 'channels:write',
    'webhooks:manage', 'api:administer'
  ]::text[]
);
