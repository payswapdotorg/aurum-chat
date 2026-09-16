-- W051 · attention module — unprompted unknown discovery (ADR-0017).
--
-- Two tables:
--
--   goal_gap_policies   — the tenant's deterministic materiality policy
--                         (THE policy gate on mission creation). A
--                         management control like the actions module's
--                         authority policies: updatable, not evidence.
--                         The DECISIONS it produces are snapshotted
--                         immutably on every candidate_unknowns row, so
--                         changing the policy never rewrites why a past
--                         discovery was material or immaterial.
--
--   candidate_unknowns  — the auditable discovery artifact: one material
--                         goal/evidence gap discovered WITHOUT a user
--                         question. Every row records which goal, which
--                         evidence, which decision impact, which urgency,
--                         which confidence gap and which information value
--                         produced it (ADR-0017's "Every candidate unknown
--                         is reconstructable"), plus the policy snapshot
--                         that decided materiality and — once
--                         materialized — the epistemic unknown and
--                         LearningMission it became.
--
-- Retention discipline (the epistemics module's precedent, applied to
-- discoveries): identity, evidence links and the materiality decision are
-- FROZEN after insert; the only legal mutation is the one-way
-- material -> materialized transition that links the created unknown and
-- mission; 'immaterial' rows are terminal on arrival (they never become
-- missions — ADR-0017's core invariant); DELETE/TRUNCATE are rejected
-- outright, even for a caller bypassing the service.
--
-- Cross-module references (goals, cognitive executions, observations,
-- claims, unknowns, missions) are deliberately NOT foreign keys — the
-- codebase discipline: links are validated through the owning modules'
-- contracts at write time and stored as opaque uuids / sorted jsonb
-- arrays.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; two tenants
-- hold fully independent discovery policies and candidates, and
-- cross-tenant access is indistinguishable from missing records at the
-- service layer.

-- ---------------------------------------------------------------------------
-- Discovery policies — the deterministic materiality gate configuration
-- ---------------------------------------------------------------------------

CREATE TABLE goal_gap_policies (
  tenant_id uuid PRIMARY KEY,
  min_decision_impact double precision NOT NULL
    CHECK (min_decision_impact >= 0 AND min_decision_impact <= 1),
  min_information_value double precision NOT NULL
    CHECK (min_information_value >= 0 AND min_information_value <= 1),
  mission_policy text NOT NULL CHECK (mission_policy IN ('auto', 'manual')),
  investigation_budget_amount bigint NOT NULL
    CHECK (investigation_budget_amount >= 0 AND investigation_budget_amount <= 9007199254740991),
  investigation_budget_currency text NOT NULL
    CHECK (char_length(investigation_budget_currency) = 3),
  reward_budget_amount bigint NOT NULL
    CHECK (reward_budget_amount >= 0 AND reward_budget_amount <= 9007199254740991),
  reward_budget_currency text NOT NULL
    CHECK (char_length(reward_budget_currency) = 3),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL CHECK (char_length(updated_by) >= 1)
);

-- ---------------------------------------------------------------------------
-- Candidate unknowns — the auditable unprompted discoveries
-- ---------------------------------------------------------------------------

CREATE TABLE candidate_unknowns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  goal_id uuid NOT NULL,
  metric_name text,
  missing_knowledge text NOT NULL
    CHECK (char_length(missing_knowledge) >= 1 AND char_length(missing_knowledge) <= 2048),
  impact_description text NOT NULL
    CHECK (char_length(impact_description) >= 1 AND char_length(impact_description) <= 2048),
  decision_impact double precision NOT NULL
    CHECK (decision_impact >= 0 AND decision_impact <= 1),
  information_value double precision NOT NULL
    CHECK (information_value >= 0 AND information_value <= 1),
  urgency text NOT NULL CHECK (urgency IN ('critical', 'high', 'medium', 'low')),
  current_confidence double precision NOT NULL
    CHECK (current_confidence >= 0 AND current_confidence <= 1),
  required_confidence double precision NOT NULL
    CHECK (required_confidence >= 0 AND required_confidence <= 1),
  -- The gap rule: a gap without a confidence shortfall is not a gap.
  CONSTRAINT candidate_unknowns_confidence_gap CHECK (required_confidence > current_confidence),
  evidence_observation_ids jsonb NOT NULL
    CONSTRAINT candidate_unknowns_evidence_shape CHECK (
      jsonb_typeof(evidence_observation_ids) = 'array'
      AND jsonb_array_length(evidence_observation_ids) >= 1
    ),
  evidence_claim_ids jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence_claim_ids) = 'array'),
  acquisition_paths jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(acquisition_paths) = 'array'),
  proposer_kind text NOT NULL
    CHECK (proposer_kind IN ('person', 'team', 'agent', 'system', 'external')),
  proposer_id uuid,
  proposer_label text,
  -- A proposal must be traceable: an id or a label.
  CONSTRAINT candidate_unknowns_proposer_shape CHECK (
    (proposer_id IS NULL AND proposer_label IS NOT NULL)
    OR proposer_id IS NOT NULL
  ),
  proposer_note text,
  execution_id uuid,
  status text NOT NULL
    CHECK (status IN ('immaterial', 'material', 'materialized')),
  -- The policy snapshot that decided this discovery (audit: reconstructable
  -- even after the policy itself changes).
  min_decision_impact double precision NOT NULL
    CHECK (min_decision_impact >= 0 AND min_decision_impact <= 1),
  min_information_value double precision NOT NULL
    CHECK (min_information_value >= 0 AND min_information_value <= 1),
  materiality_basis text NOT NULL CHECK (char_length(materiality_basis) >= 1),
  recorded_by text NOT NULL CHECK (char_length(recorded_by) >= 1),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  unknown_id uuid,
  mission_id uuid,
  materialized_at timestamptz,
  materialized_by text,
  CONSTRAINT candidate_unknowns_materialization_shape CHECK (
    (status IN ('immaterial', 'material')
      AND unknown_id IS NULL
      AND mission_id IS NULL
      AND materialized_at IS NULL
      AND materialized_by IS NULL)
    OR (status = 'materialized'
      AND unknown_id IS NOT NULL
      AND mission_id IS NOT NULL
      AND materialized_at IS NOT NULL
      AND materialized_by IS NOT NULL)
  )
);

