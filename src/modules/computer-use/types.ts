// Public domain types of the computer-use module (W093 — Browser and
// Computer-Use Fallback).
//
// W093 owns the LAST-RESORT executor of the integration journey's action
// model (spec/WORK-ITEM-CATALOG.md):
//
//   "Use governed browser automation only where APIs/MCP/native adapters
//    are insufficient. Require verification, reconciliation,
//    screenshots/action traces and evidence."
//   Acceptance: "browser task is disposable and resumable; session
//   credentials are isolated; observed state is verified before being
//   treated as a result; failure produces actionable evidence."
//
// THE POSTURE (the work item's first sentence is the whole idea): the
// browser is the LAST connector of last resort. Where the W081 inventory
// surface offers an API, an MCP tool or an edge-native adapter, the
// deep-action gateway (W084) or the edge connector (W088) carries the
// task; this module exists for the systems that expose nothing but a
// login page. It therefore borrows the W084 execution discipline
// wholesale and adds the two controls a raw browser demands:
//
//   1. GOVERNED AUTOMATION — no free-form agent driving. A task is a
//      FROZEN plan of canonical steps (verb + url + selector + literal
//      value or OPAQUE credential field), each step checked against a
//      frozen allowlist (URL/domain globs + permitted verbs) at creation,
//      again at dispatch, and a third time by the driver inside the
//      session (the W088 twice-checked discipline). A step budget bounds
//      the plan's size.
//
//   2. DISPOSABLE SESSIONS, DURABLE TASKS — the browser session is
//      disposable state; the task record is the durable truth (lock 35:
//      PostgreSQL is authoritative). Every verified step is a CHECKPOINT:
//      a worker/session death parks the task resumable, and
//      `resumeBrowserTask` mints a FRESH session that continues from the
//      first open step — verified steps are never re-executed (their
//      evidence already stands; the driver-side idempotency key keeps a
//      crash between accept-and-record exactly-once).
//
// VERIFICATION BEFORE RESULT (the acceptance's sharpest clause): a step's
// observed DOM/page state must MATCH its expected-shape assertion before
// the step counts as an outcome. The comparison is the W084
// reconciliation VERBATIM — `reconcileOperation` (subset semantics over
// plain JSON, deterministic) imported from the deep-actions contract, and
// the divergence shapes (`StateMismatch`, `OperationReconciliation`) are
// the deep-actions types re-exported, not a forked model: browser-step
// evidence lands in the SAME evidence ledger (immutable W004
// observations) and creates the SAME attention records (epistemics
// unknowns) a deep-action mismatch would.
//
// PROVIDER ISOLATION (lock 16): everything here is provider-neutral BY
// CONSTRUCTION. The driver port (`BrowserDriver` below) is the exit
// seam — a real browser automation runtime (an approved edge browser
// adapter, W088) implements it CUSTOMER-SIDE; the repository ships only
// the deterministic in-memory double the tests execute against (the
// fixtures/doubles doctrine, IMPLEMENTATION-STACK §7 — NO live network,
// NO real browser in the test suite; the real-browser driver is
// environment-dependent and lives outside this module's tests). Driver
// results are canonicalized: a provider object (class instance, symbol,
// cycle, oversized body) is rejected loudly (`invalid_driver_result`).
//
// CREDENTIAL ISOLATION (the W082 discipline, sharpened per-task): the
// task carries only an OPAQUE `credentialRef`. Browser profiles and
// credential stores are PER TENANT AND PER TASK — the profile key is
// minted from both, so no two tasks (and no two tenants) ever share
// browser state. The reference is materialized into the isolated profile
// ONLY inside the session, by the driver; secret VALUES never appear in
// a task record, a step, an event, a trace, an observation or a log line
// this module persists. A step that must type a secret names the
// credential FIELD (`secretField`); the driver types the materialized
// value and returns a trace that records the typing WITHOUT the value.

import type { OperationReconciliation, StateMismatch } from '@/modules/deep-actions/contract';

// ---------------------------------------------------------------------------
// Vocabularies (mirrored by migration CHECKs)
// ---------------------------------------------------------------------------

/**
 * The governed verb set — the ONLY actions the fallback can perform.
 * There is deliberately no 'evaluate', 'exec' or free-form driver call:
 * governed automation means the plan can only compose these five.
 */
