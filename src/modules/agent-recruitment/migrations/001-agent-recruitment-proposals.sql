-- W022 · agent-recruitment module — AgentRecruitmentProposal.
--
-- The work item: "Create AgentRecruitmentProposal comparing
-- train/reassign/hire/automate/recruit/install alternatives. Approval is
-- explicit."
--
-- Two tables, the actions module's (W009) request discipline applied to
-- a recruitment proposal:
--
--   agent_recruitment_proposals   — the proposal: what is being proposed
--                                   (title, capability link + snapshot,
--                                   rationale, evidence) and its lifecycle
--                                   state + approval trail;
--   agent_recruitment_alternatives— the comparison: 2..6 rows per
--                                   proposal, one per acquisition channel
--                                   (train/reassign/hire/automate/recruit/
--                                   install), each assessed on the same
--                                   dimensions.
--
-- The proposal's SUBSTANTIVE content is immutable history the moment it
-- is recorded (a changed proposal is a NEW proposal — the actions
-- module's discipline); only the lifecycle state (status, gate snapshot,
-- decision, withdrawal, updated_at) may move, and only forward. The
-- alternatives are fully immutable. PostgreSQL itself rejects DELETE/
-- TRUNCATE on both tables and substantive UPDATEs via the guard triggers
-- below — not even a future module bypassing the service can rewrite a
-- recorded comparison or erase a recruitment decision (§24 decision
-- evidence; lock 37).
--
-- APPROVAL IS EXPLICIT (§20/lock 23): the proposal links to its W009
-- action request (kind 'agent-recruitment', level EXECUTE) — opaque uuid
-- reference, no cross-module foreign key (the capabilities module's
-- rule) — and freezes the gate evaluation (policy_outcome +
-- policy_resolved_via) exactly as the actions module freezes it on the
-- request, so later policy edits never rewrite what gated a recorded
-- proposal.
--
-- The capability link is likewise an opaque uuid (existence verified
-- through the capabilities contract at creation time, no cross-module
-- FK), with the name/status/gap numbers SNAPSHOTTED at creation: the
-- "existing capability" side of the §15 comparison is decision-time
-- evidence, not live derived state (the actions module's evaluation-
-- snapshot discipline — derived intelligence is never persisted as truth,
-- but what a decision was based on is).
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the composite
-- UNIQUE (id, tenant_id) on each table is the tenant-consistent target
-- for the alternatives' foreign key, making a cross-tenant or dangling
-- alternative unrepresentable in SQL.

-- ---------------------------------------------------------------------------
-- Proposals
-- ---------------------------------------------------------------------------

