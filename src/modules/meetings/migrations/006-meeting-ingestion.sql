-- W085 · meetings module — the ingestion ledger (dedupe authority) and
-- the explicit failed/expired-access events.
--
-- MEETING INGESTION is the append-only ledger: one row per (tenant,
-- connection, provider record id), carrying the canonical path that
-- claimed it (`ingested_via`) and the ONE-WAY link to the observation
-- (W004 evidence) the record became. The claim is written BEFORE the
-- observation is recorded; the `observation_id`/`ingested_at` pair is
-- then filled by the only legal UPDATE (NULL → value, once — the sources
-- module's ledger discipline). A claim that never linked (a crash
-- between claim and observation) is re-ingestible: the capture path
-- re-observes ledger rows whose `observation_id` is still NULL when the
-- provider delivers the record again — no record is lost to a crash
-- window. Webhook redeliveries and poll re-fetches of the same window are
-- all suppressed against this ledger: one observation per provider
-- record id, ever.
--
-- MEETING ACCESS EVENTS make "failed/expired meeting access is explicit"
-- (W085 acceptance) a queryable domain fact, not just a thrown error: a
-- lapsed recorded OAuth grant discovered at poll time is recorded here
-- (in addition to failing fast), and provider-delivered access failures
-- (recording_unavailable, access_denied, …) are recorded here AND as
-- observations (kind `meeting.access`). Append-only: no UPDATE, no
-- DELETE, no TRUNCATE.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; composite
-- UNIQUE (id, tenant_id) matches the house pattern. `observation_id`
-- references the observations module's evidence opaquely — no
-- cross-module foreign keys.

CREATE TABLE meeting_ingestion (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  provider_record_id text NOT NULL
    CHECK (char_length(provider_record_id) BETWEEN 1 AND 255),
  ingested_via text NOT NULL CHECK (ingested_via IN ('polling', 'webhook')),
  observation_id uuid,
  claimed_at timestamptz NOT NULL,
  ingested_at timestamptz,
  CONSTRAINT meeting_ingestion_connection_record_unique
    UNIQUE (tenant_id, connection_id, provider_record_id),
  CONSTRAINT meeting_ingestion_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT meeting_ingestion_connection_fk
    FOREIGN KEY (connection_id, tenant_id)
    REFERENCES meeting_connections (id, tenant_id),
  CONSTRAINT meeting_ingestion_ingested_link_shape CHECK (
    (observation_id IS NULL AND ingested_at IS NULL)
    OR (observation_id IS NOT NULL AND ingested_at IS NOT NULL)
  )
);

CREATE INDEX meeting_ingestion_connection_idx
  ON meeting_ingestion (tenant_id, connection_id, claimed_at DESC);
CREATE INDEX meeting_ingestion_connection_link_idx
  ON meeting_ingestion (tenant_id, connection_id, observation_id);

-- Storage-level guarantee: append-only claims with a one-way link — the
-- claim's identity (connection, record id, via, claimed_at) is immutable,
-- and the observation link may only be filled once (NULL → value).
-- DELETE and TRUNCATE are forbidden: the ledger IS the dedupe authority
-- and the capture audit.

CREATE OR REPLACE FUNCTION meeting_ingestion_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'meeting ingestion is the append-only capture ledger (W085 meetings): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'meeting ingestion is the append-only capture ledger (W085 meetings): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.connection_id <> OLD.connection_id
     OR NEW.provider_record_id <> OLD.provider_record_id
     OR NEW.ingested_via <> OLD.ingested_via
     OR NEW.claimed_at <> OLD.claimed_at
     OR (OLD.observation_id IS NOT NULL AND NEW.observation_id IS DISTINCT FROM OLD.observation_id)
     OR (OLD.ingested_at IS NOT NULL AND NEW.ingested_at IS DISTINCT FROM OLD.ingested_at)
     OR (NEW.observation_id IS NULL) <> (NEW.ingested_at IS NULL) THEN
    RAISE EXCEPTION 'meeting ingestion is the append-only capture ledger (W085 meetings): only the one-way observation link (observation_id, ingested_at) may be filled on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER meeting_ingestion_link_only_updates
  BEFORE UPDATE OR DELETE ON meeting_ingestion
  FOR EACH ROW EXECUTE FUNCTION meeting_ingestion_guard();

CREATE TRIGGER meeting_ingestion_immutable_truncate
  BEFORE TRUNCATE ON meeting_ingestion
  FOR EACH STATEMENT EXECUTE FUNCTION meeting_ingestion_guard();

CREATE TABLE meeting_access_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN (
    'zoom', 'microsoft-teams', 'google-meet', 'recall'
  )),
  provider_meeting_id text
    CHECK (provider_meeting_id IS NULL OR char_length(provider_meeting_id) BETWEEN 1 AND 255),
  code text NOT NULL CHECK (code IN (
    'authorization_expired', 'access_denied', 'not_found',
    'recording_unavailable', 'transcript_unavailable'
  )),
  detail text CHECK (detail IS NULL OR char_length(detail) BETWEEN 1 AND 2000),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meeting_access_events_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT meeting_access_events_connection_fk
    FOREIGN KEY (connection_id, tenant_id)
    REFERENCES meeting_connections (id, tenant_id)
);

CREATE INDEX meeting_access_events_tenant_connection_idx
  ON meeting_access_events (tenant_id, connection_id, occurred_at DESC);
CREATE INDEX meeting_access_events_tenant_code_idx
  ON meeting_access_events (tenant_id, code);

-- Storage-level guarantee: access events are strictly append-only — no
-- UPDATE, no DELETE, no TRUNCATE, ever. The history of what Aurum could
-- not access (and when) is itself evidence.

CREATE OR REPLACE FUNCTION meeting_access_events_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only access evidence (W085 meetings): % is forbidden on table %',
    TG_TABLE_NAME, TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER meeting_access_events_immutable
  BEFORE UPDATE OR DELETE ON meeting_access_events
  FOR EACH ROW EXECUTE FUNCTION meeting_access_events_reject_mutation();

CREATE TRIGGER meeting_access_events_immutable_truncate
  BEFORE TRUNCATE ON meeting_access_events
  FOR EACH STATEMENT EXECUTE FUNCTION meeting_access_events_reject_mutation();
