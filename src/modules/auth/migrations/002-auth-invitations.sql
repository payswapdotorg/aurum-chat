-- W058 — auth/session domain: the TENANT-SCOPED invitation table.
--
-- auth_invitations carries tenant_id (the arch gate's rule (d)): an
-- invitation is issued BY a member of one company FOR that company.
--
--   tenant_id / workspace_id — the company (and optional workspace) the
--       invitee joins. Opaque references: no cross-module foreign keys
--       (the organizations module owns those tables; the same doctrine
--       tenant_members follows for principal_id).
--   tenant_name — a DISPLAY SNAPSHOT of the company name at invitation
--       time (a receipt copy for the acceptance screen; the authoritative
--       tenant record stays in organizations).
--   token_hash — sha-256 of the opaque invite token (the raw token is
--       shown to the inviter exactly once, like a session token).
--   invited_by — the principal whose authority grants the membership at
--       acceptance time (the organizations contract re-checks their
--       CURRENT role when the grant runs — an invite can never outlive
--       its inviter's authority).
--
-- At most one OPEN invitation per (tenant, email): creating a new one
-- supersedes (revokes) the previous open row in the same transaction.

CREATE TABLE auth_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid,
  tenant_name text NOT NULL,
  email text NOT NULL,
  tenant_role text NOT NULL CHECK (tenant_role IN ('owner', 'admin', 'member')),
  workspace_role text CHECK (workspace_role IN ('admin', 'member')),
  token_hash text NOT NULL,
  invited_by uuid NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_principal_id uuid,
  revoked_at timestamptz,
  CONSTRAINT auth_invitations_token_unique UNIQUE (token_hash)
);

CREATE INDEX auth_invitations_tenant_idx ON auth_invitations (tenant_id);

CREATE UNIQUE INDEX auth_invitations_open_unique
  ON auth_invitations (tenant_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
