-- W084 · deep-actions module — the Deep Action Gateway and Reconciliation:
-- the discover→inspect→propose→authorize→execute→verify→reconcile pipeline
-- that carries a multi-system task out of Aurum across external systems,
-- with evidence and outcome links, action-receipt and downstream-state
-- verification, and reconciliation that detects mismatches and creates
-- attention (epistemics unknowns) plus evidence (immutable observations).
--
-- Every table carries tenant_id (ADR-0001; scripts/check-architecture.ts
-- rule d). Nothing provider-named appears anywhere: an operation addresses
-- an external system only through the OPAQUE broker-connection id (W082),
-- the W081 inventory's plain-language capability keys and the frozen
-- system descriptor; the only provider-minted values that reach these
-- tables are OPAQUE strings (action receipt ids). Credential VALUES never
-- reach these tables at all (the W082 discipline: the connection row, not
-- this module, holds the opaque credentialRef).
--
-- State model (the work item's canonical chain, mirrored by the shapes):
--   * deep_action_tasks      — the multi-system task and its PHASE state:
--                              draft → discovered → inspected → proposed →
--                              authorized → executed → verified →
--                              reconciled | mismatched, with rejected /
--                              failed as the refusal and failure terminals.
--   * deep_action_operations — the per-operation plan and outcome: the
--                              frozen target/payload/expectation, the W083
--                              capability-invocation evidence (allowed write
--                              or the denial that stopped it), the opaque
--                              provider action receipt, and the pre-state /
--                              post-state / mismatch evidence observation
--                              links plus the attention unknown link.
--   * deep_action_surface    — the discovered execution surface: one row
--                              per distinct connection the task touches
--                              (system snapshot, read floor, gated writes,
--                              active grants at discover time).
--   * deep_action_events     — append-only lifecycle audit (every phase
--                              transition, every denial, every mismatch).

-- ---------------------------------------------------------------------------
-- Tasks — the multi-system deep action and its phase state
-- ---------------------------------------------------------------------------

CREATE TABLE deep_action_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  -- The concrete task (frozen at creation; mirrors the W083 task-context
  -- shape): {description, requestedFor} — the human-readable what-and-why.
  task_context jsonb NOT NULL CHECK (jsonb_typeof(task_context) = 'object'),
  -- Frozen operation count (the plan's size; the operations live below).
  operation_count integer NOT NULL CHECK (operation_count BETWEEN 1 AND 16),
  -- The canonical chain as forward-only phase state.
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'discovered', 'inspected', 'proposed', 'authorized',
    'executed', 'verified', 'reconciled', 'mismatched', 'rejected', 'failed'
  )),
  -- The actions module's ActionRequest id (the W009 gate record that the
  -- proposal routed through; soft reference).
  action_request_id uuid,
  -- Why a terminal refusal/failure happened (rejected/failed only).
  rejection_reason text
    CHECK (rejection_reason IS NULL OR char_length(rejection_reason) BETWEEN 1 AND 2000),
  -- Reconciliation outcome: operations whose downstream state mismatched.
  mismatch_count integer NOT NULL DEFAULT 0 CHECK (mismatch_count >= 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT deep_action_tasks_id_tenant_unique UNIQUE (id, tenant_id),
  -- A task past its proposal always knows its gate record.
  CONSTRAINT deep_action_tasks_gate_shape CHECK (
    status IN ('draft', 'discovered', 'inspected') OR action_request_id IS NOT NULL
  ),
  -- Only refusals/failures carry a reason.
  CONSTRAINT deep_action_tasks_reason_shape CHECK (
    status NOT IN ('rejected', 'failed') OR rejection_reason IS NOT NULL
  ),
  CONSTRAINT deep_action_tasks_no_reason_while_live CHECK (
    status IN ('rejected', 'failed') OR rejection_reason IS NULL
  ),
  -- A reconciled task mismatched nothing; a mismatched task mismatched
  -- at least one operation.
  CONSTRAINT deep_action_tasks_reconciled_clean CHECK (
    status <> 'reconciled' OR mismatch_count = 0
  ),
  CONSTRAINT deep_action_tasks_mismatched_dirty CHECK (
    status <> 'mismatched' OR mismatch_count >= 1
  )
);

CREATE INDEX deep_action_tasks_tenant_status_idx
  ON deep_action_tasks (tenant_id, status, created_at DESC);
CREATE INDEX deep_action_tasks_tenant_gate_idx
  ON deep_action_tasks (tenant_id, action_request_id);

-- ---------------------------------------------------------------------------
-- Operations — the per-operation plan, authority evidence and outcome
-- ---------------------------------------------------------------------------

