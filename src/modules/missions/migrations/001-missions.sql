-- W011 · missions module — first-class learning missions.
--
-- ARCHITECTURE.md §6 (frozen): "A LearningMission is a persistent objective
-- for acquiring knowledge required by a goal, decision, risk or
-- opportunity." Lock 8: "LearningMission is first-class and is
-- goal/decision-driven." The work item:
-- "Implement first-class missions with knowledge objective, affected goals,
--  information value, urgency, target confidence, budget, candidate
--  sources/people, rewards and completion criteria."
--
-- Two tables, the goals module's (W008) split, deliberately identical in
-- discipline:
--
--   missions          — identity + the CURRENT version pointer. Carries no
--                       content: every field a caller can define lives in
--                       the version chain, so the current picture and the
--                       audit trail can never diverge. `current_version`
--                       advances by UPDATE (that is the pointer's only job);
--                       DELETE and TRUNCATE are rejected by trigger — a
--                       mission's identity and history are never erased
--                       (abandonment, a versioned terminal transition, is
--                       the retirement path; there is no delete operation
--                       on the contract either).
--
--   mission_versions  — the append-only AUDIT CHAIN: one row per version,
--                       each a FULL self-contained snapshot of the mission's
--                       content plus the audit quartet —
--                         * who   — actor (provider-neutral party: kind + id
--                                   or label, traceable) AND
--                                   changed_by_principal (the authenticated
--                                   TenantContext principal, system-minted);
--                         * when  — recorded_at (service clock, never
--                                   caller-supplied);
--                         * what  — change_kind (created/revised/completed/
--                                   abandoned, service-derived) + the full
--                                   content snapshot (any version decodes
--                                   without reading the others; diffs between
--                                   consecutive versions reconstruct exact
--                                   changes) + the completion record on
--                                   'completed' versions;
--                         * why   — rationale (revisions; abandonment
--                                   reasons) or the structured completion
--                                   outcome.
--                       UPDATE/DELETE/TRUNCATE are rejected by triggers —
--                       history cannot be rewritten even by a caller
--                       bypassing the service (same discipline as goal
--                       versions W008 and events W003).
--
-- Content columns mirror the §6/W011 definition:
--   title, knowledge_objective, completion_criteria — text fields (the
--     knowledge objective IS the mission's question);
--   affected_goals   — jsonb array of {goalId, label?}: opaque forward
--                      references to goals module (W008) records. No
--                      cross-module foreign keys (MODULE-DEPENDENCY-MAP.md
--                      sanctions `world + epistemics → missions` only) —
--                      the goals module's own evidence-source precedent;
--   unknown_ids      — jsonb array of epistemics unknown (W007) uuids,
--                      validated readable through the epistemics contract
--                      at write time (the sanctioned dependency), stored
--                      sorted and deduplicated;
--   information_value— expected information value, a comparable score in
--                      [0, 1] (double precision + CHECK);
--   urgency          — critical/high/medium/low (TEXT + CHECK,
--                      IMPLEMENTATION-STACK §8);
--   current_confidence / target_confidence — the confidence gap the
--                      mission closes ([0, 1]; CHECK target > current — a
--                      mission that closed its gap is COMPLETED, never
--                      silently revised past its target);
--   investigation_budget_amount/currency, reward_budget_amount/currency —
--                      integer minor units + ISO 4217-shaped currency code
--                      (IMPLEMENTATION-STACK §8 money convention);
--   reward_terms     — what is promised for a qualifying contribution
--                      (W043 RewardPolicy reads this);
--   candidate_sources— jsonb array of {kind, id?, label?} references to the
--                      acquisition menu of §7 (person/system/document/
--                      external/agent/analysis) — the W012 planner's menu;
--   status           — active/completed/abandoned (versioned content, so
--                      lifecycle changes are auditable like every other
--                      change);
--   achieved_confidence, completion_outcome — the completion record
--                      (§6 "outcome"), present on 'completed' versions
--                      only (CHECK-enforced).
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the composite
-- FK (mission_id, tenant_id) → missions (id, tenant_id) makes a
-- cross-tenant version unrepresentable in SQL even for a caller that
-- bypasses the service (same pattern as goal_versions, W008).

CREATE TABLE missions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT missions_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX missions_tenant_idx ON missions (tenant_id);

CREATE TABLE mission_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  mission_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  change_kind text NOT NULL CHECK (change_kind IN ('created', 'revised', 'completed', 'abandoned')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  knowledge_objective text NOT NULL CHECK (char_length(knowledge_objective) BETWEEN 1 AND 2000),
  affected_goals jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(affected_goals) = 'array'),
  unknown_ids jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(unknown_ids) = 'array'),
  information_value double precision NOT NULL
    CHECK (information_value >= 0 AND information_value <= 1),
  urgency text NOT NULL CHECK (urgency IN ('critical', 'high', 'medium', 'low')),
  current_confidence double precision NOT NULL
    CHECK (current_confidence >= 0 AND current_confidence <= 1),
  target_confidence double precision NOT NULL
    CHECK (target_confidence >= 0 AND target_confidence <= 1),
  investigation_budget_amount bigint NOT NULL
    CHECK (investigation_budget_amount >= 0),
  investigation_budget_currency text NOT NULL
    CHECK (investigation_budget_currency ~ '^[A-Z]{3}$'),
  reward_budget_amount bigint NOT NULL
    CHECK (reward_budget_amount >= 0),
  reward_budget_currency text NOT NULL
    CHECK (reward_budget_currency ~ '^[A-Z]{3}$'),
  reward_terms text
    CHECK (reward_terms IS NULL OR char_length(reward_terms) BETWEEN 1 AND 2000),
  candidate_sources jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(candidate_sources) = 'array'),
  completion_criteria text NOT NULL CHECK (char_length(completion_criteria) BETWEEN 1 AND 4000),
  status text NOT NULL CHECK (status IN ('active', 'completed', 'abandoned')),
  achieved_confidence double precision
    CHECK (achieved_confidence IS NULL OR (achieved_confidence >= 0 AND achieved_confidence <= 1)),
  completion_outcome text
    CHECK (completion_outcome IS NULL OR char_length(completion_outcome) BETWEEN 1 AND 4000),
  actor_kind text NOT NULL CHECK (actor_kind IN ('person', 'team', 'agent', 'system', 'external')),
  actor_id text,
  actor_label text,
  changed_by_principal text NOT NULL,
  rationale text
    CHECK (rationale IS NULL OR char_length(rationale) BETWEEN 1 AND 2000),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mission_versions_mission_version_unique UNIQUE (tenant_id, mission_id, version),
  CONSTRAINT mission_versions_mission_fk
    FOREIGN KEY (mission_id, tenant_id) REFERENCES missions (id, tenant_id),
  CONSTRAINT mission_versions_actor_traceable CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL),
  -- The confidence gap is a content invariant: a mission always closes a gap.
  CONSTRAINT mission_versions_confidence_gap
    CHECK (target_confidence > current_confidence),
  -- The completion record exists exactly on 'completed' versions, and a
  -- completion always records what confidence was achieved.
  CONSTRAINT mission_versions_completion_shape CHECK (
    (change_kind = 'completed' AND achieved_confidence IS NOT NULL)
    OR (change_kind <> 'completed' AND achieved_confidence IS NULL AND completion_outcome IS NULL)
  ),
  -- The version's status agrees with its change kind (transitions are
  -- surgical: 'completed' versions are completed missions, 'abandoned'
  -- versions are abandoned missions, everything else is active).
  CONSTRAINT mission_versions_status_agrees CHECK (
    (change_kind = 'completed' AND status = 'completed')
    OR (change_kind = 'abandoned' AND status = 'abandoned')
    OR (change_kind IN ('created', 'revised') AND status = 'active')
  )
);

