-- W037 · destinations module — the outbound delivery ledger and its
-- append-only attempt audit.
--
-- DESTINATION DELIVERIES is the outbound ledger (the §10 "checkpointing"
-- authority for delivery — see the module types for the interpretation):
-- one row per delivery request, carrying the CANONICAL export batch
-- exactly as requested (kind, records), its evidence provenance
-- (provenance_observation_ids — validated observations), the authority
-- gate that authorized it (action_request_id, one-way fill after the
-- actions module's authorizeAction), the delivery it replays when it is a
-- reprocessing (replayed_from_id), the caller's dedupe key and the
-- lifecycle status. The substantive fields are immutable history; only
-- the status may move, and only FORWARD: 'pending' → terminal,
-- 'failed' → terminal or stayed-'failed' on another transient retry
-- (guard trigger below). DELETE and TRUNCATE are forbidden outright —
-- the ledger is the delivery audit.
--
-- ADR-0009 ("destinations never become domain truth") is carried by
-- construction: delivery rows are outbound audit state ONLY. The
-- destinations module records no observations and exposes no operation
-- that promotes a delivery or a provider acknowledgment into evidence,
-- claims or beliefs — evidence remains the observations module's concept
-- (W004), built ON TOP of nothing this table holds.
--
-- DESTINATION DELIVERY ATTEMPTS is the append-only physical audit: one
-- row per transport call, carrying the EXACT adapter-formatted envelope
-- handed to the transport (what actually left the system), the
-- provider-neutral outcome, the provider's opaque acknowledgment id, the
-- transport's detail text and the wall-clock window of the attempt.
-- Nothing may UPDATE, DELETE or TRUNCATE an attempt row.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the composite
-- UNIQUE (id, tenant_id) matches the house pattern. No cross-module
-- foreign keys: action_request_id references the actions module's gate
-- request and provenance_observation_ids reference the observations
-- module's evidence opaquely, like every sibling forward reference.

CREATE TABLE destination_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  destination_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN (
    'looker', 'tableau', 'power-bi', 'snowflake', 'bigquery', 'redshift',
    'salesforce', 'hubspot', 'netsuite', 'google-sheets', 'airtable',
    'http-api', 'webhook'
  )),
  kind text NOT NULL CHECK (kind ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  records jsonb NOT NULL CHECK (
    jsonb_typeof(records) = 'array'
    AND jsonb_array_length(records) BETWEEN 1 AND 200
  ),
  provenance_observation_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(provenance_observation_ids) = 'array'
    AND jsonb_array_length(provenance_observation_ids) <= 32
  ),
  idempotency_key text CHECK (
    idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$'
  ),
  action_request_id uuid,
  replayed_from_id uuid,
  status text NOT NULL CHECK (status IN ('pending', 'delivered', 'rejected', 'failed')),
  requested_by text NOT NULL CHECK (requested_by <> ''),
  requested_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT destination_deliveries_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT destination_deliveries_idempotency_tenant_unique
    UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT destination_deliveries_replay_shape
    CHECK (replayed_from_id IS NULL OR replayed_from_id <> id)
);

CREATE INDEX destination_deliveries_tenant_destination_idx
  ON destination_deliveries (tenant_id, destination_id, requested_at DESC, id DESC);
CREATE INDEX destination_deliveries_tenant_status_idx
  ON destination_deliveries (tenant_id, status);
CREATE INDEX destination_deliveries_tenant_provider_idx
  ON destination_deliveries (tenant_id, provider);

CREATE TABLE destination_delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  attempt_number int NOT NULL CHECK (attempt_number BETWEEN 1 AND 1000),
  envelope jsonb NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('delivered', 'rejected', 'failed')),
  provider_delivery_id text CHECK (
    provider_delivery_id IS NULL OR char_length(provider_delivery_id) BETWEEN 1 AND 255
  ),
  detail text CHECK (detail IS NULL OR char_length(detail) <= 2000),
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  CONSTRAINT destination_delivery_attempts_attempt_unique
    UNIQUE (tenant_id, delivery_id, attempt_number),
  CONSTRAINT destination_delivery_attempts_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX destination_delivery_attempts_delivery_idx
  ON destination_delivery_attempts (tenant_id, delivery_id, attempt_number);

-- Storage-level guarantees.
--
-- destination_deliveries: DELETE and TRUNCATE are forbidden, and an
-- UPDATE may only move the lifecycle FORWARD ('pending' → terminal,
-- 'failed' → terminal or same, same-status touches for the one-way gate
-- link fill) plus fill action_request_id once (NULL → value) and move
-- updated_at. Every substantive field (tenancy, destination, provider,
-- kind, records, provenance, idempotency key, requester, requested_at,
-- replay origin) is immutable — a changed proposal is a NEW delivery.

CREATE OR REPLACE FUNCTION destination_deliveries_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'destination deliveries are the append-only outbound ledger (W037 destinations): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'destination deliveries are the append-only outbound ledger (W037 destinations): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.destination_id <> OLD.destination_id
     OR NEW.provider <> OLD.provider
     OR NEW.kind <> OLD.kind
     OR NEW.records <> OLD.records
     OR NEW.provenance_observation_ids <> OLD.provenance_observation_ids
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR (OLD.action_request_id IS NOT NULL AND NEW.action_request_id IS DISTINCT FROM OLD.action_request_id)
     OR (NEW.action_request_id IS NULL AND OLD.action_request_id IS NOT NULL)
     OR NEW.replayed_from_id IS DISTINCT FROM OLD.replayed_from_id
     OR NEW.requested_by <> OLD.requested_by
     OR NEW.requested_at <> OLD.requested_at THEN
    RAISE EXCEPTION 'destination deliveries are the append-only outbound ledger (W037 destinations): only the lifecycle status, the one-way action_request_id link and updated_at may change on table %',
      TG_TABLE_NAME;
  END IF;
  IF NOT (
       (OLD.status = 'pending' AND NEW.status IN ('pending', 'delivered', 'rejected', 'failed'))
    OR (OLD.status = 'failed'  AND NEW.status IN ('failed', 'delivered', 'rejected'))
    OR (OLD.status = NEW.status)
  ) THEN
    RAISE EXCEPTION 'destination deliveries move forward only (W037 destinations): status may not go from ''%'' to ''%'' on table %',
      OLD.status, NEW.status, TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER destination_deliveries_forward_only_updates
  BEFORE UPDATE OR DELETE ON destination_deliveries
  FOR EACH ROW EXECUTE FUNCTION destination_deliveries_guard();

CREATE TRIGGER destination_deliveries_immutable_truncate
  BEFORE TRUNCATE ON destination_deliveries
  FOR EACH STATEMENT EXECUTE FUNCTION destination_deliveries_guard();

-- destination_delivery_attempts: strictly append-only physical audit —
-- no UPDATE, DELETE or TRUNCATE, ever.

CREATE OR REPLACE FUNCTION destination_delivery_attempts_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only delivery audit (W037 destinations): % is forbidden on table %',
    TG_TABLE_NAME, TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER destination_delivery_attempts_immutable
  BEFORE UPDATE OR DELETE ON destination_delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION destination_delivery_attempts_reject_mutation();

CREATE TRIGGER destination_delivery_attempts_immutable_truncate
  BEFORE TRUNCATE ON destination_delivery_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION destination_delivery_attempts_reject_mutation();
