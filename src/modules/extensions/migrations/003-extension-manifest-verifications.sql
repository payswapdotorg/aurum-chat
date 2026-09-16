-- W025 · extensions module — manifest verification runs (append-only
-- evidence).
--
-- One IMMUTABLE row per verification run of one manifest version. A run
-- is the deterministic static examination of a stored manifest against
-- the closed check vocabulary (manifest-schema,
-- permissions-consistency, capability-declarations, quota-bounds,
-- compatibility-bounds — verification.ts); the row records every
-- per-check outcome plus a bounded summary. The manifest's DERIVED
-- verification state folds from its runs: UNVERIFIED (none), VERIFIED
-- (latest passed), FAILED (latest failed).
--
-- Why runs rather than a mutable state column: verification is EVIDENCE
-- (ARCHITECTURE.md §24 — reconstructable), evidence is append-only in
-- this codebase, and drift must be visible as new runs — a rule added
-- later can FAIL an older manifest without rewriting history. The
-- marketplace's AUTOMATED_VERIFICATION phase (W028) and the builder's
-- verify step (W027) append runs through this module's contract and run
-- the SAME exported pure checks.
--
-- Storage-level append-only guarantee (the house pattern — approval
-- decisions, events, observations): the triggers below reject UPDATE,
-- DELETE and TRUNCATE outright.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the composite
-- foreign key (manifest_id, tenant_id) keeps a run tenant-consistent
-- with its manifest.

CREATE TABLE extension_manifest_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  manifest_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('verified', 'failed')),
  checks jsonb NOT NULL CHECK (jsonb_typeof(checks) = 'array'),
  summary text NOT NULL CHECK (summary <> ''),
  verifier text NOT NULL CHECK (verifier <> ''),
  ran_at timestamptz NOT NULL,
  CONSTRAINT extension_manifest_verifications_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT extension_manifest_verifications_manifest_tenant_fk
    FOREIGN KEY (manifest_id, tenant_id) REFERENCES extension_manifests (id, tenant_id)
);

CREATE INDEX extension_manifest_verifications_tenant_manifest_idx
  ON extension_manifest_verifications (tenant_id, manifest_id, ran_at DESC);

-- Storage-level append-only guarantee: nothing may UPDATE, DELETE or
-- TRUNCATE a verification run — not even a future module bypassing the
-- service. The message deliberately names no row id so the same function
-- serves the row-level and the statement-level trigger.

CREATE OR REPLACE FUNCTION extension_manifest_verifications_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'manifest verification runs are append-only evidence (W025 extension contracts): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER extension_manifest_verifications_immutable
  BEFORE UPDATE OR DELETE ON extension_manifest_verifications
  FOR EACH ROW EXECUTE FUNCTION extension_manifest_verifications_reject_mutation();

CREATE TRIGGER extension_manifest_verifications_immutable_truncate
  BEFORE TRUNCATE ON extension_manifest_verifications
  FOR EACH STATEMENT EXECUTE FUNCTION extension_manifest_verifications_reject_mutation();
