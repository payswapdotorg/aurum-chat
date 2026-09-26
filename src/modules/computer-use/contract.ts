// ============================================================================
// computer-use — the ONLY public surface of the computer-use module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W093 — Browser and Computer-Use Fallback:
// "Use governed browser automation only where APIs/MCP/native adapters
//  are insufficient. Require verification, reconciliation,
//  screenshots/action traces and evidence."
// Acceptance: "browser task is disposable and resumable; session
// credentials are isolated; observed state is verified before being
// treated as a result; failure produces actionable evidence."
//
//   THE LAST-RESORT POSTURE: where the W081 inventory surface offers an
//   API, an MCP tool or an edge-native adapter, the deep-action gateway
//   (W084) or the edge connector (W088) carries the task. This module
//   exists for the systems that expose nothing but a login page — it
//   borrows the W084 execution discipline wholesale (the same receipt
//   taxonomy, the same reconciliation, the same evidence ledger and
//   attention records — no second evidence model) and adds the controls
//   a raw browser demands.
//
//   THE TASK LIFECYCLE (each phase an explicit, bounded, tenant-scoped
//   call):
//     createBrowserTask — freeze the governed plan: the task context,
//        the ALLOWLIST (URL/domain globs + permitted verbs — the whole
//        plan must be allowlist-conformant at creation), 1..32 canonical
//        steps (verb + url + selector + literal value or OPAQUE
//        credential field, each with its expected-shape assertion), and
//        the OPAQUE credentialRef. Idempotent by caller key.
//     startBrowserTask — mint session 1 (a DISPOSABLE browser session
//        bound to the task's per-(tenant,task) ISOLATED PROFILE) and
//        drive the plan: per step the allowlist is re-checked, the
//        canonical action envelope goes through the driver port, the
//        observed page state is recorded as immutable evidence with its
//        screenshot reference and redacted action trace, and the state
//        is VERIFIED against the expected shape (the W084
//        reconciliation) before the step counts as an outcome.
//     resumeBrowserTask — a FRESH session from the durable checkpoint:
//        verified steps are never re-executed; a 'failed' (transient)
//        step retries; the task's own status is the resume truth
//        (worker/session death never loses the task — lock 36).
//
//   THE READS
//     getBrowserTask / listBrowserTasks / listBrowserTaskEvents — the
//        task with its ordered steps (every evidence link: allowlist
//        decision, opaque receipt, observed-state observation, screenshot
//        reference, redacted trace, mismatch links) and its disposable
//        sessions; the task feed; the append-only lifecycle audit.
//     getBrowserFailureEvidence — the ACTIONABLE bundle for every
//        non-clean outcome: the failure kind, the deterministic reason,
//        the failing step's full evidence links and the W084-shape
//        verification diff (recomputed from the stored expectation and
//        observed states — reconciliation is a computation).
//
//   THE DRIVER PORT (the fallback's provider-neutral exit seam)
//     setBrowserDriver / getBrowserDriver — infrastructure wiring for
//     the BrowserDriver port. No driver is wired by default: the run
//     fails explicitly with `driver_unavailable` rather than faking
//     success. Driver results are canonicalized and validated — a
//     provider object (class instance, symbol, cycle, oversized body),
//     or an ACCEPTED action without its observed state, is rejected
//     loudly (`invalid_driver_result`): provider objects never cross
//     the boundary, and the fallback executes ONLY normalized action
//     envelopes. The port's shapes are deliberately aligned at the
//     CONTRACT LEVEL with the edge-connector's approved-browser-adapter
//     surface (W088's EdgeConnectivityAdapter, connectivity 'browser'):
//     the receipt taxonomy is verbatim ('accepted'/'rejected'/'failed'),
//     the observed-state shape is the {found, state} pair, and the
//     opaque credential reference passes straight through for LOCAL
//     resolution — an edge browser adapter binds with a thin shape
//     adapter (proven by the module's suite; no edge internals are
//     imported here).
//
//   THE DETERMINISTIC DOUBLE (fixture — NO live network, NO real
//     browser; the fixtures/doubles doctrine)
//     createScriptedBrowserDriver — the in-memory scripted driver the
//     repository's tests execute against: a tiny seeded site, isolated
//     per-(tenant,task) profiles with materialized credential stores,
//     the driver-side allowlist copy, honoring idempotency, and the
//     scriptable failure modes (transient failure, permanent refusal,
//     worker crash, observed-state divergence, stale page). A REAL
//     browser driver is environment-dependent and lives outside this
//     repository's test suite (customer-side / edge runtime).
//
// There is deliberately NO operation to update or erase a task's plan or
// its recorded evidence: the plan is frozen at creation, receipts and
// observations are immutable, and a changed plan is a NEW task (the
// actions-module discipline). Learning never rewrites execution history
// (lock 14 mirrored).
//
// CREDENTIAL ISOLATION (the acceptance's sharpest edge): browser
// profiles and credential stores are PER TENANT AND PER TASK — the
// profile key is minted from both; the task carries only the OPAQUE
// credentialRef (the W082 discipline), which is handed to the driver at
// session start and materialized ONLY inside the isolated profile.
// Secret VALUES never appear in a task record, a step, an event, a
// session, a trace, an observation or a log line this module persists.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext
// and is tenant-scoped at the SQL layer; another tenant's tasks, steps,
// sessions or events are indistinguishable from missing
// (`task_not_found`) — no existence leak.
//
// Dependency posture (WORK-ITEM-CATALOG W093 ← W080, W084, W088): the
// W084 reconciliation (reconcileOperation, StateMismatch) and its
// evidence vocabulary are imported from the deep-actions contract and
// re-exported here VERBATIM — browser-step verification lands in the
// same evidence model, never a fork; the W082 credentialRef discipline
// and the W088 approved-browser-adapter surface are honored by shape
// (see the driver port above); the W080 durable-run composition is
// deliberately deferred (the task record itself is the durable
// checkpoint and resume is an explicit contract call — see the delivery
// report's DEFERRED note).
// ============================================================================

