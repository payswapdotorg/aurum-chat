-- W083 · capability-grants module — progressive capability grants over
-- connected systems: the safe read-only start, the ask-later write/action
-- authority path (routed through the actions module's W009 gate), and the
-- invocation gate whose denials stop the write while carrying exactly what
-- should be asked for.
--
-- Every table carries tenant_id (ADR-0001; scripts/check-architecture.ts
-- rule d). Nothing provider-named appears anywhere: a grant's scope is
-- expressed in the W081 inventory's capability keys (plain-language
-- "what the organization can do" descriptors like 'write.customer-records'),
-- and the only provider-adjacent value is the OPAQUE broker-connection id
-- inherited from the connection-broker's provider-neutral contract.
-- Credential VALUES never reach these tables at all (the W082 discipline:
-- the connection row, not this module, holds the opaque credentialRef).
--
-- State model (the work item's acceptance, mirrored by the shapes):
--   * capability_access          — the per-connection read-only ENVELOPE:
--                                  what the connection confers on day one
--                                  (every current READ capability) and what
--                                  stays WRITE-GATED until a concrete task
--                                  asks. One row per (tenant, connection).
--   * capability_grant_requests  — the ASK: the exact missing scope, the
--                                  human-readable reason (why the permission
--                                  is necessary) and the frozen task context,
--                                  gated through the actions module (W009:
--                                  action kind 'capability-grant', authority
--                                  level EXECUTE — an authority EXPANSION is
--                                  always a consequential action).
--   * capability_grants          — the AUTHORITY records: one grant per
--                                  approved request, scoped to exactly the
--                                  approved capability keys, revocable with
--                                  a full trail.
--   * capability_grant_events   — append-only lifecycle audit.
--   * capability_invocations    — append-only gate ledger: every capability
--                                  invocation (allowed or denied) with its
--                                  basis, the grant that authorized it and,
--                                  on denial, the human-readable reason plus
--                                  the exact requested scope.
--
-- The grants/requests tables are updatable management/authorization state
-- (they legitimately move: requests get decided, grants get revoked — the
-- W081 precedent), while the events and invocations tables are strictly
-- append-only evidence (storage-level triggers below).

-- ---------------------------------------------------------------------------
-- Access — the read-only envelope of one broker connection
-- ---------------------------------------------------------------------------

CREATE TABLE capability_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  -- The connection-broker connection this envelope governs (opaque id;
  -- validated through the connection-broker contract at establish time —
  -- a soft reference, the events/observations precedent: no cross-module
  -- foreign key).
  connection_id uuid NOT NULL,
  -- The Tool & System Inventory entry (W081) the connection realizes: the
  -- capability surface this envelope partitions. Frozen at establish time
  -- (re-establish refreshes it); invocations validate keys against the
  -- LIVE surface through the W081 contract.
  system_id uuid NOT NULL,
  system_key text NOT NULL,
  system_display_name text NOT NULL,
  -- The partition of the system's capability surface at establish time:
  -- every READ capability (conferred by the read-only floor) and every
  -- WRITE capability (gated behind grants). Frozen descriptors
  -- {key, label, dataCategories}.
  read_capabilities jsonb NOT NULL CHECK (
    jsonb_typeof(read_capabilities) = 'array'
    AND jsonb_array_length(read_capabilities) <= 64
  ),
  write_capabilities jsonb NOT NULL CHECK (
    jsonb_typeof(write_capabilities) = 'array'
    AND jsonb_array_length(write_capabilities) <= 64
  ),
  established_by text NOT NULL,
  established_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT capability_access_connection_unique UNIQUE (tenant_id, connection_id),
  CONSTRAINT capability_access_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT capability_access_system_key_shape
    CHECK (char_length(system_key) BETWEEN 3 AND 312),
  CONSTRAINT capability_access_display_name_shape
    CHECK (char_length(system_display_name) BETWEEN 1 AND 200)
);

CREATE INDEX capability_access_tenant_established_idx
  ON capability_access (tenant_id, established_at DESC);
CREATE INDEX capability_access_tenant_system_idx
  ON capability_access (tenant_id, system_id);

-- ---------------------------------------------------------------------------
-- Grant requests — the ask (human-readable reason + exact requested scope)
-- ---------------------------------------------------------------------------

