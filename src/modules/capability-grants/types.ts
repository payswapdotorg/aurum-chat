// Public domain types of the capability-grants module (W083 — Progressive
// Capability Grants).
//
// W083 owns the AUTHORITY half of the integration journey's progressive
// access model (spec/FINAL-TECH-LEAD-HANDOFF-POST-S002-2026-09-23.md §6):
//
//   "Start read-only. Ask for narrowly scoped write/action authority only
//    when a concrete task requires it."
//
// with the acceptance triad:
//
//   1. INITIAL READ-ONLY CONNECTION — `establishConnectionAccess` partitions
//      a connected system's capability surface into what the connection
//      confers on day one (every READ capability — the read-only floor) and
//      what stays WRITE-GATED until a concrete task asks.
//
//   2. ACTION INVOCATION PRODUCES A HUMAN-READABLE REASON AND THE EXACT
//      REQUESTED SCOPE — `invokeCapability` is the pre-execution authority
//      gate (the record W084's executor consults before carrying a write
//      out). A denied write invocation carries `denial`: a deterministic
//      plain-language reason grounded in the concrete task, plus the exact
//      requested scope — the missing capability with its label, data
//      categories and current ask-state.
//
//   3. DENIAL STOPS THE WRITE; A LATER RETRY ASKS ONLY FOR THE MISSING
//      CAPABILITY — `requestCapabilityAuthority` subtracts every capability
//      an active grant already covers before asking (the request row and
//      the W009 action payload carry exactly the missing keys), and a
//      rejected ask mints no grant (the gate keeps refusing).
//
// Every grant is VISIBLE (get/list surface below), SCOPED (capability keys
// + frozen scope detail, validated against the live inventory surface),
// AUDITABLE (the W009 action-request trail, the append-only grant-event
// ledger and the append-only invocation ledger) and REVOCABLE
// (`revokeCapabilityGrant`, claim-gated, full revocation trail).
//
// Provider neutrality (lock 16): nothing here names a provider or a broker.
// The only provider-adjacent values are the OPAQUE connection id inherited
// from the connection-broker contract and the W081 inventory's
// plain-language capability keys. Credential values never appear on this
// surface — they never leave the connection-broker's opaque credentialRef.

// ---------------------------------------------------------------------------
// Vocabularies (mirrored by migration CHECKs)
// ---------------------------------------------------------------------------

/** Lifecycle of a capability grant request (mirrors its W009 action request). */
export type GrantRequestStatus = 'pending_approval' | 'approved' | 'rejected';

/** Lifecycle of a capability grant (the authority record). */
export type GrantStatus = 'active' | 'revoked';

/** The gate's verdict on one capability invocation. */
export type InvocationOutcome = 'allowed' | 'denied';

/** Why the gate decided what it decided (mirrors the invocations CHECK). */
export type InvocationBasis = 'read-only-floor' | 'capability-grant' | 'grant-missing';

/** The mode of a capability on a system's surface (W081 vocabulary). */
export type CapabilityMode = 'read' | 'write';

/**
 * What state the ASK for a write capability is in — the denial detail and
 * the retry path both speak it:
 *   * 'unrequested' — never asked for (the default for a gated capability);
 *   * 'pending'     — an ask is sitting in the W009 gate right now;
 *   * 'rejected'    — an ask was decided against (this write is stopped
 *                     until a NEW concrete task re-asks);
 *   * 'revoked'     — authority existed and was taken back.
 */
export type CapabilityAskState = 'unrequested' | 'pending' | 'rejected' | 'revoked';

// ---------------------------------------------------------------------------
// The concrete task (write/action authority exists only FOR a task)
// ---------------------------------------------------------------------------

/**
 * The concrete task a capability invocation or authority request serves.
 * The work item's discipline: write/action authority is asked for "only
 * when a concrete task requires it" — so every ask and every invocation
 * freezes the task it serves, and every human-readable reason is grounded
 * in it.
 */
export interface TaskContext {
  /** What the task is, in plain organizational language (1..2000 chars). */
  description: string;
  /** Optional plain-language link to what the task is for (a goal, mission, commitment). */
  requestedFor?: string | null;
}

// ---------------------------------------------------------------------------
// Scope descriptors (plain-language, from the W081 inventory surface)
// ---------------------------------------------------------------------------

/**
 * One capability on a system's surface, frozen onto a record exactly as
 * the inventory described it (plain-language descriptor — what the
 * organization can do, and which kinds of data are in play).
 */
export interface CapabilityDescriptor {
  /** The canonical W081 capability key (e.g. 'write.customer-records'). */
  key: string;
  /** Plain-language label (what the organization can do). */
  label: string;
  /** Data categories exercising this capability puts in play. */
  dataCategories: string[];
}

/** A capability being asked for / denied, with its current ask-state. */
export interface RequestedCapabilityDetail extends CapabilityDescriptor {
  state: CapabilityAskState;
}

/** What an active grant covers, as a denial/result tells the caller. */
export interface GrantedCapability {
  key: string;
  label: string;
  grantId: string;
}

// ---------------------------------------------------------------------------
// Access — the read-only envelope
// ---------------------------------------------------------------------------

/**
 * The progressive-access envelope of one broker connection: the safe
 * read-only start. Read capabilities are conferred by the connection
 * itself (the floor); write capabilities stay gated behind per-task
 * grants. One per (tenant, connection).
 */
export interface CapabilityAccess {
  id: string;
  tenantId: string;
  /** The connection-broker connection (opaque id). */
  connectionId: string;
  /** The Tool & System Inventory entry the connection realizes (W081). */
  systemId: string;
  systemKey: string;
  systemDisplayName: string;
  /** Read capabilities conferred by the read-only floor (frozen descriptors). */
  readCapabilities: CapabilityDescriptor[];
  /** Write capabilities gated behind grants (frozen descriptors). */
  writeCapabilities: CapabilityDescriptor[];
  establishedBy: string;
  establishedAt: string;
  updatedAt: string;
}

