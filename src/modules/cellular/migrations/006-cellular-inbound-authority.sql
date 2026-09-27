-- W108 · cellular module — the manager-inbound W009 AUTHORITY RECORD
-- (the W097 deferral closure) and the inbound-origin reference on reach
-- requests.
--
-- W097 recorded one explicit deferred authority gap: a manager-originated
-- inbound request (inbound_kind 'inbound_request' — a manager with no
-- usable Internet data texting/calling Aurum's own number) can RETURN
-- into Aurum, but the FORMAL W009 authority-gate record for actions
-- ORIGINATING from that request was deferred. This migration closes the
-- storage half of that gap:
--
-- 1. CELLULAR REACH REQUESTS gain INSERT-time ORIGIN columns — when a
--    consequential outbound reach originates from a manager's inbound
--    ask, the reach row and its W009 action-request payload reference
--    the originating inbound event (reply row id + provider + the
--    vendor's stable event id — the same evidence triple the reply row
--    and the event ledger already carry). The columns are set at insert
--    and NEVER move: the guard function below (replaced additively per
--    the W102 discipline — this file, never migration 003) protects them
--    exactly like every other substantive field.
--
-- 2. CELLULAR INBOUND AUTHORITY — the per-event DETERMINATION LEDGER:
--    one row per inbound event whose consequentiality was decided.
--    * 'consequential'     — the ask led Aurum to an authority-gated
--      action; `action_request_id` references the W009 gate record (the
--      actions module's own audit surface shows the full decision: the
--      gate payload itself references the inbound origin, closing the
--      loop in BOTH directions).
--    * 'not_consequential' — a recorded NEGATIVE determination: the ask
--      required no authority-gated action (evidence, not silence).
--    * 'ambiguous_sender'  — the sender's identity could not be resolved
--      unambiguously to a verified person; no consequential action was
--      taken and NO identity was merged (lock 15 / the W002 posture:
--      ambiguous identities never auto-merge).
--    Idempotency: UNIQUE (tenant_id, provider, provider_event_id) — one
--    determination per inbound event, first write wins; redelivery or a
--    second review of the same event never duplicates the record.
--    APPEND-ONLY (storage-level triggers reject UPDATE/DELETE/TRUNCATE —
--    the same discipline as cellular_events/cellular_replies).
--
-- No cross-module foreign keys (the house pattern): reply_id and
-- action_request_id reference this module's / the actions module's rows
-- opaquely; the shape CHECK constraints carry the referential
-- discipline.

-- ---------------------------------------------------------------------------
-- 1. Reach requests: the inbound-origin reference (INSERT-time only)
-- ---------------------------------------------------------------------------

ALTER TABLE cellular_reach_requests
  ADD COLUMN origin_reply_id uuid,
  ADD COLUMN origin_provider text
    CHECK (origin_provider IS NULL OR origin_provider IN ('twilio', 'telnyx')),
  ADD COLUMN origin_provider_event_id text
    CHECK (
      origin_provider_event_id IS NULL
      OR char_length(origin_provider_event_id) BETWEEN 1 AND 255
    );

ALTER TABLE cellular_reach_requests
  ADD CONSTRAINT cellular_reach_requests_origin_shape CHECK (
    (origin_reply_id IS NULL AND origin_provider IS NULL AND origin_provider_event_id IS NULL)
    OR (origin_reply_id IS NOT NULL AND origin_provider IS NOT NULL AND origin_provider_event_id IS NOT NULL)
  );

-- The origin triple is substantive history: extend the guard (W102
-- discipline — REPLACE the function from THIS immutable file; migration
-- 003 itself is never edited). Every clause of the 003 guard is
-- reproduced verbatim, with the origin columns added to the comparison.
CREATE OR REPLACE FUNCTION cellular_reach_requests_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cellular reach requests are immutable history (W087 cellular): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'cellular reach requests are immutable history (W087 cellular): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.kind <> OLD.kind
     OR NEW.recipient_kind <> OLD.recipient_kind
     OR NEW.person_id <> OLD.person_id
     OR NEW.employee_id <> OLD.employee_id
     OR NEW.identity_id <> OLD.identity_id
     OR NEW.phone_number <> OLD.phone_number
     OR NEW.text <> OLD.text
     OR NEW.connection_id <> OLD.connection_id
     OR NEW.requested_by <> OLD.requested_by
     OR NEW.action_kind <> OLD.action_kind
     OR NEW.policy_source <> OLD.policy_source
     OR NEW.voice_fallback <> OLD.voice_fallback
     OR NEW.sms_max_attempts <> OLD.sms_max_attempts
     OR NEW.retry_backoff_seconds <> OLD.retry_backoff_seconds
     OR NEW.max_sms_segments <> OLD.max_sms_segments
     OR NEW.sms_segment_cost_minor <> OLD.sms_segment_cost_minor
     OR NEW.voice_per_minute_cost_minor <> OLD.voice_per_minute_cost_minor
     OR NEW.currency <> OLD.currency
     OR NEW.max_cost_per_reach_minor <> OLD.max_cost_per_reach_minor
     OR NEW.failure_notification IS DISTINCT FROM OLD.failure_notification
     OR NEW.created_at <> OLD.created_at
     OR (NEW.action_request_id IS NOT DISTINCT FROM NULL AND OLD.action_request_id IS NOT NULL)
     OR NEW.origin_reply_id IS DISTINCT FROM OLD.origin_reply_id
     OR NEW.origin_provider IS DISTINCT FROM OLD.origin_provider
     OR NEW.origin_provider_event_id IS DISTINCT FROM OLD.origin_provider_event_id
  THEN
    RAISE EXCEPTION 'cellular reach request substantive fields are immutable (W087/W108 cellular): only the lifecycle state may move on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 2. The per-event inbound determination ledger (append-only)
-- ---------------------------------------------------------------------------

CREATE TABLE cellular_inbound_authority (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('twilio', 'telnyx')),
  provider_event_id text NOT NULL
    CHECK (char_length(provider_event_id) BETWEEN 1 AND 255),
  -- The manager-originated inbound message row this determination is
  -- about (this module's cellular_replies, referenced opaquely).
  reply_id uuid NOT NULL,
  determination text NOT NULL CHECK (determination IN (
    'consequential', 'not_consequential', 'ambiguous_sender'
  )),
  -- The W009 gate record of the consequential action (the actions
  -- module's action_requests, referenced opaquely) — required exactly
  -- for 'consequential' determinations.
  action_request_id uuid,
  -- Which action surface produced the consequential action (e.g.
  -- 'cellular-reach') — the reconstruction hint for auditors.
  origin_kind text NOT NULL CHECK (char_length(origin_kind) BETWEEN 1 AND 100),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
  -- The principal that made (or recorded) the determination.
  decided_by text NOT NULL CHECK (decided_by <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cellular_inbound_authority_tenant_event_unique
    UNIQUE (tenant_id, provider, provider_event_id),
  CONSTRAINT cellular_inbound_authority_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT cellular_inbound_authority_shape CHECK (
    (determination = 'consequential' AND action_request_id IS NOT NULL)
    OR (determination IN ('not_consequential', 'ambiguous_sender') AND action_request_id IS NULL)
  )
);

CREATE INDEX cellular_inbound_authority_tenant_created_idx
  ON cellular_inbound_authority (tenant_id, created_at DESC);
CREATE INDEX cellular_inbound_authority_tenant_reply_idx
  ON cellular_inbound_authority (tenant_id, reply_id);

-- Storage-level immutability (append-only determination trail).

CREATE OR REPLACE FUNCTION cellular_inbound_authority_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'cellular inbound authority determinations are append-only (W108 cellular): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cellular_inbound_authority_immutable
  BEFORE UPDATE OR DELETE ON cellular_inbound_authority
  FOR EACH ROW EXECUTE FUNCTION cellular_inbound_authority_reject_mutation();

CREATE TRIGGER cellular_inbound_authority_immutable_truncate
  BEFORE TRUNCATE ON cellular_inbound_authority
  FOR EACH STATEMENT EXECUTE FUNCTION cellular_inbound_authority_reject_mutation();
