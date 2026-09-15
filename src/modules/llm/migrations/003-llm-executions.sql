-- W034 · llm module — LLM executions (append-only provider-interaction
-- evidence).
--
-- One row per real provider interaction (attempt): completed AND failed
-- attempts are both evidence, so a failover chain leaves one row per
-- attempt. Completed executions retain their provider/model metadata,
-- canonical result, usage, deterministic cost and measured latency
-- (ARCHITECTURE.md §18: "Completed executions retain provider/model
-- metadata for auditability"); the result itself is canonical and
-- provider-neutral, and it is EVIDENCE — never authoritative business
-- state (lock 10).
--
-- Columns:
--  * purpose      — 'invocation' (the gateway path) or
--                   'hot-swap-verification' (the W048 seed inside W034);
--  * provider / model / account_id — the routing outcome, for audit;
--  * result       — canonical result jsonb when completed; NULL on failure;
--  * error_code / error_detail — canonical failure code + human detail
--                   when failed; NULL on completion;
--  * input_tokens / output_tokens / cost_minor / cost_currency — usage and
--                   deterministic cost (integer minor units + ISO code,
--                   IMPLEMENTATION-STACK §8); failed attempts carry zeros;
--  * latency_ms   — measured wall-clock duration of the provider call;
--  * provider_execution_id — the provider's own execution id (OPAQUE
--                   string — the only provider-minted value stored);
--  * action_request_id / policy_outcome / policy_resolved_via — the W009
--                   authority-gate decision that admitted the execution:
--                   the reconstructable `policy → model/provider →
--                   execution` chain ARCHITECTURE.md §24 demands. No
--                   cross-module foreign key is possible (the actions
--                   module owns action_requests — the same discipline the
--                   channels module applies to conversation_id);
--  * routing      — the frozen routing decision: every (account, model)
--                   candidate considered, its eligibility reason, and the
--                   chosen target.
--
-- APPEND-ONLY: executions are history the moment they happen — nothing may
-- UPDATE, DELETE or TRUNCATE them, not even a future module bypassing the
-- service.

CREATE TABLE llm_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq serial NOT NULL UNIQUE,
  tenant_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('invocation', 'hot-swap-verification')),
  capability text NOT NULL CHECK (capability IN ('text-generation', 'embedding')),
  provider text NOT NULL CHECK (provider IN (
    'openai', 'anthropic', 'google', 'mistral', 'cohere', 'deepseek', 'groq'
  )),
  model text NOT NULL,
  account_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('completed', 'failed')),
  error_code text,
  error_detail text,
  result jsonb,
  input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens BETWEEN 0 AND 100000000),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens BETWEEN 0 AND 100000000),
  cost_minor integer NOT NULL DEFAULT 0 CHECK (cost_minor BETWEEN 0 AND 2000000000),
  cost_currency text NOT NULL DEFAULT 'USD' CHECK (cost_currency = 'USD'),
  latency_ms integer NOT NULL CHECK (latency_ms >= 0),
  provider_execution_id text,
  action_request_id uuid,
  policy_outcome text CHECK (policy_outcome IN ('allowed', 'approval_required', 'forbidden')),
  policy_resolved_via text CHECK (policy_resolved_via IN ('kind', 'tenant-default', 'built-in')),
  routing jsonb NOT NULL,
  invoked_by text NOT NULL CHECK (invoked_by <> ''),
  invoked_at timestamptz NOT NULL,
  CONSTRAINT llm_executions_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT llm_executions_model_shape
    CHECK (char_length(model) BETWEEN 1 AND 255),
  CONSTRAINT llm_executions_error_shape
    CHECK (char_length(error_code) BETWEEN 1 AND 100
           AND (error_detail IS NULL OR char_length(error_detail) BETWEEN 1 AND 500)),
  CONSTRAINT llm_executions_provider_execution_id_shape
    CHECK (provider_execution_id IS NULL OR char_length(provider_execution_id) BETWEEN 1 AND 255),
  CONSTRAINT llm_executions_completed_has_result
    CHECK (status = 'failed' OR result IS NOT NULL),
  CONSTRAINT llm_executions_failed_has_error
    CHECK (status = 'completed' OR (error_code IS NOT NULL AND result IS NULL)),
  CONSTRAINT llm_executions_policy_pair
    CHECK ((action_request_id IS NULL) = (policy_outcome IS NULL)
           AND (policy_outcome IS NULL) = (policy_resolved_via IS NULL))
);

CREATE INDEX llm_executions_tenant_invoked_idx
  ON llm_executions (tenant_id, invoked_at DESC, seq DESC);
CREATE INDEX llm_executions_tenant_account_idx
  ON llm_executions (tenant_id, account_id, invoked_at DESC);
CREATE INDEX llm_executions_tenant_provider_model_idx
  ON llm_executions (tenant_id, provider, model);
CREATE INDEX llm_executions_tenant_usage_idx
  ON llm_executions (tenant_id, status, invoked_at);

-- Storage-level immutability (append-only execution evidence).

CREATE OR REPLACE FUNCTION llm_executions_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'llm executions are append-only (provider interactions are evidence): % is forbidden on tenant %, table %',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER llm_executions_immutable
  BEFORE UPDATE OR DELETE ON llm_executions
  FOR EACH ROW EXECUTE FUNCTION llm_executions_reject_mutation();

CREATE TRIGGER llm_executions_immutable_truncate
  BEFORE TRUNCATE ON llm_executions
  FOR EACH STATEMENT EXECUTE FUNCTION llm_executions_reject_mutation();
