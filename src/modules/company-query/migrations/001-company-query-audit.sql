-- W126 · company-query module — the append-only query audit.
--
-- The query plane's ONLY persistence (see contract.ts): one row per
-- executed company query recording WHO asked (the authenticated
-- TenantContext principal — system-captured, never caller-suppliable),
-- WHAT was asked (the question and the resolved surface scope), WHEN (the
-- service clock), and HOW STRONG the answer was (claim, contradiction,
-- unknown, material-gap counts, and whether the optional LLM presentation
-- layer was used). Answer CONTENT is deliberately NOT stored here: the
-- answer is a derived, two-layer composition over other modules'
-- contracts, never domain truth of its own (COMPANY-COVERAGE-ARCHITECTURE
-- §2 "coverage is not a second source of truth", applied to the query
-- plane; ARCHITECTURE.md lock 10 — LLM output especially never lands in a
-- domain table).
--
-- Append-only, like every evidence/audit table in this codebase: UPDATE,
-- DELETE and TRUNCATE are rejected by trigger (the goals/epistemics/
-- meetings precedent). A query that was asked can never be silently
-- un-asked.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the service
-- inserts with the asking tenant only, and no read path exists on this
-- surface (the query plane never re-serves audit rows — governance reads
-- arrive with the audit module's own tooling).

CREATE TABLE company_query_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  question text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 2000),
  surfaces text[] NOT NULL CHECK (array_length(surfaces, 1) BETWEEN 1 AND 13),
  generated_at timestamptz NOT NULL,
  claim_count integer NOT NULL CHECK (claim_count >= 0),
  contradiction_count integer NOT NULL CHECK (contradiction_count >= 0),
  unknown_count integer NOT NULL CHECK (unknown_count >= 0),
  material_gap_count integer NOT NULL CHECK (material_gap_count >= 0),
  llm_used boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX company_query_log_tenant_created_idx
  ON company_query_log (tenant_id, created_at DESC);

-- Append-only enforcement (the epistemics/goals trigger discipline: a
-- row-level guard for UPDATE/DELETE plus a statement-level guard for
-- TRUNCATE).
CREATE OR REPLACE FUNCTION company_query_log_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'company_query_log is append-only (W126: queries are audited, never rewritten)';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER company_query_log_immutable
  BEFORE UPDATE OR DELETE ON company_query_log
  FOR EACH ROW EXECUTE FUNCTION company_query_log_reject_mutation();

CREATE TRIGGER company_query_log_immutable_truncate
  BEFORE TRUNCATE ON company_query_log
  FOR EACH STATEMENT EXECUTE FUNCTION company_query_log_reject_mutation();
