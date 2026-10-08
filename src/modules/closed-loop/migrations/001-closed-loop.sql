-- W140 · closed-loop module — Loop Cycles + the two deviation-class
-- tables + Ranking Signals.
--
-- The UNIFIED CLOSED-LOOP LEARNING spine (spec/work-items/
-- WORK-ITEM-CATALOG.md §W140): one longitudinal loop-cycle record per
-- (tenant, goal) turn, citing REAL evidence from the connected seams
-- (agent-exchange runs W136, execution-fabric leases W137, org-lab
-- calibration outcomes W135, goal metrics W008 — the REALITY class;
-- coverage gaps W125, CompanyModel learning events W053 — the
-- KNOWLEDGE class) and the advisory ranking signals derived from them.
--
-- Load-bearing schema laws:
--   1. THE DEVIATION CLASSES ARE STRUCTURALLY DISTINCT TABLES. Reality
--      deviations (the world differed from expectations) and knowledge
--      deviations (our knowledge was wrong/insufficient) NEVER share a
--      row: loop_reality_deviations and loop_knowledge_deviations are
--      separate tables with class-specific columns. A deviation cannot
--      migrate between classes, be recorded as the other class, or be
--      read through the other class's path (W128's distinction made
--      structural; test-locked at the service layer).
--   2. THE EVIDENCE AND SIGNAL TABLES ARE APPEND-ONLY (§24 "Audit
--      records are append-only from the domain perspective"): all three
--      child tables reject UPDATE/DELETE/TRUNCATE outright — cited
--      deviations and recorded signals are retained evidence, never
--      rewritten.
--   3. THE CYCLE SPINE IS APPEND-AND-CLOSE: loop_cycles identity
--      columns (tenant, goal, cycle number, prediction, rationale,
--      provenance) are immutable from creation; the ONLY legal UPDATE
--      is the one-way open → closed transition stamping the frozen
--      longitudinal metrics exactly once; closed is terminal;
--      DELETE/TRUNCATE are rejected.
--   4. TENANT SCOPING (ADR-0001): every table carries tenant_id; two
--      tenants hold fully independent loops, and cross-tenant access is
--      indistinguishable from missing records at the service layer
--      (uniform typed not-found, no leak).

-- ---------------------------------------------------------------------------
-- Loop cycles — the longitudinal spine (laws 3 + 4)
-- ---------------------------------------------------------------------------
CREATE TABLE loop_cycles (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  goal_id uuid NOT NULL,
  goal_version integer NOT NULL CHECK (goal_version >= 1),
  cycle_number integer NOT NULL CHECK (cycle_number >= 1),
  status text NOT NULL CHECK (status IN ('open', 'closed')),
  predicted_score numeric NOT NULL
    CHECK (predicted_score >= 0 AND predicted_score <= 1),
  -- The frozen longitudinal metrics (present exactly once closed).
  observed_score numeric CHECK (observed_score IS NULL OR (observed_score >= 0 AND observed_score <= 1)),
  calibration_error numeric CHECK (calibration_error IS NULL OR (calibration_error >= 0 AND calibration_error <= 1)),
  gap_closure_rate numeric CHECK (gap_closure_rate IS NULL OR (gap_closure_rate >= 0 AND gap_closure_rate <= 1)),
  deviation_recurrence numeric CHECK (deviation_recurrence IS NULL OR (deviation_recurrence >= 0 AND deviation_recurrence <= 1)),
  reality_count integer NOT NULL CHECK (reality_count >= 0),
  knowledge_count integer NOT NULL CHECK (knowledge_count >= 0),
  rationale text NOT NULL CHECK (char_length(rationale) >= 1 AND char_length(rationale) <= 2000),
  close_note text,
  recorded_by text NOT NULL CHECK (char_length(recorded_by) >= 1),
  recorded_at timestamptz NOT NULL,
  closed_at timestamptz,
  closed_by text,
  -- The one-way lifecycle stamps exactly once; the frozen metrics are
  -- written exactly at the close.
  CHECK (
    (status = 'open'
       AND observed_score IS NULL AND calibration_error IS NULL
       AND gap_closure_rate IS NULL AND deviation_recurrence IS NULL
       AND reality_count = 0 AND knowledge_count = 0
       AND close_note IS NULL AND closed_at IS NULL AND closed_by IS NULL)
    OR (status = 'closed' AND close_note IS NOT NULL
       AND closed_at IS NOT NULL AND closed_by IS NOT NULL)
  )
);

CREATE UNIQUE INDEX loop_cycles_tenant_goal_number_unique
  ON loop_cycles (tenant_id, goal_id, cycle_number);
CREATE INDEX loop_cycles_tenant_goal_idx ON loop_cycles (tenant_id, goal_id, status, cycle_number);
CREATE INDEX loop_cycles_tenant_recorded_idx ON loop_cycles (tenant_id, recorded_at DESC);

-- Law 3: identity immutable; the only legal UPDATE is the one-way close;
-- DELETE/TRUNCATE rejected (the spine anchors the longitudinal record).
CREATE OR REPLACE FUNCTION loop_cycles_close_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'loop_cycles is append-and-close only: DELETE is rejected (W140 law 3)';
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'loop_cycles is append-and-close only: TRUNCATE is rejected (W140 law 3)';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.tenant_id <> OLD.tenant_id
       OR NEW.goal_id <> OLD.goal_id
       OR NEW.goal_version <> OLD.goal_version
       OR NEW.cycle_number <> OLD.cycle_number
       OR NEW.predicted_score <> OLD.predicted_score
       OR NEW.rationale <> OLD.rationale
       OR NEW.recorded_by <> OLD.recorded_by
       OR NEW.recorded_at <> OLD.recorded_at THEN
      RAISE EXCEPTION 'loop_cycles identity columns are immutable from creation (W140 law 3)';
    END IF;
    IF OLD.status = 'closed' AND NEW.status <> 'closed' THEN
      RAISE EXCEPTION 'loop_cycles lifecycle is one-way: closed is terminal (W140 law 3)';
    END IF;
    IF OLD.status = 'closed' AND (
         NEW.observed_score IS DISTINCT FROM OLD.observed_score
         OR NEW.calibration_error IS DISTINCT FROM OLD.calibration_error
         OR NEW.gap_closure_rate IS DISTINCT FROM OLD.gap_closure_rate
         OR NEW.deviation_recurrence IS DISTINCT FROM OLD.deviation_recurrence
         OR NEW.reality_count <> OLD.reality_count
         OR NEW.knowledge_count <> OLD.knowledge_count
         OR NEW.close_note IS DISTINCT FROM OLD.close_note
         OR NEW.closed_at IS DISTINCT FROM OLD.closed_at
         OR NEW.closed_by IS DISTINCT FROM OLD.closed_by) THEN
      RAISE EXCEPTION 'loop_cycles frozen metrics are immutable once closed (W140 law 3)';
    END IF;
    IF OLD.status = 'open' AND NEW.status = 'closed' AND (
         NEW.reality_count < 0 OR NEW.knowledge_count < 0
         OR NEW.close_note IS NULL OR NEW.closed_at IS NULL OR NEW.closed_by IS NULL) THEN
      RAISE EXCEPTION 'loop_cycles close must freeze the metrics and stamp the close (W140 law 3)';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER loop_cycles_close_guard
  BEFORE UPDATE OR DELETE ON loop_cycles
  FOR EACH ROW EXECUTE FUNCTION loop_cycles_close_guard();
CREATE TRIGGER loop_cycles_close_guard_truncate
  BEFORE TRUNCATE ON loop_cycles
  FOR EACH STATEMENT EXECUTE FUNCTION loop_cycles_close_guard();

-- ---------------------------------------------------------------------------
-- Reality deviations — the world differed from expectations (law 1)
-- ---------------------------------------------------------------------------
CREATE TABLE loop_reality_deviations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  cycle_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('execution_run', 'fabric_lease', 'org_calibration', 'goal_metric')),
  source_ref text NOT NULL CHECK (char_length(source_ref) >= 1 AND char_length(source_ref) <= 256),
  plan_ref text CHECK (plan_ref IS NULL OR (char_length(plan_ref) >= 1 AND char_length(plan_ref) <= 256)),
  expected numeric NOT NULL CHECK (expected >= 0 AND expected <= 1),
  observed numeric NOT NULL CHECK (observed >= 0 AND observed <= 1),
  magnitude numeric NOT NULL CHECK (magnitude >= 0 AND magnitude <= 1),
  note text NOT NULL CHECK (char_length(note) >= 1 AND char_length(note) <= 2000),
  recorded_at timestamptz NOT NULL,
  -- plan_ref exists exactly on execution_run citations.
  CHECK (
    (source_kind = 'execution_run' AND plan_ref IS NOT NULL)
    OR (source_kind <> 'execution_run' AND plan_ref IS NULL)
  )
);

