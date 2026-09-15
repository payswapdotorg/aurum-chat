-- W010 · memory module — transactive memory entries.
--
-- Transactive memory (ARCHITECTURE.md §7): "who knows, owns, decides, has
-- experience with, influences, or can perform a capability." One row is one
-- evidence-backed assertion of such a relation between an organizational
-- actor and a subject:
--
--   * actor     — the person / agent / team the assertion is about. An
--                 opaque forward reference (id owned by the people module
--                 W002, the agents module W021+ or the world module's team
--                 entities W005; a label when no registered record exists)
--                 — memory's only declared upstream is the observations
--                 module (MODULE-DEPENDENCY-MAP.md:
--                 `observations → memory → epistemics`), so no cross-module
--                 foreign keys are made; traceability (id OR label) is
--                 enforced instead.
--   * relation  — the ARCHITECTURE.md §7 vocabulary, verbatim.
--   * subject   — a human-readable label plus at least one topic key
--                 (retrievability) and optional opaque entity references.
--   * evidence  — `evidence_observation_ids` cites at least one observation
--                 (W004) that the service verified to exist in this tenant
--                 and be readable by the recording principal (lock 11).
--                 Sorted, deduplicated jsonb array; NOT a foreign key.
--
-- Assertions are append-only history: an actor ceasing to know/own/perform
-- something is expressed by NEW evidence and NEW entries (or by the
-- freshness module classifying the supporting evidence stale — W006), never
-- by rewriting what was recorded. The triggers below enforce this at the
-- storage level: UPDATE, DELETE and TRUNCATE are rejected outright.
--
-- Downstream consumers: the Knowledge Acquisition Planner (W012) asks who
-- to approach; knowledge source ranking (W052) orders these entries. Both
-- consume the contract, never these tables.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; two tenants hold
-- fully independent transactive memories with no cross-tenant visibility.

CREATE TABLE memory_transactive_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('person', 'agent', 'team')),
  actor_id uuid,
  actor_label text,
  relation text NOT NULL CHECK (relation IN (
    'knows', 'owns', 'decides', 'has_experience_with', 'influences', 'can_perform'
  )),
  subject_label text NOT NULL,
  topics text[] NOT NULL,
  entities jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_observation_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_transactive_actor_traceable
    CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL),
  CONSTRAINT memory_transactive_topics_nonempty
    CHECK (cardinality(topics) >= 1),
  CONSTRAINT memory_transactive_entities_shape
    CHECK (jsonb_typeof(entities) = 'array'),
  CONSTRAINT memory_transactive_evidence_shape
    CHECK (jsonb_typeof(evidence_observation_ids) = 'array'),
  CONSTRAINT memory_transactive_evidence_nonempty
    CHECK (jsonb_array_length(evidence_observation_ids) >= 1)
);

CREATE INDEX memory_transactive_tenant_recorded_idx
  ON memory_transactive_entries (tenant_id, recorded_at DESC);
CREATE INDEX memory_transactive_tenant_actor_idx
  ON memory_transactive_entries (tenant_id, actor_kind, actor_id);
CREATE INDEX memory_transactive_tenant_relation_idx
  ON memory_transactive_entries (tenant_id, relation);
CREATE INDEX memory_transactive_topics_idx
  ON memory_transactive_entries USING gin (topics);

-- Storage-level immutability (append-only transactive memory): nothing may
-- UPDATE, DELETE or TRUNCATE a transactive entry — not even a future module
-- bypassing the service.

CREATE OR REPLACE FUNCTION memory_transactive_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'transactive memory is append-only (architecture locks 5/12/37): % is forbidden on tenant %, table %',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER memory_transactive_immutable
  BEFORE UPDATE OR DELETE ON memory_transactive_entries
  FOR EACH ROW EXECUTE FUNCTION memory_transactive_reject_mutation();

CREATE TRIGGER memory_transactive_immutable_truncate
  BEFORE TRUNCATE ON memory_transactive_entries
  FOR EACH STATEMENT EXECUTE FUNCTION memory_transactive_reject_mutation();
