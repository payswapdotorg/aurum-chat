-- W098 · agent-supervision module — the persistent supervision record
-- (one per tenant, agent): the organizational actor's ongoing
-- EMPLOYMENT state.
--
-- ARCHITECTURE.md §15 (frozen): "Agents are organizational actors with
-- role, capabilities, permissions, contract, objectives, budget,
-- expected outcomes, performance metrics, cost, owner and review
-- schedule." Lock 22: "Agent and AgentTeam are organizational actors
-- with explicit contracts, budgets, permissions and outcomes."
--
-- This table is the durable heart of W098's acceptance ("worker/process
-- failure does not terminate organizational actor state; ... budget and
-- permissions survive resume"):
--   * status / health_*          — the supervision lifecycle (with its
--                                  WAITING STATES) and the latest
--                                  durable health observation;
--   * review_interval_seconds /
--     next_review_at / last_review_at / review_count
--                                — the durable review schedule: the
--                                  pump fires due reviews as guarded,
--                                  exactly-once transitions;
--   * budget_minor / budget_spent_minor
--                                — the envelope and the ledgered spend
--                                  (integer minor units, USD; NULL
--                                  envelope = unlimited). The spend is
--                                  maintained ONLY by the append-only
--                                  budget-entry ledger (migrations/004),
--                                  exactly once per W021 attempt;
--   * permitted_scopes           — the supervision permission CEILING
--                                  (closed vocabulary, jsonb array);
--   * termination_decision_id    — the W024 lifecycle decision a
--                                  termination proposal defers to
--                                  (waiting_termination / terminated).
--
-- Storage-level guarantees (not just service discipline):
--   * the guard trigger rejects DELETE/TRUNCATE outright and rejects
--     any UPDATE that touches an IDENTITY field (id, tenant_id,
--     agent_id, created_by, created_at) — the actor's identity is
--     never rewritten, even for a caller bypassing the service;
--   * the state-shape CHECKs keep waiting_termination / terminated
--     linked to a decision, and terminated terminal.
--
-- Tenant scoping (ADR-0001): tenant_id on every row; UNIQUE
-- (tenant_id, agent_id) is the one-supervision-per-actor invariant.

CREATE TABLE agent_supervision_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  owner_principal text NOT NULL CHECK (owner_principal <> ''),
  status text NOT NULL DEFAULT 'active' CHECK (status IN (
    'active', 'waiting_review', 'paused_budget', 'suspended', 'waiting_termination', 'terminated'
  )),
  health_state text NOT NULL DEFAULT 'unknown' CHECK (health_state IN (
    'unknown', 'healthy', 'degraded', 'unhealthy'
  )),
  health_detail text,
  health_observed_at timestamptz,
  review_interval_seconds integer NOT NULL
    CHECK (review_interval_seconds BETWEEN 60 AND 31536000),
  health_interval_seconds integer NOT NULL
    CHECK (health_interval_seconds BETWEEN 60 AND 2592000),
  next_review_at timestamptz NOT NULL,
  last_review_at timestamptz,
  review_count integer NOT NULL DEFAULT 0 CHECK (review_count >= 0),
  budget_minor bigint CHECK (budget_minor IS NULL OR budget_minor >= 0),
  budget_spent_minor bigint NOT NULL DEFAULT 0 CHECK (budget_spent_minor >= 0),
  permitted_scopes jsonb NOT NULL CHECK (jsonb_typeof(permitted_scopes) = 'array'),
  termination_decision_id uuid,
  created_by text NOT NULL CHECK (created_by <> ''),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT agent_supervision_records_agent_unique UNIQUE (tenant_id, agent_id),
  CONSTRAINT agent_supervision_records_waiting_termination_linked CHECK (
    status <> 'waiting_termination' OR termination_decision_id IS NOT NULL
  ),
  CONSTRAINT agent_supervision_records_terminated_linked CHECK (
    status <> 'terminated' OR termination_decision_id IS NOT NULL
  )
);

CREATE INDEX agent_supervision_records_tenant_status_idx
  ON agent_supervision_records (tenant_id, status);
CREATE INDEX agent_supervision_records_tenant_review_idx
  ON agent_supervision_records (tenant_id, next_review_at);
CREATE INDEX agent_supervision_records_tenant_agent_idx
  ON agent_supervision_records (tenant_id, agent_id);

-- Storage-level identity immutability (W098): DELETE/TRUNCATE are
-- always forbidden, and an UPDATE may never touch the actor's identity
-- or audit origin. The message deliberately names no row id so the
-- same function serves the row-level and statement-level triggers.

CREATE OR REPLACE FUNCTION agent_supervision_records_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'supervision records are never erased (W098 persistent agent supervision): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'supervision records are never erased (W098 persistent agent supervision): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.agent_id <> OLD.agent_id
     OR NEW.created_by <> OLD.created_by
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'supervision record identity is immutable (W098 persistent agent supervision): only supervision state and controls may change on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_supervision_records_identity_only_updates
  BEFORE UPDATE OR DELETE ON agent_supervision_records
  FOR EACH ROW EXECUTE FUNCTION agent_supervision_records_guard();

CREATE TRIGGER agent_supervision_records_immutable_truncate
  BEFORE TRUNCATE ON agent_supervision_records
  FOR EACH STATEMENT EXECUTE FUNCTION agent_supervision_records_guard();
