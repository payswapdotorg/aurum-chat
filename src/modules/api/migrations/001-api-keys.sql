-- W038 · api module — tenant-scoped API keys for the versioned public API.
--
-- An API key is the machine-caller credential of the public surface
-- (ARCHITECTURE.md §23/ADR-0005: "Every API/MCP operation is tenant-scoped,
-- permission-checked and audited"). Only the sha-256 hash of the key is
-- persisted — the raw credential is returned exactly once at issuance and
-- never stored (the identity module's challenge-code precedent; the
-- credential VALUE never reaches domain tables in recoverable form).
--
--  * tenant_id (lock 3 — every business datum is tenant-scoped). The
--    key_hash unique index is global (a presented key must resolve onto
--    its one tenant), but every row and every other access path is
--    tenant-scoped.
--  * principal_id — the principal the key acts as; it becomes
--    TenantContext.principalId, and membership is re-verified through the
--    organizations contract on EVERY request, so removing the principal
--    from the tenant immediately disables the key.
--  * scopes — the capability-oriented grant (W038: "capability-oriented
--    operations"); a closed vocabulary mirrored from src/modules/api/
--    scopes.ts (API_SCOPES) — keep both in sync.
--  * authority — the closed set of authority claims the key may carry
--    downstream (mirrored from API_KEY_AUTHORITY_CLAIMS — keep in sync).
--    Platform claims ('organizations:provision' & co.) are deliberately
--    absent: they must never ride a tenant API key.
--  * status — active/revoked; revocation is idempotent and auditable
--    (revoked_at/revoked_by). This is authorization configuration state,
--    not evidence: no append-only triggers here (the ai_provider_accounts
--    precedent), and the key hash is immutable in practice because the
--    service never updates it.

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
  key_hash text NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] NOT NULL CHECK (
    cardinality(scopes) >= 1
    AND scopes <@ ARRAY[
      'goals:read', 'missions:read', 'missions:write', 'epistemics:read',
      'knowledge:read', 'evidence:read', 'capabilities:read', 'agents:read',
      'approvals:read', 'approvals:write', 'webhooks:manage', 'api:administer'
    ]::text[]
  ),
  authority text[] NOT NULL DEFAULT '{}' CHECK (
    authority <@ ARRAY[
      'api:administer', 'actions:approve', 'actions:administer', 'agents:administer'
    ]::text[]
  ),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL CHECK (created_by <> ''),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by text,
  CONSTRAINT api_keys_hash_unique UNIQUE (key_hash)
);

CREATE INDEX api_keys_tenant_status_idx ON api_keys (tenant_id, status);
