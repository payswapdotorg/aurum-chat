-- W058 · auth module — sessions (platform table).
--
-- One row per signed-in browser session. The raw session token never
-- leaves the HTTP layer: the table stores only its SHA-256 digest (the
-- api module's constant-time discipline). The digest's GLOBAL uniqueness
-- is the authentication invariant — a presented token must resolve onto
-- exactly ONE session — so it is not namespaced by tenant (the same
-- contract `api_keys.key_hash` documents).
--
-- This is a PLATFORM table (scripts/arch-allowlist.json, like `tenants`
-- and `auth_users`): a session belongs to a PRINCIPAL, exists BEFORE any
-- company is selected (fresh registration), and may switch companies —
-- so it cannot carry a NOT NULL tenant partition key.
--
-- `active_tenant_id` / `active_workspace_id` are the session's SELECTION,
-- not an ownership claim: every resolution re-verifies through the
-- organizations contract that the principal is still a member of the
-- selected company (getTenantMembership) and silently de-selects when it
-- is not — "tenant switching cannot cross scope" is enforced per request,
-- never by trusting these columns.
--
-- Expiry policy (src/modules/auth/policy.ts): `expires_at` slides with
-- activity (idle TTL) up to an absolute cap from `created_at`;
-- `last_seen_at` throttles renewal writes; `revoked_at` is the explicit
-- sign-out mark. PostgreSQL remains authoritative (lock 35: Redis is
-- never domain truth, and sessions ARE authoritative auth state).

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth_users (id),
  token_hash text NOT NULL UNIQUE CHECK (char_length(token_hash) = 64),
  active_tenant_id uuid,
  active_workspace_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT auth_sessions_tenant_workspace CHECK (
    active_tenant_id IS NOT NULL OR active_workspace_id IS NULL
  )
);

CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id);
