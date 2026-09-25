-- W087 · cellular module — reach requests (the outcome-oriented core).
--
-- A REACH REQUEST is the durable record of one outcome-oriented ask:
-- "Tell Sarah …" / "Ask Sarah …". The SUBSTANTIVE record — the resolved
-- recipient (classification, person/employee/identity references, E.164
-- number), the message, the authority-gate request covering it, and the
-- RESOLVED POLICY SNAPSHOT that governs it (voice fallback mode, retry
-- budget, backoff, segment cap, cost model, cost cap — exactly as
-- resolved at creation; later policy edits never rewrite what governs a
-- recorded request) — is immutable history the moment it is written,
-- exactly like a notification's policy snapshot (W031) or an action
-- request's evaluation snapshot (W009).
--
-- The LIFECYCLE STATE (status, failure code, attempt counters, delivery
-- cycle, accumulated cost, next-attempt schedule, the sent/delivered/
-- replied timestamps, and the one-way NULL→value assignment of the
-- authority-gate request id) is the only thing that may move:
--
--   pending ──▶ awaiting_approval ──▶ blocked        (gate rejected)
--      │              │ (approved between pumps)
--      │              └──▶ sent ◀──┐
--      ├──▶ sent ◀─────────────────┘ (SMS accepted by the carrier)
--      │      ├──▶ delivered        (DLR confirmed / call answered)
--      │      ├──▶ replied          (the recipient answered back)
--      │      ├──▶ voice_fallback   (SMS terminal, policy permits voice)
--      │      │        ├──▶ delivered / replied
--      │      │        └──▶ failed
--      │      └──▶ pending          (DLR failed, retry budget remains)
--      └──▶ failed                  (terminal — visible and retryable)
--
--   `failed` reopens via retryCellularReach (a NEW delivery cycle — the
--   counters reset, the lifetime cost does not). `blocked` never
--   reopens: the authority decision is stable per request (idempotent
--   gate replay), so a policy change requires a NEW request.
--
-- `failure_notification` is the caller's OPTIONAL snapshot of where a
-- terminal failure/blocking is notified (W031 contract: canonical
-- channel party {provider, providerAccountId, displayName?}).
--
-- No cross-module foreign keys (the house pattern): person/employee/
-- identity/action references are opaque uuids; action_kind is the
-- actions matrix's canonical slug this request was gated under.
--
-- Storage-level guarantees (mirroring notifications, W031): the guard
-- trigger rejects DELETE/TRUNCATE outright and rejects any UPDATE that
-- touches a substantive field.

