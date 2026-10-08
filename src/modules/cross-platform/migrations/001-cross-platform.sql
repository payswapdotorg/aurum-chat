-- W139 · cross-platform module — Client Sessions + Handoff Sessions +
-- Handoff Evidence.
--
-- The CROSS-PLATFORM SEMANTIC CORE's own persistence (spec/work-items/
-- WORK-ITEM-CATALOG.md §W139): the server-issued client-session
-- registry (one row per signed-in client instance — web canonical,
-- desktop Tauri 2, mobile Expo/RN) and the cross-device handoff
-- evidence trail. Everything ELSE the module serves is a live
-- projection over the owning seams' contracts (conversations W029,
-- goals W008, missions W011, agent-exchange W136, execution-fabric
-- W137, notifications, organizations) — this module persists NO domain
-- truth, only client identity and handoff evidence.
--
-- Load-bearing schema laws:
--   1. THE EVIDENCE TRAIL IS APPEND-ONLY (§24 "Audit records are
--      append-only from the domain perspective"). handoff_evidence
--      rejects UPDATE/DELETE/TRUNCATE outright — what moved where,
--      when, with which context snapshot and which server projection
--      it was bound to is recorded once and never rewritten.
--   2. THE WORKING CONTEXT IS IMMUTABLE FROM CREATION. A handoff
--      session's focus/draft/navigation are frozen at open (the
--      storage trigger rejects any context mutation); handoffs move
--      the VERBATIM context between devices and resumption restores
--      it EXACTLY while re-projecting from current server state (the
--      frozen W131 ContinuityHandoffSemantics literals). Only the
--      spine's tracking columns (active session, open-on platform,
--      last-active stamp, anchor revision) and the one-way
--      open → closed lifecycle may move.
--   3. CLIENT SESSIONS ARE SERVER-ISSUED IDENTITY, not domain state:
--      UPDATE is legal only for the tracking/revocation columns
--      (last_seen_at, revoked_at, revoked_by — the storage trigger
--      freezes platform, principal and device label); DELETE/TRUNCATE
--      are rejected (a revoked session is retained evidence).
--   4. TENANT SCOPING (ADR-0001): every table carries tenant_id; two
--      tenants hold fully independent client/handoff state, and
--      cross-tenant access is indistinguishable from missing records
--      at the service layer (uniform typed not-found, no leak).

-- ---------------------------------------------------------------------------
-- Client sessions — the server-issued registry (law 3)
-- ---------------------------------------------------------------------------
CREATE TABLE client_sessions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  principal_id text NOT NULL CHECK (char_length(principal_id) >= 1),
  platform text NOT NULL CHECK (platform IN ('web', 'desktop', 'mobile')),
  device_label text
    CHECK (device_label IS NULL OR (char_length(device_label) >= 1 AND char_length(device_label) <= 120)),
  issued_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by text
);

CREATE INDEX client_sessions_tenant_idx ON client_sessions (tenant_id, issued_at DESC);
CREATE INDEX client_sessions_tenant_platform_idx ON client_sessions (tenant_id, platform);
CREATE INDEX client_sessions_tenant_principal_idx ON client_sessions (tenant_id, principal_id);

-- Law 3: identity columns immutable; DELETE/TRUNCATE rejected (a revoked
-- session is retained evidence, never erased).
CREATE OR REPLACE FUNCTION client_sessions_identity_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'client_sessions is append-and-revoke only: DELETE is rejected (W139 law 3)';
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'client_sessions is append-and-revoke only: TRUNCATE is rejected (W139 law 3)';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.tenant_id <> OLD.tenant_id
       OR NEW.principal_id <> OLD.principal_id
       OR NEW.platform <> OLD.platform
       OR NEW.device_label IS DISTINCT FROM OLD.device_label
       OR NEW.issued_at <> OLD.issued_at
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
      RAISE EXCEPTION 'client_sessions identity columns are immutable (W139 law 3)';
    END IF;
    IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at <> OLD.revoked_at OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by) THEN
      RAISE EXCEPTION 'client_sessions revocation is one-way and terminal (W139 law 3)';
    END IF;
    IF NEW.revoked_at IS NOT NULL AND NEW.revoked_by IS NULL THEN
      RAISE EXCEPTION 'client_sessions revocation must record the acting principal (W139 law 3)';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER client_sessions_identity_guard
  BEFORE UPDATE OR DELETE ON client_sessions
  FOR EACH ROW EXECUTE FUNCTION client_sessions_identity_guard();
CREATE TRIGGER client_sessions_identity_guard_truncate
  BEFORE TRUNCATE ON client_sessions
  FOR EACH STATEMENT EXECUTE FUNCTION client_sessions_identity_guard();

-- ---------------------------------------------------------------------------
-- Handoff sessions — the spine (laws 2 + 4)
-- ---------------------------------------------------------------------------
CREATE TABLE handoff_sessions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  principal_id text NOT NULL CHECK (char_length(principal_id) >= 1),
  focus_kind text NOT NULL CHECK (focus_kind IN ('conversation', 'background-work', 'mission')),
  focus_ref text NOT NULL CHECK (char_length(focus_ref) >= 1 AND char_length(focus_ref) <= 256),
  focus_seam text
    CHECK (focus_seam IS NULL OR focus_seam IN ('mission', 'execution-run', 'fabric-lease')),
  draft text CHECK (char_length(draft) <= 20000),
  navigation_state jsonb NOT NULL,
  origin_client_session_id uuid NOT NULL,
  active_client_session_id uuid NOT NULL,
  open_on_platform text NOT NULL CHECK (open_on_platform IN ('web', 'desktop', 'mobile')),
  status text NOT NULL CHECK (status IN ('open', 'closed')),
  anchor_revision integer NOT NULL CHECK (anchor_revision >= 0),
  opened_at timestamptz NOT NULL,
  last_active_at timestamptz NOT NULL,
  closed_at timestamptz,
  closed_by text,
  -- focus_seam is present exactly when the focus is background work.
  CHECK (
    (focus_kind = 'background-work' AND focus_seam IS NOT NULL)
    OR (focus_kind <> 'background-work' AND focus_seam IS NULL)
  ),
  -- the one-way lifecycle stamps exactly once.
  CHECK ((status = 'open' AND closed_at IS NULL AND closed_by IS NULL)
         OR (status = 'closed' AND closed_at IS NOT NULL AND closed_by IS NOT NULL))
);

