-- W004 · observations module — immutable evidence records.
--
-- An observation is evidence encountered by Aurum with full provenance:
-- source, channel, timestamps (observed_at per the source clock;
-- recorded_at set by the service via the injectable clock), extraction
-- lineage, permissions and confidence. It is EVIDENCE, never truth
-- (ARCHITECTURE.md §4): claims/beliefs (W007) are derived ON TOP of
-- observations, and this module exposes no mutation path at all.
--
-- Immutability (lock 5) is enforced at the storage layer, not just by the
-- service's discipline: the `observations_immutable` triggers reject
-- UPDATE, DELETE and TRUNCATE outright. A correction or a contradiction is
-- a NEW observation (lock 12 — contradictory evidence is retained).
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the composite
-- UNIQUE (id, tenant_id) is the tenant-consistent target for the lineage
-- edges of migrations/002-observation-lineage.sql.

CREATE TABLE observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  source_kind text NOT NULL CHECK (source_kind IN ('source', 'person', 'agent', 'system', 'external')),
  source_id text,
  source_label text,
  channel text NOT NULL,
  lineage_method text NOT NULL CHECK (lineage_method IN (
    'direct', 'connector', 'extraction', 'transformation', 'inference'
  )),
  extractor jsonb,
  visibility text NOT NULL DEFAULT 'tenant'
    CHECK (visibility IN ('tenant', 'workspace', 'principal')),
  visibility_workspace_id uuid,
  visibility_principal_id uuid,
  usage_tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence_value double precision NOT NULL
    CHECK (confidence_value >= 0 AND confidence_value <= 1),
  confidence_method text NOT NULL,
  confidence_basis text,
  CONSTRAINT observations_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT observations_source_traceable
    CHECK (source_id IS NOT NULL OR source_label IS NOT NULL),
  CONSTRAINT observations_visibility_shape CHECK (
    (visibility = 'tenant' AND visibility_workspace_id IS NULL AND visibility_principal_id IS NULL)
    OR (visibility = 'workspace' AND visibility_workspace_id IS NOT NULL AND visibility_principal_id IS NULL)
    OR (visibility = 'principal' AND visibility_principal_id IS NOT NULL AND visibility_workspace_id IS NULL)
  ),
  CONSTRAINT observations_usage_tags_shape
    CHECK (jsonb_typeof(usage_tags) = 'array'),
  CONSTRAINT observations_extractor_shape CHECK (
    extractor IS NULL
    OR (
      COALESCE(jsonb_typeof(extractor) = 'object', false)
      AND COALESCE(jsonb_typeof(extractor->'provider') = 'string', false)
      AND COALESCE(jsonb_typeof(extractor->'model') = 'string', false)
    )
  )
);

CREATE INDEX observations_tenant_recorded_idx ON observations (tenant_id, recorded_at DESC);
CREATE INDEX observations_tenant_kind_idx ON observations (tenant_id, kind);
CREATE INDEX observations_tenant_source_idx ON observations (tenant_id, source_kind, source_id);
CREATE INDEX observations_tenant_channel_idx ON observations (tenant_id, channel);

-- Storage-level immutability (lock 5): nothing may UPDATE, DELETE or
-- TRUNCATE an observation — not even a future module bypassing the service.
-- The message deliberately names no row id so the same function serves the
-- row-level and the statement-level trigger.

CREATE OR REPLACE FUNCTION observations_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'observations are immutable (architecture lock 5): % is forbidden on tenant %, table %',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER observations_immutable
  BEFORE UPDATE OR DELETE ON observations
  FOR EACH ROW EXECUTE FUNCTION observations_reject_mutation();

CREATE TRIGGER observations_immutable_truncate
  BEFORE TRUNCATE ON observations
  FOR EACH STATEMENT EXECUTE FUNCTION observations_reject_mutation();
