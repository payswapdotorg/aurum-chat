-- W086 · realtime module — the realtime session registry.
--
-- A REALTIME SESSION is one live room occurrence plus the durable
-- canonical state W086 owns: the current lifecycle status, the explicit
-- recording state (W086 acceptance: "consent/recording state"), the
-- terminal classification, and the durable finalization bookkeeping (the
-- W080 workflow link that materializes the durable meeting artifact).
--
-- The four product modes share this one shape (kinds): aurum_voice,
-- meeting_participation, meeting_companion, telephony.
--
-- `meeting_session_id` is an OPAQUE reference to the meetings module's
-- canonical session (W085) — validated readable through that module's
-- contract at start, NEVER a foreign key (cross-module, house pattern).
--
-- DURABLE-FIRST LIFECYCLE: a start records the `requested` intent BEFORE
-- the transport materializes the room, so concurrent starts are explicit
-- and a failed materialization is a queryable `failed` row (never a
-- silent gap — the W085 "failed/expired access is explicit" discipline
-- applied to realtime starts). `provider_room_id` fills once (NULL →
-- value) when the room goes live.
--
-- FINALIZATION (the W080 dependency): every terminal transition that
-- reached `live` sets `finalize_pending`; the durable finalization
-- workflow run (`finalize_run_id`) materializes the transcript artifact
-- through the object-storage port and records the session-close
-- observation (W004) through the observations contract, then links it
-- one-way via `evidence_observation_id`. `pumpRealtimeFinalization`
-- recovers the crash window between the terminal transition and the run
-- start (idempotent — first write wins).
--
-- Storage-level guarantee: the session's identity columns (connection,
-- kind, meeting link, created_by) are frozen from creation, the room and
-- evidence links are one-way fills, and DELETE/TRUNCATE are always
-- forbidden — the event ledger, turns and artifacts hold the history.

CREATE TABLE realtime_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('livekit', 'openai-realtime')),
  kind text NOT NULL CHECK (kind IN (
    'aurum_voice', 'meeting_participation', 'meeting_companion', 'telephony'
  )),
  status text NOT NULL CHECK (status IN ('requested', 'live', 'ended', 'failed')),
  title text CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 200),
  meeting_session_id uuid,
  provider_room_id text
    CHECK (provider_room_id IS NULL OR char_length(provider_room_id) BETWEEN 1 AND 255),
  recording_state text NOT NULL DEFAULT 'off'
    CHECK (recording_state IN ('off', 'recording', 'recorded')),
  ended_reason text CHECK (ended_reason IS NULL OR ended_reason IN (
    'caller_stopped', 'provider_ended', 'last_participant_left'
  )),
  error_code text CHECK (error_code IS NULL OR error_code IN (
    'provider_unavailable', 'transport_failed', 'dial_failed',
    'room_unavailable', 'agent_disconnected', 'provider_error'
  )),
  error_detail text
    CHECK (error_detail IS NULL OR char_length(error_detail) BETWEEN 1 AND 2000),
  finalize_pending boolean NOT NULL DEFAULT false,
  finalize_run_id uuid,
  evidence_observation_id uuid,
  created_by text NOT NULL CHECK (created_by <> ''),
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT realtime_sessions_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT realtime_sessions_connection_fk
    FOREIGN KEY (connection_id, tenant_id)
    REFERENCES realtime_connections (id, tenant_id),
  CONSTRAINT realtime_sessions_room_unique
    UNIQUE (tenant_id, connection_id, provider_room_id),
  CONSTRAINT realtime_sessions_ended_shape CHECK (
    (status IN ('ended', 'failed')) = (ended_at IS NOT NULL)
  ),
  CONSTRAINT realtime_sessions_ended_reason_shape CHECK (
    status <> 'ended' OR ended_reason IS NOT NULL
  ),
  CONSTRAINT realtime_sessions_failed_shape CHECK (
    status <> 'failed' OR error_code IS NOT NULL
  ),
  CONSTRAINT realtime_sessions_live_shape CHECK (
    status <> 'live' OR (provider_room_id IS NOT NULL AND started_at IS NOT NULL)
  )
);

CREATE INDEX realtime_sessions_tenant_status_idx
  ON realtime_sessions (tenant_id, status, created_at DESC);
CREATE INDEX realtime_sessions_tenant_connection_idx
  ON realtime_sessions (tenant_id, connection_id, created_at DESC);
CREATE INDEX realtime_sessions_finalize_pending_idx
  ON realtime_sessions (tenant_id, ended_at ASC)
  WHERE finalize_pending AND finalize_run_id IS NULL;

-- Storage-level guarantee: identity is frozen from creation; the room
-- and evidence links are one-way fills; lifecycle/terminal/finalization
-- state is the only mutable surface. DELETE and TRUNCATE are forbidden.

CREATE OR REPLACE FUNCTION realtime_sessions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'realtime sessions are the durable session registry (W086 realtime): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'realtime sessions are the durable session registry (W086 realtime): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.connection_id <> OLD.connection_id
     OR NEW.provider <> OLD.provider
     OR NEW.kind <> OLD.kind
     OR NEW.created_by <> OLD.created_by
     OR NEW.meeting_session_id IS DISTINCT FROM OLD.meeting_session_id
     OR (OLD.provider_room_id IS NOT NULL AND NEW.provider_room_id IS DISTINCT FROM OLD.provider_room_id)
     OR (OLD.evidence_observation_id IS NOT NULL AND NEW.evidence_observation_id IS DISTINCT FROM OLD.evidence_observation_id) THEN
    RAISE EXCEPTION 'realtime sessions are the durable session registry (W086 realtime): identity is frozen and the room/evidence links are one-way fills on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER realtime_sessions_identity_frozen_updates
  BEFORE UPDATE OR DELETE ON realtime_sessions
  FOR EACH ROW EXECUTE FUNCTION realtime_sessions_guard();

CREATE TRIGGER realtime_sessions_immutable_truncate
  BEFORE TRUNCATE ON realtime_sessions
  FOR EACH STATEMENT EXECUTE FUNCTION realtime_sessions_guard();