-- History + current-view lookups: (tenant_id, mission_id, version) is covered
-- by the unique constraint above; these cover the management list filters.
CREATE INDEX mission_versions_mission_idx ON mission_versions (tenant_id, mission_id, version);
CREATE INDEX mission_versions_filters_idx ON mission_versions (tenant_id, status, urgency);
CREATE INDEX mission_versions_affected_goals_idx
  ON mission_versions USING gin (affected_goals jsonb_path_ops);
CREATE INDEX mission_versions_unknown_ids_idx
  ON mission_versions USING gin (unknown_ids jsonb_path_ops);
CREATE INDEX mission_versions_candidate_sources_idx
  ON mission_versions USING gin (candidate_sources jsonb_path_ops);

-- Storage-level audit guarantee: a mission's version history is append-only.
-- Nothing may UPDATE, DELETE or TRUNCATE a version — not even a future
-- module bypassing the service. The message deliberately names no row id so
-- the same function serves the row-level and the statement-level trigger.

CREATE OR REPLACE FUNCTION mission_versions_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'mission versions are append-only (W011 mission audit trail): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER mission_versions_immutable
  BEFORE UPDATE OR DELETE ON mission_versions
  FOR EACH ROW EXECUTE FUNCTION mission_versions_reject_mutation();

CREATE TRIGGER mission_versions_immutable_truncate
  BEFORE TRUNCATE ON mission_versions
  FOR EACH STATEMENT EXECUTE FUNCTION mission_versions_reject_mutation();

-- The missions identity row may advance its version pointer (UPDATE) — that
-- is how versioning moves — but identity and history are never erased.

CREATE OR REPLACE FUNCTION missions_reject_erasure() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'missions cannot be erased (W011): % is forbidden on table % — abandon the mission instead',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER missions_immutable_delete
  BEFORE DELETE ON missions
  FOR EACH ROW EXECUTE FUNCTION missions_reject_erasure();

CREATE TRIGGER missions_immutable_truncate
  BEFORE TRUNCATE ON missions
  FOR EACH STATEMENT EXECUTE FUNCTION missions_reject_erasure();
