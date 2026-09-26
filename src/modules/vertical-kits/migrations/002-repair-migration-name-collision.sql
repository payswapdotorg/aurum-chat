-- W092 repair · migration-name collision (deployment integrity).
--
-- CONTEXT: the pre-W092 era recorded "vertical-kits/001-vertical-kits.sql" in
-- _migrations while creating a DIFFERENT table set (the __orphaned tables
-- below — all 0 rows in production). The name-based idempotent migrate
-- runner (scripts/migrate.ts: skip when the name is already recorded) then
-- skipped W092's real 001 on EVERY deployment, silently leaving
-- production without this module's schema. Surfaced by the W101
-- deployment-integrity audit (and the /ai/preferences HTTP 500).
--
-- THE REPAIR (idempotent on every environment):
--   1. preserve the orphaned pre-W092 tables/indexes/triggers under
--      __orphaned names (renames only — nothing is dropped, 0 rows anyway);
--   2. create this module's W092 objects with IF NOT EXISTS /
--      guarded triggers, so:
--        * production (001 skipped): this file is the applying path;
--        * fresh environments (001 applied): every statement below no-ops.
--
-- Generated deterministically from 001-vertical-kits.sql (see the integration
-- station's repair generator) — the DDL below is byte-faithful to 001 apart
-- from the idempotence transforms.

-- 1a. the events SCHEMA collision: the orphan shares the name, not the shape
--     (orphan: kit_key/event_type/from_version columns; W092:
--     installation_id/position/recorded_by). Guarded by column signature.
DO $$
DECLARE has_kit_key boolean; has_position boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='vertical_kit_events' AND column_name='kit_key')
    INTO has_kit_key;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='vertical_kit_events' AND column_name='position')
    INTO has_position;
  IF has_kit_key AND NOT has_position THEN
    ALTER TABLE vertical_kit_events RENAME TO vertical_kit_events__orphaned_pre_w092;
  END IF;
END $$;

-- 1b. the renamed orphan keeps its trigger NAME — rename it so the
--     current-name trigger below lands on the RIGHT table.
--     (fresh environments: the orphan table never exists — the missing
--     TABLE raises undefined_table 42P01, the missing TRIGGER only
--     undefined_object 42704 — both must be swallowed so the guard no-ops.)
DO $$
BEGIN
  ALTER TRIGGER vertical_kit_events_immutable ON vertical_kit_events__orphaned_pre_w092
    RENAME TO vertical_kit_events_immutable__orphaned_pre_w092;
EXCEPTION WHEN undefined_object OR undefined_table THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TRIGGER vertical_kit_events_immutable_truncate ON vertical_kit_events__orphaned_pre_w092
    RENAME TO vertical_kit_events_immutable_truncate__orphaned_pre_w092;
EXCEPTION WHEN undefined_object OR undefined_table THEN NULL;
END $$;

-- 1c. the grants SCHEMA collision (orphan: install_id/extension_key columns;
--     W092: installation_id/capability_key). Guarded by column signature.
DO $$
DECLARE has_install_id boolean; has_installation_id boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='vertical_kit_grants' AND column_name='install_id')
    INTO has_install_id;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='vertical_kit_grants' AND column_name='installation_id')
    INTO has_installation_id;
  IF has_install_id AND NOT has_installation_id THEN
    ALTER TABLE vertical_kit_grants RENAME TO vertical_kit_grants__orphaned_pre_w092;
  END IF;
END $$;
DO $$
BEGIN
  ALTER TRIGGER vertical_kit_grants_immutable ON vertical_kit_grants__orphaned_pre_w092
    RENAME TO vertical_kit_grants_immutable__orphaned_pre_w092;
EXCEPTION WHEN undefined_object OR undefined_table THEN NULL;
END $$;

