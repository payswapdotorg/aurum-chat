-- W002 · identity module — ExternalIdentity records (ADR-0003).
--
-- One row per (tenant, provider, account). `subject_id` is an opaque
-- reference to the people module's persons table: the dependency direction is
-- people → identity (MODULE-DEPENDENCY-MAP.md), so no cross-module foreign
-- key is possible — referential integrity is enforced by the people module's
-- link workflow, which validates the person before attaching.
--
-- The unique constraint below is what makes duplicate provider-account
-- registrations collapse onto a single row, and lock 15 (no disconnected
-- pseudo-employees) is enforced by the service layer: only `verified`
-- identities may carry a subject.
--
-- NOTE: the provider CHECK mirrors CHANNEL_PROVIDERS in src/modules/identity/
-- providers.ts — keep both in sync.

CREATE TABLE identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN (
    'whatsapp', 'telegram', 'signal', 'slack', 'x', 'instagram',
    'facebook', 'linkedin', 'email', 'sms', 'voice', 'web'
  )),
  provider_account_id text NOT NULL,
  display_name text,
  subject_id uuid,
  subject_kind text,
  status text NOT NULL DEFAULT 'unverified'
    CHECK (status IN ('unverified', 'pending', 'verified', 'revoked')),
  verification_method text
    CHECK (verification_method IS NULL OR verification_method IN ('challenge_response', 'admin_attestation')),
  verified_at timestamptz,
  verified_by text,
  verification_evidence text,
  revoked_at timestamptz,
  revoked_reason text,
  linked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identities_provider_key_unique UNIQUE (tenant_id, provider, provider_account_id),
  CONSTRAINT identities_subject_shape CHECK ((subject_id IS NULL) = (subject_kind IS NULL)),
  CONSTRAINT identities_subject_kind_value CHECK (subject_kind IS NULL OR subject_kind = 'person')
);

CREATE INDEX identities_tenant_subject_idx ON identities (tenant_id, subject_id)
  WHERE subject_id IS NOT NULL;
