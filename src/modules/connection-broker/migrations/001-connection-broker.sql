-- W082 · connection-broker module — the universal connection layer:
-- tenant-scoped broker connections (connect/revoke/refresh lifecycle),
-- append-only connection audit events, per-flow sync/webhook checkpoints
-- with append-only history, the append-only delivery ledger (dedupe
-- authority), append-only provider-health evidence (outage localization)
-- and append-only broker hot-swap verification records.
--
-- Every table carries tenant_id (ADR-0001; scripts/check-architecture.ts
-- rule d). Credential VALUES never reach any of these tables: a connection
-- persists only the OPAQUE broker-issued credential_ref plus NON-SECRET
-- authorization state (scopes, expiry); token material lives in the
-- managed broker's credential store (GOVERNANCE mandatory invariant;
-- IMPLEMENTATION-STACK §8).
--
-- The `broker` column is deliberately an OPEN vocabulary (shape-checked
-- only, not a closed CHECK): "a pluggable managed connection broker with
-- Nango as the first candidate and equivalent alternatives" — wiring a new
-- broker adapter must require no migration. The first-party keys are
-- 'nango' and 'embedded' (src/modules/connection-broker/adapters/).
--
-- NOTE: the provider CHECK mirrors BROKER_PROVIDERS in
-- src/modules/connection-broker/validation.ts (the union of the sources
-- and destinations gateways' provider vocabularies, derived from their
-- contracts) — keep both in sync.

-- ---------------------------------------------------------------------------
-- Connections — the universal connection record
-- ---------------------------------------------------------------------------

CREATE TABLE broker_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN (
    'salesforce', 'hubspot', 'zendesk', 'jira', 'linear', 'confluence',
    'notion', 'github', 'google-drive', 'google-calendar', 'stripe',
    'quickbooks', 'zapier', 'looker', 'tableau', 'power-bi', 'snowflake',
    'bigquery', 'redshift', 'netsuite', 'google-sheets', 'airtable',
    'http-api', 'webhook'
  )),
  connection_key text NOT NULL
    CHECK (char_length(connection_key) BETWEEN 1 AND 128),
  display_name text
    CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 200),
  -- Pluggable broker adapter key (open vocabulary — see the header note).
  broker text NOT NULL CHECK (char_length(broker) BETWEEN 1 AND 64),
  broker_connection_id text
    CHECK (broker_connection_id IS NULL OR char_length(broker_connection_id) BETWEEN 1 AND 255),
  provider_account_id text
    CHECK (provider_account_id IS NULL OR char_length(provider_account_id) BETWEEN 1 AND 255),
  -- OPAQUE broker credential-store reference (never a credential value).
  credential_ref text
    CHECK (credential_ref IS NULL OR char_length(credential_ref) BETWEEN 1 AND 255),
  requested_scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  oauth_scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  oauth_expires_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'connected', 'revoked', 'failed')),
  authorization_state text
    CHECK (authorization_state IS NULL OR char_length(authorization_state) BETWEEN 1 AND 255),
  authorization_expires_at timestamptz,
  -- Opaque soft references validated through the owning modules' contracts
  -- at initiation (W081 inventory, W036 sources, W037 destinations).
  inventory_system_id uuid,
  bind_source_id uuid,
  bind_destination_id uuid,
  last_refreshed_at timestamptz,
  revoked_by text,
  revoked_at timestamptz,
  revocation_note text
    CHECK (revocation_note IS NULL OR char_length(revocation_note) BETWEEN 1 AND 2000),
  created_by text NOT NULL CHECK (created_by <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT broker_connections_key_unique UNIQUE (tenant_id, provider, connection_key),
  CONSTRAINT broker_connections_account_unique UNIQUE (tenant_id, provider, provider_account_id),
  CONSTRAINT broker_connections_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT broker_connections_scopes_shape CHECK (
    jsonb_typeof(requested_scopes) = 'array'
    AND jsonb_array_length(requested_scopes) <= 32
    AND jsonb_typeof(oauth_scopes) = 'array'
    AND jsonb_array_length(oauth_scopes) <= 32
  ),
  -- A connected connection carries its full grant; a pending one carries none.
  CONSTRAINT broker_connections_connected_has_grant CHECK (
    status <> 'connected'
    OR (broker_connection_id IS NOT NULL AND provider_account_id IS NOT NULL AND credential_ref IS NOT NULL)
  ),
  CONSTRAINT broker_connections_pending_has_no_grant CHECK (
    status <> 'pending'
    OR (broker_connection_id IS NULL AND provider_account_id IS NULL AND credential_ref IS NULL)
  ),
  -- The pending hand-off is stateful only while pending.
  CONSTRAINT broker_connections_pending_state CHECK (
    status = 'pending'
    OR (authorization_state IS NULL AND authorization_expires_at IS NULL)
  ),
  -- A revocation keeps its trail together or not at all.
  CONSTRAINT broker_connections_revocation_shape CHECK (
    status <> 'revoked'
    OR (revoked_by IS NOT NULL AND revoked_at IS NOT NULL)
  ),
  CONSTRAINT broker_connections_active_has_no_revocation CHECK (
    status = 'revoked'
    OR (revoked_by IS NULL AND revoked_at IS NULL)
  )
);

