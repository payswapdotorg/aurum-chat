-- W035 · agents module — routing evidence on dispatch attempts.
--
-- Extends agent_execution_attempts (migrations/003, append-only evidence)
-- with the W035 routing outcome so each dispatch attempt reconstructs
-- WHICH tenant-registered runtime account served it and WHY the router
-- chose it (ARCHITECTURE.md §24: consequential execution is reconstructable
-- from evidence through outcome):
--  * runtime_account_id — the account the router chose for this dispatch;
--    NULL when the tenant has no account for the execution's runtime
--    family and the process transport served unrouted (the W021 path,
--    preserved). No cross-table foreign key, mirroring the module's other
--    linkage columns (agent_id, execution_id) — the accounts table is
--    mutable management configuration and evidence rows must never be
--    coupled to its lifecycle;
--  * routing — the FROZEN deterministic routing decision (jsonb object):
--    every tenant account considered with its machine-readable eligibility
--    reason, and the chosen target. NULL only on rows written before W035.
--
-- ALTER TABLE (not a fresh table) so existing deployments keep their
-- attempt history; new rows always write both fields (the unrouted path
-- writes a snapshot with routed = false and a NULL account id). The
-- appended CHECKs are defense in depth:
--  * routing must be a JSON object when present;
--  * an account-served dispatch always freezes its routing snapshot;
--  * a snapshot that claims routed = true always names the account.

ALTER TABLE agent_execution_attempts
  ADD COLUMN runtime_account_id uuid,
  ADD COLUMN routing jsonb,
  ADD CONSTRAINT agent_execution_attempts_routing_shape CHECK (
    routing IS NULL OR jsonb_typeof(routing) = 'object'
  ),
  ADD CONSTRAINT agent_execution_attempts_account_needs_routing CHECK (
    runtime_account_id IS NULL OR routing IS NOT NULL
  ),
  ADD CONSTRAINT agent_execution_attempts_routed_names_account CHECK (
    routing IS NULL OR (routing->>'routed') IS DISTINCT FROM 'true' OR runtime_account_id IS NOT NULL
  );

CREATE INDEX agent_execution_attempts_tenant_account_idx
  ON agent_execution_attempts (tenant_id, runtime_account_id);