CREATE TABLE agent_recruitment_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  -- the capability being addressed (W017); opaque reference + snapshot
  capability_id uuid NOT NULL,
  capability_name text NOT NULL CHECK (char_length(capability_name) BETWEEN 1 AND 200),
  capability_status text NOT NULL CHECK (capability_status IN ('active', 'retired')),
  gap_status text CHECK (gap_status IN (
    'uncovered', 'level_shortfall', 'capacity_shortfall', 'covered'
  )),
  gap_best_level double precision
    CHECK (gap_best_level IS NULL OR (gap_best_level >= 0 AND gap_best_level <= 1)),
  gap_total_capacity double precision
    CHECK (gap_total_capacity IS NULL OR gap_total_capacity >= 0),
  rationale text NOT NULL CHECK (char_length(rationale) BETWEEN 1 AND 2000),
  evidence_observation_ids jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence_observation_ids) = 'array'),
  -- lifecycle
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN (
    'proposed', 'awaiting_approval', 'approved', 'rejected', 'withdrawn'
  )),
  -- the frozen W009 gate link (present exactly once submitted)
  action_request_id uuid,
  policy_outcome text CHECK (policy_outcome IN ('allowed', 'approval_required', 'forbidden')),
  policy_resolved_via text CHECK (policy_resolved_via IN ('kind', 'tenant-default', 'built-in')),
  submitted_by text,
  submitted_at timestamptz,
  decided_by text CHECK (decided_by IN ('policy', 'principal')),
  decided_by_principal text,
  decided_at timestamptz,
  withdrawn_at timestamptz,
  withdrawal_reason text
    CHECK (withdrawal_reason IS NULL OR char_length(withdrawal_reason) BETWEEN 1 AND 512),
  -- audit
  created_by text NOT NULL CHECK (created_by <> ''),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT agent_recruitment_proposals_id_tenant_unique UNIQUE (id, tenant_id),
  -- a proposal carries its gate link exactly from submission on; a
  -- draft or a withdrawn draft never touched the gate.
  CONSTRAINT agent_recruitment_proposals_gate_linked CHECK (
    (status IN ('proposed', 'withdrawn')
       AND action_request_id IS NULL AND policy_outcome IS NULL
       AND policy_resolved_via IS NULL AND submitted_by IS NULL AND submitted_at IS NULL)
    OR (status IN ('awaiting_approval', 'approved', 'rejected')
       AND action_request_id IS NOT NULL AND policy_outcome IS NOT NULL
       AND policy_resolved_via IS NOT NULL AND submitted_by IS NOT NULL AND submitted_at IS NOT NULL)
  ),
  -- a decision exists exactly on the decided statuses, never on a
  -- draft, an open gate or a withdrawal.
  CONSTRAINT agent_recruitment_proposals_decision_shape CHECK (
    (status IN ('proposed', 'awaiting_approval', 'withdrawn')
       AND decided_by IS NULL AND decided_by_principal IS NULL AND decided_at IS NULL)
    OR (status IN ('approved', 'rejected')
       AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
  ),
  -- policy decisions have no deciding principal; principal decisions do.
  CONSTRAINT agent_recruitment_proposals_decider_shape CHECK (
    (decided_by = 'policy' AND decided_by_principal IS NULL)
    OR (decided_by = 'principal' AND decided_by_principal IS NOT NULL)
  ),
  -- withdrawal evidence exists exactly on withdrawals.
  CONSTRAINT agent_recruitment_proposals_withdrawal_shape CHECK (
    (status = 'withdrawn') = (withdrawn_at IS NOT NULL)
  ),
  CONSTRAINT agent_recruitment_proposals_withdrawal_reason CHECK (
    status <> 'withdrawn' OR withdrawal_reason IS NOT NULL
  )
);

CREATE INDEX agent_recruitment_proposals_tenant_created_idx
  ON agent_recruitment_proposals (tenant_id, created_at DESC);
CREATE INDEX agent_recruitment_proposals_tenant_status_idx
  ON agent_recruitment_proposals (tenant_id, status);
CREATE INDEX agent_recruitment_proposals_tenant_capability_idx
  ON agent_recruitment_proposals (tenant_id, capability_id);

-- ---------------------------------------------------------------------------
-- Alternatives (the comparison)
-- ---------------------------------------------------------------------------

CREATE TABLE agent_recruitment_alternatives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'train', 'reassign', 'hire', 'automate', 'recruit', 'install'
  )),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 2000),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
  -- house money convention: integer minor units + ISO 4217 code, paired
  estimated_cost_minor bigint CHECK (
    estimated_cost_minor IS NULL OR (estimated_cost_minor >= 0 AND estimated_cost_minor <= 1000000000000000)
  ),
  estimated_cost_currency text
    CHECK (estimated_cost_currency IS NULL OR estimated_cost_currency ~ '^[A-Z]{3}$'),
  estimated_weeks integer
    CHECK (estimated_weeks IS NULL OR (estimated_weeks >= 1 AND estimated_weeks <= 520)),
  expected_level double precision
    CHECK (expected_level IS NULL OR (expected_level >= 0 AND expected_level <= 1)),
  expected_capacity double precision
    CHECK (expected_capacity IS NULL OR (expected_capacity >= 0 AND expected_capacity <= 1000000000)),
  recommended boolean NOT NULL DEFAULT false,
  -- the future agent's permission grant — recruit alternatives only
  agent_permissions jsonb CHECK (agent_permissions IS NULL OR jsonb_typeof(agent_permissions) = 'array'),
  CONSTRAINT agent_recruitment_alternatives_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT agent_recruitment_alternatives_proposal_fk
    FOREIGN KEY (proposal_id, tenant_id) REFERENCES agent_recruitment_proposals (id, tenant_id),
  -- one assessment per acquisition channel: the comparison is over
  -- channels, not over arguments (service validation guarantees 2..6
  -- rows per proposal).
  CONSTRAINT agent_recruitment_alternatives_kind_unique
    UNIQUE (tenant_id, proposal_id, kind),
  CONSTRAINT agent_recruitment_alternatives_recruit_only_permissions
    CHECK (kind = 'recruit' OR agent_permissions IS NULL),
  CONSTRAINT agent_recruitment_alternatives_cost_currency_paired CHECK (
    (estimated_cost_minor IS NULL AND estimated_cost_currency IS NULL)
    OR (estimated_cost_minor IS NOT NULL AND estimated_cost_currency IS NOT NULL)
  )
);