CREATE TABLE deep_action_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  -- Unique operation key within the task (caller-chosen).
  op_key text NOT NULL CHECK (char_length(op_key) BETWEEN 1 AND 128),
  -- 1-based execution order (frozen at creation).
  position integer NOT NULL CHECK (position >= 1),
  -- The connection-broker connection this operation rides (opaque id;
  -- validated through the connection-broker contract — soft reference).
  connection_id uuid NOT NULL,
  -- The W081 inventory system this connection realizes. NULL until the
  -- DISCOVER phase resolves the connection's surface (the plain-language
  -- descriptor is frozen together with it).
  system_id uuid,
  system_key text CHECK (system_key IS NULL OR char_length(system_key) BETWEEN 3 AND 312),
  system_display_name text
    CHECK (system_display_name IS NULL OR char_length(system_display_name) BETWEEN 1 AND 200),
  -- The WRITE capability exercised (plain-language W081 key).
  capability_key text NOT NULL CHECK (char_length(capability_key) BETWEEN 3 AND 128),
  -- The READ capability of the same class (derived; inspect/verify path).
  -- NULL until discover resolves it.
  read_capability_key text
    CHECK (read_capability_key IS NULL OR char_length(read_capability_key) BETWEEN 3 AND 128),
  -- Opaque external entity reference (the provider-side id of the record
  -- this operation writes; never interpreted here).
  target text NOT NULL CHECK (char_length(target) BETWEEN 1 AND 200),
  -- The canonical write payload (provider-neutral; the transport's
  -- adapter composes the provider-native request from it INSIDE the
  -- gateway — lock 16).
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  -- The canonical EXPECTED downstream state (a plain JSON object of
  -- expected field values; reconciliation checks every entry against the
-- observed post-state — subset semantics, deterministic).
  expectation jsonb NOT NULL CHECK (jsonb_typeof(expectation) = 'object'),
  -- Forward-only operation state (the chain at operation granularity).
  state text NOT NULL DEFAULT 'pending' CHECK (state IN (
    'pending', 'authorized', 'denied', 'executed', 'verified',
    'matched', 'mismatched', 'failed'
  )),
  -- The W083 capability invocation that authorized the write (allowed).
  invocation_id uuid,
  -- The W083 capability invocation whose DENIAL stopped this write (the
  -- gate's verdict — recorded evidence, never an error to be swallowed).
  denial_invocation_id uuid,
  -- The provider-neutral action receipt of the executed write.
  receipt_status text CHECK (receipt_status IN ('accepted', 'rejected', 'failed')),
  -- The provider's own opaque action-receipt id (null when it gave none).
  receipt_id text CHECK (receipt_id IS NULL OR char_length(receipt_id) BETWEEN 1 AND 200),
  receipt_detail text CHECK (receipt_detail IS NULL OR char_length(receipt_detail) BETWEEN 1 AND 500),
  -- Evidence links (immutable observations recorded through the W004
  -- contract) and the attention link (epistemics unknown).
  pre_state_observation_id uuid,
  post_state_observation_id uuid,
  mismatch_evidence_observation_id uuid,
  mismatch_unknown_id uuid,
  executed_at timestamptz,
  verified_at timestamptz,
  reconciled_at timestamptz,
  CONSTRAINT deep_action_operations_key_unique UNIQUE (tenant_id, task_id, op_key),
  CONSTRAINT deep_action_operations_position_unique UNIQUE (tenant_id, task_id, position),
  CONSTRAINT deep_action_operations_id_tenant_unique UNIQUE (id, tenant_id),
  -- State-shape invariants (the chain, one row at a time).
  CONSTRAINT deep_action_operations_pending_shape CHECK (
    state <> 'pending'
    OR (invocation_id IS NULL AND denial_invocation_id IS NULL AND receipt_status IS NULL)
  ),
  CONSTRAINT deep_action_operations_authorized_shape CHECK (
    state <> 'authorized' OR (invocation_id IS NOT NULL AND receipt_status IS NULL)
  ),
  CONSTRAINT deep_action_operations_denied_shape CHECK (
    state <> 'denied' OR (denial_invocation_id IS NOT NULL AND invocation_id IS NULL)
  ),
  CONSTRAINT deep_action_operations_executed_shape CHECK (
    state <> 'executed'
    OR (invocation_id IS NOT NULL AND receipt_status = 'accepted' AND executed_at IS NOT NULL)
  ),
  CONSTRAINT deep_action_operations_verified_shape CHECK (
    state <> 'verified'
    OR (invocation_id IS NOT NULL AND post_state_observation_id IS NOT NULL
        AND executed_at IS NOT NULL AND verified_at IS NOT NULL)
  ),
  CONSTRAINT deep_action_operations_matched_shape CHECK (
    state <> 'matched'
    OR (post_state_observation_id IS NOT NULL AND reconciled_at IS NOT NULL)
  ),
  CONSTRAINT deep_action_operations_mismatched_shape CHECK (
    state <> 'mismatched'
    OR (mismatch_evidence_observation_id IS NOT NULL
        AND mismatch_unknown_id IS NOT NULL AND reconciled_at IS NOT NULL)
  ),
  CONSTRAINT deep_action_operations_failed_shape CHECK (
    state <> 'failed' OR receipt_status IN ('rejected', 'failed')
  ),
  -- The discover-frozen system descriptor is all-or-nothing, and exists
  -- from the discovered phase onward.
  CONSTRAINT deep_action_operations_system_descriptor_shape CHECK (
    (system_id IS NULL) = (system_key IS NULL)
    AND (system_id IS NULL) = (system_display_name IS NULL)
  ),
  CONSTRAINT deep_action_operations_system_resolved_shape CHECK (
    state = 'pending' OR (system_id IS NOT NULL AND read_capability_key IS NOT NULL)
  )
);

