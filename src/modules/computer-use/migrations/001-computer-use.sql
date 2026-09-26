-- W093 · computer-use module — the Browser and Computer-Use Fallback:
-- the governed last-resort browser executor used only where APIs/MCP/
-- native adapters are insufficient. Tasks are durable records with
-- checkpointed steps (disposable sessions, resumable tasks); browser
-- profiles and credential stores are per tenant AND per task; every step
-- rides a frozen allowlist (URL globs + permitted verbs) and a step
-- budget; the observed page state is verified against an expected-shape
-- assertion (the W084 reconciliation) before it counts as a result; and
-- every failure produces actionable evidence (trace, screenshot
-- reference, allowlist decision, verification diff) in the SAME W004
-- observation ledger the deep-action pipeline uses.
--
-- Every table carries tenant_id (ADR-0001; scripts/check-architecture.ts
-- rule d). Nothing provider-named appears anywhere: the only
-- driver-minted values that reach these tables are OPAQUE strings
-- (receipt ids, session keys, screenshot artifact references). The
-- credential reference is OPAQUE by the W082 discipline — secret VALUES
-- never reach these tables at all (they are materialized only inside the
-- isolated per-(tenant,task) browser profile, driver-side).
--
-- State model (the governed lifecycle, mirrored by the shapes):
--   * browser_tasks       — the durable task and its phase state:
--                           draft → completed | failed | suspended (both
--                           resumable) | mismatched | aborted (terminal
--                           evidence states). No persistent in-flight
--                           state — the pre-run status stands while a
--                           session drives the plan.
--   * browser_task_steps  — the frozen step plan plus the outcome links
--                           each executed step fills in: the allowlist
--                           decision, the opaque driver receipt, the
--                           observed-state evidence observation link,
--                           the screenshot reference + redacted action
--                           trace, and the mismatch evidence / attention
--                           unknown links.
--   * browser_sessions    — the DISPOSABLE execution sessions (one per
--                           start/resume), each bound to the task's
--                           isolated profile key; worker death marks a
--                           session 'interrupted' while the task's
--                           verified steps stand as the resume checkpoint.
--   * browser_task_events — append-only lifecycle audit.

-- ---------------------------------------------------------------------------
-- Tasks — the durable record (disposable sessions, resumable tasks)
-- ---------------------------------------------------------------------------

CREATE TABLE browser_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  -- The concrete task (frozen at creation; the W083/W084 shape):
  -- {description, requestedFor} — the human-readable what-and-why.
  task_context jsonb NOT NULL CHECK (jsonb_typeof(task_context) = 'object'),
  -- The frozen governed-automation allowlist: {urlGlobs: [...], verbs:
  -- [...]} — URL/domain globs plus the permitted verb subset.
  allowlist jsonb NOT NULL CHECK (
    jsonb_typeof(allowlist) = 'object'
    AND jsonb_typeof(allowlist->'urlGlobs') = 'array'
    AND jsonb_typeof(allowlist->'verbs') = 'array'
  ),
  -- The OPAQUE credential reference (W082 discipline). A reference into
  -- the credential store — never a secret value.
  credential_ref text
    CHECK (credential_ref IS NULL OR char_length(credential_ref) BETWEEN 1 AND 512),
  -- Frozen step count (the plan's size; the steps live below).
  step_count integer NOT NULL CHECK (step_count BETWEEN 1 AND 32),
  -- The governed lifecycle (forward-only; the deep-actions discipline —
  -- no persistent in-flight state: the pre-run status stands while a
  -- session drives, the session rows carry the transient 'running').
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'suspended', 'failed', 'completed', 'mismatched', 'aborted'
  )),
  -- Verification outcome: steps whose observed state diverged.
  mismatch_count integer NOT NULL DEFAULT 0 CHECK (mismatch_count >= 0),
  -- Why a terminal refusal happened ('aborted' only).
  abort_reason text
    CHECK (abort_reason IS NULL OR char_length(abort_reason) BETWEEN 1 AND 2000),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT browser_tasks_id_tenant_unique UNIQUE (id, tenant_id),
  -- A completed task diverged nowhere; a mismatched task at least once.
  CONSTRAINT browser_tasks_completed_clean CHECK (
    status <> 'completed' OR mismatch_count = 0
  ),
  CONSTRAINT browser_tasks_mismatched_dirty CHECK (
    status <> 'mismatched' OR mismatch_count >= 1
  ),
  -- Only a refusal carries a task-level reason (transient failures carry
  -- theirs on the step/session/event rows).
  CONSTRAINT browser_tasks_abort_reason_shape CHECK (
    status = 'aborted' OR abort_reason IS NULL
  ),
  CONSTRAINT browser_tasks_aborted_reasoned CHECK (
    status <> 'aborted' OR abort_reason IS NOT NULL
  )
);

CREATE INDEX browser_tasks_tenant_status_idx
  ON browser_tasks (tenant_id, status, created_at DESC);

