-- W020 · suppliers module — supplier intelligence.
--
-- The work item: "Score suppliers/subcontractors on price, quality,
-- reliability, capacity, compliance, geography, switching cost and
-- alternatives."
--
-- Four tables, the goals module's (W008) identity-plus-version discipline,
-- applied to the two record kinds of this module (the capabilities module's
-- W017 precedent):
--
--   suppliers / supplier_versions
--   supplier_scorecards / supplier_scorecard_versions
--
-- Each identity table carries the tenant-unique graph key and the CURRENT
-- version pointer (its only mutable column); each version table carries
-- the append-only audit chain of full self-contained snapshots. A record
-- change appends the next version — history is never rewritten, so what
-- Aurum believed about a supplier at any time stays reconstructable (§24
-- decision evidence). PostgreSQL itself rejects UPDATE/DELETE/TRUNCATE on
-- the version tables and DELETE/TRUNCATE on the identity tables via
-- triggers (there is no update or delete operation on the contract either);
-- the derived layer (overall scores, rankings, alternatives analysis) is
-- never persisted at all.
--
-- Graph keys (tenant-unique, immutable after registration):
--   suppliers            (tenant_id, name)            — one supplier registry entry per name
--   supplier_scorecards  (tenant_id, supplier_id)     — ONE assessment chain per supplier
-- The supplier's kind (supplier | subcontractor) is immutable identity
-- content, snapshotted on every version for self-containment.
--
-- The eight score columns are the work item's verbatim dimension list,
-- each in [0, 1] (1 = most favorable) or NULL (unscored — missing data is
-- never a grade); every version must score at least one dimension.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the composite
-- UNIQUE (id, tenant_id) on each identity is the tenant-consistent target
-- for the version foreign keys, and the composite FKs make a cross-tenant
-- or dangling version unrepresentable in SQL.

-- ---------------------------------------------------------------------------
-- Suppliers
-- ---------------------------------------------------------------------------

CREATE TABLE suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT suppliers_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT suppliers_tenant_name_unique UNIQUE (tenant_id, name)
);

CREATE INDEX suppliers_tenant_idx ON suppliers (tenant_id);

CREATE TABLE supplier_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  change_kind text NOT NULL
    CHECK (change_kind IN ('created', 'revised', 'retired', 'reactivated')),
  -- immutable identity content (snapshotted for self-containment)
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  supplier_kind text NOT NULL CHECK (supplier_kind IN ('supplier', 'subcontractor')),
  -- content
  description text
    CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 2000),
  world_entity_id uuid,
  status text NOT NULL CHECK (status IN ('active', 'retired')),
  -- audit quartet: who / when / what / why
  actor_kind text NOT NULL
    CHECK (actor_kind IN ('person', 'team', 'agent', 'system', 'external')),
  actor_id text,
  actor_label text,
  changed_by_principal text NOT NULL,
  rationale text
    CHECK (rationale IS NULL OR char_length(rationale) BETWEEN 1 AND 2000),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_versions_version_unique UNIQUE (tenant_id, supplier_id, version),
  CONSTRAINT supplier_versions_supplier_fk
    FOREIGN KEY (supplier_id, tenant_id) REFERENCES suppliers (id, tenant_id),
  CONSTRAINT supplier_versions_actor_traceable CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL)
);

CREATE INDEX supplier_versions_supplier_idx ON supplier_versions (tenant_id, supplier_id, version);

-- ---------------------------------------------------------------------------
-- Scorecards
-- ---------------------------------------------------------------------------

CREATE TABLE supplier_scorecards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_scorecards_id_tenant_unique UNIQUE (id, tenant_id),
  -- ONE assessment chain per supplier (the graph key)
  CONSTRAINT supplier_scorecards_supplier_unique UNIQUE (tenant_id, supplier_id),
  CONSTRAINT supplier_scorecards_supplier_fk
    FOREIGN KEY (supplier_id, tenant_id) REFERENCES suppliers (id, tenant_id)
);

CREATE INDEX supplier_scorecards_tenant_idx ON supplier_scorecards (tenant_id);
CREATE INDEX supplier_scorecards_supplier_idx ON supplier_scorecards (tenant_id, supplier_id);