export const BROWSER_VERBS = ['goto', 'click', 'type', 'read', 'submit'] as const;
export type BrowserVerb = (typeof BROWSER_VERBS)[number];

/**
 * The forward-only lifecycle of a browser task (the deep-actions
 * discipline: no persistent in-flight state — the pre-run status stands
 * while a session drives the plan, and each outcome transitions once):
 *   * 'draft'     — the frozen plan exists; no session has completed a
 *     verdict yet (a hard-killed first run leaves it here — start is
 *     re-enterable and skips verified steps);
 *   * 'suspended' — the session/worker died mid-run without a verdict
 *     (driver crash) — RESUMABLE; verified steps are the checkpoint;
 *   * 'failed'    — a step failed transiently (driver 'failed' receipt)
 *     or the session budget was exhausted — RESUMABLE;
 *   * 'completed' — every step executed AND verified (the only outcome
 *     state: nothing is treated as a result before verification);
 *   * 'mismatched'— a step's observed state diverged from its expected
 *     shape — terminal, evidence + attention recorded (a changed plan
 *     is a NEW task, the actions-module discipline);
 *   * 'aborted'   — the allowlist (service or driver side) refused a
 *     step, or the driver permanently refused one — terminal, evidence
 *     recorded.
 *
 * The TRANSIENT 'a session is live' fact lives on the session rows
 * (browser_sessions.status 'running'), never on the task: worker death
 * can never strand the durable record in an unresumable state.
 */
export type BrowserTaskStatus =
  | 'draft'
  | 'suspended'
  | 'failed'
  | 'completed'
  | 'mismatched'
  | 'aborted';

/** Terminal task statuses (the end of a task's lifecycle). */
export const BROWSER_TASK_TERMINAL_STATUSES: readonly BrowserTaskStatus[] = [
  'completed',
  'mismatched',
  'aborted',
] as const;

/**
 * The forward-only state of one step:
 *   * 'pending'   — planned; no session has a verdict for it yet;
 *   * 'verified'  — executed AND observed-state-verified (the checkpoint
 *     states: a verified step is never re-executed);
 *   * 'mismatched'— executed, accepted, but the observed state diverged
 *     from the expected shape (verification failure = evidence, never a
 *     result);
 *   * 'failed'    — the driver reported a transient failure (resumable:
 *     the step re-executes in a fresh session);
 *   * 'refused'   — the driver permanently refused the action;
 *   * 'blocked'   — the SERVICE-side allowlist refused the action
 *     (defense in depth: the plan is allowlist-checked at creation).
 */
export type BrowserStepState =
  | 'pending'
  | 'verified'
  | 'mismatched'
  | 'failed'
  | 'refused'
  | 'blocked';

/**
 * The disposable-session lifecycle: every start/resume mints a session;
 * the session ends when the run loop ends (any outcome) or when the
 * worker dies ('interrupted' — the crash-resumable marker).
 */
export type BrowserSessionStatus =
  | 'running'
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'mismatched'
  | 'aborted';

/** The append-only lifecycle event vocabulary. */
export type BrowserTaskEventType =
  | 'created'
  | 'started'
  | 'resumed'
  | 'step-executed'
  | 'step-verified'
  | 'step-failed'
  | 'step-blocked'
  | 'step-refused'
  | 'step-mismatch-detected'
  | 'suspended'
  | 'completed'
  | 'aborted'
  | 'mismatched';

/** The canonical observation kinds this module records (W004 evidence). */
export const OBSERVED_STATE_OBSERVATION_KIND = 'computer-use.observed-state';
export const VERIFICATION_MISMATCH_OBSERVATION_KIND = 'computer-use.verification-mismatch';
export const STEP_FAILURE_OBSERVATION_KIND = 'computer-use.step-failure';

// ---------------------------------------------------------------------------
// The frozen plan: task context, allowlist, steps
// ---------------------------------------------------------------------------

/**
 * The concrete browser task (mirrors the W083/W084 task-context shape):
 * the human-readable what-and-why, frozen at creation.
 */
export interface BrowserTaskContext {
  /** What the task is, in plain organizational language (1..2000 chars). */
  description: string;
  /** Optional plain-language link to what the task is for. */
  requestedFor?: string | null;
}

