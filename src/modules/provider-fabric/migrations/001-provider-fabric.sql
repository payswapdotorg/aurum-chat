-- W132 · provider-fabric module — the canonical tenant-scoped provider /
-- model registry: provider definitions, model catalog entries, model
-- discovery states, model bindings and provider health states.
--
-- Architecture laws baked into the schema (spec/ARCHITECTURE-LOCK.md):
--   * lock 28/30 — no provider is architecturally privileged. A provider
--     appears here only as a tenant-scoped DEFINITION: either a 'known'
--     definition over the W034 LlmProvider vocabulary (the code-owned
--     registry the llm module keeps) or a 'custom' definition over an
--     EXISTING wire protocol. A custom provider NEVER invents a protocol
--     dialect — wire_protocol is CHECK-constrained to the five dialects
--     the W034 adapter set already speaks, and is required exactly when
--     kind = 'custom' (for 'known' rows it stays NULL: the dialect is
--     derived from the code-owned provider→protocol mapping, mirroring
--     how deepseek/groq route through the openai-compatible adapter).
--   * credentials live ONLY in the existing credential-ref mechanism
--     (W034 BYOA accounts + the secret store). No column in this
--     migration stores a credential value — model_bindings carries the
--     OPAQUE account_id reference only, exactly like llm_executions.
--     (The llm_executions discipline: provider-minted / foreign-module
--     references cross boundaries only as opaque ids; no cross-module
--     foreign key is possible because the llm module owns
--     ai_provider_accounts.)
--   * the LLM Gateway (W034) remains the ONLY owner of provider/model
--     execution and routing. Nothing here executes a model; the fabric
--     SUPPLIES definitions/catalogs/bindings to the gateway.
--
-- Audit semantics (the llm_executions discipline):
--   * model_bindings are APPEND-ONLY selection evidence. A binding is
--     superseded, never hard-deleted: the swap path appends the new
--     binding and supersedes the old one inside one transaction, so the
--     tenant's model-selection history — including the two-provider swap
--     evidence the GOVERNANCE "Provider swap evidence" clause demands —
--     survives forever. DELETE and TRUNCATE are rejected by trigger, and
--     an UPDATE may only perform the one-way active→superseded transition
--     (every substantive column is immutable — the destinations module's
--     forward-only guard shape).
--   * provider_health_states are APPEND-ONLY observation evidence (the
--     llm_availability_events discipline): one row per health
--     observation with a monotonic `seq` (the llm_executions `seq`
--     discipline — serial, globally unique, never rewritten). The
--     current health of a definition is the LATEST event; nothing
--     rewrites health history.
--   * model_discovery_states is a per-definition CURRENT-STATE row (the
--     honest "what happened on the last discovery attempt" record);
--     model_catalog_entries is a current-state registry (discovery
--     refreshes it; manual entries are sticky and never silently
--     overwritten).
--
-- One-active-binding-per-purpose: a PARTIAL UNIQUE INDEX enforces that
-- each (tenant, purpose) has at most one 'active' model binding — the
-- "model switching" acceptance is a supersede, never a silent rewrite.
--
-- Tenant scoping (ADR-0001): every table carries tenant_id; every
-- service statement is scoped by the explicit TenantContext, so another
-- tenant's definitions, catalog, discovery state, bindings or health are
-- indistinguishable from missing ones.

CREATE TABLE provider_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('known', 'custom')),
  -- For 'known': the W034 LlmProvider vocabulary value (CHECK-deferred to
  -- the service layer because the vocabulary is code-owned by the llm
  -- module's registry and versions with its adapter set). For 'custom':
  -- a tenant-chosen slug that must NOT collide with that vocabulary.
  provider text NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 64),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 100),
  -- REQUIRED for 'custom' (a custom endpoint); NULL for 'known' (the
  -- adapter's canonical endpoint). No userinfo may ever appear here —
  -- the service rejects credential-bearing URLs before they land.
  base_url text,
  wire_protocol text CHECK (wire_protocol IN (
    'openai-compatible', 'anthropic-compatible', 'google-compatible',
    'mistral-compatible', 'cohere-compatible'
  )),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  -- One definition per provider slug per tenant (one canonical registry:
  -- the tenant's provider space has no duplicates regardless of kind, so
  -- a custom slug can never shadow a known-provider slug either).
  CONSTRAINT provider_definitions_slug_unique UNIQUE (tenant_id, provider),
  CONSTRAINT provider_definitions_kind_shape CHECK (
    (kind = 'custom' AND base_url IS NOT NULL AND wire_protocol IS NOT NULL)
    OR (kind = 'known' AND base_url IS NULL AND wire_protocol IS NULL)
  ),
  CONSTRAINT provider_definitions_base_url_shape CHECK (
    base_url IS NULL
    OR (char_length(base_url) BETWEEN 8 AND 2048 AND base_url ~ '^https?://')
  )
);

