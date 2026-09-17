-- W035 · agents module — tenant-registered agent runtime accounts.
--
-- One row per tenant-owned runtime deployment the gateway may route
-- dispatches to (work item W035: "Register multiple agent runtimes/providers
-- and route execution without semantic provider coupling"; lock 29: "Tenants
-- may BYOA through explicit AIProviderAccount and agent/provider account
-- boundaries"). Mirrors the llm module's ai_provider_accounts discipline:
--  * `credential_ref` is an OPAQUE reference into the secret store — the
--    credential VALUE never reaches any domain table (IMPLEMENTATION-STACK
--    §8; GOVERNANCE mandatory invariant: credentials are tenant-scoped and
--    never stored in semantic memory);
--  * UNIQUE (tenant_id, provider, label) makes re-registration idempotent
--    (first registration wins — the agents module's own slug rule); a
--    tenant may register ANY number of accounts per runtime family.
--
-- Columns carry the routing concerns as first-class, separately
-- configurable facts (each feeds a distinct, tested eligibility check in
-- routing.ts):
--  * provider              — the canonical runtime family (closed
--                            vocabulary, CHECK below — mirrors policy.ts);
--  * capabilities          — which canonical execution capabilities the
--                            account PERMITS (the tenant's own permission,
--                            a subset of the registry runtime's set);
--  * max_authority_level   — the account's §20 authority ceiling: an
--                            execution authorized above it never routes
--                            here (the authority matrix applies uniformly,
--                            §20);
--  * priority              — routing preference (lower first); the registry
--                            carries NO privilege (lock 30 mirrored — no
--                            runtime is architecturally privileged);
--  * status                — enable/disable (management control).
--
-- This is configuration state, NOT evidence: the mutable fields
-- (credential rotation, capabilities, authority ceiling, priority, status)
-- are updatable management controls through updateAgentRuntimeAccount
-- (`agents:administer` claim-gated), so none of the append-only triggers
-- that guard the observation-derived tables apply here.
--
-- NOTE: the provider CHECK mirrors AGENT_RUNTIME_PROVIDERS in
-- src/modules/agents/policy.ts and the registry in registry.ts — keep all
-- three in sync.

CREATE TABLE agent_runtime_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN (
    'openai-assistants', 'langgraph', 'crewai', 'autogen', 'semantic-kernel'
  )),
  label text NOT NULL,
  credential_ref text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  capabilities text[] NOT NULL,
  max_authority_level text NOT NULL CHECK (max_authority_level IN (
    'OBSERVE', 'ANALYZE', 'RECOMMEND', 'ASK', 'PROPOSE', 'EXECUTE'
  )),
  priority integer NOT NULL CHECK (priority BETWEEN 0 AND 1000),
  created_by text NOT NULL CHECK (created_by <> ''),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT agent_runtime_accounts_tenant_provider_label_unique
    UNIQUE (tenant_id, provider, label),
  CONSTRAINT agent_runtime_accounts_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT agent_runtime_accounts_label_shape
    CHECK (char_length(label) BETWEEN 1 AND 100),
  CONSTRAINT agent_runtime_accounts_credential_shape
    CHECK (char_length(credential_ref) BETWEEN 1 AND 255),
  CONSTRAINT agent_runtime_accounts_capabilities_vocabulary CHECK (
    cardinality(capabilities) BETWEEN 1 AND 8
    AND capabilities <@ ARRAY['task-execution']
  )
);

CREATE INDEX agent_runtime_accounts_tenant_provider_idx
  ON agent_runtime_accounts (tenant_id, provider, status);
CREATE INDEX agent_runtime_accounts_tenant_routing_idx
  ON agent_runtime_accounts (tenant_id, priority, created_at);
