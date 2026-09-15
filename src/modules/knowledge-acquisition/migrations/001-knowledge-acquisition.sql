-- W012 · knowledge-acquisition module — the Knowledge Acquisition Planner.
--
-- ARCHITECTURE.md §7 (frozen): "Aurum has a Knowledge Acquisition Planner
-- that selects among employees, managers, internal systems, documents,
-- messages, structured business systems, external sources, agents and
-- temporary analyses." Lock 17: "Knowledge Acquisition Planner decides
-- where to investigate next; it does not blindly query all sources."
-- The work item: "Choose the next information source/action among
-- employees, managers, systems, documents, external sources, agents and
-- analyses. Verify mission-driven targeted employee questioning."
--
-- Two tables, both append-only evidence of how Aurum investigated:
--
--   acquisition_plans    — one row per planner decision: WHICH source to
--                          acquire from next and WHY (the persisted,
--                          auditable ADR-0018 ranking rationale). Carries
--                          the mission reference (opaque forward reference
--                          to a missions module W011 record, validated
--                          readable through the missions contract at write
--                          time — no cross-module foreign key, the
--                          missions module's own unknown-ref precedent)
--                          plus the mission version the plan was computed
--                          against, the deterministic decision
--                          ('selected' with its chosen candidate + mapped
--                          action + composed question + ASK policy
--                          evaluation, or 'no_candidate'), the full ranked
--                          signal snapshot (jsonb: per-candidate signals,
--                          score, cost share, dominant signal, exclusion),
--                          the budget accounting (remaining minor units
--                          BEFORE this plan's commitment + the chosen
--                          candidate's estimated cost) and the audit
--                          quartet (actor party + authenticated principal,
--                          recorded_at, decision content, rationale).
--
--   acquisition_outcomes — the terminal outcome of one plan (answered /
--                          unavailable / failed), first-write-wins via
--                          UNIQUE (tenant_id, plan_id). An 'answered'
--                          outcome requires an evidence observation id
--                          (the answer was recorded as immutable evidence
--                          through the observations contract, W004);
--                          'unavailable'/'failed' require a note —
--                          terminal outcomes record their why.
--
-- Both tables reject UPDATE/DELETE/TRUNCATE by trigger: planner decisions
-- and their outcomes are history the moment they are committed (the
-- missions/events discipline). There is no operation on the contract to
-- rewrite a plan or un-answer an acquisition either.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the composite
-- FK (plan_id, tenant_id) → acquisition_plans (id, tenant_id) makes a
-- cross-tenant outcome unrepresentable in SQL even for a caller that
-- bypasses the service (the mission_versions pattern).

CREATE TABLE acquisition_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  mission_id uuid NOT NULL,
  mission_version integer NOT NULL CHECK (mission_version >= 1),
  decision text NOT NULL CHECK (decision IN ('selected', 'no_candidate')),
  chosen_kind text
    CHECK (chosen_kind IN ('person', 'system', 'document', 'external', 'agent', 'analysis')),
  chosen_id text
    CHECK (chosen_id IS NULL OR chosen_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  chosen_label text
    CHECK (chosen_label IS NULL OR char_length(chosen_label) BETWEEN 1 AND 200),
  action text
    CHECK (action IN ('ask-person', 'query-system', 'retrieve-document', 'fetch-external', 'commission-agent', 'run-analysis')),
  question text
    CHECK (question IS NULL OR char_length(question) BETWEEN 1 AND 4000),
  ask_policy_outcome text
    CHECK (ask_policy_outcome IN ('allowed', 'approval_required', 'forbidden')),
  ask_policy_source text
    CHECK (ask_policy_source IN ('kind', 'tenant-default', 'built-in')),
  ranked jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(ranked) = 'array'),
  budget_remaining bigint NOT NULL CHECK (budget_remaining >= 0),
  budget_currency text NOT NULL
    CHECK (budget_currency ~ '^[A-Z]{3}$'),
  estimated_cost bigint
    CHECK (estimated_cost IS NULL OR estimated_cost >= 0),
  actor_kind text NOT NULL CHECK (actor_kind IN ('person', 'team', 'agent', 'system', 'external')),
  actor_id text,
  actor_label text,
  planned_by_principal text NOT NULL,
  rationale text
    CHECK (rationale IS NULL OR char_length(rationale) BETWEEN 1 AND 2000),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  -- The decision shape is surgical: a 'selected' plan carries a traceable
  -- chosen candidate, a mapped action and an estimated cost; a
  -- 'no_candidate' plan carries none of them.
  CONSTRAINT acquisition_plans_decision_shape CHECK (
    (decision = 'selected'
       AND chosen_kind IS NOT NULL AND action IS NOT NULL AND estimated_cost IS NOT NULL
       AND (chosen_id IS NOT NULL OR chosen_label IS NOT NULL))
    OR (decision = 'no_candidate'
       AND chosen_kind IS NULL AND chosen_id IS NULL AND chosen_label IS NULL
       AND action IS NULL AND question IS NULL AND estimated_cost IS NULL)
  ),
  -- The targeted question exists exactly on 'ask-person' plans, and every
  -- 'ask-person' plan records the ASK authority evaluation that governed
  -- it (§7 "when policy permits"). Non-ask actions never carry one.
  CONSTRAINT acquisition_plans_question_shape CHECK (
    (action = 'ask-person' AND question IS NOT NULL
       AND ask_policy_outcome IS NOT NULL AND ask_policy_source IS NOT NULL)
    OR (action IS NOT NULL AND action <> 'ask-person' AND question IS NULL)
    OR (action IS NULL AND question IS NULL)
  ),
  -- The ASK policy evaluation columns are a pair: both present or both absent.
  CONSTRAINT acquisition_plans_ask_policy_pair CHECK (
    (ask_policy_outcome IS NULL) = (ask_policy_source IS NULL)
  ),
  -- The acting party is traceable (the missions actor rule).
  CONSTRAINT acquisition_plans_actor_traceable CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL),
  -- The composite target of acquisition_outcomes' tenant-scoped FK.
  CONSTRAINT acquisition_plans_id_tenant_unique UNIQUE (id, tenant_id)
);

