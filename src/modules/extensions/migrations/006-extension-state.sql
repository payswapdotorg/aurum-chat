-- W026 · extensions module — persistent scoped extension state.
--
-- The persistent state store of the extension runtime (§17 "persistent
-- tenant/install scoped state"). One row per state key of one
-- namespace:
--
--   * install_key IS NULL — the TENANT namespace: (tenant, extension,
--     key), shared across every install and every deployment; state
--     survives version upgrades and rollbacks (that is the point of
--     rollback safety).
--   * install_key = slug — the INSTALL namespace: (tenant, extension,
--     install, key), isolated between installs of the same extension
--     (two installs never see each other's rows — the isolation
--     boundary W047 tests).
--
-- The scope of a given extension is whatever its CURRENT deployment's
-- manifest declares (stateScope 'tenant' | 'install' | 'none'); the
-- service enforces scope↔install_key agreement and the namespace's
-- maxStateBytes quota (SUM(bytes) per namespace, the declared
-- manifest's ceiling).
--
-- State is RUNTIME STATE, not evidence: the value is legitimately
-- replaceable (upsert with revision +1) like an authority policy — but
-- the row's IDENTITY (tenant, extension, install namespace, key,
-- creation time) is immutable, the revision only ever moves forward,
-- and DELETE/TRUNCATE are forbidden outright: a key is cleared by
-- overwriting its value with null, never by removing it (the quota
-- accounting and the read model stay total). Triggers enforce all of
-- this even for writes bypassing the service.
--
-- `bytes` is the UTF-8 length of the value's canonical JSON
-- serialization (service-computed; the CHECK is a coarse backstop).
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the
-- composite foreign key keeps state tenant-consistent with its
-- extension.

CREATE TABLE extension_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  extension_id uuid NOT NULL,
  install_key text,
  state_key text NOT NULL CHECK (
    state_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  value jsonb NOT NULL,
  bytes integer NOT NULL CHECK (bytes >= 0 AND bytes <= 524288),
  revision integer NOT NULL CHECK (revision >= 1),
  updated_by text NOT NULL CHECK (updated_by <> ''),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT extension_state_extension_tenant_fk
    FOREIGN KEY (extension_id, tenant_id) REFERENCES extensions (id, tenant_id),
  CONSTRAINT extension_state_install_key_shape CHECK (
    install_key IS NULL OR install_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
  )
);

-- One key per namespace. install_key NULL (tenant scope) and any slug
-- (install scope) never collide: the expression index folds NULL to
-- the empty string, which the slug CHECK above can never produce.
CREATE UNIQUE INDEX extension_state_namespace_key_unique
  ON extension_state (tenant_id, extension_id, COALESCE(install_key, ''), state_key);

-- The quota accounting lookup: SUM(bytes) per namespace.
CREATE INDEX extension_state_namespace_idx
  ON extension_state (tenant_id, extension_id, COALESCE(install_key, ''));

-- Identity immutability + monotonic revision + no DELETE/TRUNCATE:
-- only the value (value, bytes, revision, updated_by, updated_at) may
-- change, and the revision must advance by exactly one per write.

CREATE OR REPLACE FUNCTION extension_state_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'extension state is persistent (W026 extension runtime): DELETE is forbidden on table % — clear a key by overwriting its value with null',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'extension state is persistent (W026 extension runtime): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.extension_id <> OLD.extension_id
     OR NEW.install_key IS DISTINCT FROM OLD.install_key
     OR NEW.state_key <> OLD.state_key
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'extension state identity is immutable (W026 extension runtime): only the value (value, bytes, revision, updated_by, updated_at) may change on table %',
      TG_TABLE_NAME;
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'extension state revisions advance by exactly one per write (W026 extension runtime)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER extension_state_value_only_updates
  BEFORE UPDATE OR DELETE ON extension_state
  FOR EACH ROW EXECUTE FUNCTION extension_state_guard();

CREATE TRIGGER extension_state_persistent_truncate
  BEFORE TRUNCATE ON extension_state
  FOR EACH STATEMENT EXECUTE FUNCTION extension_state_guard();