/** The live view of a connection's progressive access (the visible surface). */
export interface ConnectionAccessView extends CapabilityAccess {
  /** The current capability mode of the connection. */
  connectionMode: 'read-only' | 'elevated';
  /** Active grants and exactly what each covers. */
  activeGrants: GrantedCapability[];
  /** Open asks sitting in the W009 gate (if any). */
  pendingRequestIds: string[];
}

export interface EstablishAccessInput {
  connectionId: string;
}

export interface GetAccessQuery {
  connectionId: string;
}

// ---------------------------------------------------------------------------
// Grant requests — the ask
// ---------------------------------------------------------------------------

/** One ask for write/action authority, routed through the W009 gate. */
export interface CapabilityGrantRequest {
  id: string;
  tenantId: string;
  accessId: string;
  connectionId: string;
  systemId: string;
  /** The actions module's ActionRequest id (the W009 gate record). */
  actionRequestId: string;
  /** The EXACT requested scope — only the keys that were missing. */
  capabilityKeys: string[];
  /** Frozen per-key detail: what the approver was shown. */
  requestedScope: RequestedCapabilityDetail[];
  /** The human-readable why (deterministic; reason.ts). */
  reason: string;
  /** The concrete task the ask serves (frozen). */
  taskContext: TaskContext;
  status: GrantRequestStatus;
  requestedBy: string;
  requestedAt: string;
  decidedAt: string | null;
  updatedAt: string;
}

export interface RequestAuthorityInput {
  connectionId: string;
  /** Every capability key the task needs (the module narrows to the missing subset). */
  capabilityKeys: string[];
  /** The concrete task (why the permission is necessary). */
  taskContext: TaskContext;
}

/** Result of `requestCapabilityAuthority` — what was asked, what already held. */
export interface RequestAuthorityResult {
  /** The created request (the exact missing scope), or null when nothing was missing. */
  request: CapabilityGrantRequest | null;
  /** What an active grant already covered (never re-asked). */
  alreadyGranted: GrantedCapability[];
  /** Read capabilities that came with the connection (no authority needed). */
  conferredReadCapabilities: CapabilityDescriptor[];
}

export interface DecideGrantRequestInput {
  requestId: string;
  decision: 'approve' | 'reject';
  note?: string | null;
}

export interface GetGrantRequestQuery {
  requestId: string;
}

export interface ListGrantRequestsQuery {
  connectionId?: string;
  status?: GrantRequestStatus;
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Grants — the authority records
// ---------------------------------------------------------------------------

/** One scoped, revocable authority record over a connection's capabilities. */
export interface CapabilityGrant {
  id: string;
  tenantId: string;
  accessId: string;
  connectionId: string;
  systemId: string;
  /** The EXACT scope: the capability keys this grant confers. */
  capabilityKeys: string[];
  /** Frozen per-key detail: what the approver approved. */
  scopeDetail: CapabilityDescriptor[];
  status: GrantStatus;
  /** The approved grant request that authorized this grant. */
  grantedVia: string;
  /** The approving principal, or 'policy' when the matrix auto-allowed. */
  grantedBy: string;
  grantedAt: string;
  revokedBy: string | null;
  revokedAt: string | null;
  revocationNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RevokeGrantInput {
  grantId: string;
  note?: string | null;
}

export interface GetGrantQuery {
  grantId: string;
}

export interface ListGrantsQuery {
  connectionId?: string;
  status?: GrantStatus;
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Invocations — the gate
// ---------------------------------------------------------------------------

/** The denial detail a denied write invocation carries (the acceptance core). */
export interface CapabilityDenial {
  /** Human-readable: why the permission is necessary for this task. */
  reason: string;
  /** The EXACT requested scope: the missing capability, fully described. */
  requestedScope: RequestedCapabilityDetail[];
  /** What active grants already cover on this connection (for contrast). */
  alreadyGranted: GrantedCapability[];
}

/** One gate decision: may this connection exercise this capability now? */
export interface CapabilityInvocation {
  id: string;
  tenantId: string;
  accessId: string;
  connectionId: string;
  systemId: string;
  capabilityKey: string;
  capabilityMode: CapabilityMode;
  outcome: InvocationOutcome;
  basis: InvocationBasis;
  /** The grant that authorized an allowed write invocation (null otherwise). */
  grantId: string | null;
  /** The denial detail (null on allowed invocations). */
  denial: CapabilityDenial | null;
  /** The concrete task this invocation served (frozen). */
  taskContext: TaskContext;
  invokedBy: string;
  invokedAt: string;
}

export interface InvokeCapabilityInput {
  connectionId: string;
  /** The single capability the action invokes (the atomic gate unit). */
  capabilityKey: string;
  /** The concrete task the invocation serves. */
  taskContext: TaskContext;
}

export interface GetInvocationQuery {
  invocationId: string;
}

export interface ListInvocationsQuery {
  connectionId?: string;
  capabilityKey?: string;
  outcome?: InvocationOutcome;
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Grant events — the append-only lifecycle audit
// ---------------------------------------------------------------------------

export type GrantEventType =
  | 'access-established'
  | 'authority-requested'
  | 'authority-granted'
  | 'authority-rejected'
  | 'authority-revoked';

/** One append-only lifecycle event of a connection's progressive access. */
export interface GrantEventEntry {
  id: string;
  accessId: string;
  event: GrantEventType;
  detail: string | null;
  recordedBy: string;
  recordedAt: string;
}

export interface ListGrantEventsQuery {
  connectionId: string;
  /** 1..500, default 50. */
  limit?: number;
}
