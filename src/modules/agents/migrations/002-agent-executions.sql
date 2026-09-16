-- W021 · agents module — agent executions (the asynchronous unit of work).
--
-- One row per submitted task: the explicit, resumable record of
-- dispatching work to an agent's runtime (ARCHITECTURE.md §16; lock 36:
-- "Long-running cognition and execution are asynchronous, resumable and
-- traceable"). Submission happens through `submitAgentExecution`
-- (permission-scoped, W009-gated, idempotent); dispatch happens ONLY
-- through the `runAgentExecution` worker pump, ONE bounded attempt per
-- call.
--
-- Columns:
--   * agent_id / provider      — the target definition and its runtime
--     (denormalized at submission; provider is the canonical key);
--   * task                     — the canonical task payload (plain JSON);
--   * requested_permissions    — the scopes the execution operates at
--     (validated to be a subset of the agent's grant at submission);
--   * authority_level          — the §20 level the W009 gate evaluated:
--     the HIGHEST level the requested scopes imply (the matrix applies
--     uniformly to agent execution, §20);
--   * idempotency_key          — emitter-supplied dedupe key, unique per
--     tenant (NULL keys never collide — SQL UNIQUE treats NULLs as
--     distinct). A recorded key replays the original execution: first
--     write wins, history is never rewritten;
--   * correlation_id / causation_id — §25 identities (opaque, bounded);
--   * status                   — the lifecycle: awaiting_approval /
--     queued (live, resumable) → succeeded / failed / refused /
--     cancelled (terminal). CHECKs below pin the terminal shapes;
--   * action_request_id / policy_outcome / policy_resolved_via — the
--     frozen W009 decision that admitted (or refused) the submission:
--     'allowed' → queued immediately, 'approval_required' →
--     awaiting_approval until a human decides (the pump resolves it),
--     'forbidden' → refused (recorded as evidence, §24);
--   * max_attempts / attempts_count — the retry policy and its progress
--     (transient dispatch failures retry while attempts remain);
--   * result                   — the CANONICAL, provider-neutral result
--     (adapter-parsed) when succeeded;
--   * error_code / error_detail— the canonical failure classification
--     when failed/refused/cancelled;
--   * cost_minor / cost_currency — the accumulated attempt cost in
--     integer minor units (deterministic adapter pricing; the house
--     money convention);
--   * submitted_by / submitted_at — the acting TenantContext principal
--     and the service-clock submission time.
--
-- Storage-level guarantees (not just service discipline):
--   * the guard trigger rejects DELETE/TRUNCATE outright and rejects any
--     UPDATE that touches a SUBSTANTIVE field — only the live state
--     (status, attempts_count, result, error_code, error_detail,
--     cost_minor, completed_at, updated_at) may move, even for a caller
--     bypassing the service;
--   * the state-shape CHECKs keep status, completed_at, result and
--     error_code consistent.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; UNIQUE
-- (id, tenant_id) is the tenant-consistent target for the attempts of
-- migrations/003.

CREATE TABLE agent_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN (
    'openai-assistants', 'langgraph', 'crewai', 'autogen', 'semantic-kernel'
  )),
  task jsonb NOT NULL,
  requested_permissions jsonb NOT NULL CHECK (jsonb_typeof(requested_permissions) = 'array'),
  authority_level text NOT NULL CHECK (authority_level IN (
    'OBSERVE', 'ANALYZE', 'RECOMMEND', 'ASK', 'PROPOSE', 'EXECUTE'
  )),
  idempotency_key text CHECK (
    idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$'
  ),
  correlation_id text CHECK (
    correlation_id IS NULL OR correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$'
  ),
  causation_id text CHECK (
    causation_id IS NULL OR causation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$'
  ),
  status text NOT NULL CHECK (status IN (
    'awaiting_approval', 'queued', 'succeeded', 'failed', 'refused', 'cancelled'
  )),
  action_request_id uuid,
  policy_outcome text NOT NULL CHECK (policy_outcome IN (
    'allowed', 'approval_required', 'forbidden'
  )),
  policy_resolved_via text NOT NULL CHECK (policy_resolved_via IN (
    'kind', 'tenant-default', 'built-in'
  )),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 5),
  attempts_count integer NOT NULL DEFAULT 0 CHECK (attempts_count >= 0),
  result jsonb,
  error_code text,
  error_detail text,
  cost_minor bigint NOT NULL DEFAULT 0 CHECK (cost_minor >= 0),
  cost_currency text NOT NULL DEFAULT 'USD' CHECK (cost_currency = 'USD'),
  submitted_by text NOT NULL CHECK (submitted_by <> ''),
  submitted_at timestamptz NOT NULL,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL,
  CONSTRAINT agent_executions_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT agent_executions_idempotency_tenant_unique UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT agent_executions_live_state_shape CHECK (
    (status IN ('awaiting_approval', 'queued') AND completed_at IS NULL)
    OR (status IN ('succeeded', 'failed', 'refused', 'cancelled') AND completed_at IS NOT NULL)
  ),
  CONSTRAINT agent_executions_succeeded_shape CHECK (
    status <> 'succeeded' OR (result IS NOT NULL AND error_code IS NULL)
  ),
  CONSTRAINT agent_executions_failed_shape CHECK (
    status <> 'failed' OR (error_code IS NOT NULL AND result IS NULL)
  ),
  CONSTRAINT agent_executions_refused_shape CHECK (
    status <> 'refused' OR (error_code IS NOT NULL AND result IS NULL)
  ),
  CONSTRAINT agent_executions_cancelled_shape CHECK (
    status <> 'cancelled' OR (error_code = 'cancelled' AND result IS NULL)
  ),
  CONSTRAINT agent_executions_attempts_bounded CHECK (attempts_count <= max_attempts),
  CONSTRAINT agent_executions_gate_linked CHECK (
    (policy_outcome = 'allowed' AND status <> 'refused' AND action_request_id IS NOT NULL)
    OR (policy_outcome = 'approval_required' AND action_request_id IS NOT NULL)
    OR (policy_outcome = 'forbidden' AND status = 'refused' AND action_request_id IS NOT NULL)
  )
);

