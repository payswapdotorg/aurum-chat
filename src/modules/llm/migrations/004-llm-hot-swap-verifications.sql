-- W034 · llm module — provider hot-swap verification records.
--
-- One row per verification run: the SAME canonical capability request
-- executed through two different (provider, model) targets with no
-- business-code or contract change (GOVERNANCE.md "Provider swap
-- evidence": "The same provider-independent AI capability must execute
-- through at least two providers/models ... Domain semantics and persisted
-- authoritative state must remain unchanged" — the module-level seed W034
-- owns; W048 builds the cross-surface proof on top).
--
-- `request_digest` (SHA-256 hex of the canonical request) proves both
-- targets executed byte-identical requests; the two execution ids carry
-- the per-target provider/model metadata, usage, cost and latency.
-- `outcome` is a DETERMINISTIC structural comparison (equivalent /
-- completed-divergent / failed) — semantic judgment stays with the caller
-- (see the service and the contract documentation).
--
-- APPEND-ONLY: a verification is evidence the moment it completes; nothing
-- may rewrite what was verified (storage-level triggers, like executions).

CREATE TABLE llm_hot_swap_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  capability text NOT NULL CHECK (capability IN ('text-generation', 'embedding')),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  account_a uuid NOT NULL,
  provider_a text NOT NULL CHECK (provider_a IN (
    'openai', 'anthropic', 'google', 'mistral', 'cohere', 'deepseek', 'groq'
  )),
  model_a text NOT NULL,
  execution_a uuid NOT NULL,
  account_b uuid NOT NULL,
  provider_b text NOT NULL CHECK (provider_b IN (
    'openai', 'anthropic', 'google', 'mistral', 'cohere', 'deepseek', 'groq'
  )),
  model_b text NOT NULL,
  execution_b uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('equivalent', 'completed-divergent', 'failed')),
  note text,
  requested_by text NOT NULL CHECK (requested_by <> ''),
  verified_at timestamptz NOT NULL,
  CONSTRAINT llm_hot_swap_verifications_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT llm_hot_swap_verifications_targets_differ
    CHECK (provider_a <> provider_b OR model_a <> model_b),
  CONSTRAINT llm_hot_swap_verifications_model_shape
    CHECK (char_length(model_a) BETWEEN 1 AND 255 AND char_length(model_b) BETWEEN 1 AND 255),
  CONSTRAINT llm_hot_swap_verifications_note_shape
    CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500)
);

CREATE INDEX llm_hot_swap_verifications_tenant_idx
  ON llm_hot_swap_verifications (tenant_id, verified_at DESC);

-- Storage-level immutability (append-only verification evidence).

CREATE OR REPLACE FUNCTION llm_hot_swap_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'llm hot-swap verifications are append-only (verification is evidence): % is forbidden on tenant %, table %',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER llm_hot_swap_verifications_immutable
  BEFORE UPDATE OR DELETE ON llm_hot_swap_verifications
  FOR EACH ROW EXECUTE FUNCTION llm_hot_swap_reject_mutation();

CREATE TRIGGER llm_hot_swap_verifications_immutable_truncate
  BEFORE TRUNCATE ON llm_hot_swap_verifications
  FOR EACH STATEMENT EXECUTE FUNCTION llm_hot_swap_reject_mutation();