CREATE INDEX agent_recruitment_alternatives_tenant_proposal_idx
  ON agent_recruitment_alternatives (tenant_id, proposal_id);

-- At most ONE recommended alternative per proposal — an approver
-- approves ONE course of action (partial unique index).
CREATE UNIQUE INDEX agent_recruitment_alternatives_one_recommended
  ON agent_recruitment_alternatives (tenant_id, proposal_id) WHERE recommended;

-- ---------------------------------------------------------------------------
-- Append-only enforcement
-- ---------------------------------------------------------------------------

-- Storage-level audit guarantee: a recorded comparison is history. The
-- alternatives reject UPDATE, DELETE and TRUNCATE outright; the proposal
-- may advance ONLY its lifecycle state (status, gate link, decision,
-- withdrawal, updated_at) — never its substantive content. The messages
-- deliberately name no row id so the same function serves the row-level
-- and the statement-level triggers (the goals/agents discipline).

CREATE OR REPLACE FUNCTION agent_recruitment_alternatives_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'recruitment alternatives are immutable history (W022 comparison audit trail): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_recruitment_alternatives_immutable
  BEFORE UPDATE OR DELETE ON agent_recruitment_alternatives
  FOR EACH ROW EXECUTE FUNCTION agent_recruitment_alternatives_guard();

CREATE TRIGGER agent_recruitment_alternatives_immutable_truncate
  BEFORE TRUNCATE ON agent_recruitment_alternatives
  FOR EACH STATEMENT EXECUTE FUNCTION agent_recruitment_alternatives_guard();

CREATE OR REPLACE FUNCTION agent_recruitment_proposals_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'recruitment proposals cannot be erased (W022): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'recruitment proposals cannot be erased (W022): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.title <> OLD.title
     OR NEW.capability_id <> OLD.capability_id
     OR NEW.capability_name <> OLD.capability_name
     OR NEW.capability_status <> OLD.capability_status
     OR NEW.gap_status IS DISTINCT FROM OLD.gap_status
     OR NEW.gap_best_level IS DISTINCT FROM OLD.gap_best_level
     OR NEW.gap_total_capacity IS DISTINCT FROM OLD.gap_total_capacity
     OR NEW.rationale <> OLD.rationale
     OR NEW.evidence_observation_ids <> OLD.evidence_observation_ids
     OR NEW.created_by <> OLD.created_by
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'recruitment proposals are immutable history (W022): only the lifecycle state (status, action_request_id, policy_outcome, policy_resolved_via, submitted_by, submitted_at, decided_by, decided_by_principal, decided_at, withdrawn_at, withdrawal_reason, updated_at) may change on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_recruitment_proposals_state_only_updates
  BEFORE UPDATE OR DELETE ON agent_recruitment_proposals
  FOR EACH ROW EXECUTE FUNCTION agent_recruitment_proposals_guard();

CREATE TRIGGER agent_recruitment_proposals_immutable_truncate
  BEFORE TRUNCATE ON agent_recruitment_proposals
  FOR EACH STATEMENT EXECUTE FUNCTION agent_recruitment_proposals_guard();
