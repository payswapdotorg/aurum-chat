-- W019 · workforce module — workforce intelligence.
--
-- The work item: "Assess workload, role/capability fit, performance
-- signals and staffing needs while preserving alternative explanations and
-- human decision authority."
--
-- ARCHITECTURE.md §14 (frozen) fixes the discipline this schema carries:
-- "Workforce intelligence assesses role expectations, capabilities,
--  workload, process context, outcomes and alternatives. It must separate
--  observed behavior from interpretation. Employment-impacting results
--  follow `evidence → assessment → alternative explanations →
--  alternatives → recommendation → authorized human decision`.
--  Aurum never autonomously terminates a human employee."
--
-- Tables, in the §14 chain's order:
--
--   role_expectations / role_expectation_versions
--        The EXPECTATION side: a named role's required capabilities
--        (opaque forward references to the capabilities module, W017) and
--        expected weekly hours. Identity-plus-append-only-versions in the
--        goals (W008) / capabilities (W017) discipline.
--   role_assignments / role_assignment_versions
--        Who holds which role at which allocation fraction. The employee
--        is an opaque people-module (W002) reference — immutable identity
--        content of the assignment.
--   workforce_signals
--        OBSERVED BEHAVIOR: immutable measurements (workload hours per
--        week / performance score), with provenance and optional evidence
--        observation references. No version chain, no update operation —
--        a measurement is a fact; corrections are new signals.
--        UPDATE/DELETE/TRUNCATE are rejected by trigger.
--   workforce_assessments / workforce_assessment_versions
--        The INTERPRETATION: one identity per (tenant, employee), each
--        version a self-contained snapshot of the deterministic assessment
--        (workload/fit/performance/staffing + scope honesty + alternative
--        explanations + alternatives + recommendation + confidence +
--        evidence citations + the options it was computed under). The
--        lock-20 employment guards and the adverse-grounding guard are
--        enforced here as CHECK constraints — defense in depth behind the
--        service validation.
--   workforce_decisions
--        The AUTHORIZED HUMAN DECISION: append-only, exactly one per
--        assessment version (UNIQUE), decider is always a person with a
--        required id. There is deliberately no table and no operation that
--        changes employment — lock 21 is structural.
--
-- Graph keys (tenant-unique, immutable):
--   role_expectations  (tenant_id, role_key)
--   role_assignments   (tenant_id, role_id, employee_key)
--   workforce_assessments (tenant_id, employee_key)
-- employee_key is the service-computed storage key of the employee
-- reference (its id) — the employee itself is immutable identity content,
-- snapshotted on every version for self-containment.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the composite
-- UNIQUE (id, tenant_id) on each identity is the tenant-consistent target
-- for the version/decision foreign keys, and the composite FKs make a
-- cross-tenant or dangling version/decision unrepresentable in SQL.

-- ---------------------------------------------------------------------------
-- Role expectations
-- ---------------------------------------------------------------------------

CREATE TABLE role_expectations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  role_key text NOT NULL CHECK (char_length(role_key) BETWEEN 1 AND 200),
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_expectations_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT role_expectations_tenant_role_key_unique UNIQUE (tenant_id, role_key)
);

CREATE INDEX role_expectations_tenant_idx ON role_expectations (tenant_id);

CREATE TABLE role_expectation_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  role_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  change_kind text NOT NULL
    CHECK (change_kind IN ('created', 'revised', 'retired', 'reactivated')),
  -- always the identity's immutable role key (snapshotted for self-containment)
  role_key text NOT NULL CHECK (char_length(role_key) BETWEEN 1 AND 200),
  title text CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 200),
  description text
    CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 2000),
  required_capabilities jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(required_capabilities) = 'array'
           AND jsonb_array_length(required_capabilities) <= 32),
  expected_weekly_hours double precision NOT NULL
    CHECK (expected_weekly_hours > 0 AND expected_weekly_hours <= 168),
  status text NOT NULL CHECK (status IN ('active', 'retired')),
  -- audit quartet: who / when / what / why
  actor_kind text NOT NULL
    CHECK (actor_kind IN ('person', 'team', 'agent', 'system', 'external')),
  actor_id text,
  actor_label text,
  changed_by_principal text NOT NULL,
  rationale text
    CHECK (rationale IS NULL OR char_length(rationale) BETWEEN 1 AND 2000),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_expectation_versions_version_unique UNIQUE (tenant_id, role_id, version),
  CONSTRAINT role_expectation_versions_role_fk
    FOREIGN KEY (role_id, tenant_id) REFERENCES role_expectations (id, tenant_id),
  CONSTRAINT role_expectation_versions_actor_traceable
    CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL)
);

