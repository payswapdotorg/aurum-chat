-- W054 · outcomes module — capability outcome learning (intervention
-- learning per ADR-0019).
--
-- The work item:
-- "Implement intervention outcome learning per ADR-0019: interventions
--  establish baseline/expected/observed/realized outcome; realized value and
--  variance are recorded; failed interventions are retained as negative
--  evidence; later similar recommendations use learned intervention priors;
--  no hidden outcome labels may leak into recommendations."
--
-- ADR-0019: "Every material intervention has: a baseline; an expected
-- outcome; an intervention record; an observed outcome; variance/realized
-- value; a learning update. Outcomes are linked to the originating goal,
-- recommendation, authorization and execution. Future recommendations may
-- improve only through explicit, evidence-linked learning updates."
--
-- Three tables, all FULLY append-only (the learning module W040's
-- discipline: definition row + terminal record + derived status; there is
-- no UPDATE anywhere — status is DERIVED, never stored on the definition):
--
--   interventions              — one immutable DEFINITION row: the material
--                                capability-change act (ARCHITECTURE.md
--                                §13's acquisition options — the eight
--                                intervention kinds) on one capability
--                                (label + deterministic normalized key,
--                                the similarity dimension), with the
--                                ADR-0019 originating links (goals,
--                                recommendation, authorization, execution
--                                — ALL opaque forward references: W018/
--                                W022/W023 own their records, this module
--                                creates no cross-module FKs), tied to
--                                exactly ONE measuring learning-module
--                                outcome (validated readable + open through
--                                the learning contract at write time — the
--                                sanctioned W040 → W054 dependency; the
--                                UNIQUE (tenant_id, outcome_id) makes the
--                                1:1 measuring tie unrepresentable any
--                                other way). The baseline/expected snapshot
--                                is copied from the outcome's immutable
--                                definition by the service — never
--                                caller-supplied.
--
--   intervention_realizations  — the TERMINAL record, first-write-wins via
--                                UNIQUE (tenant_id, intervention_id):
--                                 * 'realized' — the measuring outcome
--                                   settled; the service consumes the
--                                   learning module's FROZEN realization
--                                   (realized value, variance vs expected,
--                                   improvement vs baseline, assessment,
--                                   grounding measurement, settle time) and
--                                   derives the evidence polarity
--                                   (positive ⇔ met/exceeded, negative ⇔
--                                   missed — failed interventions are
--                                   RETAINED as negative evidence).
--                                 * 'abandoned' — a required reason; only
--                                   allowed while the outcome has NOT
--                                   settled (a settled outcome means the
--                                   evidence exists — abandoning then would
--                                   suppress it).
--                                A realization row existing at all IS the
--                                intervention's terminal status; its
--                                absence means 'active'.
--
--   intervention_priors        — the LEARNING UPDATE, append-only and
--                                versioned per (tenant, intervention kind,
--                                capability key): the deterministic
--                                aggregate over every REALIZED
--                                intervention of the key (sample size,
--                                successes, failures, success rate,
--                                expected/realized sums, net and mean
--                                variance), the triggering intervention and
--                                the full evidence intervention-id list.
--                                Written ONLY by realizeIntervention — this
--                                table is the ONE channel from intervention
--                                outcomes to future recommendations
--                                (ADR-0019); its rows carry aggregates and
--                                evidence REFERENCES, never per-
--                                intervention outcome labels.
--
-- There is deliberately NO operation to redefine an intervention, rewrite
-- a realization, un-realize, un-abandon or delete anything, and NO
-- operation that writes priors outside a realization: predictions that
-- could be edited after realization are worthless for calibration, failed
-- evidence must stay retained, and the learning update path must stay the
-- only outcome→behavior channel. PostgreSQL itself rejects
-- UPDATE/DELETE/TRUNCATE on all three tables (triggers below), even for a
-- caller bypassing the service.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the composite
-- FKs (intervention_id, tenant_id) → interventions (id, tenant_id) make
-- cross-tenant rows unrepresentable in SQL (the learning module's
-- outcomes/outcome_realizations pattern). The measuring outcome link is
-- deliberately NOT a foreign key — it crosses a module boundary and is
-- validated through the learning contract at write time instead.

