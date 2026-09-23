-- W080 · workflow module — the durable orchestration core.
--
-- Abstract durable orchestration behind an Aurum-owned workflow port:
-- workflow definitions (the program), runs and steps (the durable state
-- machine), step attempts (the append-only evidence trail), orchestration
-- events (the event-trigger substrate) and run signals (the durable
-- employee-response delivery surface). ALL workflow state lives here —
-- no workflow state is held only in worker memory (W080 acceptance;
-- ARCHITECTURE-LOCK 35: PostgreSQL is authoritative domain state; lock
-- 36: long-running cognition and execution are asynchronous, resumable
-- and traceable).
--
-- The mutable/append-only split follows the W013 house pattern:
--   * workflow_runs / workflow_run_steps are STATE MACHINES — their
--     lifecycle columns move (that is what "resumable" means in
--     storage) but their identity is never erased: DELETE and TRUNCATE
--     are rejected by triggers.
--   * workflow_step_attempts / workflow_events are APPEND-ONLY
--     evidence — UPDATE, DELETE and TRUNCATE are rejected outright (the
--     W021 agent-execution-attempts discipline).
--   * workflow_run_signals are append-only EXCEPT their consumption
--     stamp (the actions module's decision-state pattern: the guard
--     trigger permits only consumed_at to change).
--
-- Tenant scoping (ADR-0001): every table carries tenant_id, and the
-- child tables keep tenant consistency through composite foreign keys
-- (id, tenant_id) -> parent (id, tenant_id) — the mission_versions /
-- cognitive_execution_steps precedent.

-- ---------------------------------------------------------------------------
-- Definitions: the durable orchestration program.
--
-- The definitions row is the identity anchor (tenant-unique key, current
-- version pointer, active/retired status); the spec CONTENT lives in the
-- append-only workflow_definition_versions table — one row per version.
-- Runs freeze (definition_id, definition_version) at start, so a run
-- reconstructs against the exact program that produced it even after
-- later re-registrations (the missions versioning discipline).
-- ---------------------------------------------------------------------------

CREATE TABLE workflow_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  key text NOT NULL CHECK (
    key ~ '^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$'
  ),
  -- The CURRENT version (the latest recorded content).
  version integer NOT NULL CHECK (version >= 1),
  status text NOT NULL CHECK (status IN ('active', 'retired')),
  created_by text NOT NULL CHECK (created_by <> ''),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT workflow_definitions_tenant_key_unique UNIQUE (tenant_id, key),
  CONSTRAINT workflow_definitions_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX workflow_definitions_tenant_idx
  ON workflow_definitions (tenant_id, created_at DESC);

CREATE TABLE workflow_definition_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  definition_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description text CHECK (
    description IS NULL OR char_length(description) BETWEEN 1 AND 2000
  ),
  -- The serialized WorkflowSpec: ordered steps (retry/lease policy) plus
  -- the event types that start runs. Content changes append a version.
  spec jsonb NOT NULL
    CHECK (jsonb_typeof(spec) = 'object')
    CHECK (jsonb_typeof(spec->'steps') = 'array' AND jsonb_array_length(spec->'steps') >= 1)
    CHECK (
      spec->'eventTriggers' IS NULL
      OR (jsonb_typeof(spec->'eventTriggers') = 'array' AND jsonb_array_length(spec->'eventTriggers') <= 20)
    ),
  created_by text NOT NULL CHECK (created_by <> ''),
  created_at timestamptz NOT NULL,
  CONSTRAINT workflow_definition_versions_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT workflow_definition_versions_slot_unique UNIQUE (tenant_id, definition_id, version),
  CONSTRAINT workflow_definition_versions_definition_fk
    FOREIGN KEY (definition_id, tenant_id) REFERENCES workflow_definitions (id, tenant_id)
);

CREATE INDEX workflow_definition_versions_definition_idx
  ON workflow_definition_versions (tenant_id, definition_id, version);

-- ---------------------------------------------------------------------------
-- Orchestration events: the durable event-trigger substrate.
-- ---------------------------------------------------------------------------

CREATE TABLE workflow_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  event_type text NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 128),
  payload jsonb NOT NULL,
  -- A domain event (events module, W003) this trigger references —
  -- validated readable through the events contract at dispatch time.
  domain_event_id uuid,
  idempotency_key text CHECK (
    idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 1 AND 200
  ),
  occurred_at timestamptz NOT NULL,
  dispatched_by text NOT NULL CHECK (dispatched_by <> ''),
  CONSTRAINT workflow_events_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT workflow_events_tenant_key_unique UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX workflow_events_tenant_idx
  ON workflow_events (tenant_id, occurred_at DESC);
