-- W038 · api module — outbound webhook subscriptions, deliveries and the
-- append-only delivery-attempt evidence.
--
-- The public API's webhook surface (WORK-ITEM-CATALOG W038: "…operations
-- and webhooks"): a tenant subscribes an https endpoint to event-type
-- patterns; matched events enqueue one delivery per subscription; the
-- explicit dispatch pump performs bounded attempts with exponential
-- backoff (lock 36 discipline — asynchronous, resumable, traceable).
--
--  * secret_ref is an OPAQUE reference into the secret store — the HMAC
--    signing secret VALUE never reaches any domain table
--    (IMPLEMENTATION-STACK §8; the sources/channels credential_ref
--    precedent). The webhook transport resolves it when signing.
--  * event_types patterns are validated exactly in the service
--    (src/modules/api/webhook.ts); this CHECK is the storage-level
--    backstop on count and the pattern character set (canonical ids may
--    also carry a trailing `.*`, `*` matches everything).
--  * api_webhook_deliveries.body is the FROZEN delivery envelope as an
--    exact text payload — the same bytes are POSTed on every attempt, so
--    subscriber-side HMAC verification stays valid across retries.
--  * Fanout idempotency: at most ONE delivery per (subscription, event)
--    for organic fanout rows — enforced by the partial unique index below
--    (redeliveries and test pings are exempt; event_id IS NULL exactly on
--    test pings). The service inserts with ON CONFLICT DO NOTHING against
--    that index, so concurrent fanout of the same event collapses.
--  * Delivery rows are EXECUTION STATE (the agent_executions precedent):
--    status/attempts/next_attempt_at move forward only, and attempts are
--    never rewritten. The attempt TABLE itself is append-only — storage
--    triggers reject UPDATE/DELETE/TRUNCATE outright (lock 5 discipline
--    applied to evidence).

CREATE TABLE api_webhook_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
  url text NOT NULL CHECK (char_length(url) BETWEEN 12 AND 2048),
  event_types text[] NOT NULL,
  secret_ref text CHECK (secret_ref IS NULL OR char_length(secret_ref) BETWEEN 1 AND 255),
  max_attempts int NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deactivated')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL CHECK (created_by <> ''),
  deactivated_at timestamptz,
  deactivated_by text,
  CONSTRAINT api_webhook_subscriptions_tenant_url_unique UNIQUE (tenant_id, url),
  CONSTRAINT api_webhook_event_types_shape CHECK (
    cardinality(event_types) BETWEEN 1 AND 20
    AND array_to_string(event_types, ',') ~
      '^[A-Za-z0-9*][A-Za-z0-9._:*-]{0,127}(,[A-Za-z0-9*][A-Za-z0-9._:*-]{0,127})*$'
  )
);

CREATE INDEX api_webhook_subscriptions_tenant_status_idx
  ON api_webhook_subscriptions (tenant_id, status);

CREATE TABLE api_webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  delivery_kind text NOT NULL CHECK (delivery_kind IN ('event', 'test')),
  event_id uuid,
  event_type text NOT NULL CHECK (event_type ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  body text NOT NULL CHECK (char_length(body) BETWEEN 2 AND 262144),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts int NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_status_code int CHECK (last_status_code IS NULL OR last_status_code BETWEEN 100 AND 599),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  finalized_at timestamptz,
  redelivery_of uuid,
  CONSTRAINT api_webhook_delivery_event_xor_redelivery CHECK (
    (delivery_kind = 'test' AND event_id IS NULL)
    OR (delivery_kind = 'event' AND event_id IS NOT NULL)
  )
);

-- Fanout idempotency: one organic delivery per (subscription, event).
CREATE UNIQUE INDEX api_webhook_deliveries_fanout_unique
  ON api_webhook_deliveries (subscription_id, event_id)
  WHERE event_id IS NOT NULL AND redelivery_of IS NULL;

CREATE INDEX api_webhook_deliveries_tenant_status_due_idx
  ON api_webhook_deliveries (tenant_id, status, next_attempt_at);

CREATE INDEX api_webhook_deliveries_tenant_subscription_idx
  ON api_webhook_deliveries (tenant_id, subscription_id, created_at);

CREATE TABLE api_webhook_delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  attempt_no int NOT NULL CHECK (attempt_no >= 1),
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'transient_failure', 'terminal_failure')),
  status_code int CHECK (status_code IS NULL OR status_code BETWEEN 100 AND 599),
  error text,
  latency_ms int CHECK (latency_ms IS NULL OR latency_ms >= 0),
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL
);

CREATE INDEX api_webhook_delivery_attempts_tenant_delivery_idx
  ON api_webhook_delivery_attempts (tenant_id, delivery_id, attempt_no);

-- Storage-level immutability: delivery attempts are append-only evidence —
-- nothing may UPDATE, DELETE or TRUNCATE them, not even a caller bypassing
-- the service (the events/observations trigger precedent).

CREATE OR REPLACE FUNCTION api_webhook_attempts_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'webhook delivery attempts are append-only (W038 evidence): % is forbidden on tenant %, table %',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER api_webhook_attempts_immutable
  BEFORE UPDATE OR DELETE ON api_webhook_delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION api_webhook_attempts_reject_mutation();

CREATE TRIGGER api_webhook_attempts_immutable_truncate
  BEFORE TRUNCATE ON api_webhook_delivery_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION api_webhook_attempts_reject_mutation();
