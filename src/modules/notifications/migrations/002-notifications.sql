-- W031 · notifications module — notifications, delivery attempts
-- (audit), acknowledgments.
--
-- NOTIFICATIONS are the work items of W031: one row per notification
-- created for a recipient. The SUBSTANTIVE record (kind, recipient,
-- subject, body, data, dedupe key, provenance, and the RESOLVED POLICY
-- SNAPSHOT that governs its delivery — class, retry budget, dedupe
-- window, digest window, acknowledgment requirement, escalation
-- configuration, and where the policy came from) is immutable history the
-- moment it is written, exactly like an action request's evaluation
-- snapshot (W009): later policy edits never rewrite what governed an
-- already-recorded notification. Only the LIFECYCLE STATE may ever move,
-- and only forward:
--
--   pending ──▶ delivered ──▶ escalating ──▶ escalated
--      │            │              └───────▶ escalation_failed
--      ├──▶ failed  └─(escalation class, unacknowledged past deadline)
--      └──▶ blocked
--   suppressed (dedupe duplicate — terminal, set at creation)
--
--   * pending     — awaiting delivery (digest accumulation, retry backoff,
--                   or the W009 authority gate waiting for approval);
--   * delivered   — delivered to the recipient at least once;
--   * escalating  — escalation-class, unacknowledged past the deadline,
--                   escalation delivery in flight;
--   * escalated   — the escalation message was delivered;
--   * failed      — delivery attempts exhausted or permanently rejected;
--   * blocked     — the authority gate (W009) rejected delivery;
--   * suppressed  — a dedupe duplicate of a live notification; it is
--                   recorded for audit and never delivered;
--   * escalation_failed — the original delivery succeeded but the
--                   escalation delivery could not be completed.
--
-- Storage-level guarantees (mirroring action_requests, W009): the guard
-- trigger rejects DELETE/TRUNCATE outright and rejects any UPDATE that
-- touches a substantive field — only the lifecycle state (status,
-- attempts_count, escalation_attempts_count, next_attempt_at, delivered_at,
-- escalated_at, acknowledged_at, and the one-way NULL→value assignment of
-- the authority-gate request ids) may move, even for a caller bypassing
-- the service.
--
-- NOTIFICATION ATTEMPTS are the append-only delivery audit (W031
-- "…and audit"): one row per gate-evaluated delivery attempt — initial,
-- retry, digest or escalation — carrying the recipient it targeted, the
-- authority-gate decision that covered it, the outcome, and the
-- provider's receipt when one exists. Nothing may UPDATE, DELETE or
-- TRUNCATE an attempt.
--
-- NOTIFICATION ACKNOWLEDGMENTS are first-wins, append-only: exactly one
-- acknowledgment may exist per notification (UNIQUE), recording who
-- acknowledged, when, and an optional note. The notifications row
-- carries the derived acknowledged_at marker for cheap filtering; the
-- acknowledgment row is the truth.
--
-- No cross-module foreign keys (the house pattern): recipient/escalation
-- references are canonical channel parties (provider + opaque account id),
-- and action_request ids reference the actions module's requests
-- opaquely, like every sibling forward reference.

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  notification_kind text NOT NULL CHECK (notification_kind ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  recipient_provider text NOT NULL CHECK (recipient_provider IN (
    'whatsapp', 'telegram', 'signal', 'slack', 'x', 'instagram',
    'facebook', 'linkedin', 'email', 'sms', 'voice', 'web'
  )),
  recipient_account_id text NOT NULL
    CHECK (char_length(recipient_account_id) BETWEEN 1 AND 255),
  recipient_display_name text
    CHECK (recipient_display_name IS NULL OR char_length(recipient_display_name) BETWEEN 1 AND 200),
  connection_id uuid,
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4096),
  data jsonb,
  dedupe_key text CHECK (
    dedupe_key IS NULL OR dedupe_key ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$'
  ),
  deduped_of_id uuid,
  correlation_id text CHECK (
    correlation_id IS NULL OR (char_length(correlation_id) BETWEEN 1 AND 200)
  ),
  created_by text NOT NULL CHECK (created_by <> ''),
  created_at timestamptz NOT NULL,
  policy_source text NOT NULL CHECK (policy_source IN ('kind', 'tenant-default', 'built-in')),
  delivery_class text NOT NULL CHECK (delivery_class IN ('urgent', 'digest', 'escalation')),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
  retry_backoff_seconds integer NOT NULL CHECK (retry_backoff_seconds BETWEEN 1 AND 86400),
  dedupe_window_seconds integer NOT NULL CHECK (dedupe_window_seconds BETWEEN 0 AND 2592000),
  digest_window_seconds integer NOT NULL CHECK (digest_window_seconds BETWEEN 1 AND 2592000),
  require_acknowledgment boolean NOT NULL,
  escalation_after_seconds integer CHECK (
    escalation_after_seconds IS NULL OR escalation_after_seconds BETWEEN 1 AND 2592000
  ),
  escalation_recipient jsonb,
  status text NOT NULL CHECK (status IN (
    'pending', 'delivered', 'escalating', 'escalated',
    'failed', 'blocked', 'suppressed', 'escalation_failed'
  )),
  attempts_count integer NOT NULL DEFAULT 0 CHECK (attempts_count >= 0),
  escalation_attempts_count integer NOT NULL DEFAULT 0 CHECK (escalation_attempts_count >= 0),
  next_attempt_at timestamptz,
  delivered_at timestamptz,
  escalated_at timestamptz,
  acknowledged_at timestamptz,
  action_request_id uuid,
  escalation_action_request_id uuid,
  updated_at timestamptz NOT NULL,
  CONSTRAINT notifications_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT notifications_escalation_recipient_shape CHECK (
    escalation_recipient IS NULL OR (
      jsonb_typeof(escalation_recipient) = 'object'
      AND escalation_recipient ? 'provider'
      AND escalation_recipient ? 'providerAccountId'
      AND jsonb_typeof(escalation_recipient->'provider') = 'string'
      AND jsonb_typeof(escalation_recipient->'providerAccountId') = 'string'
      AND (escalation_recipient->>'provider') IN (
        'whatsapp', 'telegram', 'signal', 'slack', 'x', 'instagram',
        'facebook', 'linkedin', 'email', 'sms', 'voice', 'web'
      )
      AND char_length(escalation_recipient->>'providerAccountId') BETWEEN 1 AND 255
      AND (
        NOT (escalation_recipient ? 'displayName')
        OR jsonb_typeof(escalation_recipient->'displayName') = 'null'
        OR (
          jsonb_typeof(escalation_recipient->'displayName') = 'string'
          AND char_length(escalation_recipient->>'displayName') BETWEEN 1 AND 200
        )
      )
    )
  ),
  CONSTRAINT notifications_escalation_snapshot_coherent CHECK (
    (
      delivery_class = 'escalation'
      AND require_acknowledgment
      AND escalation_after_seconds IS NOT NULL
      AND escalation_recipient IS NOT NULL
    )
    OR (
      delivery_class <> 'escalation'
      AND escalation_after_seconds IS NULL
      AND escalation_recipient IS NULL
    )
  ),
  CONSTRAINT notifications_suppression_shape CHECK (
    (status = 'suppressed') = (deduped_of_id IS NOT NULL)
  ),
  CONSTRAINT notifications_suppressed_never_delivered CHECK (
    status <> 'suppressed' OR (delivered_at IS NULL AND escalated_at IS NULL)
  ),
  CONSTRAINT notifications_delivered_state_shape CHECK (
    (status IN ('delivered', 'escalating', 'escalated', 'escalation_failed'))
      = (delivered_at IS NOT NULL)
  ),
  CONSTRAINT notifications_escalated_state_shape CHECK (
    (status = 'escalated') = (escalated_at IS NOT NULL)
  ),
  CONSTRAINT notifications_acknowledgment_requires_delivery CHECK (
    acknowledged_at IS NULL OR delivered_at IS NOT NULL
  )
);

