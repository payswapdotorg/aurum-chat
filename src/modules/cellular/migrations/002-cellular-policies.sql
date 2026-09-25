-- W087 · cellular module — tenant-scoped cellular policies (the routing/
-- cost controls).
--
-- A cellular policy (W087: "routing, cost and policy controls") declares
-- HOW a reach kind behaves: whether the SMS leg may fall back to a voice
-- call when it terminally fails ('forbidden' — the conservative built-in
-- default — or 'on_sms_failure', the work item's "falls back to voice
-- when policy permits"), the SMS retry budget and backoff, the SMS
-- segment limit, the COST MODEL (per-segment SMS rate, per-minute voice
-- rate, ISO 4217 currency — integer minor units, IMPLEMENTATION-STACK
-- §8) and the lifetime cost cap per reach request (0 = uncapped).
--
-- Policies are keyed by reach kind:
--   * reach_kind — 'tell' | 'ask', or NULL for the tenant-wide DEFAULT
--     row governing every kind without its own row;
--   * resolution (service layer): kind row → tenant-default row → the
--     built-in default policy (voice fallback forbidden, 3 SMS attempts,
--     60s backoff, 4-segment budget, modest USD rates, 1000-minor cap).
--
-- Policies are management controls, NOT evidence: they are legitimately
-- updatable (setCellularPolicy upserts; updated_at moves) and therefore
-- carry NO immutability triggers. Their full change history belongs to
-- the audit module (W046), not W087 — the same discipline the
-- notifications and actions modules apply to their policy tables.
--
-- Every reach request SNAPSHOTS the resolved policy at creation
-- (migration 003), so later policy edits never rewrite what governs a
-- recorded request — the notifications module's snapshot discipline.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; one policy per
-- (tenant, kind) — UNIQUE NULLS NOT DISTINCT treats two NULL reach_kind
-- rows as the same key (the default).

CREATE TABLE cellular_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  reach_kind text CHECK (reach_kind IS NULL OR reach_kind IN ('tell', 'ask')),
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
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cellular_policies_subject_unique
    UNIQUE NULLS NOT DISTINCT (tenant_id, reach_kind),
  CONSTRAINT cellular_policies_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT cellular_policies_kind_shape CHECK (
    reach_kind IS NULL OR char_length(reach_kind) BETWEEN 1 AND 8
  )
);

CREATE INDEX cellular_policies_tenant_kind_idx
  ON cellular_policies (tenant_id, reach_kind);
