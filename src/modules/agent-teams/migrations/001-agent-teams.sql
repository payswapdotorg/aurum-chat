-- W023 · agent-teams module — team identity + the append-only version
-- chain that carries the team contract.
--
-- ARCHITECTURE.md §15 (frozen): "AgentTeam is a first-class
-- organizational actor composed of agents with roles, topology, shared
-- objectives, budget, escalation rules and team-level outcomes."
-- Lock 22: "Agent and AgentTeam are organizational actors with explicit
-- contracts, budgets, permissions and outcomes." ADR-0008: "AgentTeam
-- is a first-class actor."
--
-- Two tables, the goals/missions (W008/W011) split, deliberately
-- identical in discipline:
--
--   agent_teams          — identity + the CURRENT version pointer:
--                          the stable slug (unique per tenant — the
--                          agents module's identity discipline) and
--                          nothing else. The pointer advances by
--                          UPDATE (that is its only job); DELETE and
--                          TRUNCATE are rejected by trigger — a team's
--                          identity and history are never erased
--                          (dissolution, a versioned terminal
--                          transition, is the retirement path; there is
--                          no delete operation on the contract either).
--
--   agent_team_versions  — the append-only AUDIT CHAIN: one row per
--                          version, each a FULL self-contained snapshot
--                          of the team contract plus the audit quartet:
--                            * who   — actor (provider-neutral party:
--                                      kind + id or label, traceable)
--                                      AND changed_by_principal (the
--                                      authenticated TenantContext
--                                      principal, system-minted);
--                            * when  — recorded_at (service clock,
--                                      never caller-supplied);
--                            * what  — change_kind (created/revised/
--                                      activated/dissolved,
--                                      service-derived) + the full
--                                      content snapshot (any version
--                                      decodes without reading the
--                                      others) + the authority-gate
--                                      linkage on lifecycle versions;
--                            * why   — rationale (revisions) or the
--                                      required dissolution reason.
--                          UPDATE/DELETE/TRUNCATE are rejected by
--                          triggers — composition changes are auditable
--                          history, never silent rewrites (§24).
--
-- Content columns mirror the W023 definition:
--   * topology       — flat (peers, no reporting lines) or
--                      hierarchical (exactly one root — the
--                      coordinator — with a reporting tree);
--   * members        — jsonb array of {agentId, role, reportsTo}:
--                      the roster with per-member ROLES and reporting
--                      lines (the topology). Agent ids are OPAQUE
--                      forward references to agents module (W021)
--                      records — no cross-module foreign keys (the
--                      missions affected-goals precedent); they are
--                      validated readable through the agents contract
--                      at write time;
--   * objectives     — jsonb array of {key, objective,
--                      successCriteria}: the SHARED OBJECTIVES every
--                      member works toward; keys are stable slugs
--                      outcomes reference; at least one is required;
--   * budget_amount_minor / budget_currency — the team BUDGET
--                      envelope, integer minor units + ISO 4217-shaped
--                      currency (IMPLEMENTATION-STACK §8 money
--                      convention);
--   * escalation_rules — jsonb array of {trigger, threshold, route}:
--                      the ESCALATION policy — member-failure (int
--                      threshold ≥ 1), budget-threshold (fraction in
--                      (0, 1]) and authority-gap (no threshold),
--                      routed to the coordinator (hierarchical only),
--                      the owner (owner required) or management;
--   * owner_principal — the accountable human principal;
--   * status         — draft/active/dissolved (versioned content, so
--                      lifecycle changes are auditable like every
--                      other change);
--   * action_request_id — the actions module (W009) request that
--                      gated the lifecycle transition; present exactly
--                      on 'activated'/'dissolved' versions (the gate
--                      shape is CHECK-enforced).
--
-- Storage-level guarantees (not just service discipline):
--   * the content trigger below enforces the STRUCTURAL invariants —
--     roster shape (uuid agent ids, non-empty roles, unique agents),
--     topology consistency (flat ⇒ no reporting lines; hierarchical ⇒
--     exactly one root, reportsTo ∈ roster, no self-report, no
--     cycles), objective shape (unique keys, non-empty statements) and
--     escalation consistency (trigger vocabulary + threshold rules +
--     route landing spots + no duplicate rules) — even for a caller
--     bypassing the service;
--   * the mutation triggers reject UPDATE/DELETE/TRUNCATE on versions
--     and DELETE/TRUNCATE on identities.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the
-- composite FK (team_id, tenant_id) → agent_teams (id, tenant_id)
-- makes a cross-tenant version unrepresentable in SQL (the
-- mission_versions pattern).

CREATE TABLE agent_teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_teams_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT agent_teams_slug_tenant_unique UNIQUE (tenant_id, slug)
);