-- 1d. the unambiguous orphans.
DO $$
BEGIN
  ALTER TABLE vertical_kit_installs RENAME TO vertical_kit_installs__orphaned_pre_w092;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE vertical_kit_recipe_references RENAME TO vertical_kit_recipe_references__orphaned_pre_w092;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 2. The W092 schema (idempotent)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS vertical_kit_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  kit_key text NOT NULL CHECK (char_length(kit_key) BETWEEN 3 AND 128),
  version text NOT NULL CHECK (char_length(version) BETWEEN 5 AND 32),
  -- Parsed semver parts (numeric ordering — never text order).
  version_major integer NOT NULL CHECK (version_major >= 0),
  version_minor integer NOT NULL CHECK (version_minor >= 0),
  version_patch integer NOT NULL CHECK (version_patch >= 0),
  -- The versioned manifest FORMAT this manifest obeys.
  kit_schema_version integer NOT NULL CHECK (kit_schema_version = 1),
  vertical_key text NOT NULL CHECK (char_length(vertical_key) BETWEEN 2 AND 64),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 2000),
  -- The frozen manifest content (everything vertical lives here).
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  -- The sha-256 hex digest of the canonical JSON of the manifest — the
  -- signed-manifest integrity signature.
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  capability_count integer NOT NULL CHECK (capability_count BETWEEN 1 AND 32),
  extension_count integer NOT NULL CHECK (extension_count BETWEEN 0 AND 16),
  agent_count integer NOT NULL CHECK (agent_count BETWEEN 0 AND 16),
  integration_count integer NOT NULL CHECK (integration_count BETWEEN 0 AND 16),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT vertical_kit_versions_version_unique UNIQUE (tenant_id, kit_key, version),
  CONSTRAINT vertical_kit_versions_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX IF NOT EXISTS vertical_kit_versions_tenant_key_idx
  ON vertical_kit_versions (tenant_id, kit_key, version_major DESC, version_minor DESC, version_patch DESC);

-- ---------------------------------------------------------------------------
-- Kit verifications — append-only deterministic runs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS vertical_kit_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  kit_version_id uuid NOT NULL,
  -- Monotonic per-version position (deterministic latest-run derivation
  -- even under a fixed test clock).
  position integer NOT NULL CHECK (position >= 1),
  outcome text NOT NULL CHECK (outcome IN ('verified', 'failed')),
  checks jsonb NOT NULL CHECK (jsonb_typeof(checks) = 'array'),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 2000),
  verifier text NOT NULL,
  ran_at timestamptz NOT NULL,
  CONSTRAINT vertical_kit_verifications_position_unique UNIQUE (tenant_id, kit_version_id, position),
  CONSTRAINT vertical_kit_verifications_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX IF NOT EXISTS vertical_kit_verifications_version_idx
  ON vertical_kit_verifications (tenant_id, kit_version_id, ran_at DESC);

-- ---------------------------------------------------------------------------
-- Installations — the install lifecycle and its W009 gate record
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS vertical_kit_installations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  kit_key text NOT NULL CHECK (char_length(kit_key) BETWEEN 3 AND 128),
  kit_version text NOT NULL CHECK (char_length(kit_version) BETWEEN 5 AND 32),
  -- The registered version this install froze (soft reference).
  kit_version_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN (
    'pending-review', 'rejected', 'granted', 'active', 'suspended', 'removed'
  )),
  -- The frozen required-capability snapshot at install time (the exact
  -- scope the tenant's grant review approved).
  required_capabilities jsonb NOT NULL CHECK (jsonb_typeof(required_capabilities) = 'array'),
  -- The actions module's ActionRequest id — the W009 gate record the
  -- install review routed through (always set: install routes the gate
  -- in the same transaction).
  action_request_id uuid NOT NULL,
  installed_by text NOT NULL,
  installed_at timestamptz NOT NULL,
  reviewed_at timestamptz,
  activated_at timestamptz,
  suspended_at timestamptz,
  removed_at timestamptz,
  removal_reason text CHECK (
    removal_reason IS NULL OR char_length(removal_reason) BETWEEN 1 AND 2000
  ),
  CONSTRAINT vertical_kit_installations_id_tenant_unique UNIQUE (id, tenant_id),
  -- State-shape invariants (the lifecycle, one row at a time):
  -- every state past the review (rejected/granted/active/suspended)
  -- knows its review time; removal knows its removal time; only removal
  -- carries a reason. 'removed' may ALSO carry reviewed_at (removed after
  -- a review) but need not (a pending-review lifecycle withdrawn before
  -- any decision) — removal is not a review.
  CONSTRAINT vertical_kit_installations_reviewed_shape CHECK (
    status IN ('pending-review', 'removed') OR reviewed_at IS NOT NULL
  ),
  CONSTRAINT vertical_kit_installations_removed_shape CHECK (
    status <> 'removed' OR removed_at IS NOT NULL
  ),
  CONSTRAINT vertical_kit_installations_no_removal_while_live CHECK (
    status = 'removed' OR removed_at IS NULL
  ),
  CONSTRAINT vertical_kit_installations_activated_shape CHECK (
    status NOT IN ('active', 'suspended') OR activated_at IS NOT NULL
  ),
  CONSTRAINT vertical_kit_installations_suspended_shape CHECK (
    status <> 'suspended' OR suspended_at IS NOT NULL
  )
);