CREATE INDEX role_expectation_versions_role_idx
  ON role_expectation_versions (tenant_id, role_id, version);

-- ---------------------------------------------------------------------------
-- Role assignments
-- ---------------------------------------------------------------------------

CREATE TABLE role_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  role_id uuid NOT NULL,
  employee_key text NOT NULL CHECK (char_length(employee_key) BETWEEN 1 AND 200),
  employee_id text NOT NULL CHECK (char_length(employee_id) BETWEEN 1 AND 200),
  employee_label text CHECK (employee_label IS NULL OR char_length(employee_label) BETWEEN 1 AND 200),
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_assignments_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT role_assignments_role_employee_unique
    UNIQUE (tenant_id, role_id, employee_key),
  CONSTRAINT role_assignments_role_fk
    FOREIGN KEY (role_id, tenant_id) REFERENCES role_expectations (id, tenant_id)
);

CREATE INDEX role_assignments_tenant_idx ON role_assignments (tenant_id);
CREATE INDEX role_assignments_employee_idx ON role_assignments (tenant_id, employee_key);
CREATE INDEX role_assignments_role_idx ON role_assignments (tenant_id, role_id);

CREATE TABLE role_assignment_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  role_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  change_kind text NOT NULL
    CHECK (change_kind IN ('assigned', 'revised', 'retired', 'reactivated')),
  -- immutable identity content, snapshotted for self-containment
  employee_id text NOT NULL CHECK (char_length(employee_id) BETWEEN 1 AND 200),
  employee_label text CHECK (employee_label IS NULL OR char_length(employee_label) BETWEEN 1 AND 200),
  -- content
  allocation double precision NOT NULL CHECK (allocation > 0 AND allocation <= 1),
  status text NOT NULL CHECK (status IN ('active', 'retired')),
  evidence_observation_ids jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence_observation_ids) = 'array'
           AND jsonb_array_length(evidence_observation_ids) <= 32),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
  -- audit quartet
  actor_kind text NOT NULL
    CHECK (actor_kind IN ('person', 'team', 'agent', 'system', 'external')),
  actor_id text,
  actor_label text,
  changed_by_principal text NOT NULL,
  rationale text
    CHECK (rationale IS NULL OR char_length(rationale) BETWEEN 1 AND 2000),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_assignment_versions_version_unique UNIQUE (tenant_id, assignment_id, version),
  CONSTRAINT role_assignment_versions_assignment_fk
    FOREIGN KEY (assignment_id, tenant_id) REFERENCES role_assignments (id, tenant_id),
  CONSTRAINT role_assignment_versions_role_fk
    FOREIGN KEY (role_id, tenant_id) REFERENCES role_expectations (id, tenant_id),
  CONSTRAINT role_assignment_versions_actor_traceable
    CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL)
);

CREATE INDEX role_assignment_versions_assignment_idx
  ON role_assignment_versions (tenant_id, assignment_id, version);
CREATE INDEX role_assignment_versions_role_idx
  ON role_assignment_versions (tenant_id, role_id);

-- ---------------------------------------------------------------------------
-- Workforce signals (observed behavior — immutable)
-- ---------------------------------------------------------------------------

CREATE TABLE workforce_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  employee_key text NOT NULL CHECK (char_length(employee_key) BETWEEN 1 AND 200),
  employee_id text NOT NULL CHECK (char_length(employee_id) BETWEEN 1 AND 200),
  employee_label text CHECK (employee_label IS NULL OR char_length(employee_label) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('workload', 'performance')),
  -- workload: hours per week in [0, 168]; performance: score in [0, 1]
  value double precision NOT NULL
    CHECK ((kind = 'workload' AND value >= 0 AND value <= 168)
           OR (kind = 'performance' AND value >= 0 AND value <= 1)),
  evidence_observation_ids jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence_observation_ids) = 'array'
           AND jsonb_array_length(evidence_observation_ids) <= 32),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
  actor_kind text NOT NULL
    CHECK (actor_kind IN ('person', 'team', 'agent', 'system', 'external')),
  actor_id text,
  actor_label text,
  recorded_by_principal text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workforce_signals_actor_traceable
    CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL)
);

