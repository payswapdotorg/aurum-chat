-- W135 · org-lab module — the Contextual Organizational Lab.
--
-- The Lab RECOMMENDS (spec/AGENT-BODY-LAB-CROSS-PLATFORM-ARCHITECTURE.md
-- §10): it registers organization candidates (§4 compositions: role
-- proposals/agent-body nodes, topology edges, information routes, the §5
-- marketplace/human/external comparison set), searches them under a
-- ContextFingerprint (§2 — the W134 seam, never re-derived here), records
-- recommendations as immutable §11 evidence objects (goal revision,
-- fingerprint, knowledge objective, candidates INCLUDING rejected
-- alternatives, model occupancies, evaluation configuration, expected
-- outcomes), and calibrates them against the learning module's frozen
-- outcome realizations. No table here grants authority, executes anything
-- or installs anything — the completion law.
--
-- Load-bearing schema laws:
--   1. CANDIDATE CONTENT IS IMMUTABLE FROM REGISTRATION. A changed design
--      is a NEW candidate (new slug) — rewriting a design under evaluation
--      would corrupt the calibration history that references it (the
--      actions module's "a changed proposal is a NEW proposal"
--      discipline). Only the one-way active → retired lifecycle moves,
--      and rows are never deleted or truncated.
--   2. RECOMMENDATIONS ARE IMMUTABLE EVIDENCE (§11 "Historical
--      recommendations are immutable"). The recommendation row's ONLY
--      legal UPDATE is the one-way recorded → calibrated transition
--      (stamping calibrated_at exactly once); the candidate evaluations,
--      occupancy snapshots and expected-outcome snapshots reject
--      UPDATE/DELETE/TRUNCATE outright — REJECTED CANDIDATES ARE RETAINED,
--      nothing silently disappears (the house evidence law).
--   3. ONE CALIBRATION PER RECOMMENDATION — UNIQUE (tenant_id,
--      recommendation_id) on the calibration table; the row is append-only.
--
-- Cross-module references are opaque forward references, deliberately NOT
-- foreign keys (the house discipline): goal → goals (W008, validated
-- ACTIVE at write time), fingerprint → context (W134, validated readable
-- and goal-matched), strategy → info-strategy (W134, optional, validated
-- readable), expected outcomes → learning (W040, validated OPEN at record
-- time; realizations consumed at calibration time), agent-body node refs →
-- agent-body (W133, validated readable+active at registration), body /
-- fabric binding ids → VERBATIM opaque ids (the agent-body opaque-seam
-- ruling), agent evaluation evidence refs → agent-evaluation (W024,
-- validated readable). Marketplace packages, tenant agents, human
-- capabilities and external specialists are opaque (kind + ref + label) —
-- their registries own the verification points.
--
-- Tenant scoping (ADR-0001): every table carries tenant_id; two tenants
-- hold fully independent Lab state, and cross-tenant access is
-- indistinguishable from missing records at the service layer.

-- ---------------------------------------------------------------------------
-- §4 The organization candidate registry.
-- ---------------------------------------------------------------------------
CREATE TABLE org_candidates (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  -- Identity: tenant-unique immutable slug.
  slug text NOT NULL
    CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  label text NOT NULL
    CHECK (char_length(label) >= 1 AND char_length(label) <= 128),
  description text
    CHECK (description IS NULL OR char_length(description) <= 2048),
  -- The §4 composition: nodes (role proposals + actor refs), edges
  -- (delegation/review/handoff/escalation/information-feed), information
  -- routes (coverage source-registry references).
  composition jsonb NOT NULL
    CHECK (jsonb_typeof(composition) = 'object'),
  -- The declared contextual applicability hypotheses (the contextual
  -- rule: caller-supplied content, matched mechanically — never
  -- industry-coded).
  applicability jsonb NOT NULL
    CHECK (jsonb_typeof(applicability) = 'object'),
  status text NOT NULL CHECK (status IN ('active', 'retired')),
  lifecycle_note text
    CHECK (lifecycle_note IS NULL OR char_length(lifecycle_note) >= 1),
  retired_at timestamptz,
  created_by text NOT NULL CHECK (char_length(created_by) >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug),
  CHECK (
    (status = 'active' AND retired_at IS NULL)
    OR (status = 'retired' AND retired_at IS NOT NULL)
  )
);

CREATE INDEX org_candidates_tenant_status_idx ON org_candidates (tenant_id, status);

-- ---------------------------------------------------------------------------
-- §11 The recommendation — the immutable evidence object's pointer row.
-- ---------------------------------------------------------------------------
CREATE TABLE org_recommendations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  goal_id uuid NOT NULL,
  -- §11 "goal revision": the goal's current version at record time.
  goal_version integer NOT NULL CHECK (goal_version >= 1),
  fingerprint_id uuid NOT NULL,
  -- Optional W134 info-strategy link (opaque after write-time validation).
  strategy_id uuid,
  knowledge_objective text NOT NULL
    CHECK (char_length(knowledge_objective) >= 1 AND char_length(knowledge_objective) <= 2000),
  -- The evaluation configuration the recorded scores interpret forever.
  evaluation_config jsonb NOT NULL
    CHECK (jsonb_typeof(evaluation_config) = 'object'),
  -- The recommended candidate, or NULL ("no clear winner" is honest).
  recommended_candidate_id uuid,
  status text NOT NULL DEFAULT 'recorded'
    CHECK (status IN ('recorded', 'calibrated')),
  note text
    CHECK (note IS NULL OR char_length(note) >= 1),
  derived_from jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(derived_from) = 'array'),
  recorded_by text NOT NULL CHECK (char_length(recorded_by) >= 1),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  calibrated_at timestamptz,
  CHECK (
    (status = 'recorded' AND calibrated_at IS NULL)
    OR (status = 'calibrated' AND calibrated_at IS NOT NULL)
  )
);

