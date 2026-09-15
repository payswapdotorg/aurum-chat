// ============================================================================
// actions — the ONLY public surface of the actions module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W009 — Policy and Action Authority:
// "Implement OBSERVE/ANALYZE/RECOMMEND/ASK/PROPOSE/EXECUTE authority
//  matrix and deterministic approval gates."
//
// THE AUTHORITY MATRIX (ARCHITECTURE.md §20 — "Actions are classified as
// OBSERVE, ANALYZE, RECOMMEND, ASK, PROPOSE and EXECUTE. Tenant policy
// defines which authority levels and operations require human approval.
// The authority matrix applies uniformly to employee messaging, source
// access, data export, agent recruitment, agent termination, extension
// deployment, external communications and other consequential actions."):
//   setAuthorityPolicy / getAuthorityPolicy / resolveAuthorityPolicy /
//   listAuthorityPolicies — tenant-scoped matrix rows keyed by action
//      kind (any canonical slug; the §20 enumeration is anchored by
//      CANONICAL_ACTION_KINDS), each declaring which levels are gated
//      behind human approval and which are forbidden outright; the NULL
//      kind is the tenant-wide default row. Policies are updatable
//      management controls (not evidence — their change history belongs
//      to audit, W046) and are claim-gated: writing them requires the
//      'actions:administer' authority claim, so a plain member cannot
//      weaken the tenant's own approval gates.
//   evaluateActionAuthority — the read-only evaluation of one
//      (kind, level): resolve (kind row → default row → built-in floor)
//      and evaluate, returning the outcome plus the resolution trail.
//      Records nothing; consequential paths use authorizeAction.
//   evaluateAuthorityMatrix / builtInDefaultMatrix — the PURE
//      deterministic evaluation and the built-in floor, for downstream
//      modules (W013 cognition, W021 agent gateway, W025 extension
//      contracts, W031 notifications) to use without a database. The
//      built-in default: OBSERVE/ANALYZE/RECOMMEND/ASK/PROPOSE are
//      allowed, EXECUTE is approval-gated — consequential execution
//      always awaits an explicit human decision until tenant policy
//      says otherwise (GOVERNANCE.md "high-impact actions are
//      policy-gated").
//
// THE APPROVAL GATES (deterministic — the work item's acceptance core):
//   authorizeAction — record an action request and route it through the
//      matrix deterministically. The evaluation is a pure function of
//      the tenant's policy state and (kind, level) — no LLM, clock,
//      randomness or principal identity participates (authority is
//      application-owned, ARCHITECTURE.md §2/§20). Outcomes:
//        'allowed'           → status 'approved'  (policy auto-approval,
//                              recorded as an immediate POLICY decision);
//        'forbidden'         → status 'rejected'  (policy rejection,
//                              likewise recorded);
//        'approval_required' → status 'pending' — the gate. The request
//                              waits for exactly one human decision.
//      Every request carries its evaluation snapshot (outcome, resolution
//      source, deciding policy), so gate decisions are reconstructable
//      (§24: policy → recommendation → approval → ...). An optional
//      idempotency key replays the original request on retry (first
//      write wins — the events module's semantics).
//   decideApproval — the human decision on a pending request. Requires
//      the 'actions:approve' claim or the kind-scoped
//      'actions:approve:<kind>'; the requesting principal may NEVER
//      decide its own request (separation of duties — Aurum's proposals
//      are decided by authorized humans, §14/§15). First decision wins;
//      approved/rejected are terminal.
//   getActionRequest / listActionRequests / listApprovalDecisions — the
//      approvals surface (§21 "Approvals"): tenant-member-readable
//      request feed (kind/level/status/requester filters) and the
//      append-only decision trail of each request.
//
// There is deliberately NO operation to update or erase a request's
// substantive fields, and NO operation to un-decide, revoke or overwrite
// a decision: requests are history the moment they are recorded and
// decisions are append-only (storage-level triggers, migrations/002 and
// /003). A changed proposal is a NEW request. Learning cannot silently
// override policy (lock 14 mirrored): nothing in this module rewrites a
// gate outcome after the fact.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext
// and is tenant-scoped at the SQL layer; another tenant's requests,
// decisions and policies are indistinguishable from missing ones — no
// existence leak.
//
// Dependency posture: this module imports ONLY src/infra ports — no
// other module's contract. The interim per-module authority claims
// (organizations' 'organizations:provision', identity's
// 'identity:attest'/'identity:link') remain authoritative inside their
// modules until those modules migrate onto this matrix; the claim
// vocabulary below (administer/approve) is the tenant-wide model those
// checks fold into. Observations' workspace visibility and usage tags
// (recorded by W004 "for the policy layer") are consumed by the modules
// that execute those flows (W033/W036/W037) — the matrix governs the
// ACTION authority uniformly, evidence-level permissions stay with the
// evidence-owning modules.
// ============================================================================

export {
  authorizeAction,
  decideApproval,
  evaluateActionAuthority,
  getActionRequest,
  getAuthorityPolicy,
  listActionRequests,
  listApprovalDecisions,
  listAuthorityPolicies,
  resolveAuthorityPolicy,
  setAuthorityPolicy,
} from './service';

export { ActionsError } from './errors';
export type { ActionsErrorCode } from './errors';

export {
  ACTION_REQUEST_STATUSES,
  ACTIONS_AUTHORITY_ADMINISTER,
  ACTIONS_AUTHORITY_APPROVE,
  AUTHORITY_LEVELS,
  AUTHORITY_OUTCOMES,
  CANONICAL_ACTION_KINDS,
  builtInDefaultMatrix,
  canAdminister,
  canApprove,
  evaluateAuthorityMatrix,
  isActionRequestStatus,
  isAuthorityLevel,
  isAuthorityOutcome,
  isCanonicalActionKind,
  kindScopedApproveClaim,
  policyDecisionForOutcome,
  statusForOutcome,
} from './matrix';

export {
  DEFAULT_LIST_LIMIT,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_LIST_LIMIT,
  MAX_PAYLOAD_BYTES,
} from './validation';

export type {
  ValidatedAuthorizeInput,
  ValidatedDecideInput,
  ValidatedPolicyInput,
} from './validation';

export type {
  ActionRequest,
  ActionRequestEvaluation,
  ActionRequestStatus,
  ApprovalDecider,
  ApprovalDecision,
  ApprovalDecisionKind,
  AuthorityEvaluation,
  AuthorityLevel,
  AuthorityLevelsPolicy,
  AuthorityOutcome,
  AuthorityPolicy,
  AuthorizeActionInput,
  CanonicalActionKind,
  DecideApprovalInput,
  EvaluateAuthorityQuery,
  GetActionRequestQuery,
  ListActionRequestsQuery,
  ListApprovalDecisionsQuery,
  ListAuthorityPoliciesQuery,
  PolicyResolutionSource,
  PolicySubjectQuery,
  ResolvedAuthorityPolicy,
  SetAuthorityPolicyInput,
} from './types';
