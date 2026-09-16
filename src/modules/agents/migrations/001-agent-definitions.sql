-- W021 · agents module — persistent agent definitions.
--
-- ARCHITECTURE.md §16 (frozen): "Persistent agent definitions are
-- separated from execution infrastructure: agent definition → Agent
-- Gateway → runtime/provider adapter → execution → normalized
-- result/evidence/cost/outcome." This table is the PERSISTENT side of
-- that separation: WHAT an agent is and MAY do, independent of the
-- infrastructure that runs it.
--
-- Columns:
--   * slug / display_name / role / description — identity and role
--     (the full organizational actor — objectives, budget, owner,
--     review schedule — is layered on by W022–W024, not redefined here);
--   * provider        — the canonical runtime provider key (closed
--     vocabulary, CHECK below; provider SDKs and native objects stay
--     inside the module's adapters/);
--   * instructions    — the agent's operating contract;
--   * runtime_config  — OPAQUE, adapter-consumed configuration (plain
--     JSON ≤ 64 KiB): provider-side assistant/crew/team ids, model
--     bindings, tool wiring. Credential VALUES never belong here — only
--     opaque secret-store references (GOVERNANCE mandatory invariant);
--   * permissions     — the granted permission scopes (the lowercase
--     §20 authority-level mirrors; sorted jsonb array, the house pattern
--     for list columns); every execution must request a subset;
--   * status          — active/disabled (management configuration; the
--     W022–W024 lifecycle builds on top).
--
-- Definitions are tenant-scoped management CONTROLS (like the llm
-- module's ai_provider_accounts and the sources module's connections):
-- legitimately updatable, therefore NO immutability triggers — their
-- change history belongs to audit (W046). One agent per (tenant, slug).
--
-- Tenant scoping (ADR-0001): every row carries tenant_id.

CREATE TABLE agent_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  display_name text,
  role text NOT NULL CHECK (role <> ''),
  description text,
  provider text NOT NULL CHECK (provider IN (
    'openai-assistants', 'langgraph', 'crewai', 'autogen', 'semantic-kernel'
  )),
  instructions text NOT NULL CHECK (instructions <> ''),
  runtime_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by text NOT NULL CHECK (created_by <> ''),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT agent_definitions_slug_tenant_unique UNIQUE (tenant_id, slug),
  CONSTRAINT agent_definitions_permissions_shape CHECK (jsonb_typeof(permissions) = 'array'),
  CONSTRAINT agent_definitions_permissions_vocabulary CHECK (
    permissions <@ '["observe","analyze","recommend","ask","propose","execute"]'::jsonb
  )
);

CREATE INDEX agent_definitions_tenant_provider_idx
  ON agent_definitions (tenant_id, provider);
CREATE INDEX agent_definitions_tenant_status_idx
  ON agent_definitions (tenant_id, status);

-- The grant-shape guard: permissions are deduplicated and canonically
-- ordered, so equal grants always serialize identically (determinism —
-- the service validates this; the trigger keeps rows well-formed
-- regardless of which path wrote them).

CREATE OR REPLACE FUNCTION agent_definitions_check_permissions() RETURNS trigger AS $$
DECLARE
  scope text;
  vocabulary text[] := ARRAY['observe','analyze','recommend','ask','propose','execute'];
  seen text[];
BEGIN
  FOR scope IN SELECT jsonb_array_elements_text(NEW.permissions) LOOP
    IF NOT scope = ANY(vocabulary) THEN
      RAISE EXCEPTION 'unknown permission scope ''%'' in permissions (W021 agent gateway)', scope;
    END IF;
    IF scope = ANY(seen) THEN
      RAISE EXCEPTION 'permission scope ''%'' appears twice in permissions (W021 agent gateway)', scope;
    END IF;
    seen := seen || scope;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_definitions_permissions_valid
  BEFORE INSERT OR UPDATE ON agent_definitions
  FOR EACH ROW EXECUTE FUNCTION agent_definitions_check_permissions();
