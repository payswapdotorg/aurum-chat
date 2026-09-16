-- W017 · capabilities module — the capability graph.
--
-- The work item: "Model capabilities supplied by employees, teams, agents,
-- software, suppliers and partners; identify gaps and available
-- alternatives."
--
-- ARCHITECTURE.md §13 continues the chain W016 started:
-- `process → capability → gap → acquisition option → authorization →
--  deployment → outcome`. This module owns the capability links of that
-- chain; W018 (automation) and W022 (agent recruitment) consume them
-- through the capabilities contract (`processes + capabilities →
-- automation`).
--
-- Six tables, the goals module's (W008) identity-plus-version discipline,
-- applied to the three record kinds of the graph:
--
--   capabilities / capability_versions
--   capability_supplies / capability_supply_versions
--   capability_requirements / capability_requirement_versions
--
-- Each identity table carries the tenant-unique graph key and the CURRENT
-- version pointer (its only mutable column); each version table carries the
-- append-only audit chain of full self-contained snapshots. A record change
-- appends the next version — history is never rewritten, so what Aurum
-- believed about the capability graph at any time stays reconstructable
-- (§24 decision evidence). PostgreSQL itself rejects UPDATE/DELETE/TRUNCATE
-- on the version tables and DELETE/TRUNCATE on the identity tables via
-- triggers (there is no update or delete operation on the contract either);
-- the derived layer (gaps, alternatives) is never persisted at all.
--
-- Graph keys (tenant-unique, immutable after registration):
--   capabilities            (tenant_id, name)
--   capability_supplies     (tenant_id, capability_id, supplier_kind, supplier_key)
--   capability_requirements (tenant_id, capability_id, source_kind, source_key)
-- supplier_key/source_key are the service-computed storage key of the party
-- (its id, else its label) — the supplier/source party itself is immutable
-- identity content, snapshotted on every version for self-containment.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the composite
-- UNIQUE (id, tenant_id) on each identity is the tenant-consistent target
-- for the version foreign keys, and the composite FKs make a cross-tenant
-- or dangling version unrepresentable in SQL.

-- ---------------------------------------------------------------------------
-- Capabilities
-- ---------------------------------------------------------------------------

CREATE TABLE capabilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT capabilities_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT capabilities_tenant_name_unique UNIQUE (tenant_id, name)
);

CREATE INDEX capabilities_tenant_idx ON capabilities (tenant_id);

CREATE TABLE capability_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  capability_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  change_kind text NOT NULL
    CHECK (change_kind IN ('created', 'revised', 'retired', 'reactivated')),
  -- always the identity's immutable name (snapshotted for self-containment)
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
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
  CONSTRAINT capability_versions_version_unique UNIQUE (tenant_id, capability_id, version),
  CONSTRAINT capability_versions_capability_fk
    FOREIGN KEY (capability_id, tenant_id) REFERENCES capabilities (id, tenant_id),
  CONSTRAINT capability_versions_actor_traceable CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL)
);

CREATE INDEX capability_versions_capability_idx
  ON capability_versions (tenant_id, capability_id, version);

-- ---------------------------------------------------------------------------
-- Supplies
-- ---------------------------------------------------------------------------

CREATE TABLE capability_supplies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  capability_id uuid NOT NULL,
  supplier_kind text NOT NULL
    CHECK (supplier_kind IN ('employee', 'team', 'agent', 'software', 'supplier', 'partner')),
  supplier_key text NOT NULL CHECK (char_length(supplier_key) BETWEEN 1 AND 200),
  supplier_id text CHECK (supplier_id IS NULL OR char_length(supplier_id) BETWEEN 1 AND 200),
  supplier_label text CHECK (supplier_label IS NULL OR char_length(supplier_label) BETWEEN 1 AND 200),
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT capability_supplies_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT capability_supplies_supplier_unique
    UNIQUE (tenant_id, capability_id, supplier_kind, supplier_key),
  CONSTRAINT capability_supplies_capability_fk
    FOREIGN KEY (capability_id, tenant_id) REFERENCES capabilities (id, tenant_id),
  CONSTRAINT capability_supplies_supplier_traceable
    CHECK (supplier_id IS NOT NULL OR supplier_label IS NOT NULL)
);

CREATE INDEX capability_supplies_tenant_idx ON capability_supplies (tenant_id);
CREATE INDEX capability_supplies_capability_idx
  ON capability_supplies (tenant_id, capability_id);
