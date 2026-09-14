-- W005 · world module — extensible entity vocabulary + entities.
--
-- The world model represents internal and external reality through
-- extensible entities and relationships (ARCHITECTURE.md §4). This
-- migration creates the entity half:
--
--   * world_entity_kinds — the tenant's CUSTOM entity kinds (the
--     "extensible" of the work item). The frozen core vocabulary
--     (person, employee, team, …, external_identity — ARCHITECTURE.md §4)
--     is code-defined in kinds.ts and deliberately NOT stored here; custom
--     kinds are tenant-scoped rows, so two tenants may extend their world
--     vocabularies completely independently.
--   * world_entities     — the tenant's current working picture of one
--     thing in the world (company, person, team, process, capability,
--     market, …). This is the UNDERSTANDING side of "reality is immutable;
--     understanding is mutable" — entities are mutable current state;
--     immutable evidence lives in observations (W004), and temporal
--     versioning of this state is W006's scope.
--
-- Entities carry an optional external reference (external_module,
-- external_id): an opaque pointer to the authoritative record of the module
-- that owns the underlying thing (e.g. people.persons) — the same
-- provenance-reference approach as the observations module's source refs.
-- UNIQUE (tenant_id, external_module, external_id) keeps the world model
-- from forking its picture of one authoritative record, while the same
-- (module, id) may exist in every tenant independently (tenant-scoped).
--
-- `category` is denormalized from the effective kind vocabulary (built-in
-- registry or the custom-kind registration row) so category-filtered
-- listing never needs a join; the CHECK keeps it honest at the storage
-- layer.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the composite
-- UNIQUE (id, tenant_id) is the tenant-consistent FK target for
-- world_relationships (migrations/002).

CREATE TABLE world_entity_kinds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  kind text NOT NULL,
  category text NOT NULL CHECK (category IN (
    'company', 'people', 'process', 'capability', 'environment', 'direction'
  )),
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT world_entity_kinds_tenant_kind_unique UNIQUE (tenant_id, kind)
);

CREATE INDEX world_entity_kinds_tenant_idx ON world_entity_kinds (tenant_id);

CREATE TABLE world_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  kind text NOT NULL,
  category text NOT NULL CHECK (category IN (
    'company', 'people', 'process', 'capability', 'environment', 'direction'
  )),
  name text NOT NULL,
  description text,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  external_module text,
  external_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT world_entities_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT world_entities_external_ref_shape CHECK (
    (external_module IS NULL AND external_id IS NULL)
    OR (external_module IS NOT NULL AND external_id IS NOT NULL)
  ),
  CONSTRAINT world_entities_external_ref_unique UNIQUE (tenant_id, external_module, external_id),
  CONSTRAINT world_entities_attributes_shape CHECK (jsonb_typeof(attributes) = 'object')
);

CREATE INDEX world_entities_tenant_kind_idx ON world_entities (tenant_id, kind);
CREATE INDEX world_entities_tenant_category_idx ON world_entities (tenant_id, category);
