-- W036 · sources module — checkpoints, checkpoint history and the
-- ingestion ledger (dedupe authority).
--
-- SOURCE CHECKPOINTS hold each source's current polling cursor: the
-- OPAQUE provider token the next poll resumes from. NULL means "from the
-- beginning of the provider's history" (never polled, or rewound to the
-- start by replay). This is mutable ingestion state, not evidence: only
-- `cursor` and `updated_at` may ever move (guard trigger below); DELETE
-- and TRUNCATE are forbidden outright — the history table preserves the
-- trail of every cursor a source has held.
--
-- SOURCE CHECKPOINT HISTORY is the append-only audit of cursor movement
-- and the legal replay target set: one row per poll ADVANCE (origin
-- 'poll') and per replay REWIND (origin 'replay', including the
-- rewind-to-start, whose cursor is NULL). Nothing may UPDATE, DELETE or
-- TRUNCATE a history row.
--
-- SOURCE RECORDS is the append-only ingestion ledger — the DEDUPE
-- authority (W036 "checkpointing, replay and dedupe"; ARCHITECTURE.md §10
-- idempotent ingestion): one row per (tenant, source, provider record id),
-- carrying the canonical path that claimed it (`ingested_via`) and the
-- ONE-WAY link to the observation (W004 evidence) the record became.
-- The claim is written BEFORE the observation is recorded; the
-- `observation_id`/`ingested_at` pair is then filled by the only legal
-- UPDATE (NULL → value, once — the notifications module's gate-request
-- discipline). A claim that never linked (a crash between claim and
-- observation) is re-ingestible: the ingestion path re-observes ledger
-- rows whose `observation_id` is still NULL when the provider delivers
-- the record again — no record is lost to a crash window.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the composite
-- UNIQUE (id, tenant_id) matches the house pattern. No cross-module
-- foreign keys: `observation_id` references the observations module's
-- evidence opaquely, like every sibling forward reference.

CREATE TABLE source_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  source_id uuid NOT NULL,
  cursor text CHECK (cursor IS NULL OR char_length(cursor) BETWEEN 1 AND 1024),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_checkpoints_source_unique UNIQUE (tenant_id, source_id),
  CONSTRAINT source_checkpoints_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE TABLE source_checkpoint_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  source_id uuid NOT NULL,
  cursor text CHECK (cursor IS NULL OR char_length(cursor) BETWEEN 1 AND 1024),
  origin text NOT NULL CHECK (origin IN ('poll', 'replay')),
  recorded_by text NOT NULL CHECK (recorded_by <> ''),
  recorded_at timestamptz NOT NULL,
  CONSTRAINT source_checkpoint_history_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX source_checkpoint_history_source_idx
  ON source_checkpoint_history (tenant_id, source_id, recorded_at DESC, id DESC);

CREATE TABLE source_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  source_id uuid NOT NULL,
  provider_record_id text NOT NULL
    CHECK (char_length(provider_record_id) BETWEEN 1 AND 255),
  ingested_via text NOT NULL CHECK (ingested_via IN ('polling', 'webhook')),
  observation_id uuid,
  claimed_at timestamptz NOT NULL,
  ingested_at timestamptz,
  CONSTRAINT source_records_source_record_unique
    UNIQUE (tenant_id, source_id, provider_record_id),
  CONSTRAINT source_records_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT source_records_ingested_link_shape CHECK (
    (observation_id IS NULL AND ingested_at IS NULL)
    OR (observation_id IS NOT NULL AND ingested_at IS NOT NULL)
  )
);

CREATE INDEX source_records_source_idx
  ON source_records (tenant_id, source_id, claimed_at DESC);
CREATE INDEX source_records_source_link_idx
  ON source_records (tenant_id, source_id, observation_id);

-- Storage-level guarantees.
--
-- source_checkpoints: only the cursor (and updated_at) may move — the
-- checkpoint row can never be repointed at another source, and it can
-- never be deleted (the history table is the trail; the current row is
-- the live state).

CREATE OR REPLACE FUNCTION source_checkpoints_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'source checkpoints are live ingestion state (W036 sources): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'source checkpoints are live ingestion state (W036 sources): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.source_id <> OLD.source_id THEN
    RAISE EXCEPTION 'source checkpoints are live ingestion state (W036 sources): only the cursor and updated_at may change on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER source_checkpoints_state_only_updates
  BEFORE UPDATE OR DELETE ON source_checkpoints
  FOR EACH ROW EXECUTE FUNCTION source_checkpoints_guard();

CREATE TRIGGER source_checkpoints_immutable_truncate
  BEFORE TRUNCATE ON source_checkpoints
  FOR EACH STATEMENT EXECUTE FUNCTION source_checkpoints_guard();

-- source_checkpoint_history: strictly append-only audit evidence — no
-- UPDATE, DELETE or TRUNCATE, ever.

CREATE OR REPLACE FUNCTION source_checkpoint_history_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only checkpoint audit (W036 sources): % is forbidden on table %',
    TG_TABLE_NAME, TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER source_checkpoint_history_immutable
  BEFORE UPDATE OR DELETE ON source_checkpoint_history
  FOR EACH ROW EXECUTE FUNCTION source_checkpoint_history_reject_mutation();

CREATE TRIGGER source_checkpoint_history_immutable_truncate
  BEFORE TRUNCATE ON source_checkpoint_history
  FOR EACH STATEMENT EXECUTE FUNCTION source_checkpoint_history_reject_mutation();

-- source_records: append-only claims with a one-way link — the claim's
-- identity (source, record id, via, claimed_at) is immutable, and the
-- observation link may only be filled once (NULL → value). DELETE and
-- TRUNCATE are forbidden: the ledger IS the dedupe authority and the
-- ingestion audit.

CREATE OR REPLACE FUNCTION source_records_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'source records are the append-only ingestion ledger (W036 sources): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'source records are the append-only ingestion ledger (W036 sources): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.source_id <> OLD.source_id
     OR NEW.provider_record_id <> OLD.provider_record_id
     OR NEW.ingested_via <> OLD.ingested_via
     OR NEW.claimed_at <> OLD.claimed_at
     OR (OLD.observation_id IS NOT NULL AND NEW.observation_id IS DISTINCT FROM OLD.observation_id)
     OR (OLD.ingested_at IS NOT NULL AND NEW.ingested_at IS DISTINCT FROM OLD.ingested_at)
     OR (NEW.observation_id IS NULL) <> (NEW.ingested_at IS NULL) THEN
    RAISE EXCEPTION 'source records are the append-only ingestion ledger (W036 sources): only the one-way observation link (observation_id, ingested_at) may be filled on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER source_records_link_only_updates
  BEFORE UPDATE OR DELETE ON source_records
  FOR EACH ROW EXECUTE FUNCTION source_records_guard();

CREATE TRIGGER source_records_immutable_truncate
  BEFORE TRUNCATE ON source_records
  FOR EACH STATEMENT EXECUTE FUNCTION source_records_guard();