CREATE INDEX deep_action_operations_task_idx
  ON deep_action_operations (tenant_id, task_id, position);
CREATE INDEX deep_action_operations_tenant_connection_idx
  ON deep_action_operations (tenant_id, connection_id, executed_at DESC);

-- ---------------------------------------------------------------------------
-- Surface — the discovered execution surface (one row per connection)
-- ---------------------------------------------------------------------------

CREATE TABLE deep_action_surface (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  system_id uuid NOT NULL,
  system_key text NOT NULL CHECK (char_length(system_key) BETWEEN 3 AND 312),
  system_display_name text NOT NULL CHECK (char_length(system_display_name) BETWEEN 1 AND 200),
  -- The W083 progressive-access partition frozen at discover time: the
  -- read-only floor and the write-gated set ({key,label,dataCategories}).
  read_capabilities jsonb NOT NULL CHECK (jsonb_typeof(read_capabilities) = 'array'),
  write_capabilities jsonb NOT NULL CHECK (jsonb_typeof(write_capabilities) = 'array'),
  -- The capability keys active grants covered at discover time.
  active_grant_keys jsonb NOT NULL CHECK (jsonb_typeof(active_grant_keys) = 'array'),
  connection_mode text NOT NULL CHECK (connection_mode IN ('read-only', 'elevated')),
  discovered_at timestamptz NOT NULL,
  CONSTRAINT deep_action_surface_connection_unique UNIQUE (tenant_id, task_id, connection_id),
  CONSTRAINT deep_action_surface_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX deep_action_surface_task_idx
  ON deep_action_surface (tenant_id, task_id);

-- ---------------------------------------------------------------------------
-- Events — append-only lifecycle audit
-- ---------------------------------------------------------------------------

CREATE TABLE deep_action_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  -- Monotonic per-task position: the service clock can hold still within
  -- one phase (test-controllable time), so the audit feed orders by
  -- (recorded_at DESC, position DESC) deterministically.
  position integer NOT NULL CHECK (position >= 1),
  event text NOT NULL CHECK (event IN (
    'created',
    'surface-discovered',
    'targets-inspected',
    'proposed',
    'gate-rejected',
    'authorized',
    'operation-denied',
    'operation-executed',
    'execution-failed',
    'executed',
    'verified',
    'reconciled',
    'mismatch-detected'
  )),
  detail text
    CHECK (detail IS NULL OR char_length(detail) BETWEEN 1 AND 500),
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL,
  CONSTRAINT deep_action_events_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX deep_action_events_task_idx
  ON deep_action_events (tenant_id, task_id, recorded_at DESC, position DESC);

-- ---------------------------------------------------------------------------
-- Idempotency — caller-supplied dedupe keys, first write wins
-- ---------------------------------------------------------------------------

-- One row per recorded createDeepAction idempotency key: a replay of the
-- key returns the original task (the events module's first-write-wins
-- semantics; the destinations/llm delivery-key precedent).

CREATE TABLE deep_action_idempotency (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  idempotency_key text NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 2 AND 200),
  created_at timestamptz NOT NULL,
  CONSTRAINT deep_action_idempotency_key_unique UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT deep_action_idempotency_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX deep_action_idempotency_task_idx
  ON deep_action_idempotency (tenant_id, task_id);

-- ---------------------------------------------------------------------------
-- Storage-level guarantees
-- ---------------------------------------------------------------------------

-- deep_action_events: strictly append-only audit — no UPDATE, DELETE or
-- TRUNCATE, ever. (The task/operation/surface tables legitimately move
-- forward through the pipeline — they are workflow state, not evidence;
-- the evidence itself lives in the immutable observations the pipeline
-- records through the W004 contract, and the append-only ledgers of the
-- modules it composes.)

CREATE OR REPLACE FUNCTION deep_action_append_only_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (W084 deep-actions audit): % is forbidden on table %',
    TG_TABLE_NAME, TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER deep_action_events_immutable
  BEFORE UPDATE OR DELETE ON deep_action_events
  FOR EACH ROW EXECUTE FUNCTION deep_action_append_only_reject_mutation();
CREATE TRIGGER deep_action_events_immutable_truncate
  BEFORE TRUNCATE ON deep_action_events
  FOR EACH STATEMENT EXECUTE FUNCTION deep_action_append_only_reject_mutation();