CREATE INDEX workforce_signals_tenant_employee_idx
  ON workforce_signals (tenant_id, employee_key, kind, recorded_at);
CREATE INDEX workforce_signals_tenant_recorded_idx
  ON workforce_signals (tenant_id, recorded_at);

-- ---------------------------------------------------------------------------
-- Workforce assessments (the interpretation)
-- ---------------------------------------------------------------------------

CREATE TABLE workforce_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  employee_key text NOT NULL CHECK (char_length(employee_key) BETWEEN 1 AND 200),
  employee_id text NOT NULL CHECK (char_length(employee_id) BETWEEN 1 AND 200),
  employee_label text CHECK (employee_label IS NULL OR char_length(employee_label) BETWEEN 1 AND 200),
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workforce_assessments_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT workforce_assessments_employee_unique UNIQUE (tenant_id, employee_key)
);

CREATE INDEX workforce_assessments_tenant_idx ON workforce_assessments (tenant_id);
CREATE INDEX workforce_assessments_employee_idx ON workforce_assessments (tenant_id, employee_id);

CREATE TABLE workforce_assessment_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  assessment_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  change_kind text NOT NULL CHECK (change_kind IN ('issued', 'reassessed')),
  -- immutable identity content, snapshotted for self-containment
  employee_id text NOT NULL CHECK (char_length(employee_id) BETWEEN 1 AND 200),
  employee_label text CHECK (employee_label IS NULL OR char_length(employee_label) BETWEEN 1 AND 200),
  -- the deterministic computed interpretation (full snapshot, lock 37)
  workload jsonb NOT NULL CHECK (jsonb_typeof(workload) = 'object'),
  fit jsonb NOT NULL CHECK (jsonb_typeof(fit) = 'object'),
  performance jsonb NOT NULL CHECK (jsonb_typeof(performance) = 'object'),
  staffing jsonb NOT NULL CHECK (jsonb_typeof(staffing) = 'object'),
  scope jsonb NOT NULL CHECK (jsonb_typeof(scope) = 'object'),
  adverse_findings jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(adverse_findings) = 'array'),
  alternative_explanations jsonb NOT NULL
    CHECK (jsonb_typeof(alternative_explanations) = 'array'
           AND jsonb_array_length(alternative_explanations) <= 64),
  alternatives jsonb NOT NULL
    CHECK (jsonb_typeof(alternatives) = 'array'
           AND jsonb_array_length(alternatives) <= 64),
  recommendation_kind text NOT NULL
    CHECK (recommendation_kind IN (
      'redistribute_work', 'training', 'hire', 'role_change', 'performance_action',
      'process_improvement', 'automation', 'monitor', 'no_action', 'termination')),
  recommendation_text text NOT NULL CHECK (char_length(recommendation_text) BETWEEN 1 AND 2000),
  employment_impacting boolean NOT NULL,
  confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  -- the options this version was computed under (reproducibility, lock 37)
  window_weeks integer NOT NULL CHECK (window_weeks BETWEEN 1 AND 52),
  workload_margin double precision NOT NULL CHECK (workload_margin >= 0 AND workload_margin <= 1),
  performance_strong double precision NOT NULL CHECK (performance_strong >= 0 AND performance_strong <= 1),
  performance_satisfactory double precision NOT NULL
    CHECK (performance_satisfactory >= 0 AND performance_satisfactory <= 1),
  considered_signal_ids jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(considered_signal_ids) = 'array'
           AND jsonb_array_length(considered_signal_ids) <= 200),
  evidence_observation_ids jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence_observation_ids) = 'array'
           AND jsonb_array_length(evidence_observation_ids) <= 32),
  -- audit quartet
  actor_kind text NOT NULL
    CHECK (actor_kind IN ('person', 'team', 'agent', 'system', 'external')),
  actor_id text,
  actor_label text,
  changed_by_principal text NOT NULL,
  rationale text
    CHECK (rationale IS NULL OR char_length(rationale) BETWEEN 1 AND 2000),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workforce_assessment_versions_version_unique UNIQUE (tenant_id, assessment_id, version),
  CONSTRAINT workforce_assessment_versions_assessment_fk
    FOREIGN KEY (assessment_id, tenant_id) REFERENCES workforce_assessments (id, tenant_id),
  CONSTRAINT workforce_assessment_versions_actor_traceable
    CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL),
  -- Lock 20, enforced in STORAGE (defense in depth behind the service
  -- validation): an employment-impacting recommendation must preserve
  -- uncertainty (confidence < 1), carry at least one alternative
  -- explanation, at least two alternatives, and at least one evidence
  -- reference (considered signals or cited observations).
  CONSTRAINT workforce_assessment_versions_employment_guards CHECK (
    NOT employment_impacting
    OR (
      confidence < 1
      AND jsonb_array_length(alternative_explanations) >= 1
      AND jsonb_array_length(alternatives) >= 2
      AND (jsonb_array_length(considered_signal_ids)
           + jsonb_array_length(evidence_observation_ids)) >= 1
    )
  ),
  -- An adverse-action recommendation must be grounded in at least one
  -- adverse computed finding — prose alone cannot justify a
  -- termination/performance action.
  CONSTRAINT workforce_assessment_versions_grounding CHECK (
    recommendation_kind NOT IN ('termination', 'performance_action')
    OR jsonb_array_length(adverse_findings) >= 1
  )
);

