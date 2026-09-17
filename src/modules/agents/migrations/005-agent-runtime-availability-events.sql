-- W035 · agents module — per runtime account availability events.
--
-- Availability is an OBSERVED property (runtimes fail and recover), so its
-- history is APPEND-ONLY evidence: one row per observed transition, nothing
-- may UPDATE, DELETE or TRUNCATE it — not even a future module bypassing
-- the service (the llm module's llm_availability_events discipline, applied
-- to the agent runtime family).
--
-- `seq` (serial) gives the append log a total order that survives
-- same-millisecond service-clock collisions; "current availability" of an
-- account is the row with the highest seq (the service's DISTINCT ON
-- query). `expires_at` carries the cooldown horizon for `unavailable`
-- events (NULL = indefinite); `available` events never expire.
--
-- `source` distinguishes automatic observation ('execution' — recorded by
-- the dispatch path when a routed account fails transiently, or recovers
-- after a cooldown) from operator overrides ('manual' —
-- setAgentRuntimeAvailability, claim-gated).

CREATE TABLE agent_runtime_availability_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq serial NOT NULL UNIQUE,
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN (
    'openai-assistants', 'langgraph', 'crewai', 'autogen', 'semantic-kernel'
  )),
  state text NOT NULL CHECK (state IN ('available', 'unavailable')),
  reason text,
  source text NOT NULL CHECK (source IN ('execution', 'manual')),
  expires_at timestamptz,
  observed_at timestamptz NOT NULL,
  observed_by text NOT NULL CHECK (observed_by <> ''),
  CONSTRAINT agent_runtime_availability_events_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT agent_runtime_availability_events_reason_shape
    CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 500),
  CONSTRAINT agent_runtime_availability_events_expiry_semantics
    CHECK (state = 'unavailable' OR expires_at IS NULL)
);

CREATE INDEX agent_runtime_availability_events_current_idx
  ON agent_runtime_availability_events (tenant_id, account_id, seq DESC);

-- Storage-level immutability (append-only availability evidence).

CREATE OR REPLACE FUNCTION agent_runtime_availability_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'agent runtime availability events are append-only (observed transitions are evidence): % is forbidden on tenant %, table %',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_runtime_availability_events_immutable
  BEFORE UPDATE OR DELETE ON agent_runtime_availability_events
  FOR EACH ROW EXECUTE FUNCTION agent_runtime_availability_reject_mutation();

CREATE TRIGGER agent_runtime_availability_events_immutable_truncate
  BEFORE TRUNCATE ON agent_runtime_availability_events
  FOR EACH STATEMENT EXECUTE FUNCTION agent_runtime_availability_reject_mutation();
