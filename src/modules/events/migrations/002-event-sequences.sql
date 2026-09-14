-- W003 · events module — per-tenant sequence counters (ordering metadata).
--
-- One row per tenant that has ever appended an event. The append path
-- allocates the next sequence number atomically:
--
--   INSERT INTO event_sequences (tenant_id, last_sequence) VALUES ($1, 1)
--   ON CONFLICT (tenant_id) DO UPDATE
--     SET last_sequence = event_sequences.last_sequence + 1
--   RETURNING last_sequence
--
-- executed inside the append transaction, so the counter row lock is held
-- until commit: appends serialize per tenant and `sequence` is the
-- canonical, strictly increasing replay order (unique per tenant via
-- events_tenant_sequence_unique in migrations/001-events.sql).
--
-- The counter is mutable bookkeeping (its whole job is to be incremented),
-- so it deliberately lacks the events immutability triggers — but it can
-- never be DELETED or TRUNCATEd: a lost counter would restart numbering
-- at 1 and collide with existing history, wedging all future appends.
-- UPDATE remains legal (it is the increment path).

CREATE TABLE event_sequences (
  tenant_id uuid PRIMARY KEY,
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0)
);

CREATE OR REPLACE FUNCTION event_sequences_reject_removal() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'event sequence counters cannot be removed: % is forbidden on tenant %, table %',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER event_sequences_no_delete
  BEFORE DELETE ON event_sequences
  FOR EACH ROW EXECUTE FUNCTION event_sequences_reject_removal();

CREATE TRIGGER event_sequences_no_truncate
  BEFORE TRUNCATE ON event_sequences
  FOR EACH STATEMENT EXECUTE FUNCTION event_sequences_reject_removal();
