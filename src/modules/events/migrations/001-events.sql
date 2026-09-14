-- W003 · events module — the immutable, versioned domain event envelope.
--
-- An event is an immutable historical occurrence (ARCHITECTURE.md §4,
-- lock 5): something that happened in the tenant's world. This table is
-- the append-only event log downstream modules (process intelligence
-- W016, audit, the API surface) derive from — never a place to edit
-- history.
--
-- The envelope is VERSIONED on two axes (work item W003):
--   - envelope_version — the version of the envelope SHAPE itself,
--     stamped by the module's service (callers cannot choose it);
--   - type_version — the version of the event type's payload contract,
--     chosen by the emitting module.
--
-- Provenance fields: tenant_id (lock 3 — every business datum is
-- tenant-scoped), actor_* (who/what caused the occurrence) and source_*
-- (the surface the event entered Aurum through). Both actor and source
-- must be traceable (id or label) — the same rule the observations module
-- applies to evidence provenance.
--
-- correlation_id / causation_id (ARCHITECTURE.md §25 — executions carry
-- correlation and causation identities): the correlation id groups the
-- events of one logical flow and is ALWAYS present (the service resolves
-- it: explicit, inherited from the cause, or the event's own id for a
-- root); the causation id names the event that directly caused this one
-- and is tenant-consistent by foreign key — history cannot claim another
-- tenant's event as its cause, even if the service layer were bypassed.
--
-- Ordering metadata (work item acceptance): sequence is the per-tenant,
-- strictly increasing replay order, allocated from event_sequences
-- (migrations/002-event-sequences.sql) inside the append transaction and
-- unique within the tenant. occurred_at is the acting system's clock;
-- recorded_at is Aurum's commit time (service-controlled).
--
-- Idempotency (work item acceptance): (tenant_id, idempotency_key) is
-- UNIQUE — an emitter retrying with the same key replays the original
-- event instead of duplicating history. NULL keys never collide (SQL
-- UNIQUE treats NULLs as distinct).

CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  envelope_version int NOT NULL DEFAULT 1 CHECK (envelope_version >= 1),
  type text NOT NULL CHECK (type ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  type_version int NOT NULL DEFAULT 1 CHECK (type_version >= 1),
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  sequence bigint NOT NULL CHECK (sequence >= 1),
  actor_kind text NOT NULL CHECK (actor_kind IN ('person', 'agent', 'system', 'external', 'source')),
  actor_id text,
  actor_label text,
  source_kind text NOT NULL CHECK (source_kind IN ('source', 'channel', 'system', 'api', 'external')),
  source_id text,
  source_label text,
  correlation_id uuid NOT NULL,
  causation_id uuid,
  idempotency_key text,
  CONSTRAINT events_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT events_tenant_sequence_unique UNIQUE (tenant_id, sequence),
  CONSTRAINT events_idempotency_tenant_unique UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT events_actor_traceable CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL),
  CONSTRAINT events_source_traceable CHECK (source_id IS NOT NULL OR source_label IS NOT NULL),
  CONSTRAINT events_causation_tenant_fk
    FOREIGN KEY (causation_id, tenant_id) REFERENCES events (id, tenant_id)
);

CREATE INDEX events_tenant_type_idx ON events (tenant_id, type, type_version);
CREATE INDEX events_tenant_correlation_idx ON events (tenant_id, correlation_id);
CREATE INDEX events_tenant_causation_idx ON events (tenant_id, causation_id);
CREATE INDEX events_tenant_occurred_idx ON events (tenant_id, occurred_at);

-- Storage-level immutability (lock 5): nothing may UPDATE, DELETE or
-- TRUNCATE an event — not even a future module bypassing the service.
-- The message deliberately names no row id so the same function serves the
-- row-level and the statement-level trigger.

CREATE OR REPLACE FUNCTION events_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'events are immutable (architecture lock 5): % is forbidden on tenant %, table %',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER events_immutable
  BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION events_reject_mutation();

CREATE TRIGGER events_immutable_truncate
  BEFORE TRUNCATE ON events
  FOR EACH STATEMENT EXECUTE FUNCTION events_reject_mutation();
