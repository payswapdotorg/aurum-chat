// Pure authority-matrix logic of the actions module (W009 — Policy and
// Action Authority). No database, no context, no time — everything here is
// a total, deterministic function of its arguments, which is exactly what
// "deterministic approval gates" (work item) demands: the same tenant
// policy state and the same (action kind, authority level) always yield
// the same gate outcome, with no LLM, randomness or hidden state in the
// path (ARCHITECTURE.md §2 "authority ... remain[s] application-owned";
// §20).
//
// The six authority levels (ARCHITECTURE.md §20, in the architecture's
// canonical consequentiality order):
//   OBSERVE    — perceive/read data (evidence intake, world-model reads);
//   ANALYZE    — compute over evidence in Aurum's own head (no world
//                effect beyond derived observations);
//   RECOMMEND  — present findings/recommendations to management (advisory
//                output; never authoritative state);
//   ASK        — request information from a human (an outbound
//                communication — §7 "when policy permits");
//   PROPOSE    — put a specific consequential action up for approval
//                (§15 PROPOSED → APPROVAL → ...);
//   EXECUTE    — carry the consequential action out (messaging, source
//                access, data export, agent recruitment/termination,
//                extension deployment, external communication, ...).
//
// The BUILT-IN DEFAULT matrix is the deterministic floor that applies when
// a tenant has configured no policy rows: OBSERVE/ANALYZE/RECOMMEND/ASK/
// PROPOSE are allowed (Aurum is an always-on intelligence employee — it
// must be able to look, think, advise, ask and propose), and EXECUTE is
// approval-gated (consequential execution always awaits an explicit human
// decision until tenant policy says otherwise — GOVERNANCE.md "high-impact
// actions are policy-gated"). Tenants tighten or relax every level per
// action kind through setAuthorityPolicy; the floor never silently
// overrides tenant policy (lock 14 mirrored: policy wins over defaults).

// (No imports needed: this file is pure by design — see the header.)

/** The six authority levels, in canonical consequentiality order (§20). */
export const AUTHORITY_LEVELS = [
  'OBSERVE',
  'ANALYZE',
  'RECOMMEND',
  'ASK',
  'PROPOSE',
  'EXECUTE',
] as const;

export type AuthorityLevel = (typeof AUTHORITY_LEVELS)[number];

export function isAuthorityLevel(value: unknown): value is AuthorityLevel {
  return (
    typeof value === 'string' &&
    (AUTHORITY_LEVELS as readonly string[]).includes(value)
  );
}

/**
 * The canonical action kinds ARCHITECTURE.md §20 names as governed by the
 * authority matrix: "employee messaging, source access, data export, agent
 * recruitment, agent termination, extension deployment, external
 * communications and other consequential actions". The matrix applies
 * UNIFORMLY to all of them (same levels, same resolution, same gates).
 *
 * The vocabulary is deliberately open: any canonical slug matching the
 * kind pattern is a legal action kind (future modules — agents W021+,
 * extensions W025+, destinations W037 — register their kinds by using
 * them), exactly like the freshness module's subject-kind namespace. The
 * list below anchors the §20 enumeration for documentation, discovery and
 * tests; it does not restrict which kinds may carry policies.
 */
export const CANONICAL_ACTION_KINDS = [
  'employee-messaging',
  'source-access',
  'data-export',
  'agent-recruitment',
  'agent-termination',
  'extension-deployment',
  'external-communication',
] as const;

export type CanonicalActionKind = (typeof CANONICAL_ACTION_KINDS)[number];

export function isCanonicalActionKind(value: unknown): value is CanonicalActionKind {
  return (
    typeof value === 'string' &&
    (CANONICAL_ACTION_KINDS as readonly string[]).includes(value)
  );
}

/** The three deterministic outcomes of the approval gate. */
export const AUTHORITY_OUTCOMES = ['allowed', 'approval_required', 'forbidden'] as const;

export type AuthorityOutcome = (typeof AUTHORITY_OUTCOMES)[number];

export function isAuthorityOutcome(value: unknown): value is AuthorityOutcome {
  return (
    typeof value === 'string' &&
    (AUTHORITY_OUTCOMES as readonly string[]).includes(value)
  );
}

/** Lifecycle states of an action request. `pending` = sitting in the gate. */
export const ACTION_REQUEST_STATUSES = ['pending', 'approved', 'rejected'] as const;

export type ActionRequestStatus = (typeof ACTION_REQUEST_STATUSES)[number];

export function isActionRequestStatus(value: unknown): value is ActionRequestStatus {
  return (
    typeof value === 'string' &&
    (ACTION_REQUEST_STATUSES as readonly string[]).includes(value)
  );
}

/** Which policy row decided an evaluation (the resolution trail). */
export type PolicyResolutionSource = 'kind' | 'tenant-default' | 'built-in';

