-- W032 · briefings module — briefings and their sections.
--
-- BRIEFINGS are the immutable derived documents of W032 (lock 34 /
-- ADR-0010: "Management briefings are derived intelligence, not
-- authoritative source state"): one row per generation, carrying the
-- trigger that produced it, the inclusive coverage window, the
-- deterministic headline, and the BRIEFING-LEVEL POLICY SNAPSHOT that
-- governed the generation (where the policy came from, the cadence
-- window, the delivery recipient). Later policy edits never rewrite
-- what governed a recorded briefing.
--
-- The only post-write move — for ANY caller, even one bypassing the
-- service — is the one-way NULL→value assignment of
-- delivery_notification_id (filled after the W031 handoff created the
-- notification; the notifications module applies the same discipline to
-- its authority-gate request ids). The storage-level guard trigger
-- rejects DELETE/TRUNCATE outright and rejects any UPDATE that touches
-- a substantive field.
--
-- BRIEFING SECTIONS: one row per section kind per briefing — the
-- SECTION POLICY SNAPSHOT (source, enabled, item cap, lookback), the
-- section's effective window, the candidate count found before the cap
-- applied (honesty about truncation), and the bounded item list as
-- jsonb (each item: summary + deep links + typed detail; deep links
-- carry the reader to the full underlying records — briefings never
-- become authoritative state). Disabled sections record an empty row:
-- the briefing documents exactly what was off. Strictly append-only —
-- no UPDATE, DELETE or TRUNCATE, ever.
--
-- No cross-module foreign keys (the house pattern): delivery_notification_id
-- references the notifications module's record opaquely; section items
-- deep-link sibling-module records opaquely; idempotency_key is the
-- emitter-supplied generation key (first write wins, the events module's
-- discipline).

CREATE TABLE briefings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('on_demand', 'scheduled', 'system')),
  trigger_label text
    CHECK (trigger_label IS NULL OR char_length(trigger_label) BETWEEN 1 AND 200),
  window_from timestamptz NOT NULL,
  window_to timestamptz NOT NULL,
  generated_by text NOT NULL CHECK (generated_by <> ''),
  generated_at timestamptz NOT NULL,
  headline text NOT NULL CHECK (char_length(headline) BETWEEN 1 AND 200),
  policy_source text NOT NULL CHECK (policy_source IN ('tenant-default', 'built-in')),
  default_window_seconds integer NOT NULL
    CHECK (default_window_seconds BETWEEN 60 AND 2592000),
  delivery_recipient jsonb,
  delivery_notification_id uuid,
  idempotency_key text CHECK (
    idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$'
  ),
  updated_at timestamptz NOT NULL,
  CONSTRAINT briefings_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT briefings_idempotency_key_tenant_unique UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT briefings_window_ordered CHECK (window_from < window_to),
  CONSTRAINT briefings_delivery_recipient_shape CHECK (
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
  )
);

CREATE INDEX briefings_tenant_generated_idx
  ON briefings (tenant_id, generated_at DESC);
CREATE INDEX briefings_tenant_trigger_idx
  ON briefings (tenant_id, trigger_kind, generated_at DESC);
CREATE INDEX briefings_tenant_window_idx
  ON briefings (tenant_id, window_from, window_to);

CREATE TABLE briefing_sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  briefing_id uuid NOT NULL,
  section_kind text NOT NULL CHECK (section_kind IN (
    'changes', 'goal-drift', 'unknowns', 'risks', 'opportunities',
    'capability-gaps', 'workforce-performance', 'approvals'
  )),
  policy_source text NOT NULL CHECK (policy_source IN ('kind', 'tenant-default', 'built-in')),
  enabled boolean NOT NULL,
  max_items integer NOT NULL CHECK (max_items BETWEEN 1 AND 50),
  window_seconds integer NOT NULL CHECK (window_seconds BETWEEN 60 AND 2592000),
  window_from timestamptz NOT NULL,
  window_to timestamptz NOT NULL,
  candidate_count integer NOT NULL CHECK (candidate_count >= 0),
  item_count integer NOT NULL CHECK (item_count >= 0),
  items jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  CONSTRAINT briefing_sections_unique UNIQUE (tenant_id, briefing_id, section_kind),
  CONSTRAINT briefing_sections_window_ordered CHECK (window_from < window_to),
  CONSTRAINT briefing_sections_items_array CHECK (jsonb_typeof(items) = 'array'),
  CONSTRAINT briefing_sections_disabled_empty CHECK (
    enabled OR (item_count = 0 AND candidate_count = 0)
  ),
  CONSTRAINT briefing_sections_count_coherent CHECK (
    item_count <= max_items AND item_count <= candidate_count
  ),
  CONSTRAINT briefing_sections_items_bounded CHECK (
    char_length(items::text) <= 262144
  )
);

CREATE INDEX briefing_sections_tenant_briefing_idx
  ON briefing_sections (tenant_id, briefing_id, section_kind);

-- Storage-level immutability.
--
-- briefings: the substantive record is history; only the one-way
-- NULL→value assignment of the delivery notification id (and the
-- updated_at that moves with it) may ever change.

CREATE OR REPLACE FUNCTION briefings_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'briefings are immutable history (W032 briefings): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'briefings are immutable history (W032 briefings): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.trigger_kind <> OLD.trigger_kind
     OR NEW.trigger_label IS DISTINCT FROM OLD.trigger_label
     OR NEW.window_from <> OLD.window_from
     OR NEW.window_to <> OLD.window_to
     OR NEW.generated_by <> OLD.generated_by
     OR NEW.generated_at <> OLD.generated_at
     OR NEW.headline <> OLD.headline
     OR NEW.policy_source <> OLD.policy_source
     OR NEW.default_window_seconds <> OLD.default_window_seconds
     OR NEW.delivery_recipient IS DISTINCT FROM OLD.delivery_recipient
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR (OLD.delivery_notification_id IS NOT NULL
         AND NEW.delivery_notification_id IS DISTINCT FROM OLD.delivery_notification_id) THEN
    RAISE EXCEPTION 'briefings are immutable history (W032 briefings): only the one-way delivery_notification_id assignment (with updated_at) may change on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER briefings_state_only_updates
  BEFORE UPDATE OR DELETE ON briefings
  FOR EACH ROW EXECUTE FUNCTION briefings_guard();

CREATE TRIGGER briefings_immutable_truncate
  BEFORE TRUNCATE ON briefings
  FOR EACH STATEMENT EXECUTE FUNCTION briefings_guard();

-- briefing_sections: strictly append-only derived snapshots — no
-- UPDATE, DELETE or TRUNCATE, ever.

CREATE OR REPLACE FUNCTION briefing_sections_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only derived intelligence (W032 briefings): % is forbidden on table %',
    TG_TABLE_NAME, TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER briefing_sections_immutable
  BEFORE UPDATE OR DELETE ON briefing_sections
  FOR EACH ROW EXECUTE FUNCTION briefing_sections_reject_mutation();

CREATE TRIGGER briefing_sections_immutable_truncate
  BEFORE TRUNCATE ON briefing_sections
  FOR EACH STATEMENT EXECUTE FUNCTION briefing_sections_reject_mutation();