CREATE INDEX loop_reality_deviations_cycle_idx
  ON loop_reality_deviations (tenant_id, cycle_id, recorded_at ASC, id ASC);
CREATE INDEX loop_reality_deviations_source_idx
  ON loop_reality_deviations (tenant_id, source_kind, source_ref);

-- Law 1 + law 2: append-only — UPDATE/DELETE/TRUNCATE rejected outright,
-- even for callers bypassing the service.
CREATE OR REPLACE FUNCTION loop_reality_append_only_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'loop_reality_deviations is append-only: % is rejected (W140 laws 1+2)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER loop_reality_append_only
  BEFORE UPDATE OR DELETE ON loop_reality_deviations
  FOR EACH ROW EXECUTE FUNCTION loop_reality_append_only_guard();
CREATE TRIGGER loop_reality_append_only_truncate
  BEFORE TRUNCATE ON loop_reality_deviations
  FOR EACH STATEMENT EXECUTE FUNCTION loop_reality_append_only_guard();

-- ---------------------------------------------------------------------------
-- Knowledge deviations — our knowledge was wrong/insufficient (law 1)
-- ---------------------------------------------------------------------------
CREATE TABLE loop_knowledge_deviations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  cycle_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('coverage_gap', 'learning_update')),
  source_ref text NOT NULL CHECK (char_length(source_ref) >= 1 AND char_length(source_ref) <= 256),
  snapshot_ref text CHECK (snapshot_ref IS NULL OR (char_length(snapshot_ref) >= 1 AND char_length(snapshot_ref) <= 256)),
  severity numeric NOT NULL CHECK (severity > 0 AND severity <= 1),
  note text NOT NULL CHECK (char_length(note) >= 1 AND char_length(note) <= 2000),
  recorded_at timestamptz NOT NULL,
  -- snapshot_ref exists exactly on coverage_gap citations.
  CHECK (
    (source_kind = 'coverage_gap' AND snapshot_ref IS NOT NULL)
    OR (source_kind = 'learning_update' AND snapshot_ref IS NULL)
  )
);

