-- W136 · agent-exchange module — Agent Exchange + Execution Plan +
-- Cross-Agent Relay.
--
-- The durable ORCHESTRATION PROJECTION (spec/work-items/
-- WORK-ITEM-CATALOG.md §W136): the execution plan spine linking goal →
-- tasks → agent organization → handoffs → approvals → execution runs →
-- results/outcomes. The exchange is a PROJECTION — no table here
-- executes, dispatches, recruits, installs or decides anything (the
-- "no second execution authority" acceptance law): the agents module
-- (W021) stays the one execution authority, Marketplace (W028) and
-- Agent Recruitment (W022) own acquisition, and the actions module
-- (W009) owns authority decisions.
--
-- Load-bearing schema laws:
--   1. TASKS AND MEMBERS ARE IMMUTABLE FROM CREATION. They are the
--      plan's declared decomposition and organization — rewriting a
--      decomposition under execution would corrupt the run/handoff/
--      approval history that references it (the house "changed
--      proposal is a NEW proposal" law). Rows are never updated,
--      deleted or truncated.
--   2. HANDOFFS, APPROVALS AND RUNS ARE APPEND-ONLY EVIDENCE (§24
--      "Audit records are append-only from the domain perspective").
--      The relay history, the recorded authority decisions and the
--      execution observations reject UPDATE/DELETE/TRUNCATE outright.
--   3. THE PLAN LIFECYCLE IS ONE-WAY: active → completed | abandoned,
--      each stamping its terminal column EXACTLY ONCE and setting the
--      retained lifecycle note with the transition. Every identity/
--      content column is immutable; DELETE/TRUNCATE forbidden.
--
-- Cross-module references are opaque forward references, deliberately
-- NOT foreign keys (the house discipline), validated at write time
-- through their owning contracts and snapshotted where §24
-- reconstructability demands: goal → goals (W008, ACTIVE + version
-- pin), fingerprint → context (W134, goal-matched), strategy →
-- info-strategy (W134), recommendation → org-lab (W135 §11,
-- goal-matched), team → agent-teams (W023, ACTIVE), agent-body member
-- refs → agent-body (W133, readable + active), tenant-agent member
-- refs → agents (W021, readable + active), marketplace package member
-- refs → marketplace (W028, visible + INSTALLABLE), recruitment
-- provenance → agent-recruitment (W022, approved), run executions →
-- agents executions (W021, readable; status/summary/cost frozen
-- verbatim at record time), approval decisions → actions requests
-- (W009, terminal; the decision snapshot frozen verbatim), run outcome
-- links → learning outcomes (W040, OPEN at record time).
--
-- Tenant scoping (ADR-0001): every table carries tenant_id; two
-- tenants hold fully independent exchange state, and cross-tenant
-- access is indistinguishable from missing records at the service
-- layer.

-- ---------------------------------------------------------------------------
-- The execution plan — the projection's spine (pointer row).
-- ---------------------------------------------------------------------------
CREATE TABLE execution_plans (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  goal_id uuid NOT NULL,
  -- The goal's current version at creation (§11-style revision pinning).
  goal_version integer NOT NULL CHECK (goal_version >= 1),
  -- Optional conditioning/context links (validated at write time,
  -- opaque after): W134 fingerprint (goal-matched), W134 strategy,
  -- W135 org-lab recommendation (goal-matched), W023 agent team (active).
  fingerprint_id uuid,
  strategy_id uuid,
  recommendation_id uuid,
  team_id uuid,
  objective text NOT NULL
    CHECK (char_length(objective) >= 1 AND char_length(objective) <= 2000),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'abandoned')),
  note text
    CHECK (note IS NULL OR char_length(note) >= 1),
  created_by text NOT NULL CHECK (char_length(created_by) >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  abandoned_at timestamptz,
  -- The retained lifecycle note (the completion note or the abandonment
  -- reason), set exactly once by the terminal transition.
  lifecycle_note text
    CHECK (lifecycle_note IS NULL OR char_length(lifecycle_note) >= 1),
  CHECK (
    (status = 'active' AND completed_at IS NULL AND abandoned_at IS NULL)
    OR (status = 'completed' AND completed_at IS NOT NULL AND abandoned_at IS NULL)
    OR (status = 'abandoned' AND completed_at IS NULL AND abandoned_at IS NOT NULL)
  )
);

