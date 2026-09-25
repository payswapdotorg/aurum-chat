-- W098 · agent-supervision module — the append-only budget spend
-- ledger (exactly-once per W021 dispatch attempt).
--
-- One row per LEDGERED ATTEMPT: the agents module's dispatch attempts
-- (W021 append-only evidence with deterministic integer-minor-unit
-- cost) are consumed by the supervision pump and ledgered here under
-- the UNIQUE (tenant_id, attempt_id) key. A crashed, restarted or
-- duplicated supervisor can neither double-count nor lose spend —
-- W098's "budget ... survive resume" is this constraint plus the
-- same-transaction spend increment on agent_supervision_records.
--
-- execution_id / attempt_id are OPAQUE forward references to the
-- agents module's records (no cross-module foreign keys; the service
-- reads them through the agents contract).
--
-- Full immutability (the events discipline): a ledgered cost is
-- history; PostgreSQL rejects UPDATE/DELETE/TRUNCATE.

CREATE TABLE agent_supervision_budget_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  supervision_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  cost_minor bigint NOT NULL CHECK (cost_minor >= 0),
  cost_currency text NOT NULL DEFAULT 'USD' CHECK (cost_currency = 'USD'),
  recorded_by text NOT NULL CHECK (recorded_by <> ''),
  recorded_at timestamptz NOT NULL,
  CONSTRAINT agent_supervision_budget_entries_attempt_unique UNIQUE (tenant_id, attempt_id)
);

CREATE INDEX agent_supervision_budget_entries_tenant_execution_idx
  ON agent_supervision_budget_entries (tenant_id, execution_id);
CREATE INDEX agent_supervision_budget_entries_tenant_agent_idx
  ON agent_supervision_budget_entries (tenant_id, agent_id, recorded_at);

CREATE OR REPLACE FUNCTION agent_supervision_budget_entries_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'budget ledger entries are immutable history (W098 agent supervision): UPDATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'budget ledger entries are immutable history (W098 agent supervision): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  RAISE EXCEPTION 'budget ledger entries are immutable history (W098 agent supervision): TRUNCATE is forbidden on table %',
    TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_supervision_budget_entries_immutable_update
  BEFORE UPDATE ON agent_supervision_budget_entries
  FOR EACH ROW EXECUTE FUNCTION agent_supervision_budget_entries_guard();

CREATE TRIGGER agent_supervision_budget_entries_immutable_delete
  BEFORE DELETE ON agent_supervision_budget_entries
  FOR EACH ROW EXECUTE FUNCTION agent_supervision_budget_entries_guard();

CREATE TRIGGER agent_supervision_budget_entries_immutable_truncate
  BEFORE TRUNCATE ON agent_supervision_budget_entries
  FOR EACH STATEMENT EXECUTE FUNCTION agent_supervision_budget_entries_guard();
