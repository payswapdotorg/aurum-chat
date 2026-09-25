-- W086 · realtime module — the durable meeting artifacts.
--
-- The DURABLE MEETING ARTIFACT surface (W086 acceptance): what survives
-- the session. The TRANSCRIPT artifact is materialized by the durable
-- finalization workflow (W080) into the object-storage port — a JSON
-- document of the session's canonical state; `storage_ref` is the blob
-- URL (W086 owns durable artifact storage, per the meetings module's
-- artifact contract note). RECORDING artifacts carry the provider's
-- OPAQUE materialization key (never a raw provider URL with scoped
-- tokens — IMPLEMENTATION-STACK §8).
--
-- Idempotency (the W080 exactly-once discipline): the domain-keyed
-- transcript artifact is UNIQUE per (session, domain_key) and its blob
-- key is deterministic, so a retried/recovered finalization can neither
-- duplicate it nor fork its reference; provider recording artifacts are
-- UNIQUE per (session, provider artifact id), so a re-delivered
-- recording.stopped event cannot double-record.
--
-- Append-only capture evidence: no UPDATE, no DELETE, no TRUNCATE, ever.
-- (The artifact → observation direction lives in the session-close
-- observation's payload, which carries the artifact ids; artifacts
-- themselves are immutable from creation.)

CREATE TABLE realtime_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  session_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('transcript', 'recording')),
  domain_key text CHECK (domain_key IS NULL OR char_length(domain_key) BETWEEN 1 AND 64),
  provider_artifact_id text
    CHECK (provider_artifact_id IS NULL OR char_length(provider_artifact_id) BETWEEN 1 AND 255),
  display_name text
    CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 200),
  media_type text
    CHECK (media_type IS NULL OR char_length(media_type) BETWEEN 3 AND 127),
  byte_size bigint CHECK (byte_size IS NULL OR (byte_size >= 0 AND byte_size <= 2147483647)),
  storage_ref text NOT NULL CHECK (char_length(storage_ref) BETWEEN 1 AND 1024),
  checksum text CHECK (checksum IS NULL OR char_length(checksum) BETWEEN 1 AND 255),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT realtime_artifacts_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT realtime_artifacts_session_fk
    FOREIGN KEY (session_id, tenant_id)
    REFERENCES realtime_sessions (id, tenant_id),
  CONSTRAINT realtime_artifacts_kind_shape CHECK (
    (kind = 'transcript' AND domain_key = 'transcript' AND provider_artifact_id IS NULL)
    OR (kind = 'recording' AND domain_key IS NULL AND provider_artifact_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX realtime_artifacts_domain_unique
  ON realtime_artifacts (tenant_id, session_id, domain_key)
  WHERE domain_key IS NOT NULL;

CREATE UNIQUE INDEX realtime_artifacts_provider_unique
  ON realtime_artifacts (tenant_id, session_id, provider_artifact_id)
  WHERE provider_artifact_id IS NOT NULL;

CREATE INDEX realtime_artifacts_session_idx
  ON realtime_artifacts (tenant_id, session_id, kind, created_at ASC);

-- Storage-level guarantee: strictly append-only — artifacts are capture
-- evidence; a correction is a NEW artifact row (a new provider artifact
-- id), never an edit.

CREATE OR REPLACE FUNCTION realtime_artifacts_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is the append-only realtime artifact store (W086 realtime): % is forbidden on table %',
    TG_TABLE_NAME, TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER realtime_artifacts_immutable
  BEFORE UPDATE OR DELETE ON realtime_artifacts
  FOR EACH ROW EXECUTE FUNCTION realtime_artifacts_reject_mutation();

CREATE TRIGGER realtime_artifacts_immutable_truncate
  BEFORE TRUNCATE ON realtime_artifacts
  FOR EACH STATEMENT EXECUTE FUNCTION realtime_artifacts_reject_mutation();
