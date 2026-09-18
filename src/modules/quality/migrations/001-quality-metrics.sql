-- W055 · quality module — Aurum Quality Measurement.
--
-- The work item (spec/work-items/WORK-ITEM-CATALOG.md, W055):
-- "Implement quality metrics: unknown-discovery precision/recall,
--  source-selection quality, mission resolution efficiency, evidence
--  quality, recommendation calibration, intervention success, realized
--  value, investigation cost and time-to-useful-understanding. Metrics are
--  tenant-aware, versioned and auditable and do not become business truth."
--
-- LONGITUDINAL-BENCHMARK.md is normative for W055/W056; the nine metric
-- families implement its measurements (consequential unknown discovery
-- precision/recall; first-choice source quality and employee routing
-- accuracy; mission completion time and cost; recommendation calibration;
-- intervention realized value versus expected value; and the work item's
-- remaining families).
--
-- Three tables, all append-only (the knowledge-acquisition/learning
-- discipline — measurement records are evidence of what was judged and
-- computed; there is no UPDATE anywhere):
--
--   quality_judgments  — ground-truth labels: whether a discovered gap was
--                        a consequential unknown ('unknown-
--                        consequentiality' — the labeled truth
--                        precision/recall is computed against), or whether
--                        the source one recorded plan chose was the right
--                        one ('source-selection'). Corrections are NEW
--                        judgment rows — computation resolves the latest
--                        per target deterministically, so the audit trail
--                        is never rewritten.
--
--   quality_snapshots  — ONE explicit computation pass over a bounded
--                        evaluation window: the window, the requested
--                        metric families, the metric definition version
--                        (metrics are versioned), the full input audit
--                        (considered counts + truncated-source flags —
--                        honest bounds), the optional originating
--                        cognitive execution (validated readable through
--                        the cognition contract at write time; the
--                        sanctioned W013 dependency), actor provenance.
--
--   quality_metric_results — one row per computed metric family of one
--                        snapshot: the kind + the payload (jsonb; the
--                        versioned pure functions in metrics.ts define the
--                        shapes). UNIQUE per (tenant, snapshot, kind).
--
-- There is deliberately NO operation to update or erase a judgment, a
-- snapshot or a result: judgments and snapshots are append-only audit
-- evidence, and PostgreSQL itself rejects UPDATE/DELETE/TRUNCATE on all
-- three tables (triggers below), even for a caller bypassing the service.
-- Quality metrics are derived intelligence, never business truth — the
-- module exposes reads for reporting/verification only, and nothing here
-- can mutate another module's state.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the composite
-- FK (snapshot_id, tenant_id) → quality_snapshots (id, tenant_id) makes
-- cross-tenant result rows unrepresentable in SQL (the outcome_
-- measurements pattern).

CREATE TABLE quality_judgments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  judgment_kind text NOT NULL
    CHECK (judgment_kind IN ('unknown-consequentiality', 'source-selection')),
  gap_key text
    CHECK (gap_key IS NULL OR char_length(gap_key) BETWEEN 1 AND 200),
  candidate_id text
    CHECK (candidate_id IS NULL
      OR candidate_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  plan_id text
    CHECK (plan_id IS NULL
      OR plan_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  window_from timestamptz,
  window_to timestamptz,
  verdict text NOT NULL
    CHECK (verdict IN ('consequential', 'not_consequential', 'correct', 'incorrect')),
  evaluator_kind text NOT NULL
    CHECK (evaluator_kind IN ('person', 'team', 'agent', 'system', 'external')),
  evaluator_id text,
  evaluator_label text
    CHECK (evaluator_label IS NULL OR char_length(evaluator_label) BETWEEN 1 AND 200),
  note text
    CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
  recorded_by_principal text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  -- The acting party is traceable (the missions actor rule).
  CONSTRAINT quality_judgments_evaluator_traceable
    CHECK (evaluator_id IS NOT NULL OR evaluator_label IS NOT NULL),
  -- The kind shapes are surgical: an unknown-consequentiality judgment
  -- names a gap (optionally one candidate and a consequentiality window)
  -- and carries a gap verdict; a source-selection judgment names exactly
  -- one plan and carries a selection verdict.
  CONSTRAINT quality_judgments_kind_shape CHECK (
    (judgment_kind = 'unknown-consequentiality'
       AND gap_key IS NOT NULL AND plan_id IS NULL
       AND verdict IN ('consequential', 'not_consequential')
       AND (window_from IS NULL OR window_to IS NULL OR window_from <= window_to))
    OR (judgment_kind = 'source-selection'
       AND plan_id IS NOT NULL AND gap_key IS NULL AND candidate_id IS NULL
       AND window_from IS NULL AND window_to IS NULL
       AND verdict IN ('correct', 'incorrect'))
  )
);

-- The computation's latest-per-target lookups and the audit feed.
CREATE INDEX quality_judgments_gap_idx ON quality_judgments (tenant_id, gap_key, recorded_at);
CREATE INDEX quality_judgments_candidate_idx ON quality_judgments (tenant_id, candidate_id, recorded_at);
CREATE INDEX quality_judgments_plan_idx ON quality_judgments (tenant_id, plan_id, recorded_at);
CREATE INDEX quality_judgments_kind_idx ON quality_judgments (tenant_id, judgment_kind, recorded_at);

CREATE TABLE quality_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  window_from timestamptz NOT NULL,
  window_to timestamptz NOT NULL,
  metric_kinds jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(metric_kinds) = 'array'),
  metric_version integer NOT NULL CHECK (metric_version >= 1),
  inputs jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(inputs) = 'object'),
  origin_execution_id text
    CHECK (origin_execution_id IS NULL
      OR origin_execution_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  actor_kind text NOT NULL
    CHECK (actor_kind IN ('person', 'team', 'agent', 'system', 'external')),
  actor_id text,
  actor_label text
    CHECK (actor_label IS NULL OR char_length(actor_label) BETWEEN 1 AND 200),
  computed_by_principal text NOT NULL,
  rationale text
    CHECK (rationale IS NULL OR char_length(rationale) BETWEEN 1 AND 2000),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quality_snapshots_window CHECK (window_from < window_to),
  CONSTRAINT quality_snapshots_actor_traceable CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL),
  -- The composite target of the tenant-scoped FK below.
  CONSTRAINT quality_snapshots_id_tenant_unique UNIQUE (id, tenant_id)
);