CREATE INDEX broker_connections_tenant_provider_idx
  ON broker_connections (tenant_id, provider, status);
CREATE INDEX broker_connections_tenant_created_idx
  ON broker_connections (tenant_id, created_at DESC);
CREATE INDEX broker_connections_tenant_broker_idx
  ON broker_connections (tenant_id, broker);
-- One connection binds at most one source / one destination connector.
CREATE UNIQUE INDEX broker_connections_bind_source_unique
  ON broker_connections (tenant_id, bind_source_id) WHERE bind_source_id IS NOT NULL;
CREATE UNIQUE INDEX broker_connections_bind_destination_unique
  ON broker_connections (tenant_id, bind_destination_id) WHERE bind_destination_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Connection events — append-only lifecycle audit
-- ---------------------------------------------------------------------------

CREATE TABLE broker_connection_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  event text NOT NULL CHECK (event IN (
    'connect_initiated', 'connected', 'connect_failed', 'refreshed', 'revoked'
  )),
  broker text NOT NULL CHECK (char_length(broker) BETWEEN 1 AND 64),
  detail text
    CHECK (detail IS NULL OR char_length(detail) BETWEEN 1 AND 500),
  recorded_by text NOT NULL CHECK (recorded_by <> ''),
  recorded_at timestamptz NOT NULL,
  CONSTRAINT broker_connection_events_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX broker_connection_events_connection_idx
  ON broker_connection_events (tenant_id, connection_id, recorded_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- Checkpoints — live per-flow state + append-only history
-- ---------------------------------------------------------------------------

CREATE TABLE broker_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  flow text NOT NULL CHECK (flow IN ('sync', 'webhook')),
  cursor text CHECK (cursor IS NULL OR char_length(cursor) BETWEEN 1 AND 1024),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT broker_checkpoints_flow_unique UNIQUE (tenant_id, connection_id, flow),
  CONSTRAINT broker_checkpoints_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE TABLE broker_checkpoint_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  flow text NOT NULL CHECK (flow IN ('sync', 'webhook')),
  cursor text CHECK (cursor IS NULL OR char_length(cursor) BETWEEN 1 AND 1024),
  origin text NOT NULL CHECK (origin IN ('sync', 'webhook', 'replay')),
  recorded_by text NOT NULL CHECK (recorded_by <> ''),
  recorded_at timestamptz NOT NULL,
  CONSTRAINT broker_checkpoint_history_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX broker_checkpoint_history_connection_idx
  ON broker_checkpoint_history (tenant_id, connection_id, flow, recorded_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- Delivery ledger — the dedupe authority (append-only claims)
-- ---------------------------------------------------------------------------

CREATE TABLE broker_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  provider_record_id text NOT NULL
    CHECK (char_length(provider_record_id) BETWEEN 1 AND 255),
  ingested_via text NOT NULL CHECK (ingested_via IN ('sync', 'webhook')),
  claimed_at timestamptz NOT NULL,
  CONSTRAINT broker_records_connection_record_unique
    UNIQUE (tenant_id, connection_id, provider_record_id),
  CONSTRAINT broker_records_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX broker_records_connection_idx
  ON broker_records (tenant_id, connection_id, claimed_at DESC);

-- ---------------------------------------------------------------------------
-- Provider health — append-only observed outage/recovery evidence
-- ---------------------------------------------------------------------------

CREATE TABLE broker_provider_health_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq serial NOT NULL UNIQUE,
  tenant_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN (
    'salesforce', 'hubspot', 'zendesk', 'jira', 'linear', 'confluence',
    'notion', 'github', 'google-drive', 'google-calendar', 'stripe',
    'quickbooks', 'zapier', 'looker', 'tableau', 'power-bi', 'snowflake',
    'bigquery', 'redshift', 'netsuite', 'google-sheets', 'airtable',
    'http-api', 'webhook'
  )),
  broker text NOT NULL CHECK (char_length(broker) BETWEEN 1 AND 64),
  state text NOT NULL CHECK (state IN ('available', 'degraded', 'unavailable')),
  -- The canonical failure category (W089 taxonomy) that caused the state;
  -- NULL only on 'available' (recovery) events.
  category text CHECK (category IS NULL OR category IN (
    'auth_failure', 'permission_denied', 'quota_exhausted', 'rate_limited',
    'provider_unavailable', 'timeout', 'malformed_response',
    'unsupported_capability', 'invalid_request', 'canceled', 'unknown_failure'
  )),
  reason text
    CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 500),
  source text NOT NULL CHECK (source IN ('execution', 'manual')),
  expires_at timestamptz,
  observed_at timestamptz NOT NULL,
  observed_by text NOT NULL CHECK (observed_by <> ''),
  CONSTRAINT broker_provider_health_events_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT broker_provider_health_events_category_required CHECK (
    state = 'available' OR category IS NOT NULL
  ),
  CONSTRAINT broker_provider_health_events_available_never_expires CHECK (
    state <> 'available' OR expires_at IS NULL
  )
);

