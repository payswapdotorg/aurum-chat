-- W026 · extensions module — external participation call records
-- (append-only).
--
-- One IMMUTABLE row per scoped external participation call (§17
-- "scoped external participants"). The runtime only executes calls
-- whose origin EXACTLY matches a declared participant origin of the
-- current deployment's manifest (the sandbox boundary W047 tests) and
-- only within the manifest's maxExternalCallsPerDay quota (counted
-- per (tenant, extension, install, UTC day) over these rows).
--
-- Recorded per call: origin/method/path (the request's shape — the
-- request body itself is never stored, only its serialized size), the
-- outcome ('succeeded' for 2xx, 'http_error' for a non-2xx status,
-- 'failed' when the egress port threw), the HTTP status when there
-- was one, and a bounded diagnostic detail. Response bodies are never
-- stored; request headers are never stored (secrets do not become
-- evidence — IMPLEMENTATION-STACK §8).
--
-- Storage-level append-only guarantee (the house pattern): the
-- triggers below reject UPDATE, DELETE and TRUNCATE outright.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the
-- composite foreign key keeps a call tenant-consistent with its
-- extension.

CREATE TABLE extension_external_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  extension_id uuid NOT NULL,
  extension_key text NOT NULL CHECK (
    extension_key ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
  ),
  install_key text NOT NULL CHECK (
    install_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
  ),
  origin text NOT NULL CHECK (origin LIKE 'https://%' AND char_length(origin) <= 255),
  method text NOT NULL CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  path text NOT NULL CHECK (path LIKE '/%' AND char_length(path) <= 512),
  request_body_bytes integer NOT NULL CHECK (request_body_bytes >= 0),
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'http_error', 'failed')),
  response_status integer CHECK (
    response_status IS NULL OR (response_status >= 100 AND response_status <= 599)
  ),
  detail text,
  requested_by text NOT NULL CHECK (requested_by <> ''),
  requested_at timestamptz NOT NULL,
  CONSTRAINT extension_external_calls_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT extension_external_calls_extension_tenant_fk
    FOREIGN KEY (extension_id, tenant_id) REFERENCES extensions (id, tenant_id),
  -- The outcome vocabulary is total: a status exists exactly when the
  -- participant answered.
  CONSTRAINT extension_external_calls_status_shape CHECK (
    (outcome = 'succeeded' AND response_status >= 200 AND response_status <= 299)
    OR (outcome = 'http_error' AND response_status >= 100)
    OR (outcome = 'failed' AND response_status IS NULL)
  )
);

CREATE INDEX extension_external_calls_quota_idx
  ON extension_external_calls (tenant_id, extension_id, install_key, requested_at);
CREATE INDEX extension_external_calls_list_idx
  ON extension_external_calls (tenant_id, extension_id, requested_at DESC);

CREATE OR REPLACE FUNCTION extension_external_calls_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'extension external calls are append-only evidence (W026 extension runtime): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER extension_external_calls_immutable
  BEFORE UPDATE OR DELETE ON extension_external_calls
  FOR EACH ROW EXECUTE FUNCTION extension_external_calls_reject_mutation();

CREATE TRIGGER extension_external_calls_immutable_truncate
  BEFORE TRUNCATE ON extension_external_calls
  FOR EACH STATEMENT EXECUTE FUNCTION extension_external_calls_reject_mutation();
