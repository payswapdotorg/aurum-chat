-- W068 · demo module — the seed-anchor registry of the demo harness.
--
-- The demo module is a HARNESS over the domain contracts, not a source of
-- organizational truth: it owns no business records. Its single table
-- records WHAT the harness seeded — one row per (tenant, journey, anchor)
-- pointing at the primary record id the anchor created, plus deterministic
-- secondary facts (metadata jsonb: the observation ids of a process case,
-- the pending request id of a cognition execution, ...).
--
-- Two jobs:
--   * IDEMPOTENCY — the harness checks an anchor before seeding, so a
--     re-run on the dev database replays nothing (deterministic data,
--     stable record ids across runs, resumable after partial failure);
--   * DIRECTORY — the browser-verification consumer (W070) reads the
--     anchors to deep-link straight into the seeded records.
--
-- Like every domain table it carries tenant_id (the tenant whose data the
-- anchor points into; ADR-0001). Rows are append-only by harness
-- convention: an anchor is never rewritten — a re-seed of the same anchor
-- is a skip, not an update.

CREATE TABLE demo_journey_anchors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  journey_id text NOT NULL CHECK (char_length(journey_id) BETWEEN 1 AND 64),
  anchor_key text NOT NULL CHECK (char_length(anchor_key) BETWEEN 1 AND 120),
  record_id text NOT NULL CHECK (char_length(record_id) BETWEEN 1 AND 255),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT demo_journey_anchors_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT demo_journey_anchors_anchor_unique UNIQUE (tenant_id, journey_id, anchor_key)
);

CREATE INDEX demo_journey_anchors_tenant_journey_idx
  ON demo_journey_anchors (tenant_id, journey_id, anchor_key);

CREATE INDEX demo_journey_anchors_tenant_created_idx
  ON demo_journey_anchors (tenant_id, created_at);
