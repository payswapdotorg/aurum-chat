-- W032 · briefings module — tenant-scoped briefing policies.
--
-- A briefing policy (W032: "policy-controlled ... briefings") declares
-- HOW briefings are generated: which sections are enabled, the item cap
-- and the lookback window per section — and, on the tenant-wide DEFAULT
-- row only, the briefing-level cadence window plus the delivery
-- recipient a generated briefing is pushed to through the notifications
-- module (W031).
--
-- Policies are keyed by section kind:
--   * section_kind — one of the eight W032 section kinds ('changes',
--     'goal-drift', 'unknowns', 'risks', 'opportunities',
--     'capability-gaps', 'workforce-performance', 'approvals'), or NULL
--     for the tenant-wide DEFAULT row;
--   * resolution (service layer): kind row → tenant-default row → the
--     built-in default policy (every section enabled, 20 items, a 24h
--     lookback, a 24h cadence window, no delivery push).
--
-- Policies are management controls, NOT evidence: they are legitimately
-- updatable (setBriefingPolicy upserts; updated_at moves) and therefore
-- carry NO immutability triggers. Their full change history belongs to
-- the audit module (W046), not W032 — the same discipline the
-- freshness, actions and notifications modules apply to their policy
-- tables.
--
-- DELIVERY COHERENCE (enforced here and in validation.ts): only the
-- DEFAULT row may carry a delivery_recipient — the briefing-level push
-- configuration lives in exactly one addressable place; a section-kind
-- row with a recipient is a configuration error, rejected outright.
-- delivery_recipient is a canonical channel party {provider,
-- providerAccountId, displayName?} — provider-neutral (ADR-0015), never
-- a provider object.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; one policy per
-- (tenant, kind) — UNIQUE NULLS NOT DISTINCT treats two NULL
-- section_kind rows as the same key (the default).

CREATE TABLE briefing_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  section_kind text CHECK (
    section_kind IS NULL OR section_kind IN (
      'changes', 'goal-drift', 'unknowns', 'risks', 'opportunities',
      'capability-gaps', 'workforce-performance', 'approvals'
    )
  ),
  enabled boolean NOT NULL,
  max_items integer NOT NULL CHECK (max_items BETWEEN 1 AND 50),
  window_seconds integer NOT NULL CHECK (window_seconds BETWEEN 60 AND 2592000),
  delivery_recipient jsonb,
  note text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT briefing_policies_subject_unique
    UNIQUE NULLS NOT DISTINCT (tenant_id, section_kind),
  CONSTRAINT briefing_policies_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT briefing_policies_note_shape CHECK (
    note IS NULL OR char_length(note) BETWEEN 1 AND 2000
  ),
  CONSTRAINT briefing_policies_delivery_recipient_shape CHECK (
    delivery_recipient IS NULL OR (
      jsonb_typeof(delivery_recipient) = 'object'
      AND delivery_recipient ? 'provider'
      AND delivery_recipient ? 'providerAccountId'
      AND jsonb_typeof(delivery_recipient->'provider') = 'string'
      AND jsonb_typeof(delivery_recipient->'providerAccountId') = 'string'
      AND (delivery_recipient->>'provider') IN (
        'whatsapp', 'telegram', 'signal', 'slack', 'x', 'instagram',
        'facebook', 'linkedin', 'email', 'sms', 'voice', 'web'
      )
      AND char_length(delivery_recipient->>'providerAccountId') BETWEEN 1 AND 255
      AND (
        NOT (delivery_recipient ? 'displayName')
        OR jsonb_typeof(delivery_recipient->'displayName') = 'null'
        OR (
          jsonb_typeof(delivery_recipient->'displayName') = 'string'
          AND char_length(delivery_recipient->>'displayName') BETWEEN 1 AND 200
        )
      )
    )
  ),
  CONSTRAINT briefing_policies_delivery_default_row_only CHECK (
    section_kind IS NULL OR delivery_recipient IS NULL
  )
);

CREATE INDEX briefing_policies_tenant_kind_idx
  ON briefing_policies (tenant_id, section_kind);
