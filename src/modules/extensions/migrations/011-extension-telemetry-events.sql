-- W026 · extensions module — extension telemetry events (append-only).
--
-- One IMMUTABLE row per extension-emitted telemetry event (§17
-- "telemetry"). Emission is gated on the current deployment's
-- manifest declaring the telemetry capability and its grant including
-- telemetry:emit; the payload is bounded opaque JSON. The runtime's
-- own activity records (deployments, schedule runs, deliveries,
-- external calls) are evidence in their own tables; this table is the
-- extension's own channel — what IT chose to report about its work.
--
-- Storage-level append-only guarantee (the house pattern): the
-- triggers below reject UPDATE, DELETE and TRUNCATE outright.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the
-- composite foreign key keeps a telemetry event tenant-consistent
-- with its extension.

CREATE TABLE extension_telemetry_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  extension_id uuid NOT NULL,
  extension_key text NOT NULL CHECK (
    extension_key ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
  ),
  install_key text NOT NULL CHECK (
    install_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
  ),
  name text NOT NULL CHECK (
    name ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
  ),
  payload jsonb NOT NULL,
  emitted_by text NOT NULL CHECK (emitted_by <> ''),
  emitted_at timestamptz NOT NULL,
  CONSTRAINT extension_telemetry_events_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT extension_telemetry_events_extension_tenant_fk
    FOREIGN KEY (extension_id, tenant_id) REFERENCES extensions (id, tenant_id)
);

CREATE INDEX extension_telemetry_events_list_idx
  ON extension_telemetry_events (tenant_id, extension_id, install_key, emitted_at DESC);

CREATE OR REPLACE FUNCTION extension_telemetry_events_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'extension telemetry events are append-only evidence (W026 extension runtime): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER extension_telemetry_events_immutable
  BEFORE UPDATE OR DELETE ON extension_telemetry_events
  FOR EACH ROW EXECUTE FUNCTION extension_telemetry_events_reject_mutation();

CREATE TRIGGER extension_telemetry_events_immutable_truncate
  BEFORE TRUNCATE ON extension_telemetry_events
  FOR EACH STATEMENT EXECUTE FUNCTION extension_telemetry_events_reject_mutation();