CREATE INDEX loop_knowledge_deviations_cycle_idx
  ON loop_knowledge_deviations (tenant_id, cycle_id, recorded_at ASC, id ASC);
CREATE INDEX loop_knowledge_deviations_source_idx
  ON loop_knowledge_deviations (tenant_id, source_kind, source_ref);

-- Law 1 + law 2: append-only — UPDATE/DELETE/TRUNCATE rejected outright.
CREATE OR REPLACE FUNCTION loop_knowledge_append_only_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'loop_knowledge_deviations is append-only: % is rejected (W140 laws 1+2)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER loop_knowledge_append_only
  BEFORE UPDATE OR DELETE ON loop_knowledge_deviations
  FOR EACH ROW EXECUTE FUNCTION loop_knowledge_append_only_guard();
CREATE TRIGGER loop_knowledge_append_only_truncate
  BEFORE TRUNCATE ON loop_knowledge_deviations
  FOR EACH STATEMENT EXECUTE FUNCTION loop_knowledge_append_only_guard();

-- ---------------------------------------------------------------------------
-- Ranking signals — the policy-safe learning applications (laws 2 + 4)
-- ---------------------------------------------------------------------------
CREATE TABLE loop_ranking_signals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  cycle_id uuid NOT NULL,
  target_seam text NOT NULL CHECK (target_seam IN ('info_strategy', 'org_lab', 'company_model')),
  target_ref text NOT NULL CHECK (char_length(target_ref) >= 1 AND char_length(target_ref) <= 256),
  direction text NOT NULL CHECK (direction IN ('raise', 'lower')),
  magnitude numeric NOT NULL CHECK (magnitude > 0 AND magnitude <= 1),
  basis text NOT NULL CHECK (basis IN ('reality_deviation', 'knowledge_deviation')),
  rationale text NOT NULL CHECK (char_length(rationale) >= 1 AND char_length(rationale) <= 2000),
  recorded_by text NOT NULL CHECK (char_length(recorded_by) >= 1),
  recorded_at timestamptz NOT NULL
);

CREATE INDEX loop_ranking_signals_cycle_idx
  ON loop_ranking_signals (tenant_id, cycle_id, recorded_at ASC, id ASC);
CREATE INDEX loop_ranking_signals_target_idx
  ON loop_ranking_signals (tenant_id, target_seam, target_ref);

-- Law 2: signals are append-only, reviewable evidence — never rewritten.
CREATE OR REPLACE FUNCTION loop_signals_append_only_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'loop_ranking_signals is append-only: % is rejected (W140 law 2)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER loop_signals_append_only
  BEFORE UPDATE OR DELETE ON loop_ranking_signals
  FOR EACH ROW EXECUTE FUNCTION loop_signals_append_only_guard();
CREATE TRIGGER loop_signals_append_only_truncate
  BEFORE TRUNCATE ON loop_ranking_signals
  FOR EACH STATEMENT EXECUTE FUNCTION loop_signals_append_only_guard();
