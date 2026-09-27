-- W106 · api module — reconcile the api_keys scopes CHECK with the
-- authoritative API_SCOPES vocabulary (the four-surface re-certification).
--
-- ROOT CAUSE (verified by direct production Postgres inspection,
-- 2026-09-27, the W102 drift class): the deployed production revision
-- 625a133 carries 003-api-scopes-w104.sql AMENDED at merge time to
-- include the W103 channels family, but the W104 BRANCH's Vercel preview
-- deployment had already applied the UNAMENDED 003 (meetings + cellular,
-- NO channels) against the SHARED production Neon database at
-- 2026-09-26T23:47:18Z — the name-keyed _migrations ledger then skipped
-- the merged file forever. The W103-era channels constraint
-- (applied 2026-09-26T20:46:46Z) was REPLACED by that unamended pass, so
-- the live production constraint accepted meetings/cellular but rejected
-- channels:read/channels:write (api_keys_scopes_check violation 23514 on
-- every channels-scoped key creation — caught by the W106 Run A browser
-- matrix, J16). The table census and ledger-count guards stay green on
-- this state because a CONSTRAINT is invisible to both (W102's guards
-- verify table existence, not constraint content).
--
-- THE REPAIR (the W102 discipline — one repair truth, no parallel
-- migrations): applied migrations are immutable history; a NEW
-- uniquely-named file carries the authoritative constraint shape. This
-- file REPLACES the constraint with EXACTLY the closed vocabulary of
-- src/modules/api/scopes.ts (API_SCOPES — 17 scopes: the 14 W038-era
-- grants, the W103 channels family, the W104 meetings + cellular
-- families), keeping 001's generated constraint name so introspection
-- sees exactly one live scopes CHECK. Idempotent no-op convergence
-- wherever the constraint is already correct (fresh databases that ran
-- both 003 files land here unchanged); the ledger records this file by
-- its unique name so it applies exactly once per environment.
--
-- Existing rows stay valid untouched: every scope ever granted is inside
-- the authoritative list (the vocabulary only ever widened). No table is
-- created, dropped or renamed: the W102 drift-guard census
-- (scripts/migrate.ts + /api/health EXPECTED_TABLE_CENSUS) is unaffected.

ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_scopes_check;

ALTER TABLE api_keys ADD CONSTRAINT api_keys_scopes_check CHECK (
  cardinality(scopes) >= 1
  AND scopes <@ ARRAY[
    'goals:read', 'missions:read', 'missions:write', 'epistemics:read',
    'knowledge:read', 'evidence:read', 'capabilities:read', 'agents:read',
    'approvals:read', 'approvals:write', 'channels:read', 'channels:write',
    'webhooks:manage', 'api:administer',
    'meetings:read', 'cellular:read', 'cellular:write'
  ]::text[]
);
