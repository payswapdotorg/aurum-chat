-- W085 · meetings module — the canonical meeting and session registry.
--
-- A MEETING is the provider-identified scheduled/recurring entity
-- (title, agenda, scheduled window, host); a SESSION is ONE occurrence of
-- it — the unit transcripts and artifacts attach to. Together they are the
-- canonical contracts W085 names ("canonical meeting/session/… contracts")
-- and the surface W086 (Realtime Voice / Meeting Companion) builds its
-- live sessions on.
--
-- These are CAPTURE REGISTRY rows holding the LATEST provider-delivered
-- state, not evidence: every delivered state of a meeting or session is
-- preserved as an immutable observation (kinds `meeting.metadata` /
-- `meeting.session`) through the observations contract (W004 — "meeting
-- metadata, participant identity, transcript/artifact and provenance are
-- captured into the canonical evidence model"). The registry answers
-- "what is the current capture state"; the observations answer "what did
-- the provider deliver and when".
--
-- Identity: a meeting is one (tenant, provider, provider_meeting_id) —
-- provider-minted and stable, so a session that arrives before any
-- metadata event creates a skeleton row (null title) that fills when
-- metadata arrives, without forking. A session is one
-- (tenant, meeting, provider_session_id).
--
-- Sessions update while the occurrence is live (scheduled → started →
-- ended, attendance lists) and after provider corrections; the identity
-- columns are frozen from creation (guard trigger below) and DELETE is
-- always forbidden — the transcript/artifact tables and the observations
-- hold the history. `participants` carries the LATEST attendance as a
-- sorted jsonb array of registry refs + captured display facets
-- {participantId, providerParticipantId, displayName, email, joinedAt,
-- leftAt}; per-delivery attendance is in the observations.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the composite
-- UNIQUE (id, tenant_id) is the tenant-consistent FK target for the
-- transcript/artifact/access tables.

CREATE TABLE meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN (
    'zoom', 'microsoft-teams', 'google-meet', 'recall'
  )),
  provider_meeting_id text NOT NULL
    CHECK (char_length(provider_meeting_id) BETWEEN 1 AND 255),
  title text CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 300),
  agenda text CHECK (agenda IS NULL OR char_length(agenda) BETWEEN 1 AND 4000),
  scheduled_start_at timestamptz,
  scheduled_end_at timestamptz,
  host_participant_id uuid,
  underlying_platform text CHECK (
    underlying_platform IS NULL OR underlying_platform ~ '^[a-z0-9][a-z0-9-]{0,62}$'
  ),
  created_by text NOT NULL CHECK (created_by <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meetings_tenant_provider_meeting_unique
    UNIQUE (tenant_id, provider, provider_meeting_id),
  CONSTRAINT meetings_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT meetings_connection_fk
    FOREIGN KEY (connection_id, tenant_id)
    REFERENCES meeting_connections (id, tenant_id),
  CONSTRAINT meetings_host_participant_fk
    FOREIGN KEY (host_participant_id, tenant_id)
    REFERENCES meeting_participants (id, tenant_id),
  CONSTRAINT meetings_scheduled_window CHECK (
    scheduled_start_at IS NULL OR scheduled_end_at IS NULL OR scheduled_start_at <= scheduled_end_at
  )
);

CREATE INDEX meetings_tenant_provider_idx ON meetings (tenant_id, provider);
CREATE INDEX meetings_tenant_connection_idx ON meetings (tenant_id, connection_id);
CREATE INDEX meetings_tenant_scheduled_idx
  ON meetings (tenant_id, scheduled_start_at DESC);

CREATE TABLE meeting_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  meeting_id uuid NOT NULL,
  provider_session_id text NOT NULL
    CHECK (char_length(provider_session_id) BETWEEN 1 AND 255),
  status text NOT NULL CHECK (status IN ('scheduled', 'started', 'ended')),
  title text CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 300),
  started_at timestamptz,
  ended_at timestamptz,
  participants jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(participants) = 'array'
           AND jsonb_array_length(participants) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meeting_sessions_meeting_session_unique
    UNIQUE (tenant_id, meeting_id, provider_session_id),
  CONSTRAINT meeting_sessions_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT meeting_sessions_meeting_fk
    FOREIGN KEY (meeting_id, tenant_id) REFERENCES meetings (id, tenant_id),
  CONSTRAINT meeting_sessions_actual_window CHECK (
    started_at IS NULL OR ended_at IS NULL OR started_at <= ended_at
  ),
  -- A 'started' session always knows when it started. A session whose end
  -- time is unknown MAY be 'ended': artifact/transcript deliveries prove
  -- the occurrence ran and completed without carrying a session event, so
  -- the skeleton they create is 'ended' with NULL actual times until a
  -- session event fills them (the validation layer enforces the stronger
  -- provider-event coherence: a session.updated record with status 'ended'
  -- must carry its endedAt).
  CONSTRAINT meeting_sessions_status_shape CHECK (
    status <> 'started' OR started_at IS NOT NULL
  )
);

CREATE INDEX meeting_sessions_tenant_meeting_idx
  ON meeting_sessions (tenant_id, meeting_id, created_at DESC);
CREATE INDEX meeting_sessions_tenant_status_idx ON meeting_sessions (tenant_id, status);
CREATE INDEX meeting_sessions_tenant_started_idx
  ON meeting_sessions (tenant_id, started_at DESC);

-- Storage-level guarantees: a session's identity (tenant, meeting,
-- provider session id) is frozen from creation; only the capture state
-- (status, actual times, title, attendance, updated_at) may move. DELETE
-- and TRUNCATE are forbidden — the occurrence registry is append-only
-- history; a cancellation is a status, not an erasure.

CREATE OR REPLACE FUNCTION meeting_sessions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'meeting sessions are the append-only occurrence registry (W085 meetings): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'meeting sessions are the append-only occurrence registry (W085 meetings): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.meeting_id <> OLD.meeting_id
     OR NEW.provider_session_id <> OLD.provider_session_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'meeting sessions are the append-only occurrence registry (W085 meetings): only the capture state (status, title, started_at, ended_at, participants, updated_at) may change on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER meeting_sessions_state_only_updates
  BEFORE UPDATE OR DELETE ON meeting_sessions
  FOR EACH ROW EXECUTE FUNCTION meeting_sessions_guard();

CREATE TRIGGER meeting_sessions_immutable_truncate
  BEFORE TRUNCATE ON meeting_sessions
  FOR EACH STATEMENT EXECUTE FUNCTION meeting_sessions_guard();
