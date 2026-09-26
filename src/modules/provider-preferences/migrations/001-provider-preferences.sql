-- W091 · provider-preferences module — the User-Friendly Provider Choice
-- UX domain: the tenant-level outcome priority with its
-- organizational-policy posture, the per-member personal preferences,
-- the authorization-gated technical overrides (reversible, audited),
-- and the append-only selection-explanation ledger (the honest
-- "why this provider?" records) with its ordinary/advanced projection
-- seam enforced in code (the ordinary reads strip the technical
-- identity before it can cross).
--
-- Every table carries tenant_id (ADR-0001; scripts/check-architecture.ts
-- rule d). JARGON DISCIPLINE: provider keys appear ONLY in the
-- technical columns (provider_technical_overrides.provider,
-- provider_selection_explanations.chosen_provider) that the
-- claim-gated advanced surface reads — no user-language column ever
-- stores a provider identity. Gateway/capability/provider keys are
-- OPEN vocabularies (shape-checked only — the provider-billing
-- discipline): the owning gateway's vocabulary is validated where it
-- is known, so wiring a new gateway requires no migration here and no
-- provider is privileged (lock 30).
--
-- NOTE: the outcome-priority CHECKs mirror the validation in
-- src/modules/provider-preferences/validation.ts — keep both in sync.

-- ---------------------------------------------------------------------------
-- Tenant preference — the company-wide outcome priority + policy posture
-- ---------------------------------------------------------------------------

CREATE TABLE provider_preference_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  -- The ordered outcome priority (1..4, unique entries — enforced in
  -- validation; the storage layer enforces the array shape).
  outcome_priority jsonb NOT NULL
    CHECK (jsonb_typeof(outcome_priority) = 'array' AND jsonb_array_length(outcome_priority) BETWEEN 1 AND 4),
  -- True when organizational policy decides: personal preferences are
  -- recorded but do not bend routing while this holds.
  policy_first boolean NOT NULL DEFAULT false,
  updated_by text NOT NULL CHECK (updated_by <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_preference_settings_tenant_unique UNIQUE (tenant_id),
  CONSTRAINT provider_preference_settings_id_tenant_unique UNIQUE (id, tenant_id)
);

-- ---------------------------------------------------------------------------
-- Personal preferences — one member's own outcome priority
-- ---------------------------------------------------------------------------

