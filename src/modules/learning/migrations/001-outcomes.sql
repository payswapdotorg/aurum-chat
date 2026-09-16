-- W040 · learning module — outcome measurement.
--
-- ARCHITECTURE.md §26 (frozen): the learning layer's modules are `learning`
-- and `rewards`; the DAG (WORK-ITEM-DEPENDENCY-GRAPH.md) places W040 as the
-- first item of the LEARNING/REWARDS track (W012 + W013 → W040 → W041,
-- W012 + W040 → W042 → W043). The work item:
-- "Tie recommendations, agents, extensions and missions to measurable
--  outcomes and expected-versus-realized value."
--
-- ADR-0019 (Capability Outcome Learning — the addendum W040 builds the
-- measurement foundation for, W054 completes): "Every material intervention
-- has: a baseline; an expected outcome; an intervention record; an observed
-- outcome; variance/realized value; a learning update. Outcomes are linked to
-- the originating goal, recommendation, authorization and execution."
--
-- Three tables, all FULLY append-only (the knowledge-acquisition W012
-- discipline: definition row + terminal outcome row, plus an observation
-- series; there is no UPDATE anywhere — status is DERIVED, never stored on
-- the definition):
--
--   outcomes              — one immutable DEFINITION row: the measurable
--                           outcome one subject (a recommendation, an agent,
--                           an extension or a mission — opaque uuid forward
--                           references, no cross-module FKs) is tied to:
--                           metric name + unit, direction (at_least/at_most),
--                           baseline (the "before"), expected value (the
--                           committed prediction — frozen at definition time,
--                           which is what keeps expected-versus-realized
--                           honest and W055's calibration measurable),
--                           optional horizon (ISO date), affected goals
--                           (opaque forward references, the missions module's
--                           affected-goals precedent) and the optional
--                           originating cognitive execution (validated
--                           readable through the cognition contract at write
--                           time — the sanctioned W013 → W040 dependency;
--                           ADR-0019's "originating execution" link).
--
--   outcome_measurements  — the append-only OBSERVATION series: observed
--                           metric values over time with provenance (actor
--                           party + authenticated principal + clock-stamped
--                           recorded_at) and optional opaque evidence
--                           references. Measurements are observation-derived
--                           evidence: UPDATE/DELETE/TRUNCATE are rejected by
--                           trigger.
--
--   outcome_realizations  — the TERMINAL record, first-write-wins via
--                           UNIQUE (tenant_id, outcome_id):
--                            * 'settled'   — the realized value IS a recorded
--                              measurement's value (realized_from_measurement_id,
--                              composite-FK'd to the same tenant AND the same
--                              outcome, so realization is always evidence-
--                              grounded, never free-floating); the service
--                              freezes variance-vs-expected,
--                              improvement-vs-baseline and the deterministic
--                              assessment (met/exceeded/missed) at settle
--                              time — the frozen expected-versus-realized
--                              record W054/W055 build on.
--                            * 'abandoned' — a required reason (terminal
--                              transitions record their why).
--                           A realization row existing at all IS the
--                           outcome's terminal status; its absence means
--                           'open'. Both dispositions are dead ends.
--
-- There is deliberately NO operation to redefine an outcome, rewrite a
-- measurement, un-settle or un-abandon: predictions that could be edited
-- after realization are worthless for calibration, and measured history is
-- evidence. PostgreSQL itself rejects UPDATE/DELETE/TRUNCATE on all three
-- tables (triggers below), even for a caller bypassing the service.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the composite FKs
-- (outcome_id, tenant_id) → outcomes (id, tenant_id) and
-- (realized_from_measurement_id, tenant_id, outcome_id) →
-- outcome_measurements (id, tenant_id, outcome_id) make cross-tenant rows
-- unrepresentable in SQL (the mission_versions / acquisition_outcomes
-- pattern).

CREATE TABLE outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  subject_kind text NOT NULL
    CHECK (subject_kind IN ('recommendation', 'agent', 'extension', 'mission')),
  subject_id text NOT NULL
    CHECK (subject_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  subject_label text
    CHECK (subject_label IS NULL OR char_length(subject_label) BETWEEN 1 AND 200),
  metric_name text NOT NULL CHECK (char_length(metric_name) BETWEEN 1 AND 200),
  metric_unit text NOT NULL CHECK (char_length(metric_unit) BETWEEN 1 AND 100),
  direction text NOT NULL CHECK (direction IN ('at_least', 'at_most')),
  baseline double precision NOT NULL
    CHECK (baseline >= -9007199254740991 AND baseline <= 9007199254740991),
  expected double precision NOT NULL
    CHECK (expected >= -9007199254740991 AND expected <= 9007199254740991),
  horizon text
    CHECK (horizon IS NULL OR horizon ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  affected_goals jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(affected_goals) = 'array'),
  origin_execution_id text
    CHECK (origin_execution_id IS NULL
      OR origin_execution_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  actor_kind text NOT NULL CHECK (actor_kind IN ('person', 'team', 'agent', 'system', 'external')),
  actor_id text,
  actor_label text,
  defined_by_principal text NOT NULL,
  rationale text
    CHECK (rationale IS NULL OR char_length(rationale) BETWEEN 1 AND 2000),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  -- The acting party is traceable (the missions actor rule).
  CONSTRAINT outcomes_actor_traceable CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL),
  -- The composite target of the tenant-scoped FKs below.
  CONSTRAINT outcomes_id_tenant_unique UNIQUE (id, tenant_id)
);

-- Subject lookups (the "tie" queries) and the management list filters.
CREATE INDEX outcomes_subject_idx ON outcomes (tenant_id, subject_kind, subject_id);
CREATE INDEX outcomes_recorded_idx ON outcomes (tenant_id, recorded_at);
CREATE INDEX outcomes_affected_goals_idx
  ON outcomes USING gin (affected_goals jsonb_path_ops);
CREATE INDEX outcomes_origin_execution_idx ON outcomes (tenant_id, origin_execution_id);

CREATE TABLE outcome_measurements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  outcome_id uuid NOT NULL,
  value double precision NOT NULL
    CHECK (value >= -9007199254740991 AND value <= 9007199254740991),
  note text
    CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence) = 'array'),
  actor_kind text NOT NULL CHECK (actor_kind IN ('person', 'team', 'agent', 'system', 'external')),
  actor_id text,
  actor_label text,
  recorded_by_principal text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outcome_measurements_actor_traceable CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL),
  -- Same-tenant measurement of this outcome only.
  CONSTRAINT outcome_measurements_outcome_fk
    FOREIGN KEY (outcome_id, tenant_id) REFERENCES outcomes (id, tenant_id),
  -- The composite target of outcome_realizations' evidence-grounding FK
  -- (id is the PK, so this superkey constraint costs nothing).
  CONSTRAINT outcome_measurements_id_tenant_outcome_unique
    UNIQUE (id, tenant_id, outcome_id)
);

