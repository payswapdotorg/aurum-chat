-- W030 · channels module — provider thread → conversation routing.
--
-- One row per (tenant, provider, provider-native thread key): the FIRST
-- canonical message observed on a provider thread maps that thread to the
-- conversation the transcript created for it (chat id, channel id, session
-- id, subject-normalized email thread, …). The key and the conversation id
-- are OPAQUE to everything except the channels service; no cross-module
-- foreign key is possible (the conversations module owns the conversations
-- table — same discipline as identities.subject_id).
--
-- This table is observation-derived routing evidence (it exists because
-- messages were observed), so it is APPEND-ONLY: nothing may UPDATE,
-- DELETE or TRUNCATE a mapping — not even a future module bypassing the
-- service. First mapping wins; a misrouted thread is a new mapping after
-- an explicit governed migration, never a silent rewrite (lock 12 spirit).

CREATE TABLE channel_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN (
    'whatsapp', 'telegram', 'signal', 'slack', 'x', 'instagram',
    'facebook', 'linkedin', 'email', 'sms', 'voice', 'web'
  )),
  provider_thread_key text NOT NULL,
  conversation_id uuid NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_threads_tenant_provider_thread_unique
    UNIQUE (tenant_id, provider, provider_thread_key),
  CONSTRAINT channel_threads_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT channel_threads_thread_key_shape
    CHECK (char_length(provider_thread_key) BETWEEN 1 AND 512)
);

CREATE INDEX channel_threads_tenant_conversation_idx
  ON channel_threads (tenant_id, conversation_id);
CREATE INDEX channel_threads_tenant_provider_idx
  ON channel_threads (tenant_id, provider);

-- Storage-level immutability (append-only routing evidence).

CREATE OR REPLACE FUNCTION channel_threads_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'channel thread mappings are append-only (first mapping wins — ADR-0014/lock 12 spirit): % is forbidden on tenant %, table %',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER channel_threads_immutable
  BEFORE UPDATE OR DELETE ON channel_threads
  FOR EACH ROW EXECUTE FUNCTION channel_threads_reject_mutation();

CREATE TRIGGER channel_threads_immutable_truncate
  BEFORE TRUNCATE ON channel_threads
  FOR EACH STATEMENT EXECUTE FUNCTION channel_threads_reject_mutation();