CREATE INDEX workforce_assessment_versions_assessment_idx
  ON workforce_assessment_versions (tenant_id, assessment_id, version);
CREATE INDEX workforce_assessment_versions_employee_idx
  ON workforce_assessment_versions (tenant_id, employee_id);

-- ---------------------------------------------------------------------------
-- Workforce decisions (the authorized human decision — append-only)
-- ---------------------------------------------------------------------------

CREATE TABLE workforce_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  assessment_id uuid NOT NULL,
  assessment_version integer NOT NULL CHECK (assessment_version >= 1),
  decision text NOT NULL
    CHECK (decision IN ('accepted', 'rejected', 'superseded', 'more_information_needed')),
  -- HUMAN decision authority: the decider is always a person, always traceable.
  decider_kind text NOT NULL CHECK (decider_kind = 'person'),
  decider_id text NOT NULL CHECK (char_length(decider_id) BETWEEN 1 AND 200),
  decider_label text CHECK (decider_label IS NULL OR char_length(decider_label) BETWEEN 1 AND 200),
  decided_by_principal text NOT NULL,
  rationale text
    CHECK (rationale IS NULL OR char_length(rationale) BETWEEN 1 AND 2000),
  follow_up_note text
    CHECK (follow_up_note IS NULL OR char_length(follow_up_note) BETWEEN 1 AND 2000),
  decided_at timestamptz NOT NULL DEFAULT now(),
  -- First decision wins: exactly one decision per assessment version.
  CONSTRAINT workforce_decisions_version_unique
    UNIQUE (tenant_id, assessment_id, assessment_version),
  CONSTRAINT workforce_decisions_assessment_fk
    FOREIGN KEY (assessment_id, tenant_id) REFERENCES workforce_assessments (id, tenant_id),
  CONSTRAINT workforce_decisions_version_fk
    FOREIGN KEY (assessment_id, tenant_id, assessment_version)
    REFERENCES workforce_assessment_versions (assessment_id, tenant_id, version)
);

CREATE INDEX workforce_decisions_assessment_idx
  ON workforce_decisions (tenant_id, assessment_id, decided_at);

-- ---------------------------------------------------------------------------
-- Append-only enforcement
-- ---------------------------------------------------------------------------

-- Storage-level audit guarantee: the workforce module's history is
-- append-only. Nothing may UPDATE, DELETE or TRUNCATE the version tables,
-- the signal table or the decision table — not even a future module
-- bypassing the service. The identity tables may advance their version
-- pointer (UPDATE) — that is how versioning moves — but their rows are
-- never erased. Observed behavior (signals) and human decisions are even
-- stricter: they have no mutable column at all. The messages deliberately
-- name no row id so the same function serves the row-level and the
-- statement-level triggers (the goals/processes/capabilities discipline).