CREATE TABLE provider_personal_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  outcome_priority jsonb NOT NULL
    CHECK (jsonb_typeof(outcome_priority) = 'array' AND jsonb_array_length(outcome_priority) BETWEEN 1 AND 4),
  updated_by text NOT NULL CHECK (updated_by <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_personal_preferences_principal_unique UNIQUE (tenant_id, principal_id),
  CONSTRAINT provider_personal_preferences_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX provider_personal_preferences_tenant_idx
  ON provider_personal_preferences (tenant_id, updated_at DESC);

-- ---------------------------------------------------------------------------
-- Technical overrides — the advanced, authorization-gated provider pin
-- ---------------------------------------------------------------------------

CREATE TABLE provider_technical_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  gateway text NOT NULL CHECK (gateway ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  -- The capability scope; NULL = the whole gateway.
  capability text CHECK (capability IS NULL OR capability ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  -- Canonical scope encoding ('g:<gateway>' | 'g:<gateway>:c:<capability>')
  -- — the per-tenant override namespace (see validation.overrideScopeKey).
  scope_key text NOT NULL CHECK (char_length(scope_key) BETWEEN 3 AND 200),
  provider text NOT NULL CHECK (provider ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  -- Why this override exists (required human language — the advanced
  -- surface shows it beside the pin).
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  set_by text NOT NULL CHECK (set_by <> ''),
  set_at timestamptz NOT NULL,
  retired_by text CHECK (retired_by IS NULL OR retired_by <> ''),
  retired_at timestamptz,
  CONSTRAINT provider_technical_overrides_scope_unique UNIQUE (tenant_id, scope_key),
  CONSTRAINT provider_technical_overrides_id_tenant_unique UNIQUE (id, tenant_id),
  -- Only retired rows carry the retirement trail; active rows carry none.
  CONSTRAINT provider_technical_overrides_retired_shape CHECK (
    status <> 'retired' OR (retired_by IS NOT NULL AND retired_at IS NOT NULL)
  ),
  CONSTRAINT provider_technical_overrides_active_shape CHECK (
    status <> 'active' OR (retired_by IS NULL AND retired_at IS NULL)
  )
);

CREATE INDEX provider_technical_overrides_tenant_status_idx
  ON provider_technical_overrides (tenant_id, status, set_at DESC);

-- ---------------------------------------------------------------------------
-- Selection explanations — the append-only "why this provider?" ledger
-- ---------------------------------------------------------------------------

CREATE TABLE provider_selection_explanations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  gateway text NOT NULL CHECK (gateway ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  capability text NOT NULL CHECK (capability ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  -- The chosen provider's key (NULL when no option was available).
  -- TECHNICAL identity: read only through the claim-gated advanced
  -- projection (getSelectionExplanation); the ordinary projection
  -- strips it in code.
  chosen_provider text CHECK (chosen_provider IS NULL OR chosen_provider ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  chosen_account_ref text
    CHECK (chosen_account_ref IS NULL OR char_length(chosen_account_ref) BETWEEN 1 AND 255),
  decision text NOT NULL CHECK (decision IN (
    'technical-override', 'preference', 'single-choice', 'no-choice'
  )),
  preference_source text NOT NULL CHECK (preference_source IN (
    'organizational-policy', 'tenant-priority', 'personal-preference', 'default'
  )),
  deciding_outcome text CHECK (deciding_outcome IS NULL OR deciding_outcome IN (
    'cost', 'privacy', 'quality', 'speed'
  )),
  candidates_considered integer NOT NULL CHECK (candidates_considered BETWEEN 0 AND 16),
  budget_excluded_count integer NOT NULL DEFAULT 0 CHECK (budget_excluded_count BETWEEN 0 AND 16),
  override_unavailable boolean NOT NULL DEFAULT false,
  -- The user-language explanation (built by policy.ts from structured
  -- fields — jargon-free by construction: never contains provider identity).
  explanation text NOT NULL CHECK (char_length(explanation) BETWEEN 1 AND 2000),
  -- Emitter-supplied dedupe key — unique per (tenant, gateway): a
  -- recorded key replays the original record (first write wins).
  dedupe_key text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 2 AND 200),
  recorded_by text NOT NULL CHECK (recorded_by <> ''),
  recorded_at timestamptz NOT NULL,
  CONSTRAINT provider_selection_explanations_dedupe_unique UNIQUE (tenant_id, gateway, dedupe_key),
  CONSTRAINT provider_selection_explanations_id_tenant_unique UNIQUE (id, tenant_id),
  -- A 'no-choice' decision records that NOTHING was chosen.
  CONSTRAINT provider_selection_explanations_no_choice_shape CHECK (
    decision <> 'no-choice' OR chosen_provider IS NULL
  )
);

CREATE INDEX provider_selection_explanations_tenant_recent_idx
  ON provider_selection_explanations (tenant_id, recorded_at DESC);
CREATE INDEX provider_selection_explanations_tenant_capability_idx
  ON provider_selection_explanations (tenant_id, capability, recorded_at DESC);

-- ---------------------------------------------------------------------------
-- Events — append-only audit of the module's state changes
-- ---------------------------------------------------------------------------

CREATE TABLE provider_preference_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  -- The principal a personal event is about (NULL for tenant-level).
  principal_id uuid,
  -- Monotonic per-tenant position: the service clock can hold still
  -- (test-controllable time), so the audit feed orders by
  -- (recorded_at DESC, position DESC) deterministically.
  position integer NOT NULL CHECK (position >= 1),
  event text NOT NULL CHECK (event IN (
    'tenant-preference-set',
    'personal-preference-set',
    'personal-preference-cleared',
    'override-set',
    'override-cleared'
  )),
  -- User-language detail (never technical provider identity).
  detail text NOT NULL CHECK (char_length(detail) BETWEEN 1 AND 2000),
  recorded_by text NOT NULL CHECK (recorded_by <> ''),
  recorded_at timestamptz NOT NULL,
  CONSTRAINT provider_preference_events_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX provider_preference_events_tenant_idx
  ON provider_preference_events (tenant_id, recorded_at DESC, position DESC);

-- ---------------------------------------------------------------------------
-- Storage-level guarantees
-- ---------------------------------------------------------------------------

-- provider_preference_events AND provider_selection_explanations:
-- strictly append-only ledgers — no UPDATE, DELETE or TRUNCATE, ever.
-- (The preference settings and override rows are live workflow state —
-- changeable any time by design; their HISTORY is the append-only
-- audit above, and the explanation ledger is evidence, not state.)

CREATE OR REPLACE FUNCTION provider_preference_append_only_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (W091 provider-preferences audit): % is forbidden on table %',
    TG_TABLE_NAME, TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER provider_preference_events_immutable
  BEFORE UPDATE OR DELETE ON provider_preference_events
  FOR EACH ROW EXECUTE FUNCTION provider_preference_append_only_reject_mutation();
CREATE TRIGGER provider_preference_events_immutable_truncate
  BEFORE TRUNCATE ON provider_preference_events
  FOR EACH STATEMENT EXECUTE FUNCTION provider_preference_append_only_reject_mutation();

CREATE TRIGGER provider_selection_explanations_immutable
  BEFORE UPDATE OR DELETE ON provider_selection_explanations
  FOR EACH ROW EXECUTE FUNCTION provider_preference_append_only_reject_mutation();
CREATE TRIGGER provider_selection_explanations_immutable_truncate
  BEFORE TRUNCATE ON provider_selection_explanations
  FOR EACH STATEMENT EXECUTE FUNCTION provider_preference_append_only_reject_mutation();