/** A human decision on a gated request. */
export type ApprovalDecisionKind = 'approve' | 'reject';

/** Who made a decision: the deterministic matrix (`policy`) or a human (`principal`). */
export type ApprovalDecider = 'policy' | 'principal';

/**
 * The level rules of one authority-policy row: which levels are gated
 * behind human approval and which are forbidden outright. Levels in
 * neither list are allowed. A level may never appear in both lists
 * (validation rejects it; `forbidden` would win anyway — see
 * `evaluateAuthorityMatrix`).
 */
export interface AuthorityLevelsPolicy {
  approvalLevels: AuthorityLevel[];
  forbiddenLevels: AuthorityLevel[];
}

/**
 * The built-in default matrix (see module header): informational and
 * interrogative levels are allowed; EXECUTE is approval-gated. Private by
 * design — `builtInDefaultMatrix()` hands out defensive copies so no
 * caller can mutate the floor for everyone else.
 */
const BUILT_IN_DEFAULT: AuthorityLevelsPolicy = {
  approvalLevels: ['EXECUTE'],
  forbiddenLevels: [],
};

/** A fresh copy of the built-in default matrix. */
export function builtInDefaultMatrix(): AuthorityLevelsPolicy {
  return {
    approvalLevels: [...BUILT_IN_DEFAULT.approvalLevels],
    forbiddenLevels: [...BUILT_IN_DEFAULT.forbiddenLevels],
  };
}

/**
 * The deterministic gate evaluation (W009 acceptance core).
 *
 * `policy === null` means "no tenant policy applies" — the built-in
 * default floor decides. Otherwise, in strict precedence:
 *   1. `forbidden` — the level is forbidden outright, even if it also
 *      appears in `approvalLevels` (defense in depth: overlapping data
 *      stays deterministic because the stricter rule wins);
 *   2. `approval_required` — the level is gated behind a human approval;
 *   3. otherwise `allowed`.
 *
 * Total (every level yields an outcome) and pure (same inputs, same
 * output — no clock, no randomness, no IO). This function never consults
 * anything but its arguments; the tenant's policy STATE is the only
 * input that can change its result.
 */
export function evaluateAuthorityMatrix(
  policy: AuthorityLevelsPolicy | null,
  level: AuthorityLevel,
): AuthorityOutcome {
  const effective = policy ?? BUILT_IN_DEFAULT;
  if ((effective.forbiddenLevels as readonly string[]).includes(level)) return 'forbidden';
  if ((effective.approvalLevels as readonly string[]).includes(level)) return 'approval_required';
  return 'allowed';
}

/** The request status a gate outcome maps onto at authorization time. */
export function statusForOutcome(outcome: AuthorityOutcome): ActionRequestStatus {
  switch (outcome) {
    case 'allowed':
      return 'approved';
    case 'approval_required':
      return 'pending';
    case 'forbidden':
      return 'rejected';
  }
}

/**
 * The decision a policy outcome records immediately: `allowed` is a policy
 * approval, `forbidden` a policy rejection, `approval_required` records
 * NO decision — the request waits for a human one.
 */
export function policyDecisionForOutcome(outcome: AuthorityOutcome): ApprovalDecisionKind | null {
  switch (outcome) {
    case 'allowed':
      return 'approve';
    case 'forbidden':
      return 'reject';
    case 'approval_required':
      return null;
  }
}

/** Authority claim that manages the tenant's authority matrix. */
export const ACTIONS_AUTHORITY_ADMINISTER = 'actions:administer';

/** Authority claim that decides approval-gated requests of ANY kind. */
export const ACTIONS_AUTHORITY_APPROVE = 'actions:approve';

/** The kind-scoped approver claim: `actions:approve:<actionKind>`. */
export function kindScopedApproveClaim(actionKind: string): string {
  return `${ACTIONS_AUTHORITY_APPROVE}:${actionKind}`;
}

/** May these authority claims manage the tenant's authority matrix? */
export function canAdminister(authorityClaims: readonly string[]): boolean {
  return authorityClaims.includes(ACTIONS_AUTHORITY_ADMINISTER);
}

/**
 * May these authority claims decide a request of `actionKind`? The global
 * `actions:approve` claim covers every kind; the kind-scoped
 * `actions:approve:<kind>` covers exactly that kind. (Whether the decider
 * may decide THIS request also requires the separation-of-duties rule —
 * the requester never decides its own request — which is a property of
 * the request, not of the claims, and is enforced by `decideApproval`.)
 */
export function canApprove(authorityClaims: readonly string[], actionKind: string): boolean {
  return (
    authorityClaims.includes(ACTIONS_AUTHORITY_APPROVE) ||
    authorityClaims.includes(kindScopedApproveClaim(actionKind))
  );
}
