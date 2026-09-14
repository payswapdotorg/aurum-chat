-- W001 · organizations module — tenant membership roster (ADR-0001).
--
-- One row per (tenant, principal): the membership that carries the tenant
-- role (owner > admin > member). principal_id is an opaque authenticated
-- principal (TenantContext.principalId): the auth module owns principals and
-- the people module owns persons (organizations is the upstream module per
-- MODULE-DEPENDENCY-MAP.md: organizations → identity → people), so no
-- cross-module foreign key is possible — the organizations service enforces
-- the invariants instead.
--
-- Invariants held by the service layer on top of this table:
--   * every tenant keeps at least one owner (provisionTenant creates one;
--     role changes/removals refuse to break the last owner);
--   * owners grant any role and manage everyone; admins manage plain
--     members only;
--   * removing a tenant member also removes their workspace memberships
--     inside that tenant (single transaction).

CREATE TABLE tenant_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  principal_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_members_unique UNIQUE (tenant_id, principal_id)
);

CREATE INDEX tenant_members_principal_idx ON tenant_members (principal_id);
