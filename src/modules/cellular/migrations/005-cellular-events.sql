-- W087 · cellular module — the provider event ledger (append-only) and
-- the recorded inbound messages (replies and manager-originated
-- requests).
--
-- CELLULAR EVENTS (the ledger — realtime module's event-ledger
-- discipline): one row per APPLIED provider event, keyed by the vendor's
-- own STABLE event id: (tenant, provider, provider_event_id) UNIQUE.
-- The ledger row IS the claim — one application per event id; a
-- redelivered envelope dedupes. The canonical (vendor-normalized) event
-- is stored as JSON; nothing may UPDATE, DELETE or TRUNCATE a ledger
-- row. Recognized-but-non-record events (queued/sent delivery pings,
-- call media pings) never reach the ledger — the adapters reject them
-- as unsupported.
--
-- CELLULAR REPLIES: one row per recorded inbound cellular MESSAGE (SMS
-- text or recognized call speech), keyed by the same provider event id
-- (one reply row per event). The reply is the W087 reply-state half of
-- "delivery/reply state":
--
--   * inbound_kind 'reach_reply'     — the message correlated to an open
--     reach request (the request moves to 'replied');
--   * inbound_kind 'inbound_request' — the message arrived on the
--     tenant's number with no open reach request: the MANAGER-originated
--     path (a manager with no usable Internet data can text/call Aurum
--     and the request returns into Aurum).
--
-- The canonical transcript turn of the reply was recorded through the
-- channels contract (W030) BEFORE the reply row is written — the reply
-- row references the conversation/message ids opaquely (no cross-module
-- foreign key, the house pattern). The sender's identity is registered
-- on sight (W002) by that same delegation; person/employee attribution
-- is the people contract's resolution (lock 15 — unverified senders
-- resolve to nobody).
--
-- Both tables are APPEND-ONLY: storage-level triggers reject UPDATE,
-- DELETE and TRUNCATE — not even a future module bypassing the service
-- can rewrite the inbound trail.

CREATE TABLE cellular_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('twilio', 'telnyx')),
  provider_event_id text NOT NULL
    CHECK (char_length(provider_event_id) BETWEEN 1 AND 255),
  kind text NOT NULL CHECK (kind IN ('sms_reply', 'voice_reply', 'sms_receipt', 'call_status')),
  connection_id uuid,
  event jsonb NOT NULL CHECK (jsonb_typeof(event) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cellular_events_tenant_provider_event_unique
    UNIQUE (tenant_id, provider, provider_event_id),
  CONSTRAINT cellular_events_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX cellular_events_tenant_created_idx
  ON cellular_events (tenant_id, created_at DESC);
CREATE INDEX cellular_events_tenant_provider_idx
  ON cellular_events (tenant_id, provider, created_at DESC);

CREATE TABLE cellular_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('twilio', 'telnyx')),
  provider_event_id text NOT NULL
    CHECK (char_length(provider_event_id) BETWEEN 1 AND 255),
  inbound_kind text NOT NULL CHECK (inbound_kind IN ('reach_reply', 'inbound_request')),
  reach_request_id uuid,
  channel text NOT NULL CHECK (channel IN ('sms', 'voice')),
  from_number text NOT NULL CHECK (from_number ~ '^\+[1-9][0-9]{6,14}$'),
  to_number text NOT NULL CHECK (to_number ~ '^\+[1-9][0-9]{6,14}$'),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 65536),
  identity_id uuid,
  person_id uuid,
  employee_id uuid,
  conversation_id uuid,
  message_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cellular_replies_tenant_provider_event_unique
    UNIQUE (tenant_id, provider, provider_event_id),
  CONSTRAINT cellular_replies_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT cellular_replies_correlation_shape CHECK (
    (inbound_kind = 'reach_reply' AND reach_request_id IS NOT NULL)
    OR (inbound_kind = 'inbound_request' AND reach_request_id IS NULL)
  )
);

CREATE INDEX cellular_replies_tenant_created_idx
  ON cellular_replies (tenant_id, created_at DESC);
CREATE INDEX cellular_replies_tenant_request_idx
  ON cellular_replies (tenant_id, reach_request_id);
CREATE INDEX cellular_replies_tenant_from_idx
  ON cellular_replies (tenant_id, from_number);

-- Storage-level immutability (append-only inbound trail).

CREATE OR REPLACE FUNCTION cellular_events_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'cellular events are append-only (W087 cellular): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cellular_events_immutable
  BEFORE UPDATE OR DELETE ON cellular_events
  FOR EACH ROW EXECUTE FUNCTION cellular_events_reject_mutation();

CREATE TRIGGER cellular_events_immutable_truncate
  BEFORE TRUNCATE ON cellular_events
  FOR EACH STATEMENT EXECUTE FUNCTION cellular_events_reject_mutation();

CREATE OR REPLACE FUNCTION cellular_replies_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'cellular replies are append-only (W087 cellular): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cellular_replies_immutable
  BEFORE UPDATE OR DELETE ON cellular_replies
  FOR EACH ROW EXECUTE FUNCTION cellular_replies_reject_mutation();

CREATE TRIGGER cellular_replies_immutable_truncate
  BEFORE TRUNCATE ON cellular_replies
  FOR EACH STATEMENT EXECUTE FUNCTION cellular_replies_reject_mutation();
