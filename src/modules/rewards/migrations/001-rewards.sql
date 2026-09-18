-- W043 · rewards module — explicit reward policies for valuable knowledge
-- contributions.
--
-- ARCHITECTURE.md §8 (frozen): "KnowledgeContribution records what
-- information an employee supplied, the associated evidence, validation
-- outcome, knowledge gain, goal impact and investigation cost avoided.
-- RewardPolicy converts contribution value into configured rewards." And:
-- "Rewards must never silently become compensation decisions or
-- performance ratings. Contribution rewards are a separate policy-
-- controlled mechanism." Lock 9: "useful knowledge contributions may be
-- rewarded under explicit policy."
--
-- Three tables:
--
--   reward_policies    — the tenant's ONE explicit conversion policy
--                        (management control, deliberately updatable like
--                        the actions module's authority policies: change
--                        history belongs to audit, W046). One row per
--                        tenant; `version` increments on every update.
--                        Until a row exists rewards are refused outright
--                        (policy_not_configured): rewards exist only under
--                        an EXPLICIT policy.
--
--   rewards            — ONE append-only configured-reward record per
--                        knowledge contribution (UNIQUE (tenant_id,
--                        contribution_kind, contribution_id)): the frozen
--                        §8 value assessment, the frozen policy snapshot +
--                        matched tier, the mission reward-budget accounting
--                        (the missions module's rewardBudget/rewardTerms —
--                        its types anticipate exactly this read), the
--                        actions-module authority evaluation that gated the
--                        grant (§20), the minted status ('granted' when the
--                        matrix allowed, 'proposed' when gated, 'refused'
--                        when forbidden) and the audit quartet.
--
--   reward_settlements — the ONE terminal settlement of a gated reward
--                        (first write wins, UNIQUE (tenant_id, reward_id)):
--                        the frozen consumption of the actions module's
--                        human decision on the reward's action request
--                        ('granted' / 'declined').
--
-- rewards and reward_settlements reject UPDATE/DELETE/TRUNCATE by trigger:
-- what a policy decided, what it configured, what budget it committed and
-- how the gate resolved are history the moment they are committed (the
-- missions/events/planner discipline). There is no operation on the
-- contract to rewrite a reward, un-settle or delete anything either.
--
-- COMPENSATION SEPARATION (the item's second sentence): reward_kind is
-- CHECK-constrained to the closed non-compensation vocabulary
-- (recognition/gift/voucher/experience/donation) — salary, bonus,
-- commission, raise, promotion, merit and performance-rating shapes are
-- unrepresentable at the storage layer, and no compensation or performance
-- field exists on any of these tables.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the composite
-- FK (reward_id, tenant_id) → rewards (id, tenant_id) makes a cross-tenant
-- settlement unrepresentable in SQL even for a caller that bypasses the
-- service (the mission_versions pattern).

CREATE TABLE reward_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE,
  version integer NOT NULL CHECK (version >= 1),
  qualifying_statuses jsonb NOT NULL
    CHECK (jsonb_typeof(qualifying_statuses) = 'array' AND jsonb_array_length(qualifying_statuses) >= 1),
  min_knowledge_gain double precision NOT NULL
    CHECK (min_knowledge_gain >= 0 AND min_knowledge_gain <= 1),
  min_affected_goals integer NOT NULL
    CHECK (min_affected_goals >= 0),
  weight_knowledge_gain double precision NOT NULL
    CHECK (weight_knowledge_gain >= 0 AND weight_knowledge_gain <= 1),
  weight_mission_impact double precision NOT NULL
    CHECK (weight_mission_impact >= 0 AND weight_mission_impact <= 1),
  weight_cost_avoided double precision NOT NULL
    CHECK (weight_cost_avoided >= 0 AND weight_cost_avoided <= 1),
  impact_weight_advanced double precision NOT NULL
    CHECK (impact_weight_advanced >= 0 AND impact_weight_advanced <= 1),
  impact_weight_resolved double precision NOT NULL
    CHECK (impact_weight_resolved >= 0 AND impact_weight_resolved <= 1),
  impact_weight_no_effect double precision NOT NULL
    CHECK (impact_weight_no_effect >= 0 AND impact_weight_no_effect <= 1),
  cost_avoided_saturation bigint NOT NULL
    CHECK (cost_avoided_saturation >= 1),
  tiers jsonb NOT NULL
    CHECK (jsonb_typeof(tiers) = 'array' AND jsonb_array_length(tiers) >= 1),
  reward_currency text NOT NULL
    CHECK (reward_currency ~ '^[A-Z]{3}$'),
  note text
    CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
  updated_by_principal text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rewards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  contribution_kind text NOT NULL
    CHECK (contribution_kind IN ('acquisition-plan', 'knowledge-contribution')),
  contribution_id uuid NOT NULL,
  contribution_label text
    CHECK (contribution_label IS NULL OR char_length(contribution_label) BETWEEN 1 AND 200),
  contributor_person_id uuid NOT NULL,
  contributor_label text
    CHECK (contributor_label IS NULL OR char_length(contributor_label) BETWEEN 1 AND 200),
  mission_id uuid NOT NULL,
  mission_version integer NOT NULL CHECK (mission_version >= 1),
  mission_reward_budget_amount bigint NOT NULL
    CHECK (mission_reward_budget_amount >= 0),
  mission_reward_budget_currency text NOT NULL
    CHECK (mission_reward_budget_currency ~ '^[A-Z]{3}$'),
  mission_reward_terms text
    CHECK (mission_reward_terms IS NULL OR char_length(mission_reward_terms) BETWEEN 1 AND 2000),
  contribution_status text NOT NULL
    CHECK (contribution_status IN ('pending', 'validated', 'contradicted', 'rejected', 'measured')),
  knowledge_gain double precision NOT NULL
    CHECK (knowledge_gain >= 0 AND knowledge_gain <= 1),
  mission_impact_kind text NOT NULL
    CHECK (mission_impact_kind IN ('advanced', 'resolved', 'no_effect')),
  affected_goals jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(affected_goals) = 'array'),
  cost_avoided_amount bigint NOT NULL
    CHECK (cost_avoided_amount >= 0),
  cost_avoided_currency text NOT NULL
    CHECK (cost_avoided_currency ~ '^[A-Z]{3}$'),
  value_score double precision NOT NULL
    CHECK (value_score >= 0 AND value_score <= 1),
  reward_kind text NOT NULL
    CHECK (reward_kind IN ('recognition', 'gift', 'voucher', 'experience', 'donation')),
  reward_amount bigint NOT NULL
    CHECK (reward_amount >= 0),
  reward_currency text NOT NULL
    CHECK (reward_currency ~ '^[A-Z]{3}$'),
  tier_name text NOT NULL
    CHECK (char_length(tier_name) BETWEEN 1 AND 100),
  policy_version integer NOT NULL CHECK (policy_version >= 1),
  policy_snapshot jsonb NOT NULL
    CHECK (jsonb_typeof(policy_snapshot) = 'object'),
  value_assessment jsonb NOT NULL
    CHECK (jsonb_typeof(value_assessment) = 'object'),
  -- The minted status (the derived current status lives in the settlement
  -- join): 'granted' only from a policy-allowed grant, 'proposed' only
  -- from an approval-gated one, 'refused' only from a forbidden one.
  status text NOT NULL
    CHECK (status IN ('proposed', 'granted', 'refused')),
  authority_outcome text NOT NULL
    CHECK (authority_outcome IN ('allowed', 'approval_required', 'forbidden')),
  authority_source text NOT NULL
    CHECK (authority_source IN ('kind', 'tenant-default', 'built-in')),
  action_request_id uuid NOT NULL,
  budget_remaining_before bigint NOT NULL
    CHECK (budget_remaining_before >= 0),
  actor_kind text NOT NULL
    CHECK (actor_kind IN ('person', 'team', 'agent', 'system', 'external')),
  actor_id text,
  actor_label text,
  applied_by_principal text NOT NULL,
  rationale text
    CHECK (rationale IS NULL OR char_length(rationale) BETWEEN 1 AND 2000),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  -- One configured reward per contribution, whatever anchored it.
  CONSTRAINT rewards_contribution_unique UNIQUE (tenant_id, contribution_kind, contribution_id),
  -- The acting party is traceable (the missions actor rule).
  CONSTRAINT rewards_actor_traceable CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL),
  -- The composite target of reward_settlements' tenant-scoped FK.
  CONSTRAINT rewards_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX rewards_mission_idx ON rewards (tenant_id, mission_id, recorded_at);