CREATE INDEX broker_provider_health_events_current_idx
  ON broker_provider_health_events (tenant_id, provider, broker, seq DESC);

-- ---------------------------------------------------------------------------
-- Broker hot-swap verifications — append-only swap evidence
-- ---------------------------------------------------------------------------

CREATE TABLE broker_hot_swap_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  capability text NOT NULL CHECK (capability = 'connection-sync'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  provider text NOT NULL CHECK (provider IN (
    'salesforce', 'hubspot', 'zendesk', 'jira', 'linear', 'confluence',
    'notion', 'github', 'google-drive', 'google-calendar', 'stripe',
    'quickbooks', 'zapier', 'looker', 'tableau', 'power-bi', 'snowflake',
    'bigquery', 'redshift', 'netsuite', 'google-sheets', 'airtable',
    'http-api', 'webhook'
  )),
  broker_a text NOT NULL CHECK (char_length(broker_a) BETWEEN 1 AND 64),
  connection_a uuid NOT NULL,
  result_a text NOT NULL
    CHECK (result_a ~ '^[0-9a-f]{64}$' OR result_a = 'failed'),
  broker_b text NOT NULL CHECK (char_length(broker_b) BETWEEN 1 AND 64),
  connection_b uuid NOT NULL,
  result_b text NOT NULL
    CHECK (result_b ~ '^[0-9a-f]{64}$' OR result_b = 'failed'),
  outcome text NOT NULL CHECK (outcome IN ('equivalent', 'completed-divergent', 'failed')),
  note text
    CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
  requested_by text NOT NULL CHECK (requested_by <> ''),
  verified_at timestamptz NOT NULL,
  CONSTRAINT broker_hot_swap_verifications_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT broker_hot_swap_verifications_targets_differ CHECK (broker_a <> broker_b)
);

