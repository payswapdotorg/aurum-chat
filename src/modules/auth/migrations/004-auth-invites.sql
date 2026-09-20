-- W058 · auth module — tenant invitations (ADR-0001 tenant-scoped).
--
-- One row per outstanding invitation a company's owner/admin issues to an
-- email address. The invite CODE is an opaque random token delivered
-- out-of-band (the free-tier deployment uses transactional email); the
-- table stores only its SHA-256 hash, exactly like sessions.
--
-- Lifecycle: pending → accepted (redeemed by a signed-in principal whose
-- email matches) | revoked (by an issuer) | expired (TTL passed).
-- Redemption records which principal accepted, so the audit trail stays
-- reconstructable without storing credentials.
--
-- `created_by` is the issuing principal (must hold the tenant owner/admin
-- role when the invite is created); redemption executes the membership
-- grant through the organizations contract acting AS the issuer — the
-- invite is the issuer's standing authorization, and a demoted/removed
-- issuer fails honestly at that point.
--
-- A workspace-scoped invitation additionally grants that workspace's
-- membership on redemption (nullable = tenant membership only).

CREATE TABLE auth_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  workspace_id uuid,
  email text NOT NULL CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254
    AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  role text NOT NULL CHECK (role IN ('member', 'admin')),
  token_hash text NOT NULL UNIQUE CHECK (char_length(token_hash) = 64),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid
);

CREATE INDEX auth_invites_tenant_idx ON auth_invites (tenant_id);

-- Only one PENDING invitation per (tenant, email): the partial unique
-- index is the race-proof backstop (the service revokes superseded
-- pending invites before inserting a fresh one).
CREATE UNIQUE INDEX auth_invites_pending_email
  ON auth_invites (tenant_id, email) WHERE status = 'pending';
