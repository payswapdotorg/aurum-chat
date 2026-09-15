-- W031 · notifications module — tenant-scoped notification policies.
--
-- A notification policy (W031: "policy-controlled urgent/digest/escalation
-- notification delivery") declares HOW notifications of one kind are
-- delivered: their delivery class (urgent = immediate delivery with
-- retries; digest = accumulated per (kind, recipient) and delivered as one
-- combined message per digest window; escalation = immediate delivery that
-- demands acknowledgment and escalates to a fallback recipient when the
-- deadline passes unacknowledged), the retry budget and backoff, the
-- dedupe window, the digest window, whether acknowledgment is required,
-- and — for the escalation class — the escalation deadline and recipient.
--
-- Policies are keyed by notification kind:
--   * notification_kind — the canonical slug the row governs
--     ('approval.requested', 'goal.drift', … any canonical slug; the
--     namespace is open exactly like the actions module's action kinds),
--     or NULL for the tenant-wide DEFAULT row;
--   * resolution (service layer): kind row → tenant-default row → the
--     built-in default policy (urgent, 3 attempts, 60s backoff, 300s
--     dedupe window, 3600s digest window, no acknowledgment, no
--     escalation).
--
-- Policies are management controls, NOT evidence: they are legitimately
-- updatable (setNotificationPolicy upserts; updated_at moves) and
-- therefore carry NO immutability triggers. Their full change history
-- belongs to the audit module (W046), not W031 — the same discipline the
-- freshness and actions modules apply to their policy tables.
--
-- ESCALATION COHERENCE (enforced here and in validation.ts): a row of
-- class 'escalation' MUST require acknowledgment and carry both the
-- deadline and the fallback recipient; a row of any other class must carry
-- NONE of the escalation configuration (inert configuration invites
-- confusion — a policy change to the escalation class is explicit and
-- atomic). `escalation_recipient` is a canonical channel party
-- {provider, providerAccountId, displayName?} — provider-neutral (ADR-0015),
-- never a provider object.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; one policy per
-- (tenant, kind) — UNIQUE NULLS NOT DISTINCT treats two NULL
-- notification_kind rows as the same key (the default).

CREATE TABLE notification_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  notification_kind text CHECK (
    notification_kind IS NULL OR notification_kind ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
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
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_policies_subject_unique
    UNIQUE NULLS NOT DISTINCT (tenant_id, notification_kind),
  CONSTRAINT notification_policies_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT notification_policies_kind_shape CHECK (
    notification_kind IS NULL OR char_length(notification_kind) BETWEEN 1 AND 128
  ),
  CONSTRAINT notification_policies_note_shape CHECK (
    note IS NULL OR char_length(note) BETWEEN 1 AND 2000
  ),
  CONSTRAINT notification_policies_escalation_recipient_shape CHECK (
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
  CONSTRAINT notification_policies_escalation_coherent CHECK (
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
  )
);

CREATE INDEX notification_policies_tenant_kind_idx
  ON notification_policies (tenant_id, notification_kind);
