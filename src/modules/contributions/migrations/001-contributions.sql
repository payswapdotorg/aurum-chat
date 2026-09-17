-- W042 · contributions module — knowledge contributions.
--
-- ARCHITECTURE.md §8 (frozen): "KnowledgeContribution records what
-- information an employee supplied, the associated evidence, validation
-- outcome, knowledge gain, goal impact and investigation cost avoided.
-- RewardPolicy converts contribution value into configured rewards."
-- The work item (spec/work-items/WORK-ITEM-CATALOG.md, W042):
-- "Record employee knowledge contributions, validation, knowledge gain,
--  mission impact and investigation-cost avoidance."
-- Lock 9: "Employees are first-class knowledge sources; useful knowledge
-- contributions may be rewarded under explicit policy."
-- §7 (the canonical loop this module sits in): "Aurum may ask an employee
-- targeted questions when policy permits, record the resulting
-- contribution, assess evidence quality, update the mission, and reward
-- useful contributions."
--
-- Three tables, all FULLY append-only (the W040 learning / W012
-- knowledge-acquisition discipline — there is no UPDATE anywhere; status
-- is DERIVED, never stored on the definition row):
--
--   contributions            — one immutable DEFINITION row: the fact that
--                              an employee answered one planned acquisition
--                              (W012). Everything the architecture's
--                              KnowledgeContribution ties together is
--                              DERIVED from the validated acquisition plan
--                              (the sanctioned W012 → W042 dependency,
--                              checked readable through the
--                              knowledge-acquisition contract at write
--                              time): the plan's mission (mission impact
--                              surface), the chosen person (the
--                              contributing employee, an opaque people-module
--                              forward reference), the targeted question,
--                              the answer's evidence observation (an opaque
--                              observations-module forward reference — §8
--                              "the associated evidence") and the mission's
--                              investigation-budget currency (the
--                              denomination of the avoided cost). The
--                              caller supplies only the human summary of
--                              what was supplied. UNIQUE (tenant_id,
--                              plan_id): one contribution per acquisition —
--                              one question, one answer, one record.
--
--   contribution_validations — the append-only VALIDATION series (§7
--                              "assess evidence quality"; §8 "validation
--                              outcome"): evidence-quality assessments with
--                              outcome validated/contradicted/rejected,
--                              quality score in [0,1], opaque evidence
--                              references and full provenance. Revalidation
--                              is allowed and history is never rewritten —
--                              contradictions are RETAINED (lock 12); the
--                              current validation is the latest row. There
--                              is deliberately no gate on a measured
--                              contribution: later contradicting evidence
--                              keeps arriving after the impact was frozen.
--
--   contribution_impacts     — the ONE measured impact record per
--                              contribution (first write wins via UNIQUE
--                              (tenant_id, contribution_id)): the frozen
--                              knowledge gain (mission confidence before →
--                              after — §8 "knowledge gain", the missions
--                              confidence scale), the mission impact kind
--                              (§8 "goal impact" via the affected-goal
--                              opaque forward references + the mission the
--                              plan served), the investigation cost avoided
--                              (§8; integer MINOR UNITS of the mission's
--                              investigation-budget currency, itemized by
--                              the acquisition actions that no longer need
--                              to run) and the optional learning-module
--                              outcome (W040) that measures the mission's
--                              improvement — the sanctioned W040 → W042
--                              dependency, checked readable through the
--                              learning contract at write time. The service
--                              requires at least one validation record
--                              before an impact can be recorded (§7's
--                              canonical order: assess evidence quality,
--                              THEN update the mission).
--
-- There is deliberately NO operation to rewrite a contribution, rewrite a
-- validation, un-measure an impact or delete anything: what an employee
-- supplied, how it was assessed and what it changed are auditable history
-- (W043 Rewards and W053 CompanyModel build on these records; W055's
-- "evidence quality" and "investigation cost" metrics read them).
-- PostgreSQL itself rejects UPDATE/DELETE/TRUNCATE on all three tables
-- (triggers below), even for a caller bypassing the service.
--
-- Derived lifecycle (never stored): 'pending' (no validation yet) →
-- 'validated' | 'contradicted' | 'rejected' (the LATEST validation's
-- outcome) → 'measured' (the impact record exists — the terminal
-- assessment state of this module). A measured contribution keeps
-- accepting validations (contradiction retention).
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the composite
-- FKs (contribution_id, tenant_id) → contributions (id, tenant_id) make
-- cross-tenant rows unrepresentable in SQL (the outcome_realizations /
-- acquisition_outcomes pattern). The acquisition-plan and learning-outcome
-- links are contract-validated (no cross-module FKs — the learning
-- module's originating-execution precedent).

CREATE TABLE contributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  -- The answered ask-person acquisition plan (W012) this contribution is
  -- the answer of. Contract-validated at write time; no cross-module FK.
  plan_id uuid NOT NULL,
  -- DERIVED from the plan: the mission the acquisition served (§8 "goal
  -- impact" surface). Opaque forward reference to a missions (W011) record.
  mission_id text NOT NULL
    CHECK (mission_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  -- DERIVED from the plan's answered outcome: the immutable observation
  -- (W004) carrying the supplied information (§8 "the associated
  -- evidence"). Opaque forward reference.
  evidence_observation_id text NOT NULL
    CHECK (evidence_observation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  -- DERIVED from the plan's chosen candidate: the contributing employee
  -- (an opaque people-module W002 person forward reference — no
  -- cross-module FK, no contract import for it).
  person_id text NOT NULL
    CHECK (person_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  person_label text
    CHECK (person_label IS NULL OR char_length(person_label) BETWEEN 1 AND 200),
  -- DERIVED from the plan: the targeted question the employee answered
  -- (W012's mission-derived composition).
  question text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 2000),
  -- DERIVED from the plan: the mission's investigation-budget currency —
  -- the denomination of the impact's avoided cost (the W012 convention:
  -- money as integer minor units + ISO currency code).
  budget_currency text NOT NULL
    CHECK (budget_currency ~ '^[A-Z]{3}$'),
  -- Caller-supplied: what the employee supplied, summarized.
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 2000),
  note text
    CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
  actor_kind text NOT NULL CHECK (actor_kind IN ('person', 'team', 'agent', 'system', 'external')),
  actor_id text,
  actor_label text,
  recorded_by_principal text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  -- The acting party is traceable (the missions actor rule).
  CONSTRAINT contributions_actor_traceable CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL),
  -- One contribution per acquisition: one question, one answer, one record.
  CONSTRAINT contributions_plan_unique UNIQUE (tenant_id, plan_id),
  -- The composite target of the tenant-scoped FKs below.
  CONSTRAINT contributions_id_tenant_unique UNIQUE (id, tenant_id)
);

-- The mission/person tie lookups and the management list filters.
CREATE INDEX contributions_mission_idx ON contributions (tenant_id, mission_id);
CREATE INDEX contributions_person_idx ON contributions (tenant_id, person_id);
CREATE INDEX contributions_recorded_idx ON contributions (tenant_id, recorded_at);

CREATE TABLE contribution_validations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  contribution_id uuid NOT NULL,
  -- The evidence-quality assessment outcome (§8 "validation outcome").
  outcome text NOT NULL CHECK (outcome IN ('validated', 'contradicted', 'rejected')),
  -- The assessed evidence quality, a comparable score in [0, 1].
  quality double precision NOT NULL
    CHECK (quality >= 0 AND quality <= 1),
  -- Opaque evidence references supporting the assessment (write-validated:
  -- kind vocabulary, uuid id and/or label, at most 8).
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence) = 'array'),
  note text
    CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
  actor_kind text NOT NULL CHECK (actor_kind IN ('person', 'team', 'agent', 'system', 'external')),
  actor_id text,
  actor_label text,
  recorded_by_principal text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contribution_validations_actor_traceable
    CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL),
  -- Same-tenant validation of this contribution only.
  CONSTRAINT contribution_validations_contribution_fk
    FOREIGN KEY (contribution_id, tenant_id) REFERENCES contributions (id, tenant_id)
);

