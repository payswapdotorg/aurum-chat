-- W009 · actions module — approval decisions (the append-only trail).
--
-- One row per decision on an action request:
--   * decided_by = 'policy'    — recorded by authorizeAction itself when
--     the matrix auto-allows (decision 'approve') or forbids
--     (decision 'reject') a request; principal_id is NULL;
--   * decided_by = 'principal' — recorded by decideApproval when an
--     authorized human resolves a pending request; principal_id is the
--     deciding TenantContext principal (the requester can never decide
--     its own request — separation of duties, enforced in the service).
--
-- Together with the request's frozen evaluation snapshot this keeps the
-- §24 chain reconstructable: policy → request → decision(s). A pending
-- request has NO decision row (it waits for one); an auto-decided
-- request has exactly one policy decision; a human-decided request has
-- exactly one principal decision. First decision wins — there is no
-- operation (and no storage path) to un-decide, revoke or overwrite.
--
-- Storage-level append-only guarantee (the house pattern — events,
-- observations, temporal revisions): the triggers below reject UPDATE,
-- DELETE and TRUNCATE outright — not even a future module bypassing the
-- service can rewrite the approval trail.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id, and the
-- composite foreign key (request_id, tenant_id) keeps a decision
-- tenant-consistent with its request — a decision can never reference
-- another tenant's request, even bypassing the service.

CREATE TABLE action_approval_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approve', 'reject')),
  decided_by text NOT NULL CHECK (decided_by IN ('policy', 'principal')),
  principal_id text,
  note text,
  decided_at timestamptz NOT NULL,
  CONSTRAINT action_approval_decisions_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT action_approval_decisions_request_tenant_fk
    FOREIGN KEY (request_id, tenant_id) REFERENCES action_requests (id, tenant_id),
  CONSTRAINT action_approval_decisions_decider_shape CHECK (
    (decided_by = 'policy' AND principal_id IS NULL)
    OR (decided_by = 'principal' AND principal_id IS NOT NULL)
  )
);

CREATE INDEX action_approval_decisions_tenant_request_idx
  ON action_approval_decisions (tenant_id, request_id);
CREATE INDEX action_approval_decisions_tenant_decided_idx
  ON action_approval_decisions (tenant_id, decided_at DESC);

-- Storage-level append-only guarantee: nothing may UPDATE, DELETE or
-- TRUNCATE an approval decision — not even a future module bypassing the
-- service. The message deliberately names no row id so the same function
-- serves the row-level and the statement-level trigger.

CREATE OR REPLACE FUNCTION action_approval_decisions_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'approval decisions are append-only (W009 action authority): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER action_approval_decisions_immutable
  BEFORE UPDATE OR DELETE ON action_approval_decisions
  FOR EACH ROW EXECUTE FUNCTION action_approval_decisions_reject_mutation();

CREATE TRIGGER action_approval_decisions_immutable_truncate
  BEFORE TRUNCATE ON action_approval_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION action_approval_decisions_reject_mutation();