CREATE TABLE capability_grant_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  access_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  system_id uuid NOT NULL,
  -- The actions module's ActionRequest id (the W009 gate record; soft
  -- reference). The action request is created BEFORE this row: a request
  -- may never sit in a gated state without its gate record existing (the
  -- W081 batch discipline).
  action_request_id uuid NOT NULL,
  -- The EXACT requested scope: only the capability keys that were MISSING
  -- (never re-asking what an active grant already covers) — the work item's
  -- "later retry can request only the missing capability".
  capability_keys jsonb NOT NULL CHECK (
    jsonb_typeof(capability_keys) = 'array'
    AND jsonb_array_length(capability_keys) BETWEEN 1 AND 32
  ),
  -- Frozen scope detail: what the approver was shown ({key, label,
  -- dataCategories} per requested key).
  requested_scope jsonb NOT NULL CHECK (
    jsonb_typeof(requested_scope) = 'array'
    AND jsonb_array_length(requested_scope) BETWEEN 1 AND 32
  ),
  -- The human-readable WHY (deterministic; reason.ts) — why this permission
  -- is necessary for the concrete task.
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 2000),
  -- The concrete task the ask serves (frozen): the write/action authority
  -- exists only FOR a task.
  task_context jsonb NOT NULL CHECK (jsonb_typeof(task_context) = 'object'),
  status text NOT NULL DEFAULT 'pending_approval' CHECK (
    status IN ('pending_approval', 'approved', 'rejected')
  ),
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL,
  decided_at timestamptz,
  updated_at timestamptz NOT NULL,
  CONSTRAINT capability_grant_requests_id_tenant_unique UNIQUE (id, tenant_id),
  -- Only a pending request is undecided.
  CONSTRAINT capability_grant_requests_decided_shape CHECK (
    status = 'pending_approval' OR decided_at IS NOT NULL
  ),
  CONSTRAINT capability_grant_requests_pending_undecided CHECK (
    status <> 'pending_approval' OR decided_at IS NULL
  )
);

CREATE INDEX capability_grant_requests_tenant_status_idx
  ON capability_grant_requests (tenant_id, status, requested_at DESC);
CREATE INDEX capability_grant_requests_tenant_connection_idx
  ON capability_grant_requests (tenant_id, connection_id, requested_at DESC);
-- One OPEN ask per (tenant, connection): a pending request for overlapping
-- scope must be decided before a new one is created (the service refuses
-- duplicates; the index is the storage-level backstop).
CREATE UNIQUE INDEX capability_grant_requests_open_unique
  ON capability_grant_requests (tenant_id, connection_id)
  WHERE status = 'pending_approval';

-- ---------------------------------------------------------------------------
-- Grants — the scoped authority records (visible, scoped, revocable)
-- ---------------------------------------------------------------------------

CREATE TABLE capability_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  access_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  system_id uuid NOT NULL,
  -- The EXACT scope: the capability keys this grant confers (write-mode
  -- only; read comes with the connection's read-only floor).
  capability_keys jsonb NOT NULL CHECK (
    jsonb_typeof(capability_keys) = 'array'
    AND jsonb_array_length(capability_keys) BETWEEN 1 AND 32
  ),
  -- Frozen scope detail (what the approver approved).
  scope_detail jsonb NOT NULL CHECK (
    jsonb_typeof(scope_detail) = 'array'
    AND jsonb_array_length(scope_detail) BETWEEN 1 AND 32
  ),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  -- The approved grant request that authorized this grant (the W009
  -- decision chain: grant → request → action request → decisions).
  granted_via uuid NOT NULL,
  -- 'policy' when the tenant's authority matrix auto-allowed the ask; the
  -- approving principal otherwise.
  granted_by text NOT NULL,
  granted_at timestamptz NOT NULL,
  revoked_by text,
  revoked_at timestamptz,
  revocation_note text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT capability_grants_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT capability_grants_note_shape
    CHECK (revocation_note IS NULL OR char_length(revocation_note) BETWEEN 1 AND 2000),
  -- A revoked grant keeps its revocation trail together or not at all.
  CONSTRAINT capability_grants_revocation_shape CHECK (
    status = 'active' OR (revoked_by IS NOT NULL AND revoked_at IS NOT NULL)
  ),
  CONSTRAINT capability_grants_active_has_no_revocation CHECK (
    status = 'revoked' OR (revoked_by IS NULL AND revoked_at IS NULL)
  )
);

CREATE INDEX capability_grants_tenant_connection_idx
  ON capability_grants (tenant_id, connection_id, status, granted_at DESC);