CREATE OR REPLACE FUNCTION role_expectation_versions_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'role expectation versions are append-only (W019 workforce audit trail): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER role_expectation_versions_immutable
  BEFORE UPDATE OR DELETE ON role_expectation_versions
  FOR EACH ROW EXECUTE FUNCTION role_expectation_versions_reject_mutation();

CREATE TRIGGER role_expectation_versions_immutable_truncate
  BEFORE TRUNCATE ON role_expectation_versions
  FOR EACH STATEMENT EXECUTE FUNCTION role_expectation_versions_reject_mutation();

CREATE OR REPLACE FUNCTION role_assignment_versions_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'role assignment versions are append-only (W019 workforce audit trail): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER role_assignment_versions_immutable
  BEFORE UPDATE OR DELETE ON role_assignment_versions
  FOR EACH ROW EXECUTE FUNCTION role_assignment_versions_reject_mutation();

CREATE TRIGGER role_assignment_versions_immutable_truncate
  BEFORE TRUNCATE ON role_assignment_versions
  FOR EACH STATEMENT EXECUTE FUNCTION role_assignment_versions_reject_mutation();

CREATE OR REPLACE FUNCTION workforce_signals_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'workforce signals are immutable observed behavior (W019): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workforce_signals_immutable
  BEFORE UPDATE OR DELETE ON workforce_signals
  FOR EACH ROW EXECUTE FUNCTION workforce_signals_reject_mutation();

CREATE TRIGGER workforce_signals_immutable_truncate
  BEFORE TRUNCATE ON workforce_signals
  FOR EACH STATEMENT EXECUTE FUNCTION workforce_signals_reject_mutation();

CREATE OR REPLACE FUNCTION workforce_assessment_versions_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'workforce assessment versions are append-only (W019 workforce audit trail): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workforce_assessment_versions_immutable
  BEFORE UPDATE OR DELETE ON workforce_assessment_versions
  FOR EACH ROW EXECUTE FUNCTION workforce_assessment_versions_reject_mutation();

CREATE TRIGGER workforce_assessment_versions_immutable_truncate
  BEFORE TRUNCATE ON workforce_assessment_versions
  FOR EACH STATEMENT EXECUTE FUNCTION workforce_assessment_versions_reject_mutation();

CREATE OR REPLACE FUNCTION workforce_decisions_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'workforce decisions are append-only authorized human decisions (W019): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workforce_decisions_immutable
  BEFORE UPDATE OR DELETE ON workforce_decisions
  FOR EACH ROW EXECUTE FUNCTION workforce_decisions_reject_mutation();

CREATE TRIGGER workforce_decisions_immutable_truncate
  BEFORE TRUNCATE ON workforce_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION workforce_decisions_reject_mutation();

CREATE OR REPLACE FUNCTION workforce_records_reject_erasure() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'workforce records cannot be erased (W019): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER role_expectations_immutable_delete
  BEFORE DELETE ON role_expectations
  FOR EACH ROW EXECUTE FUNCTION workforce_records_reject_erasure();

CREATE TRIGGER role_expectations_immutable_truncate
  BEFORE TRUNCATE ON role_expectations
  FOR EACH STATEMENT EXECUTE FUNCTION workforce_records_reject_erasure();

CREATE TRIGGER role_assignments_immutable_delete
  BEFORE DELETE ON role_assignments
  FOR EACH ROW EXECUTE FUNCTION workforce_records_reject_erasure();

CREATE TRIGGER role_assignments_immutable_truncate
  BEFORE TRUNCATE ON role_assignments
  FOR EACH STATEMENT EXECUTE FUNCTION workforce_records_reject_erasure();

CREATE TRIGGER workforce_assessments_immutable_delete
  BEFORE DELETE ON workforce_assessments
  FOR EACH ROW EXECUTE FUNCTION workforce_records_reject_erasure();

CREATE TRIGGER workforce_assessments_immutable_truncate
  BEFORE TRUNCATE ON workforce_assessments
  FOR EACH STATEMENT EXECUTE FUNCTION workforce_records_reject_erasure();
