-- W125 · coverage module — the company coverage registry and measurement
-- model.
--
-- COMPANY-COVERAGE-ARCHITECTURE.md (approved additive architecture):
-- §3 defines the object model (CoverageSurface / CoverageSource /
-- CoverageClaim / CoverageGap / CoverageSnapshot), §4 the nine coverage
-- dimensions ("Never compress all of them into one percentage"), §5 the
-- provider-neutral state vocabulary. The W124 reconciliation froze
-- src/modules/coverage/{types,contract}.ts as the shared TL contract;
-- the CHECK constraints below and the module's validation.ts mirror the
-- frozen vocabularies — one list, two layers of defense.
--
-- §2 discipline ("coverage is a derived, tenant-scoped view over
-- existing Aurum state. It MUST NOT become another organizational
-- database"): these tables hold provider-neutral vocabulary, opaque
-- registry references and derived statements with their observation
-- basis — no domain object is copied, no credential-bearing column
-- exists (§13: "Credentials never enter coverage state"). Claims may
-- only address registered surfaces and sources (service-layer guard).
--
-- Cross-module references (sources) are deliberately NOT foreign keys —
-- the codebase discipline (audit's subject precedent): a source is an
-- opaque forward reference owned by its registry, recorded as
-- (registry, ref).
--
-- Append-only discipline (the audit module's precedent, applied to
-- derived coverage history): coverage_claims, coverage_snapshots and
-- coverage_gaps reject UPDATE/DELETE/TRUNCATE outright — claims are the
-- evaluation history (the latest per surface+source is the current
-- statement; correction is appending a newer claim), and §3 requires "a
-- later snapshot never rewrites an earlier one".
--
-- Tenant scoping (ADR-0001): every table carries tenant_id; two tenants
-- hold fully independent coverage state, and cross-tenant access is
-- indistinguishable from missing records at the service layer.

-- §3 CoverageSurface — a logical area of company reality, provider-neutral.
CREATE TABLE coverage_surfaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  key text NOT NULL
    CHECK (key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  label text NOT NULL
    CHECK (char_length(label) >= 1 AND char_length(label) <= 128),
  description text
    CHECK (description IS NULL OR char_length(description) <= 1024),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

CREATE INDEX coverage_surfaces_tenant_key_idx ON coverage_surfaces (tenant_id, key);

-- §3 CoverageSource — an authorized source of observations: an opaque
-- reference into the real source/channel/meeting/integration registries.
CREATE TABLE coverage_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  registry text NOT NULL CHECK (registry IN ('source', 'channel', 'meeting', 'integration')),
  ref text NOT NULL
    CHECK (char_length(ref) >= 1 AND char_length(ref) <= 256),
  label text CHECK (label IS NULL OR char_length(label) <= 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, registry, ref)
);

CREATE INDEX coverage_sources_tenant_registry_idx ON coverage_sources (tenant_id, registry, ref);

-- §3 CoverageClaim — an append-only derived statement about observability.
CREATE TABLE coverage_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  surface_key text NOT NULL CHECK (surface_key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  source_registry text NOT NULL CHECK (source_registry IN ('source', 'channel', 'meeting', 'integration')),
  source_ref text NOT NULL CHECK (char_length(source_ref) >= 1 AND char_length(source_ref) <= 256),
  -- What the claim was derived from (evidence/connection basis).
  basis_kind text NOT NULL CHECK (char_length(basis_kind) >= 1 AND char_length(basis_kind) <= 64),
  basis_ids jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(basis_ids) = 'array'),
  last_observed_at timestamptz,
  -- §5 state vocabulary (frozen).
  state text NOT NULL CHECK (state IN (
    'COVERED', 'PARTIAL', 'STALE', 'UNAVAILABLE', 'UNAUTHORIZED', 'EXCLUDED', 'UNKNOWN'
  )),
  last_usable_at timestamptz,
  policy_max_age_seconds integer
    CHECK (policy_max_age_seconds IS NULL OR policy_max_age_seconds > 0),
  confidence_value numeric(4, 3) NOT NULL
    CHECK (confidence_value >= 0 AND confidence_value <= 1),
  reason text NOT NULL
    CHECK (char_length(reason) >= 1 AND char_length(reason) <= 2048),
  evaluated_by text NOT NULL CHECK (char_length(evaluated_by) >= 1),
  evaluated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX coverage_claims_tenant_surface_idx
  ON coverage_claims (tenant_id, surface_key, evaluated_at DESC);
CREATE INDEX coverage_claims_tenant_state_idx ON coverage_claims (tenant_id, state);
CREATE INDEX coverage_claims_tenant_source_idx
  ON coverage_claims (tenant_id, source_registry, source_ref);

-- §3 CoverageSnapshot — the immutable-at-evaluation-time summary. The
-- document carries the per-surface rollups, the nine §4 dimensions
-- measured separately, the §5 policy restrictions and the detected gaps.
CREATE TABLE coverage_snapshots (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  evaluated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX coverage_snapshots_tenant_evaluated_idx
  ON coverage_snapshots (tenant_id, evaluated_at DESC);

-- §3 CoverageGap — a material missing/stale portion of observability: an
-- attention input, not a dashboard warning. attached to the snapshot
-- that detected it; affected_goal_ids is the W127 extension point.
CREATE TABLE coverage_gaps (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  surface_key text NOT NULL CHECK (surface_key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  -- §4 dimension vocabulary (frozen).
  dimension text NOT NULL CHECK (dimension IN (
    'breadth', 'depth', 'freshness', 'identity-continuity',
    'provenance-completeness', 'temporal-completeness',
    'outcome-completeness', 'permission-completeness', 'goal-sufficiency'
  )),
  state text NOT NULL CHECK (state IN (
    'COVERED', 'PARTIAL', 'STALE', 'UNAVAILABLE', 'UNAUTHORIZED', 'EXCLUDED', 'UNKNOWN'
  )),
  reason text NOT NULL
    CHECK (char_length(reason) >= 1 AND char_length(reason) <= 2048),
  material boolean NOT NULL,
  affected_goal_ids jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(affected_goal_ids) = 'array'),
  detected_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX coverage_gaps_tenant_snapshot_idx ON coverage_gaps (tenant_id, snapshot_id);
CREATE INDEX coverage_gaps_tenant_surface_idx ON coverage_gaps (tenant_id, surface_key);
CREATE INDEX coverage_gaps_tenant_material_idx ON coverage_gaps (tenant_id, material);

-- Append-only discipline for derived coverage history (§3: "A later
-- snapshot never rewrites an earlier one"; claims are evaluation
-- history — correction is appending a newer claim).
CREATE OR REPLACE FUNCTION coverage_records_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'coverage history is append-only (W125 coverage): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER coverage_claims_immutable
  BEFORE UPDATE OR DELETE ON coverage_claims
  FOR EACH ROW EXECUTE FUNCTION coverage_records_reject_mutation();

CREATE TRIGGER coverage_claims_immutable_truncate
  BEFORE TRUNCATE ON coverage_claims
  FOR EACH STATEMENT EXECUTE FUNCTION coverage_records_reject_mutation();

CREATE TRIGGER coverage_snapshots_immutable
  BEFORE UPDATE OR DELETE ON coverage_snapshots
  FOR EACH ROW EXECUTE FUNCTION coverage_records_reject_mutation();

CREATE TRIGGER coverage_snapshots_immutable_truncate
  BEFORE TRUNCATE ON coverage_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION coverage_records_reject_mutation();

CREATE TRIGGER coverage_gaps_immutable
  BEFORE UPDATE OR DELETE ON coverage_gaps
  FOR EACH ROW EXECUTE FUNCTION coverage_records_reject_mutation();

CREATE TRIGGER coverage_gaps_immutable_truncate
  BEFORE TRUNCATE ON coverage_gaps
  FOR EACH STATEMENT EXECUTE FUNCTION coverage_records_reject_mutation();