CREATE UNIQUE INDEX handoff_sessions_focus_seam_unique
  ON handoff_sessions (tenant_id, focus_seam, focus_ref)
  WHERE focus_seam IS NOT NULL AND status = 'open';

CREATE INDEX handoff_sessions_tenant_idx ON handoff_sessions (tenant_id, last_active_at DESC);
CREATE INDEX handoff_sessions_tenant_status_idx ON handoff_sessions (tenant_id, status);
CREATE INDEX handoff_sessions_tenant_principal_idx ON handoff_sessions (tenant_id, principal_id);

-- Law 2: the working context is immutable from creation; only the spine's
-- tracking columns and the one-way lifecycle may move; DELETE/TRUNCATE
-- rejected (the spine anchors the append-only evidence trail).
CREATE OR REPLACE FUNCTION handoff_sessions_context_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'handoff_sessions is append-and-close only: DELETE is rejected (W139 law 2)';
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'handoff_sessions is append-and-close only: TRUNCATE is rejected (W139 law 2)';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.tenant_id <> OLD.tenant_id
       OR NEW.principal_id <> OLD.principal_id
       OR NEW.focus_kind <> OLD.focus_kind
       OR NEW.focus_ref <> OLD.focus_ref
       OR NEW.focus_seam IS DISTINCT FROM OLD.focus_seam
       OR NEW.draft IS DISTINCT FROM OLD.draft
       OR NEW.navigation_state <> OLD.navigation_state
       OR NEW.origin_client_session_id <> OLD.origin_client_session_id
       OR NEW.opened_at <> OLD.opened_at THEN
      RAISE EXCEPTION 'handoff_sessions working context is immutable from creation (W139 law 2)';
    END IF;
    IF OLD.status = 'closed' AND NEW.status <> 'closed' THEN
      RAISE EXCEPTION 'handoff_sessions lifecycle is one-way: closed is terminal (W139 law 2)';
    END IF;
    IF OLD.status = 'open' AND NEW.status = 'closed' AND (NEW.closed_at IS NULL OR NEW.closed_by IS NULL) THEN
      RAISE EXCEPTION 'handoff_sessions close must stamp closed_at and closed_by (W139 law 2)';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER handoff_sessions_context_guard
  BEFORE UPDATE OR DELETE ON handoff_sessions
  FOR EACH ROW EXECUTE FUNCTION handoff_sessions_context_guard();
CREATE TRIGGER handoff_sessions_context_guard_truncate
  BEFORE TRUNCATE ON handoff_sessions
  FOR EACH STATEMENT EXECUTE FUNCTION handoff_sessions_context_guard();

-- ---------------------------------------------------------------------------
-- Handoff evidence — the append-only trail (law 1)
-- ---------------------------------------------------------------------------
CREATE TABLE handoff_evidence (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  handoff_session_id uuid NOT NULL,
  evidence_kind text NOT NULL CHECK (evidence_kind IN (
    'session-opened',
    'handoff-recorded',
    'resumed',
    'conflict-discarded',
    'session-closed'
  )),
  actor text NOT NULL CHECK (char_length(actor) >= 1),
  client_session_id uuid,
  from_platform text CHECK (from_platform IN ('web', 'desktop', 'mobile')),
  to_platform text CHECK (to_platform IN ('web', 'desktop', 'mobile')),
  context_snapshot jsonb,
  projection_revision integer CHECK (projection_revision IS NULL OR projection_revision >= 0),
  projection_digest text,
  discarded_client_revision integer CHECK (discarded_client_revision IS NULL OR discarded_client_revision >= 0),
  resolution text CHECK (resolution IS NULL OR resolution = 'server-state-wins'),
  recorded_at timestamptz NOT NULL,
  -- the conflict discipline: resolution/discarded revision exist exactly
  -- on conflict-discarded events; projections bind opened/handed/resumed.
  CHECK (
    (evidence_kind = 'conflict-discarded'
       AND resolution = 'server-state-wins'
       AND discarded_client_revision IS NOT NULL)
    OR (evidence_kind <> 'conflict-discarded'
       AND resolution IS NULL
       AND discarded_client_revision IS NULL)
  )
);

CREATE INDEX handoff_evidence_session_idx
  ON handoff_evidence (tenant_id, handoff_session_id, recorded_at ASC, id ASC);
CREATE INDEX handoff_evidence_session_kind_idx
  ON handoff_evidence (tenant_id, handoff_session_id, evidence_kind, recorded_at ASC);

-- Law 1: the trail is append-only — UPDATE/DELETE/TRUNCATE rejected
-- outright, even for callers bypassing the service.
CREATE OR REPLACE FUNCTION handoff_evidence_append_only_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'handoff_evidence is append-only: % is rejected (W139 law 1)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER handoff_evidence_append_only
  BEFORE UPDATE OR DELETE ON handoff_evidence
  FOR EACH ROW EXECUTE FUNCTION handoff_evidence_append_only_guard();
CREATE TRIGGER handoff_evidence_append_only_truncate
  BEFORE TRUNCATE ON handoff_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION handoff_evidence_append_only_guard();
