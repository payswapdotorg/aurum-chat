-- W058 · auth module — the principal's company directory.
--
-- One row per (principal, company) the principal has legitimately reached
-- through an auth-owned flow: created it during onboarding, joined it by
-- redeeming an invitation, or explicitly switched to it after a successful
-- membership check. This is the switcher's candidate list — NOTHING more.
--
-- It is deliberately NOT a second source of membership truth (lock: the
-- product surface may never become one): the organizations module stays
-- the sole membership authority, every selection re-verifies membership
-- through its contract, and rows whose membership no longer verifies are
-- pruned on read. Cross-module reads of tenant_members are forbidden
-- (contract-only doctrine), which is exactly why this derived, always
-- re-verified navigation table exists instead.

CREATE TABLE auth_user_companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth_users (id),
  tenant_id uuid NOT NULL,
  added_via text NOT NULL CHECK (added_via IN ('created', 'invite', 'switch')),
  added_at timestamptz NOT NULL DEFAULT now(),
  last_selected_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_user_companies_unique UNIQUE (user_id, tenant_id)
);

CREATE INDEX auth_user_companies_tenant_idx ON auth_user_companies (tenant_id);