CREATE INDEX org_recommendations_tenant_goal_idx ON org_recommendations (tenant_id, goal_id);
CREATE INDEX org_recommendations_tenant_fingerprint_idx ON org_recommendations (tenant_id, fingerprint_id);
CREATE INDEX org_recommendations_tenant_status_idx ON org_recommendations (tenant_id, status);
CREATE INDEX org_recommendations_tenant_recommended_idx
  ON org_recommendations (tenant_id, recommended_candidate_id);

-- ---------------------------------------------------------------------------
-- The evaluated candidates — ALL retained, recommended AND rejected.
-- ---------------------------------------------------------------------------
CREATE TABLE org_recommendation_candidates (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  recommendation_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('recommended', 'rejected')),
  -- Required (≥ 1 entry) iff rejected — the retained rejection evidence.
  rejection_reasons text[] NOT NULL DEFAULT '{}',
  -- The per-candidate evaluation record: summary, scores, evidence refs,
  -- agent-evaluation refs (the system-level evaluation, §4).
  evaluation jsonb NOT NULL
    CHECK (jsonb_typeof(evaluation) = 'object'),
  -- Deterministic order within the recommendation.
  position integer NOT NULL CHECK (position >= 1),
  UNIQUE (tenant_id, recommendation_id, candidate_id),
  UNIQUE (tenant_id, recommendation_id, position),
  -- Lifecycle discipline at storage level: only rejected rows carry
  -- reasons; recommended rows carry none.
  CHECK (
    (disposition = 'rejected' AND array_length(rejection_reasons, 1) >= 1)
    OR (disposition = 'recommended' AND array_length(rejection_reasons, 1) IS NULL)
  )
);

-- The calibration-aggregate join path (which candidates were recommended
-- in calibrated recommendations).
CREATE INDEX org_recommendation_candidates_tenant_candidate_idx
  ON org_recommendation_candidates (tenant_id, candidate_id);

-- ---------------------------------------------------------------------------
-- §11 "model occupancies" — the read-only snapshot through the W133
-- agent-body + W132 provider-fabric seams, taken at recommendation time.
-- ---------------------------------------------------------------------------
CREATE TABLE org_recommendation_occupancy (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  recommendation_id uuid NOT NULL,
  -- The composition node (of the RECOMMENDED candidate) the row describes.
  node_id text NOT NULL
    CHECK (char_length(node_id) >= 1 AND char_length(node_id) <= 64),
  role text NOT NULL
    CHECK (char_length(role) >= 1 AND char_length(role) <= 128),
  purpose text NOT NULL CHECK (purpose IN ('cognition', 'conversation', 'analysis', 'background')),
  body_id uuid NOT NULL,
  -- The active agent-body attachment's OPAQUE fabric binding id, VERBATIM
  -- (null = honestly unoccupied at snapshot time).
  body_binding_id text
    CHECK (body_binding_id IS NULL OR (char_length(body_binding_id) >= 1 AND char_length(body_binding_id) <= 256)),
  -- The fabric's current active binding id for the purpose, VERBATIM
  -- (null = the tenant has no active binding for the purpose).
  fabric_binding_id text
    CHECK (fabric_binding_id IS NULL OR (char_length(fabric_binding_id) >= 1 AND char_length(fabric_binding_id) <= 256)),
  UNIQUE (tenant_id, recommendation_id, node_id, purpose)
);

