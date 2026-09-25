-- W098 · agent-supervision module — supervisor sessions: the durable
-- WORKER-LIFETIME ledger.
--
-- A supervisor (a worker process) begins a session with a lease,
-- heartbeats it, and ends it. `beginSupervisorSession` RECOVERS this
-- tenant's expired live sessions (UPDATE ... SET end_reason =
-- 'lease_expired_recovered', recovered_by_session_id = the fresh
-- session) — the durable evidence of W098's core property: a dead
-- worker's session is taken over, while every supervision fact (which
-- never lived in the session) continues unaffected.
--
-- Sessions are LIVE STATE, not append-only evidence: the lease
-- columns (last_heartbeat_at, lease_expires_at) and the end columns
-- (ended_at, end_reason, recovered_by_session_id) are exactly what
-- may move — the guard trigger freezes identity and cadence (id,
-- tenant_id, started_by, lease_seconds, started_at) and rejects
-- DELETE/TRUNCATE outright.
--
-- The lease discipline (the W080 engine's): a heartbeat extends the
-- lease from the CURRENT time; an expired session is never
-- resurrected by a late heartbeat — it is recovered by a fresh
-- session, once, durably.

CREATE TABLE agent_supervisor_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  started_by text NOT NULL CHECK (started_by <> ''),
  lease_seconds integer NOT NULL CHECK (lease_seconds BETWEEN 30 AND 86400),
  started_at timestamptz NOT NULL,
  last_heartbeat_at timestamptz,
  lease_expires_at timestamptz NOT NULL,
  ended_at timestamptz,
  end_reason text CHECK (end_reason IS NULL OR end_reason IN ('ended', 'lease_expired_recovered')),
  recovered_by_session_id uuid,
  CONSTRAINT agent_supervisor_sessions_end_shape CHECK (
    (ended_at IS NULL AND end_reason IS NULL)
    OR (ended_at IS NOT NULL AND end_reason IS NOT NULL)
  ),
  CONSTRAINT agent_supervisor_sessions_recovery_linked CHECK (
    end_reason <> 'lease_expired_recovered' OR recovered_by_session_id IS NOT NULL
  )
);

CREATE INDEX agent_supervisor_sessions_tenant_started_idx
  ON agent_supervisor_sessions (tenant_id, started_at);
CREATE INDEX agent_supervisor_sessions_tenant_live_idx
  ON agent_supervisor_sessions (tenant_id, lease_expires_at)
  WHERE ended_at IS NULL;

-- Storage-level discipline (W098): a session's identity and lease
-- cadence are frozen at start; only the live lease/end state may move;
-- sessions are never deleted.

CREATE OR REPLACE FUNCTION agent_supervisor_sessions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'supervisor sessions are durable worker-lifetime history (W098 agent supervision): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'supervisor sessions are durable worker-lifetime history (W098 agent supervision): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.started_by <> OLD.started_by
     OR NEW.lease_seconds <> OLD.lease_seconds
     OR NEW.started_at <> OLD.started_at THEN
    RAISE EXCEPTION 'supervisor session identity and lease cadence are immutable (W098 agent supervision): only the live lease and end state may change on table %',
      TG_TABLE_NAME;
  END IF;
  IF OLD.ended_at IS NOT NULL AND NEW.ended_at IS DISTINCT FROM OLD.ended_at THEN
    RAISE EXCEPTION 'an ended supervisor session is history (W098 agent supervision): its end state may not change on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_supervisor_sessions_live_only_updates
  BEFORE UPDATE OR DELETE ON agent_supervisor_sessions
  FOR EACH ROW EXECUTE FUNCTION agent_supervisor_sessions_guard();

CREATE TRIGGER agent_supervisor_sessions_immutable_truncate
  BEFORE TRUNCATE ON agent_supervisor_sessions
  FOR EACH STATEMENT EXECUTE FUNCTION agent_supervisor_sessions_guard();