CREATE TABLE supplier_scorecard_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  scorecard_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  change_kind text NOT NULL CHECK (change_kind IN ('assessed', 'reassessed')),
  -- the eight dimensions the work item names verbatim; [0, 1] or NULL (unscored)
  price_score double precision CHECK (price_score IS NULL OR (price_score >= 0 AND price_score <= 1)),
  quality_score double precision CHECK (quality_score IS NULL OR (quality_score >= 0 AND quality_score <= 1)),
  reliability_score double precision CHECK (reliability_score IS NULL OR (reliability_score >= 0 AND reliability_score <= 1)),
  capacity_score double precision CHECK (capacity_score IS NULL OR (capacity_score >= 0 AND capacity_score <= 1)),
  compliance_score double precision CHECK (compliance_score IS NULL OR (compliance_score >= 0 AND compliance_score <= 1)),
  geography_score double precision CHECK (geography_score IS NULL OR (geography_score >= 0 AND geography_score <= 1)),
  switching_cost_score double precision CHECK (switching_cost_score IS NULL OR (switching_cost_score >= 0 AND switching_cost_score <= 1)),
  alternatives_score double precision CHECK (alternatives_score IS NULL OR (alternatives_score >= 0 AND alternatives_score <= 1)),
  -- a snapshot that scores nothing is meaningless
  CONSTRAINT supplier_scorecard_versions_at_least_one_score CHECK (
    price_score IS NOT NULL OR quality_score IS NOT NULL OR reliability_score IS NOT NULL
    OR capacity_score IS NOT NULL OR compliance_score IS NOT NULL OR geography_score IS NOT NULL
    OR switching_cost_score IS NOT NULL OR alternatives_score IS NOT NULL
  ),
  evidence_observation_ids jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence_observation_ids) = 'array'),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
  -- audit quartet
  actor_kind text NOT NULL
    CHECK (actor_kind IN ('person', 'team', 'agent', 'system', 'external')),
  actor_id text,
  actor_label text,
  changed_by_principal text NOT NULL,
  rationale text
    CHECK (rationale IS NULL OR char_length(rationale) BETWEEN 1 AND 2000),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_scorecard_versions_version_unique UNIQUE (tenant_id, scorecard_id, version),
  CONSTRAINT supplier_scorecard_versions_scorecard_fk
    FOREIGN KEY (scorecard_id, tenant_id) REFERENCES supplier_scorecards (id, tenant_id),
  CONSTRAINT supplier_scorecard_versions_supplier_fk
    FOREIGN KEY (supplier_id, tenant_id) REFERENCES suppliers (id, tenant_id),
  CONSTRAINT supplier_scorecard_versions_actor_traceable CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL)
);

CREATE INDEX supplier_scorecard_versions_scorecard_idx
  ON supplier_scorecard_versions (tenant_id, scorecard_id, version);
CREATE INDEX supplier_scorecard_versions_supplier_idx
  ON supplier_scorecard_versions (tenant_id, supplier_id);

-- ---------------------------------------------------------------------------
-- Append-only enforcement
-- ---------------------------------------------------------------------------

-- Storage-level audit guarantee: the supplier registry's history is
-- append-only. Nothing may UPDATE, DELETE or TRUNCATE the version tables —
-- not even a future module bypassing the service. The identity tables may
-- advance their version pointer (UPDATE) — that is how versioning moves —
-- but their rows are never erased. The messages deliberately name no row id
-- so the same function serves the row-level and the statement-level
-- triggers (the goals/processes/capabilities discipline).

CREATE OR REPLACE FUNCTION supplier_versions_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'supplier versions are append-only (W020 supplier audit trail): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER supplier_versions_immutable
  BEFORE UPDATE OR DELETE ON supplier_versions
  FOR EACH ROW EXECUTE FUNCTION supplier_versions_reject_mutation();

CREATE TRIGGER supplier_versions_immutable_truncate
  BEFORE TRUNCATE ON supplier_versions
  FOR EACH STATEMENT EXECUTE FUNCTION supplier_versions_reject_mutation();

CREATE OR REPLACE FUNCTION supplier_scorecard_versions_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'supplier scorecard versions are append-only (W020 supplier audit trail): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER supplier_scorecard_versions_immutable
  BEFORE UPDATE OR DELETE ON supplier_scorecard_versions
  FOR EACH ROW EXECUTE FUNCTION supplier_scorecard_versions_reject_mutation();

CREATE TRIGGER supplier_scorecard_versions_immutable_truncate
  BEFORE TRUNCATE ON supplier_scorecard_versions
  FOR EACH STATEMENT EXECUTE FUNCTION supplier_scorecard_versions_reject_mutation();

CREATE OR REPLACE FUNCTION suppliers_reject_erasure() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'supplier registry records cannot be erased (W020): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER suppliers_immutable_delete
  BEFORE DELETE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION suppliers_reject_erasure();

CREATE TRIGGER suppliers_immutable_truncate
  BEFORE TRUNCATE ON suppliers
  FOR EACH STATEMENT EXECUTE FUNCTION suppliers_reject_erasure();

CREATE TRIGGER supplier_scorecards_immutable_delete
  BEFORE DELETE ON supplier_scorecards
  FOR EACH ROW EXECUTE FUNCTION suppliers_reject_erasure();

CREATE TRIGGER supplier_scorecards_immutable_truncate
  BEFORE TRUNCATE ON supplier_scorecards
  FOR EACH STATEMENT EXECUTE FUNCTION suppliers_reject_erasure();
