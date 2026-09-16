-- W013 · cognition module — the canonical company intelligence loop as
-- explicit asynchronous/resumable executions with policy gates and
-- outcome recording.
--
-- ARCHITECTURE.md §19 (frozen): "Cognitive orchestration connects
-- perception, evidence, world model, goals, attention, unknowns, learning
-- missions, investigation, learning, capability analysis, recommendations
-- and action policy. Canonical execution:
-- `observation → evidence/memory → world update → epistemic evaluation
--  → goal evaluation → unknown/mission evaluation → knowledge
--  acquisition → model update → risk/opportunity/capability analysis
--  → recommendation/ask/proposal/action → outcome → learning`.
-- Cognitive executions are explicit, asynchronous, resumable and
-- traceable." Lock 36: "Long-running cognition and execution are
-- asynchronous, resumable and traceable." §25: "Executions carry
-- correlation and causation identities."
--
-- Two tables, the missions module's (W011) split discipline:
--
--   cognitive_executions — the EXECUTION record: identity, trigger,
--                       focus, actor, correlation/causation identities
--                       (§25), the lifecycle state machine (running →
--                       awaiting_input / awaiting_approval → completed /
--                       abandoned) with its pending pointers, the
--                       canonical position (current_stage = completed
--                       canonical stages, 0..12) and the cycle's recorded
--                       OUTCOME. The lifecycle columns (state,
--                       current_stage, pending_*, outcome_*, timestamps)
--                       are the ONLY mutable part — that is what
--                       "resumable" means in storage: an execution is a
--                       durable state machine a worker pumps forward one
--                       canonical stage at a time (runNextStage). DELETE
--                       and TRUNCATE are rejected by trigger — an
--                       execution's identity and history are never erased
--                       (abandonment, a terminal transition with a
--                       required reason, is the retirement path).
--
--   cognitive_execution_steps — the append-only TRACE: exactly one row
--                       per canonical stage, in canonical order (unique
--                       (execution, stage_number); the service only ever
--                       appends stage_number = current_stage + 1 under an
--                       optimistic pointer guard). Each row carries the
--                       audit quartet — who (advanced_by_principal, the
--                       authenticated TenantContext principal), when
--                       (recorded_at, service clock), what (the stage +
--                       the validated input snapshot + the structured
--                       result: recorded observation/claim/unknown/
--                       mission/belief/entity ids, the acquisition plan
--                       chain, the policy-gate snapshot) and implicitly
--                       why (the input snapshot's rationale fields).
--                       UPDATE/DELETE/TRUNCATE are rejected by triggers —
--                       the trace cannot be rewritten even by a caller
--                       bypassing the service (same discipline as mission
--                       versions W011 and events W003), which is what
--                       keeps consequential cognition reconstructable
--                       (§24: input → evidence → … → policy → … →
--                       outcome → learning).
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the composite
-- FK (execution_id, tenant_id) → cognitive_executions (id, tenant_id)
-- makes a cross-tenant step unrepresentable in SQL even for a caller
-- that bypasses the service (same pattern as mission_versions, W011).

CREATE TABLE cognitive_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  -- What started the cycle (provider-neutral; an observation trigger is
  -- validated readable through the observations contract at start).
  trigger_kind text NOT NULL CHECK (
    trigger_kind IN ('observation', 'conversation', 'mission', 'management', 'system', 'schedule')
  ),
  trigger_id uuid,
  trigger_label text
    CHECK (trigger_label IS NULL OR char_length(trigger_label) BETWEEN 1 AND 200),
  -- What the cycle attends to (retrieval topics + opaque entity refs).
  focus_topics jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(focus_topics) = 'array'),
  focus_entities jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(focus_entities) = 'array'),
  -- Who/what drives the loop.
  actor_kind text NOT NULL CHECK (
    actor_kind IN ('person', 'team', 'agent', 'system', 'external')
  ),
  actor_id uuid,
  actor_label text
    CHECK (actor_label IS NULL OR char_length(actor_label) BETWEEN 1 AND 200),
  -- §25 correlation/causation identities.
  correlation_id uuid NOT NULL,
  causation_kind text CHECK (
    causation_kind IS NULL OR causation_kind IN (
      'execution', 'event', 'conversation-message', 'mission', 'observation', 'schedule'
    )
  ),
  causation_id uuid,
  -- The lifecycle state machine (lock 36).
  state text NOT NULL DEFAULT 'running' CHECK (
    state IN ('running', 'awaiting_input', 'awaiting_approval', 'completed', 'abandoned')
  ),
  -- Completed canonical stages, 0..12 (§19's twelve arrows).
  current_stage integer NOT NULL DEFAULT 0
    CHECK (current_stage >= 0 AND current_stage <= 12),
  -- Suspension pointers: what the in-progress stage waits on.
  pending_plan_id uuid,
  pending_request_id uuid,
  -- The cycle's recorded outcome (written by the outcome stage).
  outcome_kind text CHECK (
    outcome_kind IS NULL OR outcome_kind IN ('action-authorized', 'action-refused', 'no-action')
  ),
  outcome_summary text
    CHECK (outcome_summary IS NULL OR char_length(outcome_summary) BETWEEN 1 AND 4000),
  outcome_recorded_at timestamptz,
  outcome_action_request_id uuid,
  -- The abandonment record (terminal transition with a required why).
  abandon_reason text
    CHECK (abandon_reason IS NULL OR char_length(abandon_reason) BETWEEN 1 AND 2000),
  abandoned_at timestamptz,
  rationale text
    CHECK (rationale IS NULL OR char_length(rationale) BETWEEN 1 AND 2000),
  started_by_principal text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT cognitive_executions_id_tenant_unique UNIQUE (id, tenant_id),
  -- Provenance must be traceable.
  CONSTRAINT cognitive_executions_trigger_traceable CHECK (
    trigger_kind = 'observation' OR trigger_id IS NOT NULL OR trigger_label IS NOT NULL
  ),
  CONSTRAINT cognitive_executions_actor_traceable CHECK (
    actor_id IS NOT NULL OR actor_label IS NOT NULL
  ),
  -- An observation trigger always carries the observation's uuid.
  CONSTRAINT cognitive_executions_observation_trigger CHECK (
    trigger_kind <> 'observation' OR trigger_id IS NOT NULL
  ),
  -- Causation is an id-kind pair.
  CONSTRAINT cognitive_executions_causation_pair CHECK (
    (causation_kind IS NULL) = (causation_id IS NULL)
  ),
  -- Suspensions carry exactly their pending pointer.
  CONSTRAINT cognitive_executions_awaiting_input_plan CHECK (
    (state = 'awaiting_input') = (pending_plan_id IS NOT NULL)
  ),
  CONSTRAINT cognitive_executions_awaiting_approval_request CHECK (
    (state = 'awaiting_approval') = (pending_request_id IS NOT NULL)
  ),
  -- Only one suspension pointer at a time (one state, one wait).
  CONSTRAINT cognitive_executions_single_pending CHECK (
    NOT (pending_plan_id IS NOT NULL AND pending_request_id IS NOT NULL)
  ),
  -- The outcome record is present or absent as a whole.
  CONSTRAINT cognitive_executions_outcome_shape CHECK (
    (outcome_kind IS NULL) = (outcome_summary IS NULL)
    AND (outcome_kind IS NULL) = (outcome_recorded_at IS NULL)
  ),
  -- Completion is exactly "every canonical stage done".
  CONSTRAINT cognitive_executions_completed_shape CHECK (
    (state = 'completed') = (current_stage = 12)
  ),
  CONSTRAINT cognitive_executions_completed_at CHECK (
    (state = 'completed') = (completed_at IS NOT NULL)
  ),
  -- Completion records the cycle's outcome (the outcome stage always
  -- precedes learning in canonical order).
  CONSTRAINT cognitive_executions_completed_outcome CHECK (
    state <> 'completed' OR outcome_kind IS NOT NULL
  ),
  -- Abandonment records its why; terminal states never carry the other's
  -- terminal fields.
  CONSTRAINT cognitive_executions_abandoned_shape CHECK (
    (state = 'abandoned') = (abandon_reason IS NOT NULL)
  ),
  CONSTRAINT cognitive_executions_abandoned_at CHECK (
    (state = 'abandoned') = (abandoned_at IS NOT NULL)
  ),
  CONSTRAINT cognitive_executions_terminal_exclusive CHECK (
    NOT (completed_at IS NOT NULL AND abandoned_at IS NOT NULL)
  ),
  -- Live states carry no terminal timestamps.
  CONSTRAINT cognitive_executions_live_clean CHECK (
    state IN ('completed', 'abandoned')
    OR (completed_at IS NULL AND abandoned_at IS NULL AND abandon_reason IS NULL)
  )
);