CREATE INDEX agent_executions_tenant_submitted_idx
  ON agent_executions (tenant_id, submitted_at DESC);
CREATE INDEX agent_executions_tenant_status_idx
  ON agent_executions (tenant_id, status);
CREATE INDEX agent_executions_tenant_agent_idx
  ON agent_executions (tenant_id, agent_id);
CREATE INDEX agent_executions_tenant_correlation_idx
  ON agent_executions (tenant_id, correlation_id);

-- Storage-level immutability of the submission (W021): DELETE/TRUNCATE
-- are always forbidden, and an UPDATE may move ONLY the live state. The
-- message deliberately names no row id so the same function serves the
-- row-level and the statement-level triggers.

CREATE OR REPLACE FUNCTION agent_executions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'agent executions are immutable history (W021 agent gateway): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'agent executions are immutable history (W021 agent gateway): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.agent_id <> OLD.agent_id
     OR NEW.provider <> OLD.provider
     OR NEW.task <> OLD.task
     OR NEW.requested_permissions <> OLD.requested_permissions
     OR NEW.authority_level <> OLD.authority_level
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.causation_id IS DISTINCT FROM OLD.causation_id
     OR NEW.action_request_id IS DISTINCT FROM OLD.action_request_id
     OR NEW.policy_outcome <> OLD.policy_outcome
     OR NEW.policy_resolved_via <> OLD.policy_resolved_via
     OR NEW.max_attempts <> OLD.max_attempts
     OR NEW.submitted_by <> OLD.submitted_by
     OR NEW.submitted_at <> OLD.submitted_at THEN
    RAISE EXCEPTION 'agent executions are immutable history (W021 agent gateway): only the live state (status, attempts_count, result, error_code, error_detail, cost_minor, completed_at, updated_at) may change on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_executions_state_only_updates
  BEFORE UPDATE OR DELETE ON agent_executions
  FOR EACH ROW EXECUTE FUNCTION agent_executions_guard();

CREATE TRIGGER agent_executions_immutable_truncate
  BEFORE TRUNCATE ON agent_executions
  FOR EACH STATEMENT EXECUTE FUNCTION agent_executions_guard();