-- Planner history per mission (attempt detection + budget accounting) and
-- the management filters.
CREATE INDEX acquisition_plans_mission_idx ON acquisition_plans (tenant_id, mission_id, recorded_at);
CREATE INDEX acquisition_plans_filters_idx ON acquisition_plans (tenant_id, decision, action);

CREATE TABLE acquisition_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('answered', 'unavailable', 'failed')),
  note text
    CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
  evidence_observation_id text,
  recorded_by_principal text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  -- First outcome wins: one terminal outcome per plan.
  CONSTRAINT acquisition_outcomes_plan_unique UNIQUE (tenant_id, plan_id),
  CONSTRAINT acquisition_outcomes_plan_fk
    FOREIGN KEY (plan_id, tenant_id) REFERENCES acquisition_plans (id, tenant_id),
  -- An answered acquisition carries its evidence observation; the other
  -- outcomes never do.
  CONSTRAINT acquisition_outcomes_evidence_shape CHECK (
    (outcome = 'answered' AND evidence_observation_id IS NOT NULL)
    OR (outcome <> 'answered' AND evidence_observation_id IS NULL)
  ),
  -- Terminal outcomes other than 'answered' record their why.
  CONSTRAINT acquisition_outcomes_note_shape CHECK (
    outcome = 'answered' OR (note IS NOT NULL AND char_length(note) >= 1)
  )
);

CREATE INDEX acquisition_outcomes_plan_idx ON acquisition_outcomes (tenant_id, plan_id);

-- Storage-level audit guarantee: planner decisions are append-only.
-- Nothing may UPDATE, DELETE or TRUNCATE a plan — not even a future
-- module bypassing the service. The message deliberately names no row id
-- so the same function serves the row-level and the statement-level
-- trigger.

CREATE OR REPLACE FUNCTION acquisition_plans_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'acquisition plans are append-only (W012 planner rationale): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER acquisition_plans_immutable
  BEFORE UPDATE OR DELETE ON acquisition_plans
  FOR EACH ROW EXECUTE FUNCTION acquisition_plans_reject_mutation();

CREATE TRIGGER acquisition_plans_immutable_truncate
  BEFORE TRUNCATE ON acquisition_plans
  FOR EACH STATEMENT EXECUTE FUNCTION acquisition_plans_reject_mutation();

-- Outcomes are append-only too (first write wins; there is no un-answer).

CREATE OR REPLACE FUNCTION acquisition_outcomes_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'acquisition outcomes are append-only (W012): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER acquisition_outcomes_immutable
  BEFORE UPDATE OR DELETE ON acquisition_outcomes
  FOR EACH ROW EXECUTE FUNCTION acquisition_outcomes_reject_mutation();

CREATE TRIGGER acquisition_outcomes_immutable_truncate
  BEFORE TRUNCATE ON acquisition_outcomes
  FOR EACH STATEMENT EXECUTE FUNCTION acquisition_outcomes_reject_mutation();
