-- W025 · extensions module — the extension registry (one row per
-- (tenant, extension key)).
--
-- ARCHITECTURE.md §17: "Extensions are real software capabilities, not
-- a fixed feature catalog." The registry row is the extension's IDENTITY
-- in the tenant: a stable key plus its lifecycle state. Everything
-- substantive about WHAT an extension is lives in its immutable,
-- versioned manifests (migrations/002); what STATE it is in lives here:
--
--   REGISTERED — manifests recorded, the extension is inert;
--   ACTIVE     — enabled (publication never implies activation — §17:
--                "Publication never implies tenant installation or
--                activation");
--   SUSPENDED  — temporarily disabled (§17 "disablement");
--   DEPRECATED — retired; TERMINAL.
--
-- The lifecycle is a management-controlled, auditable concern: every
-- applied transition is authorized through the actions module's
-- authority matrix (kind 'extension-deployment', level EXECUTE — §20
-- lists extension deployment among the consequential actions) and
-- appended to extension_lifecycle_events (migrations/004). The row
-- itself may move ONLY its lifecycle_state and updated_at — the guard
-- trigger below forbids DELETE/TRUNCATE outright and rejects any UPDATE
-- that touches the identity fields, so an extension's history cannot be
-- rewritten or erased even by a caller bypassing the service
-- (deprecation is the retire path, not deletion).
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the key is
-- unique PER TENANT — two tenants may register extensions under the
-- same key with no interaction, and cross-tenant access is
-- indistinguishable from a missing record at the service layer.

CREATE TABLE extensions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  extension_key text NOT NULL CHECK (
    extension_key ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
  ),
  lifecycle_state text NOT NULL CHECK (lifecycle_state IN (
    'REGISTERED', 'ACTIVE', 'SUSPENDED', 'DEPRECATED'
  )),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT extensions_tenant_key_unique UNIQUE (tenant_id, extension_key),
  CONSTRAINT extensions_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX extensions_tenant_state_idx ON extensions (tenant_id, lifecycle_state);
CREATE INDEX extensions_tenant_updated_idx ON extensions (tenant_id, updated_at DESC);

-- Storage-level identity immutability: an extension may move only its
-- lifecycle state (and updated_at); its identity (tenant, key) and
-- creation time are history. DELETE and TRUNCATE are always forbidden —
-- DEPRECATED is the retire path, and the audit trail must survive.

CREATE OR REPLACE FUNCTION extensions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'extensions are registry history (W025 extension contracts): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'extensions are registry history (W025 extension contracts): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.extension_key <> OLD.extension_key
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'extensions are registry history (W025 extension contracts): only the lifecycle state (lifecycle_state, updated_at) may change on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER extensions_state_only_updates
  BEFORE UPDATE OR DELETE ON extensions
  FOR EACH ROW EXECUTE FUNCTION extensions_guard();

CREATE TRIGGER extensions_immutable_truncate
  BEFORE TRUNCATE ON extensions
  FOR EACH STATEMENT EXECUTE FUNCTION extensions_guard();
