-- W092 · vertical-kits module — the tenant-scoped installation
-- lifecycle of vertical extension starter kits.
--
-- WORK-ITEM-CATALOG W092: "Create reusable specialist extension/agent
-- starter kits and first deep integrations for system-of-record-heavy
-- industries without moving vertical semantics into Aurum core."
-- Acceptance: "each pack is installable, permission-scoped, versioned,
-- auditable and removable; core modules remain industry-independent."
--
-- WHAT LIVES HERE — and what deliberately does NOT:
--
--   * Kit DEFINITIONS are versioned platform-supplied DATA held in code
--     (kits.ts), validated pure against the contracts they compose
--     (extensions/marketplace/deep-actions/connection-broker/
--     integration-intelligence). There is deliberately NO kit catalog
--     table: definitions carry no tenant state, and this module's
--     tables below are ALL tenant-scoped (the architecture gate's rule
--     (d) — no arch-allowlist entry is needed or wanted).
--
--   * INSTALLATION state is a tenant's own: one row per (tenant, kit)
--     recording the installed version; one grant row per kit manifest
--     recording EXACTLY what installing granted and WHICH marketplace
--     ExtensionPackage the binding rode (the W028 discipline — the
--     platform catalog stops at INSTALLABLE; this module is the
--     tenant-side consumer of that hand-off point).
--
--   * The AUDIT TRAIL (vertical_kit_events) is append-only, with the
--     full WHAT frozen at append time: who installed/upgraded/removed,
--     when, from which version to which, with exactly which grants and
--     package bindings. Storage triggers forbid UPDATE/DELETE/TRUNCATE
--     — not even a future module bypassing the service can rewrite
--     kit history.
--
--   * RECIPE REFERENCES (vertical_kit_recipe_references) record which
--     kit version a deep-action plan was instantiated from, and are
--     immutable by design: after a kit is REMOVED the references stay
--     readable with their version and an honest removed flag — no
--     silent data loss (the W092 removal clause).
--
-- Removal semantics: `removeVerticalKit` DELETES the install row and
-- its grants (the kit's grants and package bindings are gone — that is
-- what removal means) while events and recipe references survive as
-- history. Upgrade semantics: the install row moves to the new version
-- and the grant set is REPLACED (the old grants are deleted, the new
-- grants recorded, and BOTH states live on in the append-only event
-- trail — no silent in-place mutation of granted permissions).

-- ---------------------------------------------------------------------------
-- Installs (one row per tenant × kit)
-- ---------------------------------------------------------------------------

CREATE TABLE vertical_kit_installs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  kit_key text NOT NULL CHECK (
    kit_key ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
  ),
  kit_version text NOT NULL CHECK (
    kit_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
  ),
  version_major integer NOT NULL CHECK (version_major >= 0),
  version_minor integer NOT NULL CHECK (version_minor >= 0),
  version_patch integer NOT NULL CHECK (version_patch >= 0),
  installed_by text NOT NULL CHECK (installed_by <> ''),
  installed_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  -- One current install per (tenant, kit): the floor under the
  -- service's own idempotency and upgrade discipline.
  CONSTRAINT vertical_kit_installs_tenant_kit_unique
    UNIQUE (tenant_id, kit_key)
);

CREATE INDEX vertical_kit_installs_tenant_idx
  ON vertical_kit_installs (tenant_id, updated_at DESC);

-- ---------------------------------------------------------------------------
-- Grants (what installing granted, per manifest, with the package
-- binding the install rode)
-- ---------------------------------------------------------------------------

CREATE TABLE vertical_kit_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  install_id uuid NOT NULL,
  kit_key text NOT NULL CHECK (
    kit_key ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
  ),
  extension_key text NOT NULL CHECK (
    extension_key ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
  ),
  extension_version text NOT NULL CHECK (
    extension_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
  ),
  -- The marketplace ExtensionPackage the binding rode (opaque forward
  -- reference — no cross-module FK, the marketplace's own discipline).
  package_id uuid NOT NULL,
  package_key text NOT NULL CHECK (
    package_key ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
  ),
  -- EXACTLY what installing granted: the closed extension permission
  -- vocabulary, canonical order, frozen at grant time (the shape floor
  -- is structure only; the service enforces the vocabulary).
  granted_permissions jsonb NOT NULL CHECK (
    jsonb_typeof(granted_permissions) = 'array'
  ),
  deployed_at timestamptz NOT NULL,
  CONSTRAINT vertical_kit_grants_install_fk
    FOREIGN KEY (install_id) REFERENCES vertical_kit_installs (id),
  -- One grant per (install, extension): a kit installs each of its
  -- manifests exactly once per version.
  CONSTRAINT vertical_kit_grants_install_extension_unique
    UNIQUE (tenant_id, install_id, extension_key)
);

CREATE INDEX vertical_kit_grants_install_idx
  ON vertical_kit_grants (install_id);
CREATE INDEX vertical_kit_grants_tenant_idx
  ON vertical_kit_grants (tenant_id, kit_key);

-- ---------------------------------------------------------------------------
-- Lifecycle events (append-only audit — install/upgrade/remove)
-- ---------------------------------------------------------------------------