CREATE INDEX agent_teams_tenant_idx ON agent_teams (tenant_id);

CREATE TABLE agent_team_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  team_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  change_kind text NOT NULL CHECK (change_kind IN (
    'created', 'revised', 'activated', 'dissolved'
  )),
  display_name text
    CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 128),
  description text
    CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 2048),
  topology text NOT NULL CHECK (topology IN ('flat', 'hierarchical')),
  members jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(members) = 'array'),
  objectives jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(objectives) = 'array'),
  budget_amount_minor bigint NOT NULL
    CHECK (budget_amount_minor >= 0 AND budget_amount_minor <= 9007199254740991),
  budget_currency text NOT NULL CHECK (budget_currency ~ '^[A-Z]{3}$'),
  escalation_rules jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(escalation_rules) = 'array'),
  owner_principal text
    CHECK (owner_principal IS NULL OR char_length(owner_principal) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('draft', 'active', 'dissolved')),
  actor_kind text NOT NULL CHECK (actor_kind IN (
    'person', 'team', 'agent', 'system', 'external'
  )),
  actor_id text,
  actor_label text
    CHECK (actor_label IS NULL OR char_length(actor_label) BETWEEN 1 AND 200),
  changed_by_principal text NOT NULL CHECK (changed_by_principal <> ''),
  rationale text
    CHECK (rationale IS NULL OR char_length(rationale) BETWEEN 1 AND 2000),
  action_request_id text
    CHECK (action_request_id IS NULL
      OR action_request_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_team_versions_team_version_unique UNIQUE (tenant_id, team_id, version),
  CONSTRAINT agent_team_versions_team_fk
    FOREIGN KEY (team_id, tenant_id) REFERENCES agent_teams (id, tenant_id),
  CONSTRAINT agent_team_versions_actor_traceable CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL),
  -- The version's status agrees with its change kind: lifecycle
  -- transitions are surgical ('activated' versions are active teams,
  -- 'dissolved' versions are dissolved teams); 'created' mints a draft
  -- and 'revised' carries the status forward.
  CONSTRAINT agent_team_versions_status_agrees CHECK (
    (change_kind = 'created' AND status = 'draft')
    OR (change_kind = 'revised' AND status IN ('draft', 'active'))
    OR (change_kind = 'activated' AND status = 'active')
    OR (change_kind = 'dissolved' AND status = 'dissolved')
  ),
  -- The authority-gate linkage exists exactly on lifecycle versions:
  -- every activation/dissolution names the W009 request that decided
  -- it; content versions (created/revised) are claim-gated writes and
  -- carry no gate request.
  CONSTRAINT agent_team_versions_gate_shape CHECK (
    (change_kind IN ('activated', 'dissolved') AND action_request_id IS NOT NULL)
    OR (change_kind IN ('created', 'revised') AND action_request_id IS NULL)
  )
);

-- History + current-view lookups: (tenant_id, team_id, version) is
-- covered by the unique constraint above; these cover the management
-- list filters and the gate-replay lookup.
CREATE INDEX agent_team_versions_team_idx ON agent_team_versions (tenant_id, team_id, version);
CREATE INDEX agent_team_versions_status_idx ON agent_team_versions (tenant_id, status);
CREATE INDEX agent_team_versions_gate_idx ON agent_team_versions (tenant_id, action_request_id);

-- ---------------------------------------------------------------------------
-- Structural content invariants (defense in depth — the service
-- validates the same rules through pure policy functions first)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION agent_team_versions_check_content() RETURNS trigger AS $$
DECLARE
  member jsonb;
  objective jsonb;
  rule jsonb;
  agent_ids text[] := ARRAY[]::text[];
  reports_count integer := 0;
  roots integer := 0;
  seen text[];
  cursor_id text;
  steps integer;
  objective_keys text[] := ARRAY[]::text[];
  rule_sig text;
  rule_sigs text[] := ARRAY[]::text[];
  trigger_vocabulary text[] := ARRAY['member-failure', 'budget-threshold', 'authority-gap'];
  route_vocabulary text[] := ARRAY['coordinator', 'owner', 'management'];
  threshold_text text;