/**
 * The governed-automation allowlist, frozen at creation: a step is
 * dispatchable only when its URL matches at least one glob AND its verb
 * is permitted. Checked at creation (the whole plan), at dispatch (every
 * step — defense in depth) and by the driver inside the session (the
 * W088 twice-checked discipline).
 */
export interface BrowserAllowlist {
  /** 1..32 URL globs, e.g. 'https://vendor.example.com/app/*'. */
  urlGlobs: string[];
  /** 1..5 permitted verbs (a subset of the canonical five). */
  verbs: BrowserVerb[];
}

/** One governed step of the frozen plan. */
export interface BrowserStepInput {
  /** Unique key within the task (1..128, canonical pattern). */
  key: string;
  /** The canonical action envelope (verb + url + selector + value). */
  action: BrowserAction;
  /**
   * The expected-shape assertion: a plain JSON object of expected page
   * fields. The step's observed state must contain every entry
   * (deep-equal, subset semantics — the W084 reconciliation) before the
   * step counts as an outcome. At least one entry: an unverifiable step
   * is not a governed step.
   */
  expectation: Record<string, unknown>;
}

/**
 * The canonical action envelope — the ONLY thing the fallback executes.
 * Provider objects never cross the boundary; the driver composes
 * provider-native interactions from this shape INSIDE the session.
 */
export interface BrowserAction {
  /** One of the five governed verbs. */
  verb: BrowserVerb;
  /** The page URL the action targets (allowlist-checked). */
  url: string;
  /** The selector acted on (required for click/type/read/submit). */
  selector?: string | null;
  /**
   * The literal text to type (verb 'type' only). Must be null when
   * `secretField` is set — a literal and a credential field are mutually
   * exclusive by construction.
   */
  value?: string | null;
  /**
   * The credential FIELD to type (verb 'type' only): the driver
   * materializes the field from the task's opaque credentialRef INSIDE
   * the isolated session and types the value; the value itself is never
   * persisted, traced or observed back.
   */
  secretField?: string | null;
}

// ---------------------------------------------------------------------------
// Persisted records
// ---------------------------------------------------------------------------

