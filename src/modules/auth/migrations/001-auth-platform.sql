-- W058 — auth/session domain: the PLATFORM tables (accounts, sessions and
-- the per-principal company activation registry).
--
-- Platform tables (no tenant_id — listed in scripts/arch-allowlist.json):
-- an account and its sessions exist BEFORE and ACROSS companies, exactly
-- the way `tenants` is the platform root (organizations/001). The
-- tenant-scoped auth state (invitations) lives in 002.
--
--   auth_principals        — one sign-in account per person (email +
--                            password). A principal id is the opaque id
--                            organizations.tenant_members already carries.
--   auth_sessions          — opaque-token sessions. The ACTIVE company and
--                            workspace selection is per-session NAVIGATION
--                            state, never organizational truth: membership
--                            is re-verified through the organizations
--                            contract on every resolution (W058 acceptance:
--                            tenant switching can never cross scope).
--   auth_principal_tenants — which companies a principal has ACTIVATED in
--                            Aurum. A navigation registry only: it stores
--                            no role and claims nothing about membership;
--                            authoritative membership lives in
--                            organizations.tenant_members and every
--                            activation is verified live before use.
--
-- Conventions (IMPLEMENTATION-STACK §3/§8): uuid ids via gen_random_uuid(),
-- timestamptz written by the application clock, TEXT + CHECK enums.

CREATE TABLE auth_principals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT auth_principals_email_unique UNIQUE (email)
);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL,
  token_hash text NOT NULL,
  active_tenant_id uuid,
  active_workspace_id uuid,
  created_at timestamptz NOT NULL,
  last_renewed_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_user_agent text,
  CONSTRAINT auth_sessions_token_unique UNIQUE (token_hash)
);

CREATE INDEX auth_sessions_principal_idx ON auth_sessions (principal_id);

CREATE TABLE auth_principal_tenants (
  principal_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  activated_at timestamptz NOT NULL,
  last_workspace_id uuid,
  PRIMARY KEY (principal_id, tenant_id)
);
