-- W009 · actions module — action requests (the approval-gate records).
--
-- One row per action brought to the authority gate. The SUBSTANTIVE
-- request (kind, level, payload, requester, idempotency key, evaluation)
-- is immutable history the moment it is recorded; only the DECISION
-- STATE (status, decided_at, updated_at) may ever move, and only
-- forward: pending → approved/rejected, first decision wins. A changed
-- proposal is a NEW request — the trail of what was proposed, how the
-- matrix routed it and who decided it stays reconstructable
-- (ARCHITECTURE.md §24).
--
-- Columns:
--   * action_kind / authority_level — what was requested, at which of
--     the six levels (§20 vocabulary; the kind namespace is open, the
--     level namespace is closed);
--   * payload / justification       — the proposal's content and the
--     requester's stated reason (plain JSON / text);
--   * requested_by / requested_at   — the acting TenantContext
--     principal (opaque string — the same precedent the observations
--     and freshness modules apply) and the service-clock commit time;
--   * outcome / resolved_via / policy_snapshot — the DETERMINISTIC
--     evaluation, frozen at gate time: the matrix outcome
--     (allowed/approval_required/forbidden), which policy row decided
--     (kind / tenant-default / built-in) and its full snapshot (null
--     when the built-in floor decided). Later policy edits never
--     rewrite what gated a recorded request;
--   * status / decided_at           — the lifecycle state and when the
--     deciding decision landed (CHECK: decided_at is null exactly while
--     pending);
--   * idempotency_key               — emitter-supplied dedupe key,
--     unique per tenant (NULL keys never collide — SQL UNIQUE treats
--     NULLs as distinct). A recorded key replays the original request
--     on retry: first write wins, history is never rewritten.
--
-- Storage-level guarantees (not just service discipline):
--   * the guard trigger below rejects DELETE outright and rejects any
--     UPDATE that touches a substantive field — only the decision state
--     may move, even for a caller bypassing the service;
--   * the decision-state CHECK keeps status and decided_at consistent.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; UNIQUE
-- (id, tenant_id) is the tenant-consistent target for the approval
-- decisions of migrations/003.

CREATE TABLE action_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  action_kind text NOT NULL CHECK (action_kind ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  authority_level text NOT NULL CHECK (authority_level IN (
    'OBSERVE', 'ANALYZE', 'RECOMMEND', 'ASK', 'PROPOSE', 'EXECUTE'
  )),
  payload jsonb NOT NULL,
  justification text,
  requested_by text NOT NULL CHECK (requested_by <> ''),
  requested_at timestamptz NOT NULL,
  idempotency_key text CHECK (
    idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$'
  ),
  outcome text NOT NULL CHECK (outcome IN ('allowed', 'approval_required', 'forbidden')),
  resolved_via text NOT NULL CHECK (resolved_via IN ('kind', 'tenant-default', 'built-in')),
  policy_snapshot jsonb,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_at timestamptz,
  updated_at timestamptz NOT NULL,
  CONSTRAINT action_requests_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT action_requests_idempotency_tenant_unique UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT action_requests_decision_state_shape CHECK (
    (status = 'pending' AND decided_at IS NULL)
    OR (status <> 'pending' AND decided_at IS NOT NULL)
  )
);

CREATE INDEX action_requests_tenant_requested_idx
  ON action_requests (tenant_id, requested_at DESC);
CREATE INDEX action_requests_tenant_status_idx
  ON action_requests (tenant_id, status);
CREATE INDEX action_requests_tenant_kind_idx
  ON action_requests (tenant_id, action_kind);

-- Storage-level immutability of the substantive request (W009): DELETE
-- is always forbidden, and an UPDATE may move ONLY the decision state
-- (status, decided_at, updated_at). The message deliberately names no
-- row id so the same function serves the row-level and the
-- statement-level trigger.

CREATE OR REPLACE FUNCTION action_requests_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'action requests are immutable history (W009 action authority): DELETE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'action requests are immutable history (W009 action authority): TRUNCATE is forbidden on table %',
      TG_TABLE_NAME;
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.action_kind <> OLD.action_kind
     OR NEW.authority_level <> OLD.authority_level
     OR NEW.payload <> OLD.payload
     OR NEW.justification IS DISTINCT FROM OLD.justification
     OR NEW.requested_by <> OLD.requested_by
     OR NEW.requested_at <> OLD.requested_at
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.outcome <> OLD.outcome
     OR NEW.resolved_via <> OLD.resolved_via
     OR NEW.policy_snapshot IS DISTINCT FROM OLD.policy_snapshot THEN
    RAISE EXCEPTION 'action requests are immutable history (W009 action authority): only the decision state (status, decided_at, updated_at) may change on table %',
      TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER action_requests_state_only_updates
  BEFORE UPDATE OR DELETE ON action_requests
  FOR EACH ROW EXECUTE FUNCTION action_requests_guard();

CREATE TRIGGER action_requests_immutable_truncate
  BEFORE TRUNCATE ON action_requests
  FOR EACH STATEMENT EXECUTE FUNCTION action_requests_guard();
