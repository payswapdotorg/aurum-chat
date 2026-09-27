-- W104 · api module — expand the api_keys scopes CHECK with the meetings
-- and cellular capability families.
--
-- W038 discipline (additive only): the v1 surface gains the meeting
-- family (meetings:read — the meeting-intelligence contract's read
-- surface, W085) and the cellular family (cellular:read + cellular:write
-- — the SMS/voice reachability contract's read + connection-registration
-- surface, W087). Every existing scope is carried forward verbatim; no
-- key loses a grant and no operation is renamed or removed.
--
-- INTEGRATION AMENDMENT (tech lead, W104 merge): this file runs AFTER
-- 003-api-channels-scopes.sql (alphabetical order) and therefore carries
-- the constraint's authoritative current shape — the channels family
-- (channels:read + channels:write, W103) is included below so the final
-- installed constraint accepts EVERY family in API_SCOPES. On the
-- current production the channels 003 has already applied (ledger-keyed);
-- on fresh databases both 003 files run in order with identical effect.
--
-- The constraint is REPLACED (not edited in 001): the migration ledger
-- is name-keyed with no content checksum (the W102 reconciliation's
-- finding), so an already-applied 001 must never be rewritten — a new
-- file carries the expansion, and the constraint keeps 001's generated
-- name so future introspection sees exactly one live scopes CHECK.

ALTER TABLE api_keys DROP CONSTRAINT api_keys_scopes_check;

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
