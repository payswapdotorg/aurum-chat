-- W086 · realtime module — the live transcript turns.
--
-- One row per FINALIZED stretch of speech, with speaker attribution to
-- the participant registry: the LIVE TRANSCRIPT of the session (W086
-- acceptance). Human turns are produced by canonical `transcript.final`
-- events (adapters normalize provider interim ASR away — only finalized
-- speech is canonical; interim state is transport-side ephemera). Aurum
-- turns are produced when a spoken response is accepted by the transport
-- (full intended text; the interruption lifecycle lives on the response
-- row and in the event ledger).
--
-- `turn_no` is the per-session commit order (1-based, monotonic) —
-- assigned under the per-session application lock, so MAX+1 is race-free.
--
-- Append-only capture evidence: no UPDATE, no DELETE, no TRUNCATE ever
-- (storage-enforced). The durable transcript artifact (the finalization
-- workflow's JSON document) is a VIEW over these rows at finalize time —
-- the rows are the truth, the artifact is the materialization.

CREATE TABLE realtime_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  session_id uuid NOT NULL,
  turn_no bigint NOT NULL CHECK (turn_no >= 1),
  kind text NOT NULL CHECK (kind IN ('human_speech', 'aurum_response')),
  speaker_participant_id uuid,
  speaker_name text
    CHECK (speaker_name IS NULL OR char_length(speaker_name) BETWEEN 1 AND 200),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 8000),
  confidence double precision CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  response_id uuid,
  event_id uuid,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT realtime_turns_session_no_unique UNIQUE (tenant_id, session_id, turn_no),
  CONSTRAINT realtime_turns_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT realtime_turns_session_fk
    FOREIGN KEY (session_id, tenant_id)
    REFERENCES realtime_sessions (id, tenant_id),
  CONSTRAINT realtime_turns_speaker_fk
    FOREIGN KEY (speaker_participant_id, tenant_id)
    REFERENCES realtime_participants (id, tenant_id),
  CONSTRAINT realtime_turns_kind_shape CHECK (
    (kind = 'aurum_response') = (response_id IS NOT NULL)
  ),
  CONSTRAINT realtime_turns_event_shape CHECK (
    (kind = 'human_speech') = (event_id IS NOT NULL)
  )
);

CREATE INDEX realtime_turns_session_idx
  ON realtime_turns (tenant_id, session_id, turn_no ASC);

-- Storage-level guarantee: strictly append-only — the transcript is
-- capture evidence (lock 5 spirit; the meetings transcripts discipline).

CREATE OR REPLACE FUNCTION realtime_turns_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is the append-only live transcript (W086 realtime): % is forbidden on table %',
    TG_TABLE_NAME, TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER realtime_turns_immutable
  BEFORE UPDATE OR DELETE ON realtime_turns
  FOR EACH ROW EXECUTE FUNCTION realtime_turns_reject_mutation();

CREATE TRIGGER realtime_turns_immutable_truncate
  BEFORE TRUNCATE ON realtime_turns
  FOR EACH STATEMENT EXECUTE FUNCTION realtime_turns_reject_mutation();
