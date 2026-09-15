// Public domain types of the actions module (W009 — Policy and Action
// Authority).
//
// W009 owns two halves of one foundation:
//
//  1. THE AUTHORITY MATRIX (ARCHITECTURE.md §20): tenant-scoped policy
//     rows mapping (action kind × authority level) to a deterministic
//     gate outcome — `allowed`, `approval_required` or `forbidden`. Rows
//     are keyed by action kind (employee messaging, source access, data
//     export, agent recruitment, agent termination, extension deployment,
//     external communication, ... — any canonical slug); the NULL kind is
//     the tenant-wide default. Resolution: the kind's row first, then the
//     default row, then the built-in default matrix.
//
//  2. THE APPROVAL GATES: `authorizeAction` records an ActionRequest and
//     routes it deterministically through the matrix — allowed requests
//     are auto-approved by policy, forbidden requests are rejected by
//     policy, and approval-required requests sit as `pending` until a
//     human decides them via `decideApproval`. Every decision (policy or
//     human) is an append-only ApprovalDecision row, so the chain
//     `request → policy evaluation → approval/rejection` stays
//     reconstructable (ARCHITECTURE.md §24).
//
// Types stay provider-neutral and tenant-scoped. The acting principal is
// the TenantContext principal (opaque string, per the observations/
// freshness precedent); the matrix never trusts LLM output for authority
// (lock 10 — evaluation is pure code over persisted policy state).

import type {
  ActionRequestStatus,
  ApprovalDecider,
  ApprovalDecisionKind,
  AuthorityLevel,
  AuthorityOutcome,
  AuthorityLevelsPolicy,
  PolicyResolutionSource,
} from './matrix';

export type {
  ActionRequestStatus,
  ApprovalDecider,
  ApprovalDecisionKind,
  AuthorityLevel,
  AuthorityOutcome,
  AuthorityLevelsPolicy,
  CanonicalActionKind,
  PolicyResolutionSource,
} from './matrix';

/**
 * A tenant-scoped authority-matrix row (ARCHITECTURE.md §20: "Tenant
 * policy defines which authority levels and operations require human
 * approval").
 *
 * Keyed by action kind:
 *  * `actionKind` — the canonical slug the row governs ('source-access',
 *    'agent-recruitment', ... any canonical slug future modules bring),
 *    or `null` for the tenant-wide DEFAULT row that governs every kind
 *    without its own row.
 *  * `approvalLevels` — levels gated behind a human approval decision;
 *  * `forbiddenLevels` — levels forbidden outright (no approval path).
 *
 * Levels in neither list are allowed. Resolution order (service):
 * kind row → default row → built-in default matrix.
 *
 * Policies are management controls, not evidence: they are legitimately
 * updatable (`setAuthorityPolicy` upserts; `updatedAt` moves) and
 * deliberately NOT append-only. Their full change history belongs to the
 * audit module (W046), not W009 — the same discipline the freshness
 * module applies to stale-after policies.
 */
