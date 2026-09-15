-- W029 · conversations module — links to cognitive executions.
--
-- One row per (execution, role, target): the conversations module persists
-- REFERENCES to the cognition module's executions (W013). It never reads,
-- writes or validates execution state — `execution_id` is an opaque uuid
-- (the cognition module does not exist at W029 and cross-module foreign
-- keys are impossible, MODULE-DEPENDENCY-MAP.md), exactly like the opaque
-- source references the observations module persists. A link grants no
-- authority: the transcript never becomes truth because an execution
-- touched it (lock 10; ADR-0014 — conversation is a channel only).
--
-- Roles:
--   'triggered' — the conversation (as a whole) or a specific message
--                 caused a cognitive execution to start (inbound
--                 causation: what the loop was reacting to);
--   'produced'  — the cognitive execution produced this specific outbound
--                 message (outbound causation) — requires a message.
--
-- `conversation_id` is always carried; for message-level links the service
-- derives it from the message, and a BEFORE INSERT trigger enforces the
-- match at the storage level. Links are append-only and idempotent per
-- (tenant, execution, role, target): re-recording an identical link replays
-- the original row — channel adapters and the orchestrator may retry.

CREATE TABLE conversation_execution_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  message_id uuid,
  execution_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('triggered', 'produced')),
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_execution_links_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT conversation_execution_links_conversation_fk
    FOREIGN KEY (conversation_id, tenant_id) REFERENCES conversations (id, tenant_id),
  CONSTRAINT conversation_execution_links_message_fk
    FOREIGN KEY (message_id, tenant_id) REFERENCES conversation_messages (id, tenant_id),
  CONSTRAINT conversation_execution_links_role_target CHECK (
    role <> 'produced' OR message_id IS NOT NULL
  )
);

-- Idempotency per target shape: a message-level link is unique per
-- (tenant, execution, role, message); a conversation-level link (the
-- conversation as a whole) is unique per (tenant, execution, role,
-- conversation). NULLs never collide (partial unique indexes).

CREATE UNIQUE INDEX conversation_execution_links_message_unique
  ON conversation_execution_links (tenant_id, execution_id, role, message_id)
  WHERE message_id IS NOT NULL;

CREATE UNIQUE INDEX conversation_execution_links_conversation_unique
  ON conversation_execution_links (tenant_id, execution_id, role, conversation_id)
  WHERE message_id IS NULL;

CREATE INDEX conversation_execution_links_tenant_conversation_idx
  ON conversation_execution_links (tenant_id, conversation_id);
CREATE INDEX conversation_execution_links_tenant_execution_idx
  ON conversation_execution_links (tenant_id, execution_id);
CREATE INDEX conversation_execution_links_tenant_message_idx
  ON conversation_execution_links (tenant_id, message_id)
  WHERE message_id IS NOT NULL;

-- Storage-level consistency: a message-level link must name the
-- conversation its message belongs to (defense in depth — the service
-- already derives conversation_id from the message).

CREATE OR REPLACE FUNCTION conversation_execution_links_check_message() RETURNS trigger AS $$
DECLARE
  message_conversation uuid;
BEGIN
  IF NEW.message_id IS NOT NULL THEN
    SELECT conversation_id INTO message_conversation
      FROM conversation_messages
      WHERE tenant_id = NEW.tenant_id AND id = NEW.message_id;
    IF message_conversation IS NULL OR message_conversation <> NEW.conversation_id THEN
      RAISE EXCEPTION 'execution link message/conversation mismatch (tenant %, message %, conversation %)',
        NEW.tenant_id, NEW.message_id, NEW.conversation_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER conversation_execution_links_message_consistent
  BEFORE INSERT ON conversation_execution_links
  FOR EACH ROW EXECUTE FUNCTION conversation_execution_links_check_message();

-- Storage-level immutability: links are append-only provenance history.

CREATE OR REPLACE FUNCTION conversation_execution_links_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'conversation execution links are immutable (append-only provenance): % is forbidden on tenant %, table %',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER conversation_execution_links_immutable
  BEFORE UPDATE OR DELETE ON conversation_execution_links
  FOR EACH ROW EXECUTE FUNCTION conversation_execution_links_reject_mutation();

CREATE TRIGGER conversation_execution_links_immutable_truncate
  BEFORE TRUNCATE ON conversation_execution_links
  FOR EACH STATEMENT EXECUTE FUNCTION conversation_execution_links_reject_mutation();
