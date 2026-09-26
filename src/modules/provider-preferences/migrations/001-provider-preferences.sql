-- W091 · provider-preferences module — the user-friendly provider choice
-- UX: a tenant-level OUTCOME preference profile (privacy / cost / speed /
-- reliability / balanced), the deterministic mapping that documents how the
-- preference orders the tenant's AI options (positions + plain-language
-- basis + assigned priorities), and the append-only change-event audit
-- (saves, applications, technical overrides).
--
-- Every table carries tenant_id (ADR-0001; scripts/check-architecture.ts
-- rule d). The profile and mapping tables are CONFIGURATION state (mutable
-- upserts, like ai_provider_accounts); the event table is append-only
-- history, guarded at the storage level (the provider-billing discipline).
--
-- No provider name, model id or credential reference ever reaches these
-- tables: accounts are referenced by their opaque llm-module ids, and the
-- mapping's basis strings are plain-language outcome statements produced by
-- the module's pure core (mappings.ts).
--
-- NOTE: the preference CHECKs mirror PREFERENCE_KINDS in
-- src/modules/provider-preferences/validation.ts — keep both in sync.

-- ---------------------------------------------------------------------------
-- The tenant's outcome preference profile (one row per tenant)
-- ---------------------------------------------------------------------------

CREATE TABLE provider_preference_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  preference text NOT NULL CHECK (preference IN (
    'privacy-first', 'lowest-cost', 'fastest', 'most-reliable', 'balanced'
  )),
  note text
    CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
  updated_by text NOT NULL CHECK (updated_by <> ''),
  -- The preference currently in routing effect (written through the llm
  -- contract's updateAiProviderAccount); NULL = nothing applied yet.
  applied_preference text CHECK (applied_preference IN (
    'privacy-first', 'lowest-cost', 'fastest', 'most-reliable', 'balanced'
  )),
  applied_at timestamptz,
  -- The honest-unavailable notes of the last computed mapping (plain
  -- language, from mappings.ts — stored with the plan they describe).
  mapping_notes text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_preference_profiles_tenant_unique UNIQUE (tenant_id),
  CONSTRAINT provider_preference_profiles_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT provider_preference_profiles_applied_shape CHECK (
    (applied_preference IS NULL AND applied_at IS NULL)
    OR (applied_preference IS NOT NULL AND applied_at IS NOT NULL)
  )
);

-- ---------------------------------------------------------------------------
-- The deterministic preference → order mapping (guidance documentation)
-- ---------------------------------------------------------------------------

CREATE TABLE provider_preference_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  preference text NOT NULL CHECK (preference IN (
    'privacy-first', 'lowest-cost', 'fastest', 'most-reliable', 'balanced'
  )),
  -- Opaque reference to the tenant's AI provider account (owned by the llm
  -- module; no cross-module FK, the house discipline).
  account_id uuid NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 100),
  assigned_priority integer NOT NULL CHECK (assigned_priority BETWEEN 0 AND 1000),
  -- Plain-language basis (from mappings.ts — outcomes, never jargon).
  basis text NOT NULL CHECK (char_length(basis) BETWEEN 1 AND 500),
  -- False when the option kept its configured place for lack of evidence.
  evidence_available boolean NOT NULL DEFAULT false,
  computed_at timestamptz NOT NULL,
  CONSTRAINT provider_preference_mappings_tenant_account_unique UNIQUE (tenant_id, account_id),
  CONSTRAINT provider_preference_mappings_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX provider_preference_mappings_tenant_idx
  ON provider_preference_mappings (tenant_id, position);

-- ---------------------------------------------------------------------------
-- The append-only change-event audit (change-anytime proof)
-- ---------------------------------------------------------------------------

CREATE TABLE provider_preference_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  event text NOT NULL CHECK (event IN ('preference-saved', 'preference-applied', 'technical-override')),
  preference text CHECK (preference IS NULL OR preference IN (
    'privacy-first', 'lowest-cost', 'fastest', 'most-reliable', 'balanced'
  )),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 2000),
  detail jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object'),
  actor text NOT NULL CHECK (actor <> ''),
  occurred_at timestamptz NOT NULL,
  CONSTRAINT provider_preference_events_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX provider_preference_events_tenant_idx
  ON provider_preference_events (tenant_id, occurred_at DESC);

-- Storage-level immutability: the audit trail is append-only history
-- (W091 acceptance — preference changes are audited, never rewritten).

CREATE OR REPLACE FUNCTION provider_preferences_append_only_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'provider preferences % is append-only history (W091 provider choice UX): % is forbidden on table %',
    TG_TABLE_NAME, TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER provider_preference_events_immutable
  BEFORE UPDATE OR DELETE ON provider_preference_events
  FOR EACH ROW EXECUTE FUNCTION provider_preferences_append_only_guard();
CREATE TRIGGER provider_preference_events_immutable_truncate
  BEFORE TRUNCATE ON provider_preference_events
  FOR EACH STATEMENT EXECUTE FUNCTION provider_preferences_append_only_guard();
