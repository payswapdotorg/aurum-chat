-- W134 · context module — ContextFingerprint storage over the TL-frozen
-- shared vocabulary (W124b staged src/modules/context/types.ts; W134 owns
-- the derivation implementation).
--
-- THE NULL-SIGNAL LAW AT THE SCHEMA LEVEL: every typed context dimension
-- is its own NULLABLE column — an unknown dimension is stored as SQL NULL,
-- never a fabricated default. The fingerprint records what is known;
-- knownDimensions/absentDimensions (the summary) read exactly these
-- nulls. The task descriptor is likewise nullable (null = task unknown at
-- derivation time).
--
-- Dimension objects are stored as jsonb documents with shape guards
-- (typeof object); the module's validation.ts is the authoritative
-- input guard, these CHECKs are defense in depth (the coverage module's
-- two-layers discipline).
--
-- The goal reference is an opaque forward reference to a goals-module
-- (W008) record — deliberately NOT a foreign key (the house discipline:
-- goals/attention/company-query precedents). It is validated ACTIVE
-- through the goals contract at write time.
--
-- Append-only discipline (the audit/coverage precedent, applied to
-- derived context history): a fingerprint is an observation of context at
-- a point in time — re-deriving under changed context appends a NEW
-- fingerprint row; UPDATE/DELETE/TRUNCATE are rejected outright so the
-- Lab (W135) and the strategy layer (W134 info-strategy) can cite
-- fingerprints as immutable evidence.
--
-- Tenant scoping (ADR-0001): the table carries tenant_id; two tenants
-- hold fully independent fingerprint history, and cross-tenant access is
-- indistinguishable from a missing record at the service layer.

CREATE TABLE context_fingerprints (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  goal_id uuid NOT NULL,
  task_title text
    CHECK (task_title IS NULL OR (char_length(task_title) >= 1 AND char_length(task_title) <= 256)),
  task_kind text
    CHECK (task_kind IS NULL OR task_kind ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
  -- The eight typed context dimensions: NULL = unknown (null-signal law).
  season jsonb
    CHECK (season IS NULL OR jsonb_typeof(season) = 'object'),
  duration jsonb
    CHECK (duration IS NULL OR jsonb_typeof(duration) = 'object'),
  staffing jsonb
    CHECK (staffing IS NULL OR jsonb_typeof(staffing) = 'object'),
  workload text
    CHECK (workload IS NULL OR workload IN ('light', 'normal', 'heavy', 'overloaded')),
  capabilities jsonb
    CHECK (capabilities IS NULL OR jsonb_typeof(capabilities) = 'object'),
  environment jsonb
    CHECK (environment IS NULL OR jsonb_typeof(environment) = 'object'),
  constraints jsonb
    CHECK (constraints IS NULL OR jsonb_typeof(constraints) = 'object'),
  evidence_freshness jsonb
    CHECK (evidence_freshness IS NULL OR jsonb_typeof(evidence_freshness) = 'object'),
  additional_signals jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(additional_signals) = 'object'),
  derived_from jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(derived_from) = 'array'),
  derived_at timestamptz NOT NULL
);

CREATE INDEX context_fingerprints_tenant_goal_idx
  ON context_fingerprints (tenant_id, goal_id, derived_at DESC);
CREATE INDEX context_fingerprints_tenant_derived_idx
  ON context_fingerprints (tenant_id, derived_at DESC);

-- Append-only: derived context history is immutable evidence.
CREATE OR REPLACE FUNCTION context_fingerprints_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'context fingerprints are append-only (W134 context): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER context_fingerprints_immutable
  BEFORE UPDATE OR DELETE ON context_fingerprints
  FOR EACH ROW EXECUTE FUNCTION context_fingerprints_reject_mutation();

CREATE TRIGGER context_fingerprints_immutable_truncate
  BEFORE TRUNCATE ON context_fingerprints
  FOR EACH STATEMENT EXECUTE FUNCTION context_fingerprints_reject_mutation();