-- ---------------------------------------------------------------------------
-- Steps — the frozen plan, the per-step outcome links and evidence
-- ---------------------------------------------------------------------------

CREATE TABLE browser_task_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  -- Unique step key within the task (caller-chosen).
  step_key text NOT NULL CHECK (char_length(step_key) BETWEEN 1 AND 128),
  -- 1-based execution order (frozen at creation).
  position integer NOT NULL CHECK (position >= 1),
  -- The canonical action envelope (verb + url + selector + value |
  -- secretField) — the ONLY thing the fallback executes.
  action jsonb NOT NULL CHECK (jsonb_typeof(action) = 'object'),
  -- The expected-shape assertion: every entry must be present and
  -- deep-equal in the observed state (W084 subset semantics) before the
  -- step counts as an outcome.
  expectation jsonb NOT NULL CHECK (jsonb_typeof(expectation) = 'object'),
  -- Forward-only step state.
  state text NOT NULL DEFAULT 'pending' CHECK (state IN (
    'pending', 'verified', 'mismatched', 'failed', 'refused', 'blocked'
  )),
  -- The allowlist decision at dispatch ({allowed, verb, url, matchedGlob,
  -- reason} — the refusal reason IS the evidence).
  allowlist_decision jsonb CHECK (allowlist_decision IS NULL OR jsonb_typeof(allowlist_decision) = 'object'),
  -- The driver's canonical receipt.
  receipt_status text CHECK (receipt_status IN ('accepted', 'rejected', 'failed')),
  -- The driver's own OPAQUE receipt id (null when it gave none).
  receipt_id text CHECK (receipt_id IS NULL OR char_length(receipt_id) BETWEEN 1 AND 200),
  receipt_detail text CHECK (receipt_detail IS NULL OR char_length(receipt_detail) BETWEEN 1 AND 500),
  -- The normalized observed page state ({found, state}).
  observed_state jsonb CHECK (observed_state IS NULL OR jsonb_typeof(observed_state) = 'object'),
  -- The observed-state evidence observation (W004, immutable).
  observed_state_observation_id uuid,
  -- Opaque screenshot artifact reference (object storage holds the bytes).
  screenshot_ref text CHECK (screenshot_ref IS NULL OR char_length(screenshot_ref) BETWEEN 1 AND 512),
  -- The normalized, REDACTED action trace the driver returned.
  action_trace jsonb CHECK (action_trace IS NULL OR jsonb_typeof(action_trace) = 'object'),
  -- The session whose run loop dispatched this step (null while pending).
  session_id uuid,
  -- The mismatch evidence observation + attention unknown (verification
  -- divergence only).
  mismatch_evidence_observation_id uuid,
  mismatch_unknown_id uuid,
  executed_at timestamptz,
  verified_at timestamptz,
  CONSTRAINT browser_task_steps_key_unique UNIQUE (tenant_id, task_id, step_key),
  CONSTRAINT browser_task_steps_position_unique UNIQUE (tenant_id, task_id, position),
  CONSTRAINT browser_task_steps_id_tenant_unique UNIQUE (id, tenant_id),
  -- State-shape invariants (the lifecycle, one row at a time).
  CONSTRAINT browser_task_steps_pending_shape CHECK (
    state <> 'pending'
    OR (allowlist_decision IS NULL AND receipt_status IS NULL AND observed_state IS NULL
        AND observed_state_observation_id IS NULL AND screenshot_ref IS NULL
        AND action_trace IS NULL AND session_id IS NULL
        AND mismatch_evidence_observation_id IS NULL AND mismatch_unknown_id IS NULL
        AND executed_at IS NULL AND verified_at IS NULL)
  ),
  CONSTRAINT browser_task_steps_verified_shape CHECK (
    state <> 'verified'
    OR (receipt_status = 'accepted' AND observed_state IS NOT NULL
        AND observed_state_observation_id IS NOT NULL AND session_id IS NOT NULL
        AND executed_at IS NOT NULL AND verified_at IS NOT NULL)
  ),
  CONSTRAINT browser_task_steps_mismatched_shape CHECK (
    state <> 'mismatched'
    OR (receipt_status = 'accepted' AND observed_state IS NOT NULL
        AND observed_state_observation_id IS NOT NULL
        AND mismatch_evidence_observation_id IS NOT NULL
        AND mismatch_unknown_id IS NOT NULL
        AND session_id IS NOT NULL AND executed_at IS NOT NULL)
  ),
  CONSTRAINT browser_task_steps_failed_shape CHECK (
    state <> 'failed' OR (receipt_status = 'failed' AND session_id IS NOT NULL)
  ),
  CONSTRAINT browser_task_steps_refused_shape CHECK (
    state <> 'refused' OR (receipt_status = 'rejected' AND session_id IS NOT NULL)
  ),
  CONSTRAINT browser_task_steps_blocked_shape CHECK (
    state <> 'blocked'
    OR (receipt_status IS NULL AND session_id IS NOT NULL
        AND allowlist_decision IS NOT NULL
        AND (allowlist_decision->>'allowed') = 'false')
  ),
  -- Receipt detail only exists with a receipt; observed state only with
  -- a dispatch attempt.
  CONSTRAINT browser_task_steps_receipt_shape CHECK (
    receipt_status IS NOT NULL OR (receipt_id IS NULL AND receipt_detail IS NULL)
  )
);

