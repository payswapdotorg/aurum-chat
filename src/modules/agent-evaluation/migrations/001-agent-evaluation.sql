-- W024 · agent-evaluation module — Agent Evaluation and Termination.
--
-- The work item: "Measure outcome, cost, quality, utilization, security
-- and replacement options; lifecycle changes follow policy."
--
-- Three tables:
--
--   agent_evaluations             — the MEASUREMENT: one append-only
--                                   evidence snapshot of one agent's
--                                   measured performance across the six
--                                   work-item dimensions, plus the
--                                   decision-time agent snapshot;
--   agent_evaluation_replacement_options — the compared alternatives
--                                   (1..9 per evaluation, distinct kinds),
--                                   each with the deterministic cost
--                                   comparison against the measured cost;
--   agent_lifecycle_decisions     — the POLICY: the RETAIN / MODIFY /
--                                   TERMINATE tail of the §15 agent
--                                   lifecycle, always evidence-linked to
--                                   one evaluation, with the frozen W009
--                                   gate snapshot on terminate decisions.
--
-- EVALUATIONS AND OPTIONS ARE APPEND-ONLY EVIDENCE (§24; lock 37): what
-- was measured and when is history the moment it is committed —
-- PostgreSQL itself rejects UPDATE, DELETE and TRUNCATE on both tables
-- (the agents module's attempt-evidence discipline). A later
-- measurement is a NEW evaluation row; nothing rewrites a recorded one.
--
-- DECISIONS ARE HISTORY WITH A MOVING LIFE: the substantive content
-- (agent, evaluation link, change, rationale, modification summary,
-- replacement option, gate link) is frozen from birth; only the
-- lifecycle state (status, decision trail, application trail,
-- updated_at) may move, and only forward. The guard trigger below
-- rejects DELETE/TRUNCATE outright and any UPDATE that touches a
-- substantive column (the actions module's request discipline, applied
-- to the agent lifecycle).
--
-- TERMINATION FOLLOWS POLICY (§20/lock 23): a terminate decision links
-- to its W009 action request (kind 'agent-termination', level EXECUTE —
-- opaque uuid reference, no cross-module foreign key) and freezes the
-- gate evaluation (policy_outcome + policy_resolved_via) exactly as the
-- actions module freezes it on the request, so later policy edits never
-- rewrite what gated a recorded decision. Retain/modify decisions never
-- touch the gate (§20 names agent termination, not retention or
-- modification, as matrix-governed; their actual mutations flow through
-- the agents module's own claim-gated management controls).
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the composite
-- UNIQUE (id, tenant_id) on each table is the tenant-consistent target
-- for the options' foreign key, making a cross-tenant or dangling
-- option unrepresentable in SQL.

-- ---------------------------------------------------------------------------
-- Evaluations (the measurement — append-only evidence)
-- ---------------------------------------------------------------------------

CREATE TABLE agent_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  -- the evaluated agent (W021); opaque reference + decision-time snapshot
  agent_id uuid NOT NULL,
  agent_slug text NOT NULL CHECK (agent_slug <> ''),
  agent_role text NOT NULL CHECK (agent_role <> ''),
  agent_provider text NOT NULL CHECK (agent_provider <> ''),
  agent_status text NOT NULL CHECK (agent_status IN ('active', 'disabled')),
  agent_permissions jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(agent_permissions) = 'array'),
  -- the measured window (derived from the included submissions)
  window_from timestamptz NOT NULL,
  window_to timestamptz NOT NULL,
  -- OUTCOME (W040 learning outcomes tied to this agent)
  outcome_total integer NOT NULL CHECK (outcome_total >= 0),
  outcome_open integer NOT NULL CHECK (outcome_open >= 0),
  outcome_settled integer NOT NULL CHECK (outcome_settled >= 0),
  outcome_abandoned integer NOT NULL CHECK (outcome_abandoned >= 0),
  outcome_met integer NOT NULL CHECK (outcome_met >= 0),
  outcome_exceeded integer NOT NULL CHECK (outcome_exceeded >= 0),
  outcome_missed integer NOT NULL CHECK (outcome_missed >= 0),
  outcome_settled_expected_total double precision NOT NULL,
  outcome_settled_realized_total double precision NOT NULL,
  outcome_net_variance double precision NOT NULL,
  -- COST (W021 executions + attempts)
  cost_executions_included integer NOT NULL CHECK (cost_executions_included >= 0),
  cost_executions_truncated boolean NOT NULL,
  cost_total_minor bigint NOT NULL CHECK (cost_total_minor >= 0),
  cost_currency text NOT NULL CHECK (cost_currency = 'USD'),
  cost_succeeded_minor bigint NOT NULL CHECK (cost_succeeded_minor >= 0),
  cost_per_succeeded_minor bigint CHECK (cost_per_succeeded_minor IS NULL OR cost_per_succeeded_minor >= 0),
  cost_attempts_included integer NOT NULL CHECK (cost_attempts_included >= 0),
  cost_input_tokens_total bigint,
  cost_output_tokens_total bigint,
  cost_operations_total bigint,
  -- QUALITY (W021 terminal distribution + failure classifications)
  quality_succeeded integer NOT NULL CHECK (quality_succeeded >= 0),
  quality_failed integer NOT NULL CHECK (quality_failed >= 0),
  quality_refused integer NOT NULL CHECK (quality_refused >= 0),
  quality_cancelled integer NOT NULL CHECK (quality_cancelled >= 0),
  quality_terminal_count integer NOT NULL CHECK (quality_terminal_count >= 0),
  quality_success_rate double precision
    CHECK (quality_success_rate IS NULL OR (quality_success_rate >= 0 AND quality_success_rate <= 1)),
  quality_dispatch_failed_attempts integer NOT NULL CHECK (quality_dispatch_failed_attempts >= 0),
  quality_dispatch_rejected_attempts integer NOT NULL CHECK (quality_dispatch_rejected_attempts >= 0),
  quality_result_invalid_attempts integer NOT NULL CHECK (quality_result_invalid_attempts >= 0),
  quality_retryable_attempts integer NOT NULL CHECK (quality_retryable_attempts >= 0),
  quality_average_latency_ms integer
    CHECK (quality_average_latency_ms IS NULL OR quality_average_latency_ms >= 0),
  -- UTILIZATION (W021 submission activity)
  utilization_submissions integer NOT NULL CHECK (utilization_submissions >= 0),
  utilization_live integer NOT NULL CHECK (utilization_live >= 0),
  utilization_distinct_principals integer NOT NULL CHECK (utilization_distinct_principals >= 0),
  utilization_distinct_active_days integer NOT NULL CHECK (utilization_distinct_active_days >= 0),
  utilization_window_days integer NOT NULL CHECK (utilization_window_days >= 1),
  utilization_submissions_per_day double precision NOT NULL CHECK (utilization_submissions_per_day >= 0),
  utilization_first_submission_at timestamptz,
  utilization_last_submission_at timestamptz,
  -- SECURITY (W021 permission posture + W009 evidence on executions)
  security_requested_scope_counts jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(security_requested_scope_counts) = 'object'),
  security_over_granted_scopes jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(security_over_granted_scopes) = 'array'),
  security_approval_gated integer NOT NULL CHECK (security_approval_gated >= 0),
  security_policy_refusals integer NOT NULL CHECK (security_policy_refusals >= 0),
  security_approval_rejections integer NOT NULL CHECK (security_approval_rejections >= 0),
  security_findings jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(security_findings) = 'array'),
  -- BASIS (what the measurement actually saw)
  basis_attempts_included integer NOT NULL CHECK (basis_attempts_included >= 0),
  basis_outcomes_included integer NOT NULL CHECK (basis_outcomes_included >= 0),
  basis_outcomes_truncated boolean NOT NULL,
  -- audit
  recorded_by text NOT NULL CHECK (recorded_by <> ''),
  recorded_at timestamptz NOT NULL,
  CONSTRAINT agent_evaluations_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT agent_evaluations_window_order CHECK (window_from <= window_to),
  CONSTRAINT agent_evaluations_counts_add_up CHECK (
    outcome_total = outcome_open + outcome_settled + outcome_abandoned
  ),
  CONSTRAINT agent_evaluations_assessment_within_settled CHECK (
    outcome_met + outcome_exceeded + outcome_missed <= outcome_settled
  ),
  CONSTRAINT agent_evaluations_utilization_live_bounded CHECK (
    utilization_live <= utilization_submissions
  )
);