CREATE INDEX capability_supplies_supplier_idx
  ON capability_supplies (tenant_id, supplier_kind, supplier_key);

CREATE TABLE capability_supply_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  supply_id uuid NOT NULL,
  capability_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  change_kind text NOT NULL
    CHECK (change_kind IN ('asserted', 'revised', 'retired', 'reactivated')),
  -- immutable identity content, snapshotted for self-containment
  supplier_kind text NOT NULL
    CHECK (supplier_kind IN ('employee', 'team', 'agent', 'software', 'supplier', 'partner')),
  supplier_key text NOT NULL CHECK (char_length(supplier_key) BETWEEN 1 AND 200),
  supplier_id text CHECK (supplier_id IS NULL OR char_length(supplier_id) BETWEEN 1 AND 200),
  supplier_label text CHECK (supplier_label IS NULL OR char_length(supplier_label) BETWEEN 1 AND 200),
  -- content
  level double precision NOT NULL CHECK (level >= 0 AND level <= 1),
  capacity double precision CHECK (capacity IS NULL OR (capacity >= 0 AND capacity <= 1000000000)),
  status text NOT NULL CHECK (status IN ('active', 'retired')),
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
  CONSTRAINT capability_supply_versions_version_unique UNIQUE (tenant_id, supply_id, version),
  CONSTRAINT capability_supply_versions_supply_fk
    FOREIGN KEY (supply_id, tenant_id) REFERENCES capability_supplies (id, tenant_id),
  CONSTRAINT capability_supply_versions_capability_fk
    FOREIGN KEY (capability_id, tenant_id) REFERENCES capabilities (id, tenant_id),
  CONSTRAINT capability_supply_versions_actor_traceable
    CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL)
);

CREATE INDEX capability_supply_versions_supply_idx
  ON capability_supply_versions (tenant_id, supply_id, version);
CREATE INDEX capability_supply_versions_capability_idx
  ON capability_supply_versions (tenant_id, capability_id);

-- ---------------------------------------------------------------------------
-- Requirements
-- ---------------------------------------------------------------------------

CREATE TABLE capability_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  capability_id uuid NOT NULL,
  source_kind text NOT NULL
    CHECK (source_kind IN ('goal', 'process', 'project', 'opportunity', 'manual')),
  source_key text NOT NULL CHECK (char_length(source_key) BETWEEN 1 AND 200),
  source_id text CHECK (source_id IS NULL OR char_length(source_id) BETWEEN 1 AND 200),
  source_label text CHECK (source_label IS NULL OR char_length(source_label) BETWEEN 1 AND 200),
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT capability_requirements_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT capability_requirements_source_unique
    UNIQUE (tenant_id, capability_id, source_kind, source_key),
  CONSTRAINT capability_requirements_capability_fk
    FOREIGN KEY (capability_id, tenant_id) REFERENCES capabilities (id, tenant_id),
  CONSTRAINT capability_requirements_source_traceable
    CHECK (source_id IS NOT NULL OR source_label IS NOT NULL)
);

CREATE INDEX capability_requirements_tenant_idx ON capability_requirements (tenant_id);
CREATE INDEX capability_requirements_capability_idx
  ON capability_requirements (tenant_id, capability_id);
CREATE INDEX capability_requirements_source_idx
  ON capability_requirements (tenant_id, source_kind, source_key);

CREATE TABLE capability_requirement_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  requirement_id uuid NOT NULL,
  capability_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  change_kind text NOT NULL
    CHECK (change_kind IN ('declared', 'revised', 'retired', 'reactivated')),
  -- immutable identity content, snapshotted for self-containment
  source_kind text NOT NULL
    CHECK (source_kind IN ('goal', 'process', 'project', 'opportunity', 'manual')),
  source_key text NOT NULL CHECK (char_length(source_key) BETWEEN 1 AND 200),
  source_id text CHECK (source_id IS NULL OR char_length(source_id) BETWEEN 1 AND 200),
  source_label text CHECK (source_label IS NULL OR char_length(source_label) BETWEEN 1 AND 200),
  -- content
  level double precision NOT NULL CHECK (level >= 0 AND level <= 1),
  capacity double precision CHECK (capacity IS NULL OR (capacity >= 0 AND capacity <= 1000000000)),
  status text NOT NULL CHECK (status IN ('active', 'retired')),
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
  CONSTRAINT capability_requirement_versions_version_unique
    UNIQUE (tenant_id, requirement_id, version),
  CONSTRAINT capability_requirement_versions_requirement_fk
    FOREIGN KEY (requirement_id, tenant_id) REFERENCES capability_requirements (id, tenant_id),
  CONSTRAINT capability_requirement_versions_capability_fk
    FOREIGN KEY (capability_id, tenant_id) REFERENCES capabilities (id, tenant_id),
  CONSTRAINT capability_requirement_versions_actor_traceable
    CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL)
);

