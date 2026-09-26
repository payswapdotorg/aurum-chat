-- W088 repair · migration-name collision (deployment integrity).
--
-- CONTEXT: the pre-W088 era recorded "edge-connector/001-edge-connector.sql" in
-- _migrations while creating a DIFFERENT table set (the __orphaned tables
-- below — all 0 rows in production). The name-based idempotent migrate
-- runner (scripts/migrate.ts: skip when the name is already recorded) then
-- skipped W088's real 001 on EVERY deployment, silently leaving
-- production without this module's schema. Surfaced by the W101
-- deployment-integrity audit (and the /ai/preferences HTTP 500).
--
-- THE REPAIR (idempotent on every environment):
--   1. preserve the orphaned pre-W088 tables/indexes/triggers under
--      __orphaned names (renames only — nothing is dropped, 0 rows anyway);
--   2. create this module's W088 objects with IF NOT EXISTS /
--      guarded triggers, so:
--        * production (001 skipped): this file is the applying path;
--        * fresh environments (001 applied): every statement below no-ops.
--
-- Generated deterministically from 001-edge-connector.sql (see the integration
-- station's repair generator) — the DDL below is byte-faithful to 001 apart
-- from the idempotence transforms.

-- 1a. the jobs SCHEMA collision: the orphan table shares the current name but
--     not the shape (orphan: envelope/system_class/edge_key columns; W088:
--     payload/credential_ref/target). Guarded by column signature.
DO $$
DECLARE has_envelope boolean; has_payload boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='edge_jobs' AND column_name='envelope')
    INTO has_envelope;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='edge_jobs' AND column_name='payload')
    INTO has_payload;
  IF has_envelope AND NOT has_payload THEN
    ALTER TABLE edge_jobs RENAME TO edge_jobs__orphaned_pre_w088;
  END IF;
END $$;

