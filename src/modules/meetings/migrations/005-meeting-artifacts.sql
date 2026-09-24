-- W085 · meetings module — canonical artifacts (append-only capture
-- evidence).
--
-- One row per (tenant, session, provider artifact id): a durable artifact
-- of one session occurrence — a recording, the in-meeting chat export, a
-- provider summary, a shared document, an attachment. The canonical kind
-- vocabulary is the closed CHECK below (mirrored in validation.ts).
--
-- `storage_ref` is an OPAQUE reference to where the artifact content can
-- be materialized. It is NEVER a raw provider URL: provider URLs carry
-- scoped tokens (a credential) and must not reach domain tables
-- (IMPLEMENTATION-STACK §8). Durable blob persistence of artifact CONTENT
-- is W086's declared surface ("durable meeting artifact"); W085 records
-- the artifact's identity, provenance and evidence link.
--
-- Append-only capture evidence, exactly like transcripts: UPDATE, DELETE
-- and TRUNCATE are rejected by trigger; the immutable observation (kind
-- `meeting.artifact`) preserves exactly what the provider delivered, and
-- the row links to it (`evidence_observation_id`).
--
-- Tenant scoping (ADR-0001): every row carries tenant_id.

CREATE TABLE meeting_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  session_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'recording', 'chat', 'summary', 'document', 'attachment', 'other'
  )),
  provider_artifact_id text NOT NULL
    CHECK (char_length(provider_artifact_id) BETWEEN 1 AND 255),
  display_name text
    CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 200),
  media_type text
    CHECK (media_type IS NULL OR char_length(media_type) BETWEEN 3 AND 255),
  byte_size bigint CHECK (byte_size IS NULL OR (byte_size >= 0 AND byte_size <= 2147483647)),
  storage_ref text
    CHECK (storage_ref IS NULL OR char_length(storage_ref) BETWEEN 1 AND 1024),
  checksum text CHECK (checksum IS NULL OR char_length(checksum) BETWEEN 1 AND 255),
  evidence_observation_id uuid NOT NULL,
  captured_via text NOT NULL CHECK (captured_via IN ('polling', 'webhook')),
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meeting_artifacts_session_artifact_unique
    UNIQUE (tenant_id, session_id, provider_artifact_id),
  CONSTRAINT meeting_artifacts_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT meeting_artifacts_session_fk
    FOREIGN KEY (session_id, tenant_id) REFERENCES meeting_sessions (id, tenant_id)
);

CREATE INDEX meeting_artifacts_tenant_session_idx
  ON meeting_artifacts (tenant_id, session_id, created_at DESC);
CREATE INDEX meeting_artifacts_tenant_kind_idx
  ON meeting_artifacts (tenant_id, kind);
CREATE INDEX meeting_artifacts_tenant_observation_idx
  ON meeting_artifacts (tenant_id, evidence_observation_id);

-- Storage-level guarantee: artifacts are strictly append-only capture
-- evidence — no UPDATE, no DELETE, no TRUNCATE, ever.

CREATE OR REPLACE FUNCTION meeting_artifacts_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only capture evidence (W085 meetings): % is forbidden on table %',
    TG_TABLE_NAME, TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER meeting_artifacts_immutable
  BEFORE UPDATE OR DELETE ON meeting_artifacts
  FOR EACH ROW EXECUTE FUNCTION meeting_artifacts_reject_mutation();

CREATE TRIGGER meeting_artifacts_immutable_truncate
  BEFORE TRUNCATE ON meeting_artifacts
  FOR EACH STATEMENT EXECUTE FUNCTION meeting_artifacts_reject_mutation();
