-- W091 repair · migration-name collision (deployment integrity).
--
-- CONTEXT: the pre-W091 era recorded "provider-preferences/001-provider-preferences.sql" in
-- _migrations while creating a DIFFERENT table set (the __orphaned tables
-- below — all 0 rows in production). The name-based idempotent migrate
-- runner (scripts/migrate.ts: skip when the name is already recorded) then
-- skipped W091's real 001 on EVERY deployment, silently leaving
-- production without this module's schema. Surfaced by the W101
-- deployment-integrity audit (and the /ai/preferences HTTP 500).
--
-- THE REPAIR (idempotent on every environment):
--   1. preserve the orphaned pre-W091 tables/indexes/triggers under
--      __orphaned names (renames only — nothing is dropped, 0 rows anyway);
--   2. create this module's W091 objects with IF NOT EXISTS /
--      guarded triggers, so:
--        * production (001 skipped): this file is the applying path;
--        * fresh environments (001 applied): every statement below no-ops.
--
-- Generated deterministically from 001-provider-preferences.sql (see the integration
-- station's repair generator) — the DDL below is byte-faithful to 001 apart
-- from the idempotence transforms.

-- 1a. the events SCHEMA collision: the orphan table shares the current name
--     but not the shape (orphan: preference/summary/actor columns; W091:
--     principal_id/position/recorded_by). Guarded by column signature so a
--     correct-shape table (fresh environments where 001 applied) is NEVER
--     renamed.
DO $$
DECLARE has_summary boolean; has_position boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='provider_preference_events' AND column_name='summary')
    INTO has_summary;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='provider_preference_events' AND column_name='position')
    INTO has_position;
  IF has_summary AND NOT has_position THEN
    ALTER TABLE provider_preference_events RENAME TO provider_preference_events__orphaned_pre_w091;
  END IF;
END $$;

-- 1b. the renamed orphan keeps its index/trigger NAMES — rename them so the
--     current-name objects below can be created on the RIGHT table.
--     (fresh environments: the orphan table never exists — the missing
--     TABLE raises undefined_table 42P01, the missing TRIGGER only
--     undefined_object 42704 — both must be swallowed so the guard no-ops.)
DO $$
BEGIN
  ALTER INDEX provider_preference_events_tenant_idx RENAME TO provider_preference_events_tenant_idx__orphaned_pre_w091;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TRIGGER provider_preference_events_immutable ON provider_preference_events__orphaned_pre_w091
    RENAME TO provider_preference_events_immutable__orphaned_pre_w091;
EXCEPTION WHEN undefined_object OR undefined_table THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TRIGGER provider_preference_events_immutable_truncate ON provider_preference_events__orphaned_pre_w091
    RENAME TO provider_preference_events_immutable_truncate__orphaned_pre_w091;
EXCEPTION WHEN undefined_object OR undefined_table THEN NULL;
END $$;

-- 1c. the unambiguous orphans (names the W091 schema never uses): preserve
--     them under renamed names if they exist.
DO $$
BEGIN
  ALTER TABLE provider_preference_profiles RENAME TO provider_preference_profiles__orphaned_pre_w091;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE provider_preference_mappings RENAME TO provider_preference_mappings__orphaned_pre_w091;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 2. The W091 schema (idempotent)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS provider_preference_settings (
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

CREATE TABLE IF NOT EXISTS provider_personal_preferences (
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

CREATE INDEX IF NOT EXISTS provider_personal_preferences_tenant_idx
  ON provider_personal_preferences (tenant_id, updated_at DESC);

-- ---------------------------------------------------------------------------
-- Technical overrides — the advanced, authorization-gated provider pin
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS provider_technical_overrides (
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

CREATE INDEX IF NOT EXISTS provider_technical_overrides_tenant_status_idx
  ON provider_technical_overrides (tenant_id, status, set_at DESC);

-- ---------------------------------------------------------------------------
-- Selection explanations — the append-only "why this provider?" ledger
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS provider_selection_explanations (
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

CREATE INDEX IF NOT EXISTS provider_selection_explanations_tenant_recent_idx
  ON provider_selection_explanations (tenant_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS provider_selection_explanations_tenant_capability_idx
  ON provider_selection_explanations (tenant_id, capability, recorded_at DESC);

-- ---------------------------------------------------------------------------
-- Events — append-only audit of the module's state changes
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS provider_preference_events (
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

CREATE INDEX IF NOT EXISTS provider_preference_events_tenant_idx
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

DO $$
BEGIN
CREATE TRIGGER provider_preference_events_immutable
  BEFORE UPDATE OR DELETE ON provider_preference_events
  FOR EACH ROW EXECUTE FUNCTION provider_preference_append_only_reject_mutation();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
CREATE TRIGGER provider_preference_events_immutable_truncate
  BEFORE TRUNCATE ON provider_preference_events
  FOR EACH STATEMENT EXECUTE FUNCTION provider_preference_append_only_reject_mutation();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
CREATE TRIGGER provider_selection_explanations_immutable
  BEFORE UPDATE OR DELETE ON provider_selection_explanations
  FOR EACH ROW EXECUTE FUNCTION provider_preference_append_only_reject_mutation();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
CREATE TRIGGER provider_selection_explanations_immutable_truncate
  BEFORE TRUNCATE ON provider_selection_explanations
  FOR EACH STATEMENT EXECUTE FUNCTION provider_preference_append_only_reject_mutation();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