CREATE INDEX capability_grants_tenant_status_idx
  ON capability_grants (tenant_id, status, granted_at DESC);

-- ---------------------------------------------------------------------------
-- Grant events — append-only lifecycle audit
-- ---------------------------------------------------------------------------

CREATE TABLE capability_grant_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  access_id uuid NOT NULL,
  event text NOT NULL CHECK (event IN (
    'access-established',
    'authority-requested',
    'authority-granted',
    'authority-rejected',
    'authority-revoked'
  )),
  detail text
    CHECK (detail IS NULL OR char_length(detail) BETWEEN 1 AND 500),
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL,
  CONSTRAINT capability_grant_events_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX capability_grant_events_access_idx
  ON capability_grant_events (tenant_id, access_id, recorded_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- Invocations — the append-only gate ledger
-- ---------------------------------------------------------------------------

CREATE TABLE capability_invocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  access_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  system_id uuid NOT NULL,
  capability_key text NOT NULL
    CHECK (char_length(capability_key) BETWEEN 3 AND 128),
  capability_mode text NOT NULL CHECK (capability_mode IN ('read', 'write')),
  outcome text NOT NULL CHECK (outcome IN ('allowed', 'denied')),
  -- Why the gate decided what it decided:
  --   read-only-floor  — a read capability, conferred by the connection;
  --   capability-grant — a write capability, covered by an active grant;
  --   grant-missing    — a write capability with no active grant (denied).
  basis text NOT NULL CHECK (
    basis IN ('read-only-floor', 'capability-grant', 'grant-missing')
  ),
  -- The grant that authorized an allowed write invocation (null otherwise).
  grant_id uuid,
  -- On denial: the human-readable reason plus the exact requested scope.
  -- Null on allowed invocations.
  denial jsonb CHECK (denial IS NULL OR jsonb_typeof(denial) = 'object'),
  -- The concrete task this invocation served (frozen).
  task_context jsonb NOT NULL CHECK (jsonb_typeof(task_context) = 'object'),
  invoked_by text NOT NULL,
  invoked_at timestamptz NOT NULL,
  CONSTRAINT capability_invocations_id_tenant_unique UNIQUE (id, tenant_id),
  -- Only an allowed write invocation rides a grant; only a denied one
  -- carries a denial.
  CONSTRAINT capability_invocations_granted_shape CHECK (
    (outcome = 'allowed' AND basis = 'capability-grant')
    OR (outcome = 'allowed' AND basis = 'read-only-floor' AND grant_id IS NULL)
    OR (outcome = 'denied' AND basis = 'grant-missing' AND grant_id IS NULL AND denial IS NOT NULL)
  )
);

CREATE INDEX capability_invocations_tenant_connection_idx
  ON capability_invocations (tenant_id, connection_id, invoked_at DESC, id DESC);
CREATE INDEX capability_invocations_tenant_outcome_idx
  ON capability_invocations (tenant_id, outcome, invoked_at DESC, id DESC);
CREATE INDEX capability_invocations_tenant_capability_idx
  ON capability_invocations (tenant_id, capability_key, invoked_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- Storage-level guarantees
-- ---------------------------------------------------------------------------

-- capability_grant_events / capability_invocations: strictly append-only
-- audit and evidence — no UPDATE, DELETE or TRUNCATE, ever.

CREATE OR REPLACE FUNCTION capability_append_only_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (W083 capability-grants audit/evidence): % is forbidden on table %',
    TG_TABLE_NAME, TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER capability_grant_events_immutable
  BEFORE UPDATE OR DELETE ON capability_grant_events
  FOR EACH ROW EXECUTE FUNCTION capability_append_only_reject_mutation();
CREATE TRIGGER capability_grant_events_immutable_truncate
  BEFORE TRUNCATE ON capability_grant_events
  FOR EACH STATEMENT EXECUTE FUNCTION capability_append_only_reject_mutation();

CREATE TRIGGER capability_invocations_immutable
  BEFORE UPDATE OR DELETE ON capability_invocations
  FOR EACH ROW EXECUTE FUNCTION capability_append_only_reject_mutation();
CREATE TRIGGER capability_invocations_immutable_truncate
  BEFORE TRUNCATE ON capability_invocations
  FOR EACH STATEMENT EXECUTE FUNCTION capability_append_only_reject_mutation();