-- The validation series, ascending in record order.
CREATE INDEX contribution_validations_contribution_idx
  ON contribution_validations (tenant_id, contribution_id, recorded_at);

CREATE TABLE contribution_impacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  contribution_id uuid NOT NULL,
  -- The mission impact kind (§8 "goal impact" / the catalog's "mission
  -- impact"): what the contribution did to the mission it served.
  mission_impact text NOT NULL CHECK (mission_impact IN ('advanced', 'resolved', 'no_effect')),
  -- The mission's confidence before the contribution was applied (the
  -- missions confidence scale, [0, 1]).
  confidence_before double precision NOT NULL
    CHECK (confidence_before >= 0 AND confidence_before <= 1),
  -- The mission's confidence after the contribution was applied, [0, 1].
  confidence_after double precision NOT NULL
    CHECK (confidence_after >= 0 AND confidence_after <= 1),
  -- FROZEN by the service at record time: confidence_after −
  -- confidence_before (validation.ts assessKnowledgeGain is the single
  -- deterministic definition). Never recomputed, never edited.
  knowledge_gain double precision NOT NULL
    CHECK (knowledge_gain >= -1 AND knowledge_gain <= 1),
  -- Affected goals (§8 "goal impact"): opaque uuid forward references to
  -- goals-module (W008) records (the missions/learning affected-goals
  -- precedent; write-validated, unique, at most 16).
  affected_goals jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(affected_goals) = 'array'),
  -- The investigation cost avoided (§8; W055's "investigation cost"
  -- metric): integer MINOR UNITS of the contribution's budget_currency.
  avoided_cost bigint NOT NULL
    CHECK (avoided_cost >= 0 AND avoided_cost <= 9007199254740991),
  -- The itemization: which acquisition actions no longer need to run
  -- (write-validated: acquisition-action vocabulary, label, estimated
  -- cost). Indicative evidence for the avoided total; no arithmetic
  -- coupling is enforced (avoided_cost is the authoritative figure).
  avoided_paths jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(avoided_paths) = 'array'),
  -- The learning-module outcome (W040) that measures the mission's
  -- improvement — validated readable through the learning contract at
  -- write time (the sanctioned W040 → W042 dependency). Opaque forward
  -- reference; no cross-module FK.
  outcome_id text
    CHECK (outcome_id IS NULL
      OR outcome_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  note text
    CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
  actor_kind text NOT NULL CHECK (actor_kind IN ('person', 'team', 'agent', 'system', 'external')),
  actor_id text,
  actor_label text,
  recorded_by_principal text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  -- First (and only) impact record per contribution: the measured record
  -- is frozen history, exactly like W040's terminal realization.
  CONSTRAINT contribution_impacts_contribution_unique UNIQUE (tenant_id, contribution_id),
  CONSTRAINT contribution_impacts_contribution_fk
    FOREIGN KEY (contribution_id, tenant_id) REFERENCES contributions (id, tenant_id),
  CONSTRAINT contribution_impacts_actor_traceable
    CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL)
);