CREATE INDEX cognitive_executions_tenant_idx
  ON cognitive_executions (tenant_id, created_at DESC);
CREATE INDEX cognitive_executions_state_idx
  ON cognitive_executions (tenant_id, state);
CREATE INDEX cognitive_executions_correlation_idx
  ON cognitive_executions (tenant_id, correlation_id);

CREATE TABLE cognitive_execution_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  -- 1-based canonical position (§19's order; 1..12).
  stage_number integer NOT NULL CHECK (stage_number BETWEEN 1 AND 12),
  stage text NOT NULL CHECK (stage IN (
    'observation',
    'evidence-memory',
    'world-update',
    'epistemic-evaluation',
    'goal-evaluation',
    'unknown-mission-evaluation',
    'knowledge-acquisition',
    'model-update',
    'risk-opportunity-capability-analysis',
    'recommendation-ask-proposal-action',
    'outcome',
    'learning'
  )),
  -- The validated stage input snapshot (audit: what the driver supplied).
  input jsonb NOT NULL
    CHECK (jsonb_typeof(input) = 'object'),
  -- The structured stage outcome (ids, references, gate snapshots).
  result jsonb NOT NULL
    CHECK (jsonb_typeof(result) = 'object'),
  advanced_by_principal text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cognitive_execution_steps_unique UNIQUE (execution_id, tenant_id, stage_number),
  CONSTRAINT cognitive_execution_steps_fk
    FOREIGN KEY (execution_id, tenant_id) REFERENCES cognitive_executions (id, tenant_id),
  -- The row's slug agrees with its canonical position.
  CONSTRAINT cognitive_execution_steps_stage_agrees CHECK (
    (stage_number = 1 AND stage = 'observation')
    OR (stage_number = 2 AND stage = 'evidence-memory')
    OR (stage_number = 3 AND stage = 'world-update')
    OR (stage_number = 4 AND stage = 'epistemic-evaluation')
    OR (stage_number = 5 AND stage = 'goal-evaluation')
    OR (stage_number = 6 AND stage = 'unknown-mission-evaluation')
    OR (stage_number = 7 AND stage = 'knowledge-acquisition')
    OR (stage_number = 8 AND stage = 'model-update')
    OR (stage_number = 9 AND stage = 'risk-opportunity-capability-analysis')
    OR (stage_number = 10 AND stage = 'recommendation-ask-proposal-action')
    OR (stage_number = 11 AND stage = 'outcome')
    OR (stage_number = 12 AND stage = 'learning')
  )
);