-- The observation series, ascending in record order.
CREATE INDEX outcome_measurements_outcome_idx
  ON outcome_measurements (tenant_id, outcome_id, recorded_at);

CREATE TABLE outcome_realizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  outcome_id uuid NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('settled', 'abandoned')),
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
  realized_from_measurement_id uuid,
  note text
    CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
  reason text
    CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 2000),
  actor_kind text NOT NULL CHECK (actor_kind IN ('person', 'team', 'agent', 'system', 'external')),
  actor_id text,
  actor_label text,
  realized_by_principal text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  -- First terminal record wins: one realization per outcome.
  CONSTRAINT outcome_realizations_outcome_unique UNIQUE (tenant_id, outcome_id),
  CONSTRAINT outcome_realizations_outcome_fk
    FOREIGN KEY (outcome_id, tenant_id) REFERENCES outcomes (id, tenant_id),
  -- A settlement is grounded in a measurement OF THE SAME OUTCOME in THE
  -- SAME TENANT — realization is never free-floating.
  CONSTRAINT outcome_realizations_measurement_fk
    FOREIGN KEY (realized_from_measurement_id, tenant_id, outcome_id)
    REFERENCES outcome_measurements (id, tenant_id, outcome_id),
  CONSTRAINT outcome_realizations_actor_traceable
    CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL),
  -- The disposition shapes are surgical: a settlement carries the full
  -- frozen expected-versus-realized record and no reason; an abandonment
  -- carries a required reason and none of the realized fields.
  CONSTRAINT outcome_realizations_settled_shape CHECK (
    (disposition = 'settled'
       AND realized_value IS NOT NULL AND variance_vs_expected IS NOT NULL
       AND improvement_vs_baseline IS NOT NULL AND assessment IS NOT NULL
       AND realized_from_measurement_id IS NOT NULL AND reason IS NULL)
    OR (disposition = 'abandoned'
       AND realized_value IS NULL AND variance_vs_expected IS NULL
       AND improvement_vs_baseline IS NULL AND assessment IS NULL
       AND realized_from_measurement_id IS NULL AND reason IS NOT NULL)
  )
);

CREATE INDEX outcome_realizations_outcome_idx ON outcome_realizations (tenant_id, outcome_id);
-- The summary rollup scans settled realizations per subject kind.
CREATE INDEX outcome_realizations_disposition_idx
  ON outcome_realizations (tenant_id, disposition, assessment);

-- Storage-level audit guarantee: outcome definitions, measurements and
-- realizations are append-only. Nothing may UPDATE, DELETE or TRUNCATE any
-- of them — not even a future module bypassing the service. The message
-- deliberately names no row id so the same function serves the row-level
-- and the statement-level triggers.

CREATE OR REPLACE FUNCTION outcomes_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'learning outcome records are append-only (W040 outcome measurement): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outcomes_immutable
  BEFORE UPDATE OR DELETE ON outcomes
  FOR EACH ROW EXECUTE FUNCTION outcomes_reject_mutation();

CREATE TRIGGER outcomes_immutable_truncate
  BEFORE TRUNCATE ON outcomes
  FOR EACH STATEMENT EXECUTE FUNCTION outcomes_reject_mutation();

CREATE OR REPLACE FUNCTION outcome_measurements_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'outcome measurements are append-only (W040 observed-outcome evidence): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outcome_measurements_immutable
  BEFORE UPDATE OR DELETE ON outcome_measurements
  FOR EACH ROW EXECUTE FUNCTION outcome_measurements_reject_mutation();

CREATE TRIGGER outcome_measurements_immutable_truncate
  BEFORE TRUNCATE ON outcome_measurements
  FOR EACH STATEMENT EXECUTE FUNCTION outcome_measurements_reject_mutation();

CREATE OR REPLACE FUNCTION outcome_realizations_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'outcome realizations are append-only (W040 terminal outcome records): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outcome_realizations_immutable
  BEFORE UPDATE OR DELETE ON outcome_realizations
  FOR EACH ROW EXECUTE FUNCTION outcome_realizations_reject_mutation();

CREATE TRIGGER outcome_realizations_immutable_truncate
  BEFORE TRUNCATE ON outcome_realizations
  FOR EACH STATEMENT EXECUTE FUNCTION outcome_realizations_reject_mutation();
