-- W023 · agent-teams module — team-level outcomes.
--
-- ARCHITECTURE.md §15 (frozen): an AgentTeam carries "team-level
-- outcomes"; lock 22: "Agent and AgentTeam are organizational actors
-- with explicit contracts, budgets, permissions and outcomes"; the
-- work item: "Create agent-team topology, roles, shared objectives,
-- budgets, escalation and team outcomes."
--
-- One FULLY append-only table (the knowledge-acquisition W012
-- discipline: there is no UPDATE anywhere — an outcome is evidence the
-- moment it is recorded; the learning module W040 owns the general
-- expected-versus-realized measurement primitive for ITS subject
-- vocabulary, and team outcomes are deliberately free of that numeric
-- model — no silent overlap with a delivered module; W024 evaluation
-- and W054 capability outcome learning consume both through the
-- respective contracts):
--
--   agent_team_outcomes — one immutable team-level outcome record:
--                          * objective_key — WHICH shared objective
--                            the outcome measures (validated against
--                            the team's CURRENT version at record
--                            time; null = team-level overall);
--                          * headline / detail / assessment — what was
--                            achieved and the recorded verdict
--                            (met/partial/missed — a recorded
--                            judgment, not a derived value);
--                          * evidence — opaque forward references to
--                            evidence-bearing records (agent
--                            executions, observations, …): kind +
--                            id and/or label, traceable, never
--                            validated cross-module (the learning
--                            module's measurement-evidence
--                            discipline);
--                          * the provenance trio — actor party, the
--                            authenticated principal and the
--                            clock-stamped recorded_at.
--
-- There is deliberately NO operation to rewrite or erase an outcome:
-- measured history is evidence. PostgreSQL itself rejects
-- UPDATE/DELETE/TRUNCATE (triggers below), even for a caller bypassing
-- the service.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the
-- composite FK (team_id, tenant_id) → agent_teams (id, tenant_id)
-- makes a cross-tenant outcome unrepresentable in SQL (the
-- mission_versions pattern).

CREATE TABLE agent_team_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  team_id uuid NOT NULL,
  objective_key text
    CHECK (objective_key IS NULL OR objective_key ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  headline text NOT NULL CHECK (char_length(headline) BETWEEN 1 AND 200),
  detail text
    CHECK (detail IS NULL OR char_length(detail) BETWEEN 1 AND 4000),
  assessment text NOT NULL CHECK (assessment IN ('met', 'partial', 'missed')),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence) = 'array'),
  actor_kind text NOT NULL CHECK (actor_kind IN (
    'person', 'team', 'agent', 'system', 'external'
  )),
  actor_id text,
  actor_label text
    CHECK (actor_label IS NULL OR char_length(actor_label) BETWEEN 1 AND 200),
  recorded_by_principal text NOT NULL CHECK (recorded_by_principal <> ''),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_team_outcomes_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT agent_team_outcomes_team_fk
    FOREIGN KEY (team_id, tenant_id) REFERENCES agent_teams (id, tenant_id),
  CONSTRAINT agent_team_outcomes_actor_traceable CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL)
);

-- Team timeline (newest first) and the objective filter.
CREATE INDEX agent_team_outcomes_team_idx
  ON agent_team_outcomes (tenant_id, team_id, recorded_at DESC);
CREATE INDEX agent_team_outcomes_objective_idx
  ON agent_team_outcomes (tenant_id, team_id, objective_key);

-- Evidence references must be traceable: every entry carries an id or
-- a label, and a bounded slug-shaped kind.

CREATE OR REPLACE FUNCTION agent_team_outcomes_check_evidence() RETURNS trigger AS $$
DECLARE
  ref jsonb;
BEGIN
  IF jsonb_array_length(NEW.evidence) > 32 THEN
    RAISE EXCEPTION 'agent-team outcomes carry at most 32 evidence references (W023)';
  END IF;
  FOR ref IN SELECT jsonb_array_elements(NEW.evidence) LOOP
    IF ref->>'kind' IS NULL OR ref->>'kind' !~ '^[a-z0-9][a-z0-9-]{0,63}$' THEN
      RAISE EXCEPTION 'agent-team outcome evidence kind must be slug-shaped (W023)';
    END IF;
    IF (ref->>'id') IS NULL AND (ref->>'label') IS NULL THEN
      RAISE EXCEPTION 'agent-team outcome evidence must carry an id or a label — evidence must be traceable (W023)';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_team_outcomes_evidence_valid
  BEFORE INSERT OR UPDATE ON agent_team_outcomes
  FOR EACH ROW EXECUTE FUNCTION agent_team_outcomes_check_evidence();

-- Outcomes are append-only evidence: UPDATE/DELETE/TRUNCATE are
-- rejected outright.

CREATE OR REPLACE FUNCTION agent_team_outcomes_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'agent team outcomes are append-only (W023 team evidence): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_team_outcomes_immutable
  BEFORE UPDATE OR DELETE ON agent_team_outcomes
  FOR EACH ROW EXECUTE FUNCTION agent_team_outcomes_reject_mutation();

CREATE TRIGGER agent_team_outcomes_immutable_truncate
  BEFORE TRUNCATE ON agent_team_outcomes
  FOR EACH STATEMENT EXECUTE FUNCTION agent_team_outcomes_reject_mutation();