CREATE INDEX agent_evaluations_tenant_recorded_idx
  ON agent_evaluations (tenant_id, recorded_at DESC);
CREATE INDEX agent_evaluations_tenant_agent_idx
  ON agent_evaluations (tenant_id, agent_id, recorded_at DESC);

-- Append-only evidence (W024): evaluations are immutable history — no
-- UPDATE, no DELETE, no TRUNCATE, for any caller.

CREATE OR REPLACE FUNCTION agent_evaluations_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'agent evaluations are append-only evidence (W024 agent evaluation): UPDATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'agent evaluations are append-only evidence (W024 agent evaluation): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'agent evaluations are append-only evidence (W024 agent evaluation): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_evaluations_append_only
  BEFORE UPDATE OR DELETE ON agent_evaluations
  FOR EACH ROW EXECUTE FUNCTION agent_evaluations_guard();

CREATE TRIGGER agent_evaluations_immutable_truncate
  BEFORE TRUNCATE ON agent_evaluations
  FOR EACH STATEMENT EXECUTE FUNCTION agent_evaluations_guard();

-- ---------------------------------------------------------------------------
-- Replacement options (the compared alternatives — append-only)
-- ---------------------------------------------------------------------------

CREATE TABLE agent_evaluation_replacement_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  evaluation_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'retain', 'modify', 'train', 'reassign', 'hire',
    'automate', 'recruit', 'install', 'eliminate'
  )),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 2000),
  note text CHECK (note IS NULL OR char_length(note) <= 2000),
  estimated_cost_minor bigint CHECK (estimated_cost_minor IS NULL OR estimated_cost_minor >= 0),
  estimated_cost_currency text CHECK (estimated_cost_currency ~ '^[A-Z]{3}$'),
  estimated_weeks double precision
    CHECK (estimated_weeks IS NULL OR (estimated_weeks > 0 AND estimated_weeks <= 520)),
  recommended boolean NOT NULL DEFAULT false,
  -- the deterministic comparison against the measured cost (computed at record time)
  cost_delta_minor bigint,
  cost_comparison text NOT NULL CHECK (cost_comparison IN (
    'lower_cost', 'equal_cost', 'higher_cost', 'unknown'
  )),
  CONSTRAINT agent_evaluation_replacement_options_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT agent_evaluation_replacement_options_evaluation_fk FOREIGN KEY (evaluation_id, tenant_id)
    REFERENCES agent_evaluations (id, tenant_id)
);

