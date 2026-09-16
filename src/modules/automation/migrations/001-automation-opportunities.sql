-- W018 · automation module — automation opportunities.
--
-- The work item: "Represent automation candidates with process evidence,
-- frequency, cost, error rate, candidate solution types, expected ROI and
-- outcome measurement."
--
-- ARCHITECTURE.md §13 (frozen) completes the chain this module heads:
-- `process → capability → gap → acquisition option → authorization →
--  deployment → outcome` — AutomationOpportunity connects observed process
-- inefficiency (W016 findings, validated through the processes contract at
-- write time) to the eight solution options §13 names verbatim, with the
-- committed expected-ROI figures and the outcome-measurement plan that will
-- judge the result (ADR-0019's baseline → expected → observed chain; W054
-- capability outcome learning builds on these records).
--
-- Three tables, the goals module's (W008) identity-plus-version discipline
-- applied to the one record kind of the module plus its measurement series:
--
--   automation_opportunities        (identity + current-version pointer)
--   automation_opportunity_versions (append-only full-snapshot chain)
--   automation_measurements         (append-only outcome observation series)
--
-- Each version is a full self-contained snapshot of the candidate: the
-- process evidence (process id + name snapshot + cited finding ids + the
-- optional capability whose gap the acquisition option would close), the
-- frequency/cost/error-rate measurements of the work as-is, the candidate
-- solution types, the committed expected-ROI figures and the
-- outcome-measurement plan. A record change appends the next version —
-- history is never rewritten, so what Aurum believed about an automation
-- candidate at any time stays reconstructable (§24 decision evidence).
-- PostgreSQL itself rejects UPDATE/DELETE/TRUNCATE on the version table
-- and UPDATE/DELETE/TRUNCATE on the measurement table, and DELETE/TRUNCATE
-- on the identity table, via triggers (there is no update or delete
-- operation on the contract either); the DERIVED layer (the expected-ROI
-- summary and the latest-observed/target-met verdict) is never persisted at
-- all — it is recomputed from the current records on every read (lock 10).
--
-- Graph key (tenant-unique, immutable after registration):
--   automation_opportunities (tenant_id, name)
-- The process of a candidate is immutable identity content (a candidate
-- about one process cannot become a candidate about another); it lives in
-- the version rows as content, but the revise input does not accept a
-- processId key at all, so it can never change.
--
-- Money: integer minor units (bigint) + ISO 4217 currency code
-- (IMPLEMENTATION-STACK §8). Frequency: integer occurrences per period.
-- Error rate: double in [0, 1]. The outcome plan is a jsonb object
-- (metric name/unit/direction/baseline/target), write-validated by the
-- service.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the composite
-- UNIQUE (id, tenant_id) on each identity is the tenant-consistent target
-- for the foreign keys, and the composite FKs make a cross-tenant or
-- dangling version/measurement unrepresentable in SQL.

-- ---------------------------------------------------------------------------
-- Automation opportunities
-- ---------------------------------------------------------------------------

CREATE TABLE automation_opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_opportunities_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT automation_opportunities_tenant_name_unique UNIQUE (tenant_id, name)
);

CREATE INDEX automation_opportunities_tenant_idx ON automation_opportunities (tenant_id);

CREATE TABLE automation_opportunity_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  change_kind text NOT NULL
    CHECK (change_kind IN ('created', 'revised', 'accepted', 'dismissed', 'reopened')),
  -- always the identity's immutable name (snapshotted for self-containment)
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('candidate', 'accepted', 'dismissed')),
  -- process evidence: the process is immutable identity content; its name
  -- is the processes module's own immutable graph key, snapshotted here
  process_id uuid NOT NULL,
  process_name text NOT NULL CHECK (char_length(process_name) BETWEEN 1 AND 200),
  finding_ids jsonb NOT NULL
    CHECK (jsonb_typeof(finding_ids) = 'array' AND jsonb_array_length(finding_ids) >= 1),
  -- the optional capability (W017) whose gap this acquisition option closes
  capability_id uuid,
  capability_name text
    CHECK (capability_name IS NULL OR char_length(capability_name) BETWEEN 1 AND 200),
  CONSTRAINT automation_opportunity_versions_capability_named
    CHECK ((capability_id IS NULL) = (capability_name IS NULL)),
  description text
    CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 2000),
  -- frequency / cost / error rate of the work as-is
  frequency_count integer NOT NULL CHECK (frequency_count >= 1),
  period text NOT NULL CHECK (period IN ('day', 'week', 'month', 'quarter', 'year')),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  current_cost_minor bigint NOT NULL
    CHECK (current_cost_minor >= 0 AND current_cost_minor <= 1000000000000000),
  error_rate double precision NOT NULL CHECK (error_rate >= 0 AND error_rate <= 1),
  -- candidate solution types (the eight §13 options, write-validated)
  solution_types jsonb NOT NULL
    CHECK (jsonb_typeof(solution_types) = 'array' AND jsonb_array_length(solution_types) >= 1),
  -- committed expected-ROI figures (the derived summary is never stored)
  expected_savings_minor bigint NOT NULL
    CHECK (expected_savings_minor >= 0 AND expected_savings_minor <= 1000000000000000),
  expected_investment_minor bigint NOT NULL
    CHECK (expected_investment_minor >= 0 AND expected_investment_minor <= 1000000000000000),
  roi_horizon_periods integer NOT NULL CHECK (roi_horizon_periods >= 1),
  -- the outcome-measurement plan
  outcome jsonb NOT NULL CHECK (jsonb_typeof(outcome) = 'object'),
  -- audit quartet: who / when / what / why
  actor_kind text NOT NULL
    CHECK (actor_kind IN ('person', 'team', 'agent', 'system', 'external')),
  actor_id text,
  actor_label text,
  changed_by_principal text NOT NULL,
  rationale text
    CHECK (rationale IS NULL OR char_length(rationale) BETWEEN 1 AND 2000),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_opportunity_versions_version_unique
    UNIQUE (tenant_id, opportunity_id, version),
  CONSTRAINT automation_opportunity_versions_opportunity_fk
    FOREIGN KEY (opportunity_id, tenant_id) REFERENCES automation_opportunities (id, tenant_id),
  CONSTRAINT automation_opportunity_versions_actor_traceable
    CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL)
);

