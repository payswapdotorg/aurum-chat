-- W008 · goals module — versioned management goals and desired state.
--
-- ARCHITECTURE.md §5 (frozen): "Management defines goals with objective,
-- desired state, metric/threshold, horizon, owner, priority, evidence
-- sources and success criteria. Goals are versioned and auditable."
-- Lock 13: goals and desired states are distinct from beliefs and attention
-- policy — this module owns direction, not epistemics (W007) and not
-- attention (W033 surfaces). Lock 3: every row is tenant-scoped.
--
-- Two tables, deliberately split:
--
--   goals        — identity + the CURRENT version pointer. Carries no
--                  content: every field a manager can define lives in the
--                  version chain, so the current picture and the audit
--                  trail can never diverge. `current_version` advances by
--                  UPDATE (that is the pointer's only job); DELETE and
--                  TRUNCATE are rejected by trigger — a goal's identity and
--                  history are never erased (archival, a versioned status
--                  change, is the retirement path; there is no delete
--                  operation on the contract either).
--
--   goal_versions— the append-only AUDIT CHAIN (the "versioned and
--                  auditable" of §5, and the W008 acceptance "verify goal
--                  changes are auditable"): one row per version, each a
--                  FULL self-contained snapshot of the goal's content plus
--                  the audit quartet —
--                    * who   — actor (provider-neutral party: kind + id or
--                              label, traceable) AND changed_by_principal
--                              (the authenticated TenantContext principal,
--                              system-minted, not caller-suppliable);
--                    * when  — recorded_at (service clock, never
--                              caller-supplied);
--                    * what  — change_kind (created/revised/archived/
--                              reactivated, service-derived) + the full
--                              content snapshot (any version is decodable
--                              without reading the others; diffs between
--                              consecutive versions reconstruct exact
--                              changes);
--                    * why   — rationale (free text, optional).
--                  UPDATE/DELETE/TRUNCATE are rejected by triggers —
--                  history cannot be rewritten even by a caller bypassing
--                  the service (same discipline as events W003 and
--                  temporal_revisions W006).
--
-- Content columns mirror the §5 definition:
--   title, objective, desired_state, success_criteria — text fields;
--   metrics           — jsonb array of {name, unit?, direction,
--                        threshold?/lowerBound?+upperBound?}: a goal's
--                        metric/threshold definitions (shape validated by
--                        the service; SQL checks the array type);
--   horizon_start/end — the horizon window (end required, start strictly
--                        before end when present — CHECK'd here as well);
--   owner             — jsonb provider-neutral party {kind, id?, label?};
--   priority          — critical/high/medium/low (TEXT + CHECK,
--                        IMPLEMENTATION-STACK §8);
--   evidence_sources  — jsonb array of {kind, id?, label?} references to
--                        the sources/people/systems that bear evidence on
--                        this goal (unverified forward references — the
--                        owning modules stay owners; no cross-module FKs,
--                        MODULE-DEPENDENCY-MAP.md);
--   status            — active/archived (versioned content, so lifecycle
--                        changes are auditable like every other change;
--                        ADR-0017 speaks of "active goals").
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the composite
-- FK (goal_id, tenant_id) → goals (id, tenant_id) makes a cross-tenant
-- version unrepresentable in SQL even for a caller that bypasses the
-- service (same pattern as world_relationships, W005).

CREATE TABLE goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT goals_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX goals_tenant_idx ON goals (tenant_id);

CREATE TABLE goal_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  goal_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  change_kind text NOT NULL CHECK (change_kind IN ('created', 'revised', 'archived', 'reactivated')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  objective text NOT NULL CHECK (char_length(objective) BETWEEN 1 AND 2000),
  desired_state text NOT NULL CHECK (char_length(desired_state) BETWEEN 1 AND 4000),
  metrics jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(metrics) = 'array'),
  horizon_start timestamptz,
  horizon_end timestamptz NOT NULL,
  owner jsonb NOT NULL
    CHECK (jsonb_typeof(owner) = 'object'),
  priority text NOT NULL CHECK (priority IN ('critical', 'high', 'medium', 'low')),
  evidence_sources jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence_sources) = 'array'),
  success_criteria text NOT NULL CHECK (char_length(success_criteria) BETWEEN 1 AND 4000),
  status text NOT NULL CHECK (status IN ('active', 'archived')),
  actor_kind text NOT NULL CHECK (actor_kind IN ('person', 'team', 'agent', 'system', 'external')),
  actor_id text,
  actor_label text,
  changed_by_principal text NOT NULL,
  rationale text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT goal_versions_goal_version_unique UNIQUE (tenant_id, goal_id, version),
  CONSTRAINT goal_versions_goal_fk
    FOREIGN KEY (goal_id, tenant_id) REFERENCES goals (id, tenant_id),
  CONSTRAINT goal_versions_actor_traceable CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL),
  CONSTRAINT goal_versions_horizon_ordered
    CHECK (horizon_start IS NULL OR horizon_start < horizon_end)
);

-- History + current-view lookups: (tenant_id, goal_id, version) is covered
-- by the unique constraint above; these cover the management list filters.
CREATE INDEX goal_versions_goal_idx ON goal_versions (tenant_id, goal_id, version);
CREATE INDEX goal_versions_filters_idx ON goal_versions (tenant_id, status, priority);
CREATE INDEX goal_versions_horizon_idx ON goal_versions (tenant_id, horizon_end);
CREATE INDEX goal_versions_owner_idx
  ON goal_versions (tenant_id, (owner->>'kind'), (owner->>'id'));

-- Storage-level audit guarantee: a goal's version history is append-only.
-- Nothing may UPDATE, DELETE or TRUNCATE a version — not even a future
-- module bypassing the service. The message deliberately names no row id so
-- the same function serves the row-level and the statement-level trigger.

CREATE OR REPLACE FUNCTION goal_versions_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'goal versions are append-only (W008 goal audit trail): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER goal_versions_immutable
  BEFORE UPDATE OR DELETE ON goal_versions
  FOR EACH ROW EXECUTE FUNCTION goal_versions_reject_mutation();

CREATE TRIGGER goal_versions_immutable_truncate
  BEFORE TRUNCATE ON goal_versions
  FOR EACH STATEMENT EXECUTE FUNCTION goal_versions_reject_mutation();

-- The goals identity row may advance its version pointer (UPDATE) — that is
-- how versioning moves — but identity and history are never erased.

CREATE OR REPLACE FUNCTION goals_reject_erasure() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'goals cannot be erased (W008): % is forbidden on table % — archive the goal instead',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER goals_immutable_delete
  BEFORE DELETE ON goals
  FOR EACH ROW EXECUTE FUNCTION goals_reject_erasure();

CREATE TRIGGER goals_immutable_truncate
  BEFORE TRUNCATE ON goals
  FOR EACH STATEMENT EXECUTE FUNCTION goals_reject_erasure();
