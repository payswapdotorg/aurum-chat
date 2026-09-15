-- W029 · conversations module — conversation threads and messages.
--
-- A conversation is a persisted communication THREAD; a message is one
-- immutable turn with full provenance: actor (who), channel + provider
-- message id (through which conduit, under the provider's own message
-- identity), sent_at (the sender's/channel's clock) vs recorded_at (Aurum's
-- commit time, set by the service via the injectable clock).
--
-- Chat is a CHANNEL, not the product (ARCHITECTURE.md §1, ADR-0014): this
-- table is the transcript of what was actually communicated — it is never
-- authoritative truth. Messages carry no confidence or truth metadata;
-- incoming messages become EVIDENCE only through the observations module
-- (W004) and understanding through epistemics (W007) — both deliberately
-- outside this module's dependency set (W029 depends on W002 only, per the
-- work-item DAG), so no observation is created here.
--
-- Actor attribution (ADR-0003, lock 15): a message may only be attributed
-- to a `person` through a verified, linked channel identity — the service
-- enforces this through the identity/people contracts (W002). The storage
-- layer keeps `actor_id` opaque (people.persons.id for persons; the agents
-- module's id for agents once W021 lands — no cross-module foreign key is
-- possible). `actor_identity_id` records the channel identity used for that
-- specific message: the same person may speak through many providers
-- (W045), and the transcript must show which one carried each turn.
--
-- Direction semantics (ARCHITECTURE.md §9): `inbound` messages enter
-- perception; `outbound` messages are actions of the tenant side. Two
-- incoherent combinations are rejected outright by CHECK: an external party
-- cannot send on the tenant's outbound side, and Aurum's own subsystems
-- are never inbound senders.
--
-- Idempotency: (tenant_id, channel, provider_message_id) is UNIQUE for
-- non-null provider ids — a channel webhook redelivering the same provider
-- message replays the original row instead of duplicating the transcript.
--
-- Immutability: the transcript is append-only history (what was said
-- cannot be silently rewritten — it feeds audit reconstruction, §24);
-- UPDATE/DELETE/TRUNCATE are rejected by triggers, mirroring the events and
-- observations modules. A provider-side edit is a NEW message; both turns
-- are retained (lock 12 spirit). If a retention/purge policy is ever
-- required it will arrive as its own governed migration — never a silent
-- rewrite.

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  title text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversations_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT conversations_title_shape CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 200)
);

CREATE INDEX conversations_tenant_created_idx ON conversations (tenant_id, created_at DESC);

CREATE TABLE conversation_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  actor_kind text NOT NULL CHECK (actor_kind IN ('person', 'agent', 'system', 'external')),
  actor_id uuid,
  actor_label text,
  actor_identity_id uuid,
  -- NOTE: mirrors CHANNEL_PROVIDERS in src/modules/identity/providers.ts —
  -- keep both in sync (the same note the identity migration carries).
  channel text NOT NULL CHECK (channel IN (
    'whatsapp', 'telegram', 'signal', 'slack', 'x', 'instagram',
    'facebook', 'linkedin', 'email', 'sms', 'voice', 'web'
  )),
  provider_message_id text,
  payload jsonb NOT NULL,
  sent_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_messages_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT conversation_messages_conversation_fk
    FOREIGN KEY (conversation_id, tenant_id) REFERENCES conversations (id, tenant_id),
  CONSTRAINT conversation_messages_actor_traceable CHECK (actor_id IS NOT NULL OR actor_label IS NOT NULL),
  CONSTRAINT conversation_messages_actor_id_scoped CHECK (
    actor_kind IN ('person', 'agent') OR actor_id IS NULL
  ),
  CONSTRAINT conversation_messages_direction_actor_coherent CHECK (
    (direction <> 'outbound' OR actor_kind <> 'external')
    AND (direction <> 'inbound' OR actor_kind <> 'system')
  ),
  CONSTRAINT conversation_messages_provider_message_id_shape CHECK (
    provider_message_id IS NULL OR char_length(provider_message_id) BETWEEN 1 AND 255
  ),
  CONSTRAINT conversation_messages_actor_label_shape CHECK (
    actor_label IS NULL OR char_length(actor_label) BETWEEN 1 AND 200
  )
);

CREATE UNIQUE INDEX conversation_messages_provider_dedupe_idx
  ON conversation_messages (tenant_id, channel, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE INDEX conversation_messages_tenant_conversation_idx
  ON conversation_messages (tenant_id, conversation_id, sent_at);
CREATE INDEX conversation_messages_tenant_channel_idx ON conversation_messages (tenant_id, channel);
CREATE INDEX conversation_messages_tenant_actor_idx ON conversation_messages (tenant_id, actor_kind, actor_id);
CREATE INDEX conversation_messages_tenant_identity_idx
  ON conversation_messages (tenant_id, actor_identity_id)
  WHERE actor_identity_id IS NOT NULL;
CREATE INDEX conversation_messages_tenant_sent_idx ON conversation_messages (tenant_id, sent_at);

-- Storage-level immutability (append-only transcript): nothing may UPDATE,
-- DELETE or TRUNCATE a conversation or message — not even a future module
-- bypassing the service.

CREATE OR REPLACE FUNCTION conversations_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'conversations are immutable (chat is a channel, not truth — ADR-0014): % is forbidden on tenant %, table %',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER conversations_immutable
  BEFORE UPDATE OR DELETE ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversations_reject_mutation();

CREATE TRIGGER conversations_immutable_truncate
  BEFORE TRUNCATE ON conversations
  FOR EACH STATEMENT EXECUTE FUNCTION conversations_reject_mutation();

CREATE OR REPLACE FUNCTION conversation_messages_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'conversation messages are immutable (chat is a channel, not truth — ADR-0014): % is forbidden on tenant %, table %',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER conversation_messages_immutable
  BEFORE UPDATE OR DELETE ON conversation_messages
  FOR EACH ROW EXECUTE FUNCTION conversation_messages_reject_mutation();

CREATE TRIGGER conversation_messages_immutable_truncate
  BEFORE TRUNCATE ON conversation_messages
  FOR EACH STATEMENT EXECUTE FUNCTION conversation_messages_reject_mutation();