CREATE INDEX browser_task_steps_task_idx
  ON browser_task_steps (tenant_id, task_id, position);

-- ---------------------------------------------------------------------------
-- Sessions — the disposable half (a fresh one per start/resume)
-- ---------------------------------------------------------------------------

CREATE TABLE browser_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  -- 1-based per-task session sequence: resume mints the next one.
  sequence integer NOT NULL CHECK (sequence >= 1),
  -- The ISOLATED per-(tenant,task) browser profile key — the driver
  -- keeps profile state (cookies, storage, materialized credentials)
  -- scoped to exactly this key.
  profile_key text NOT NULL CHECK (char_length(profile_key) BETWEEN 1 AND 512),
  status text NOT NULL DEFAULT 'running' CHECK (status IN (
    'running', 'completed', 'interrupted', 'failed', 'mismatched', 'aborted'
  )),
  -- How many step actions this session performed (the budget guard's
  -- counter — bounded by MAX_SESSION_STEPS in the service).
  steps_executed integer NOT NULL DEFAULT 0 CHECK (steps_executed >= 0),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  -- Why the session ended (human-readable, secret-free).
  end_reason text CHECK (end_reason IS NULL OR char_length(end_reason) BETWEEN 1 AND 500),
  CONSTRAINT browser_sessions_sequence_unique UNIQUE (tenant_id, task_id, sequence),
  CONSTRAINT browser_sessions_id_tenant_unique UNIQUE (id, tenant_id),
  -- A live session has no end; an ended one always says why.
  CONSTRAINT browser_sessions_end_shape CHECK (
    (status = 'running') = (ended_at IS NULL)
  ),
  CONSTRAINT browser_sessions_ended_reasoned CHECK (
    status = 'running' OR end_reason IS NOT NULL
  )
);

CREATE INDEX browser_sessions_task_idx
  ON browser_sessions (tenant_id, task_id, sequence);

-- ---------------------------------------------------------------------------
-- Events — append-only lifecycle audit
-- ---------------------------------------------------------------------------

CREATE TABLE browser_task_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  -- Monotonic per-task position: the service clock can hold still within
  -- one run (test-controllable time), so the audit feed orders by
  -- (recorded_at DESC, position DESC) deterministically.
  position integer NOT NULL CHECK (position >= 1),
  event text NOT NULL CHECK (event IN (
    'created',
    'started',
    'resumed',
    'step-executed',
    'step-verified',
    'step-failed',
    'step-blocked',
    'step-refused',
    'step-mismatch-detected',
    'suspended',
    'completed',
    'aborted',
    'mismatched'
  )),
  detail text
    CHECK (detail IS NULL OR char_length(detail) BETWEEN 1 AND 500),
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL,
  CONSTRAINT browser_task_events_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX browser_task_events_task_idx
  ON browser_task_events (tenant_id, task_id, recorded_at DESC, position DESC);

-- ---------------------------------------------------------------------------
-- Idempotency — caller-supplied dedupe keys, first write wins
-- ---------------------------------------------------------------------------

-- One row per recorded createBrowserTask idempotency key: a replay of
-- the key returns the original task (the events module's first-write-wins
-- semantics; the deep-actions/destinations precedent).

CREATE TABLE browser_task_idempotency (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  idempotency_key text NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 2 AND 200),
  created_at timestamptz NOT NULL,
  CONSTRAINT browser_task_idempotency_key_unique UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT browser_task_idempotency_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX browser_task_idempotency_task_idx
  ON browser_task_idempotency (tenant_id, task_id);

-- ---------------------------------------------------------------------------
-- Storage-level guarantees
-- ---------------------------------------------------------------------------

-- browser_task_events: strictly append-only audit — no UPDATE, DELETE or
-- TRUNCATE, ever. (The task/step/session tables legitimately move forward
-- through the lifecycle — they are workflow state, not evidence; the
-- evidence itself lives in the immutable observations the pipeline
-- records through the W004 contract.)

CREATE OR REPLACE FUNCTION browser_task_append_only_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (W093 computer-use audit): % is forbidden on table %',
    TG_TABLE_NAME, TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER browser_task_events_immutable
  BEFORE UPDATE OR DELETE ON browser_task_events
  FOR EACH ROW EXECUTE FUNCTION browser_task_append_only_reject_mutation();
CREATE TRIGGER browser_task_events_immutable_truncate
  BEFORE TRUNCATE ON browser_task_events
  FOR EACH STATEMENT EXECUTE FUNCTION browser_task_append_only_reject_mutation();