CREATE INDEX workflow_events_type_idx
  ON workflow_events (tenant_id, event_type, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Runs: the durable execution state machine.
-- ---------------------------------------------------------------------------

CREATE TABLE workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  definition_id uuid NOT NULL,
  definition_key text NOT NULL CHECK (definition_key <> ''),
  -- The definition version this run executes (frozen at start).
  definition_version integer NOT NULL CHECK (definition_version >= 1),
  idempotency_key text CHECK (
    idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 1 AND 200
  ),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'running', 'waiting', 'cancelling', 'cancelled', 'succeeded', 'failed'
  )),
  -- 0 = not yet started; 1..total_steps = the active step's number.
  current_step integer NOT NULL DEFAULT 0 CHECK (current_step >= 0),
  total_steps integer NOT NULL CHECK (total_steps >= 1),
  CONSTRAINT workflow_runs_position_bounds CHECK (current_step <= total_steps),
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('manual', 'event', 'schedule')),
  trigger_event_id uuid,
  trigger_schedule_id uuid,
  trigger_reference text CHECK (
    trigger_reference IS NULL OR char_length(trigger_reference) BETWEEN 1 AND 2000
  ),
  input jsonb NOT NULL,
  result jsonb,
  error_code text CHECK (error_code IS NULL OR error_code <> ''),
  error_detail text CHECK (error_detail IS NULL OR error_detail <> ''),
  cancel_requested_at timestamptz,
  cancel_reason text CHECK (
    cancel_reason IS NULL OR char_length(cancel_reason) BETWEEN 1 AND 2000
  ),
  cancelled_by text CHECK (cancelled_by IS NULL OR cancelled_by <> ''),
  -- The durable run context (the worker.ts job-envelope discipline): the
  -- principal and authority claims that started the run, serialized at
  -- startRun so ANY fresh engine instance pumps it with the original
  -- explicit context.
  run_principal text NOT NULL CHECK (run_principal <> ''),
  run_authority jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(run_authority) = 'array'),
  created_by text NOT NULL CHECK (created_by <> ''),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  CONSTRAINT workflow_runs_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT workflow_runs_idempotency_unique UNIQUE (tenant_id, idempotency_key),
  -- Trigger provenance pairs.
  CONSTRAINT workflow_runs_event_trigger_shape CHECK (
    (trigger_kind = 'event') = (trigger_event_id IS NOT NULL)
  ),
  CONSTRAINT workflow_runs_schedule_trigger_shape CHECK (
    (trigger_kind = 'schedule') = (trigger_schedule_id IS NOT NULL)
  ),
  CONSTRAINT workflow_runs_non_event_clean CHECK (
    trigger_kind <> 'event' OR trigger_schedule_id IS NULL
  ),
  CONSTRAINT workflow_runs_non_schedule_clean CHECK (
    trigger_kind <> 'schedule' OR trigger_event_id IS NULL
  ),
  -- Event/schedule starts always carry their derived dedupe key.
  CONSTRAINT workflow_runs_derived_key_present CHECK (
    trigger_kind NOT IN ('event', 'schedule') OR idempotency_key IS NOT NULL
  ),
  -- Terminal shapes.
  CONSTRAINT workflow_runs_finished_shape CHECK (
    (status IN ('succeeded', 'failed', 'cancelled')) = (finished_at IS NOT NULL)
  ),
  CONSTRAINT workflow_runs_failed_shape CHECK (
    (status = 'failed') = (error_code IS NOT NULL)
  ),
  CONSTRAINT workflow_runs_succeeded_result CHECK (
    status = 'succeeded' OR result IS NULL
  ),
  -- Cancellation is requested durably before it lands.
  CONSTRAINT workflow_runs_cancel_requested_shape CHECK (
    (status IN ('cancelling', 'cancelled')) = (cancel_requested_at IS NOT NULL)
  ),
  CONSTRAINT workflow_runs_cancel_reason_shape CHECK (
    (status IN ('cancelling', 'cancelled')) = (cancel_reason IS NOT NULL)
  ),
  CONSTRAINT workflow_runs_cancelled_by_shape CHECK (
    status NOT IN ('cancelling', 'cancelled') OR cancelled_by IS NOT NULL
  ),
  -- Live states carry no terminal fields.
  CONSTRAINT workflow_runs_live_clean CHECK (
    status IN ('succeeded', 'failed', 'cancelled')
    OR (finished_at IS NULL AND result IS NULL AND error_code IS NULL AND error_detail IS NULL)
  ),
  -- Only cancelled runs name their canceller (not merely-cancelling ones).
  CONSTRAINT workflow_runs_cancelled_only_by CHECK (
    status <> 'cancelled' OR cancelled_by IS NOT NULL
  )
);