-- 1b. the unambiguous orphans (names the W088 schema never uses).
DO $$
BEGIN
  ALTER TABLE edge_registrations RENAME TO edge_registrations__orphaned_pre_w088;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE edge_allowlist_events RENAME TO edge_allowlist_events__orphaned_pre_w088;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE edge_health_events RENAME TO edge_health_events__orphaned_pre_w088;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE edge_job_events RENAME TO edge_job_events__orphaned_pre_w088;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 2. The W088 schema (idempotent)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS edge_runtimes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  description text
    CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'connected', 'revoked')),
  -- OPAQUE enrollment/signing-key identifier; the key material itself is
  -- wiring-time configuration at the gateway and customer-side at the
  -- edge — NEVER a value in this schema.
  signing_key_id text NOT NULL CHECK (char_length(signing_key_id) BETWEEN 1 AND 64),
  -- Connectivity kinds the runtime is registered to serve (the work
  -- item's surface: private-api, openapi, mcp, database, file-share,
  -- browser).
  connectivity jsonb NOT NULL CHECK (jsonb_typeof(connectivity) = 'array'),
  -- Latest heartbeat-reported version (null before the first report).
  reported_version text
    CHECK (reported_version IS NULL OR char_length(reported_version) BETWEEN 1 AND 64),
  -- Latest heartbeat-reported capabilities (null before the first report).
  reported_capabilities jsonb
    CHECK (reported_capabilities IS NULL OR jsonb_typeof(reported_capabilities) = 'array'),
  -- Derived-health parameters (the staleness window is the honest
  -- degradation threshold for dispatch).
  stale_after_seconds integer NOT NULL DEFAULT 300
    CHECK (stale_after_seconds BETWEEN 30 AND 86400),
  heartbeat_interval_seconds integer NOT NULL DEFAULT 60
    CHECK (heartbeat_interval_seconds BETWEEN 10 AND 86400),
  -- Time of the last VERIFIED heartbeat (health evidence).
  last_seen_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text
    CHECK (revoked_reason IS NULL OR char_length(revoked_reason) BETWEEN 1 AND 2000),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT edge_runtimes_name_tenant_unique UNIQUE (tenant_id, name),
  CONSTRAINT edge_runtimes_id_tenant_unique UNIQUE (id, tenant_id),
  -- A pending runtime has never heartbeated; a connected one has.
  CONSTRAINT edge_runtimes_pending_shape CHECK (
    status <> 'pending' OR last_seen_at IS NULL
  ),
  CONSTRAINT edge_runtimes_connected_shape CHECK (
    status <> 'connected' OR last_seen_at IS NOT NULL
  ),
  -- Only a revoked runtime carries revocation evidence; only it may.
  -- (A runtime revoked before its first heartbeat carries no last_seen.)
  CONSTRAINT edge_runtimes_revoked_shape CHECK (
    status <> 'revoked' OR revoked_at IS NOT NULL
  ),
  CONSTRAINT edge_runtimes_live_no_revocation CHECK (
    status = 'revoked' OR (revoked_at IS NULL AND revoked_reason IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS edge_runtimes_tenant_created_idx
  ON edge_runtimes (tenant_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Capability allowlist — what the edge may execute/see
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS edge_capability_allowlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  edge_id uuid NOT NULL,
  -- The plain-language W081-style capability key (read.*/write.*).
  capability_key text NOT NULL CHECK (char_length(capability_key) BETWEEN 3 AND 128),
  mode text NOT NULL CHECK (mode IN ('read', 'write')),
  -- The connectivity kind the capability rides at the edge.
  connectivity text NOT NULL CHECK (connectivity IN (
    'private-api', 'openapi', 'mcp', 'database', 'file-share', 'browser'
  )),
  -- OPAQUE reference to the secret material the EDGE holds locally (the
  -- value never enters Aurum).
  secret_ref text NOT NULL CHECK (char_length(secret_ref) BETWEEN 1 AND 200),
  -- What the referenced secret may access (plain scope strings).
  secret_scopes jsonb NOT NULL CHECK (jsonb_typeof(secret_scopes) = 'array'),
  created_at timestamptz NOT NULL,
  CONSTRAINT edge_allowlist_edge_key_unique UNIQUE (tenant_id, edge_id, capability_key),
  CONSTRAINT edge_allowlist_id_tenant_unique UNIQUE (id, tenant_id),
  -- The mode must match the key's vocabulary prefix.
  CONSTRAINT edge_allowlist_mode_prefix CHECK (
    (mode = 'read' AND capability_key LIKE 'read.%')
    OR (mode = 'write' AND capability_key LIKE 'write.%')
  )
);

CREATE INDEX IF NOT EXISTS edge_allowlist_tenant_edge_idx
  ON edge_capability_allowlist (tenant_id, edge_id);

-- ---------------------------------------------------------------------------
-- Heartbeats — append-only health/version evidence
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS edge_heartbeats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  edge_id uuid NOT NULL,
  -- Monotonic per-edge position: the service clock can hold still within
  -- one phase (test-controllable time), so the evidence feed orders by
  -- (received_at DESC, position DESC) deterministically.
  position integer NOT NULL CHECK (position >= 1),
  reported_version text NOT NULL CHECK (char_length(reported_version) BETWEEN 1 AND 64),
  reported_capabilities jsonb NOT NULL CHECK (jsonb_typeof(reported_capabilities) = 'array'),
  reported_pending_jobs integer CHECK (reported_pending_jobs IS NULL OR reported_pending_jobs >= 0),
  received_at timestamptz NOT NULL,
  CONSTRAINT edge_heartbeats_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX IF NOT EXISTS edge_heartbeats_tenant_edge_idx
  ON edge_heartbeats (tenant_id, edge_id, received_at DESC, position DESC);

-- ---------------------------------------------------------------------------
-- Jobs — the signed tenant-scoped envelopes and their state
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS edge_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  edge_id uuid NOT NULL,
  -- Caller-supplied dedupe key; a recorded key replays the original job.
  job_key text CHECK (job_key IS NULL OR char_length(job_key) BETWEEN 2 AND 200),
  kind text NOT NULL CHECK (kind IN ('inspect', 'execute')),
  capability_key text NOT NULL CHECK (char_length(capability_key) BETWEEN 3 AND 128),
  target text NOT NULL CHECK (char_length(target) BETWEEN 1 AND 200),
  -- The canonical write payload (null for inspect — a state read).
  payload jsonb CHECK (payload IS NULL OR jsonb_typeof(payload) = 'object'),
  -- OPAQUE credential reference passed straight through for the edge to
  -- resolve locally (values never here — the W082 discipline).
  credential_ref text CHECK (credential_ref IS NULL OR char_length(credential_ref) BETWEEN 1 AND 200),
  -- Advisory plain-language system key.
  system_key text CHECK (system_key IS NULL OR char_length(system_key) BETWEEN 3 AND 312),
  -- Forward-only job state.
  state text NOT NULL DEFAULT 'issued' CHECK (state IN (
    'issued', 'delivered', 'succeeded', 'rejected', 'failed', 'expired'
  )),
  -- The per-job nonce (the replay guard — unique per tenant).
  nonce text NOT NULL CHECK (char_length(nonce) BETWEEN 16 AND 64),
  -- The EXACT canonical material the signature covers (byte-stable; the
  -- edge re-derives and verifies this form).
  canonical_material text NOT NULL CHECK (char_length(canonical_material) BETWEEN 32 AND 300000),
  -- The HMAC-SHA256 signature over the canonical material.
  signature text NOT NULL CHECK (char_length(signature) = 64),
  -- The canonical receipt of a completed job (the W084 taxonomy).
  receipt_status text CHECK (receipt_status IN ('accepted', 'rejected', 'failed')),
  -- The edge's own OPAQUE receipt id.
  receipt_id text CHECK (receipt_id IS NULL OR char_length(receipt_id) BETWEEN 1 AND 200),
  receipt_detail text CHECK (receipt_detail IS NULL OR char_length(receipt_detail) BETWEEN 1 AND 500),
  -- The normalized read state of a completed inspect job — execution
  -- evidence ({found, state}), never a second truth store.
  result_state jsonb CHECK (result_state IS NULL OR jsonb_typeof(result_state) = 'object'),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  delivered_at timestamptz,
  completed_at timestamptz,
  created_by text NOT NULL,
  CONSTRAINT edge_jobs_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT edge_jobs_idem_unique UNIQUE (tenant_id, edge_id, job_key),
  CONSTRAINT edge_jobs_nonce_tenant_unique UNIQUE (tenant_id, nonce),
  -- Kind discipline: an inspect job carries no payload; an execute job
  -- carries one.
  CONSTRAINT edge_jobs_kind_payload_shape CHECK (
    (kind = 'inspect' AND payload IS NULL)
    OR (kind = 'execute' AND payload IS NOT NULL)
  ),
  -- State-shape invariants (the chain, one row at a time).
  CONSTRAINT edge_jobs_issued_shape CHECK (
    state <> 'issued'
    OR (receipt_status IS NULL AND completed_at IS NULL AND delivered_at IS NULL)
  ),
  CONSTRAINT edge_jobs_delivered_shape CHECK (
    state <> 'delivered'
    OR (receipt_status IS NULL AND completed_at IS NULL AND delivered_at IS NOT NULL)
  ),
  CONSTRAINT edge_jobs_succeeded_shape CHECK (
    state <> 'succeeded'
    OR (receipt_status = 'accepted' AND completed_at IS NOT NULL AND delivered_at IS NOT NULL)
  ),
  CONSTRAINT edge_jobs_rejected_shape CHECK (
    state <> 'rejected'
    OR (receipt_status = 'rejected' AND completed_at IS NOT NULL AND delivered_at IS NOT NULL)
  ),
  CONSTRAINT edge_jobs_failed_shape CHECK (
    state <> 'failed'
    OR (receipt_status = 'failed' AND completed_at IS NOT NULL AND delivered_at IS NOT NULL)
  ),
  CONSTRAINT edge_jobs_expired_shape CHECK (
    state <> 'expired' OR (receipt_status IS NULL AND completed_at IS NULL)
  ),
  -- An accepted inspect result always carries its normalized read state.
  CONSTRAINT edge_jobs_inspect_result_shape CHECK (
    kind <> 'inspect' OR state <> 'succeeded' OR result_state IS NOT NULL
  ),
  -- Capability-mode discipline mirrors validation.
  CONSTRAINT edge_jobs_capability_mode CHECK (
    (kind = 'inspect' AND capability_key LIKE 'read.%')
    OR (kind = 'execute' AND capability_key LIKE 'write.%')
  )
);

CREATE INDEX IF NOT EXISTS edge_jobs_tenant_edge_state_idx
  ON edge_jobs (tenant_id, edge_id, state, issued_at DESC);
CREATE INDEX IF NOT EXISTS edge_jobs_tenant_state_idx
  ON edge_jobs (tenant_id, state, issued_at DESC);

-- ---------------------------------------------------------------------------
-- Events — append-only lifecycle audit
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS edge_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  edge_id uuid NOT NULL,
  -- Monotonic per-edge position (deterministic audit ordering).
  position integer NOT NULL CHECK (position >= 1),
  event text NOT NULL CHECK (event IN (
    'registered',
    'allowlist-updated',
    'heartbeat-received',
    'revoked',
    'job-issued',
    'job-delivered',
    'job-succeeded',
    'job-failed',
    'job-rejected',
    'job-expired'
  )),
  detail text CHECK (detail IS NULL OR char_length(detail) BETWEEN 1 AND 500),
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL,
  CONSTRAINT edge_events_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX IF NOT EXISTS edge_events_tenant_edge_idx
  ON edge_events (tenant_id, edge_id, recorded_at DESC, position DESC);

-- ---------------------------------------------------------------------------
-- Dial-home request nonces — single-use authentication material
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS edge_auth_nonces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  edge_id uuid NOT NULL,
  request_nonce text NOT NULL CHECK (char_length(request_nonce) BETWEEN 2 AND 128),
  consumed_at timestamptz NOT NULL,
  CONSTRAINT edge_auth_nonces_edge_nonce_unique UNIQUE (tenant_id, edge_id, request_nonce),
  CONSTRAINT edge_auth_nonces_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX IF NOT EXISTS edge_auth_nonces_tenant_edge_idx
  ON edge_auth_nonces (tenant_id, edge_id, consumed_at DESC);

-- ---------------------------------------------------------------------------
-- Storage-level guarantees
-- ---------------------------------------------------------------------------

-- edge_heartbeats and edge_events: strictly append-only evidence — no
-- UPDATE, DELETE or TRUNCATE, ever. (The job/allowlist/runtime tables
-- legitimately move forward through their lifecycles — they are workflow
-- and enrollment state, not evidence.)

CREATE OR REPLACE FUNCTION edge_append_only_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (W088 edge-connector evidence): % is forbidden on table %',
    TG_TABLE_NAME, TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
CREATE TRIGGER edge_heartbeats_immutable
  BEFORE UPDATE OR DELETE ON edge_heartbeats
  FOR EACH ROW EXECUTE FUNCTION edge_append_only_reject_mutation();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
CREATE TRIGGER edge_heartbeats_immutable_truncate
  BEFORE TRUNCATE ON edge_heartbeats
  FOR EACH STATEMENT EXECUTE FUNCTION edge_append_only_reject_mutation();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
CREATE TRIGGER edge_events_immutable
  BEFORE UPDATE OR DELETE ON edge_events
  FOR EACH ROW EXECUTE FUNCTION edge_append_only_reject_mutation();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
CREATE TRIGGER edge_events_immutable_truncate
  BEFORE TRUNCATE ON edge_events
  FOR EACH STATEMENT EXECUTE FUNCTION edge_append_only_reject_mutation();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