CREATE TABLE cellular_reach_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('tell', 'ask')),
  recipient_kind text NOT NULL CHECK (recipient_kind IN (
    'verified_employee', 'verified_person', 'unverified_identity', 'unknown_number'
  )),
  person_id uuid,
  employee_id uuid,
  identity_id uuid,
  phone_number text NOT NULL CHECK (phone_number ~ '^\+[1-9][0-9]{6,14}$'),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 640),
  connection_id uuid,
  requested_by text NOT NULL CHECK (requested_by <> ''),
  action_request_id uuid,
  action_kind text NOT NULL CHECK (action_kind IN ('employee-messaging', 'external-communication')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'awaiting_approval', 'blocked', 'sent',
    'delivered', 'replied', 'voice_fallback', 'failed'
  )),
  failure_code text CHECK (failure_code IS NULL OR failure_code IN (
    'sms_rejected', 'sms_attempts_exhausted', 'cost_cap_exceeded',
    'voice_not_permitted', 'voice_no_answer', 'voice_failed',
    'provider_unavailable'
  )),
  -- The resolved policy snapshot (see the file header).
  policy_source text NOT NULL CHECK (policy_source IN ('kind', 'tenant-default', 'built-in')),
  voice_fallback text NOT NULL CHECK (voice_fallback IN ('forbidden', 'on_sms_failure')),
  sms_max_attempts integer NOT NULL CHECK (sms_max_attempts BETWEEN 1 AND 10),
  retry_backoff_seconds integer NOT NULL CHECK (retry_backoff_seconds BETWEEN 1 AND 86400),
  max_sms_segments integer NOT NULL CHECK (max_sms_segments BETWEEN 1 AND 10),
  sms_segment_cost_minor integer NOT NULL CHECK (sms_segment_cost_minor BETWEEN 0 AND 1000000),
  voice_per_minute_cost_minor integer NOT NULL
    CHECK (voice_per_minute_cost_minor BETWEEN 0 AND 1000000),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  max_cost_per_reach_minor integer NOT NULL
    CHECK (max_cost_per_reach_minor BETWEEN 0 AND 1000000000),
  failure_notification jsonb,
  sms_attempts_count integer NOT NULL DEFAULT 0 CHECK (sms_attempts_count >= 0),
  voice_attempts_count integer NOT NULL DEFAULT 0 CHECK (voice_attempts_count >= 0),
  cycle integer NOT NULL DEFAULT 1 CHECK (cycle >= 1),
  cost_minor_total integer NOT NULL DEFAULT 0 CHECK (cost_minor_total >= 0),
  next_attempt_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  replied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cellular_reach_requests_id_tenant_unique UNIQUE (id, tenant_id),
  -- Lifecycle-shape invariants (defense in depth; the service enforces
  -- the same rules).
  CONSTRAINT cellular_reach_requests_failure_code_shape CHECK (
    (failure_code IS NULL) OR (status = 'failed')
  ),
  CONSTRAINT cellular_reach_requests_delivered_state_shape CHECK (
    (status IN ('delivered', 'replied')) = (delivered_at IS NOT NULL)
  ),
  CONSTRAINT cellular_reach_requests_replied_state_shape CHECK (
    (status = 'replied') = (replied_at IS NOT NULL)
  ),
  -- Only the 'sent' status requires a carrier-accepted SMS: a voice-only
  -- delivery (SMS leg rejected/failed, fallback call answered) reaches
  -- 'delivered'/'replied'/'voice_fallback' without any accepted SMS.
  CONSTRAINT cellular_reach_requests_sent_state_shape CHECK (
    status <> 'sent' OR sent_at IS NOT NULL
  ),
  CONSTRAINT cellular_reach_requests_notification_shape CHECK (
    failure_notification IS NULL OR (
      jsonb_typeof(failure_notification) = 'object'
      AND failure_notification ? 'provider'
      AND failure_notification ? 'providerAccountId'
      AND jsonb_typeof(failure_notification->'provider') = 'string'
      AND jsonb_typeof(failure_notification->'providerAccountId') = 'string'
      AND char_length(failure_notification->>'providerAccountId') BETWEEN 1 AND 255
      AND (
        NOT (failure_notification ? 'displayName')
        OR jsonb_typeof(failure_notification->'displayName') = 'null'
        OR (
          jsonb_typeof(failure_notification->'displayName') = 'string'
          AND char_length(failure_notification->>'displayName') BETWEEN 1 AND 200
        )
      )
    )
  ),
  CONSTRAINT cellular_reach_requests_attempt_counts_shape CHECK (
    (status IN ('sent', 'delivered', 'replied', 'voice_fallback') AND sms_attempts_count >= 1)
    OR (status IN ('pending', 'awaiting_approval', 'blocked', 'failed'))
  )
);

CREATE INDEX cellular_reach_requests_tenant_status_retry_idx
  ON cellular_reach_requests (tenant_id, status, next_attempt_at);
CREATE INDEX cellular_reach_requests_tenant_created_idx
  ON cellular_reach_requests (tenant_id, created_at DESC);
CREATE INDEX cellular_reach_requests_tenant_phone_idx
  ON cellular_reach_requests (tenant_id, phone_number);
CREATE INDEX cellular_reach_requests_tenant_person_idx
  ON cellular_reach_requests (tenant_id, person_id);

-- Storage-level immutability: the substantive record is history; only
-- the lifecycle state may move (plus the one-way NULL→value assignment
-- of the authority-gate request id, which is filled on the first gate
-- call — the request id must exist before the gate's idempotency key can
-- reference it).

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
  THEN
    RAISE EXCEPTION 'cellular reach request substantive fields are immutable (W087 cellular): only the lifecycle state may move on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cellular_reach_requests_immutable
  BEFORE UPDATE OR DELETE ON cellular_reach_requests
  FOR EACH ROW EXECUTE FUNCTION cellular_reach_requests_guard();

CREATE TRIGGER cellular_reach_requests_immutable_truncate
  BEFORE TRUNCATE ON cellular_reach_requests
  FOR EACH STATEMENT EXECUTE FUNCTION cellular_reach_requests_guard();
