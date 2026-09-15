-- W034 · llm module — tenant-owned AI provider accounts (BYOA).
--
-- One row per tenant-owned provider account the gateway may route to
-- (ARCHITECTURE.md §18: "Tenants may connect their own AI providers/
-- accounts through AIProviderAccount records, with scopes, capability
-- permissions, budgets, routing preferences and data policies"; lock 29).
-- Mirrors the channels module's channel_connections discipline:
--  * `credential_ref` is an OPAQUE reference into the secret store — the
--    credential VALUE never reaches any domain table (IMPLEMENTATION-STACK
--    §8; GOVERNANCE mandatory invariant: credentials are tenant-scoped and
--    never stored in semantic memory);
--  * UNIQUE (tenant_id, provider, label) makes re-registration idempotent
--    (first registration wins, exactly like channel endpoints).
--
-- Columns carry the §18 concerns as first-class, separately-configurable
-- facts (each feeds a distinct, tested eligibility check in routing.ts):
--  * scopes                — which Aurum surfaces may use the account;
--  * capabilities          — which canonical capabilities the account
--                            permits (subset of the model's own set);
--  * max_data_classification — the account's data-policy ceiling
--                            ('public' < 'internal' < 'restricted');
--  * priority              — routing preference (lower first); the
--                            registry and the adapter set carry NO
--                            privilege (lock 30 — no provider/model is
--                            architecturally privileged);
--  * budget_minor / budget_currency — monthly (UTC) spend cap in integer
--                            minor units on completed executions
--                            (IMPLEMENTATION-STACK §8 money convention);
--                            NULL budget = uncapped.
--
-- This is configuration state, NOT evidence: the mutable fields
-- (credential rotation, scopes, capabilities, policy, priority, budget,
-- status) are updatable management controls through updateAiProviderAccount
-- (`llm:administer` claim-gated), so none of the append-only triggers that
-- guard the observation-derived tables apply here.
--
-- NOTE: the provider CHECK mirrors LLM_PROVIDERS in
-- src/modules/llm/registry.ts — keep both in sync.

CREATE TABLE ai_provider_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN (
    'openai', 'anthropic', 'google', 'mistral', 'cohere', 'deepseek', 'groq'
  )),
  label text NOT NULL,
  credential_ref text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  scopes text[] NOT NULL,
  capabilities text[] NOT NULL,
  max_data_classification text NOT NULL CHECK (max_data_classification IN (
    'public', 'internal', 'restricted'
  )),
  priority integer NOT NULL CHECK (priority BETWEEN 0 AND 1000),
  budget_minor integer CHECK (budget_minor IS NULL OR budget_minor BETWEEN 1 AND 2000000000),
  budget_currency text NOT NULL DEFAULT 'USD' CHECK (budget_currency = 'USD'),
  created_by text NOT NULL CHECK (created_by <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_provider_accounts_tenant_provider_label_unique
    UNIQUE (tenant_id, provider, label),
  CONSTRAINT ai_provider_accounts_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT ai_provider_accounts_label_shape
    CHECK (char_length(label) BETWEEN 1 AND 100),
  CONSTRAINT ai_provider_accounts_credential_shape
    CHECK (char_length(credential_ref) BETWEEN 1 AND 255),
  CONSTRAINT ai_provider_accounts_scopes_vocabulary CHECK (
    cardinality(scopes) BETWEEN 1 AND 4
    AND scopes <@ ARRAY['cognition', 'conversation', 'analysis', 'background']
  ),
  CONSTRAINT ai_provider_accounts_capabilities_vocabulary CHECK (
    cardinality(capabilities) BETWEEN 1 AND 2
    AND capabilities <@ ARRAY['text-generation', 'embedding']
  )
);

CREATE INDEX ai_provider_accounts_tenant_provider_idx
  ON ai_provider_accounts (tenant_id, provider, status);
CREATE INDEX ai_provider_accounts_tenant_routing_idx
  ON ai_provider_accounts (tenant_id, priority, created_at);
