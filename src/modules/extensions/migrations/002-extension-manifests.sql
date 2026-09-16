-- W025 · extensions module — versioned extension manifests.
--
-- One IMMUTABLE row per (tenant, extension key, version): the manifest
-- of record for that version. "Versioned extension manifests" means two
-- versionings at once:
--
--   * the extension's own release semver (`version`, with parsed
--     `version_major/minor/patch` columns so ordering is NUMERIC —
--     1.2.10 > 1.2.9 — never lexicographic text order). The service
--     enforces strictly increasing versions per extension key and the
--     UNIQUE constraint below is the storage-level floor under it;
--   * `manifest_schema_version` — the version of the manifest FORMAT
--     itself (see verification.ts MANIFEST_SCHEMA_VERSIONS), so the
--     contract can evolve without reinterpreting old rows.
--
-- The substantive declaration:
--   * requested_permissions — the closed permission ceiling (jsonb
--     array, canonical order; CHECK pins the closed vocabulary);
--   * capabilities          — the normalized capability declaration
--     (stateScope / uiSurfaces / schedules / eventSubscriptions /
--     externalParticipants / telemetry; CHECKs pin the closed state and
--     UI-surface vocabularies);
--   * quotas                — the declared resource ceilings;
--   * host_compatibility    — the declared host-runtime semver range
--     (§17 "compatibility").
--
-- The permission↔capability consistency rule — every declared
-- capability must be covered by its permission and no permission may be
-- requested without its justifying capability — is enforced at THREE
-- layers: registration validation (validation.ts over the shared pure
-- rules in manifest-rules.ts), the trigger below (defense in depth for
-- writes bypassing the service), and the deterministic
-- `permissions-consistency` verification check (verification.ts).
--
-- Manifests are immutable history the moment they are recorded: a
-- changed declaration is a NEW version, never an edit. The triggers
-- below forbid UPDATE, DELETE and TRUNCATE outright — not even a caller
-- bypassing the service can rewrite what a version declared. A
-- manifest's verification evidence lives in
-- extension_manifest_verifications (migrations/003), never on this row.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the composite
-- foreign key (extension_id, tenant_id) keeps a manifest tenant-
-- consistent with its extension.

CREATE TABLE extension_manifests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  extension_id uuid NOT NULL,
  extension_key text NOT NULL CHECK (
    extension_key ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
  ),
  version text NOT NULL CHECK (version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'),
  version_major integer NOT NULL CHECK (version_major >= 0),
  version_minor integer NOT NULL CHECK (version_minor >= 0),
  version_patch integer NOT NULL CHECK (version_patch >= 0),
  manifest_schema_version integer NOT NULL,
  display_name text NOT NULL CHECK (display_name <> '' AND char_length(display_name) <= 120),
  description text,
  requested_permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  capabilities jsonb NOT NULL,
  quotas jsonb NOT NULL,
  host_compatibility jsonb NOT NULL,
  registered_by text NOT NULL CHECK (registered_by <> ''),
  registered_at timestamptz NOT NULL,
  CONSTRAINT extension_manifests_tenant_key_version_unique
    UNIQUE (tenant_id, extension_key, version),
  CONSTRAINT extension_manifests_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT extension_manifests_extension_tenant_fk
    FOREIGN KEY (extension_id, tenant_id) REFERENCES extensions (id, tenant_id),
  CONSTRAINT extension_manifests_schema_version_shape CHECK (
    jsonb_typeof(requested_permissions) = 'array'
    AND jsonb_typeof(capabilities) = 'object'
    AND jsonb_typeof(quotas) = 'object'
    AND jsonb_typeof(host_compatibility) = 'object'
  ),
  CONSTRAINT extension_manifests_permissions_vocabulary CHECK (
    requested_permissions <@ '[
      "state:read","state:write","ui:render","schedule:run",
      "events:subscribe","external:participate","telemetry:emit"
    ]'::jsonb
  ),
  CONSTRAINT extension_manifests_state_scope_vocabulary CHECK (
    (capabilities->>'stateScope') IN ('none', 'tenant', 'install')
  ),
  CONSTRAINT extension_manifests_ui_surfaces_vocabulary CHECK (
    capabilities->'uiSurfaces' <@ '[
      "control-tower-panel","briefing-card","chat-panel","settings-form"
    ]'::jsonb
  ),
  CONSTRAINT extension_manifests_telemetry_shape CHECK (
    jsonb_typeof(capabilities->'telemetry') = 'boolean'
  ),
  CONSTRAINT extension_manifests_list_shapes CHECK (
    jsonb_typeof(capabilities->'uiSurfaces') = 'array'
    AND jsonb_typeof(capabilities->'schedules') = 'array'
    AND jsonb_typeof(capabilities->'eventSubscriptions') = 'array'
    AND jsonb_typeof(capabilities->'externalParticipants') = 'array'
  ),
  CONSTRAINT extension_manifests_quota_shapes CHECK (
    jsonb_typeof(quotas->'maxStateBytes') = 'number'
    AND jsonb_typeof(quotas->'maxScheduleInvocationsPerDay') = 'number'
    AND jsonb_typeof(quotas->'maxExternalCallsPerDay') = 'number'
  ),
  CONSTRAINT extension_manifests_host_compatibility_shape CHECK (
    (host_compatibility->>'minVersion') IS NOT NULL
  )
);

