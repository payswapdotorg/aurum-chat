-- W005 · world module — extensible relationship vocabulary + relationships.
--
-- The relationship half of the world model: directed, typed edges between
-- two entities of ONE tenant (person -member_of→ team, process
-- -requires→ capability, company -operates_in→ market).
--
--   * world_relationship_types — the tenant's CUSTOM relationship types
--     (built-in vocabulary lives in kinds.ts, code-defined).
--   * world_relationships     — the edges themselves, with free-form
--     attributes. Current working state: plain created/updated timestamps;
--     temporal versioning is W006's scope.
--
-- TENANT SCOPING — the acceptance of W005 ("verify relationships are
-- tenant-scoped") is enforced at the STORAGE layer, not just by service
-- discipline: both endpoint foreign keys reference the composite
-- (id, tenant_id) of world_entities, so a relationship row can only exist
-- when BOTH endpoints live in the relationship's OWN tenant. A
-- cross-tenant edge is unrepresentable in SQL, even for a caller that
-- bypasses the service entirely.
--
-- Endpoint deletion cascades: removing an entity removes its relationships
-- (a dangling edge has no meaning in a world model).

CREATE TABLE world_relationship_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  type text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT world_relationship_types_tenant_type_unique UNIQUE (tenant_id, type)
);

CREATE INDEX world_relationship_types_tenant_idx ON world_relationship_types (tenant_id);

CREATE TABLE world_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  type text NOT NULL,
  from_entity_id uuid NOT NULL,
  to_entity_id uuid NOT NULL,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT world_relationships_id_tenant_unique UNIQUE (id, tenant_id),
  -- one directed typed edge per subject/object pair within a tenant
  CONSTRAINT world_relationships_pair_type_unique
    UNIQUE (tenant_id, type, from_entity_id, to_entity_id),
  -- a relationship never loops back to its own subject
  CONSTRAINT world_relationships_not_self CHECK (from_entity_id <> to_entity_id),
  -- both endpoints must exist in the relationship's OWN tenant (ADR-0001)
  CONSTRAINT world_relationships_from_fk
    FOREIGN KEY (from_entity_id, tenant_id)
    REFERENCES world_entities (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT world_relationships_to_fk
    FOREIGN KEY (to_entity_id, tenant_id)
    REFERENCES world_entities (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT world_relationships_attributes_shape CHECK (jsonb_typeof(attributes) = 'object')
);

CREATE INDEX world_relationships_tenant_from_idx ON world_relationships (tenant_id, from_entity_id);
CREATE INDEX world_relationships_tenant_to_idx ON world_relationships (tenant_id, to_entity_id);
CREATE INDEX world_relationships_tenant_type_idx ON world_relationships (tenant_id, type);