CREATE INDEX automation_opportunity_versions_opportunity_idx
  ON automation_opportunity_versions (tenant_id, opportunity_id, version);
CREATE INDEX automation_opportunity_versions_process_idx
  ON automation_opportunity_versions (tenant_id, process_id);

-- ---------------------------------------------------------------------------
-- Outcome measurements (the append-only observation series)
-- ---------------------------------------------------------------------------

CREATE TABLE automation_measurements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  value double precision NOT NULL,
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence) = 'array'),
  actor_kind text NOT NULL
    CHECK (actor_kind IN ('person', 'team', 'agent', 'system', 'external')),
  actor_id text,
  actor_label text,
  recorded_by_principal text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_measurements_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT automation_measurements_opportunity_fk
    FOREIGN KEY (opportunity_id, tenant_id) REFERENCES automation_opportunities (id, tenant_id),
  CONSTRAINT automation_measurements_actor_traceable
    CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL)
);

CREATE INDEX automation_measurements_opportunity_idx
  ON automation_measurements (tenant_id, opportunity_id, recorded_at);

-- ---------------------------------------------------------------------------
-- Append-only enforcement
-- ---------------------------------------------------------------------------

-- Storage-level audit guarantee: the automation candidate history and the
-- outcome observation series are append-only. Nothing may UPDATE, DELETE
-- or TRUNCATE the version table or the measurement table — not even a
-- future module bypassing the service. The identity table may advance its
-- version pointer (UPDATE) — that is how versioning moves — but its rows
-- are never erased. The messages deliberately name no row id so the same
-- function serves the row-level and the statement-level triggers (the
-- goals/processes/capabilities discipline).

CREATE OR REPLACE FUNCTION automation_opportunity_versions_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'automation opportunity versions are append-only (W018 automation audit trail): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER automation_opportunity_versions_immutable
  BEFORE UPDATE OR DELETE ON automation_opportunity_versions
  FOR EACH ROW EXECUTE FUNCTION automation_opportunity_versions_reject_mutation();

CREATE TRIGGER automation_opportunity_versions_immutable_truncate
  BEFORE TRUNCATE ON automation_opportunity_versions
  FOR EACH STATEMENT EXECUTE FUNCTION automation_opportunity_versions_reject_mutation();

CREATE OR REPLACE FUNCTION automation_measurements_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'automation measurements are append-only (W018 outcome evidence): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER automation_measurements_immutable
  BEFORE UPDATE OR DELETE ON automation_measurements
  FOR EACH ROW EXECUTE FUNCTION automation_measurements_reject_mutation();

CREATE TRIGGER automation_measurements_immutable_truncate
  BEFORE TRUNCATE ON automation_measurements
  FOR EACH STATEMENT EXECUTE FUNCTION automation_measurements_reject_mutation();

CREATE OR REPLACE FUNCTION automation_opportunities_reject_erasure() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'automation opportunity records cannot be erased (W018): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER automation_opportunities_immutable_delete
  BEFORE DELETE ON automation_opportunities
  FOR EACH ROW EXECUTE FUNCTION automation_opportunities_reject_erasure();

CREATE TRIGGER automation_opportunities_immutable_truncate
  BEFORE TRUNCATE ON automation_opportunities
  FOR EACH STATEMENT EXECUTE FUNCTION automation_opportunities_reject_erasure();