CREATE INDEX org_recommendation_occupancy_rec_idx
  ON org_recommendation_occupancy (tenant_id, recommendation_id);

-- ---------------------------------------------------------------------------
-- §11 "outcomes" — the expected-outcome records (the calibration seam).
-- The learning module's outcome definition is snapshotted at record time
-- so the recommendation commits to its expected value BEFORE realization
-- (the W054 prediction-hygiene discipline).
-- ---------------------------------------------------------------------------
CREATE TABLE org_recommendation_outcomes (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  recommendation_id uuid NOT NULL,
  -- The learning module (W040) outcome — opaque after write-time
  -- validation (readable + OPEN at record time).
  outcome_id uuid NOT NULL,
  metric_name text NOT NULL
    CHECK (char_length(metric_name) >= 1),
  metric_unit text NOT NULL
    CHECK (char_length(metric_unit) >= 1),
  direction text NOT NULL CHECK (direction IN ('at_least', 'at_most')),
  baseline double precision NOT NULL,
  expected double precision NOT NULL,
  UNIQUE (tenant_id, recommendation_id, outcome_id)
);

CREATE INDEX org_recommendation_outcomes_rec_idx
  ON org_recommendation_outcomes (tenant_id, recommendation_id);

-- ---------------------------------------------------------------------------
-- §11 "calibration" — ONE append-only record per recommendation, consuming
-- the learning module's frozen realizations.
-- ---------------------------------------------------------------------------
CREATE TABLE org_recommendation_calibrations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  recommendation_id uuid NOT NULL,
  polarity text NOT NULL CHECK (polarity IN ('positive', 'negative')),
  -- The frozen realized expected outcomes (learning's verdicts, verbatim).
  realized jsonb NOT NULL
    CHECK (jsonb_typeof(realized) = 'array'),
  note text
    CHECK (note IS NULL OR char_length(note) >= 1),
  calibrated_by text NOT NULL CHECK (char_length(calibrated_by) >= 1),
  calibrated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, recommendation_id)
);

-- ---------------------------------------------------------------------------
-- Append-only enforcement. The candidate-evaluation, occupancy, outcome
-- and calibration tables reject every UPDATE/DELETE/TRUNCATE outright
-- (law 2). The candidate registry and the recommendation pointer reject
-- DELETE/TRUNCATE and allow exactly their one-way lifecycle transitions.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION org_lab_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'org-lab evidence is append-only (W135): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER org_recommendation_candidates_immutable
  BEFORE UPDATE OR DELETE ON org_recommendation_candidates
  FOR EACH ROW EXECUTE FUNCTION org_lab_reject_mutation();

CREATE TRIGGER org_recommendation_candidates_immutable_truncate
  BEFORE TRUNCATE ON org_recommendation_candidates
  FOR EACH STATEMENT EXECUTE FUNCTION org_lab_reject_mutation();

CREATE TRIGGER org_recommendation_occupancy_immutable
  BEFORE UPDATE OR DELETE ON org_recommendation_occupancy
  FOR EACH ROW EXECUTE FUNCTION org_lab_reject_mutation();

CREATE TRIGGER org_recommendation_occupancy_immutable_truncate
  BEFORE TRUNCATE ON org_recommendation_occupancy
  FOR EACH STATEMENT EXECUTE FUNCTION org_lab_reject_mutation();

CREATE TRIGGER org_recommendation_outcomes_immutable
  BEFORE UPDATE OR DELETE ON org_recommendation_outcomes
  FOR EACH ROW EXECUTE FUNCTION org_lab_reject_mutation();

CREATE TRIGGER org_recommendation_outcomes_immutable_truncate
  BEFORE TRUNCATE ON org_recommendation_outcomes
  FOR EACH STATEMENT EXECUTE FUNCTION org_lab_reject_mutation();