export {
  // the task lifecycle
  createBrowserTask,
  startBrowserTask,
  resumeBrowserTask,
  // the reads
  getBrowserTask,
  listBrowserTasks,
  listBrowserTaskEvents,
  getBrowserFailureEvidence,
  // the driver port wiring
  setBrowserDriver,
  getBrowserDriver,
  // the isolated profile key derivation (wiring/test surface)
  browserProfileKey,
} from './service';

export { ComputerUseError } from './errors';
export type { ComputerUseErrorCode } from './errors';

// The W084 reconciliation, re-used verbatim — the module's verification
// IS the deep-actions reconciliation applied to browser steps (no second
// evidence model; exported for tests and downstream surfaces exactly as
// deep-actions exports its pure helpers).
export { reconcileOperation } from '@/modules/deep-actions/contract';
export type {
  OperationReconciliation,
  StateMismatch,
} from '@/modules/deep-actions/contract';

// The pure verification surface (unit-tested): the allowlist glob
// matcher shared by every check site, plus the deterministic
// browser-flavored mismatch language built from the W084 shapes.
export {
  buildBrowserMismatchReason,
  buildBrowserMismatchUnknownConsequence,
  buildBrowserMismatchUnknownQuestion,
  clampDetail,
  describeVerification,
  globToRegExp,
  urlMatchesGlob,
} from './verify';

// The deterministic browser driver double (the fixture — NO live
// network, NO real browser; the W082/W088 first-party-doubles
// precedent, exported through the contract).
export {
  createScriptedBrowserDriver,
  type ScriptedBrowserDriver,
  type ScriptedBrowserDriverOptions,
  type ScriptedPage,
} from './double';

// Module-owned constants (the canonical observation kinds).
export {
  BROWSER_VERBS,
  BROWSER_TASK_TERMINAL_STATUSES,
  OBSERVED_STATE_OBSERVATION_KIND,
  STEP_FAILURE_OBSERVATION_KIND,
  VERIFICATION_MISMATCH_OBSERVATION_KIND,
} from './types';

// Validation vocabularies + guards (the house pattern).
export {
  BROWSER_SESSION_STATUSES,
  BROWSER_STEP_STATES,
  BROWSER_TASK_EVENT_TYPES,
  BROWSER_TASK_STATUSES,
  DEFAULT_LIST_LIMIT,
  MAX_CREDENTIAL_REF_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_LIST_LIMIT,
  MAX_RECEIPT_DETAIL_LENGTH,
  MAX_RECEIPT_ID_LENGTH,
  MAX_SCREENSHOT_REF_LENGTH,
  MAX_SECRET_FIELD_LENGTH,
  MAX_SELECTOR_LENGTH,
  MAX_SESSION_STEPS,
  MAX_STEP_KEY_LENGTH,
  MAX_STEPS_PER_TASK,
  MAX_TYPED_VALUE_LENGTH,
  MAX_URL_GLOB_LENGTH,
  MAX_URL_GLOBS,
  MAX_URL_LENGTH,
  MAX_VALUE_BYTES,
  allowlistDecisionFor,
  assertComputerUseTenantContext,
  isBrowserSessionStatus,
  isBrowserStepState,
  isBrowserTaskEventType,
  isBrowserTaskStatus,
  isBrowserVerb,
  isUuid,
} from './validation';
export type {
  AllowlistDecision,
  ValidatedAction,
  ValidatedAllowlist,
  ValidatedCreateInput,
  ValidatedStepInput,
  ValidatedTaskContext,
} from './validation';

export type {
  BrowserAction,
  BrowserActionRequest,
  BrowserActionResult,
  BrowserAllowlist,
  BrowserDriver,
  BrowserFailureEvidence,
  BrowserSession,
  BrowserSessionEndRequest,
  BrowserSessionStartRequest,
  BrowserSessionStartResult,
  BrowserSessionStatus,
  BrowserStepInput,
  BrowserStepState,
  BrowserTask,
  BrowserTaskContext,
  BrowserTaskDetail,
  BrowserTaskEvent,
  BrowserTaskEventType,
  BrowserTaskStatus,
  BrowserVerb,
  CreateBrowserTaskInput,
  CreateBrowserTaskResult,
  GetBrowserTaskQuery,
  ListBrowserTaskEventsQuery,
  ListBrowserTasksQuery,
  ResumeBrowserTaskInput,
  StartBrowserTaskInput,
  StepVerification,
} from './types';
