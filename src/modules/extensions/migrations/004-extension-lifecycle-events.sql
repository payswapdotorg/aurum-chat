-- W025 · extensions module — extension lifecycle events (the
-- append-only transition trail).
--
-- One IMMUTABLE row per APPLIED lifecycle transition. The trail keeps
-- "who moved this extension's lifecycle, when, from which state to
-- which, through which authority decision" reconstructable
-- (ARCHITECTURE.md §24):
--
--   * transition / from_state / to_state — the pure state machine's
--     verdict at apply time (lifecycle.ts; the service re-checks
--     legality inside the apply transaction, so a recorded event always
--     describes a legal transition);
--   * actor — the TenantContext principal whose call was applied;
--   * action_request_id — the actions module's approval-gate record
--     that authorized the transition (kind 'extension-deployment',
--     level EXECUTE). The gate's own evaluation snapshot and decision
--     trail live in the actions module (W009); this column is the link.
--
-- Storage-level append-only guarantee (the house pattern): the triggers
-- below reject UPDATE, DELETE and TRUNCATE outright.
--
-- Tenant scoping (ADR-0001): every row carries tenant_id; the composite
-- foreign key (extension_id, tenant_id) keeps an event tenant-consistent
-- with its extension.

CREATE TABLE extension_lifecycle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  extension_id uuid NOT NULL,
  transition text NOT NULL CHECK (transition IN ('activate', 'suspend', 'resume', 'deprecate')),
  from_state text NOT NULL CHECK (from_state IN (
    'REGISTERED', 'ACTIVE', 'SUSPENDED', 'DEPRECATED'
  )),
  to_state text NOT NULL CHECK (to_state IN (
    'REGISTERED', 'ACTIVE', 'SUSPENDED', 'DEPRECATED'
  )),
  actor text NOT NULL CHECK (actor <> ''),
  action_request_id uuid,
  occurred_at timestamptz NOT NULL,
  CONSTRAINT extension_lifecycle_events_id_tenant_unique UNIQUE (id, tenant_id),
  -- One applied transition per authority-gate request: re-invoking a
  -- transition whose gate request was already applied replays the
  -- original outcome instead of applying a second time (the actions
  -- module's first-write-wins replay semantics, storage-enforced).
  -- NULL action_request_id (a bypass write) never collides.
  CONSTRAINT extension_lifecycle_events_request_unique UNIQUE (action_request_id),
  CONSTRAINT extension_lifecycle_events_extension_tenant_fk
    FOREIGN KEY (extension_id, tenant_id) REFERENCES extensions (id, tenant_id),
  CONSTRAINT extension_lifecycle_events_direction_shape CHECK (
    (transition = 'activate' AND from_state = 'REGISTERED' AND to_state = 'ACTIVE')
    OR (transition = 'suspend' AND from_state = 'ACTIVE' AND to_state = 'SUSPENDED')
    OR (transition = 'resume' AND from_state = 'SUSPENDED' AND to_state = 'ACTIVE')
    OR (transition = 'deprecate' AND to_state = 'DEPRECATED' AND from_state IN ('REGISTERED', 'ACTIVE', 'SUSPENDED'))
  )
);

CREATE INDEX extension_lifecycle_events_tenant_extension_idx
  ON extension_lifecycle_events (tenant_id, extension_id, occurred_at DESC);

-- Storage-level append-only guarantee: nothing may UPDATE, DELETE or
-- TRUNCATE a lifecycle event — not even a future module bypassing the
-- service.

CREATE OR REPLACE FUNCTION extension_lifecycle_events_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'extension lifecycle events are append-only history (W025 extension contracts): % is forbidden on table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER extension_lifecycle_events_immutable
  BEFORE UPDATE OR DELETE ON extension_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION extension_lifecycle_events_reject_mutation();

CREATE TRIGGER extension_lifecycle_events_immutable_truncate
  BEFORE TRUNCATE ON extension_lifecycle_events
  FOR EACH STATEMENT EXECUTE FUNCTION extension_lifecycle_events_reject_mutation();