BEGIN
  -- Roster: composed of at least one agent, uuid agent ids,
  -- non-empty roles, one slot per agent.
  IF jsonb_array_length(NEW.members) = 0 THEN
    RAISE EXCEPTION 'an agent team is composed of at least one agent (W023)';
  END IF;
  IF jsonb_array_length(NEW.members) > 32 THEN
    RAISE EXCEPTION 'an agent team roster holds at most 32 members (W023)';
  END IF;
  FOR member IN SELECT jsonb_array_elements(NEW.members) LOOP
    IF member->>'agentId' IS NULL
       OR member->>'agentId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'agent-team member agentId must be a uuid (W023)';
    END IF;
    IF member->>'role' IS NULL OR member->>'role' = '' OR char_length(member->>'role') > 128 THEN
      RAISE EXCEPTION 'agent-team member role must be a non-empty string of at most 128 characters (W023)';
    END IF;
    IF (member->>'agentId') = ANY(agent_ids) THEN
      RAISE EXCEPTION 'agent ''%'' appears twice in the agent-team roster (W023)', member->>'agentId';
    END IF;
    agent_ids := agent_ids || (member->>'agentId');
  END LOOP;

  -- Reporting lines: membership, no self-report, and the topology split.
  FOR member IN SELECT jsonb_array_elements(NEW.members) LOOP
    IF member->>'reportsTo' IS NOT NULL THEN
      IF (member->>'reportsTo') = (member->>'agentId') THEN
        RAISE EXCEPTION 'agent-team member ''%'' reports to itself (W023)', member->>'agentId';
      END IF;
      IF NOT (member->>'reportsTo') = ANY(agent_ids) THEN
        RAISE EXCEPTION 'agent-team member ''%'' reports to unknown agent ''%'' (W023)',
          member->>'agentId', member->>'reportsTo';
      END IF;
      reports_count := reports_count + 1;
    END IF;
  END LOOP;
  roots := jsonb_array_length(NEW.members) - reports_count;

  IF NEW.topology = 'flat' AND reports_count > 0 THEN
    RAISE EXCEPTION 'a flat agent team has no reporting lines (W023)';
  END IF;
  IF NEW.topology = 'hierarchical' THEN
    IF roots <> 1 THEN
      RAISE EXCEPTION 'a hierarchical agent team has exactly one coordinator (root member); found % (W023)', roots;
    END IF;
    -- Acyclicity: walking up from any member must reach the root
    -- without revisiting a node.
    FOR member IN SELECT jsonb_array_elements(NEW.members) LOOP
      seen := ARRAY[]::text[];
      cursor_id := member->>'agentId';
      steps := 0;
      WHILE cursor_id IS NOT NULL LOOP
        IF cursor_id = ANY(seen) THEN
          RAISE EXCEPTION 'agent-team reporting lines form a cycle at ''%'' (W023)', cursor_id;
        END IF;
        seen := seen || cursor_id;
        steps := steps + 1;
        IF steps > jsonb_array_length(NEW.members) THEN
          RAISE EXCEPTION 'agent-team reporting lines form a cycle (W023)';
        END IF;
        SELECT m->>'reportsTo' INTO cursor_id
          FROM jsonb_array_elements(NEW.members) m
         WHERE m->>'agentId' = cursor_id;
      END LOOP;
    END LOOP;
  END IF;

  -- Shared objectives: at least one, unique stable keys, non-empty
  -- statements.
  IF jsonb_array_length(NEW.objectives) = 0 THEN
    RAISE EXCEPTION 'an agent team carries at least one shared objective (W023)';
  END IF;
  IF jsonb_array_length(NEW.objectives) > 25 THEN
    RAISE EXCEPTION 'an agent team carries at most 25 shared objectives (W023)';
  END IF;
  FOR objective IN SELECT jsonb_array_elements(NEW.objectives) LOOP
    IF objective->>'key' IS NULL OR objective->>'key' !~ '^[a-z0-9][a-z0-9-]{1,63}$' THEN
      RAISE EXCEPTION 'agent-team objective keys must be slug-shaped (W023)';
    END IF;
    IF (objective->>'key') = ANY(objective_keys) THEN
      RAISE EXCEPTION 'agent-team objective key ''%'' appears twice (W023)', objective->>'key';
    END IF;
    objective_keys := objective_keys || (objective->>'key');
    IF objective->>'objective' IS NULL OR char_length(objective->>'objective') = 0
       OR char_length(objective->>'objective') > 2000 THEN
      RAISE EXCEPTION 'agent-team objective ''%'' must be a non-empty statement of at most 2000 characters (W023)', objective->>'key';
    END IF;
  END LOOP;

  -- Escalation rules: trigger vocabulary, per-trigger threshold rules,
  -- route landing spots and no duplicate rules.
  IF jsonb_array_length(NEW.escalation_rules) > 16 THEN
    RAISE EXCEPTION 'an agent team carries at most 16 escalation rules (W023)';
  END IF;
  FOR rule IN SELECT jsonb_array_elements(NEW.escalation_rules) LOOP
    IF NOT (rule->>'trigger') = ANY(trigger_vocabulary) THEN
      RAISE EXCEPTION 'unknown agent-team escalation trigger ''%'' (W023)', rule->>'trigger';
    END IF;
    IF NOT (rule->>'route') = ANY(route_vocabulary) THEN
      RAISE EXCEPTION 'unknown agent-team escalation route ''%'' (W023)', rule->>'route';
    END IF;
    threshold_text := rule->>'threshold';
    IF rule->>'trigger' = 'member-failure' THEN
      IF threshold_text IS NULL OR threshold_text !~ '^[0-9]+$' OR threshold_text::bigint < 1 THEN
        RAISE EXCEPTION 'a member-failure escalation carries an integer failure threshold >= 1 (W023)';
      END IF;
    ELSIF rule->>'trigger' = 'budget-threshold' THEN
      IF threshold_text IS NULL
         OR threshold_text !~ '^[0-9]+(\.[0-9]+)?$'
         OR threshold_text::double precision <= 0
         OR threshold_text::double precision > 1 THEN
        RAISE EXCEPTION 'a budget-threshold escalation carries a fraction of the budget envelope in (0, 1] (W023)';
      END IF;
    ELSE -- authority-gap
      IF threshold_text IS NOT NULL THEN
        RAISE EXCEPTION 'an authority-gap escalation carries no threshold (W023)';
      END IF;
    END IF;
    IF rule->>'route' = 'coordinator' AND NEW.topology <> 'hierarchical' THEN
      RAISE EXCEPTION 'a coordinator escalation route needs a hierarchical team (W023)';
    END IF;
    IF rule->>'route' = 'owner' AND (NEW.owner_principal IS NULL OR NEW.owner_principal = '') THEN
      RAISE EXCEPTION 'an owner escalation route needs an owner principal (W023)';
    END IF;
    rule_sig := (rule->>'trigger') || '|' || COALESCE(threshold_text, '~') || '|' || (rule->>'route');
    IF rule_sig = ANY(rule_sigs) THEN
      RAISE EXCEPTION 'the same agent-team escalation rule appears twice (W023)';
    END IF;
    rule_sigs := rule_sigs || rule_sig;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_team_versions_content_valid
  BEFORE INSERT OR UPDATE ON agent_team_versions
  FOR EACH ROW EXECUTE FUNCTION agent_team_versions_check_content();

