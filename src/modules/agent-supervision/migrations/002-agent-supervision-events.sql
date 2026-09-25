-- W098 · agent-supervision module — the append-only supervision event
-- trail (§24 reconstructability; the agents module's availability-event
-- and the workflow module's attempt-evidence discipline).
--
-- One row per supervision- or session-lifecycle fact: status
-- transitions (review_due, suspended, resumed, budget_exhausted,
-- budget_resumed, termination_proposed/applied/refused,
-- live_work_cancelled), health observations, budget grants and
-- consumption, review completion, and the supervisor-session lifecycle
-- (started, heartbeat, ended, recovered). PostgreSQL itself rejects
-- UPDATE/DELETE/TRUNCATE — nobody, not even a future module bypassing
-- the service, rewrites supervision history.
--
-- Target discipline: an event is scoped to a supervision record
-- (supervision_id + agent_id) or to a supervisor session
-- (session_id); at least one must be present (the CHECK). Agent ids
-- and supervision ids are OPAQUE forward references to the agents
-- module / this module's records — no cross-module foreign keys (the
-- agent-teams member precedent); they are validated by the service.

CREATE TABLE agent_supervision_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  supervision_id uuid,
  agent_id uuid,
  session_id uuid,
  kind text NOT NULL CHECK (kind IN (
    'registered', 'registration_replayed', 'updated',
    'review_due', 'review_completed',
    'budget_granted', 'budget_consumed', 'budget_exhausted', 'budget_resumed',
    'suspended', 'resumed',
    'health_observed',
    'termination_proposed', 'termination_applied', 'termination_refused',
    'live_work_cancelled',
    'session_started', 'session_heartbeat', 'session_ended', 'session_recovered'
  )),
  detail text NOT NULL CHECK (detail <> ''),
  data jsonb,
  recorded_by text NOT NULL CHECK (recorded_by <> ''),
  recorded_at timestamptz NOT NULL,
  CONSTRAINT agent_supervision_events_target CHECK (
    supervision_id IS NOT NULL OR session_id IS NOT NULL
  )
);

CREATE INDEX agent_supervision_events_tenant_record_idx
  ON agent_supervision_events (tenant_id, supervision_id, recorded_at);
CREATE INDEX agent_supervision_events_tenant_agent_idx
  ON agent_supervision_events (tenant_id, agent_id, recorded_at);
CREATE INDEX agent_supervision_events_tenant_session_idx
  ON agent_supervision_events (tenant_id, session_id, recorded_at);
CREATE INDEX agent_supervision_events_tenant_kind_idx
  ON agent_supervision_events (tenant_id, kind, recorded_at);

-- Full immutability (W098): supervision evidence is history the moment
-- it is recorded.

CREATE OR REPLACE FUNCTION agent_supervision_events_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'supervision events are immutable history (W098 agent supervision): UPDATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'supervision events are immutable history (W098 agent supervision): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  RAISE EXCEPTION 'supervision events are immutable history (W098 agent supervision): TRUNCATE is forbidden on table %',
    TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_supervision_events_immutable_update
  BEFORE UPDATE ON agent_supervision_events
  FOR EACH ROW EXECUTE FUNCTION agent_supervision_events_guard();

CREATE TRIGGER agent_supervision_events_immutable_delete
  BEFORE DELETE ON agent_supervision_events
  FOR EACH ROW EXECUTE FUNCTION agent_supervision_events_guard();

CREATE TRIGGER agent_supervision_events_immutable_truncate
  BEFORE TRUNCATE ON agent_supervision_events
  FOR EACH STATEMENT EXECUTE FUNCTION agent_supervision_events_guard();