CREATE INDEX provider_definitions_tenant_status_idx
  ON provider_definitions (tenant_id, status);

CREATE TABLE model_catalog_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  -- Same-module reference; enforced tenant-scoped at the service layer
  -- (the llm_executions discipline for references — no cross-module FK,
  -- and the definition must belong to the asking tenant).
  definition_id uuid NOT NULL,
  -- Opaque model id the provider's API accepts (lock 16 discipline).
  model_id text NOT NULL CHECK (char_length(model_id) BETWEEN 1 AND 255),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 255),
  -- Subset of the canonical capability vocabulary; EMPTY means "listed by
  -- the provider but capabilities unknown" (honest unknown — never faked
  -- as text-generation by default).
  capabilities text[] NOT NULL DEFAULT '{}'
    CHECK (capabilities <@ ARRAY['text-generation', 'embedding']::text[]),
  origin text NOT NULL CHECK (origin IN ('discovered', 'manual')),
  context_window_tokens integer
    CHECK (context_window_tokens IS NULL OR context_window_tokens BETWEEN 1 AND 2000000000),
  max_output_tokens integer
    CHECK (max_output_tokens IS NULL OR max_output_tokens BETWEEN 0 AND 2000000000),
  price_input_minor_per_million integer
    CHECK (price_input_minor_per_million IS NULL OR price_input_minor_per_million BETWEEN 0 AND 2000000000),
  price_output_minor_per_million integer
    CHECK (price_output_minor_per_million IS NULL OR price_output_minor_per_million BETWEEN 0 AND 2000000000),
  -- Discovery origin only; NULL = unknown / manually registered.
  discovered_at timestamptz,
  registered_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'unavailable')),
  CONSTRAINT model_catalog_entries_unique UNIQUE (tenant_id, definition_id, model_id),
  CONSTRAINT model_catalog_entries_origin_discovered_at CHECK (
    (origin = 'discovered') = (discovered_at IS NOT NULL)
  )
);

CREATE INDEX model_catalog_entries_tenant_definition_idx
  ON model_catalog_entries (tenant_id, definition_id, status);

CREATE TABLE model_discovery_states (
  tenant_id uuid NOT NULL,
  definition_id uuid NOT NULL,
  -- Protocol-derived prior: every supported wire protocol defines a
  -- list-models route; flipped to 'unsupported' when the provider itself
  -- has no such API (observed on the first attempt).
  capability text NOT NULL DEFAULT 'supported'
    CHECK (capability IN ('supported', 'unsupported')),
  last_attempt_at timestamptz,
  last_outcome text NOT NULL DEFAULT 'never-attempted'
    CHECK (last_outcome IN ('succeeded', 'failed', 'never-attempted')),
  -- Sanitized only — never a credential, never a raw provider error dump.
  last_error text CHECK (last_error IS NULL OR char_length(last_error) BETWEEN 1 AND 500),
  discovered_count integer NOT NULL DEFAULT 0 CHECK (discovered_count >= 0),
  CONSTRAINT model_discovery_states_pk PRIMARY KEY (tenant_id, definition_id),
  CONSTRAINT model_discovery_states_never_attempted_shape CHECK (
    (last_outcome = 'never-attempted') = (last_attempt_at IS NULL)
  ),
  CONSTRAINT model_discovery_states_failed_has_error CHECK (
    last_outcome <> 'failed' OR last_error IS NOT NULL
  ),
  CONSTRAINT model_discovery_states_succeeded_no_error CHECK (
    last_outcome <> 'succeeded' OR last_error IS NULL
  )
);

