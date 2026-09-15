-- W034 · llm module — per (account, model) availability events.
--
-- Availability is an OBSERVED property (providers fail and recover), so
-- its history is APPEND-ONLY evidence: one row per observed transition,
-- nothing may UPDATE, DELETE or TRUNCATE it — not even a future module
-- bypassing the service (the same storage-level discipline the channels
-- module applies to channel_threads and the actions module to its
-- decision trail).
--
-- `seq` (serial) gives the append log a total order that survives
-- same-millisecond service-clock collisions; "current availability" of an
-- (account, model) is the row with the highest seq (see the service's
-- DISTINCT ON query). `expires_at` carries the cooldown horizon for
-- `unavailable` events (NULL = indefinite); `available` events never
-- expire.
--
-- `source` distinguishes automatic observation ('execution' — recorded by
-- the invoke path when a provider call fails or a cooling-down target
-- recovers) from operator overrides ('manual' — setAiAvailability,
-- claim-gated).

CREATE TABLE llm_availability_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq serial NOT NULL UNIQUE,
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN (
    'openai', 'anthropic', 'google', 'mistral', 'cohere', 'deepseek', 'groq'
  )),
  model text NOT NULL,
  state text NOT NULL CHECK (state IN ('available', 'unavailable')),
  reason text,
  source text NOT NULL CHECK (source IN ('execution', 'manual')),
  expires_at timestamptz,
  observed_at timestamptz NOT NULL,
  observed_by text NOT NULL CHECK (observed_by <> ''),
  CONSTRAINT llm_availability_events_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT llm_availability_events_model_shape
    CHECK (char_length(model) BETWEEN 1 AND 255),
  CONSTRAINT llm_availability_events_reason_shape
    CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 500),
  CONSTRAINT llm_availability_events_expiry_semantics
    CHECK (state = 'unavailable' OR expires_at IS NULL)
);

CREATE INDEX llm_availability_events_current_idx
  ON llm_availability_events (tenant_id, account_id, model, seq DESC);
CREATE INDEX llm_availability_events_account_idx
  ON llm_availability_events (tenant_id, account_id, seq DESC);

-- Storage-level immutability (append-only availability evidence).

CREATE OR REPLACE FUNCTION llm_availability_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'llm availability events are append-only (observed transitions are evidence): % is forbidden on tenant %, table %',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER llm_availability_events_immutable
  BEFORE UPDATE OR DELETE ON llm_availability_events
  FOR EACH ROW EXECUTE FUNCTION llm_availability_reject_mutation();

CREATE TRIGGER llm_availability_events_immutable_truncate
  BEFORE TRUNCATE ON llm_availability_events
  FOR EACH STATEMENT EXECUTE FUNCTION llm_availability_reject_mutation();
