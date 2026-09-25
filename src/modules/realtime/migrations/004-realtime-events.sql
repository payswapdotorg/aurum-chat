-- W086 · realtime module — the canonical event ledger: append-only trail
-- AND dedupe authority in one.
--
-- Every canonical realtime event lands here exactly once per (session,
-- provider event id): the INSERT and the state application run in ONE
-- transaction (unlike the meetings webhook path, no cross-module
-- observation write sits inside the apply), so the ledger row IS the
-- claim — ON CONFLICT DO NOTHING suppresses redeliveries (provider event
-- ids are stable across retries) and the row's presence proves the
-- application.
--
-- Domain-originated rows (consent decisions from the companion UI,
-- recording control, consent-refused recording starts — the explicit
-- `recording.blocked` trail) carry source 'domain' and a NULL provider
-- event id (distinct NULLs: no dedupe, every decision is recorded).
--
-- This table IS the explicit consent/recording state history (W086
-- acceptance) and the audit trail of everything that happened in a
-- session: participant joins/leaves, turns' provenance, spoken-response
-- lifecycle, provider failures. Append-only with exactly ONE legal
-- UPDATE: the one-way participant link (participant_id NULL → value,
-- once — filled when the application resolves the participant the event
-- concerns, the meetings ingestion-ledger discipline). DELETE and
-- TRUNCATE are forbidden, ever.

CREATE TABLE realtime_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  session_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('provider', 'domain')),
  kind text NOT NULL CHECK (kind IN (
    'session.started', 'session.ended', 'session.failed',
    'participant.joined', 'participant.left',
    'consent.granted', 'consent.revoked',
    'transcript.final', 'response.completed', 'response.interrupted',
    'recording.started', 'recording.stopped', 'recording.blocked'
  )),
  provider_event_id text
    CHECK (provider_event_id IS NULL OR char_length(provider_event_id) BETWEEN 1 AND 255),
  participant_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(detail) = 'object'),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT realtime_events_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT realtime_events_session_fk
    FOREIGN KEY (session_id, tenant_id)
    REFERENCES realtime_sessions (id, tenant_id),
  CONSTRAINT realtime_events_participant_fk
    FOREIGN KEY (participant_id, tenant_id)
    REFERENCES realtime_participants (id, tenant_id),
  CONSTRAINT realtime_events_provider_shape CHECK (
    (source = 'provider') = (provider_event_id IS NOT NULL)
  )
);

-- Dedupe authority: one application per (session, provider event id).
-- NULL provider_event_id (domain events) never conflicts (SQL NULLs are
-- distinct), which is exactly the intended semantics.
CREATE UNIQUE INDEX realtime_events_provider_dedupe
  ON realtime_events (tenant_id, session_id, provider_event_id)
  WHERE provider_event_id IS NOT NULL;

CREATE INDEX realtime_events_session_idx
  ON realtime_events (tenant_id, session_id, occurred_at ASC, id ASC);
CREATE INDEX realtime_events_session_kind_idx
  ON realtime_events (tenant_id, session_id, kind);

-- Storage-level guarantee: append-only with the one participant-link
-- fill — the trail is evidence; identity and detail are frozen.

CREATE OR REPLACE FUNCTION realtime_events_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'the append-only realtime event ledger (W086 realtime): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'the append-only realtime event ledger (W086 realtime): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.session_id <> OLD.session_id
     OR NEW.source <> OLD.source
     OR NEW.kind <> OLD.kind
     OR NEW.provider_event_id IS DISTINCT FROM OLD.provider_event_id
     OR NEW.detail IS DISTINCT FROM OLD.detail
     OR NEW.occurred_at <> OLD.occurred_at
     OR NEW.created_at <> OLD.created_at
     OR (OLD.participant_id IS NOT NULL AND NEW.participant_id IS DISTINCT FROM OLD.participant_id) THEN
    RAISE EXCEPTION 'the append-only realtime event ledger (W086 realtime): only the one-way participant link (participant_id) may be filled on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER realtime_events_link_only_updates
  BEFORE UPDATE OR DELETE ON realtime_events
  FOR EACH ROW EXECUTE FUNCTION realtime_events_guard();

CREATE TRIGGER realtime_events_immutable_truncate
  BEFORE TRUNCATE ON realtime_events
  FOR EACH STATEMENT EXECUTE FUNCTION realtime_events_guard();