CREATE INDEX notifications_tenant_status_retry_idx
  ON notifications (tenant_id, status, next_attempt_at);
CREATE INDEX notifications_tenant_kind_created_idx
  ON notifications (tenant_id, notification_kind, created_at DESC);
CREATE INDEX notifications_tenant_recipient_idx
  ON notifications (tenant_id, recipient_provider, recipient_account_id);
CREATE INDEX notifications_tenant_dedupe_idx
  ON notifications (tenant_id, notification_kind, recipient_provider,
                    recipient_account_id, dedupe_key);
CREATE INDEX notifications_tenant_digest_cycle_idx
  ON notifications (tenant_id, delivery_class, status, created_at);
CREATE INDEX notifications_tenant_escalation_idx
  ON notifications (tenant_id, delivery_class, status, delivered_at);

CREATE TABLE notification_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  notification_id uuid NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  attempt_kind text NOT NULL CHECK (attempt_kind IN ('initial', 'retry', 'digest', 'escalation')),
  target text NOT NULL CHECK (target IN ('recipient', 'escalation')),
  provider text NOT NULL CHECK (provider IN (
    'whatsapp', 'telegram', 'signal', 'slack', 'x', 'instagram',
    'facebook', 'linkedin', 'email', 'sms', 'voice', 'web'
  )),
  provider_account_id text NOT NULL
    CHECK (char_length(provider_account_id) BETWEEN 1 AND 255),
  display_name text
    CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 200),
  outcome text NOT NULL CHECK (outcome IN (
    'delivered', 'transient_failure', 'permanent_failure', 'blocked'
  )),
  gate_status text NOT NULL CHECK (gate_status IN ('approved', 'rejected')),
  provider_message_id text
    CHECK (provider_message_id IS NULL OR char_length(provider_message_id) BETWEEN 1 AND 255),
  detail text,
  attempted_at timestamptz NOT NULL,
  CONSTRAINT notification_attempts_sequence_unique
    UNIQUE (tenant_id, notification_id, attempt_no)
);