CREATE TABLE interventions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  intervention_kind text NOT NULL
    CHECK (intervention_kind IN (
      'train_employee', 'reassign_work', 'hire_human', 'recruit_agent',
      'recruit_agent_team', 'install_extension', 'build_extension', 'outsource'
    )),
  capability_key text NOT NULL
    CHECK (char_length(capability_key) BETWEEN 1 AND 120),
  capability_label text NOT NULL
    CHECK (char_length(capability_label) BETWEEN 1 AND 200),
  target jsonb,
  origin_goal_ids jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(origin_goal_ids) = 'array'),
  origin_recommendation_id text
    CHECK (origin_recommendation_id IS NULL
      OR origin_recommendation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  authorization_ref jsonb,
  origin_execution_id text
    CHECK (origin_execution_id IS NULL
      OR origin_execution_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  outcome_id uuid NOT NULL,
  metric_name text NOT NULL CHECK (char_length(metric_name) BETWEEN 1 AND 200),
  metric_unit text NOT NULL CHECK (char_length(metric_unit) BETWEEN 1 AND 100),
  direction text NOT NULL CHECK (direction IN ('at_least', 'at_most')),
  baseline double precision NOT NULL
    CHECK (baseline >= -9007199254740991 AND baseline <= 9007199254740991),
  expected double precision NOT NULL
    CHECK (expected >= -9007199254740991 AND expected <= 9007199254740991),
  actor_kind text NOT NULL CHECK (actor_kind IN ('person', 'team', 'agent', 'system', 'external')),
  actor_id text,
  actor_label text,
  recorded_by_principal text NOT NULL,
  rationale text
    CHECK (rationale IS NULL OR char_length(rationale) BETWEEN 1 AND 2000),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  -- The acting party is traceable (the missions actor rule).
  CONSTRAINT interventions_actor_traceable CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL),
  -- ADR-0019: interventions are linked to their origin — at least one
  -- originating link or a precise target must be present.
  CONSTRAINT interventions_origin_linked CHECK (
    jsonb_array_length(origin_goal_ids) > 0
    OR origin_recommendation_id IS NOT NULL
    OR authorization_ref IS NOT NULL
    OR origin_execution_id IS NOT NULL
    OR target IS NOT NULL
  ),
  -- One measuring outcome per intervention, one intervention per outcome:
  -- the 1:1 attribution tie (an outcome measures ONE intervention's effect).
  CONSTRAINT interventions_outcome_unique UNIQUE (tenant_id, outcome_id),
  -- The composite target of the tenant-scoped FK below.
  CONSTRAINT interventions_id_tenant_unique UNIQUE (id, tenant_id)
);

-- The similarity lookups (priors group by kind + key) and the management
-- list filters.
CREATE INDEX interventions_capability_idx
  ON interventions (tenant_id, intervention_kind, capability_key);
CREATE INDEX interventions_outcome_idx ON interventions (tenant_id, outcome_id);
CREATE INDEX interventions_recorded_idx ON interventions (tenant_id, recorded_at);

CREATE TABLE intervention_realizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  intervention_id uuid NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('realized', 'abandoned')),
  realized_value double precision
    CHECK (realized_value IS NULL
      OR (realized_value >= -9007199254740991 AND realized_value <= 9007199254740991)),
  variance_vs_expected double precision
    CHECK (variance_vs_expected IS NULL
      OR (variance_vs_expected >= -9007199254740991 AND variance_vs_expected <= 9007199254740991)),
  improvement_vs_baseline double precision
    CHECK (improvement_vs_baseline IS NULL
      OR (improvement_vs_baseline >= -9007199254740991 AND improvement_vs_baseline <= 9007199254740991)),
  assessment text CHECK (assessment IN ('met', 'exceeded', 'missed')),
  polarity text CHECK (polarity IN ('positive', 'negative')),
  realized_from_measurement_id uuid,
  outcome_settled_at timestamptz,
  note text
    CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
  reason text
    CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 2000),
  actor_kind text NOT NULL CHECK (actor_kind IN ('person', 'team', 'agent', 'system', 'external')),
  actor_id text,
  actor_label text,
  realized_by_principal text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  -- First terminal record wins: one realization per intervention.
  CONSTRAINT intervention_realizations_intervention_unique UNIQUE (tenant_id, intervention_id),
  CONSTRAINT intervention_realizations_intervention_fk
    FOREIGN KEY (intervention_id, tenant_id) REFERENCES interventions (id, tenant_id),
  CONSTRAINT intervention_realizations_actor_traceable
    CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL),
  -- The disposition shapes are surgical: a realization carries the full
  -- frozen expected-versus-realized record (consumed from the learning
  -- module's frozen outcome realization) and no reason; an abandonment
  -- carries a required reason and none of the realized fields.
  CONSTRAINT intervention_realizations_realized_shape CHECK (
    (disposition = 'realized'
       AND realized_value IS NOT NULL AND variance_vs_expected IS NOT NULL
       AND improvement_vs_baseline IS NOT NULL AND assessment IS NOT NULL
       AND polarity IS NOT NULL AND realized_from_measurement_id IS NOT NULL
       AND outcome_settled_at IS NOT NULL AND reason IS NULL)
    OR (disposition = 'abandoned'
       AND realized_value IS NULL AND variance_vs_expected IS NULL
       AND improvement_vs_baseline IS NULL AND assessment IS NULL
       AND polarity IS NULL AND realized_from_measurement_id IS NULL
       AND outcome_settled_at IS NULL AND reason IS NOT NULL)
  ),
  -- The evidence polarity is the assessment's shadow: met/exceeded are
  -- positive evidence, missed is the retained negative evidence.
  CONSTRAINT intervention_realizations_polarity_consistent CHECK (
    disposition = 'abandoned'
    OR (assessment IN ('met', 'exceeded') AND polarity = 'positive')
    OR (assessment = 'missed' AND polarity = 'negative')
  )
);

