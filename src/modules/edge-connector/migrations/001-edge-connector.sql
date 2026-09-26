-- W088 · edge-connector module — the Aurum Edge Connector: a
-- customer-controlled runtime that executes jobs against private/on-prem
-- systems (APIs, MCP, OpenAPI, databases, file shares, approved browser
-- adapters) WITHOUT those systems' objects crossing the Aurum gateway.
-- The gateway sees only: canonical SIGNED job envelopes out, canonical
-- normalized results back.
--
-- Every table carries tenant_id (ADR-0001; scripts/check-architecture.ts
-- rule d). NO SECOND ORGANIZATIONAL TRUTH STORE: everything durable
-- lives here, in Aurum's PostgreSQL — edge registrations, signed job
-- records + their lifecycle events, health/status events, allowlist
-- audit. The edge holds nothing but in-flight scratch.
--
-- No credential VALUE ever reaches any of these tables: the edge token
-- is stored only as its SHA-256 digest; job envelopes carry only the
-- OPAQUE credentialRef (the edge resolves it against its own local
-- secret store — GOVERNANCE mandatory invariant; the W082 discipline).
--
-- The `edge_key` / `system_class` columns are deliberately OPEN
-- vocabularies (shape-checked only, never closed CHECKs — the
-- connection-broker module's open-broker discipline): wiring a new
-- private-system class or a new edge must require no migration.
--
-- State model (mirrored by the shapes):
--   * edge_registrations    — the broker-connection-CLASS record of one
--                             customer-controlled edge runtime
--                             (active → retired; heartbeat/report/stats
--                             columns move, identity columns are frozen).
--   * edge_allowlist_events — the append-only allowlist audit (every
--                             added/removed capability key).
--   * edge_health_events    — the append-only status events
--                             (registered/retired/heartbeat/
--                             allowlist-changed) — a silent edge renders
--                             'stale' from these + last_seen_at.
--   * edge_jobs             — the SIGNED tenant-scoped job records
--                             (pending → claimed → succeeded | failed |
--                             refused; failed re-drives on idempotency
--                             replay; expired claims revert to pending).
--   * edge_job_events       — the append-only job lifecycle audit
--                             (created/claimed/reclaimed/succeeded/
--                             failed/refused/replayed/redriven).

-- ---------------------------------------------------------------------------
-- Edge registrations — the customer-controlled runtime record
-- ---------------------------------------------------------------------------

CREATE TABLE edge_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  -- The edge's key (open vocabulary, shape-checked only).
  edge_key text NOT NULL CHECK (edge_key ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 200),
  -- The private-system class (open vocabulary: api/mcp/openapi/database/
  -- file-share/browser/… — shape-checked only, never a closed CHECK).
  system_class text NOT NULL CHECK (system_class ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  -- The version declared at registration.
  version text NOT NULL CHECK (version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  -- The recorded capability allowlist + its digest (audited below).
  allowlist jsonb NOT NULL CHECK (jsonb_typeof(allowlist) = 'array'),
  allowlist_digest text NOT NULL CHECK (allowlist_digest ~ '^[0-9a-f]{64}$'),
  -- The edge token's SHA-256 DIGEST (the VALUE lives only on the edge).
  token_digest text NOT NULL CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  -- Heartbeat/report columns (moved by reportEdgeHeartbeat).
  last_seen_at timestamptz,
  reported_version text,
  reported_allowlist_digest text CHECK (
    reported_allowlist_digest IS NULL OR reported_allowlist_digest ~ '^[0-9a-f]{64}$'
  ),
  -- Gateway-measured counters (claims and terminal reports observed here).
  jobs_claimed integer NOT NULL DEFAULT 0 CHECK (jobs_claimed >= 0),
  jobs_succeeded integer NOT NULL DEFAULT 0 CHECK (jobs_succeeded >= 0),
  jobs_failed integer NOT NULL DEFAULT 0 CHECK (jobs_failed >= 0),
  jobs_refused integer NOT NULL DEFAULT 0 CHECK (jobs_refused >= 0),
  last_job_at timestamptz,
  created_by text NOT NULL CHECK (created_by <> ''),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT edge_registrations_key_unique UNIQUE (tenant_id, edge_key),
  CONSTRAINT edge_registrations_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX edge_registrations_tenant_status_idx
  ON edge_registrations (tenant_id, status, created_at DESC);

-- ---------------------------------------------------------------------------
-- Allowlist events — append-only audit of every allowlist change
-- ---------------------------------------------------------------------------

CREATE TABLE edge_allowlist_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  edge_id uuid NOT NULL,
  change text NOT NULL CHECK (change IN ('added', 'removed')),
  capability_key text NOT NULL CHECK (char_length(capability_key) BETWEEN 3 AND 128),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
  recorded_by text NOT NULL CHECK (recorded_by <> ''),
  occurred_at timestamptz NOT NULL,
  -- Monotonic per-EDGE position: the service clock can hold still within
  -- one operation (test-controllable time), so the audit feed orders by
  -- (occurred_at DESC, position DESC) deterministically (the
  -- deep_action_events.position discipline).
  position integer NOT NULL CHECK (position >= 1),
  CONSTRAINT edge_allowlist_events_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX edge_allowlist_events_edge_idx
  ON edge_allowlist_events (tenant_id, edge_id, occurred_at DESC, position DESC);

-- ---------------------------------------------------------------------------
-- Health events — append-only status events (health/version evidence)
-- ---------------------------------------------------------------------------

CREATE TABLE edge_health_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  edge_id uuid NOT NULL,
  event text NOT NULL CHECK (event IN ('registered', 'retired', 'heartbeat', 'allowlist-changed')),
  -- The edge-REPORTED version (registered/heartbeat rows).
  version text CHECK (version IS NULL OR version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'),
  -- The edge-REPORTED allowlist digest (registered/heartbeat rows).
  allowlist_digest text CHECK (allowlist_digest IS NULL OR allowlist_digest ~ '^[0-9a-f]{64}$'),
  -- The edge-REPORTED last-job stats (heartbeat rows only).
  stats jsonb CHECK (stats IS NULL OR jsonb_typeof(stats) = 'object'),
  detail text CHECK (detail IS NULL OR char_length(detail) BETWEEN 1 AND 500),
  recorded_by text NOT NULL CHECK (recorded_by <> ''),
  occurred_at timestamptz NOT NULL,
  -- Monotonic per-EDGE position: deterministic feed order even while
  -- the service clock holds still (the deep_action_events.position
  -- discipline — tenant-scoped data, no global sequence namespace).
  position integer NOT NULL CHECK (position >= 1),
  CONSTRAINT edge_health_events_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT edge_health_events_heartbeat_shape CHECK (
    event <> 'heartbeat'
    OR (version IS NOT NULL AND allowlist_digest IS NOT NULL AND stats IS NOT NULL)
  )
);

CREATE INDEX edge_health_events_edge_idx
  ON edge_health_events (tenant_id, edge_id, occurred_at DESC, position DESC);

-- ---------------------------------------------------------------------------
-- Edge jobs — the SIGNED tenant-scoped job records
-- ---------------------------------------------------------------------------

CREATE TABLE edge_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  -- The idempotency key: first write wins; a TERMINAL job replays its
  -- recorded result verbatim (never a second external effect); a
  -- 'failed' job re-drives (no external effect was taken).
  job_key text NOT NULL CHECK (char_length(job_key) BETWEEN 2 AND 200),
  edge_id uuid NOT NULL,
  edge_key text NOT NULL CHECK (edge_key ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  kind text NOT NULL CHECK (kind IN ('inspect', 'execute')),
  system_class text NOT NULL CHECK (system_class ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  capability_key text NOT NULL CHECK (char_length(capability_key) BETWEEN 3 AND 128),
  -- The frozen, signed envelope (the core W088 contract) + its digest
  -- and signature. The signing key itself is WIRING configuration —
  -- only its reference is recorded.
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  envelope_digest text NOT NULL CHECK (envelope_digest ~ '^[0-9a-f]{64}$'),
  signature text NOT NULL CHECK (signature ~ '^[0-9a-f]{64}$'),
  signer_key_ref text NOT NULL CHECK (char_length(signer_key_ref) BETWEEN 1 AND 64),
  -- Forward-only lifecycle state.
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'claimed', 'succeeded', 'failed', 'refused'
  )),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claimed_by uuid,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  -- The recorded CANONICAL result (terminal only; returned verbatim on
  -- replay). A 'failed' row may carry the transient failed receipt.
  result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  -- Machine-readable codes (shape-checked: a free-text detail or a
  -- secret VALUE can never ride these columns).
  failure_reason text CHECK (failure_reason IS NULL OR failure_reason ~ '^[a-z0-9][a-z0-9._-]{0,62}$'),
  refusal_reason text CHECK (refusal_reason IS NULL OR refusal_reason ~ '^[a-z0-9][a-z0-9._-]{0,62}$'),
  reported_by text,
  reported_at timestamptz,
  created_by text NOT NULL CHECK (created_by <> ''),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT edge_jobs_key_unique UNIQUE (tenant_id, job_key),
  CONSTRAINT edge_jobs_id_tenant_unique UNIQUE (id, tenant_id),
  -- State-shape invariants (the chain, one row at a time).
  CONSTRAINT edge_jobs_pending_shape CHECK (
    status <> 'pending'
    OR (
      claimed_by IS NULL AND claimed_at IS NULL AND lease_expires_at IS NULL
      AND result IS NULL AND failure_reason IS NULL AND refusal_reason IS NULL
      AND reported_by IS NULL AND reported_at IS NULL
    )
  ),
  CONSTRAINT edge_jobs_claimed_shape CHECK (
    status <> 'claimed'
    OR (
      claimed_by IS NOT NULL AND claimed_at IS NOT NULL AND lease_expires_at IS NOT NULL
      AND result IS NULL AND failure_reason IS NULL AND refusal_reason IS NULL
      AND reported_by IS NULL AND reported_at IS NULL
    )
  ),
  CONSTRAINT edge_jobs_succeeded_shape CHECK (
    status <> 'succeeded'
    OR (result IS NOT NULL AND reported_at IS NOT NULL AND reported_by IS NOT NULL
        AND failure_reason IS NULL AND refusal_reason IS NULL)
  ),
  CONSTRAINT edge_jobs_failed_shape CHECK (
    status <> 'failed'
    OR ((result IS NOT NULL OR failure_reason IS NOT NULL) AND reported_at IS NOT NULL
        AND reported_by IS NOT NULL AND refusal_reason IS NULL)
  ),
  CONSTRAINT edge_jobs_refused_shape CHECK (
    status <> 'refused'
    OR (refusal_reason IS NOT NULL AND reported_at IS NOT NULL AND reported_by IS NOT NULL
        AND result IS NULL AND failure_reason IS NULL)
  )
);

CREATE INDEX edge_jobs_tenant_status_idx
  ON edge_jobs (tenant_id, status, created_at DESC);
CREATE INDEX edge_jobs_tenant_edge_idx
  ON edge_jobs (tenant_id, edge_id, status, created_at);

-- ---------------------------------------------------------------------------
-- Edge job events — append-only lifecycle audit
-- ---------------------------------------------------------------------------

CREATE TABLE edge_job_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  job_id uuid NOT NULL,
  -- Monotonic per-job position: the service clock can hold still within
  -- one phase (test-controllable time), so the audit feed orders by
  -- (recorded_at DESC, position DESC) deterministically.
  position integer NOT NULL CHECK (position >= 1),
  event text NOT NULL CHECK (event IN (
    'created', 'claimed', 'reclaimed', 'succeeded', 'failed', 'refused', 'replayed', 'redriven'
  )),
  detail text CHECK (detail IS NULL OR char_length(detail) BETWEEN 1 AND 500),
  recorded_by text NOT NULL CHECK (recorded_by <> ''),
  recorded_at timestamptz NOT NULL,
  CONSTRAINT edge_job_events_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX edge_job_events_job_idx
  ON edge_job_events (tenant_id, job_id, recorded_at DESC, position DESC);

-- ---------------------------------------------------------------------------
-- Storage-level guarantees
-- ---------------------------------------------------------------------------

-- edge_job_events, edge_health_events and edge_allowlist_events are
-- immutable evidence the moment they are recorded: UPDATE, DELETE and
-- TRUNCATE are forbidden outright, even for a caller bypassing the
-- service.

CREATE OR REPLACE FUNCTION edge_connector_append_only_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'edge connector % is append-only evidence (W088 edge connector): % is forbidden on table %',
    TG_TABLE_NAME, TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER edge_job_events_immutable
  BEFORE UPDATE OR DELETE ON edge_job_events
  FOR EACH ROW EXECUTE FUNCTION edge_connector_append_only_guard();
CREATE TRIGGER edge_job_events_immutable_truncate
  BEFORE TRUNCATE ON edge_job_events
  FOR EACH STATEMENT EXECUTE FUNCTION edge_connector_append_only_guard();

CREATE TRIGGER edge_health_events_immutable
  BEFORE UPDATE OR DELETE ON edge_health_events
  FOR EACH ROW EXECUTE FUNCTION edge_connector_append_only_guard();
CREATE TRIGGER edge_health_events_immutable_truncate
  BEFORE TRUNCATE ON edge_health_events
  FOR EACH STATEMENT EXECUTE FUNCTION edge_connector_append_only_guard();

CREATE TRIGGER edge_allowlist_events_immutable
  BEFORE UPDATE OR DELETE ON edge_allowlist_events
  FOR EACH ROW EXECUTE FUNCTION edge_connector_append_only_guard();
CREATE TRIGGER edge_allowlist_events_immutable_truncate
  BEFORE TRUNCATE ON edge_allowlist_events
  FOR EACH STATEMENT EXECUTE FUNCTION edge_connector_append_only_guard();

-- Edge jobs are durable history: DELETE and TRUNCATE are forbidden; the
-- FROZEN contract (id, tenant, key, edge, kind, class, capability,
-- envelope, digest, signature, signer ref, creator, creation) may never
-- move — only the lifecycle state (status, attempts, claim, lease,
-- result, reasons, report, updated_at) transitions forward.

CREATE OR REPLACE FUNCTION edge_jobs_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'edge jobs are durable history (W088 edge connector): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'edge jobs are durable history (W088 edge connector): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.job_key <> OLD.job_key
     OR NEW.edge_id <> OLD.edge_id
     OR NEW.edge_key <> OLD.edge_key
     OR NEW.kind <> OLD.kind
     OR NEW.system_class <> OLD.system_class
     OR NEW.capability_key <> OLD.capability_key
     OR NEW.envelope <> OLD.envelope
     OR NEW.envelope_digest <> OLD.envelope_digest
     OR NEW.signature <> OLD.signature
     OR NEW.signer_key_ref <> OLD.signer_key_ref
     OR NEW.created_by <> OLD.created_by
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'edge jobs are durable history (W088 edge connector): only the lifecycle state (status, attempts, claim, lease, result, reasons, report, updated_at) may change on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER edge_jobs_state_only_updates
  BEFORE UPDATE OR DELETE ON edge_jobs
  FOR EACH ROW EXECUTE FUNCTION edge_jobs_guard();
CREATE TRIGGER edge_jobs_immutable_truncate
  BEFORE TRUNCATE ON edge_jobs
  FOR EACH STATEMENT EXECUTE FUNCTION edge_jobs_guard();

-- Edge registrations are a guarded STATE MACHINE: the identity columns
-- (key, class, token digest, creator, creation) are frozen — a changed
-- key, class or token is a NEW registration (retire + re-register); the
-- label, version, status, allowlist (+digest), heartbeat/report columns
-- and gateway-measured stats may move (their change history lives in
-- the append-only ledgers above).

CREATE OR REPLACE FUNCTION edge_registrations_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'edge registrations are durable records with an audit trail (W088 edge connector): DELETE is forbidden — retire the row instead (table %)',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'edge registrations are durable records with an audit trail (W088 edge connector): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.edge_key <> OLD.edge_key
     OR NEW.system_class <> OLD.system_class
     OR NEW.token_digest <> OLD.token_digest
     OR NEW.created_by <> OLD.created_by
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'edge registrations are durable records with an audit trail (W088 edge connector): only the movable columns (label, version, status, allowlist, heartbeat/report, stats, updated_at) may change on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER edge_registrations_state_only_updates
  BEFORE UPDATE OR DELETE ON edge_registrations
  FOR EACH ROW EXECUTE FUNCTION edge_registrations_guard();
CREATE TRIGGER edge_registrations_immutable_truncate
  BEFORE TRUNCATE ON edge_registrations
  FOR EACH STATEMENT EXECUTE FUNCTION edge_registrations_guard();