-- The summary rollup scans measured impacts.
CREATE INDEX contribution_impacts_mission_impact_idx
  ON contribution_impacts (tenant_id, mission_impact);

-- Storage-level audit guarantee: contributions, validations and impacts
-- are append-only. Nothing may UPDATE, DELETE or TRUNCATE any of them —
-- not even a future module bypassing the service. The message deliberately
-- names no row id so the same function serves the row-level and the
-- statement-level triggers.

CREATE OR REPLACE FUNCTION contributions_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'contribution records are append-only (W042 knowledge contributions): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER contributions_immutable
  BEFORE UPDATE OR DELETE ON contributions
  FOR EACH ROW EXECUTE FUNCTION contributions_reject_mutation();

CREATE TRIGGER contributions_immutable_truncate
  BEFORE TRUNCATE ON contributions
  FOR EACH STATEMENT EXECUTE FUNCTION contributions_reject_mutation();

CREATE OR REPLACE FUNCTION contribution_validations_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'contribution validations are append-only (W042 evidence-quality assessments): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER contribution_validations_immutable
  BEFORE UPDATE OR DELETE ON contribution_validations
  FOR EACH ROW EXECUTE FUNCTION contribution_validations_reject_mutation();

CREATE TRIGGER contribution_validations_immutable_truncate
  BEFORE TRUNCATE ON contribution_validations
  FOR EACH STATEMENT EXECUTE FUNCTION contribution_validations_reject_mutation();

CREATE OR REPLACE FUNCTION contribution_impacts_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'contribution impacts are append-only (W042 measured impact records): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER contribution_impacts_immutable
  BEFORE UPDATE OR DELETE ON contribution_impacts
  FOR EACH ROW EXECUTE FUNCTION contribution_impacts_reject_mutation();

CREATE TRIGGER contribution_impacts_immutable_truncate
  BEFORE TRUNCATE ON contribution_impacts
  FOR EACH STATEMENT EXECUTE FUNCTION contribution_impacts_reject_mutation();
