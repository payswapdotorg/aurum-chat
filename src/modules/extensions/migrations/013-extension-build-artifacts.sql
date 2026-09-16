-- W027 · extensions module — extension build artifacts (append-only
-- artifact custody).
--
-- One IMMUTABLE row per (build, phase) recording WHAT the building agent
-- actually produced — the raw canonical output of the agent execution
-- that performed the phase, bounded (the service caps the serialized
-- payload at 256 KiB and records a stub when the agent exceeded it).
-- This is the "artifact/code custody" the W025 types deferred to W027:
-- in this architecture an extension's substance IS its declaration (the
-- W026 runtime executes declared capabilities, not uploaded code), so
-- custody means retaining the agent-authored design and declaration —
-- including REJECTED ones (the failure evidence names the validation
-- problems; the artifact row preserves what was actually proposed).
--
-- The row links the agent execution that produced the payload (an
-- opaque forward reference into the agents module — no cross-module FK)
-- and the principal whose pump recorded it. UNIQUE (tenant, build,
-- phase) makes recording idempotent: racing pumps record one row, and a
-- re-pump after a crash adopts the twin's custody instead of appending
-- a second copy (the first-write-wins discipline).
--
-- Storage-level append-only guarantee (the house pattern — verification
-- runs, deployment history, attempt evidence): the triggers below
-- reject UPDATE, DELETE and TRUNCATE outright.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the composite
-- foreign key keeps an artifact tenant-consistent with its build.

CREATE TABLE extension_build_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  build_id uuid NOT NULL,
  phase text NOT NULL CHECK (phase IN ('design', 'build')),
  payload jsonb NOT NULL,
  execution_id uuid NOT NULL,
  recorded_by text NOT NULL CHECK (recorded_by <> ''),
  recorded_at timestamptz NOT NULL,
  CONSTRAINT extension_build_artifacts_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT extension_build_artifacts_build_tenant_fk
    FOREIGN KEY (build_id, tenant_id) REFERENCES extension_builds (id, tenant_id),
  CONSTRAINT extension_build_artifacts_build_phase_unique
    UNIQUE (tenant_id, build_id, phase)
);

CREATE INDEX extension_build_artifacts_tenant_build_idx
  ON extension_build_artifacts (tenant_id, build_id, recorded_at ASC);

-- Storage-level append-only guarantee: nothing may UPDATE, DELETE or
-- TRUNCATE a recorded artifact — not even a future module bypassing the
-- service. The message deliberately names no row id so the same function
-- serves the row-level and the statement-level trigger.

CREATE OR REPLACE FUNCTION extension_build_artifacts_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'extension build artifacts are append-only custody (W027 extension builder): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER extension_build_artifacts_immutable
  BEFORE UPDATE OR DELETE ON extension_build_artifacts
  FOR EACH ROW EXECUTE FUNCTION extension_build_artifacts_reject_mutation();

CREATE TRIGGER extension_build_artifacts_immutable_truncate
  BEFORE TRUNCATE ON extension_build_artifacts
  FOR EACH STATEMENT EXECUTE FUNCTION extension_build_artifacts_reject_mutation();