-- The audit feed and the metric-kind containment filter.
CREATE INDEX quality_snapshots_recorded_idx ON quality_snapshots (tenant_id, recorded_at);
CREATE INDEX quality_snapshots_metric_kinds_idx
  ON quality_snapshots USING gin (metric_kinds jsonb_path_ops);

CREATE TABLE quality_metric_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  metric_kind text NOT NULL CHECK (
    metric_kind IN (
      'unknown-discovery',
      'source-selection',
      'mission-resolution-efficiency',
      'evidence-quality',
      'recommendation-calibration',
      'intervention-success',
      'realized-value',
      'investigation-cost',
      'time-to-useful-understanding'
    )
  ),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  -- Same-tenant result of this snapshot only.
  CONSTRAINT quality_metric_results_snapshot_fk
    FOREIGN KEY (snapshot_id, tenant_id) REFERENCES quality_snapshots (id, tenant_id),
  -- One result row per metric family per snapshot.
  CONSTRAINT quality_metric_results_unique UNIQUE (tenant_id, snapshot_id, metric_kind)
);

CREATE INDEX quality_metric_results_snapshot_idx
  ON quality_metric_results (tenant_id, snapshot_id);

-- Storage-level audit guarantee: judgments, snapshots and metric results
-- are append-only. Nothing may UPDATE, DELETE or TRUNCATE any of them —
-- not even a future module bypassing the service. The message deliberately
-- names no row id so the same function serves the row-level and the
-- statement-level triggers.

CREATE OR REPLACE FUNCTION quality_judgments_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'quality judgments are append-only (W055 ground-truth evaluation evidence): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER quality_judgments_immutable
  BEFORE UPDATE OR DELETE ON quality_judgments
  FOR EACH ROW EXECUTE FUNCTION quality_judgments_reject_mutation();

CREATE TRIGGER quality_judgments_immutable_truncate
  BEFORE TRUNCATE ON quality_judgments
  FOR EACH STATEMENT EXECUTE FUNCTION quality_judgments_reject_mutation();

CREATE OR REPLACE FUNCTION quality_snapshots_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'quality snapshots are append-only (W055 recorded computations): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER quality_snapshots_immutable
  BEFORE UPDATE OR DELETE ON quality_snapshots
  FOR EACH ROW EXECUTE FUNCTION quality_snapshots_reject_mutation();

CREATE TRIGGER quality_snapshots_immutable_truncate
  BEFORE TRUNCATE ON quality_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION quality_snapshots_reject_mutation();

CREATE OR REPLACE FUNCTION quality_metric_results_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'quality metric results are append-only (W055 computed metrics): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER quality_metric_results_immutable
  BEFORE UPDATE OR DELETE ON quality_metric_results
  FOR EACH ROW EXECUTE FUNCTION quality_metric_results_reject_mutation();

CREATE TRIGGER quality_metric_results_immutable_truncate
  BEFORE TRUNCATE ON quality_metric_results
  FOR EACH STATEMENT EXECUTE FUNCTION quality_metric_results_reject_mutation();
