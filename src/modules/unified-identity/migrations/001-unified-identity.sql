-- W095 · unified-identity module — the cross-modality identity registry,
-- the ambiguity ledger and the decision evidence trail.
--
-- Three tables, every one tenant-scoped (ADR-0001):
--
--   unified_identities      — one row per (tenant, modality, provider,
--                             account) for the communication paths beyond
--                             the identity module's channel-provider
--                             vocabulary: meeting participants (W085),
--                             realtime session participants (W086) and
--                             Edge Connector path identities (W088). Only
--                             `verified` rows carry a subject, so a
--                             modality-scoped account can never act as a
--                             disconnected pseudo-employee (lock 15).
--   unified_ambiguities     — the W095 acceptance evidence: observations
--                             whose matching evidence pointed at more than
--                             one organizational person, or conflicted
--                             with an existing verified link. Open until a
--                             human decides — ambiguity never auto-merges.
--   unified_identity_events — append-only evidence trail of the
--                             consequential unification decisions (lock 37).
--
-- Provider vocabularies are validated in the service layer THROUGH the
-- owning modules' contracts (identity/meetings/realtime) and deliberately
-- not hard-coded here: the three vocabularies evolve with their modules
-- and a SQL CHECK would silently fork from them. The modality CHECK below
-- mirrors UNIFIED_MODALITIES in src/modules/unified-identity/validation.ts
-- — keep both in sync.

CREATE TABLE unified_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  modality text NOT NULL CHECK (modality IN ('messaging', 'sms', 'voice', 'meeting', 'realtime', 'edge')),
  provider text NOT NULL,
  provider_account_id text NOT NULL,
  display_name text,
  email text,
  phone text,
  subject_id uuid,
  status text NOT NULL DEFAULT 'unverified'
    CHECK (status IN ('unverified', 'verified', 'revoked')),
  verification_method text
    CHECK (verification_method IS NULL OR verification_method IN ('cross_modality_match', 'admin_attestation')),
  verification_evidence text,
  verified_at timestamptz,
  verified_by text,
  revoked_at timestamptz,
  revoked_reason text,
  linked_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unified_identities_key_unique UNIQUE (tenant_id, modality, provider, provider_account_id),
  -- verification IS the link in this registry (no challenge-pending state):
  -- a row is `verified` exactly when it resolves to a subject.
  CONSTRAINT unified_identities_verified_shape CHECK (
    (status = 'verified') = (subject_id IS NOT NULL)
  ),
  CONSTRAINT unified_identities_verified_evidence CHECK (
    status <> 'verified'
    OR (verification_method IS NOT NULL AND verified_at IS NOT NULL AND verification_evidence IS NOT NULL)
  ),
  CONSTRAINT unified_identities_revoked_shape CHECK (
    (status = 'revoked') = (revoked_at IS NOT NULL)
  ),
  CONSTRAINT unified_identities_subject_shape CHECK (
    (subject_id IS NULL) = (linked_at IS NULL)
  )
);

CREATE INDEX unified_identities_tenant_subject_idx ON unified_identities (tenant_id, subject_id)
  WHERE subject_id IS NOT NULL;

CREATE TABLE unified_ambiguities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  unified_identity_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('conflicting_subject_matches', 'linked_subject_conflict')),
  candidates jsonb NOT NULL,
  detail text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolved_action text
    CHECK (resolved_action IS NULL OR resolved_action IN ('admin_linked', 'revoked', 'evidence_resolved', 'dismissed')),
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unified_ambiguities_resolution_shape CHECK (
    (status = 'resolved') = (resolved_at IS NOT NULL)
  ),
  CONSTRAINT unified_ambiguities_open_unresolved CHECK (
    status <> 'open' OR (resolved_action IS NULL AND resolved_by IS NULL)
  )
);

CREATE INDEX unified_ambiguities_tenant_identity_idx
  ON unified_ambiguities (tenant_id, unified_identity_id);

CREATE TABLE unified_identity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  unified_identity_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'observed', 'linked', 'admin_linked', 'revoked',
    'ambiguity_opened', 'ambiguity_resolved'
  )),
  detail text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX unified_identity_events_tenant_identity_idx
  ON unified_identity_events (tenant_id, unified_identity_id);