CREATE INDEX cognitive_execution_steps_execution_idx
  ON cognitive_execution_steps (tenant_id, execution_id, stage_number);

-- Storage-level audit guarantee: a cognitive execution's trace is
-- append-only. Nothing may UPDATE, DELETE or TRUNCATE a step — not even
-- a future module bypassing the service. The message deliberately names
-- no row id so the same function serves the row-level and the
-- statement-level trigger (the missions/events precedent).

CREATE OR REPLACE FUNCTION cognitive_execution_steps_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'cognitive execution steps are append-only (W013 cognition trace): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cognitive_execution_steps_immutable
  BEFORE UPDATE OR DELETE ON cognitive_execution_steps
  FOR EACH ROW EXECUTE FUNCTION cognitive_execution_steps_reject_mutation();

CREATE TRIGGER cognitive_execution_steps_immutable_truncate
  BEFORE TRUNCATE ON cognitive_execution_steps
  FOR EACH STATEMENT EXECUTE FUNCTION cognitive_execution_steps_reject_mutation();

-- The execution record may advance its lifecycle (UPDATE) — that is how
-- resumability moves — but identity and trace are never erased.

CREATE OR REPLACE FUNCTION cognitive_executions_reject_erasure() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'cognitive executions cannot be erased (W013): % is forbidden on table % — abandon the execution instead',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cognitive_executions_immutable_delete
  BEFORE DELETE ON cognitive_executions
  FOR EACH ROW EXECUTE FUNCTION cognitive_executions_reject_erasure();

CREATE TRIGGER cognitive_executions_immutable_truncate
  BEFORE TRUNCATE ON cognitive_executions
  FOR EACH STATEMENT EXECUTE FUNCTION cognitive_executions_reject_erasure();