-- At most ONE live (non-removed) installation per kit per tenant: a
-- fresh lifecycle may only start once the previous one was removed.
CREATE UNIQUE INDEX IF NOT EXISTS vertical_kit_installations_one_live_per_kit
  ON vertical_kit_installations (tenant_id, kit_key) WHERE status <> 'removed';

CREATE INDEX IF NOT EXISTS vertical_kit_installations_tenant_status_idx
  ON vertical_kit_installations (tenant_id, status, installed_at DESC);
CREATE INDEX IF NOT EXISTS vertical_kit_installations_tenant_gate_idx
  ON vertical_kit_installations (tenant_id, action_request_id);

-- ---------------------------------------------------------------------------
-- Grants — the kit-scoped capability authority (minted by an approved
-- review; revoked with the kit)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS vertical_kit_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  capability_key text NOT NULL CHECK (char_length(capability_key) BETWEEN 3 AND 128),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 200),
  data_categories jsonb NOT NULL CHECK (jsonb_typeof(data_categories) = 'array'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  granted_by text NOT NULL,
  granted_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by text,
  revocation_reason text CHECK (
    revocation_reason IS NULL OR char_length(revocation_reason) BETWEEN 1 AND 2000
  ),
  CONSTRAINT vertical_kit_grants_capability_unique UNIQUE (tenant_id, installation_id, capability_key),
  CONSTRAINT vertical_kit_grants_id_tenant_unique UNIQUE (id, tenant_id),
  -- A revoked grant carries its full trail; an active one carries none.
  CONSTRAINT vertical_kit_grants_revoked_shape CHECK (
    status <> 'revoked' OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL)
  ),
  CONSTRAINT vertical_kit_grants_active_shape CHECK (
    status <> 'active' OR (revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS vertical_kit_grants_installation_idx
  ON vertical_kit_grants (tenant_id, installation_id, capability_key);

-- ---------------------------------------------------------------------------
-- Invocations — append-only ledger of EVERY gate verdict
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS vertical_kit_invocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  capability_key text NOT NULL CHECK (char_length(capability_key) BETWEEN 3 AND 128),
  outcome text NOT NULL CHECK (outcome IN ('allowed', 'denied')),
  basis text NOT NULL CHECK (basis IN ('kit-grant', 'grant-missing', 'installation-inactive')),
  denial_reason text CHECK (
    denial_reason IS NULL OR char_length(denial_reason) BETWEEN 1 AND 2000
  ),
  task_context jsonb NOT NULL CHECK (jsonb_typeof(task_context) = 'object'),
  invoked_by text NOT NULL,
  invoked_at timestamptz NOT NULL,
  CONSTRAINT vertical_kit_invocations_id_tenant_unique UNIQUE (id, tenant_id),
  -- An allowed invocation never carries a denial reason; a denied one
  -- always does (the deterministic plain-language reason).
  CONSTRAINT vertical_kit_invocations_allowed_shape CHECK (
    outcome <> 'allowed' OR denial_reason IS NULL
  ),
  CONSTRAINT vertical_kit_invocations_denied_shape CHECK (
    outcome <> 'denied' OR (denial_reason IS NOT NULL AND basis <> 'kit-grant')
  )
);

CREATE INDEX IF NOT EXISTS vertical_kit_invocations_installation_idx
  ON vertical_kit_invocations (tenant_id, installation_id, invoked_at DESC);

-- ---------------------------------------------------------------------------
-- Edge actions — real executions through a wired edge only
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS vertical_kit_edge_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  integration_key text NOT NULL CHECK (char_length(integration_key) BETWEEN 1 AND 64),
  capability_key text NOT NULL CHECK (char_length(capability_key) BETWEEN 3 AND 128),
  -- The ALLOWED gate invocation that authorized this write.
  invocation_id uuid NOT NULL,
  receipt_status text NOT NULL CHECK (receipt_status IN ('accepted', 'rejected', 'failed')),
  receipt_id text CHECK (receipt_id IS NULL OR char_length(receipt_id) BETWEEN 1 AND 200),
  receipt_detail text CHECK (
    receipt_detail IS NULL OR char_length(receipt_detail) BETWEEN 1 AND 500
  ),
  -- The opaque wiring identity of the edge that executed.
  edge_id text NOT NULL CHECK (char_length(edge_id) BETWEEN 1 AND 200),
  executed_by text NOT NULL,
  executed_at timestamptz NOT NULL,
  CONSTRAINT vertical_kit_edge_actions_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX IF NOT EXISTS vertical_kit_edge_actions_installation_idx
  ON vertical_kit_edge_actions (tenant_id, installation_id, executed_at DESC);

-- ---------------------------------------------------------------------------
-- Events — append-only install/configure/remove audit
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS vertical_kit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  -- Monotonic per-installation position: the service clock can hold
  -- still within one transition (test-controllable time), so the audit
  -- feed orders by (recorded_at DESC, position DESC) deterministically.
  position integer NOT NULL CHECK (position >= 1),
  event text NOT NULL CHECK (event IN (
    'installed',
    'review-approved',
    'review-rejected',
    'grant-minted',
    'activated',
    'suspended',
    'resumed',
    'grant-revoked',
    'removed'
  )),
  detail text CHECK (detail IS NULL OR char_length(detail) BETWEEN 1 AND 500),
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL,
  CONSTRAINT vertical_kit_events_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX IF NOT EXISTS vertical_kit_events_installation_idx
  ON vertical_kit_events (tenant_id, installation_id, recorded_at DESC, position DESC);

-- ---------------------------------------------------------------------------
-- Storage-level guarantees
-- ---------------------------------------------------------------------------

-- The append-only ledgers: no UPDATE, DELETE or TRUNCATE, ever. (The
-- version/verification/installation/grant tables legitimately move
-- forward through their lifecycles — they are workflow state, not
-- evidence; the evidence ledgers below never rewrite.)

CREATE OR REPLACE FUNCTION vertical_kits_append_only_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (W092 vertical-kits audit): % is forbidden on table %',
    TG_TABLE_NAME, TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
CREATE TRIGGER vertical_kit_events_immutable
  BEFORE UPDATE OR DELETE ON vertical_kit_events
  FOR EACH ROW EXECUTE FUNCTION vertical_kits_append_only_reject_mutation();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
CREATE TRIGGER vertical_kit_events_immutable_truncate
  BEFORE TRUNCATE ON vertical_kit_events
  FOR EACH STATEMENT EXECUTE FUNCTION vertical_kits_append_only_reject_mutation();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
CREATE TRIGGER vertical_kit_invocations_immutable
  BEFORE UPDATE OR DELETE ON vertical_kit_invocations
  FOR EACH ROW EXECUTE FUNCTION vertical_kits_append_only_reject_mutation();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
CREATE TRIGGER vertical_kit_invocations_immutable_truncate
  BEFORE TRUNCATE ON vertical_kit_invocations
  FOR EACH STATEMENT EXECUTE FUNCTION vertical_kits_append_only_reject_mutation();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
CREATE TRIGGER vertical_kit_verifications_immutable
  BEFORE UPDATE OR DELETE ON vertical_kit_verifications
  FOR EACH ROW EXECUTE FUNCTION vertical_kits_append_only_reject_mutation();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
CREATE TRIGGER vertical_kit_verifications_immutable_truncate
  BEFORE TRUNCATE ON vertical_kit_verifications
  FOR EACH STATEMENT EXECUTE FUNCTION vertical_kits_append_only_reject_mutation();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