-- History is append-only: nothing may UPDATE, DELETE or TRUNCATE a
-- version — not even a future module bypassing the service. The
-- message deliberately names no row id so the same function serves the
-- row-level and the statement-level trigger.

CREATE OR REPLACE FUNCTION agent_team_versions_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'agent team versions are append-only (W023 team audit trail): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_team_versions_immutable
  BEFORE UPDATE OR DELETE ON agent_team_versions
  FOR EACH ROW EXECUTE FUNCTION agent_team_versions_reject_mutation();

CREATE TRIGGER agent_team_versions_immutable_truncate
  BEFORE TRUNCATE ON agent_team_versions
  FOR EACH STATEMENT EXECUTE FUNCTION agent_team_versions_reject_mutation();

-- The team identity row may advance its version pointer (UPDATE) —
-- that is how versioning moves — but identity and history are never
-- erased; dissolution is the retirement path.

CREATE OR REPLACE FUNCTION agent_teams_reject_erasure() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'agent teams cannot be erased (W023): % is forbidden on table % — dissolve the team instead',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_teams_immutable_delete
  BEFORE DELETE ON agent_teams
  FOR EACH ROW EXECUTE FUNCTION agent_teams_reject_erasure();

CREATE TRIGGER agent_teams_immutable_truncate
  BEFORE TRUNCATE ON agent_teams
  FOR EACH STATEMENT EXECUTE FUNCTION agent_teams_reject_erasure();
