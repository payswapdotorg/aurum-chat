-- W046 · audit module — the append-only decision-evidence trail.
--
-- ARCHITECTURE.md §24 (frozen): "Consequential cognition/actions are
-- reconstructable:
--   `input → evidence → claims/beliefs → unknown/mission → policy →
--    model/provider → recommendation → approval → execution → result →
--    outcome → learning`.
--  Audit records are append-only from the domain perspective."
--
-- One table, deliberately generic over subjects: any consequential record
-- (an authority-policy change — "their change history belongs to audit,
-- W046" per the actions contract; an action request; a cognitive
-- execution; a future extension deployment or API/MCP operation) can be
-- evidenced here with WHERE it sits on the §24 chain, WHAT happened, the
-- §25 correlation identity of the logical flow it belongs to, a human
-- summary and a structured (size-capped, plain-JSON-object) detail
-- snapshot. PostgreSQL triggers reject UPDATE/DELETE/TRUNCATE outright:
-- from the domain perspective the trail only ever grows — rewriting
-- history is not an operation, it is a database error (the claims/
-- steps/decisions retention discipline applied to the audit trail
-- itself).
--
-- Cross-module references (subjects) are deliberately NOT foreign keys —
-- the codebase discipline (freshness provenance precedent): the subject
-- is an opaque forward reference owned by its module, recorded as
-- (subject_kind, subject_id); `subject_id` is a uuid because every
-- domain record identity in Aurum is a uuid (IMPLEMENTATION-STACK §8)
-- and may be null only for tenant-wide subjects (e.g. the default
-- authority-policy row's change events address the tenant as a whole).
--
-- The §24 chain-stage vocabulary is mirrored in the CHECK constraint
-- below and in the module's validation.ts (CHAIN_STAGES) — one frozen
-- list, two layers of defense.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; two tenants
-- hold fully independent audit trails, and cross-tenant access is
-- indistinguishable from missing records at the service layer.

CREATE TABLE audit_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  -- What kind of record this event is about ('actions.policy',
  -- 'actions.request', 'cognition.execution', ... any canonical kind).
  subject_kind text NOT NULL
    CHECK (char_length(subject_kind) >= 1 AND char_length(subject_kind) <= 128),
  -- The record's uuid, or null for tenant-wide subjects.
  subject_id uuid,
  -- What happened ('policy-changed', 'authorized', 'approval-decided', ...).
  event text NOT NULL
    CHECK (char_length(event) >= 1 AND char_length(event) <= 64),
  -- WHERE on the §24 chain this event sits.
  chain_stage text NOT NULL CHECK (chain_stage IN (
    'input', 'evidence', 'claims-beliefs', 'unknown-mission', 'policy',
    'model-provider', 'recommendation', 'approval', 'execution', 'result',
    'outcome', 'learning'
  )),
  -- §25 correlation identity: which logical flow this event belongs to.
  correlation_id uuid,
  summary text NOT NULL
    CHECK (char_length(summary) >= 1 AND char_length(summary) <= 2048),
  -- Structured evidence snapshot — a plain JSON object, size-capped by
  -- the service (never provider-native objects; no credentials).
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(detail) = 'object'),
  -- The TenantContext principal that recorded the event.
  principal_id text NOT NULL CHECK (char_length(principal_id) >= 1),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_records_tenant_recorded_idx ON audit_records (tenant_id, recorded_at);
CREATE INDEX audit_records_tenant_subject_idx ON audit_records (tenant_id, subject_kind, subject_id);
CREATE INDEX audit_records_tenant_correlation_idx ON audit_records (tenant_id, correlation_id);

CREATE OR REPLACE FUNCTION audit_records_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit records are append-only (W046 audit): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_records_immutable
  BEFORE UPDATE OR DELETE ON audit_records
  FOR EACH ROW EXECUTE FUNCTION audit_records_reject_mutation();

CREATE TRIGGER audit_records_immutable_truncate
  BEFORE TRUNCATE ON audit_records
  FOR EACH STATEMENT EXECUTE FUNCTION audit_records_reject_mutation();