-- One candidate per (tenant, goal, metric, missing-knowledge statement):
-- re-registration of the same gap is a candidate_conflict, forcing the
-- caller to look at what is already recorded (the contradictions module's
-- canonical-pair precedent). COALESCE folds a NULL metric into the key.
CREATE UNIQUE INDEX candidate_unknowns_gap_unique
  ON candidate_unknowns (tenant_id, goal_id, COALESCE(metric_name, ''), missing_knowledge);

CREATE INDEX candidate_unknowns_tenant_recorded_idx
  ON candidate_unknowns (tenant_id, recorded_at DESC);
CREATE INDEX candidate_unknowns_tenant_goal_idx ON candidate_unknowns (tenant_id, goal_id);
CREATE INDEX candidate_unknowns_tenant_status_idx ON candidate_unknowns (tenant_id, status);
CREATE INDEX candidate_unknowns_tenant_execution_idx
  ON candidate_unknowns (tenant_id, execution_id);
CREATE INDEX candidate_unknowns_tenant_proposer_idx
  ON candidate_unknowns (tenant_id, proposer_kind, proposer_id);

-- Retention guard: identity, evidence links, the materiality decision and
-- the audit quartet are FROZEN; the only legal mutation is the one-way
-- material -> materialized transition (which must SET the materialization
-- fields); immaterial rows are terminal on arrival; DELETE/TRUNCATE are
-- forbidden — a discovery record is retained evidence of how the unknown
-- came to exist.
CREATE OR REPLACE FUNCTION candidate_unknowns_retention_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'candidate unknowns are retained (W051 attention / ADR-0017): % is forbidden on table %',
      TG_OP, TG_TABLE_NAME;
  END IF;
  IF OLD.status = 'immaterial' OR OLD.status = 'materialized' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.goal_id IS DISTINCT FROM OLD.goal_id
      OR NEW.metric_name IS DISTINCT FROM OLD.metric_name
      OR NEW.missing_knowledge IS DISTINCT FROM OLD.missing_knowledge
      OR NEW.impact_description IS DISTINCT FROM OLD.impact_description
      OR NEW.decision_impact IS DISTINCT FROM OLD.decision_impact
      OR NEW.information_value IS DISTINCT FROM OLD.information_value
      OR NEW.urgency IS DISTINCT FROM OLD.urgency
      OR NEW.current_confidence IS DISTINCT FROM OLD.current_confidence
      OR NEW.required_confidence IS DISTINCT FROM OLD.required_confidence
      OR NEW.evidence_observation_ids IS DISTINCT FROM OLD.evidence_observation_ids
      OR NEW.evidence_claim_ids IS DISTINCT FROM OLD.evidence_claim_ids
      OR NEW.acquisition_paths IS DISTINCT FROM OLD.acquisition_paths
      OR NEW.proposer_kind IS DISTINCT FROM OLD.proposer_kind
      OR NEW.proposer_id IS DISTINCT FROM OLD.proposer_id
      OR NEW.proposer_label IS DISTINCT FROM OLD.proposer_label
      OR NEW.proposer_note IS DISTINCT FROM OLD.proposer_note
      OR NEW.execution_id IS DISTINCT FROM OLD.execution_id
      OR NEW.status IS DISTINCT FROM OLD.status
      OR NEW.min_decision_impact IS DISTINCT FROM OLD.min_decision_impact
      OR NEW.min_information_value IS DISTINCT FROM OLD.min_information_value
      OR NEW.materiality_basis IS DISTINCT FROM OLD.materiality_basis
      OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by
      OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at
      OR NEW.unknown_id IS DISTINCT FROM OLD.unknown_id
      OR NEW.mission_id IS DISTINCT FROM OLD.mission_id
      OR NEW.materialized_at IS DISTINCT FROM OLD.materialized_at
      OR NEW.materialized_by IS DISTINCT FROM OLD.materialized_by THEN
      RAISE EXCEPTION 'terminal candidate unknowns cannot be rewritten (W051 attention): table %',
        TG_TABLE_NAME;
    END IF;
  ELSIF OLD.status = 'material' AND NEW.status = 'materialized' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.goal_id IS DISTINCT FROM OLD.goal_id
      OR NEW.metric_name IS DISTINCT FROM OLD.metric_name
      OR NEW.missing_knowledge IS DISTINCT FROM OLD.missing_knowledge
      OR NEW.impact_description IS DISTINCT FROM OLD.impact_description
      OR NEW.decision_impact IS DISTINCT FROM OLD.decision_impact
      OR NEW.information_value IS DISTINCT FROM OLD.information_value
      OR NEW.urgency IS DISTINCT FROM OLD.urgency
      OR NEW.current_confidence IS DISTINCT FROM OLD.current_confidence
      OR NEW.required_confidence IS DISTINCT FROM OLD.required_confidence
      OR NEW.evidence_observation_ids IS DISTINCT FROM OLD.evidence_observation_ids
      OR NEW.evidence_claim_ids IS DISTINCT FROM OLD.evidence_claim_ids
      OR NEW.acquisition_paths IS DISTINCT FROM OLD.acquisition_paths
      OR NEW.proposer_kind IS DISTINCT FROM OLD.proposer_kind
      OR NEW.proposer_id IS DISTINCT FROM OLD.proposer_id
      OR NEW.proposer_label IS DISTINCT FROM OLD.proposer_label
      OR NEW.proposer_note IS DISTINCT FROM OLD.proposer_note
      OR NEW.execution_id IS DISTINCT FROM OLD.execution_id
      OR NEW.min_decision_impact IS DISTINCT FROM OLD.min_decision_impact
      OR NEW.min_information_value IS DISTINCT FROM OLD.min_information_value
      OR NEW.materiality_basis IS DISTINCT FROM OLD.materiality_basis
      OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by
      OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
      RAISE EXCEPTION 'candidate unknown identity, evidence and materiality are frozen (W051 attention): % on table % would rewrite the retained discovery',
        TG_OP, TG_TABLE_NAME;
    END IF;
    IF NEW.unknown_id IS NULL OR NEW.mission_id IS NULL
      OR NEW.materialized_at IS NULL OR NEW.materialized_by IS NULL THEN
      RAISE EXCEPTION 'materialization must link the unknown and the mission (W051 attention): table %',
        TG_TABLE_NAME;
    END IF;
  ELSE
    RAISE EXCEPTION 'candidate unknown status may only move forward material -> materialized (W051 attention): illegal transition on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER candidate_unknowns_retention
  BEFORE UPDATE OR DELETE ON candidate_unknowns
  FOR EACH ROW EXECUTE FUNCTION candidate_unknowns_retention_guard();

CREATE TRIGGER candidate_unknowns_retention_truncate
  BEFORE TRUNCATE ON candidate_unknowns
  FOR EACH STATEMENT EXECUTE FUNCTION candidate_unknowns_retention_guard();