CREATE TABLE vertical_kit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  kit_key text NOT NULL CHECK (
    kit_key ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
  ),
  event_type text NOT NULL CHECK (event_type IN ('install', 'upgrade', 'remove')),
  from_version text
    CHECK (from_version IS NULL OR from_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'),
  to_version text
    CHECK (to_version IS NULL OR to_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'),
  actor text NOT NULL CHECK (actor <> ''),
  occurred_at timestamptz NOT NULL,
  -- The WHAT, frozen at append time: the exact grants + package
  -- bindings this event installed/upgraded/removed.
  detail jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object'),
  -- Direction shape: an install has no from-version, a remove has no
  -- to-version, an upgrade has both and must strictly increase.
  CONSTRAINT vertical_kit_events_direction_shape CHECK (
    (event_type = 'install' AND from_version IS NULL AND to_version IS NOT NULL)
    OR (event_type = 'remove' AND from_version IS NOT NULL AND to_version IS NULL)
    OR (event_type = 'upgrade' AND from_version IS NOT NULL AND to_version IS NOT NULL)
  )
);

CREATE INDEX vertical_kit_events_tenant_idx
  ON vertical_kit_events (tenant_id, occurred_at DESC, id DESC);
CREATE INDEX vertical_kit_events_kit_idx
  ON vertical_kit_events (tenant_id, kit_key, occurred_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- Recipe references (immutable — the honest removal trail)
-- ---------------------------------------------------------------------------

CREATE TABLE vertical_kit_recipe_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  kit_key text NOT NULL CHECK (
    kit_key ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
  ),
  kit_version text NOT NULL CHECK (
    kit_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
  ),
  recipe_key text NOT NULL CHECK (
    recipe_key ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
  ),
  -- Opaque caller reference (e.g. the deep-action task id).
  reference text NOT NULL CHECK (reference <> '' AND char_length(reference) <= 200),
  recorded_by text NOT NULL CHECK (recorded_by <> ''),
  recorded_at timestamptz NOT NULL,
  -- One reference per (tenant, kit, recipe, reference): recording the
  -- same use twice replays, it never duplicates.
  CONSTRAINT vertical_kit_recipe_references_dedupe_unique
    UNIQUE (tenant_id, kit_key, recipe_key, reference)
);

CREATE INDEX vertical_kit_recipe_references_tenant_idx
  ON vertical_kit_recipe_references (tenant_id, recorded_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- Storage-level guarantees (the W084/W095 house discipline: triggers
-- enforce what the service promises, even for bypassing writes)
-- ---------------------------------------------------------------------------

-- Kit history is append-only: no UPDATE, no DELETE, no TRUNCATE of a
-- lifecycle event — audit evidence is history the moment it lands.
CREATE OR REPLACE FUNCTION vertical_kits_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'vertical kit lifecycle evidence is append-only (W092 vertical starter kits): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER vertical_kit_events_immutable
  BEFORE UPDATE OR DELETE ON vertical_kit_events
  FOR EACH ROW EXECUTE FUNCTION vertical_kits_reject_mutation();

CREATE TRIGGER vertical_kit_events_immutable_truncate
  BEFORE TRUNCATE ON vertical_kit_events
  FOR EACH STATEMENT EXECUTE FUNCTION vertical_kits_reject_mutation();

-- Recipe references are immutable once recorded: after a kit is
-- removed, the references (the honest "this plan came from kit vX"
-- trail) must stay exactly as recorded — removal may never silently
-- rewrite or drop them.
CREATE TRIGGER vertical_kit_recipe_references_immutable
  BEFORE UPDATE OR DELETE ON vertical_kit_recipe_references
  FOR EACH ROW EXECUTE FUNCTION vertical_kits_reject_mutation();

CREATE TRIGGER vertical_kit_recipe_references_immutable_truncate
  BEFORE TRUNCATE ON vertical_kit_recipe_references
  FOR EACH STATEMENT EXECUTE FUNCTION vertical_kits_reject_mutation();

-- An install row's identity and installed version are the service's
-- discipline (idempotent install, explicit upgrade): a grant row may
-- never drift away from the install it belongs to.
CREATE OR REPLACE FUNCTION vertical_kit_grants_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Grants are removed by upgrade (replacement) and by removal —
    -- both service operations; allowed at the storage floor.
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.id <> OLD.id
    OR NEW.tenant_id <> OLD.tenant_id
    OR NEW.install_id <> OLD.install_id
    OR NEW.kit_key <> OLD.kit_key
    OR NEW.extension_key <> OLD.extension_key
    OR NEW.extension_version <> OLD.extension_version
    OR NEW.package_id <> OLD.package_id
    OR NEW.package_key <> OLD.package_key
    OR NEW.granted_permissions <> OLD.granted_permissions
    OR NEW.deployed_at <> OLD.deployed_at
  ) THEN
    RAISE EXCEPTION 'vertical kit grants are immutable once recorded (W092 vertical starter kits): replacement is delete-and-reinsert through the service on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER vertical_kit_grants_immutable
  BEFORE UPDATE ON vertical_kit_grants
  FOR EACH ROW EXECUTE FUNCTION vertical_kit_grants_guard();