CREATE INDEX rewards_contributor_idx ON rewards (tenant_id, contributor_person_id, recorded_at);
CREATE INDEX rewards_status_idx ON rewards (tenant_id, status);

CREATE TABLE reward_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  reward_id uuid NOT NULL,
  decision text NOT NULL
    CHECK (decision IN ('granted', 'declined')),
  decided_by_principal text,
  decided_at timestamptz,
  settled_by_principal text NOT NULL,
  settled_at timestamptz NOT NULL DEFAULT now(),
  -- First settlement wins: one terminal settlement per reward.
  CONSTRAINT reward_settlements_reward_unique UNIQUE (tenant_id, reward_id),
  CONSTRAINT reward_settlements_reward_fk
    FOREIGN KEY (reward_id, tenant_id) REFERENCES rewards (id, tenant_id),
  -- The authority-decision provenance is a pair: both present or both absent.
  CONSTRAINT reward_settlements_provenance_pair CHECK (
    (decided_by_principal IS NULL) = (decided_at IS NULL)
  )
);

CREATE INDEX reward_settlements_reward_idx ON reward_settlements (tenant_id, reward_id);

-- Storage-level audit guarantee: a reward record is append-only. Nothing
-- may UPDATE, DELETE or TRUNCATE a reward — not even a future module
-- bypassing the service. The message deliberately names no row id so the
-- same function serves the row-level and the statement-level trigger.

CREATE OR REPLACE FUNCTION rewards_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'rewards are append-only (W043 configured-reward records): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER rewards_immutable
  BEFORE UPDATE OR DELETE ON rewards
  FOR EACH ROW EXECUTE FUNCTION rewards_reject_mutation();

CREATE TRIGGER rewards_immutable_truncate
  BEFORE TRUNCATE ON rewards
  FOR EACH STATEMENT EXECUTE FUNCTION rewards_reject_mutation();

-- Settlements are append-only too (first write wins; there is no un-settle).

CREATE OR REPLACE FUNCTION reward_settlements_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'reward settlements are append-only (W043): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reward_settlements_immutable
  BEFORE UPDATE OR DELETE ON reward_settlements
  FOR EACH ROW EXECUTE FUNCTION reward_settlements_reject_mutation();

CREATE TRIGGER reward_settlements_immutable_truncate
  BEFORE TRUNCATE ON reward_settlements
  FOR EACH STATEMENT EXECUTE FUNCTION reward_settlements_reject_mutation();
