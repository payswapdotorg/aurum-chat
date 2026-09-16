-- W027 · extensions module — extension builds (the design/build/verify/
-- deploy workflow sessions).
--
-- One row per builder workflow session: a fixed TARGET (extension key +
-- version — the requester's declared scope; the building agent can never
-- choose the extension's identity), the free-form BRIEF of what the
-- extension should be, and the tenant-registered AGENT that performs the
-- design and build phases through the agents module's isolated execution
-- environment (the W021 Agent Gateway — DAG edge W021 + W026 → W027).
--
-- The phase machine (mirrored by the phase CHECK; see builder.ts for the
-- full map):
--
--   designing → building → built → verified → deploying → deployed
--        ↘ any live phase → failed | cancelled (terminal)
--
--   * `designing` / `building` — an agent execution is live (the linked
--     agent_executions id is an OPAQUE forward reference: no cross-module
--     foreign key, the learning module's subject-tie precedent — the
--     agents module owns that table and its lifecycle);
--   * `built` — the built declaration passed the SAME registration
--     validation a human registration passes and is registered as an
--     immutable manifest version (manifest_id, a real same-module FK);
--   * `verified` — a verification run over that version passed;
--   * `deploying` — the deployment (and, for a fresh extension, its
--     activation) sits at the 'extension-deployment' EXECUTE gate;
--   * `deployed` — the runtime applied the deployment (deployment_id —
--     deliberately NOT a foreign key: deployment history is append-only
--     evidence whose TRUNCATE-guard contract predates this table, and a
--     dependent FK would shadow that storage-level guarantee; the link
--     is written only from this module's own tenant-scoped deploy
--     result, the learning module's opaque-reference discipline).
--
-- failure_code / failure_detail record HOW a build died — evidence, not
-- control flow (§24): agent execution failures, artifact validation
-- rejections, registration/verification/gate rejections and cancellation
-- all land here (the closed vocabulary is CHECKed). The failure detail
-- is bounded by the service (512 chars).
--
-- The id is minted by the SERVICE (not the database): the workflow's
-- idempotency keys (agent executions, activation, deployment) are pure
-- functions of the build id, so it must exist before the first gated
-- side effect. A crash between the insert and a side effect self-heals:
-- the deterministic keys replay the recorded outcomes (lock 36).
--
-- idempotency_key is caller-supplied and unique per tenant (NULL keys
-- never collide — SQL UNIQUE treats NULLs as distinct); a recorded key
-- replays the original session: first write wins.
--
-- Storage-level guarantees (the agent_executions precedent): DELETE and
-- TRUNCATE are always forbidden, and an UPDATE may touch ONLY the live
-- state (phase, the forward links, failure fields, updated_at) — the
-- target, brief, agent and request provenance are history the moment
-- they are recorded, even for a caller bypassing the service.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; cross-tenant
-- access is indistinguishable from a missing record at the service
-- layer, and the composite FKs keep the linked manifest and deployment
-- tenant-consistent.

CREATE TABLE extension_builds (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  extension_key text NOT NULL CHECK (
    extension_key ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
  ),
  version text NOT NULL CHECK (
    version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
  ),
  brief text NOT NULL CHECK (brief <> ''),
  agent_id uuid NOT NULL,
  phase text NOT NULL CHECK (phase IN (
    'designing', 'building', 'built', 'verified', 'deploying',
    'deployed', 'failed', 'cancelled'
  )),
  design_execution_id uuid,
  build_execution_id uuid,
  manifest_id uuid,
  deployment_id uuid,
  failure_code text CHECK (failure_code IS NULL OR failure_code IN (
    'design_execution_failed',
    'design_execution_refused',
    'design_execution_cancelled',
    'design_artifact_invalid',
    'build_execution_failed',
    'build_execution_refused',
    'build_execution_cancelled',
    'build_artifact_invalid',
    'version_conflict',
    'version_not_monotonic',
    'extension_deprecated',
    'verification_failed',
    'activation_rejected',
    'activation_failed',
    'deployment_rejected',
    'deployment_failed',
    'cancelled'
  )),
  failure_detail text CHECK (
    failure_detail IS NULL OR char_length(failure_detail) <= 512
  ),
  idempotency_key text CHECK (
    idempotency_key IS NULL
    OR idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$'
  ),
  requested_by text NOT NULL CHECK (requested_by <> ''),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT extension_builds_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT extension_builds_idempotency_tenant_unique UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT extension_builds_manifest_tenant_fk
    FOREIGN KEY (manifest_id, tenant_id) REFERENCES extension_manifests (id, tenant_id),
  CONSTRAINT extension_builds_shape CHECK (
    (phase IN ('deployed', 'failed', 'cancelled'))
    OR (failure_code IS NULL AND failure_detail IS NULL)
  ),
  CONSTRAINT extension_builds_cancelled_shape CHECK (
    phase <> 'cancelled' OR (failure_code = 'cancelled' AND failure_detail IS NOT NULL)
  ),
  CONSTRAINT extension_builds_failed_shape CHECK (
    phase <> 'failed' OR (failure_code IS NOT NULL AND failure_code <> 'cancelled')
  ),
  CONSTRAINT extension_builds_built_links CHECK (
    phase NOT IN ('built', 'verified', 'deploying', 'deployed')
    OR manifest_id IS NOT NULL
  ),
  CONSTRAINT extension_builds_deployed_link CHECK (
    phase <> 'deployed' OR (manifest_id IS NOT NULL AND deployment_id IS NOT NULL)
  )
);

CREATE INDEX extension_builds_tenant_created_idx
  ON extension_builds (tenant_id, created_at DESC);
CREATE INDEX extension_builds_tenant_extension_idx
  ON extension_builds (tenant_id, extension_key, created_at DESC);
CREATE INDEX extension_builds_tenant_phase_idx
  ON extension_builds (tenant_id, phase);

-- Storage-level immutability of the submission (the agent_executions
-- discipline): the workflow's target, agent and provenance are history;
-- only the live state may move. The message deliberately names no row id
-- so the same function serves the row-level and the statement-level
-- trigger.

CREATE OR REPLACE FUNCTION extension_builds_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'extension builds are workflow history (W027 extension builder): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'extension builds are workflow history (W027 extension builder): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.extension_key <> OLD.extension_key
     OR NEW.version <> OLD.version
     OR NEW.brief <> OLD.brief
     OR NEW.agent_id <> OLD.agent_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.requested_by <> OLD.requested_by
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'extension builds are workflow history (W027 extension builder): only the live state (phase, design_execution_id, build_execution_id, manifest_id, deployment_id, failure_code, failure_detail, updated_at) may change on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER extension_builds_state_only_updates
  BEFORE UPDATE OR DELETE ON extension_builds
  FOR EACH ROW EXECUTE FUNCTION extension_builds_guard();

CREATE TRIGGER extension_builds_immutable_truncate
  BEFORE TRUNCATE ON extension_builds
  FOR EACH STATEMENT EXECUTE FUNCTION extension_builds_guard();
