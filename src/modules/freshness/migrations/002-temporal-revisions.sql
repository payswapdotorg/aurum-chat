-- W006 · freshness module — temporal revisions (versioned mutable state).
--
-- "Reality is immutable; understanding is mutable" (ARCHITECTURE.md §4):
-- world-model relationships (W005) and beliefs (W007) are versioned, never
-- overwritten. This table is the generic machinery: one append-only chain
-- per (tenant, subject_kind, subject_id). Each row is one version —
--
--   * version      — 1-based, service-minted, strictly increasing with
--                    valid_from (enforced by the two unique constraints:
--                    no two versions share a number, and no two versions
--                    share a valid-time start, so the derived intervals
--                    [valid_from_i, valid_from_{i+1}) are well-defined);
--   * state        — the versioned mutable payload (plain JSON);
--   * valid_from   — VALID time: when the asserted state began holding in
--                    reality (caller-supplied, strict ISO);
--   * recorded_at  — TRANSACTION time: when Aurum committed the version
--                    (service-minted via the injectable clock);
--   * provenance   — the observation ids supporting this version
--                    (validated by the service through the observations
--                    contract: existing in-tenant and readable; lock 11 —
--                    no versioned understanding without evidence). Stored
--                    as a sorted, deduplicated jsonb array; deliberately
--                    NOT a foreign key — cross-module table references are
--                    not made at W006 (same discipline the observations
--                    module applied to source references);
--   * rationale    — why this version was recorded.
--
-- Superseding = appending the next version. validTo/current are DERIVED
-- from the chain and never stored. Append-only is enforced at the storage
-- layer, not just by service discipline: the triggers below reject
-- UPDATE, DELETE and TRUNCATE outright — history cannot be rewritten even
-- by a caller bypassing the service. (Back-dated corrections that would
-- insert a version out of valid-time order are rejected by the service;
-- full bitemporal correction semantics are an ADR-level change, out of
-- W006 scope.)
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; two tenants may
-- hold independent revision chains for the same subject key without any
-- cross-tenant visibility.

CREATE TABLE temporal_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  subject_kind text NOT NULL,
  subject_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  state jsonb NOT NULL,
  valid_from timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  provenance_observation_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  rationale text,
  CONSTRAINT temporal_revisions_subject_version_unique
    UNIQUE (tenant_id, subject_kind, subject_id, version),
  CONSTRAINT temporal_revisions_subject_valid_from_unique
    UNIQUE (tenant_id, subject_kind, subject_id, valid_from),
  CONSTRAINT temporal_revisions_provenance_shape
    CHECK (jsonb_typeof(provenance_observation_ids) = 'array')
);

CREATE INDEX temporal_revisions_subject_idx
  ON temporal_revisions (tenant_id, subject_kind, subject_id, version);

-- Storage-level append-only guarantee: nothing may UPDATE, DELETE or
-- TRUNCATE a temporal revision — not even a future module bypassing the
-- service. The message deliberately names no row id so the same function
-- serves the row-level and the statement-level trigger.

CREATE OR REPLACE FUNCTION temporal_revisions_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'temporal revisions are append-only (W006 temporal state): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER temporal_revisions_immutable
  BEFORE UPDATE OR DELETE ON temporal_revisions
  FOR EACH ROW EXECUTE FUNCTION temporal_revisions_reject_mutation();

CREATE TRIGGER temporal_revisions_immutable_truncate
  BEFORE TRUNCATE ON temporal_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION temporal_revisions_reject_mutation();
