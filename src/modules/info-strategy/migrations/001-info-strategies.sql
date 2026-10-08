-- W134 · info-strategy module — the learnable information strategy layer.
--
-- An InfoStrategy is scoped per (tenant, goal, context fingerprint) and
-- is VERSIONED: adjustments append new versions; historical versions are
-- immutable. This migration carries the two load-bearing schema laws:
--
--   1. VERSION UNIQUENESS IS SCOPED PER TENANT: UNIQUE (tenant_id,
--      strategy_id, version) — a version number is unique inside one
--      tenant's strategy, never globally (the schema-boundary sweep's
--      per-tenant namespace rule). Version minting is serialized by the
--      service (row lock + current_version pointer bump).
--
--   2. ONE ACTIVE STRATEGY PER SCOPE: a PARTIAL unique index on
--      (tenant_id, goal_id, fingerprint_id) WHERE status = 'active' —
--      "the strategy for this goal under this context" stays unambiguous
--      while a retired strategy still blocks nothing: the returning need
--      is a NEW strategy definition (the missions dead-end discipline).
--
-- Cross-module references are opaque forward references, deliberately NOT
-- foreign keys (the house discipline): goal → goals module (W008,
-- validated ACTIVE at write time), fingerprint → context module (W134,
-- validated readable at write time), unknown ids inside the content →
-- epistemics (W007, validated readable at write time). Outcome evidence
-- and preferred sources are OPAQUE (prospective/historical references —
-- see types.ts for the rationale).
--
-- Append-only discipline (the audit/coverage/context precedent):
-- info_strategy_versions reject UPDATE/DELETE/TRUNCATE outright — a later
-- version never rewrites an earlier one; the learning loop's history is
-- evidence. The info_strategies row itself is the mutable POINTER (scope,
-- status, current version, lifecycle metadata) — its content history
-- lives entirely in the immutable version rows.
--
-- Tenant scoping (ADR-0001): every table carries tenant_id; two tenants
-- hold fully independent strategy state, and cross-tenant access is
-- indistinguishable from missing at the service layer.

-- The strategy identity: scope + lifecycle + the current-version pointer.
CREATE TABLE info_strategies (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  goal_id uuid NOT NULL,
  fingerprint_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'retired')),
  current_version integer NOT NULL DEFAULT 1
    CHECK (current_version >= 1),
  lifecycle_note text
    CHECK (lifecycle_note IS NULL OR char_length(lifecycle_note) >= 1),
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One ACTIVE strategy per (tenant, goal, fingerprint); retired strategies
-- free the scope for a successor definition.
CREATE UNIQUE INDEX info_strategies_active_scope_idx
  ON info_strategies (tenant_id, goal_id, fingerprint_id)
  WHERE status = 'active';

CREATE INDEX info_strategies_tenant_goal_idx ON info_strategies (tenant_id, goal_id);
CREATE INDEX info_strategies_tenant_fingerprint_idx ON info_strategies (tenant_id, fingerprint_id);
CREATE INDEX info_strategies_tenant_status_idx ON info_strategies (tenant_id, status);

-- One immutable strategy version: the full self-contained content
-- snapshot, the outcome evidence that justified it, its note and evidence
-- links. Version numbers are unique PER (tenant, strategy).
CREATE TABLE info_strategy_versions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  strategy_id uuid NOT NULL,
  version integer NOT NULL
    CHECK (version >= 1),
  document jsonb NOT NULL
    CHECK (jsonb_typeof(document) = 'object'),
  outcome_evidence jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(outcome_evidence) = 'array'),
  note text
    CHECK (note IS NULL OR char_length(note) >= 1),
  derived_from jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(derived_from) = 'array'),
  recorded_by text NOT NULL
    CHECK (char_length(recorded_by) >= 1),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, strategy_id, version)
);

CREATE INDEX info_strategy_versions_tenant_strategy_idx
  ON info_strategy_versions (tenant_id, strategy_id, version);

-- Append-only: version history is immutable evidence (the learning loop).
CREATE OR REPLACE FUNCTION info_strategy_versions_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'info strategy versions are append-only (W134 info-strategy): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER info_strategy_versions_immutable
  BEFORE UPDATE OR DELETE ON info_strategy_versions
  FOR EACH ROW EXECUTE FUNCTION info_strategy_versions_reject_mutation();

CREATE TRIGGER info_strategy_versions_immutable_truncate
  BEFORE TRUNCATE ON info_strategy_versions
  FOR EACH STATEMENT EXECUTE FUNCTION info_strategy_versions_reject_mutation();
