-- W052 · knowledge-acquisition module — Knowledge Source Ranking
-- (ADR-0018, accepted at lock 2.1).
--
-- "Aurum ranks possible knowledge sources using provider-independent
--  signals … The ranking rationale is persisted and auditable. … Ranking
--  is deterministic at the policy/workflow level: the same inputs and the
--  same learned state produce the same ordering."
--
-- W012's acquisition_plans already persist the planner's SELECTION
-- rationale (the ranked signal snapshot it was handed). This table
-- persists the layer beneath: the DERIVATION rationale of W052 — how the
-- ADR-0018 signal values were computed from SOURCE EVIDENCE for one
-- mission's candidate menu, and which plan those derived signals
-- produced. One row per rankMissionSources pass:
--
--   subject_topics  — the mission's subject topics (deterministic
--                     tokenization of title + knowledge objective) that
--                     the relevance/authority derivations matched
--                     transactive memory against;
--   derived         — the full per-candidate derivation snapshot (jsonb):
--                     the separately represented signal vector (six
--                     learned signals + the explicit cost/access policy),
--                     the deterministic planner score / cost share /
--                     dominant signal, and the EVIDENCE BASIS of the
--                     learned values (outcome counts, evidence confidence
--                     mean, latest evidence clock, transactive entries,
--                     matched topics, matching relations) — so a routing
--                     change caused by changed source evidence is
--                     reconstructable by diffing two snapshots
--                     (ADR-0018's required verification);
--   decision/plan_id — the decision of the plan committed from the
--                     derived signals and its id (tenant-scoped composite
--                     FK to acquisition_plans; null exactly on
--                     'no_candidate').
--
-- The ranking input itself carries NO learned signals (only the explicit
-- per-candidate cost + access policy), and no field of this row is
-- caller-suppliable: identity, tenancy, topics, derivation, plan link
-- and audit quartet are all minted by the service — the derivation
-- rationale is evidence, and evidence is not forgeable.
--
-- (W051 posture: goal-gap discovery launches the missions ranked here
-- through the shared missions contract; the chain goal gap → unknown →
-- mission → ranking → plan is reconstructable across attention's and
-- this module's records — attention's discovery candidates carry the
-- mission id — with no edge between the two modules, which the
-- migration-order graph forbids: attention → cognition → knowledge-
-- acquisition.)
--
-- Append-only, like the planner's own history: UPDATE/DELETE/TRUNCATE are
-- rejected by trigger — a ranking is never rewritten, a re-ranking is a
-- new row.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the composite
-- FK (plan_id, tenant_id) → acquisition_plans (id, tenant_id) makes a
-- cross-tenant plan link unrepresentable in SQL even for a caller that
-- bypasses the service (the migration 001 pattern).

CREATE TABLE source_rankings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  mission_id uuid NOT NULL,
  mission_version integer NOT NULL CHECK (mission_version >= 1),
  subject_topics jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(subject_topics) = 'array'),
  derived jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(derived) = 'array'),
  decision text NOT NULL CHECK (decision IN ('selected', 'no_candidate')),
  plan_id uuid,
  actor_kind text NOT NULL CHECK (actor_kind IN ('person', 'team', 'agent', 'system', 'external')),
  actor_id text,
  actor_label text,
  ranked_by_principal text NOT NULL,
  rationale text
    CHECK (rationale IS NULL OR char_length(rationale) BETWEEN 1 AND 2000),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  -- The decision shape is surgical: a 'selected' ranking links the plan
  -- its derived signals produced; a 'no_candidate' ranking links none.
  CONSTRAINT source_rankings_decision_shape CHECK (
    (decision = 'selected' AND plan_id IS NOT NULL)
    OR (decision = 'no_candidate' AND plan_id IS NULL)
  ),
  -- The acting party is traceable (the planner's actor rule).
  CONSTRAINT source_rankings_actor_traceable CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL),
  -- The composite target of the tenant-scoped plan FK.
  CONSTRAINT source_rankings_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT source_rankings_plan_fk
    FOREIGN KEY (plan_id, tenant_id) REFERENCES acquisition_plans (id, tenant_id)
);

-- The ranking feed per mission and the management filters.
CREATE INDEX source_rankings_mission_idx ON source_rankings (tenant_id, mission_id, recorded_at);
CREATE INDEX source_rankings_filters_idx ON source_rankings (tenant_id, decision);

-- Storage-level audit guarantee: ranking derivations are append-only.
-- Nothing may UPDATE, DELETE or TRUNCATE a source ranking — not even a
-- future module bypassing the service (the migration 001 pattern; the
-- message deliberately names no row id so one function serves the
-- row-level and the statement-level trigger).

CREATE OR REPLACE FUNCTION source_rankings_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'source rankings are append-only (W052 ranking rationale): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER source_rankings_immutable
  BEFORE UPDATE OR DELETE ON source_rankings
  FOR EACH ROW EXECUTE FUNCTION source_rankings_reject_mutation();

CREATE TRIGGER source_rankings_immutable_truncate
  BEFORE TRUNCATE ON source_rankings
  FOR EACH STATEMENT EXECUTE FUNCTION source_rankings_reject_mutation();
