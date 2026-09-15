-- W010 · memory module — organizational knowledge entries.
--
-- Memory is the "remember" stage of the company intelligence loop
-- (ARCHITECTURE.md §2): a knowledge entry is the organization's retrievable
-- record of something it knows — a fact, procedure, decision, preference,
-- insight or context — ALWAYS backed by evidence: `evidence_observation_ids`
-- cites at least one observation (W004) that the service has verified to
-- exist in this tenant and be readable by the recording principal (lock 11).
-- The ids are stored as a sorted, deduplicated jsonb array; deliberately
-- NOT a foreign key — cross-module table references are not made here (the
-- same discipline the observations and freshness modules apply to their
-- provenance references).
--
-- An entry is an INDEX over evidence, not a proposition with truth status
-- (lock 10): there is no confidence, no verified/authoritative flag and no
-- promotion path. Truth-weighing is the epistemics module's (W007) job,
-- derived ON TOP of memory. Contradictory entries coexist untouched
-- (lock 12): recording a contradiction is a NEW entry, never an edit.
--
-- Append-only is enforced at the storage layer, not just by the service's
-- discipline: the `memory_knowledge_reject_mutation` triggers reject
-- UPDATE, DELETE and TRUNCATE outright — what the organization remembered
-- cannot be silently rewritten, keeping memory reconstructable (lock 37).
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; two tenants hold
-- fully independent organizational memories with no cross-tenant visibility.

CREATE TABLE memory_knowledge_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'fact', 'procedure', 'decision', 'preference', 'insight', 'context'
  )),
  title text NOT NULL,
  summary text NOT NULL,
  topics text[] NOT NULL,
  entities jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_observation_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_knowledge_topics_nonempty
    CHECK (cardinality(topics) >= 1),
  CONSTRAINT memory_knowledge_entities_shape
    CHECK (jsonb_typeof(entities) = 'array'),
  CONSTRAINT memory_knowledge_evidence_shape
    CHECK (jsonb_typeof(evidence_observation_ids) = 'array'),
  CONSTRAINT memory_knowledge_evidence_nonempty
    CHECK (jsonb_array_length(evidence_observation_ids) >= 1)
);

CREATE INDEX memory_knowledge_tenant_recorded_idx
  ON memory_knowledge_entries (tenant_id, recorded_at DESC);
CREATE INDEX memory_knowledge_tenant_kind_idx
  ON memory_knowledge_entries (tenant_id, kind);
CREATE INDEX memory_knowledge_topics_idx
  ON memory_knowledge_entries USING gin (topics);

-- Storage-level immutability (append-only organizational memory): nothing
-- may UPDATE, DELETE or TRUNCATE a knowledge entry — not even a future
-- module bypassing the service. The message deliberately names no row id so
-- the same function serves the row-level and the statement-level trigger.

CREATE OR REPLACE FUNCTION memory_knowledge_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'organizational memory is append-only (architecture locks 5/12/37): % is forbidden on tenant %, table %',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER memory_knowledge_immutable
  BEFORE UPDATE OR DELETE ON memory_knowledge_entries
  FOR EACH ROW EXECUTE FUNCTION memory_knowledge_reject_mutation();

CREATE TRIGGER memory_knowledge_immutable_truncate
  BEFORE TRUNCATE ON memory_knowledge_entries
  FOR EACH STATEMENT EXECUTE FUNCTION memory_knowledge_reject_mutation();