-- At most one recommended option per evaluation (storage-level partial
-- uniqueness — non-recommended options are unconstrained).

CREATE UNIQUE INDEX agent_evaluation_replacement_options_one_recommended
  ON agent_evaluation_replacement_options (evaluation_id)
  WHERE recommended;


CREATE INDEX agent_evaluation_replacement_options_evaluation_idx
  ON agent_evaluation_replacement_options (tenant_id, evaluation_id);

-- Append-only evidence: the comparison is history the moment it is recorded.

CREATE OR REPLACE FUNCTION agent_evaluation_replacement_options_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'agent evaluation replacement options are append-only evidence (W024 agent evaluation): UPDATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'agent evaluation replacement options are append-only evidence (W024 agent evaluation): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'agent evaluation replacement options are append-only evidence (W024 agent evaluation): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_evaluation_replacement_options_append_only
  BEFORE UPDATE OR DELETE ON agent_evaluation_replacement_options
  FOR EACH ROW EXECUTE FUNCTION agent_evaluation_replacement_options_guard();

CREATE TRIGGER agent_evaluation_replacement_options_immutable_truncate
  BEFORE TRUNCATE ON agent_evaluation_replacement_options
  FOR EACH STATEMENT EXECUTE FUNCTION agent_evaluation_replacement_options_guard();

