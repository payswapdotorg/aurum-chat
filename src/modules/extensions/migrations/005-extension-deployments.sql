-- W026 · extensions module — extension deployments (the runtime's
-- version-and-grant records; append-only history).
--
-- One IMMUTABLE row per applied deployment or rollback of one manifest
-- version into one install of one extension. The deployment record is
-- the W025 contract layer's "install-time grant" made operational:
--
--   * granted_permissions — the EFFECTIVE permission set of the
--     deployment, bounded by the deployed manifest's
--     requested_permissions ceiling (the storage trigger below enforces
--     the subset rule for writes bypassing the service, defense in
--     depth; the closed vocabulary is a CHECK). Every runtime
--     operation checks the CURRENT deployment's grant, so narrowing a
--     grant is a redeploy, never a mutation of history.
--   * install_key — the stable key deployments group under (the
--     runtime's install concept; 'default' when the caller does not
--     distinguish). Rollback deploys into the SAME install.
--   * operation — 'deploy' | 'rollback'; replaces_deployment_id links
--     the deployment this one superseded at apply time (the audit
--     trail of "what was running before"), tenant-consistent.
--   * action_request_id — the actions module's authority-gate record
--     that authorized the deployment (kind 'extension-deployment',
--     level EXECUTE — §20's uniform gate; the W025 lifecycle precedent).
--     UNIQUE: one applied deployment per gate request, so an idempotent
--     replay of an approved deployment replays the recorded outcome
--     instead of appending a second row.
--
-- The CURRENT deployment of (tenant, extension, install) is DERIVED —
-- the row with the highest seq (a bigint IDENTITY column, so append
-- order is monotonic and total) — never a mutable pointer: history is
-- the record, the present is a fold.
--
-- Deployment is authorization-gated management action; the records are
-- evidence. Storage-level append-only guarantee (the house pattern):
-- the triggers below reject UPDATE, DELETE and TRUNCATE outright.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the
-- composite foreign keys keep a deployment tenant-consistent with its
-- extension and its manifest.

CREATE TABLE extension_deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  extension_id uuid NOT NULL,
  extension_key text NOT NULL CHECK (
    extension_key ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
  ),
  install_key text NOT NULL CHECK (
    install_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
  ),
  manifest_id uuid NOT NULL,
  version text NOT NULL CHECK (
    version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
  ),
  operation text NOT NULL CHECK (operation IN ('deploy', 'rollback')),
  replaces_deployment_id uuid,
  granted_permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  deployed_by text NOT NULL CHECK (deployed_by <> ''),
  deployed_at timestamptz NOT NULL,
  action_request_id uuid,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  CONSTRAINT extension_deployments_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT extension_deployments_request_unique UNIQUE (action_request_id),
  CONSTRAINT extension_deployments_extension_tenant_fk
    FOREIGN KEY (extension_id, tenant_id) REFERENCES extensions (id, tenant_id),
  CONSTRAINT extension_deployments_manifest_tenant_fk
    FOREIGN KEY (manifest_id, tenant_id) REFERENCES extension_manifests (id, tenant_id),
  CONSTRAINT extension_deployments_replaces_tenant_fk
    FOREIGN KEY (replaces_deployment_id, tenant_id) REFERENCES extension_deployments (id, tenant_id),
  CONSTRAINT extension_deployments_shape CHECK (
    jsonb_typeof(granted_permissions) = 'array'
  ),
  CONSTRAINT extension_deployments_permissions_vocabulary CHECK (
    granted_permissions <@ '[
      "state:read","state:write","ui:render","schedule:run",
      "events:subscribe","external:participate","telemetry:emit"
    ]'::jsonb
  ),
  CONSTRAINT extension_deployments_replaces_self_or_null CHECK (
    replaces_deployment_id IS NULL OR replaces_deployment_id <> id
  )
);

-- The "current deployment" lookup: newest row per (tenant, extension,
-- install) by the monotonic identity column.
CREATE INDEX extension_deployments_current_idx
  ON extension_deployments (tenant_id, extension_id, install_key, seq DESC);
CREATE INDEX extension_deployments_tenant_deployed_idx
  ON extension_deployments (tenant_id, deployed_at DESC);

-- Grant ⊆ requested-ceiling at the storage level (W026 security core,
-- the runtime's analog of the manifests' permission-consistency
-- trigger in migrations/002). A write bypassing the service cannot
-- grant a permission the deployed manifest never requested.

CREATE OR REPLACE FUNCTION extension_deployments_check_grant() RETURNS trigger AS $$
DECLARE
  ceiling jsonb;
BEGIN
  SELECT requested_permissions INTO ceiling FROM extension_manifests
    WHERE tenant_id = NEW.tenant_id AND id = NEW.manifest_id;
  IF ceiling IS NULL THEN
    RAISE EXCEPTION 'deployment references a manifest outside its tenant (W026 extension runtime)';
  END IF;
  IF NOT (NEW.granted_permissions <@ ceiling) THEN
    RAISE EXCEPTION 'deployment grants permissions beyond the manifest''s requested ceiling (W026 extension runtime)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER extension_deployments_grant_valid
  BEFORE INSERT OR UPDATE ON extension_deployments
  FOR EACH ROW EXECUTE FUNCTION extension_deployments_check_grant();

-- Storage-level append-only guarantee: nothing may UPDATE, DELETE or
-- TRUNCATE a deployment record — not even a future module bypassing the
-- service. The message deliberately names no row id so the same
-- function serves the row-level and the statement-level trigger.

CREATE OR REPLACE FUNCTION extension_deployments_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'extension deployments are append-only history (W026 extension runtime): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER extension_deployments_immutable
  BEFORE UPDATE OR DELETE ON extension_deployments
  FOR EACH ROW EXECUTE FUNCTION extension_deployments_reject_mutation();

CREATE TRIGGER extension_deployments_immutable_truncate
  BEFORE TRUNCATE ON extension_deployments
  FOR EACH STATEMENT EXECUTE FUNCTION extension_deployments_reject_mutation();
