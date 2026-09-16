-- W021 · agents module — agent execution attempts (append-only evidence).
--
-- One row per provider dispatch performed by the `runAgentExecution`
-- pump: the EVIDENCE half of the execution contract (§16 "execution →
-- normalized result/evidence/cost/outcome"; §24 reconstructability).
-- Attempts are strictly append-only — PostgreSQL triggers reject
-- UPDATE, DELETE and TRUNCATE outright (the llm module's executions
-- discipline): what was dispatched, to which runtime, with which
-- provider task id, how long it took, what it cost and what it
-- normalized into is history the moment it happens.
--
-- Columns:
--   * attempt_number — 1..max_attempts, unique per execution (also the
--     double-dispatch guard: a racing pump that computed the same next
--     attempt number loses on the UNIQUE constraint);
--   * provider / provider_task_id — the canonical runtime key and the
--     runtime's own task/run id (opaque string);
--   * status         — 'completed' (the response normalized into a
--     canonical result) or 'failed';
--   * retryable      — the deterministic failure classification
--     (policy.ts): true only for transient transport failures, which
--     the execution may retry;
--   * error_code / error_detail — the canonical failure classification
--     when failed ('dispatch_failed' / 'dispatch_rejected' /
--     'result_invalid');
--   * result         — the CANONICAL result when completed
--     ({ output, summary } — provider-neutral, adapter-parsed);
--   * input_tokens / output_tokens / operations — provider-reported
--     usage, normalized (NULL = not reported);
--   * cost_minor     — this attempt's deterministic integer-minor-unit
--     cost (adapter pricing; completed attempts only — a failed
--     dispatch reports no usage);
--   * latency_ms     — measured dispatch duration (service clock);
--   * dispatched_at / finished_at — the attempt's bounded time box;
--   * dispatched_by  — the pump's acting principal (workers preserve
--     tenant context, ADR-0001).
--
-- Tenant scoping (ADR-0001): every row carries tenant_id.

CREATE TABLE agent_execution_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number >= 1),
  provider text NOT NULL CHECK (provider IN (
    'openai-assistants', 'langgraph', 'crewai', 'autogen', 'semantic-kernel'
  )),
  status text NOT NULL CHECK (status IN ('completed', 'failed')),
  retryable boolean NOT NULL,
  error_code text,
  error_detail text,
  result jsonb,
  input_tokens integer,
  output_tokens integer,
  operations integer,
  cost_minor bigint NOT NULL DEFAULT 0 CHECK (cost_minor >= 0),
  cost_currency text NOT NULL DEFAULT 'USD' CHECK (cost_currency = 'USD'),
  provider_task_id text,
  latency_ms integer NOT NULL CHECK (latency_ms >= 0),
  dispatched_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  dispatched_by text NOT NULL CHECK (dispatched_by <> ''),
  CONSTRAINT agent_execution_attempts_slot_unique UNIQUE (tenant_id, execution_id, attempt_number),
  CONSTRAINT agent_execution_attempts_completed_shape CHECK (
    status <> 'completed' OR (result IS NOT NULL AND error_code IS NULL AND retryable = false)
  ),
  CONSTRAINT agent_execution_attempts_failed_shape CHECK (
    status <> 'failed' OR (error_code IS NOT NULL AND result IS NULL)
  ),
  CONSTRAINT agent_execution_attempts_usage_shape CHECK (
    (input_tokens IS NULL OR input_tokens >= 0)
    AND (output_tokens IS NULL OR output_tokens >= 0)
    AND (operations IS NULL OR operations >= 0)
  )
);

CREATE INDEX agent_execution_attempts_execution_idx
  ON agent_execution_attempts (tenant_id, execution_id, attempt_number);

-- Append-only evidence (W021): attempts are immutable history — no
-- UPDATE, no DELETE, no TRUNCATE, for any caller.

CREATE OR REPLACE FUNCTION agent_execution_attempts_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'agent execution attempts are append-only evidence (W021 agent gateway): UPDATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'agent execution attempts are append-only evidence (W021 agent gateway): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'agent execution attempts are append-only evidence (W021 agent gateway): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_execution_attempts_append_only
  BEFORE UPDATE OR DELETE ON agent_execution_attempts
  FOR EACH ROW EXECUTE FUNCTION agent_execution_attempts_guard();

CREATE TRIGGER agent_execution_attempts_immutable_truncate
  BEFORE TRUNCATE ON agent_execution_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION agent_execution_attempts_guard();