-- ---------------------------------------------------------------------------
-- Lifecycle decisions (the policy — history with a moving life)
-- ---------------------------------------------------------------------------

CREATE TABLE agent_lifecycle_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  -- the decided agent (W021); opaque reference + decision-time slug snapshot
  agent_id uuid NOT NULL,
  agent_slug text NOT NULL CHECK (agent_slug <> ''),
  -- the measured evidence this decision follows from (same evaluation's agent)
  evaluation_id uuid NOT NULL,
  change text NOT NULL CHECK (change IN ('retain', 'modify', 'terminate')),
  rationale text NOT NULL CHECK (char_length(rationale) BETWEEN 1 AND 2000),
  note text CHECK (note IS NULL OR char_length(note) <= 2000),
  modification_summary text
    CHECK (modification_summary IS NULL OR char_length(modification_summary) BETWEEN 1 AND 2000),
  replacement_option_id uuid,
  -- lifecycle
  status text NOT NULL CHECK (status IN (
    'recorded', 'awaiting_approval', 'approved', 'applied', 'refused'
  )),
  -- the frozen W009 gate link (terminate decisions only)
  action_request_id uuid,
  policy_outcome text CHECK (policy_outcome IN ('allowed', 'approval_required', 'forbidden')),
  policy_resolved_via text CHECK (policy_resolved_via IN ('kind', 'tenant-default', 'built-in')),
  submitted_by text,
  submitted_at timestamptz,
  decided_by text CHECK (decided_by IN ('policy', 'principal')),
  decided_by_principal text,
  decided_at timestamptz,
  -- the application trail (applied terminations only)
  applied_at timestamptz,
  applied_by_principal text,
  -- audit
  recorded_by text NOT NULL CHECK (recorded_by <> ''),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT agent_lifecycle_decisions_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT agent_lifecycle_decisions_evaluation_fk FOREIGN KEY (evaluation_id, tenant_id)
    REFERENCES agent_evaluations (id, tenant_id),
  CONSTRAINT agent_lifecycle_decisions_replacement_option_fk FOREIGN KEY (replacement_option_id, tenant_id)
    REFERENCES agent_evaluation_replacement_options (id, tenant_id),
  -- retain/modify decisions are recorded evidence: no gate, no application.
  CONSTRAINT agent_lifecycle_decisions_ungated_shape CHECK (
    (change IN ('retain', 'modify') AND status = 'recorded'
       AND action_request_id IS NULL AND policy_outcome IS NULL
       AND policy_resolved_via IS NULL AND submitted_by IS NULL AND submitted_at IS NULL
       AND decided_by IS NULL AND decided_by_principal IS NULL AND decided_at IS NULL
       AND applied_at IS NULL AND applied_by_principal IS NULL)
    OR (change = 'terminate')
  ),
  -- terminate decisions carry their gate link from birth.
  CONSTRAINT agent_lifecycle_decisions_gate_linked CHECK (
    change <> 'terminate' OR (
      status IN ('awaiting_approval', 'approved', 'applied', 'refused')
        AND action_request_id IS NOT NULL AND policy_outcome IS NOT NULL
        AND policy_resolved_via IS NOT NULL AND submitted_by IS NOT NULL AND submitted_at IS NOT NULL
    )
  ),
  -- a gate decision exists exactly on the decided terminate statuses.
  CONSTRAINT agent_lifecycle_decisions_decision_shape CHECK (
    (status = 'awaiting_approval'
       AND decided_by IS NULL AND decided_by_principal IS NULL AND decided_at IS NULL)
    OR (status IN ('approved', 'applied', 'refused')
       AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
    OR (status = 'recorded'
       AND decided_by IS NULL AND decided_by_principal IS NULL AND decided_at IS NULL)
  ),
  -- policy decisions have no deciding principal; principal decisions do.
  CONSTRAINT agent_lifecycle_decisions_decider_shape CHECK (
    decided_by IS NULL OR (
      (decided_by = 'policy' AND decided_by_principal IS NULL)
      OR (decided_by = 'principal' AND decided_by_principal IS NOT NULL)
    )
  ),
  -- application evidence exists exactly on applied terminations.
  CONSTRAINT agent_lifecycle_decisions_application_shape CHECK (
    (status = 'applied' AND applied_at IS NOT NULL AND applied_by_principal IS NOT NULL)
    OR (status <> 'applied' AND applied_at IS NULL AND applied_by_principal IS NULL)
  ),
  -- modification summaries exist exactly on modify decisions.
  CONSTRAINT agent_lifecycle_decisions_modification_shape CHECK (
    (change = 'modify') = (modification_summary IS NOT NULL)
  ),
  -- replacement options are cited by terminate decisions only.
  CONSTRAINT agent_lifecycle_decisions_replacement_shape CHECK (
    change = 'terminate' OR replacement_option_id IS NULL
  )
);

CREATE INDEX agent_lifecycle_decisions_tenant_created_idx
  ON agent_lifecycle_decisions (tenant_id, created_at DESC);
CREATE INDEX agent_lifecycle_decisions_tenant_agent_idx
  ON agent_lifecycle_decisions (tenant_id, agent_id, created_at DESC);
CREATE INDEX agent_lifecycle_decisions_tenant_status_idx
  ON agent_lifecycle_decisions (tenant_id, status);

-- History with a moving life: DELETE/TRUNCATE are forbidden outright,
-- and an UPDATE may touch ONLY the lifecycle columns (status, decision
-- trail, application trail, updated_at). The substantive decision
-- content — agent, evaluation link, change, rationale, note,
-- modification summary, replacement option, gate link, audit origin —
-- is frozen from birth (the actions module's request discipline).

CREATE OR REPLACE FUNCTION agent_lifecycle_decisions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'agent lifecycle decisions are decision evidence (W024 agent evaluation): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'agent lifecycle decisions are decision evidence (W024 agent evaluation): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.agent_id <> OLD.agent_id
     OR NEW.agent_slug <> OLD.agent_slug
     OR NEW.evaluation_id <> OLD.evaluation_id
     OR NEW.change <> OLD.change
     OR NEW.rationale <> OLD.rationale
     OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.modification_summary IS DISTINCT FROM OLD.modification_summary
     OR NEW.replacement_option_id IS DISTINCT FROM OLD.replacement_option_id
     OR NEW.action_request_id IS DISTINCT FROM OLD.action_request_id
     OR NEW.policy_outcome IS DISTINCT FROM OLD.policy_outcome
     OR NEW.policy_resolved_via IS DISTINCT FROM OLD.policy_resolved_via
     OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
     OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
     OR NEW.recorded_by <> OLD.recorded_by
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'agent lifecycle decision % is frozen evidence (W024 agent evaluation): only the lifecycle state (status, decided_by, decided_by_principal, decided_at, applied_at, applied_by_principal, updated_at) may change',
      OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_lifecycle_decisions_evidence_guard
  BEFORE UPDATE OR DELETE ON agent_lifecycle_decisions
  FOR EACH ROW EXECUTE FUNCTION agent_lifecycle_decisions_guard();

CREATE TRIGGER agent_lifecycle_decisions_immutable_truncate
  BEFORE TRUNCATE ON agent_lifecycle_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION agent_lifecycle_decisions_guard();