CREATE INDEX workflow_runs_tenant_idx ON workflow_runs (tenant_id, created_at DESC);
CREATE INDEX workflow_runs_status_idx ON workflow_runs (tenant_id, status);
CREATE INDEX workflow_runs_definition_idx ON workflow_runs (tenant_id, definition_id);
CREATE INDEX workflow_runs_pump_idx ON workflow_runs (tenant_id, status, updated_at);
CREATE INDEX workflow_runs_event_idx ON workflow_runs (tenant_id, trigger_event_id);
CREATE INDEX workflow_runs_schedule_idx ON workflow_runs (tenant_id, trigger_schedule_id);

-- ---------------------------------------------------------------------------
-- Steps: the durable per-step state machine.
-- ---------------------------------------------------------------------------

CREATE TABLE workflow_run_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  -- 1-based position in the definition's step order.
  step_number integer NOT NULL CHECK (step_number >= 1),
  step_key text NOT NULL CHECK (char_length(step_key) BETWEEN 1 AND 64),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'
  )),
  invocation_count integer NOT NULL DEFAULT 0 CHECK (invocation_count >= 0),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts >= 1),
  -- The step's FULL durable policy, frozen from the definition version at
  -- run creation: a fresh engine resumes the step without re-resolving
  -- the definition (self-contained resumption).
  retry_backoff_seconds integer NOT NULL DEFAULT 30 CHECK (
    retry_backoff_seconds >= 0 AND retry_backoff_seconds <= 86400
  ),
  lease_seconds integer NOT NULL DEFAULT 3600 CHECK (
    lease_seconds >= 5 AND lease_seconds <= 2592000
  ),
  CONSTRAINT workflow_run_steps_attempts_bounded CHECK (attempt_count <= max_attempts),
  wait_kind text CHECK (wait_kind IN ('timer', 'approval', 'employee_response')),
  wait_resume_at timestamptz,
  wait_action_request_id uuid,
  wait_event_type text CHECK (
    wait_event_type IS NULL OR char_length(wait_event_type) BETWEEN 1 AND 128
  ),
  wait_note text CHECK (wait_note IS NULL OR char_length(wait_note) BETWEEN 1 AND 2000),
  checkpoint jsonb,
  output jsonb,
  error_code text CHECK (error_code IS NULL OR error_code <> ''),
  error_detail text CHECK (error_detail IS NULL OR error_detail <> ''),
  retry_not_before timestamptz,
  lease_expires_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL,
  CONSTRAINT workflow_run_steps_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT workflow_run_steps_slot_unique UNIQUE (tenant_id, run_id, step_number),
  CONSTRAINT workflow_run_steps_run_fk
    FOREIGN KEY (run_id, tenant_id) REFERENCES workflow_runs (id, tenant_id),
  -- Exactly one wait at a time, and only while suspended.
  CONSTRAINT workflow_run_steps_wait_present CHECK (
    (status = 'waiting') = (wait_kind IS NOT NULL)
  ),
  CONSTRAINT workflow_run_steps_timer_resume CHECK (
    (wait_kind = 'timer') = (wait_resume_at IS NOT NULL)
  ),
  CONSTRAINT workflow_run_steps_approval_request CHECK (
    (wait_kind = 'approval') = (wait_action_request_id IS NOT NULL)
  ),
  CONSTRAINT workflow_run_steps_note_only_when_waiting CHECK (
    wait_kind IS NOT NULL OR (wait_note IS NULL AND wait_event_type IS NULL)
  ),
  -- A lease exists only on a running step (unclaimed continuations keep
  -- it NULL so the next pump can claim them).
  CONSTRAINT workflow_run_steps_lease_shape CHECK (
    (status = 'running') OR lease_expires_at IS NULL
  ),
  -- Backoff applies only while the step awaits a retry.
  CONSTRAINT workflow_run_steps_retry_shape CHECK (
    retry_not_before IS NULL OR status = 'pending'
  ),
  -- Terminal shapes.
  CONSTRAINT workflow_run_steps_finished_shape CHECK (
    (status IN ('succeeded', 'failed', 'cancelled')) = (finished_at IS NOT NULL)
  ),
  CONSTRAINT workflow_run_steps_failed_shape CHECK (
    (status = 'failed') = (error_code IS NOT NULL)
  ),
  CONSTRAINT workflow_run_steps_output_shape CHECK (
    status = 'succeeded' OR output IS NULL
  ),
  -- A cancelled step carries no live wait.
  CONSTRAINT workflow_run_steps_cancelled_clean CHECK (
    status <> 'cancelled' OR wait_kind IS NULL
  )
);