CREATE INDEX capability_requirement_versions_requirement_idx
  ON capability_requirement_versions (tenant_id, requirement_id, version);
CREATE INDEX capability_requirement_versions_capability_idx
  ON capability_requirement_versions (tenant_id, capability_id);

-- ---------------------------------------------------------------------------
-- Append-only enforcement
-- ---------------------------------------------------------------------------

-- Storage-level audit guarantee: the capability graph's history is
-- append-only. Nothing may UPDATE, DELETE or TRUNCATE the version tables —
-- not even a future module bypassing the service. The identity tables may
-- advance their version pointer (UPDATE) — that is how versioning moves —
-- but their rows are never erased. The messages deliberately name no row id
-- so the same function serves the row-level and the statement-level
-- triggers (the goals/processes discipline).

CREATE OR REPLACE FUNCTION capability_versions_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'capability versions are append-only (W017 capability audit trail): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER capability_versions_immutable
  BEFORE UPDATE OR DELETE ON capability_versions
  FOR EACH ROW EXECUTE FUNCTION capability_versions_reject_mutation();

CREATE TRIGGER capability_versions_immutable_truncate
  BEFORE TRUNCATE ON capability_versions
  FOR EACH STATEMENT EXECUTE FUNCTION capability_versions_reject_mutation();

CREATE OR REPLACE FUNCTION capability_supply_versions_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'capability supply versions are append-only (W017 capability audit trail): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER capability_supply_versions_immutable
  BEFORE UPDATE OR DELETE ON capability_supply_versions
  FOR EACH ROW EXECUTE FUNCTION capability_supply_versions_reject_mutation();

CREATE TRIGGER capability_supply_versions_immutable_truncate
  BEFORE TRUNCATE ON capability_supply_versions
  FOR EACH STATEMENT EXECUTE FUNCTION capability_supply_versions_reject_mutation();

CREATE OR REPLACE FUNCTION capability_requirement_versions_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'capability requirement versions are append-only (W017 capability audit trail): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER capability_requirement_versions_immutable
  BEFORE UPDATE OR DELETE ON capability_requirement_versions
  FOR EACH ROW EXECUTE FUNCTION capability_requirement_versions_reject_mutation();

CREATE TRIGGER capability_requirement_versions_immutable_truncate
  BEFORE TRUNCATE ON capability_requirement_versions
  FOR EACH STATEMENT EXECUTE FUNCTION capability_requirement_versions_reject_mutation();

CREATE OR REPLACE FUNCTION capabilities_reject_erasure() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'capability graph records cannot be erased (W017): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER capabilities_immutable_delete
  BEFORE DELETE ON capabilities
  FOR EACH ROW EXECUTE FUNCTION capabilities_reject_erasure();

CREATE TRIGGER capabilities_immutable_truncate
  BEFORE TRUNCATE ON capabilities
  FOR EACH STATEMENT EXECUTE FUNCTION capabilities_reject_erasure();

CREATE TRIGGER capability_supplies_immutable_delete
  BEFORE DELETE ON capability_supplies
  FOR EACH ROW EXECUTE FUNCTION capabilities_reject_erasure();

CREATE TRIGGER capability_supplies_immutable_truncate
  BEFORE TRUNCATE ON capability_supplies
  FOR EACH STATEMENT EXECUTE FUNCTION capabilities_reject_erasure();

CREATE TRIGGER capability_requirements_immutable_delete
  BEFORE DELETE ON capability_requirements
  FOR EACH ROW EXECUTE FUNCTION capabilities_reject_erasure();

CREATE TRIGGER capability_requirements_immutable_truncate
  BEFORE TRUNCATE ON capability_requirements
  FOR EACH STATEMENT EXECUTE FUNCTION capabilities_reject_erasure();
