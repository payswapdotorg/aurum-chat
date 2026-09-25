// ============================================================================
// capability-grants — the ONLY public surface of the capability-grants
// module (IMPLEMENTATION-STACK §2; cross-module imports of anything else
// are architecture violations detected by scripts/check-architecture.ts).
//
// W083 — Progressive Capability Grants:
// "Start with safe read-only access and request write/action authority
//  only when a concrete task requires it. Make every grant visible,
//  scoped, auditable and revocable."
// Acceptance: initial read-only connection; action invocation produces
// human-readable reason and exact requested scope; denial stops the write;
// later retry can request only the missing capability.
//
//   THE PROGRESSIVE ACCESS LIFECYCLE
//     establishConnectionAccess — the SAFE START. Partitions a connected
//        system's live capability surface (W081 inventory, read through
//        its contract) into what the connection confers on day one (every
//        READ capability — the read-only floor) and what stays WRITE-GATED
//        behind per-task grants. One envelope per (tenant, connection);
//        re-establish refreshes it onto the current surface.
//     getConnectionAccess — the visible envelope: the floor, the gated
//        set, the active grants, the open ask and the connection's current
//        capability mode ('read-only' | 'elevated').
//
//   THE ASK (write/action authority — only when a concrete task requires it)
//     requestCapabilityAuthority — state the task's full capability needs;
//        the module narrows the ask to EXACTLY the missing write
//        capabilities (active grants are never re-asked — "later retry can
//        request only the missing capability"), builds the deterministic
//        human-readable reason (reason.ts: why this permission is necessary
//        for THIS task, in plain organizational language), and routes the
//        ask through the actions contract's authority matrix (W009: action
//        kind 'capability-grant', level EXECUTE — an authority expansion is
//        always consequential). The W009 action payload carries exactly
//        what the approver sees: the reason, the exact requested scope and
//        what the connection already holds. One open ask per connection;
//        a satisfied request creates no gate history at all.
//     decideGrantRequest — the human decision, delegated to the actions
//        contract (the 'actions:approve' claim, separation of duties and
//        first-decision-wins are enforced THERE) and mirrored onto the
//        request. Approval mints the scoped grant; rejection mints
//        nothing — the gate keeps refusing (denial stops the write).
//
//   THE GATE (action invocation — denial stops the write)
//     invokeCapability — the pre-execution authority check (the record
//        W084's deep-action executor consults before carrying a write
//        out). It performs NO side effects: read capabilities are allowed
//        by the floor; write capabilities require an active grant. A
//        denied write invocation is RECORDED in the append-only ledger and
//        returned with its denial — the human-readable reason and the
//        EXACT requested scope (the missing capability, its label, data
//        categories and current ask-state) — so the caller knows precisely
//        what to ask for. An 'allowed' invocation is the authority evidence
//        a subsequent execution links to (invocation id → grant id →
//        request → W009 decision chain).
//
//   REVOCATION
//     revokeCapabilityGrant — takes an active grant back (claim-gated:
//        'capability-grants:administer'), full revocation trail; the
//        covered capabilities are denied from then on (ask-state
//        'revoked').
//
//   VISIBILITY (every grant/request/invocation is readable)
//     getCapabilityGrant / listCapabilityGrants,
//     getGrantRequest / listGrantRequests,
//     getCapabilityInvocation / listCapabilityInvocations,
//     listGrantEvents — the append-only lifecycle audit.
//
// AUDITABILITY: three independent trails — the actions module's
// ActionRequest/ApprovalDecision history (the gate), the append-only
// capability_grant_events ledger (the lifecycle) and the append-only
// capability_invocations ledger (every gate verdict, allowed or denied;
// storage-level immutability triggers in migrations/001).
//
// Provider/broker isolation (lock 16; the W082 discipline): nothing on
// this surface names a provider or a broker. The only provider-adjacent
// values are the OPAQUE connection id inherited from the
// connection-broker's provider-neutral contract and the W081 inventory's
// plain-language capability keys; credential values never appear here.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; another tenant's access, grants,
// requests or invocations are indistinguishable from missing
// (`access_not_found` / `grant_not_found` / `grant_request_not_found` /
// `invocation_not_found`) — no existence leak.
// ============================================================================

export {
  // the progressive access lifecycle
  establishConnectionAccess,
  getConnectionAccess,
  // the ask (progressive authority)
  requestCapabilityAuthority,
  decideGrantRequest,
  // the gate (action invocation)
  invokeCapability,
  // revocation
  revokeCapabilityGrant,
  // the visible surface
  getCapabilityGrant,
  listCapabilityGrants,
  getGrantRequest,
  listGrantRequests,
  getCapabilityInvocation,
  listCapabilityInvocations,
  listGrantEvents,
} from './service';

export { CapabilityGrantsError } from './errors';
export type { CapabilityGrantsErrorCode } from './errors';

// Module-owned constants (the authority claim and the canonical W009
// action kind of a capability-grant ask).
export {
  CAPABILITY_GRANT_ACTION_KIND,
  CAPABILITY_GRANTS_AUTHORITY_ADMINISTER,
} from './service';

// The pure deterministic-reason surface (unit-tested; exported for tests
// and downstream surfaces exactly like the integration-intelligence pure
// helpers — the human-readable language of progressive authority, built
// with no LLM, no clock, no randomness; lock 10).
export {
  buildAuthorityRequestReason,
  buildInvocationDenialReason,
  grantEventDetail,
  joinAnd,
} from './reason';

// Validation vocabularies + guards (the house pattern).
export {
  CAPABILITY_MODES,
  DEFAULT_LIST_LIMIT,
  GRANT_EVENT_TYPES,
  GRANT_REQUEST_STATUSES,
  GRANT_STATUSES,
  INVOCATION_BASES,
  INVOCATION_OUTCOMES,
  MAX_CAPABILITY_KEY_LENGTH,
  MAX_CAPABILITY_KEYS,
  MAX_LIST_LIMIT,
  MAX_NOTE_LENGTH,
  MAX_REQUESTED_FOR_LENGTH,
  MAX_TASK_DESCRIPTION_LENGTH,
  assertGrantsTenantContext,
  findCapability,
  isCapabilityMode,
  isGrantEventType,
  isGrantRequestStatus,
  isGrantStatus,
  isInvocationOutcome,
  isUuid,
  partitionSurface,
  taskContextToRecord,
  validateTaskContext,
} from './validation';
export type { ValidatedTaskContext } from './validation';

export type {
  CapabilityAccess,
  CapabilityAskState,
  CapabilityDenial,
  CapabilityDescriptor,
  CapabilityGrant,
  CapabilityGrantRequest,
  CapabilityInvocation,
  CapabilityMode,
  ConnectionAccessView,
  DecideGrantRequestInput,
  EstablishAccessInput,
  GetAccessQuery,
  GetGrantQuery,
  GetGrantRequestQuery,
  GetInvocationQuery,
  GrantedCapability,
  GrantEventEntry,
  GrantEventType,
  GrantRequestStatus,
  GrantStatus,
  InvocationBasis,
  InvocationOutcome,
  InvokeCapabilityInput,
  ListGrantEventsQuery,
  ListGrantRequestsQuery,
  ListGrantsQuery,
  ListInvocationsQuery,
  RequestAuthorityInput,
  RequestAuthorityResult,
  RequestedCapabilityDetail,
  RevokeGrantInput,
  TaskContext,
} from './types';