CREATE INDEX execution_plans_tenant_goal_idx ON execution_plans (tenant_id, goal_id);
CREATE INDEX execution_plans_tenant_status_idx ON execution_plans (tenant_id, status);
CREATE INDEX execution_plans_tenant_recommendation_idx
  ON execution_plans (tenant_id, recommendation_id);

-- ---------------------------------------------------------------------------
-- The task decomposition — immutable from creation (law 1).
-- ---------------------------------------------------------------------------
CREATE TABLE execution_plan_tasks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  -- Identity within the plan: slug grammar, deterministic referencing.
  task_key text NOT NULL
    CHECK (task_key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  title text NOT NULL
    CHECK (char_length(title) >= 1 AND char_length(title) <= 200),
  detail text
    CHECK (detail IS NULL OR char_length(detail) <= 2000),
  -- Other task keys this task depends on (acyclic, within the plan;
  -- enforced by validation at write time).
  depends_on text[] NOT NULL DEFAULT '{}',
  -- The organization member slot responsible for this task, when assigned.
  assignee_member_key text,
  -- Deterministic order within the plan (input order).
  position integer NOT NULL CHECK (position >= 1),
  UNIQUE (tenant_id, plan_id, task_key),
  UNIQUE (tenant_id, plan_id, position)
);

CREATE INDEX execution_plan_tasks_plan_idx
  ON execution_plan_tasks (tenant_id, plan_id);