CREATE INDEX broker_hot_swap_verifications_tenant_idx
  ON broker_hot_swap_verifications (tenant_id, verified_at DESC);

-- ---------------------------------------------------------------------------
-- Storage-level guarantees
-- ---------------------------------------------------------------------------

-- broker_checkpoints: live ingestion state — only the cursor (and
-- updated_at) may move; the row can never be repointed or deleted (the
-- history table is the trail; this row is the live state).

CREATE OR REPLACE FUNCTION broker_checkpoints_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'broker checkpoints are live flow state (W082 connection-broker): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'broker checkpoints are live flow state (W082 connection-broker): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.connection_id <> OLD.connection_id
     OR NEW.flow <> OLD.flow THEN
    RAISE EXCEPTION 'broker checkpoints are live flow state (W082 connection-broker): only the cursor and updated_at may change on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER broker_checkpoints_state_only_updates
  BEFORE UPDATE OR DELETE ON broker_checkpoints
  FOR EACH ROW EXECUTE FUNCTION broker_checkpoints_guard();

CREATE TRIGGER broker_checkpoints_immutable_truncate
  BEFORE TRUNCATE ON broker_checkpoints
  FOR EACH STATEMENT EXECUTE FUNCTION broker_checkpoints_guard();

-- broker_checkpoint_history / broker_connection_events /
-- broker_records / broker_provider_health_events /
-- broker_hot_swap_verifications: strictly append-only audit and evidence —
-- no UPDATE, DELETE or TRUNCATE, ever.

CREATE OR REPLACE FUNCTION broker_append_only_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (W082 connection-broker audit/evidence): % is forbidden on table %',
    TG_TABLE_NAME, TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER broker_checkpoint_history_immutable
  BEFORE UPDATE OR DELETE ON broker_checkpoint_history
  FOR EACH ROW EXECUTE FUNCTION broker_append_only_reject_mutation();
CREATE TRIGGER broker_checkpoint_history_immutable_truncate
  BEFORE TRUNCATE ON broker_checkpoint_history
  FOR EACH STATEMENT EXECUTE FUNCTION broker_append_only_reject_mutation();

CREATE TRIGGER broker_connection_events_immutable
  BEFORE UPDATE OR DELETE ON broker_connection_events
  FOR EACH ROW EXECUTE FUNCTION broker_append_only_reject_mutation();
CREATE TRIGGER broker_connection_events_immutable_truncate
  BEFORE TRUNCATE ON broker_connection_events
  FOR EACH STATEMENT EXECUTE FUNCTION broker_append_only_reject_mutation();

CREATE TRIGGER broker_records_immutable
  BEFORE UPDATE OR DELETE ON broker_records
  FOR EACH ROW EXECUTE FUNCTION broker_append_only_reject_mutation();
CREATE TRIGGER broker_records_immutable_truncate
  BEFORE TRUNCATE ON broker_records
  FOR EACH STATEMENT EXECUTE FUNCTION broker_append_only_reject_mutation();

CREATE TRIGGER broker_provider_health_events_immutable
  BEFORE UPDATE OR DELETE ON broker_provider_health_events
  FOR EACH ROW EXECUTE FUNCTION broker_append_only_reject_mutation();
CREATE TRIGGER broker_provider_health_events_immutable_truncate
  BEFORE TRUNCATE ON broker_provider_health_events
  FOR EACH STATEMENT EXECUTE FUNCTION broker_append_only_reject_mutation();

CREATE TRIGGER broker_hot_swap_verifications_immutable
  BEFORE UPDATE OR DELETE ON broker_hot_swap_verifications
  FOR EACH ROW EXECUTE FUNCTION broker_append_only_reject_mutation();
CREATE TRIGGER broker_hot_swap_verifications_immutable_truncate
  BEFORE TRUNCATE ON broker_hot_swap_verifications
  FOR EACH STATEMENT EXECUTE FUNCTION broker_append_only_reject_mutation();
