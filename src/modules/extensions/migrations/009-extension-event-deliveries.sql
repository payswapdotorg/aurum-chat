-- W026 · extensions module — event delivery records (append-only).
--
-- One IMMUTABLE row per delivery of one dispatched topic to one
-- subscribed install (§17 "event subscriptions"). Dispatch resolves
-- every install whose CURRENT deployment's manifest subscribes to the
-- topic and appends one record per install: outcome 'delivered' when
-- the install's grant includes events:subscribe, 'not_granted' when it
-- does not — a grant downgrade is visible as evidence, never silent.
-- The payload is the opaque bounded JSON the dispatcher handed over;
-- the topic vocabulary is the canonical slug space the manifests'
-- eventSubscriptions share.
--
-- Storage-level append-only guarantee (the house pattern): the
-- triggers below reject UPDATE, DELETE and TRUNCATE outright.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the
-- composite foreign key keeps a delivery tenant-consistent with its
-- extension. Dispatch is a tenant-scoped fan-out — another tenant's
-- subscriptions are never consulted.

CREATE TABLE extension_event_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  extension_id uuid NOT NULL,
  extension_key text NOT NULL CHECK (
    extension_key ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
  ),
  install_key text NOT NULL CHECK (
    install_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
  ),
  topic text NOT NULL CHECK (
    topic ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  payload jsonb NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('delivered', 'not_granted')),
  delivered_at timestamptz NOT NULL,
  CONSTRAINT extension_event_deliveries_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT extension_event_deliveries_extension_tenant_fk
    FOREIGN KEY (extension_id, tenant_id) REFERENCES extensions (id, tenant_id)
);

CREATE INDEX extension_event_deliveries_list_idx
  ON extension_event_deliveries (tenant_id, extension_id, install_key, delivered_at DESC);
CREATE INDEX extension_event_deliveries_topic_idx
  ON extension_event_deliveries (tenant_id, topic, delivered_at DESC);

CREATE OR REPLACE FUNCTION extension_event_deliveries_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'extension event deliveries are append-only evidence (W026 extension runtime): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER extension_event_deliveries_immutable
  BEFORE UPDATE OR DELETE ON extension_event_deliveries
  FOR EACH ROW EXECUTE FUNCTION extension_event_deliveries_reject_mutation();

CREATE TRIGGER extension_event_deliveries_immutable_truncate
  BEFORE TRUNCATE ON extension_event_deliveries
  FOR EACH STATEMENT EXECUTE FUNCTION extension_event_deliveries_reject_mutation();