/** One governed browser task — the durable record (the resume truth). */
export interface BrowserTask {
  id: string;
  tenantId: string;
  taskContext: BrowserTaskContext;
  /** The frozen governed-automation allowlist. */
  allowlist: BrowserAllowlist;
  /** The OPAQUE credential reference (W082 discipline; never a value). */
  credentialRef: string | null;
  stepCount: number;
  status: BrowserTaskStatus;
  /** How many steps' observed states diverged (terminal 'mismatched'). */
  mismatchCount: number;
  /** Why a terminal refusal/failure happened ('aborted' only here). */
  abortReason: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * One step of the frozen plan plus the outcome links each executed step
 * fills in: the allowlist decision at dispatch, the driver's opaque
 * receipt, the observed state evidence link, the per-step screenshot
 * reference and normalized (redacted) action trace, and the mismatch
 * evidence/attention links.
 */
export interface BrowserTaskStep {
  id: string;
  tenantId: string;
  taskId: string;
  key: string;
  /** 1-based execution order. */
  position: number;
  action: BrowserAction;
  expectation: unknown;
  state: BrowserStepState;
  /** The allowlist decision at dispatch ({allowed, matchedGlob, verb, reason}). */
  allowlistDecision: Record<string, unknown> | null;
  receiptStatus: 'accepted' | 'rejected' | 'failed' | null;
  /** The driver's opaque receipt id (null when it gave none). */
  receiptId: string | null;
  receiptDetail: string | null;
  /** The observed state evidence observation (executed steps). */
  observedStateObservationId: string | null;
  /** The normalized observed page state ({found, state}). */
  observedState: { found: boolean; state: unknown } | null;
  /** Opaque screenshot artifact reference (object storage holds the bytes). */
  screenshotRef: string | null;
  /** The normalized, REDACTED action trace the driver returned. */
  actionTrace: Record<string, unknown> | null;
  /** The session that executed this step (null while pending). */
  sessionId: string | null;
  /** The mismatch evidence observation (verification divergence). */
  mismatchEvidenceObservationId: string | null;
  /** The epistemics unknown created for a mismatch (the attention link). */
  mismatchUnknownId: string | null;
  executedAt: string | null;
  verifiedAt: string | null;
}

/**
 * One disposable browser session: minted by start/resume, bound to the
 * task's PER-(tenant,task) ISOLATED PROFILE, ended by any outcome or by
 * worker death. Sessions are evidence of disposability — the task's
 * checkpoint, not the session, is what survives.
 */
export interface BrowserSession {
  id: string;
  tenantId: string;
  taskId: string;
  /** 1-based per-task session sequence (resume mints the next one). */
  sequence: number;
  /** The isolated per-(tenant,task) browser profile key. */
  profileKey: string;
  status: BrowserSessionStatus;
  /** How many step actions this session performed. */
  stepsExecuted: number;
  startedAt: string;
  endedAt: string | null;
  /** Why the session ended (human-readable, secret-free). */
  endReason: string | null;
}

/** One append-only lifecycle event of a browser task. */
export interface BrowserTaskEvent {
  id: string;
  tenantId: string;
  taskId: string;
  position: number;
  event: BrowserTaskEventType;
  detail: string | null;
  recordedBy: string;
  recordedAt: string;
}

/** The full task view: the task, its ordered steps and its sessions. */
export interface BrowserTaskDetail {
  task: BrowserTask;
  steps: BrowserTaskStep[];
  sessions: BrowserSession[];
}

// ---------------------------------------------------------------------------
// Inputs / queries / results
// ---------------------------------------------------------------------------

/** Input shape of `createBrowserTask`. */
export interface CreateBrowserTaskInput {
  taskContext: BrowserTaskContext;
  allowlist: BrowserAllowlist;
  /** 1..32 governed steps; keys unique; positions follow array order. */
  steps: BrowserStepInput[];
  /** OPAQUE credential reference (optional: tasks may need no login). */
  credentialRef?: string | null;
  /** Caller-supplied dedupe key; a recorded key replays the original task. */
  idempotencyKey?: string | null;
}

/** Result shape of `createBrowserTask`. */
export interface CreateBrowserTaskResult {
  task: BrowserTask;
  steps: BrowserTaskStep[];
  /** false when a recorded idempotency key replayed an existing task. */
  created: boolean;
}

/** Input of `startBrowserTask` (drives the whole plan in session 1). */
export interface StartBrowserTaskInput {
  taskId: string;
}

/** Input of `resumeBrowserTask` (a FRESH session from the checkpoint). */
export interface ResumeBrowserTaskInput {
  taskId: string;
}

/** The result of `getBrowserFailureEvidence` — the actionable bundle. */
export interface BrowserFailureEvidence {
  taskId: string;
  /** 'blocked' | 'refused' | 'step-failed' | 'mismatch' | 'interrupted' | 'budget'. */
  failureKind: string;
  /** Deterministic human-readable reason (the investigating human reads this). */
  reason: string;
  /** The failing step (null for session-level failures like interruption). */
  step: {
    key: string;
    position: number;
    action: BrowserAction;
    state: BrowserStepState;
    allowlistDecision: Record<string, unknown> | null;
    receiptStatus: string | null;
    receiptId: string | null;
    receiptDetail: string | null;
    screenshotRef: string | null;
    actionTrace: Record<string, unknown> | null;
    observedStateObservationId: string | null;
    mismatchEvidenceObservationId: string | null;
    mismatchUnknownId: string | null;
    /** The W084-shape verification diff (mismatch failures only). */
    mismatches: StateMismatch[];
    stateUnchanged: boolean | null;
  } | null;
  /** The session that was live when the failure happened (if any). */
  session: BrowserSession | null;
}

export interface GetBrowserTaskQuery {
  taskId: string;
}

export interface ListBrowserTasksQuery {
  status?: BrowserTaskStatus;
  /** 1..500, default 50. */
  limit?: number;
}

export interface ListBrowserTaskEventsQuery {
  taskId: string;
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// The driver port (the module's provider-neutral exit seam)
// ---------------------------------------------------------------------------

/** What the service hands the driver at session start. */
export interface BrowserSessionStartRequest {
  taskId: string;
  /**
   * The ISOLATED browser profile key — per tenant AND per task by
   * construction (the service mints it from both). The driver MUST keep
   * profile state (cookies, storage, the materialized credential store)
   * scoped to exactly this key: no two tasks, and no two tenants, ever
   * share browser state.
   */
  profileKey: string;
  /**
   * The task's OPAQUE credential reference (W082 discipline). The driver
   * resolves/materializes it LOCALLY, inside the isolated profile only;
   * the value never crosses back.
   */
  credentialRef: string | null;
  /** The frozen governed-automation allowlist (the driver re-checks it). */
  allowlist: BrowserAllowlist;
}

/** The driver's session handle (an OPAQUE driver-minted string). */
export interface BrowserSessionStartResult {
  sessionKey: string;
}

/** One canonical action handed to the driver (normalized envelopes only). */
export interface BrowserActionRequest {
  sessionKey: string;
  taskId: string;
  stepKey: string;
  /** Stable per-step dedupe key — `computer-use:<taskId>:<stepId>:perform`. */
  idempotencyKey: string;
  action: BrowserAction;
}

/**
 * The canonical outcome of one performed action.
 *
 * `receipt` uses the W084/W088 receipt taxonomy VERBATIM ('accepted' /
 * 'rejected' permanent refusal / 'failed' transient), so an approved
 * browser adapter (the edge-connector's W88 connectivity surface) can
 * serve as this module's driver with a thin shape adapter. An ACCEPTED
 * action MUST report its observed state — an unobserved action is never
 * treated as an outcome (the module's core acceptance).
 */
export interface BrowserActionResult {
  receipt: {
    status: 'accepted' | 'rejected' | 'failed';
    /** The driver's own opaque receipt id (null when it gave none). */
    receiptId: string | null;
    detail: string | null;
  };
  /** The normalized observed page state ({found, state} — W084/W088 shape). Required when accepted. */
  observedState: { found: boolean; state: unknown } | null;
  /** Opaque screenshot artifact reference (per-step evidence capture). */
  screenshotRef: string | null;
  /** The normalized action trace (PLAIN JSON, REDACTED — no secret values). */
  actionTrace: Record<string, unknown> | null;
}

/** How the service closes a session (the disposable half of the model). */
export interface BrowserSessionEndRequest {
  sessionKey: string;
  reason: 'completed' | 'interrupted' | 'failed' | 'aborted' | 'mismatched';
  detail: string | null;
}

/**
 * THE BROWSER DRIVER PORT — the fallback's exit seam. A real browser
 * automation runtime (an approved edge browser adapter, W088, or a
 * governed in-process browser) implements this CUSTOMER-SIDE / in
 * wiring; the repository ships only the deterministic double (see
 * `createScriptedBrowserDriver` through the contract). No driver is
 * wired by default — start/resume then fail explicitly with
 * `driver_unavailable` rather than faking success (the
 * sources/destinations discipline).
 *
 * Implementations MUST return canonical values only: a non-canonical
 * result (a provider object, a class instance, a symbol, a cycle, an
 * oversized body, an accepted action without an observed state) is
 * rejected loudly by the service (`invalid_driver_result`) — provider
 * objects never cross the boundary, and the fallback executes ONLY
 * normalized action envelopes.
 */
export interface BrowserDriver {
  /** Mint a fresh disposable session bound to the isolated profile. */
  startSession(request: BrowserSessionStartRequest): Promise<BrowserSessionStartResult>;
  /** Perform one canonical action; return its canonical outcome. */
  performAction(request: BrowserActionRequest): Promise<BrowserActionResult>;
  /** Close the session (any outcome). Sessions are disposable by contract. */
  endSession(request: BrowserSessionEndRequest): Promise<void>;
}

// ---------------------------------------------------------------------------
// Verification (the W084 reconciliation, re-used verbatim)
// ---------------------------------------------------------------------------

export type { OperationReconciliation, StateMismatch };

/**
 * The per-step observed-state verification verdict — `reconcileOperation`
 * (deep-actions, W084) applied to the browser step: every expectation
 * entry must be present and deep-equal in the observed state; the
 * previous verified step's observed state doubles as the pre-state for
 * the unchanged-state flag (the "accepted but the page never moved"
 * divergence).
 */
export type StepVerification = OperationReconciliation;