CREATE TABLE model_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Monotonic global position (the llm_executions `seq` discipline) so
  -- the tenant's binding history has a deterministic order.
  seq serial NOT NULL UNIQUE,
  tenant_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('cognition', 'conversation', 'analysis', 'background')),
  definition_id uuid NOT NULL,
  model_id text NOT NULL CHECK (char_length(model_id) BETWEEN 1 AND 255),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
  -- OPAQUE reference to the W034 BYOA account that executes this binding
  -- (the credentialRef is resolved by the llm gateway at execution time —
  -- never by the fabric, never stored here).
  account_id uuid NOT NULL,
  created_by text NOT NULL CHECK (created_by <> ''),
  created_at timestamptz NOT NULL,
  superseded_at timestamptz,
  CONSTRAINT model_bindings_supersede_shape CHECK (
    (status = 'superseded') = (superseded_at IS NOT NULL)
  ),
  CONSTRAINT model_bindings_supersede_after_creation CHECK (
    superseded_at IS NULL OR superseded_at >= created_at
  )
);

-- THE one-active-binding-per-purpose law: a partial unique index, so the
-- swap path MUST supersede before it can attach (storage-level honesty,
-- not just service discipline).
CREATE UNIQUE INDEX model_bindings_one_active_per_purpose
  ON model_bindings (tenant_id, purpose) WHERE status = 'active';

CREATE INDEX model_bindings_tenant_purpose_history_idx
  ON model_bindings (tenant_id, purpose, seq DESC);

CREATE TABLE provider_health_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Monotonic global position (the llm_executions `seq` discipline):
  -- append-only observation evidence, never rewritten.
  seq serial NOT NULL UNIQUE,
  tenant_id uuid NOT NULL,
  definition_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('available', 'unavailable', 'unknown')),
  basis text NOT NULL CHECK (basis IN ('verification', 'execution', 'manual', 'none')),
  -- When the deciding observation happened; NULL only for the initial
  -- 'none' event minted at connect time (never verified = honestly
  -- unknown, never faked as available).
  verified_at timestamptz,
  -- Sanitized only — no credentials, no raw provider error dumps.
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
  observed_by text NOT NULL CHECK (observed_by <> ''),
  created_at timestamptz NOT NULL,
  CONSTRAINT provider_health_states_none_shape CHECK (
    (basis = 'none') = (verified_at IS NULL)
  ),
  CONSTRAINT provider_health_states_none_is_unknown CHECK (
    basis <> 'none' OR state = 'unknown'
  )
);

CREATE INDEX provider_health_states_tenant_definition_idx
  ON provider_health_states (tenant_id, definition_id, seq DESC);

-- Storage-level immutability #1: model bindings are append-only selection
-- evidence; only the one-way active→superseded transition may touch a row.

CREATE OR REPLACE FUNCTION model_bindings_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'model bindings are append-only selection evidence (W132 provider fabric): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'model bindings are append-only selection evidence (W132 provider fabric): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.seq <> OLD.seq
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.purpose <> OLD.purpose
     OR NEW.definition_id <> OLD.definition_id
     OR NEW.model_id <> OLD.model_id
     OR NEW.account_id <> OLD.account_id
     OR NEW.created_by <> OLD.created_by
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'model bindings are append-only selection evidence (W132 provider fabric): only the one-way active-to-superseded transition may change a row on table %',
      TG_TABLE_NAME;
  END IF;
  IF NOT (OLD.status = 'active' AND NEW.status = 'superseded'
          AND OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL) THEN
    RAISE EXCEPTION 'model bindings move one way only (W132 provider fabric): status may not go from ''%'' to ''%'' on table %',
      OLD.status, NEW.status, TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER model_bindings_one_way_updates
  BEFORE UPDATE OR DELETE ON model_bindings
  FOR EACH ROW EXECUTE FUNCTION model_bindings_guard();

CREATE TRIGGER model_bindings_immutable_truncate
  BEFORE TRUNCATE ON model_bindings
  FOR EACH STATEMENT EXECUTE FUNCTION model_bindings_guard();

-- Storage-level immutability #2: provider health states are append-only
-- observation evidence — no UPDATE, DELETE or TRUNCATE, ever (the
-- llm_executions trigger discipline).

CREATE OR REPLACE FUNCTION provider_health_states_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'provider health states are append-only observation evidence (W132 provider fabric): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER provider_health_states_immutable
  BEFORE UPDATE OR DELETE ON provider_health_states
  FOR EACH ROW EXECUTE FUNCTION provider_health_states_reject_mutation();

CREATE TRIGGER provider_health_states_immutable_truncate
  BEFORE TRUNCATE ON provider_health_states
  FOR EACH STATEMENT EXECUTE FUNCTION provider_health_states_reject_mutation();
