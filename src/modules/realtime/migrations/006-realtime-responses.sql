-- W086 · realtime module — the spoken-response lifecycle.
--
-- One row per spoken Aurum response: the transport's acceptance
-- (`speaking`), then `completed` (playback finished), `interrupted`
-- (barge-in — W086 acceptance "interruption handling", with the
-- interrupting participant attributed) or `failed` (the transport
-- refused; no transcript turn exists for a refused response). The
-- spoken TEXT lives on the linked aurum turn (`turn_id`, null while the
-- transport has not accepted); this table carries WHAT HAPPENED to it.
--
-- Unlike turns/events (append-only evidence), this is a LIFECYCLE
-- record: `status`, `completed_at`/`interrupted_at`,
-- `interrupted_by_participant_id`, `error_detail` and `turn_id` are the
-- mutable state surface; identity (session, text, request turn) is
-- frozen from creation. `request_turn_id` attributes the response to the
-- human turn that prompted it (speaker-attribution continuity).

CREATE TABLE realtime_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  session_id uuid NOT NULL,
  turn_id uuid,
  request_turn_id uuid,
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 8000),
  status text NOT NULL CHECK (status IN ('speaking', 'completed', 'interrupted', 'failed')),
  interrupted_by_participant_id uuid,
  error_detail text
    CHECK (error_detail IS NULL OR char_length(error_detail) BETWEEN 1 AND 2000),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  interrupted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT realtime_responses_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT realtime_responses_session_fk
    FOREIGN KEY (session_id, tenant_id)
    REFERENCES realtime_sessions (id, tenant_id),
  CONSTRAINT realtime_responses_turn_fk
    FOREIGN KEY (turn_id, tenant_id)
    REFERENCES realtime_turns (id, tenant_id),
  CONSTRAINT realtime_responses_request_turn_fk
    FOREIGN KEY (request_turn_id, tenant_id)
    REFERENCES realtime_turns (id, tenant_id),
  CONSTRAINT realtime_responses_interrupter_fk
    FOREIGN KEY (interrupted_by_participant_id, tenant_id)
    REFERENCES realtime_participants (id, tenant_id),
  CONSTRAINT realtime_responses_status_shape CHECK (
    (status = 'completed') = (completed_at IS NOT NULL)
  ),
  CONSTRAINT realtime_responses_interrupted_shape CHECK (
    (status = 'interrupted') = (interrupted_at IS NOT NULL)
  )
);

CREATE INDEX realtime_responses_session_idx
  ON realtime_responses (tenant_id, session_id, created_at ASC);
CREATE INDEX realtime_responses_session_status_idx
  ON realtime_responses (tenant_id, session_id, status);

-- Storage-level guarantee: identity is frozen; the lifecycle columns are
-- the mutable surface; DELETE and TRUNCATE are forbidden (the lifecycle
-- history of what Aurum said and what happened to it is evidence).

CREATE OR REPLACE FUNCTION realtime_responses_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'realtime responses are the spoken-response lifecycle evidence (W086 realtime): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'realtime responses are the spoken-response lifecycle evidence (W086 realtime): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.session_id <> OLD.session_id
     OR NEW.text <> OLD.text
     OR NEW.request_turn_id IS DISTINCT FROM OLD.request_turn_id
     OR NEW.started_at <> OLD.started_at
     OR (OLD.turn_id IS NOT NULL AND NEW.turn_id IS DISTINCT FROM OLD.turn_id)
     OR (OLD.status = 'completed' AND NEW.status <> 'completed')
     OR (OLD.status = 'interrupted' AND NEW.status <> 'interrupted') THEN
    RAISE EXCEPTION 'realtime responses are the spoken-response lifecycle evidence (W086 realtime): identity is frozen and lifecycle transitions are one-way on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER realtime_responses_identity_frozen_updates
  BEFORE UPDATE OR DELETE ON realtime_responses
  FOR EACH ROW EXECUTE FUNCTION realtime_responses_guard();

CREATE TRIGGER realtime_responses_immutable_truncate
  BEFORE TRUNCATE ON realtime_responses
  FOR EACH STATEMENT EXECUTE FUNCTION realtime_responses_guard();