CREATE INDEX notification_attempts_tenant_notification_idx
  ON notification_attempts (tenant_id, notification_id, attempt_no);

CREATE TABLE notification_acknowledgments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  notification_id uuid NOT NULL,
  acknowledged_by text NOT NULL CHECK (acknowledged_by <> ''),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
  acknowledged_at timestamptz NOT NULL,
  CONSTRAINT notification_acknowledgments_first_wins
    UNIQUE (tenant_id, notification_id)
);

-- Storage-level immutability.
--
-- notifications: the substantive record is history; only the lifecycle
-- state may move (plus the one-way NULL→value assignment of the
-- authority-gate request ids, which are filled on the first gate call —
-- the notification id must exist before the gate's idempotency key can
-- reference it).

CREATE OR REPLACE FUNCTION notifications_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'notifications are immutable history (W031 notifications): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'notifications are immutable history (W031 notifications): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.notification_kind <> OLD.notification_kind
     OR NEW.recipient_provider <> OLD.recipient_provider
     OR NEW.recipient_account_id <> OLD.recipient_account_id
     OR NEW.recipient_display_name IS DISTINCT FROM OLD.recipient_display_name
     OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
     OR NEW.subject <> OLD.subject
     OR NEW.body <> OLD.body
     OR NEW.data IS DISTINCT FROM OLD.data
     OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.created_by <> OLD.created_by
     OR NEW.created_at <> OLD.created_at
     OR NEW.policy_source <> OLD.policy_source
     OR NEW.delivery_class <> OLD.delivery_class
     OR NEW.max_attempts <> OLD.max_attempts
     OR NEW.retry_backoff_seconds <> OLD.retry_backoff_seconds
     OR NEW.dedupe_window_seconds <> OLD.dedupe_window_seconds
     OR NEW.digest_window_seconds <> OLD.digest_window_seconds
     OR NEW.require_acknowledgment <> OLD.require_acknowledgment
     OR NEW.escalation_after_seconds IS DISTINCT FROM OLD.escalation_after_seconds
     OR NEW.escalation_recipient IS DISTINCT FROM OLD.escalation_recipient
     OR NEW.deduped_of_id IS DISTINCT FROM OLD.deduped_of_id
     OR (OLD.action_request_id IS NOT NULL AND NEW.action_request_id IS DISTINCT FROM OLD.action_request_id)
     OR (OLD.escalation_action_request_id IS NOT NULL AND NEW.escalation_action_request_id IS DISTINCT FROM OLD.escalation_action_request_id) THEN
    RAISE EXCEPTION 'notifications are immutable history (W031 notifications): only the lifecycle state (status, attempt counters, next_attempt_at, delivered_at, escalated_at, acknowledged_at, first gate-request ids) may change on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER notifications_state_only_updates
  BEFORE UPDATE OR DELETE ON notifications
  FOR EACH ROW EXECUTE FUNCTION notifications_guard();

CREATE TRIGGER notifications_immutable_truncate
  BEFORE TRUNCATE ON notifications
  FOR EACH STATEMENT EXECUTE FUNCTION notifications_guard();

-- notification_attempts / notification_acknowledgments: strictly
-- append-only audit evidence — no UPDATE, DELETE or TRUNCATE, ever.

CREATE OR REPLACE FUNCTION notification_audit_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only audit evidence (W031 notifications): % is forbidden on table %',
    TG_TABLE_NAME, TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER notification_attempts_immutable
  BEFORE UPDATE OR DELETE ON notification_attempts
  FOR EACH ROW EXECUTE FUNCTION notification_audit_reject_mutation();

CREATE TRIGGER notification_attempts_immutable_truncate
  BEFORE TRUNCATE ON notification_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION notification_audit_reject_mutation();

CREATE TRIGGER notification_acknowledgments_immutable
  BEFORE UPDATE OR DELETE ON notification_acknowledgments
  FOR EACH ROW EXECUTE FUNCTION notification_audit_reject_mutation();

CREATE TRIGGER notification_acknowledgments_immutable_truncate
  BEFORE TRUNCATE ON notification_acknowledgments
  FOR EACH STATEMENT EXECUTE FUNCTION notification_audit_reject_mutation();
