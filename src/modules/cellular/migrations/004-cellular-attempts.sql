-- W087 · cellular module — delivery attempts (the append-then-refine
-- delivery audit).
--
-- One row per delivery attempt of one reach request: WHAT was sent (the
-- exact SMS body / spoken voice script), through which connection and
-- numbers, under which authority-gate decision, at which estimated cost
-- (the request's snapshotted policy rate), and — as the carrier reports
-- back — the receipt-driven lifecycle state. The attempt is the delivery
-- evidence the W087 acceptance demands: failed delivery is visible here
-- and retryable through the request's delivery cycles.
--
-- The SUBSTANTIVE fields (leg, cycle, gate decision, provider,
-- connection, numbers, text, segments, cost, attempt number/timestamp)
-- are history the moment they are written. Only the receipt-driven
-- LIFECYCLE fields (status, detail, receipt_at, duration_seconds,
-- recording_url) may ever move — carrier delivery receipts update an
-- SMS attempt from 'sent' to 'delivered'/'undelivered', call events
-- refine a voice attempt — and the database enforces it.
--
-- Leg-shape invariants (defense in depth):
--   * an SMS attempt carries its segment estimate and never a call id;
--   * a voice attempt carries its script and never a segment estimate
--     or a provider message id.
--
-- No cross-module foreign keys (the house pattern): reach_request_id and
-- connection_id reference this module's tables opaquely.

CREATE TABLE cellular_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  reach_request_id uuid NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  cycle integer NOT NULL CHECK (cycle >= 1),
  leg text NOT NULL CHECK (leg IN ('sms', 'voice')),
  gate_status text NOT NULL CHECK (gate_status IN ('approved', 'rejected')),
  provider text NOT NULL CHECK (provider IN ('twilio', 'telnyx')),
  -- NULL when the attempt failed before a leg could be placed (no active
  -- connection, no transport wired): the attempt still counts against the
  -- retry budget — an honest, bounded "tried and could not send" record.
  connection_id uuid,
  from_number text CHECK (from_number IS NULL OR from_number ~ '^\+[1-9][0-9]{6,14}$'),
  to_number text NOT NULL CHECK (to_number ~ '^\+[1-9][0-9]{6,14}$'),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 640),
  segments integer CHECK (segments IS NULL OR segments BETWEEN 1 AND 10),
  cost_minor integer NOT NULL CHECK (cost_minor >= 0),
  status text NOT NULL CHECK (status IN (
    'sent', 'delivered', 'undelivered', 'rejected', 'failed',
    'answered', 'no_answer', 'completed'
  )),
  provider_message_id text
    CHECK (provider_message_id IS NULL OR char_length(provider_message_id) BETWEEN 1 AND 255),
  provider_call_id text
    CHECK (provider_call_id IS NULL OR char_length(provider_call_id) BETWEEN 1 AND 255),
  detail text CHECK (detail IS NULL OR char_length(detail) BETWEEN 1 AND 2000),
  attempted_at timestamptz NOT NULL,
  receipt_at timestamptz,
  duration_seconds integer CHECK (
    duration_seconds IS NULL OR (duration_seconds >= 0 AND duration_seconds <= 86400)
  ),
  recording_url text CHECK (
    recording_url IS NULL OR char_length(recording_url) BETWEEN 1 AND 2048
  ),
  CONSTRAINT cellular_attempts_sequence_unique
    UNIQUE (tenant_id, reach_request_id, attempt_no),
  CONSTRAINT cellular_attempts_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT cellular_attempts_leg_shape CHECK (
    (leg = 'sms' AND segments IS NOT NULL AND provider_call_id IS NULL
       AND status IN ('sent', 'delivered', 'undelivered', 'rejected', 'failed'))
    OR (leg = 'voice' AND segments IS NULL AND provider_message_id IS NULL
       AND status IN ('answered', 'no_answer', 'failed', 'completed'))
  ),
  CONSTRAINT cellular_attempts_placed_shape CHECK (
    (connection_id IS NOT NULL AND from_number IS NOT NULL)
    OR (connection_id IS NULL AND from_number IS NULL AND status = 'failed')
  )
);

CREATE INDEX cellular_attempts_tenant_request_idx
  ON cellular_attempts (tenant_id, reach_request_id, attempt_no);
CREATE INDEX cellular_attempts_tenant_request_cycle_idx
  ON cellular_attempts (tenant_id, reach_request_id, cycle);
CREATE INDEX cellular_attempts_tenant_message_idx
  ON cellular_attempts (tenant_id, provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE INDEX cellular_attempts_tenant_call_idx
  ON cellular_attempts (tenant_id, provider, provider_call_id)
  WHERE provider_call_id IS NOT NULL;

-- Storage-level immutability: the substantive fields are history; only
-- the receipt-driven lifecycle fields may move (the state trail itself
-- is the append-only cellular_events ledger, migration 005).

CREATE OR REPLACE FUNCTION cellular_attempts_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cellular attempts are immutable history (W087 cellular): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'cellular attempts are immutable history (W087 cellular): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.reach_request_id <> OLD.reach_request_id
     OR NEW.attempt_no <> OLD.attempt_no
     OR NEW.cycle <> OLD.cycle
     OR NEW.leg <> OLD.leg
     OR NEW.gate_status <> OLD.gate_status
     OR NEW.provider <> OLD.provider
     OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
     OR NEW.from_number IS DISTINCT FROM OLD.from_number
     OR NEW.to_number <> OLD.to_number
     OR NEW.text <> OLD.text
     OR NEW.segments <> OLD.segments
     OR NEW.cost_minor <> OLD.cost_minor
     OR NEW.attempted_at <> OLD.attempted_at
     OR NEW.provider_message_id <> OLD.provider_message_id
     OR NEW.provider_call_id <> OLD.provider_call_id
  THEN
    RAISE EXCEPTION 'cellular attempt substantive fields are immutable (W087 cellular): only the receipt lifecycle may move on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cellular_attempts_immutable
  BEFORE UPDATE OR DELETE ON cellular_attempts
  FOR EACH ROW EXECUTE FUNCTION cellular_attempts_guard();

CREATE TRIGGER cellular_attempts_immutable_truncate
  BEFORE TRUNCATE ON cellular_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION cellular_attempts_guard();
