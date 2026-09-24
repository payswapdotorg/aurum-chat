-- W085 · meetings module — canonical transcripts (append-only capture
-- evidence).
--
-- One row per (tenant, session, provider transcript id): the canonical
-- transcript of one session occurrence, as delivered by the provider (or
-- the meeting bot). Speaker attribution resolves through the participant
-- registry (`participantId` per segment; `speakerName` preserves the
-- provider-reported label when the provider could not attribute), so
-- "participant identity … captured into the canonical evidence model"
-- holds at the segment level, not just the session level.
--
-- Append-only capture evidence: a provider-side revision is a NEW
-- provider transcript id and therefore a NEW row — both are retained (the
-- lock 12 spirit: corrected or contradictory captures are never silently
-- merged). UPDATE, DELETE and TRUNCATE are rejected by trigger — the
-- transcript of what was said cannot be silently rewritten (it feeds
-- audit reconstruction, §24). The immutable observation (kind
-- `meeting.transcript`) preserves exactly what was delivered; the row
-- links to it (`evidence_observation_id` is minted at capture).
--
-- Per-segment shape is enforced by the application validation layer
-- (ordered segments, [0,1] confidence, text bounds); the storage layer
-- guarantees array-ness and count only — the sources/notifications split
-- for deeply-shaped jsonb.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; `observation_id`
-- references the observations module's evidence opaquely (no cross-module
-- foreign key, the house pattern for sibling forward references).

CREATE TABLE meeting_transcripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  session_id uuid NOT NULL,
  provider_transcript_id text NOT NULL
    CHECK (char_length(provider_transcript_id) BETWEEN 1 AND 255),
  language text CHECK (language IS NULL OR language ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$'),
  segments jsonb NOT NULL
    CHECK (jsonb_typeof(segments) = 'array' AND jsonb_array_length(segments) BETWEEN 1 AND 5000),
  evidence_observation_id uuid NOT NULL,
  captured_via text NOT NULL CHECK (captured_via IN ('polling', 'webhook')),
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meeting_transcripts_session_transcript_unique
    UNIQUE (tenant_id, session_id, provider_transcript_id),
  CONSTRAINT meeting_transcripts_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT meeting_transcripts_session_fk
    FOREIGN KEY (session_id, tenant_id) REFERENCES meeting_sessions (id, tenant_id)
);

CREATE INDEX meeting_transcripts_tenant_session_idx
  ON meeting_transcripts (tenant_id, session_id, created_at DESC);
CREATE INDEX meeting_transcripts_tenant_observation_idx
  ON meeting_transcripts (tenant_id, evidence_observation_id);

-- Storage-level guarantee: transcripts are strictly append-only capture
-- evidence — no UPDATE, no DELETE, no TRUNCATE, ever.

CREATE OR REPLACE FUNCTION meeting_transcripts_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only capture evidence (W085 meetings): % is forbidden on table %',
    TG_TABLE_NAME, TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER meeting_transcripts_immutable
  BEFORE UPDATE OR DELETE ON meeting_transcripts
  FOR EACH ROW EXECUTE FUNCTION meeting_transcripts_reject_mutation();

CREATE TRIGGER meeting_transcripts_immutable_truncate
  BEFORE TRUNCATE ON meeting_transcripts
  FOR EACH STATEMENT EXECUTE FUNCTION meeting_transcripts_reject_mutation();