export interface AuthorityPolicy extends AuthorityLevelsPolicy {
  id: string;
  tenantId: string;
  /** The action kind this row governs, or null for the tenant-wide default. */
  actionKind: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Input shape of `setAuthorityPolicy` (upsert by action-kind key). */
export interface SetAuthorityPolicyInput {
  /** null/omitted addresses the tenant-wide default row. */
  actionKind?: string | null;
  approvalLevels?: AuthorityLevel[];
  forbiddenLevels?: AuthorityLevel[];
  note?: string | null;
}

/**
 * A resolved matrix for one action kind: the level rules that apply plus
 * where they came from. `policy` is null exactly when `source` is
 * `'built-in'` (no tenant row decided).
 */
export interface ResolvedAuthorityPolicy extends AuthorityLevelsPolicy {
  actionKind: string;
  source: PolicyResolutionSource;
  policy: AuthorityPolicy | null;
}

/**
 * The deterministic result of evaluating one (action kind, authority
 * level) against the tenant's matrix — what `evaluateActionAuthority`
 * returns and what `authorizeAction` records on the request. Carries the
 * resolution trail so "why is this gated?" is always answerable.
 */
export interface AuthorityEvaluation {
  actionKind: string;
  authorityLevel: AuthorityLevel;
  outcome: AuthorityOutcome;
  resolvedVia: PolicyResolutionSource;
  /** The policy row that decided, or null when the built-in default did. */
  policy: AuthorityPolicy | null;
}

/** The evaluation snapshot recorded on an action request at gate time. */
export interface ActionRequestEvaluation {
  outcome: AuthorityOutcome;
  resolvedVia: PolicyResolutionSource;
  policy: AuthorityPolicy | null;
}

/**
 * One action brought to the authority gate. The substantive request
 * (kind, level, payload, requester, timestamps) is immutable history;
 * only the decision state (`status`, `decidedAt`) ever moves, and only
 * forward: `pending` → `approved`/`rejected` (first decision wins).
 *
 * `evaluation` is the deterministic matrix evaluation that routed the
 * request: `allowed` → status `approved` (policy auto-approval),
 * `forbidden` → status `rejected` (policy rejection), and
 * `approval_required` → status `pending` until a human decides.
 */
export interface ActionRequest {
  id: string;
  tenantId: string;
  actionKind: string;
  authorityLevel: AuthorityLevel;
  /** The proposed action's content — any plain JSON value. */
  payload: unknown;
  justification: string | null;
  /** The principal that requested the action (TenantContext principal). */
  requestedBy: string;
  requestedAt: string;
  /** Emitter-supplied dedupe key; a recorded key replays the original request. */
  idempotencyKey: string | null;
  status: ActionRequestStatus;
  /** When the deciding decision landed; null exactly while pending. */
  decidedAt: string | null;
  evaluation: ActionRequestEvaluation;
}

/** Input shape of `authorizeAction` — the gate itself. */
export interface AuthorizeActionInput {
  actionKind: string;
  authorityLevel: AuthorityLevel;
  /** The proposed action's content — any plain JSON value (non-null, ≤ 1 MiB). */
  payload: unknown;
  justification?: string | null;
  idempotencyKey?: string | null;
}

/**
 * One decision on an action request — the append-only approval trail.
 *
 * A policy decision (`decidedBy: 'policy'`, `principalId: null`) is
 * recorded by `authorizeAction` itself when the matrix auto-allows or
 * forbids the request; a principal decision (`decidedBy: 'principal'`)
 * is recorded by `decideApproval` when a human resolves a pending
 * request. Policy decisions never overwrite the gate outcome and humans
 * never decide requests they requested (separation of duties).
 */
export interface ApprovalDecision {
  id: string;
  tenantId: string;
  requestId: string;
  decision: ApprovalDecisionKind;
  decidedBy: ApprovalDecider;
  /** The deciding principal; null on policy decisions. */
  principalId: string | null;
  note: string | null;
  decidedAt: string;
}

/** Input shape of `decideApproval`. */
export interface DecideApprovalInput {
  requestId: string;
  decision: ApprovalDecisionKind;
  note?: string | null;
}

/** Query shape of `getAuthorityPolicy` (exact key; null = the default row). */
export interface PolicySubjectQuery {
  actionKind?: string | null;
}

/** Query shape of `listAuthorityPolicies`. */
export interface ListAuthorityPoliciesQuery {
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `evaluateActionAuthority` (records nothing). */
export interface EvaluateAuthorityQuery {
  actionKind: string;
  authorityLevel: AuthorityLevel;
}

/** Query shape of `getActionRequest`. */
export interface GetActionRequestQuery {
  requestId: string;
}

/** Query shape of `listActionRequests` (the Approvals surface feed). */
export interface ListActionRequestsQuery {
  actionKind?: string;
  authorityLevel?: AuthorityLevel;
  status?: ActionRequestStatus;
  requestedBy?: string;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `listApprovalDecisions`. */
export interface ListApprovalDecisionsQuery {
  requestId: string;
}