CREATE TRIGGER org_recommendation_calibrations_immutable
  BEFORE UPDATE OR DELETE ON org_recommendation_calibrations
  FOR EACH ROW EXECUTE FUNCTION org_lab_reject_mutation();

CREATE TRIGGER org_recommendation_calibrations_immutable_truncate
  BEFORE TRUNCATE ON org_recommendation_calibrations
  FOR EACH STATEMENT EXECUTE FUNCTION org_lab_reject_mutation();

-- The candidate registry: content immutable, lifecycle one-way.

CREATE OR REPLACE FUNCTION org_candidate_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'org_candidates is lifecycle-managed (W135): % is forbidden — retire the candidate instead; its evaluations are retained evidence', TG_OP;
  END IF;

  -- Identity and content are immutable from registration.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.slug IS DISTINCT FROM OLD.slug
     OR NEW.label IS DISTINCT FROM OLD.label
     OR NEW.description IS DISTINCT FROM OLD.description
     OR NEW.composition IS DISTINCT FROM OLD.composition
     OR NEW.applicability IS DISTINCT FROM OLD.applicability
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'org_candidates content is immutable (W135): a changed design is a NEW candidate (new slug)';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'active' AND NEW.status = 'retired') THEN
    RAISE EXCEPTION 'org_candidates lifecycle is one-way (W135): active -> retired only';
  END IF;

  IF NEW.status = 'retired' AND (OLD.retired_at IS NOT NULL OR NEW.retired_at IS NULL) THEN
    RAISE EXCEPTION 'retire must stamp retired_at exactly once';
  END IF;

  IF NEW.lifecycle_note IS DISTINCT FROM OLD.lifecycle_note
     AND NOT (OLD.status = 'active' AND NEW.status = 'retired') THEN
    RAISE EXCEPTION 'org_candidates lifecycle_note may only be set by the retire transition';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER org_candidates_immutable
  BEFORE UPDATE OR DELETE ON org_candidates
  FOR EACH ROW EXECUTE FUNCTION org_candidate_guard();

CREATE TRIGGER org_candidates_immutable_truncate
  BEFORE TRUNCATE ON org_candidates
  FOR EACH STATEMENT EXECUTE FUNCTION org_candidate_guard();

-- The recommendation pointer: the ONLY legal UPDATE is the one-way
-- recorded → calibrated transition (stamp calibrated_at exactly once);
-- every identity/content column is immutable; DELETE/TRUNCATE forbidden.

CREATE OR REPLACE FUNCTION org_recommendation_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'org_recommendations is lifecycle-managed (W135): % is forbidden — historical recommendations are immutable evidence', TG_OP;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.goal_id IS DISTINCT FROM OLD.goal_id
     OR NEW.goal_version IS DISTINCT FROM OLD.goal_version
     OR NEW.fingerprint_id IS DISTINCT FROM OLD.fingerprint_id
     OR NEW.strategy_id IS DISTINCT FROM OLD.strategy_id
     OR NEW.knowledge_objective IS DISTINCT FROM OLD.knowledge_objective
     OR NEW.evaluation_config IS DISTINCT FROM OLD.evaluation_config
     OR NEW.recommended_candidate_id IS DISTINCT FROM OLD.recommended_candidate_id
     OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.derived_from IS DISTINCT FROM OLD.derived_from
     OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by
     OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
    RAISE EXCEPTION 'org_recommendations content is immutable (W135): only the recorded -> calibrated transition moves';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'recorded' AND NEW.status = 'calibrated') THEN
    RAISE EXCEPTION 'org_recommendations lifecycle is one-way (W135): recorded -> calibrated only';
  END IF;

  IF NEW.status = 'calibrated' AND (OLD.calibrated_at IS NOT NULL OR NEW.calibrated_at IS NULL) THEN
    RAISE EXCEPTION 'calibration must stamp calibrated_at exactly once';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER org_recommendations_immutable
  BEFORE UPDATE OR DELETE ON org_recommendations
  FOR EACH ROW EXECUTE FUNCTION org_recommendation_guard();

CREATE TRIGGER org_recommendations_immutable_truncate
  BEFORE TRUNCATE ON org_recommendations
  FOR EACH STATEMENT EXECUTE FUNCTION org_recommendation_guard();
