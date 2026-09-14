-- W006 · freshness module — tenant-scoped stale-after policies.
--
-- A stale-after policy (ARCHITECTURE.md §11) declares how long evidence or
-- understanding of a subject stays current, when it is merely aging, and
-- (optionally) the maximum ingestion latency an observation of it may
-- carry without being flagged. Policies are keyed by subject:
--   * subject_kind — canonical slug namespace shared by all consumers
--     ('source' for source-scoped rules, observation kinds such as
--     'metric.sample' for per-kind observation rules, later
--     'world.relationship' / 'epistemics.belief' / environment-watch kinds);
--   * subject_id   — a specific subject uuid, or NULL for the kind-wide
--     default. Resolution (service layer): exact first, then the default.
--
-- Policies are management controls, NOT evidence: they are legitimately
-- updatable (setFreshnessPolicy upserts; updated_at moves) and therefore
-- carry NO immutability triggers. Their full change history belongs to the
-- audit module (W046), not to W006.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; one policy per
-- (tenant, subject) — UNIQUE NULLS NOT DISTINCT treats two NULL subject_id
-- rows for the same kind as the same key.

CREATE TABLE freshness_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  subject_kind text NOT NULL,
  subject_id uuid,
  stale_after_seconds integer NOT NULL
    CHECK (stale_after_seconds > 0),
  aging_after_seconds integer
    CHECK (aging_after_seconds IS NULL OR
           (aging_after_seconds > 0 AND aging_after_seconds < stale_after_seconds)),
  max_latency_seconds integer
    CHECK (max_latency_seconds IS NULL OR max_latency_seconds > 0),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT freshness_policies_subject_unique
    UNIQUE NULLS NOT DISTINCT (tenant_id, subject_kind, subject_id)
);

CREATE INDEX freshness_policies_tenant_kind_idx
  ON freshness_policies (tenant_id, subject_kind);