CREATE INDEX workflow_run_steps_run_idx
  ON workflow_run_steps (tenant_id, run_id, step_number);
CREATE INDEX workflow_run_steps_pump_idx
  ON workflow_run_steps (tenant_id, status, updated_at);
CREATE INDEX workflow_run_steps_timer_idx
  ON workflow_run_steps (tenant_id, status, wait_kind, wait_resume_at)
  WHERE wait_kind = 'timer';
CREATE INDEX workflow_run_steps_approval_idx
  ON workflow_run_steps (tenant_id, status, wait_kind, updated_at)
  WHERE wait_kind = 'approval';
CREATE INDEX workflow_run_steps_signal_idx
  ON workflow_run_steps (tenant_id, status, wait_kind, wait_event_type)
  WHERE wait_kind = 'employee_response';

-- ---------------------------------------------------------------------------
-- Step attempts: the append-only invocation evidence trail.
-- ---------------------------------------------------------------------------

CREATE TABLE workflow_step_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  step_number integer NOT NULL CHECK (step_number >= 1),
  invocation integer NOT NULL CHECK (invocation >= 1),
  outcome text NOT NULL CHECK (outcome IN (
    'completed', 'checkpoint', 'wait', 'failed', 'abandoned'
  )),
  wait_kind text CHECK (wait_kind IN ('timer', 'approval', 'employee_response')),
  error_code text CHECK (error_code IS NULL OR error_code <> ''),
  error_detail text CHECK (error_detail IS NULL OR error_detail <> ''),
  checkpoint jsonb,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  recorded_by text NOT NULL CHECK (recorded_by <> ''),
  CONSTRAINT workflow_step_attempts_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT workflow_step_attempts_slot_unique UNIQUE (tenant_id, run_id, step_number, invocation),
  CONSTRAINT workflow_step_attempts_run_fk
    FOREIGN KEY (run_id, tenant_id) REFERENCES workflow_runs (id, tenant_id),
  CONSTRAINT workflow_step_attempts_failed_shape CHECK (
    outcome <> 'failed' OR error_code IS NOT NULL
  ),
  CONSTRAINT workflow_step_attempts_completed_clean CHECK (
    outcome <> 'completed' OR error_code IS NULL
  ),
  CONSTRAINT workflow_step_attempts_wait_kind_shape CHECK (
    outcome <> 'wait' OR wait_kind IS NOT NULL
  )
);

CREATE INDEX workflow_step_attempts_run_idx
  ON workflow_step_attempts (tenant_id, run_id, step_number, invocation);

-- ---------------------------------------------------------------------------
-- Run signals: the durable employee-response delivery surface.
-- ---------------------------------------------------------------------------

CREATE TABLE workflow_run_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('event', 'resume')),
  payload jsonb NOT NULL,
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
  -- The workflow event that produced this signal (kind 'event').
  event_id uuid,
  delivered_by text NOT NULL CHECK (delivered_by <> ''),
  delivered_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT workflow_run_signals_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT workflow_run_signals_run_fk
    FOREIGN KEY (run_id, tenant_id) REFERENCES workflow_runs (id, tenant_id),
  CONSTRAINT workflow_run_signals_event_shape CHECK (
    (kind = 'event') = (event_id IS NOT NULL)
  ),
  -- One event releases one waiting run at most once.
  CONSTRAINT workflow_run_signals_event_once UNIQUE (tenant_id, run_id, event_id)
);

CREATE INDEX workflow_run_signals_pending_idx
  ON workflow_run_signals (tenant_id, run_id, delivered_at)
  WHERE consumed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Guard triggers.
-- ---------------------------------------------------------------------------

-- Append-only evidence: events.
CREATE OR REPLACE FUNCTION workflow_events_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'workflow events are append-only triggers (W080 durable runtime): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workflow_events_immutable
  BEFORE UPDATE OR DELETE ON workflow_events
  FOR EACH ROW EXECUTE FUNCTION workflow_events_reject_mutation();