CREATE INDEX extension_manifests_tenant_extension_version_idx
  ON extension_manifests (tenant_id, extension_id, version_major DESC, version_minor DESC, version_patch DESC);
CREATE INDEX extension_manifests_tenant_registered_idx
  ON extension_manifests (tenant_id, registered_at DESC);

-- Permission ↔ capability consistency at the storage level (W025
-- security core). The rule set mirrors capabilityPermissionProblems in
-- manifest-rules.ts: a capability may never run undeclared, and a
-- permission may never be requested without its justifying capability.
-- Only the closed vocabularies above can reach this trigger, so the
-- membership tests are exact.

CREATE OR REPLACE FUNCTION extension_manifests_check_consistency() RETURNS trigger AS $$
DECLARE
  perms jsonb := NEW.requested_permissions;
  state_scope text := NEW.capabilities->>'stateScope';
  has_state boolean := state_scope IS NOT NULL AND state_scope <> 'none';
  has_ui boolean := jsonb_array_length(COALESCE(NEW.capabilities->'uiSurfaces', '[]'::jsonb)) > 0;
  has_schedules boolean := jsonb_array_length(COALESCE(NEW.capabilities->'schedules', '[]'::jsonb)) > 0;
  has_topics boolean := jsonb_array_length(COALESCE(NEW.capabilities->'eventSubscriptions', '[]'::jsonb)) > 0;
  has_external boolean := jsonb_array_length(COALESCE(NEW.capabilities->'externalParticipants', '[]'::jsonb)) > 0;
  has_telemetry boolean := COALESCE((NEW.capabilities->>'telemetry')::boolean, false);
BEGIN
  IF has_state AND NOT (perms ? 'state:read' AND perms ? 'state:write') THEN
    RAISE EXCEPTION 'manifest declares persistent state scope ''%'' but does not request both state:read and state:write (W025 extension contracts)', state_scope;
  END IF;
  IF NOT has_state AND (perms ? 'state:read' OR perms ? 'state:write') THEN
    RAISE EXCEPTION 'manifest requests state permissions without a state capability (stateScope must not be none) (W025 extension contracts)';
  END IF;
  IF has_ui AND NOT perms ? 'ui:render' THEN
    RAISE EXCEPTION 'manifest declares declarative UI surfaces but does not request ui:render (W025 extension contracts)';
  END IF;
  IF NOT has_ui AND perms ? 'ui:render' THEN
    RAISE EXCEPTION 'manifest requests ui:render without declaring any UI surface (W025 extension contracts)';
  END IF;
  IF has_schedules AND NOT perms ? 'schedule:run' THEN
    RAISE EXCEPTION 'manifest declares schedules but does not request schedule:run (W025 extension contracts)';
  END IF;
  IF NOT has_schedules AND perms ? 'schedule:run' THEN
    RAISE EXCEPTION 'manifest requests schedule:run without declaring any schedule (W025 extension contracts)';
  END IF;
  IF has_topics AND NOT perms ? 'events:subscribe' THEN
    RAISE EXCEPTION 'manifest declares event subscriptions but does not request events:subscribe (W025 extension contracts)';
  END IF;
  IF NOT has_topics AND perms ? 'events:subscribe' THEN
    RAISE EXCEPTION 'manifest requests events:subscribe without declaring any event subscription (W025 extension contracts)';
  END IF;
  IF has_external AND NOT perms ? 'external:participate' THEN
    RAISE EXCEPTION 'manifest declares external participants but does not request external:participate (W025 extension contracts)';
  END IF;
  IF NOT has_external AND perms ? 'external:participate' THEN
    RAISE EXCEPTION 'manifest requests external:participate without declaring any external participant (W025 extension contracts)';
  END IF;
  IF has_telemetry AND NOT perms ? 'telemetry:emit' THEN
    RAISE EXCEPTION 'manifest declares telemetry but does not request telemetry:emit (W025 extension contracts)';
  END IF;
  IF NOT has_telemetry AND perms ? 'telemetry:emit' THEN
    RAISE EXCEPTION 'manifest requests telemetry:emit without declaring telemetry (W025 extension contracts)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER extension_manifests_consistency_valid
  BEFORE INSERT OR UPDATE ON extension_manifests
  FOR EACH ROW EXECUTE FUNCTION extension_manifests_check_consistency();

-- Storage-level immutability: manifests are versioned history — no
-- UPDATE, no DELETE, no TRUNCATE, not even bypassing the service. A
-- changed declaration is a NEW version.

CREATE OR REPLACE FUNCTION extension_manifests_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'extension manifests are immutable versioned history (W025 extension contracts): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER extension_manifests_immutable
  BEFORE UPDATE OR DELETE ON extension_manifests
  FOR EACH ROW EXECUTE FUNCTION extension_manifests_reject_mutation();

CREATE TRIGGER extension_manifests_immutable_truncate
  BEFORE TRUNCATE ON extension_manifests
  FOR EACH STATEMENT EXECUTE FUNCTION extension_manifests_reject_mutation();
