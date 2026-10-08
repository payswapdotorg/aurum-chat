-- W137 · execution-fabric module — Execution Environment / Agent
-- Computer Fabric (spec/work-items/WORK-ITEM-CATALOG.md §W137).
--
-- The FABRIC that owns execution ENVIRONMENTS: vendor-neutral
-- environment definitions (the frozen W131 kinds/isolation/persistence
-- shapes), the lease/lifecycle state machine binding an environment to
-- an agent-exchange execution run (W136, gated at acquisition), and the
-- append-only evidence tails (events, artifact manifests, evidence
-- records, checkpoints). The catalog's three evaluated paths — local
-- container, Playwright/Chromium, E2B/equivalent remote sandbox — are
-- ADAPTERS behind the frozen kinds; NO vendor identifier is stored in
-- any table below (vendor identity lives on the adapter descriptor's
-- metadata at runtime, never in domain state — the W131 law).
--
-- Load-bearing schema laws:
--   1. DEFINITIONS ARE IMMUTABLE FROM CREATION. A changed definition is
--      a NEW definition under a NEW key (the house law); only the
--      one-way active → retired lifecycle moves, stamping retired_at
--      EXACTLY ONCE. Rows are never deleted or truncated.
--   2. THE LEASE LIFECYCLE IS A ONE-WAY-DOMINANT STATE MACHINE:
--      preparing → live → (suspended ⇄ live) → … with lost as the
--      recoverable park (NOT terminal) and released/cancelled/failed as
--      the terminals. The storage guard mirrors validation.ts's
--      fabricLeaseTransitionProblem (THE single legality definition —
--      defense in depth). Every identity column is immutable; the
--      disposable session id changes ONLY on prepare (NULL→value) and
--      recover (value→fresh value); terminal rows are frozen outright;
--      the lease window may move only while live (heartbeats).
--   3. EVENTS, ARTIFACTS, EVIDENCE AND CHECKPOINTS ARE APPEND-ONLY
--      EVIDENCE (§24 "Audit records are append-only from the domain
--      perspective"). Triggers reject UPDATE/DELETE/TRUNCATE outright.
--   4. ISOLATION IS STRUCTURAL: every lease row carries the literal
--      tenant isolation (tenant_id, ADR-0001) and the definition's
--      credential handling is the LITERAL 'opaque-ref-only' — a secret
--      VALUE has no column to live in anywhere in this schema.
--
-- Cross-module references are opaque forward references, deliberately
-- NOT foreign keys (the house discipline), validated at write time
-- through their owning contracts: the acquiring lease's plan/run refs →
-- agent-exchange (W136: the plan readable and ACTIVE, the execution run
-- readable within it, tenant-owned); the optional takeover
-- authority_action_ref → actions (W009, opaque after write-time shape
-- validation). The adapter reference is the runtime-resolved adapter's
-- opaque instance id (stamped at acquisition; the adapter registry is
-- in-memory wiring, not domain state — removing an adapter never
-- touches these rows, the vendor-removal clause).

-- ---------------------------------------------------------------------------
-- Environment definitions — vendor-neutral, immutable content (law 1)
-- ---------------------------------------------------------------------------

CREATE TABLE environment_definitions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  def_key text NOT NULL
    CHECK (def_key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  display_name text NOT NULL
    CHECK (char_length(display_name) >= 1 AND char_length(display_name) <= 200),
  -- The frozen W131 environment kind (local | browser | workspace |
  -- remote-sandbox). The catalog's "local container" path serves
  -- 'workspace' — a container IS the canonical workspace per W131.
  kind text NOT NULL CHECK (kind IN ('local', 'browser', 'workspace', 'remote-sandbox')),
  -- The isolation properties, frozen verbatim from the W131 contract
  -- shape. tenant_isolated is the LITERAL true and credential_handling
  -- the LITERAL 'opaque-ref-only': both are inexpressible to weaken.
  tenant_isolated boolean NOT NULL DEFAULT true CHECK (tenant_isolated),
  profile_scope text NOT NULL CHECK (profile_scope IN ('session', 'task', 'environment')),
  network_egress text NOT NULL CHECK (network_egress IN ('disabled', 'restricted', 'open')),
  credential_handling text NOT NULL DEFAULT 'opaque-ref-only'
    CHECK (credential_handling = 'opaque-ref-only'),
  -- The persistence policy, frozen verbatim from the W131 contract shape.
  survives_restart boolean NOT NULL,
  checkpoint_level text NOT NULL CHECK (checkpoint_level IN ('none', 'session', 'durable-checkpoint')),
  persistent_scope text
    CHECK (persistent_scope IS NULL OR char_length(persistent_scope) <= 256),
  -- Capability domains a serving adapter must declare supported
  -- (validated against the frozen W131 domain set at write time).
  required_capabilities text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  note text
    CHECK (note IS NULL OR char_length(note) >= 1),
  created_by text NOT NULL CHECK (char_length(created_by) >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  UNIQUE (tenant_id, def_key),
  CHECK (
    (status = 'active' AND retired_at IS NULL)
    OR (status = 'retired' AND retired_at IS NOT NULL)
  )
);

CREATE INDEX environment_definitions_tenant_status_idx
  ON environment_definitions (tenant_id, status);
CREATE INDEX environment_definitions_tenant_kind_idx
  ON environment_definitions (tenant_id, kind);

-- ---------------------------------------------------------------------------
-- Fabric leases — the lifecycle pointer (law 2)
-- ---------------------------------------------------------------------------

CREATE TABLE fabric_leases (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  definition_id uuid NOT NULL,
  -- The W136 orchestration links (validated at acquisition, opaque
  -- after): the ACTIVE plan and the readable execution run.
  plan_id uuid NOT NULL,
  execution_run_id uuid NOT NULL,
  -- Denormalized from the run at acquisition (listing filters).
  task_key text NOT NULL
    CHECK (task_key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  agent_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'preparing'
    CHECK (status IN ('preparing', 'live', 'suspended', 'lost', 'released', 'cancelled', 'failed')),
  -- The runtime-resolved adapter's opaque instance id (never a vendor
  -- NAME — the descriptor's adapterId; stamped at acquisition).
  adapter_id text
    CHECK (adapter_id IS NULL OR (char_length(adapter_id) >= 1 AND char_length(adapter_id) <= 128)),
  -- The disposable adapter session (stamped at prepare; replaced by the
  -- FRESH session at recover — sessions are disposable, the lease is
  -- the durable truth).
  session_id text
    CHECK (session_id IS NULL OR (char_length(session_id) >= 1 AND char_length(session_id) <= 256)),
  -- The OPAQUE credential reference the session materializes from at
  -- prepare (W082 discipline: opaque refs are persisted, secret VALUES
  -- are inexpressible — validated 1..256 chars at acquisition, handed
  -- verbatim to the adapter's open, immutable after).
  credential_ref text
    CHECK (credential_ref IS NULL OR (char_length(credential_ref) >= 1 AND char_length(credential_ref) <= 256)),
  lease_minutes integer NOT NULL CHECK (lease_minutes >= 1 AND lease_minutes <= 1440),
  lease_until timestamptz,
  last_heartbeat_at timestamptz,
  opened_at timestamptz,
  taken_over_at timestamptz,
  takeover_holder text CHECK (takeover_holder IS NULL OR takeover_holder = 'human'),
  takeover_reason text
    CHECK (takeover_reason IS NULL OR char_length(takeover_reason) >= 1),
  -- The opaque W009 consequential-action ref (referenced, never
  -- duplicated — the frozen boundary).
  authority_action_ref uuid,
  handback_at timestamptz,
  handback_note text
    CHECK (handback_note IS NULL OR char_length(handback_note) >= 1),
  cancellation_requested_at timestamptz,
  cancel_reason text
    CHECK (cancel_reason IS NULL OR char_length(cancel_reason) >= 1),
  lost_at timestamptz,
  lost_detail text
    CHECK (lost_detail IS NULL OR char_length(lost_detail) >= 1),
  recovery_detected_at timestamptz,
  recovered_at timestamptz,
  recovered_from_checkpoint_ref text
    CHECK (recovered_from_checkpoint_ref IS NULL OR char_length(recovered_from_checkpoint_ref) >= 1),
  released_at timestamptz,
  release_reason text
    CHECK (release_reason IS NULL OR char_length(release_reason) >= 1),
  failed_at timestamptz,
  failure_detail text
    CHECK (failure_detail IS NULL OR char_length(failure_detail) >= 1),
  acquired_by text NOT NULL CHECK (char_length(acquired_by) >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Per-status invariants (the trigger below adds the transition law).
  CHECK (
    (status = 'preparing'
       AND session_id IS NULL AND opened_at IS NULL AND lease_until IS NULL
       AND last_heartbeat_at IS NULL AND lost_at IS NULL
       AND cancellation_requested_at IS NULL AND released_at IS NULL AND failed_at IS NULL)
    OR (status = 'live'
       AND session_id IS NOT NULL AND opened_at IS NOT NULL AND lease_until IS NOT NULL
       AND last_heartbeat_at IS NOT NULL AND takeover_holder IS NULL AND lost_at IS NULL
       AND cancellation_requested_at IS NULL AND released_at IS NULL AND failed_at IS NULL)
    OR (status = 'suspended'
       AND session_id IS NOT NULL AND opened_at IS NOT NULL AND lease_until IS NOT NULL
       AND taken_over_at IS NOT NULL AND takeover_holder = 'human'
       AND takeover_reason IS NOT NULL AND lost_at IS NULL
       AND cancellation_requested_at IS NULL AND released_at IS NULL AND failed_at IS NULL)
    OR (status = 'lost'
       AND opened_at IS NOT NULL AND lost_at IS NOT NULL AND lost_detail IS NOT NULL
       AND takeover_holder IS NULL
       AND cancellation_requested_at IS NULL AND released_at IS NULL AND failed_at IS NULL)
    OR (status = 'cancelled'
       AND cancellation_requested_at IS NOT NULL AND cancel_reason IS NOT NULL
       AND released_at IS NULL AND failed_at IS NULL)
    OR (status = 'released'
       AND released_at IS NOT NULL AND release_reason IS NOT NULL
       AND cancellation_requested_at IS NULL AND failed_at IS NULL)
    OR (status = 'failed'
       AND failed_at IS NOT NULL AND failure_detail IS NOT NULL
       AND cancellation_requested_at IS NULL AND released_at IS NULL)
  )
);

CREATE INDEX fabric_leases_tenant_definition_idx ON fabric_leases (tenant_id, definition_id);
CREATE INDEX fabric_leases_tenant_run_idx ON fabric_leases (tenant_id, execution_run_id);
CREATE INDEX fabric_leases_tenant_status_idx ON fabric_leases (tenant_id, status);
CREATE INDEX fabric_leases_tenant_created_idx ON fabric_leases (tenant_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- The append-only evidence tails (law 3)
-- ---------------------------------------------------------------------------

CREATE TABLE fabric_lease_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'acquired', 'prepared', 'takeover', 'handback', 'loss', 'recovery',
    'cancellation', 'release', 'failure', 'artifact', 'evidence', 'checkpoint'
  )),
  -- The per-kind plain-JSON payload (validated shapes; opaque refs only).
  payload jsonb NOT NULL
    CHECK (jsonb_typeof(payload) = 'object'),
  recorded_by text NOT NULL CHECK (char_length(recorded_by) >= 1),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX fabric_lease_events_lease_idx
  ON fabric_lease_events (tenant_id, lease_id, recorded_at, id);

CREATE TABLE fabric_lease_artifacts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  -- Opaque artifact reference — the artifact store owns the bytes.
  artifact_ref text NOT NULL
    CHECK (char_length(artifact_ref) >= 1 AND char_length(artifact_ref) <= 256),
  artifact_kind text NOT NULL
    CHECK (char_length(artifact_kind) >= 1 AND char_length(artifact_kind) <= 64),
  digest text
    CHECK (digest IS NULL OR (char_length(digest) >= 8 AND char_length(digest) <= 128)),
  recorded_by text NOT NULL CHECK (char_length(recorded_by) >= 1),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX fabric_lease_artifacts_lease_idx
  ON fabric_lease_artifacts (tenant_id, lease_id, recorded_at, id);

CREATE TABLE fabric_lease_evidence (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  -- The frozen W131 capture vocabulary.
  capture_kind text NOT NULL CHECK (capture_kind IN ('screenshot', 'action-trace', 'dom-snapshot', 'console')),
  artifact_ref text NOT NULL
    CHECK (char_length(artifact_ref) >= 1 AND char_length(artifact_ref) <= 256),
  verification text NOT NULL CHECK (verification IN ('unverified', 'verified', 'mismatched')),
  detail text
    CHECK (detail IS NULL OR char_length(detail) >= 1),
  -- The LITERAL law: redaction is applied before storage (credentials
  -- never ride in observations — weakening this is inexpressible).
  redaction text NOT NULL DEFAULT 'applied' CHECK (redaction = 'applied'),
  recorded_by text NOT NULL CHECK (char_length(recorded_by) >= 1),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX fabric_lease_evidence_lease_idx
  ON fabric_lease_evidence (tenant_id, lease_id, recorded_at, id);

CREATE TABLE fabric_lease_checkpoints (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  -- OPAQUE cursor (each adapter/work kind owns its grammar — for this
  -- module's adapters the documented convention is
  -- '<session-id>@<worker-cursor>').
  cursor text NOT NULL
    CHECK (char_length(cursor) >= 1 AND char_length(cursor) <= 512),
  -- The evidence references covered by this checkpoint: replay never
  -- re-executes covered work (the W131 resume semantics).
  covered_evidence_refs text[] NOT NULL DEFAULT '{}',
  recorded_by text NOT NULL CHECK (char_length(recorded_by) >= 1),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX fabric_lease_checkpoints_lease_idx
  ON fabric_lease_checkpoints (tenant_id, lease_id, recorded_at, id);

-- ---------------------------------------------------------------------------
-- Append-only enforcement (law 3): events, artifacts, evidence and
-- checkpoints reject every UPDATE/DELETE/TRUNCATE outright.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION execution_fabric_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'execution-fabric evidence is append-only (W137): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fabric_lease_events_immutable
  BEFORE UPDATE OR DELETE ON fabric_lease_events
  FOR EACH ROW EXECUTE FUNCTION execution_fabric_reject_mutation();

CREATE TRIGGER fabric_lease_events_immutable_truncate
  BEFORE TRUNCATE ON fabric_lease_events
  FOR EACH STATEMENT EXECUTE FUNCTION execution_fabric_reject_mutation();

CREATE TRIGGER fabric_lease_artifacts_immutable
  BEFORE UPDATE OR DELETE ON fabric_lease_artifacts
  FOR EACH ROW EXECUTE FUNCTION execution_fabric_reject_mutation();

CREATE TRIGGER fabric_lease_artifacts_immutable_truncate
  BEFORE TRUNCATE ON fabric_lease_artifacts
  FOR EACH STATEMENT EXECUTE FUNCTION execution_fabric_reject_mutation();

CREATE TRIGGER fabric_lease_evidence_immutable
  BEFORE UPDATE OR DELETE ON fabric_lease_evidence
  FOR EACH ROW EXECUTE FUNCTION execution_fabric_reject_mutation();

CREATE TRIGGER fabric_lease_evidence_immutable_truncate
  BEFORE TRUNCATE ON fabric_lease_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION execution_fabric_reject_mutation();

CREATE TRIGGER fabric_lease_checkpoints_immutable
  BEFORE UPDATE OR DELETE ON fabric_lease_checkpoints
  FOR EACH ROW EXECUTE FUNCTION execution_fabric_reject_mutation();

CREATE TRIGGER fabric_lease_checkpoints_immutable_truncate
  BEFORE TRUNCATE ON fabric_lease_checkpoints
  FOR EACH STATEMENT EXECUTE FUNCTION execution_fabric_reject_mutation();

-- ---------------------------------------------------------------------------
-- The definition pointer: the ONLY legal UPDATE is the one-way
-- active → retired transition (retired_at stamped exactly once); every
-- identity/content column is immutable; DELETE/TRUNCATE forbidden (law 1).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION environment_definition_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'environment_definitions is lifecycle-managed (W137): % is forbidden — definitions are durable registry records', TG_OP;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.def_key IS DISTINCT FROM OLD.def_key
     OR NEW.display_name IS DISTINCT FROM OLD.display_name
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.tenant_isolated IS DISTINCT FROM OLD.tenant_isolated
     OR NEW.profile_scope IS DISTINCT FROM OLD.profile_scope
     OR NEW.network_egress IS DISTINCT FROM OLD.network_egress
     OR NEW.credential_handling IS DISTINCT FROM OLD.credential_handling
     OR NEW.survives_restart IS DISTINCT FROM OLD.survives_restart
     OR NEW.checkpoint_level IS DISTINCT FROM OLD.checkpoint_level
     OR NEW.persistent_scope IS DISTINCT FROM OLD.persistent_scope
     OR NEW.required_capabilities IS DISTINCT FROM OLD.required_capabilities
     OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'environment_definitions content is immutable (W137): a changed definition is a NEW definition under a NEW key';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'active' AND NEW.status = 'retired') THEN
    RAISE EXCEPTION 'environment_definitions lifecycle is one-way (W137): active -> retired only';
  END IF;

  IF NEW.status = 'retired' AND (OLD.retired_at IS NOT NULL OR NEW.retired_at IS NULL) THEN
    RAISE EXCEPTION 'retirement must stamp retired_at exactly once';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER environment_definitions_immutable
  BEFORE UPDATE OR DELETE ON environment_definitions
  FOR EACH ROW EXECUTE FUNCTION environment_definition_guard();

CREATE TRIGGER environment_definitions_immutable_truncate
  BEFORE TRUNCATE ON environment_definitions
  FOR EACH STATEMENT EXECUTE FUNCTION environment_definition_guard();

-- ---------------------------------------------------------------------------
-- The lease pointer: the lifecycle state machine (law 2). The guard
-- mirrors validation.ts's fabricLeaseTransitionProblem — THE single
-- deterministic legality definition — at the storage layer (defense in
-- depth): only the legal transitions move, identity is immutable, the
-- disposable session id changes only on prepare/recover, terminal rows
-- are frozen outright, and the lease window moves only while live.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fabric_lease_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'fabric_leases is lifecycle-managed (W137): % is forbidden — the lease record is durable evidence', TG_OP;
  END IF;

  -- Identity and acquisition content are immutable from creation.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.definition_id IS DISTINCT FROM OLD.definition_id
     OR NEW.plan_id IS DISTINCT FROM OLD.plan_id
     OR NEW.execution_run_id IS DISTINCT FROM OLD.execution_run_id
     OR NEW.task_key IS DISTINCT FROM OLD.task_key
     OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.adapter_id IS DISTINCT FROM OLD.adapter_id
     OR NEW.credential_ref IS DISTINCT FROM OLD.credential_ref
     OR NEW.lease_minutes IS DISTINCT FROM OLD.lease_minutes
     OR NEW.acquired_by IS DISTINCT FROM OLD.acquired_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'fabric_leases content is immutable (W137): only the lifecycle moves';
  END IF;

  -- Terminal rows are frozen outright.
  IF OLD.status IN ('released', 'cancelled', 'failed') THEN
    RAISE EXCEPTION 'fabric_leases terminal rows are frozen (W137): a % lease admits no further change', OLD.status;
  END IF;

  -- The transition law (the fabricLeaseTransitionProblem mirror).
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'preparing' AND NEW.status IN ('live', 'cancelled', 'failed'))
    OR (OLD.status = 'live' AND NEW.status IN ('suspended', 'lost', 'cancelled', 'released', 'failed'))
    OR (OLD.status = 'suspended' AND NEW.status IN ('live', 'lost', 'cancelled', 'failed'))
    OR (OLD.status = 'lost' AND NEW.status IN ('live', 'cancelled', 'failed'))
  ) THEN
    RAISE EXCEPTION 'fabric_leases lifecycle refuses the move (W137): % -> % is not a legal transition', OLD.status, NEW.status;
  END IF;

  -- The disposable session id changes ONLY on prepare (NULL -> value)
  -- and recover (value -> a FRESH value).
  IF NEW.session_id IS DISTINCT FROM OLD.session_id AND NOT (
       (OLD.status = 'preparing' AND NEW.status = 'live' AND OLD.session_id IS NULL AND NEW.session_id IS NOT NULL)
    OR (OLD.status = 'lost' AND NEW.status = 'live' AND OLD.session_id IS NOT NULL AND NEW.session_id IS NOT NULL AND NEW.session_id <> OLD.session_id)
  ) THEN
    RAISE EXCEPTION 'fabric_leases session id moves only on prepare and recover (W137): sessions are disposable, the lease is the durable truth';
  END IF;

  -- First liveness stamps exactly once (recoveries keep it).
  IF NEW.opened_at IS DISTINCT FROM OLD.opened_at AND OLD.opened_at IS NOT NULL THEN
    RAISE EXCEPTION 'fabric_leases opened_at stamps exactly once (W137)';
  END IF;
  IF OLD.status = 'preparing' AND NEW.status = 'live' AND (NEW.opened_at IS NULL OR NEW.lease_until IS NULL OR NEW.last_heartbeat_at IS NULL OR NEW.recovered_at IS NOT NULL OR NEW.recovery_detected_at IS NOT NULL OR NEW.recovered_from_checkpoint_ref IS NOT NULL) THEN
    RAISE EXCEPTION 'prepare must stamp opened_at/lease_until/heartbeat and carry no recovery history';
  END IF;

  -- The takeover/handback cycle: takeover stamps holder+reason;
  -- the explicit hand-back clears the holder and stamps handback_at.
  IF OLD.status = 'live' AND NEW.status = 'suspended' AND (NEW.taken_over_at IS NULL OR NEW.takeover_holder <> 'human' OR NEW.takeover_reason IS NULL) THEN
    RAISE EXCEPTION 'takeover must stamp taken_over_at, holder human and the reason (W137)';
  END IF;
  IF OLD.status = 'suspended' AND NEW.status = 'live' AND (NEW.handback_at IS NULL OR NEW.takeover_holder IS NOT NULL) THEN
    RAISE EXCEPTION 'handback must stamp handback_at and clear the holder — control returns by explicit hand-back only (W137)';
  END IF;

  -- Lease death parks (NOT terminal) with its detection detail.
  IF NEW.status = 'lost' AND OLD.status <> 'lost' AND (NEW.lost_at IS NULL OR NEW.lost_detail IS NULL) THEN
    RAISE EXCEPTION 'marking lost must stamp lost_at and the detection detail (W137)';
  END IF;

  -- Recovery resumes from a checkpoint ref into a fresh session.
  IF OLD.status = 'lost' AND NEW.status = 'live' AND (NEW.recovered_at IS NULL OR NEW.recovery_detected_at IS NULL OR NEW.recovered_from_checkpoint_ref IS NULL) THEN
    RAISE EXCEPTION 'recovery must stamp recovered_at, recovery_detected_at and the checkpoint ref it resumed from (W137)';
  END IF;

  -- The terminals stamp exactly once, with their retained reasons.
  IF NEW.status = 'cancelled' AND (NEW.cancellation_requested_at IS NULL OR NEW.cancel_reason IS NULL) THEN
    RAISE EXCEPTION 'cancellation must stamp cancellation_requested_at and the reason exactly once (W137)';
  END IF;
  IF NEW.status = 'released' AND (NEW.released_at IS NULL OR NEW.release_reason IS NULL) THEN
    RAISE EXCEPTION 'release must stamp released_at and the reason exactly once (W137)';
  END IF;
  IF NEW.status = 'failed' AND (NEW.failed_at IS NULL OR NEW.failure_detail IS NULL) THEN
    RAISE EXCEPTION 'failure must stamp failed_at and the actionable detail exactly once (W137)';
  END IF;
  IF NEW.status <> 'cancelled' AND NEW.cancellation_requested_at IS DISTINCT FROM OLD.cancellation_requested_at THEN
    RAISE EXCEPTION 'cancellation stamps only with the cancelled transition (W137)';
  END IF;
  IF NEW.status <> 'released' AND NEW.released_at IS DISTINCT FROM OLD.released_at THEN
    RAISE EXCEPTION 'release stamps only with the released transition (W137)';
  END IF;
  IF NEW.status <> 'failed' AND NEW.failed_at IS DISTINCT FROM OLD.failed_at THEN
    RAISE EXCEPTION 'failure stamps only with the failed transition (W137)';
  END IF;

  -- The lease window and heartbeat move only while live.
  IF (NEW.lease_until IS DISTINCT FROM OLD.lease_until
      OR NEW.last_heartbeat_at IS DISTINCT FROM OLD.last_heartbeat_at)
     AND OLD.status <> 'live' AND NEW.status <> 'live' THEN
    RAISE EXCEPTION 'the lease window moves only on a live lease (W137)';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fabric_leases_immutable
  BEFORE UPDATE OR DELETE ON fabric_leases
  FOR EACH ROW EXECUTE FUNCTION fabric_lease_guard();

CREATE TRIGGER fabric_leases_immutable_truncate
  BEFORE TRUNCATE ON fabric_leases
  FOR EACH STATEMENT EXECUTE FUNCTION fabric_lease_guard();
