-- W056 — Longitudinal Company Simulator: the synthetic company's own tables.
--
-- Three tables, every one tenant-scoped (rule d of the architecture gate):
--   sim_companies     — the materialized company identity and month cursor;
--   sim_hidden_facts  — the HIDDEN CONSEQUENTIAL FACTS (ground truth): one
--                       row per month, carrying the leak-detection marker,
--                       the month's true driver/answer, the consequentiality
--                       verdict and the intervention's hidden realized
--                       value. This is the ONLY place ground truth lives;
--                       the reasoning layer never reads it (the benchmark's
--                       leakage proof scans every cognition surface for the
--                       markers);
--   sim_month_reports — the append-only observable record of each advanced
--                       month (the behavior the benchmark compares).
--
-- Hidden facts and month reports are append-only evidence (the repo-wide
-- PostgreSQL trigger discipline): UPDATE/DELETE/TRUNCATE are rejected
-- outright. sim_companies carries the month cursor, so it allows the one
-- sanctioned UPDATE of current_month (the service performs it inside the
-- month's own transaction); DELETE/TRUNCATE are still rejected — a
-- synthetic company cannot be silently erased out from under its history.

CREATE TABLE sim_companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  seed integer NOT NULL CHECK (seed >= 0 AND seed <= 2147483647),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  current_month integer NOT NULL DEFAULT 0 CHECK (current_month >= 0),
  goal_id uuid NOT NULL,
  process_id uuid NOT NULL,
  -- The materialization manifest: the contract-record ids of the company's
  -- public surface (person ids, source ids, entity ids) so reads can
  -- resolve the design without re-deriving identity through other modules'
  -- listings. Contains NO hidden values.
  manifest jsonb NOT NULL,
  created_by_principal text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, seed)
);

CREATE TABLE sim_hidden_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES sim_companies(id),
  month integer NOT NULL CHECK (month >= 1),
  topic text NOT NULL,
  marker text NOT NULL CHECK (char_length(marker) BETWEEN 4 AND 64),
  answer_text text NOT NULL,
  consequential boolean NOT NULL,
  first_choice_threshold numeric(4, 2) NOT NULL,
  intervention_base_expectation numeric(10, 2) NOT NULL,
  intervention_realized numeric(10, 2) NOT NULL,
  recorded_at timestamptz NOT NULL,
  UNIQUE (tenant_id, company_id, month)
);

CREATE TABLE sim_month_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES sim_companies(id),
  month integer NOT NULL CHECK (month >= 1),
  report jsonb NOT NULL,
  learning_update_id uuid,
  snapshot_id uuid,
  recorded_by_principal text NOT NULL,
  recorded_at timestamptz NOT NULL,
  UNIQUE (tenant_id, company_id, month)
);

CREATE INDEX sim_month_reports_tenant_idx ON sim_month_reports (tenant_id, company_id, month);
CREATE INDEX sim_hidden_facts_tenant_idx ON sim_hidden_facts (tenant_id, company_id, month);

-- Append-only discipline on the two evidence tables.
CREATE OR REPLACE FUNCTION sim_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'simulator evidence tables are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sim_hidden_facts_no_update BEFORE UPDATE ON sim_hidden_facts
  FOR EACH ROW EXECUTE FUNCTION sim_reject_mutation();
CREATE TRIGGER sim_hidden_facts_no_delete BEFORE DELETE ON sim_hidden_facts
  FOR EACH STATEMENT EXECUTE FUNCTION sim_reject_mutation();
CREATE TRIGGER sim_hidden_facts_no_truncate BEFORE TRUNCATE ON sim_hidden_facts
  FOR EACH STATEMENT EXECUTE FUNCTION sim_reject_mutation();

CREATE TRIGGER sim_month_reports_no_update BEFORE UPDATE ON sim_month_reports
  FOR EACH ROW EXECUTE FUNCTION sim_reject_mutation();
CREATE TRIGGER sim_month_reports_no_delete BEFORE DELETE ON sim_month_reports
  FOR EACH STATEMENT EXECUTE FUNCTION sim_reject_mutation();
CREATE TRIGGER sim_month_reports_no_truncate BEFORE TRUNCATE ON sim_month_reports
  FOR EACH STATEMENT EXECUTE FUNCTION sim_reject_mutation();

CREATE TRIGGER sim_companies_no_delete BEFORE DELETE ON sim_companies
  FOR EACH STATEMENT EXECUTE FUNCTION sim_reject_mutation();
CREATE TRIGGER sim_companies_no_truncate BEFORE TRUNCATE ON sim_companies
  FOR EACH STATEMENT EXECUTE FUNCTION sim_reject_mutation();