-- The negative-evidence listing (failed interventions stay queryable).
CREATE INDEX intervention_realizations_disposition_idx
  ON intervention_realizations (tenant_id, disposition, polarity);
-- The prior sample scan joins realizations back to interventions.
CREATE INDEX intervention_realizations_recorded_idx
  ON intervention_realizations (tenant_id, recorded_at);

CREATE TABLE intervention_priors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  intervention_kind text NOT NULL
    CHECK (intervention_kind IN (
      'train_employee', 'reassign_work', 'hire_human', 'recruit_agent',
      'recruit_agent_team', 'install_extension', 'build_extension', 'outsource'
    )),
  capability_key text NOT NULL
    CHECK (char_length(capability_key) BETWEEN 1 AND 120),
  prior_version integer NOT NULL CHECK (prior_version >= 1),
  sample_size integer NOT NULL CHECK (sample_size >= 1),
  successes integer NOT NULL CHECK (successes >= 0),
  failures integer NOT NULL CHECK (failures >= 0),
  success_rate double precision NOT NULL
    CHECK (success_rate >= 0 AND success_rate <= 1),
  expected_sum double precision NOT NULL
    CHECK (expected_sum >= -9e18 AND expected_sum <= 9e18),
  realized_sum double precision NOT NULL
    CHECK (realized_sum >= -9e18 AND realized_sum <= 9e18),
  net_variance double precision NOT NULL
    CHECK (net_variance >= -9e18 AND net_variance <= 9e18),
  mean_variance double precision NOT NULL
    CHECK (mean_variance >= -9e18 AND mean_variance <= 9e18),
  triggered_by_intervention_id uuid NOT NULL,
  evidence_intervention_ids jsonb NOT NULL
    CHECK (jsonb_typeof(evidence_intervention_ids) = 'array'
      AND jsonb_array_length(evidence_intervention_ids) >= 1),
  actor_kind text NOT NULL CHECK (actor_kind IN ('person', 'team', 'agent', 'system', 'external')),
  actor_id text,
  actor_label text,
  updated_by_principal text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  -- The acting party is traceable (the missions actor rule).
  CONSTRAINT intervention_priors_actor_traceable
    CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL),
  -- The sample is consistent: every intervention counted, the polarity
  -- split complete (the rate itself is the service's pure function's
  -- output — computePriorUpdate — and stays within [0, 1] above).
  CONSTRAINT intervention_priors_sample_consistent CHECK (
    successes + failures = sample_size
  ),
  -- One version number per (tenant, kind, key): the append-only history.
  CONSTRAINT intervention_priors_version_unique
    UNIQUE (tenant_id, intervention_kind, capability_key, prior_version)
);

-- The recommendation-facing current-prior read (DISTINCT ON kind + key,
-- highest version) and the version-history scan.
CREATE INDEX intervention_priors_current_idx
  ON intervention_priors (tenant_id, intervention_kind, capability_key, prior_version DESC);
CREATE INDEX intervention_priors_recorded_idx ON intervention_priors (tenant_id, recorded_at);

-- Storage-level audit guarantee: intervention definitions, realizations
-- and priors are append-only. Nothing may UPDATE, DELETE or TRUNCATE any
-- of them — not even a future module bypassing the service. The message
-- deliberately names no row id so the same function serves the row-level
-- and the statement-level triggers.

CREATE OR REPLACE FUNCTION interventions_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'intervention records are append-only (W054 capability outcome learning): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER interventions_immutable
  BEFORE UPDATE OR DELETE ON interventions
  FOR EACH ROW EXECUTE FUNCTION interventions_reject_mutation();

CREATE TRIGGER interventions_immutable_truncate
  BEFORE TRUNCATE ON interventions
  FOR EACH STATEMENT EXECUTE FUNCTION interventions_reject_mutation();

CREATE OR REPLACE FUNCTION intervention_realizations_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'intervention realizations are append-only (W054 terminal outcome records): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER intervention_realizations_immutable
  BEFORE UPDATE OR DELETE ON intervention_realizations
  FOR EACH ROW EXECUTE FUNCTION intervention_realizations_reject_mutation();

CREATE TRIGGER intervention_realizations_immutable_truncate
  BEFORE TRUNCATE ON intervention_realizations
  FOR EACH STATEMENT EXECUTE FUNCTION intervention_realizations_reject_mutation();

CREATE OR REPLACE FUNCTION intervention_priors_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'intervention priors are append-only (W054 learning updates): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER intervention_priors_immutable
  BEFORE UPDATE OR DELETE ON intervention_priors
  FOR EACH ROW EXECUTE FUNCTION intervention_priors_reject_mutation();

CREATE TRIGGER intervention_priors_immutable_truncate
  BEFORE TRUNCATE ON intervention_priors
  FOR EACH STATEMENT EXECUTE FUNCTION intervention_priors_reject_mutation();
