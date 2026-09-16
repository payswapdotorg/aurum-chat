-- W051 · attention module — unprompted unknown discovery (goal-gap
-- discovery per ADR-0017).
--
-- MODULE PLACEMENT: `attention` is the frozen module map's L2 member
-- between goals and missions (ARCHITECTURE.md §26; IMPLEMENTATION-STACK
-- §10; MODULE-DEPENDENCY-MAP.md L2 "epistemics, goals, attention,
-- investigation, missions, knowledge-acquisition, cognition"). §19's
-- connection list places attention exactly where this capability sits
-- ("...goals, attention, unknowns, learning missions..."), and §12's
-- external-intelligence chain ends "attention decision → mission or
-- recommendation" — the materiality gate. No other catalog work item
-- claims the attention module; W051 owns it.
--
-- The work item: "Implement goal-gap discovery per ADR-0017: material
-- goal/evidence gaps create candidate unknowns without a user question;
-- candidate unknowns contain impact, urgency, confidence gap and
-- information value; only material unknowns become missions; discovery
-- is evidence-linked and auditable; end-to-end synthetic proof exists."
--
-- Two tables, both FULLY append-only (the W040/W012 discipline — a
-- discovery pass and its decisions are evidence of what Aurum attended
-- to; there is no UPDATE anywhere):
--
--   discovery_runs        — one immutable row per discovery pass: the
--                           trigger, the optional originating cognitive
--                           execution (validated readable through the
--                           cognition contract at write time — the
--                           sanctioned W013 → W051 dependency; ADR-0017
--                           drives discovery from goal-evaluation, which
--                           is the loop's stage 5), the actor, the
--                           MATERIALIZATION POLICY SNAPSHOT (both
--                           thresholds — the policy gate is auditable per
--                           run, never a silent judgment), the per-mission
--                           budgets promotions launch with, and the
--                           authenticated principal + service clock.
--
--   discovery_candidates  — one immutable row per candidate unknown: the
--                           full ADR-0017 field set (affected goals as
--                           opaque forward references — the missions
--                           module's affected-goals precedent, no
--                           cross-module FK; missing knowledge + consequence
--                           text; decision impact, urgency, the confidence
--                           gap pair, expected information value as
--                           CHECK-bounded doubles; the evidence basis as
--                           claim/belief uuid arrays validated readable
--                           through the epistemics contract at write time;
--                           acquisition paths in the §7/missions menu
--                           shape) PLUS the application's decision:
--                           disposition ('promoted' with the recorded
--                           epistemics unknown id AND the launched
--                           mission id; 'dismissed' with neither; or
--                           'already_covered' with the active mission that
--                           already closes this exact gap — discovery does
--                           not spam duplicates) and the stable gap_key
--                           the cross-run coverage check matches on.
--
-- There is deliberately NO operation to update or erase a run, re-decide
-- a candidate, un-promote or delete anything: PostgreSQL itself rejects
-- UPDATE/DELETE/TRUNCATE on both tables (triggers below), even for a
-- caller bypassing the service. Discovery decisions are reconstructable
-- end to end: which goal, which evidence, which policy, which decision
-- (ADR-0017's consequence).
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the composite
-- FK (run_id, tenant_id) → discovery_runs (id, tenant_id) makes a
-- cross-tenant candidate unrepresentable in SQL (the mission_versions /
-- outcome_measurements pattern).

CREATE TABLE discovery_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  trigger_kind text NOT NULL
    CHECK (trigger_kind IN ('cognitive-execution', 'scheduled', 'manual')),
  trigger_label text
    CHECK (trigger_label IS NULL OR char_length(trigger_label) BETWEEN 1 AND 200),
  origin_execution_id text
    CHECK (origin_execution_id IS NULL
      OR origin_execution_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  -- A cognitive-execution trigger without its loop linkage is unrepresentable.
  CONSTRAINT discovery_runs_trigger_shape CHECK (
    (trigger_kind = 'cognitive-execution' AND origin_execution_id IS NOT NULL)
    OR (trigger_kind <> 'cognitive-execution')
  ),
  actor_kind text NOT NULL CHECK (actor_kind IN ('person', 'team', 'agent', 'system', 'external')),
  actor_id text,
  actor_label text,
  impact_threshold double precision NOT NULL
    CHECK (impact_threshold > 0 AND impact_threshold <= 1),
  value_threshold double precision NOT NULL
    CHECK (value_threshold > 0 AND value_threshold <= 1),
  investigation_budget_amount bigint NOT NULL CHECK (investigation_budget_amount >= 0),
  investigation_budget_currency text NOT NULL
    CHECK (investigation_budget_currency ~ '^[A-Z]{3}$'),
  reward_budget_amount bigint NOT NULL CHECK (reward_budget_amount >= 0),
  reward_budget_currency text NOT NULL
    CHECK (reward_budget_currency ~ '^[A-Z]{3}$'),
  ran_by_principal text NOT NULL,
  rationale text
    CHECK (rationale IS NULL OR char_length(rationale) BETWEEN 1 AND 2000),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  -- The acting party is traceable (the missions actor rule).
  CONSTRAINT discovery_runs_actor_traceable CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL),
  -- The composite target of the tenant-scoped FK below.
  CONSTRAINT discovery_runs_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX discovery_runs_tenant_idx ON discovery_runs (tenant_id, recorded_at);
CREATE INDEX discovery_runs_origin_idx ON discovery_runs (tenant_id, origin_execution_id);

CREATE TABLE discovery_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  gap_key text NOT NULL CHECK (char_length(gap_key) BETWEEN 1 AND 300),
  source text NOT NULL CHECK (source IN ('derived', 'proposed')),
  gap_kind text NOT NULL CHECK (gap_kind IN ('driver', 'reading', 'standing', 'custom')),
  affected_goals jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(affected_goals) = 'array' AND jsonb_array_length(affected_goals) BETWEEN 1 AND 4),
  missing_knowledge text NOT NULL CHECK (char_length(missing_knowledge) BETWEEN 1 AND 2000),
  consequence text NOT NULL CHECK (char_length(consequence) BETWEEN 1 AND 2000),
  decision_impact double precision NOT NULL
    CHECK (decision_impact >= 0 AND decision_impact <= 1),
  urgency text NOT NULL CHECK (urgency IN ('critical', 'high', 'medium', 'low')),
  current_confidence double precision NOT NULL
    CHECK (current_confidence >= 0 AND current_confidence <= 1),
  required_confidence double precision NOT NULL
    CHECK (required_confidence >= 0 AND required_confidence <= 1),
  information_value double precision NOT NULL
    CHECK (information_value >= 0 AND information_value <= 1),
  evidence_claim_ids jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence_claim_ids) = 'array'),
  evidence_belief_ids jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence_belief_ids) = 'array'),
  acquisition_paths jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(acquisition_paths) = 'array'),
  disposition text NOT NULL CHECK (disposition IN ('promoted', 'dismissed', 'already_covered')),
  epistemics_unknown_id text
    CHECK (epistemics_unknown_id IS NULL
      OR epistemics_unknown_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  mission_id text
    CHECK (mission_id IS NULL
      OR mission_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  covered_by_mission_id text
    CHECK (covered_by_mission_id IS NULL
      OR covered_by_mission_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  -- Same-tenant candidate of this run only.
  CONSTRAINT discovery_candidates_run_fk
    FOREIGN KEY (run_id, tenant_id) REFERENCES discovery_runs (id, tenant_id),
  -- The decision shapes are surgical: a promotion carries BOTH the
  -- recorded epistemics unknown and the launched mission (and no
  -- coverage); a dismissal carries none of the three; a coverage record
  -- carries the covering mission only.
  CONSTRAINT discovery_candidates_disposition_shape CHECK (
    (disposition = 'promoted'
       AND epistemics_unknown_id IS NOT NULL AND mission_id IS NOT NULL
       AND covered_by_mission_id IS NULL)
    OR (disposition = 'dismissed'
       AND epistemics_unknown_id IS NULL AND mission_id IS NULL
       AND covered_by_mission_id IS NULL)
    OR (disposition = 'already_covered'
       AND epistemics_unknown_id IS NULL AND mission_id IS NULL
       AND covered_by_mission_id IS NOT NULL)
  )
);

-- The cross-run coverage check matches promoted candidates by gap key.
CREATE INDEX discovery_candidates_gap_idx
  ON discovery_candidates (tenant_id, gap_key, disposition);
-- The run's candidate chain, ascending in decision order.
CREATE INDEX discovery_candidates_run_idx
  ON discovery_candidates (tenant_id, run_id, recorded_at);
-- The management list filter (runs touching one goal).
CREATE INDEX discovery_candidates_goals_idx
  ON discovery_candidates USING gin (affected_goals jsonb_path_ops);

-- Storage-level audit guarantee: discovery runs and candidate decisions
-- are append-only. Nothing may UPDATE, DELETE or TRUNCATE either — not
-- even a future module bypassing the service. The message names no row
-- id so the same function serves the row-level and statement-level
-- triggers.

CREATE OR REPLACE FUNCTION discovery_runs_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'discovery runs are append-only (W051 unprompted unknown discovery): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER discovery_runs_immutable
  BEFORE UPDATE OR DELETE ON discovery_runs
  FOR EACH ROW EXECUTE FUNCTION discovery_runs_reject_mutation();

CREATE TRIGGER discovery_runs_immutable_truncate
  BEFORE TRUNCATE ON discovery_runs
  FOR EACH STATEMENT EXECUTE FUNCTION discovery_runs_reject_mutation();

CREATE OR REPLACE FUNCTION discovery_candidates_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'discovery candidates are append-only (W051 candidate unknown decisions): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER discovery_candidates_immutable
  BEFORE UPDATE OR DELETE ON discovery_candidates
  FOR EACH ROW EXECUTE FUNCTION discovery_candidates_reject_mutation();

CREATE TRIGGER discovery_candidates_immutable_truncate
  BEFORE TRUNCATE ON discovery_candidates
  FOR EACH STATEMENT EXECUTE FUNCTION discovery_candidates_reject_mutation();
