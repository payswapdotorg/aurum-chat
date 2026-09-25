-- W098 · agent-supervision module — completed supervision reviews
-- (append-only evidence).
--
-- One row per review completed through `completeSupervisionReview`:
-- the outcome (continue / adjust / suspend / terminate_proposal), the
-- required rationale, the optional cited W024 evaluation, the applied
-- adjustments (outcome 'adjust'), and — for a termination proposal —
-- the REQUIRED W024 lifecycle decision link. Supervision itself never
-- terminates an agent (lock 21 mirrored at the actor level): the
-- decision trail of the agent-evaluation module is the authority a
-- proposal defers to.
--
-- evaluation_id / decision_id are OPAQUE forward references to the
-- agent-evaluation module's records (no cross-module foreign keys; the
-- service validates readability through that module's contract).
--
-- Full immutability (the events discipline): a recorded review is
-- history; PostgreSQL rejects UPDATE/DELETE/TRUNCATE.

CREATE TABLE agent_supervision_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  supervision_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN (
    'continue', 'adjust', 'suspend', 'terminate_proposal'
  )),
  rationale text NOT NULL CHECK (rationale <> ''),
  evaluation_id uuid,
  decision_id uuid,
  adjustments jsonb,
  reviewed_by text NOT NULL CHECK (reviewed_by <> ''),
  reviewed_at timestamptz NOT NULL,
  CONSTRAINT agent_supervision_reviews_terminate_linked CHECK (
    outcome <> 'terminate_proposal' OR decision_id IS NOT NULL
  ),
  CONSTRAINT agent_supervision_reviews_adjust_shape CHECK (
    outcome <> 'adjust' OR (adjustments IS NOT NULL AND jsonb_typeof(adjustments) = 'object')
  )
);

CREATE INDEX agent_supervision_reviews_tenant_agent_idx
  ON agent_supervision_reviews (tenant_id, agent_id, reviewed_at);
CREATE INDEX agent_supervision_reviews_tenant_record_idx
  ON agent_supervision_reviews (tenant_id, supervision_id, reviewed_at);

CREATE OR REPLACE FUNCTION agent_supervision_reviews_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'supervision reviews are immutable history (W098 agent supervision): UPDATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'supervision reviews are immutable history (W098 agent supervision): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  RAISE EXCEPTION 'supervision reviews are immutable history (W098 agent supervision): TRUNCATE is forbidden on table %',
    TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_supervision_reviews_immutable_update
  BEFORE UPDATE ON agent_supervision_reviews
  FOR EACH ROW EXECUTE FUNCTION agent_supervision_reviews_guard();

CREATE TRIGGER agent_supervision_reviews_immutable_delete
  BEFORE DELETE ON agent_supervision_reviews
  FOR EACH ROW EXECUTE FUNCTION agent_supervision_reviews_guard();

CREATE TRIGGER agent_supervision_reviews_immutable_truncate
  BEFORE TRUNCATE ON agent_supervision_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION agent_supervision_reviews_guard();
