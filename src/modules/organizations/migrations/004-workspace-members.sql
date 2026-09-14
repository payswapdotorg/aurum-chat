-- W001 · organizations module — workspace membership (ADR-0001).
--
-- One row per (workspace, principal) with the workspace role
-- (admin > member). The table carries tenant_id directly (arch gate rule
-- (d)); the organizations service keeps it consistent with
-- workspaces.tenant_id — inserts run only after the workspace has been
-- resolved inside the calling tenant, and every query filters by the
-- context tenant.
--
-- Invariants held by the service layer on top of this table:
--   * workspace members must first be members of the same tenant;
--   * workspace admins manage their workspace; tenant owners/admins retain
--     authority over every workspace of their tenant (removing the last
--     workspace admin never locks a workspace);
--   * workspace memberships end together with the tenant membership.

CREATE TABLE workspace_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  principal_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_members_unique UNIQUE (workspace_id, principal_id)
);

CREATE INDEX workspace_members_tenant_workspace_idx ON workspace_members (tenant_id, workspace_id);
CREATE INDEX workspace_members_principal_idx ON workspace_members (principal_id);