-- ---------------------------------------------------------------------------
-- The agent organization — member references with governed recruitment
-- provenance. Immutable from creation (law 1).
-- ---------------------------------------------------------------------------
CREATE TABLE execution_plan_members (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  -- Identity within the plan: slug grammar.
  member_key text NOT NULL
    CHECK (member_key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  -- The org-lab §5 comparison set, consumed as-is (W136 composes W135).
  kind text NOT NULL CHECK (kind IN (
    'agent-body',
    'tenant-agent',
    'marketplace-agent-package',
    'marketplace-extension-package',
    'human-capability',
    'external-specialist'
  )),
  role text NOT NULL
    CHECK (char_length(role) >= 1 AND char_length(role) <= 128),
  -- Opaque registry reference after write-time validation (required for
  -- agent-body / tenant-agent / marketplace kinds; optional for human
  -- and external kinds).
  ref text
    CHECK (ref IS NULL OR (char_length(ref) >= 1 AND char_length(ref) <= 256)),
  label text
    CHECK (label IS NULL OR char_length(label) <= 256),
  -- Governed recruitment provenance: the approved agent-recruitment
  -- proposal (W022) that acquired this member, when one exists.
  recruitment_proposal_id uuid,
  UNIQUE (tenant_id, plan_id, member_key)
);

CREATE INDEX execution_plan_members_plan_idx
  ON execution_plan_members (tenant_id, plan_id);

-- ---------------------------------------------------------------------------
-- The cross-agent relay — append-only handoff evidence (law 2).
-- ---------------------------------------------------------------------------
CREATE TABLE execution_plan_handoffs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  task_key text NOT NULL
    CHECK (task_key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  from_member_key text NOT NULL
    CHECK (char_length(from_member_key) >= 1 AND char_length(from_member_key) <= 64),
  to_member_key text NOT NULL
    CHECK (char_length(to_member_key) >= 1 AND char_length(to_member_key) <= 64),
  -- The MINIMAL context package that traveled: at most one fingerprint
  -- reference + explicit evidence refs + a note. Structural minimality
  -- (acceptance law 2): there is no column here through which an
  -- unbounded context could travel.
  context jsonb NOT NULL
    CHECK (jsonb_typeof(context) = 'object'),
  note text
    CHECK (note IS NULL OR char_length(note) >= 1),
  recorded_by text NOT NULL CHECK (char_length(recorded_by) >= 1),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX execution_plan_handoffs_plan_idx
  ON execution_plan_handoffs (tenant_id, plan_id, recorded_at);
CREATE INDEX execution_plan_handoffs_plan_task_idx
  ON execution_plan_handoffs (tenant_id, plan_id, task_key);

-- ---------------------------------------------------------------------------
-- The governed approvals — append-only records of authority decisions
-- (law 2). The W009 authority system decides; the exchange records the
-- frozen decision snapshot.
-- ---------------------------------------------------------------------------
CREATE TABLE execution_plan_approvals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  -- The task the approval governs, when task-scoped; null when plan-scoped.
  task_key text
    CHECK (task_key IS NULL OR task_key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  -- The actions-module request whose TERMINAL decision is recorded.
  action_request_id uuid NOT NULL,
  -- The frozen decision snapshot, consumed verbatim from the actions
  -- module at record time (status, kind, level, requester, decidedAt).
  decision jsonb NOT NULL
    CHECK (jsonb_typeof(decision) = 'object'),
  recorded_by text NOT NULL CHECK (char_length(recorded_by) >= 1),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX execution_plan_approvals_plan_idx
  ON execution_plan_approvals (tenant_id, plan_id, recorded_at);
CREATE INDEX execution_plan_approvals_plan_task_idx
  ON execution_plan_approvals (tenant_id, plan_id, task_key);

-- ---------------------------------------------------------------------------
-- The execution runs — append-only observations linking plan tasks to
-- REAL agents-module executions (law 2). The normalized status/summary/
-- cost freeze at record time; the canonical result stays owned by the
-- agents module.
-- ---------------------------------------------------------------------------
CREATE TABLE execution_plan_runs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  task_key text NOT NULL
    CHECK (task_key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  -- The agents-module agent (denormalized from the execution at record
  -- time — assignee governance is checked at the service boundary).
  agent_id uuid NOT NULL,
  -- The agents-module execution this run observes (W021).
  agent_execution_id uuid NOT NULL,
  -- The minimal context package routed to the agent for this run.
  context jsonb NOT NULL
    CHECK (jsonb_typeof(context) = 'object'),
  -- The W021 execution status frozen at record time (verbatim).
  execution_status text NOT NULL
    CHECK (execution_status IN (
      'awaiting_approval', 'queued', 'succeeded', 'failed', 'refused', 'cancelled'
    )),
  -- The normalized result summary frozen at record time (null while
  -- the execution has not reported one).
  result_summary text
    CHECK (result_summary IS NULL OR char_length(result_summary) >= 1),
  -- The execution's accumulated cost at record time, integer minor units.
  cost_minor bigint NOT NULL CHECK (cost_minor >= 0),
  -- Dispatch attempts performed at record time.
  attempts_count integer NOT NULL CHECK (attempts_count >= 0),
  -- The execution's terminal time at record time (null while live).
  execution_completed_at timestamptz,
  -- The linked learning-module outcome (W040; validated OPEN at record
  -- time), when the run commits to one.
  outcome_id uuid,
  recorded_by text NOT NULL CHECK (char_length(recorded_by) >= 1),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX execution_plan_runs_plan_idx
  ON execution_plan_runs (tenant_id, plan_id, recorded_at);
CREATE INDEX execution_plan_runs_plan_task_idx
  ON execution_plan_runs (tenant_id, plan_id, task_key);
CREATE INDEX execution_plan_runs_execution_idx
  ON execution_plan_runs (tenant_id, agent_execution_id);

-- ---------------------------------------------------------------------------
-- Append-only enforcement (laws 1 + 2). Tasks, members, handoffs,
-- approvals and runs reject every UPDATE/DELETE/TRUNCATE outright.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION agent_exchange_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'agent-exchange evidence is append-only (W136): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER execution_plan_tasks_immutable
  BEFORE UPDATE OR DELETE ON execution_plan_tasks
  FOR EACH ROW EXECUTE FUNCTION agent_exchange_reject_mutation();

CREATE TRIGGER execution_plan_tasks_immutable_truncate
  BEFORE TRUNCATE ON execution_plan_tasks
  FOR EACH STATEMENT EXECUTE FUNCTION agent_exchange_reject_mutation();

CREATE TRIGGER execution_plan_members_immutable
  BEFORE UPDATE OR DELETE ON execution_plan_members
  FOR EACH ROW EXECUTE FUNCTION agent_exchange_reject_mutation();

CREATE TRIGGER execution_plan_members_immutable_truncate
  BEFORE TRUNCATE ON execution_plan_members
  FOR EACH STATEMENT EXECUTE FUNCTION agent_exchange_reject_mutation();

CREATE TRIGGER execution_plan_handoffs_immutable
  BEFORE UPDATE OR DELETE ON execution_plan_handoffs
  FOR EACH ROW EXECUTE FUNCTION agent_exchange_reject_mutation();

CREATE TRIGGER execution_plan_handoffs_immutable_truncate
  BEFORE TRUNCATE ON execution_plan_handoffs
  FOR EACH STATEMENT EXECUTE FUNCTION agent_exchange_reject_mutation();

CREATE TRIGGER execution_plan_approvals_immutable
  BEFORE UPDATE OR DELETE ON execution_plan_approvals
  FOR EACH ROW EXECUTE FUNCTION agent_exchange_reject_mutation();

CREATE TRIGGER execution_plan_approvals_immutable_truncate
  BEFORE TRUNCATE ON execution_plan_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION agent_exchange_reject_mutation();

CREATE TRIGGER execution_plan_runs_immutable
  BEFORE UPDATE OR DELETE ON execution_plan_runs
  FOR EACH ROW EXECUTE FUNCTION agent_exchange_reject_mutation();

CREATE TRIGGER execution_plan_runs_immutable_truncate
  BEFORE TRUNCATE ON execution_plan_runs
  FOR EACH STATEMENT EXECUTE FUNCTION agent_exchange_reject_mutation();

-- ---------------------------------------------------------------------------
-- The plan pointer: the ONLY legal UPDATE is the one-way
-- active → completed | abandoned transition (each stamping its terminal
-- column exactly once and setting the retained lifecycle note); every
-- identity/content column is immutable; DELETE/TRUNCATE forbidden
-- (law 3).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION execution_plan_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'execution_plans is lifecycle-managed (W136): % is forbidden — the orchestration projection is durable evidence', TG_OP;
  END IF;

  -- Identity and content are immutable from creation.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.goal_id IS DISTINCT FROM OLD.goal_id
     OR NEW.goal_version IS DISTINCT FROM OLD.goal_version
     OR NEW.fingerprint_id IS DISTINCT FROM OLD.fingerprint_id
     OR NEW.strategy_id IS DISTINCT FROM OLD.strategy_id
     OR NEW.recommendation_id IS DISTINCT FROM OLD.recommendation_id
     OR NEW.team_id IS DISTINCT FROM OLD.team_id
     OR NEW.objective IS DISTINCT FROM OLD.objective
     OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'execution_plans content is immutable (W136): only the active -> completed/abandoned transition moves';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'active' AND NEW.status IN ('completed', 'abandoned')) THEN
    RAISE EXCEPTION 'execution_plans lifecycle is one-way (W136): active -> completed | abandoned only';
  END IF;

  IF NEW.status = 'completed' AND (OLD.completed_at IS NOT NULL OR NEW.completed_at IS NULL OR NEW.abandoned_at IS NOT NULL) THEN
    RAISE EXCEPTION 'completion must stamp completed_at exactly once';
  END IF;

  IF NEW.status = 'abandoned' AND (OLD.abandoned_at IS NOT NULL OR NEW.abandoned_at IS NULL OR NEW.completed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'abandonment must stamp abandoned_at exactly once';
  END IF;

  IF NEW.lifecycle_note IS DISTINCT FROM OLD.lifecycle_note
     AND OLD.status <> 'active' THEN
    RAISE EXCEPTION 'execution_plans lifecycle_note may only be set by the terminal transition';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER execution_plans_immutable
  BEFORE UPDATE OR DELETE ON execution_plans
  FOR EACH ROW EXECUTE FUNCTION execution_plan_guard();

CREATE TRIGGER execution_plans_immutable_truncate
  BEFORE TRUNCATE ON execution_plans
  FOR EACH STATEMENT EXECUTE FUNCTION execution_plan_guard();