CREATE TRIGGER workflow_events_immutable_truncate
  BEFORE TRUNCATE ON workflow_events
  FOR EACH STATEMENT EXECUTE FUNCTION workflow_events_reject_mutation();

-- Append-only evidence: step attempts.
CREATE OR REPLACE FUNCTION workflow_step_attempts_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'workflow step attempts are append-only evidence (W080 durable runtime): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workflow_step_attempts_immutable
  BEFORE UPDATE OR DELETE ON workflow_step_attempts
  FOR EACH ROW EXECUTE FUNCTION workflow_step_attempts_reject_mutation();

CREATE TRIGGER workflow_step_attempts_immutable_truncate
  BEFORE TRUNCATE ON workflow_step_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION workflow_step_attempts_reject_mutation();

-- Signals are append-only EXCEPT their consumption stamp (the actions
-- module's decision-state pattern): only consumed_at may change.
CREATE OR REPLACE FUNCTION workflow_run_signals_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'workflow run signals are durable delivery evidence (W080 durable runtime): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'workflow run signals are durable delivery evidence (W080 durable runtime): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'UPDATE' AND (to_jsonb(OLD) - 'consumed_at') IS DISTINCT FROM (to_jsonb(NEW) - 'consumed_at') THEN
    RAISE EXCEPTION 'workflow run signals are append-only except consumed_at (W080 durable runtime): only the consumption stamp may change on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workflow_run_signals_guard_update_delete
  BEFORE UPDATE OR DELETE ON workflow_run_signals
  FOR EACH ROW EXECUTE FUNCTION workflow_run_signals_guard();

CREATE TRIGGER workflow_run_signals_guard_truncate
  BEFORE TRUNCATE ON workflow_run_signals
  FOR EACH STATEMENT EXECUTE FUNCTION workflow_run_signals_guard();

-- Runs and steps are state machines: they may advance (UPDATE) — that is
-- how resumability moves — but identity and history are never erased.

CREATE OR REPLACE FUNCTION workflow_runs_reject_erasure() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'workflow runs cannot be erased (W080 durable runtime): % is forbidden on table % — cancel the run instead',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workflow_runs_immutable_delete
  BEFORE DELETE ON workflow_runs
  FOR EACH ROW EXECUTE FUNCTION workflow_runs_reject_erasure();

CREATE TRIGGER workflow_runs_immutable_truncate
  BEFORE TRUNCATE ON workflow_runs
  FOR EACH STATEMENT EXECUTE FUNCTION workflow_runs_reject_erasure();

CREATE OR REPLACE FUNCTION workflow_run_steps_reject_erasure() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'workflow run steps cannot be erased (W080 durable runtime): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workflow_run_steps_immutable_delete
  BEFORE DELETE ON workflow_run_steps
  FOR EACH ROW EXECUTE FUNCTION workflow_run_steps_reject_erasure();

CREATE TRIGGER workflow_run_steps_immutable_truncate
  BEFORE TRUNCATE ON workflow_run_steps
  FOR EACH STATEMENT EXECUTE FUNCTION workflow_run_steps_reject_erasure();

-- Definitions may be re-versioned (UPDATE of the current-version pointer
-- or status) but never erased; retire them. Version rows are append-only.

CREATE OR REPLACE FUNCTION workflow_definition_versions_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'workflow definition versions are append-only (W080 durable runtime): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workflow_definition_versions_immutable
  BEFORE UPDATE OR DELETE ON workflow_definition_versions
  FOR EACH ROW EXECUTE FUNCTION workflow_definition_versions_reject_mutation();

CREATE TRIGGER workflow_definition_versions_immutable_truncate
  BEFORE TRUNCATE ON workflow_definition_versions
  FOR EACH STATEMENT EXECUTE FUNCTION workflow_definition_versions_reject_mutation();

CREATE OR REPLACE FUNCTION workflow_definitions_reject_erasure() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'workflow definitions cannot be erased (W080 durable runtime): % is forbidden on table % — retire the definition instead',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workflow_definitions_immutable_delete
  BEFORE DELETE ON workflow_definitions
  FOR EACH ROW EXECUTE FUNCTION workflow_definitions_reject_erasure();

CREATE TRIGGER workflow_definitions_immutable_truncate
  BEFORE TRUNCATE ON workflow_definitions
  FOR EACH STATEMENT EXECUTE FUNCTION workflow_definitions_reject_erasure();
