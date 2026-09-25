// Public domain types of the cellular module (W087 — Cellular Reachability
// and Communication Fallback).
//
// W087 owns the OUTCOME-ORIENTED "Reach Anyone" capability over SMS and
// voice cellular fallback (WORK-ITEM-CATALOG; POST-S002 handoff §W087:
// "the Reach Anyone capability over SMS/voice with multiple telecom
// adapters and routing/policy/cost logic"). A manager states an OUTCOME
// — "Tell Sarah the demo moved to 15:00" — and this module resolves the
// recipient, decides the cellular route under tenant policy, delivers
// through telecom provider adapters, tracks delivery and reply state,
// and lets the recipient answer WITHOUT any Internet connection or Aurum
// account (the PSTN is the transport; the phone number is the address).
//
// The layered division of labor (IMPLEMENTATION-STACK "Provider-independent
// reachability"; COMMOS-FUSION-REVIEW fusion rule "Aurum intent → Aurum
// identity/policy → … → provider/transport adapter → delivery evidence →
// Aurum conversation/evidence"):
//
//   * RECIPIENT RESOLUTION (W002): a reach request names a person; the
//     module resolves the person's VERIFIED phone identity through the
//     people/identity contracts (a verified, subject-linked sms/voice
//     identity — lock 15: an unverified phone account never silently
//     becomes an employee). A raw E.164 number is also reachable, but it
//     is classified honestly (`unknown_number` / `unverified_identity`)
//     and gated as an external communication.
//   * AUTHORITY (W009): every reach request passes the actions authority
//     matrix BEFORE anything is sent — 'employee-messaging' for verified
//     employees, 'external-communication' for everyone else, at the ASK
//     level with a stable idempotency key per request (the notifications
//     module's gate discipline). Approval-required requests wait visibly
//     until a human decides; forbidden requests are blocked, never sent.
//   * ROUTING + POLICY + COST (this module): the tenant's cellular policy
//     decides the retry budget, backoff, SMS segment limits, the voice
//     fallback mode, the cost model (integer minor units + ISO currency)
//     and the per-reach cost cap. Every request SNAPSHOTS its resolved
//     policy; later policy edits never rewrite what governs a recorded
//     request (the notifications module's snapshot discipline).
//   * DELIVERY (telecom adapters): SMS sends and voice fallback calls go
//     through this module's provider-neutral transport port; real
//     vendor transports live inside `adapters/` (provider isolation —
//     lock 16 / IMPLEMENTATION-STACK §6). Two canonical telecom providers
//     ('twilio', 'telnyx') keep the vendor replaceable without touching
//     a domain contract — the realtime module's LiveKit/openai-realtime
//     discipline.
//   * DELIVERY/REPLY STATE (this module): append-only attempt rows carry
//     what was sent, through which connection, at what cost, with the
//     provider's receipts; carrier delivery-status webhooks and call
//     lifecycle events update that state through the canonical event
//     edge; failed delivery is terminal, visible and retryable.
//   * REPLIES RETURN INTO AURUM (W030): a recipient reply (SMS text or
//     spoken call turn) is delegated to the channels contract's canonical
//     inbound edge — the relay envelope the channels adapters document
//     (a carrier webhook normalized to Twilio-style field names) — so the
//     reply lands as a canonical conversation transcript turn with
//     on-sight identity registration (W002) exactly like any other
//     channel message. The cellular module additionally correlates the
//     reply to its reach request and records the reply row. A MANAGER
//     with no usable Internet data can do the same thing inbound: text
//     or call Aurum's own number, and the request returns into Aurum
//     through the identical path.
//   * FAILURE VISIBILITY (W031): when a reach request terminally fails
//     or is blocked, the module emits a notification through the
//     notifications contract so the asking manager is told through the
//     ordinary notification delivery machinery (retries, dedupe, its own
//     authority gate) instead of a silent gap.
//
// Everything here is provider-neutral BY CONSTRUCTION (lock 16): telecom
// vendors appear only as the canonical `CellularProvider` key owned by
// this module; vendor-native webhook envelopes, account semantics, call
// descriptors and receipt shapes are parsed inside `adapters/` and never
// leave this module in their raw shape. The only provider-minted values
// on this surface are OPAQUE strings (account ids, message ids, call
// ids, event ids, recording references).
//
// Credential isolation (GOVERNANCE mandatory invariant; IMPLEMENTATION-
// STACK §8): `credentialRef` is an OPAQUE reference into the secret
// store; credential values never reach a domain table, transcript or
// report.

// ---------------------------------------------------------------------------
// Provider vocabulary
// ---------------------------------------------------------------------------

/**
 * Canonical telecom providers (mirrored by the migration CHECKs and the
 * adapter registry). 'twilio' is the P0 carrier the channels module's
 * sms/voice adapters already speak natively; 'telnyx' is the second
 * conforming provider with a materially different envelope shape — the
 * provider-swap evidence that keeps the transport replaceable without a
 * domain rewrite (W086 acceptance property, mirrored).
 */
export type CellularProvider = 'twilio' | 'telnyx';

/** The two cellular legs one reach request can take. */
export type CellularLeg = 'sms' | 'voice';

/**
 * Whether the tenant's policy lets a reach request fall back to a voice
 * call when the SMS leg fails. 'forbidden' (the conservative default —
 * a voice call is intrusive and costs more) or 'on_sms_failure' (the
 * work item's "falls back to voice when policy permits").
 */
export type CellularVoiceFallbackMode = 'forbidden' | 'on_sms_failure';

/** What kind of outcome the asker wants (policy is keyed by this). */
export type CellularReachKind = 'tell' | 'ask';

// ---------------------------------------------------------------------------
// Recipient resolution
// ---------------------------------------------------------------------------

/**
 * How the recipient of a reach request was resolved — the honest
 * classification that drives the authority gate's action kind:
 *
 *  * `verified_employee` — a person with an employment record whose phone
 *    identity is verified and subject-linked (lock 15): gated as
 *    'employee-messaging';
 *  * `verified_person`   — a verified, linked person without an
 *    employment record (an external contact in the directory): gated as
 *    'external-communication';
 *  * `unverified_identity` — a known phone identity that is not verified
 *    and/or not linked: never treated as an employee (lock 15); gated as
 *    'external-communication';
 *  * `unknown_number`    — a raw E.164 number with no registered
 *    identity: gated as 'external-communication'.
 */
export type CellularRecipientKind =
  | 'verified_employee'
  | 'verified_person'
  | 'unverified_identity'
  | 'unknown_number';

// ---------------------------------------------------------------------------
// Connections (tenant-owned telecom accounts)
// ---------------------------------------------------------------------------

/**
 * A tenant-scoped telecom account the tenant reaches people through: one
 * vendor account (a Twilio account, a Telnyx application) with its
 * E.164 sending number (ARCHITECTURE.md §3 — tenants own their
 * channels).
 *
 * `credentialRef` is an OPAQUE secret-store reference; the credential
 * value never reaches any domain table (IMPLEMENTATION-STACK §8).
 */
export interface CellularConnection {
  id: string;
  tenantId: string;
  provider: CellularProvider;
  /** Canonical, adapter-normalized vendor account id (opaque string). */
  providerAccountId: string;
  /** The E.164 number outbound SMS/calls originate from. */
  phoneNumber: string;
  displayName: string | null;
  /** Opaque secret-store reference (never the credential value). */
  credentialRef: string;
  status: CellularConnectionStatus;
  createdBy: string;
  /** ISO 8601 — service clock. */
  createdAt: string;
  /** ISO 8601 — service clock; moves on status/re-authorization changes only. */
  updatedAt: string;
}

export type CellularConnectionStatus = 'active' | 'disabled';

export interface RegisterCellularConnectionInput {
  provider: CellularProvider;
  /** Raw vendor account id; normalized by the vendor's adapter. */
  providerAccountId: string;
  /** E.164 sending number of the account (validated, stored as given). */
  phoneNumber: string;
  displayName?: string | null;
  /** Opaque secret-store reference (never the credential value). */
  credentialRef: string;
}

/**
 * Result of `registerCellularConnection`. Re-registering an EXISTING
 * connection is the re-authorization path: it updates the authorization
 * fields (credential reference, sending number, display name) and reports
 * `created: false` — the endpoint's identity never changes (the realtime
 * module's connection discipline).
 */
export interface RegisterCellularConnectionResult {
  connection: CellularConnection;
  created: boolean;
}

export interface ListCellularConnectionsQuery {
  provider?: CellularProvider;
  status?: CellularConnectionStatus;
  /** 1..500, default 50. */
  limit?: number;
}

export interface SetCellularConnectionStatusInput {
  connectionId: string;
  status: CellularConnectionStatus;
}

// ---------------------------------------------------------------------------
// Policies (tenant-scoped routing/cost controls)
// ---------------------------------------------------------------------------

/**
 * A tenant-scoped cellular policy row. `reachKind` null is the
 * tenant-wide default governing every kind without its own row.
 *
 * Policies are management controls, not evidence: legitimately updatable,
 * with change history belonging to audit (W046) — the notifications
 * module's policy discipline.
 */
export interface CellularPolicy {
  id: string;
  tenantId: string;
  /** 'tell' | 'ask', or null for the tenant-wide default row. */
  reachKind: CellularReachKind | null;
  voiceFallback: CellularVoiceFallbackMode;
  /** SMS delivery attempts per reach cycle (1..10). */
  smsMaxAttempts: number;
  /** Fixed delay between SMS attempts (seconds). */
  retryBackoffSeconds: number;
  /** SMS segments one message may occupy (1..10; longer requests are rejected). */
  maxSmsSegments: number;
  /** Estimated cost of one SMS segment, minor units. */
  smsSegmentCostMinor: number;
  /** Estimated cost of one voice minute, minor units. */
  voicePerMinuteCostMinor: number;
  /** ISO 4217 currency of the two cost fields. */
  currency: string;
  /** Lifetime cost cap per reach request, minor units (0 = uncapped). */
  maxCostPerReachMinor: number;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Input shape of `setCellularPolicy` (upsert by reach-kind key). */
export interface SetCellularPolicyInput {
  /** null/omitted addresses the tenant-wide default row. */
  reachKind?: CellularReachKind | null;
  voiceFallback?: CellularVoiceFallbackMode;
  smsMaxAttempts?: number;
  retryBackoffSeconds?: number;
  maxSmsSegments?: number;
  smsSegmentCostMinor?: number;
  voicePerMinuteCostMinor?: number;
  currency?: string;
  maxCostPerReachMinor?: number;
  note?: string | null;
}

/**
 * The effective rules for one reach kind: what decided (`reachKind`,
 * `source`, `policy`) plus the resolved field values (the built-in
 * floor's values when no tenant row decided, so a resolved policy is
 * always directly usable).
 */
export interface ResolvedCellularPolicy {
  reachKind: CellularReachKind;
  source: CellularPolicySource;
  /** The policy row that decided, or null when the built-in floor did. */
  policy: CellularPolicy | null;
  voiceFallback: CellularVoiceFallbackMode;
  smsMaxAttempts: number;
  retryBackoffSeconds: number;
  maxSmsSegments: number;
  smsSegmentCostMinor: number;
  voicePerMinuteCostMinor: number;
  currency: string;
  maxCostPerReachMinor: number;
}

/** Where a policy resolution came from (the resolution trail). */
export type CellularPolicySource = 'kind' | 'tenant-default' | 'built-in';

/** Query shape of `getCellularPolicy` (exact key; null = the default row). */
export interface CellularPolicySubjectQuery {
  reachKind?: CellularReachKind | null;
}

/** Query shape of `listCellularPolicies`. */
export interface ListCellularPoliciesQuery {
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Reach requests (the outcome-oriented core)
// ---------------------------------------------------------------------------

/**
 * The lifecycle of one reach request. History is the append-only
 * attempt trail; the status is the CURRENT delivery state:
 *
 *   pending ──▶ awaiting_approval ──▶ blocked            (gate rejected)
 *      │              │ (approved between pumps)
 *      │              └──▶ sent ◀──┐
 *      ├──▶ sent ◀─────────────────┘ (SMS accepted by the carrier)
 *      │      │
 *      │      ├──▶ delivered        (carrier DLR confirmed / call answered)
 *      │      ├──▶ replied          (the recipient answered back)
 *      │      ├──▶ voice_fallback   (SMS leg terminal, policy permits voice)
 *      │      │        ├──▶ delivered / replied
 *      │      │        └──▶ failed
 *      │      └──▶ pending          (DLR failed, retry budget remains)
 *      └──▶ failed                  (terminal — visible and retryable)
 *
 * `failed` reopens through `retryCellularReach` (a new delivery cycle);
 * `blocked` does not — the authority decision is stable per request
 * (idempotent gate replay), so a policy change requires a new request.
 */
export type CellularReachStatus =
  | 'pending'
  | 'awaiting_approval'
  | 'blocked'
  | 'sent'
  | 'delivered'
  | 'replied'
  | 'voice_fallback'
  | 'failed';

/**
 * Why a reach request ended up `failed` (diagnostic; the attempts carry
 * the per-leg evidence).
 */
export type CellularFailureCode =
  | 'sms_rejected' // the carrier permanently refused the SMS
  | 'sms_attempts_exhausted' // the SMS retry budget ran out
  | 'cost_cap_exceeded' // the next attempt would exceed the cost cap
  | 'voice_not_permitted' // SMS failed and policy forbids voice fallback
  | 'voice_no_answer' // the fallback call was not answered
  | 'voice_failed' // the fallback call could not be placed
  | 'provider_unavailable'; // no telecom transport is wired

/** One outcome-oriented reach request (the immutable intent + lifecycle). */
export interface CellularReach {
  id: string;
  tenantId: string;
  kind: CellularReachKind;
  recipientKind: CellularRecipientKind;
  /** Resolved person (opaque people.persons.id; null for raw numbers). */
  personId: string | null;
  /** Resolved employment (opaque people.employees.id; null when none). */
  employeeId: string | null;
  /** The phone identity used (opaque identity.identities.id; null for raw numbers). */
  identityId: string | null;
  /** The E.164 number being reached. */
  phoneNumber: string;
  /** The exact message the manager asked Aurum to deliver. */
  text: string;
  /** Explicit sending connection; null = auto-selected per attempt. */
  connectionId: string | null;
  requestedBy: string;
  /** The W009 authority-gate request covering this reach (filled on first gate call). */
  actionRequestId: string | null;
  /** The action kind the request was gated under. */
  actionKind: string;
  status: CellularReachStatus;
  failureCode: CellularFailureCode | null;
  // The policy snapshot governing this request (notifications discipline:
  // later policy edits never rewrite what governs a recorded request).
  policySource: CellularPolicySource;
  voiceFallback: CellularVoiceFallbackMode;
  smsMaxAttempts: number;
  retryBackoffSeconds: number;
  maxSmsSegments: number;
  smsSegmentCostMinor: number;
  voicePerMinuteCostMinor: number;
  currency: string;
  maxCostPerReachMinor: number;
  /** SMS attempts in the CURRENT delivery cycle. */
  smsAttemptsCount: number;
  /** Voice attempts in the CURRENT delivery cycle. */
  voiceAttemptsCount: number;
  /** 1-based delivery cycle; `retryCellularReach` opens the next one. */
  cycle: number;
  /** Lifetime estimated cost of every attempt, minor units. */
  costMinorTotal: number;
  /** ISO 8601 — when the next attempt may run; null = immediately eligible. */
  nextAttemptAt: string | null;
  /** ISO 8601 — first carrier-accepted send; null exactly while never sent. */
  sentAt: string | null;
  /** ISO 8601 — first confirmed delivery (DLR / answered call). */
  deliveredAt: string | null;
  /** ISO 8601 — when a reply was correlated. */
  repliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Input shape of `reachAnyone` — the outcome-oriented ask. */
export interface ReachAnyoneInput {
  /**
   * The person to reach, by directory id ("Tell Sarah …": the calling
   * surface resolves the name to the person and hands the id here). The
   * module requires Sarah to have a VERIFIED phone identity.
   */
  personId?: string | null;
  /**
   * Alternatively, a raw E.164 number to reach (an unverified/unknown
   * recipient — gated as an external communication).
   * Exactly one of personId / phoneNumber must be given.
   */
  phoneNumber?: string | null;
  /** The outcome kind: 'tell' (inform) or 'ask' (request an answer). */
  kind: CellularReachKind;
  /** The message (1..640 chars; the SMS segment policy applies). */
  text: string;
  /** Optional explicit sending connection (auto-selected when omitted). */
  connectionId?: string | null;
  /**
   * Optional notification target for terminal failure/blocking (W031):
   * when the reach terminally fails or is blocked, a notification of kind
   * 'cellular-reach-failed' is created for this canonical channel party
   * through the notifications contract.
   */
  failureNotification?: CellularNotificationTarget | null;
}

/** A canonical channel party a failure notification is delivered to. */
export interface CellularNotificationTarget {
  provider: string;
  providerAccountId: string;
  displayName?: string | null;
}

/** Input shape of `retryCellularReach`. */
export interface RetryCellularReachInput {
  reachRequestId: string;
}

/** Summary of one `pumpCellularReach` run (the worker seam). */
export interface CellularPumpSummary {
  /** Requests the pump considered (pending-due plus awaiting approval). */
  processed: number;
  /** Attempts made (SMS or voice). */
  attempted: number;
  /** Requests newly accepted by the carrier. */
  sent: number;
  /** Requests confirmed delivered. */
  delivered: number;
  /** Requests terminally failed. */
  failed: number;
  /** Requests blocked by the authority gate. */
  blocked: number;
  /** Requests still waiting (gate pending, backoff not elapsed). */
  waiting: number;
  /** Voice fallback legs placed. */
  voiceFallback: number;
}

/** Query shape of `getCellularReach`. */
export interface GetCellularReachQuery {
  reachRequestId: string;
}

/** Query shape of `listCellularReach`. */
export interface ListCellularReachQuery {
  status?: CellularReachStatus;
  personId?: string;
  phoneNumber?: string;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `listCellularAttempts`. */
export interface ListCellularAttemptsQuery {
  reachRequestId: string;
}

/** Query shape of `listCellularReplies`. */
export interface ListCellularRepliesQuery {
  /** Restrict to one reach request's replies; omit for all inbound. */
  reachRequestId?: string | null;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `listCellularEvents`. */
export interface ListCellularEventsQuery {
  provider?: CellularProvider;
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Attempts (append-only delivery audit)
// ---------------------------------------------------------------------------

/**
 * The lifecycle of one delivery attempt's current state (the state
 * changes are carried by the append-only event ledger; the attempt row
 * is the current-state view, mutable only on its lifecycle fields —
 * migrations enforce it).
 */
export type CellularAttemptStatus =
  // SMS legs
  | 'sent' // accepted by the carrier, awaiting the delivery receipt
  | 'delivered' // the carrier confirmed delivery (DLR)
  | 'undelivered' // the carrier reported a failed delivery
  | 'rejected' // the carrier permanently refused the send
  | 'failed' // transport error (transient — retried within the budget)
  // voice legs
  | 'answered' // the fallback call was answered and the message spoken
  | 'no_answer' // the call was not answered
  | 'completed'; // the call ended (duration/recording captured)

/**
 * One delivery attempt: the audit of WHAT was sent, through which
 * connection, at what estimated cost, with the provider's receipts. The
 * substantive fields (leg, text, numbers, gate decision, cost) are
 * history the moment they are written; only the receipt-driven lifecycle
 * fields (status, detail, receipt timestamps, duration, recording
 * reference) ever move, and the database enforces it.
 */
export interface CellularAttempt {
  id: string;
  tenantId: string;
  reachRequestId: string;
  /** 1-based position within the request's full attempt audit. */
  attemptNo: number;
  /** The delivery cycle the attempt belongs to. */
  cycle: number;
  leg: CellularLeg;
  /** The authority-gate decision covering the attempt's request. */
  gateStatus: 'approved' | 'rejected';
  /** Telecom vendor (canonical key). */
  provider: CellularProvider;
  /** The connection the attempt was sent through (null when no leg could be placed). */
  connectionId: string | null;
  fromNumber: string | null;
  toNumber: string;
  /** The exact text sent (SMS body / spoken voice script). */
  text: string;
  /** SMS segments the attempt occupies (null for voice legs). */
  segments: number | null;
  /** Estimated cost of this attempt, minor units (the policy rate). */
  costMinor: number;
  status: CellularAttemptStatus;
  /** The carrier's own message id (SMS receipt correlation). */
  providerMessageId: string | null;
  /** The carrier's own call id (voice event correlation). */
  providerCallId: string | null;
  /** The transport's/provider's human-readable outcome detail. */
  detail: string | null;
  /** ISO 8601 — when the leg was placed. */
  attemptedAt: string;
  /** ISO 8601 — when the carrier's receipt/event last touched this attempt. */
  receiptAt: string | null;
  /** Voice legs: the call duration the carrier reported, when known. */
  durationSeconds: number | null;
  /** Voice legs: the carrier's recording reference (opaque), when captured. */
  recordingUrl: string | null;
}

// ---------------------------------------------------------------------------
// Replies (inbound cellular messages — replies and manager requests)
// ---------------------------------------------------------------------------

/**
 * What an inbound cellular message is relative to the tenant's reach
 * activity:
 *
 *  * `reach_reply`     — a reply correlated to an open reach request
 *    (the recipient answered back; the request moves to `replied`);
 *  * `inbound_request` — a message/call that arrived on the tenant's
 *    number with no open reach request — the manager-originated path:
 *    a manager with no usable Internet data can text/call Aurum and the
 *    request returns into Aurum (transcript + attribution + this row).
 */
export type CellularInboundKind = 'reach_reply' | 'inbound_request';

/**
 * One recorded inbound cellular message. The canonical transcript turn
 * (conversation + message ids, recorded through the channels contract)
 * is referenced opaquely — no cross-module foreign key, the house
 * pattern.
 */
export interface CellularReply {
  id: string;
  tenantId: string;
  /** Which vendor's webhook carried the message. */
  provider: CellularProvider;
  /** The vendor event id (dedupe key — one reply row per event). */
  providerEventId: string;
  inboundKind: CellularInboundKind;
  /** The reach request this reply answered, when correlated. */
  reachRequestId: string | null;
  /** The channel the reply arrived on ('sms' | 'voice'). */
  channel: CellularLeg;
  fromNumber: string;
  toNumber: string;
  /** The reply text (SMS body / recognized speech). */
  text: string;
  /** The sender's phone identity (registered on sight, W002). */
  identityId: string | null;
  /** The person the sender resolved to (verified+linked only; lock 15). */
  personId: string | null;
  /** The sender's employment record, when one exists. */
  employeeId: string | null;
  /** Conversation the reply was transcripted into (channels contract). */
  conversationId: string | null;
  /** The transcript turn (channels contract), when recorded. */
  messageId: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// The provider event edge
// ---------------------------------------------------------------------------

/** The canonical cellular event kinds a vendor adapter can emit. */
export type CellularEventKind =
  | 'sms_reply' // an inbound SMS text
  | 'voice_reply' // recognized speech during a call
  | 'sms_receipt' // a carrier delivery-status report
  | 'call_status'; // a voice call lifecycle event

/** The carrier delivery statuses a receipt reports (terminal ones only). */
export type CellularSmsReceiptStatus = 'delivered' | 'undelivered' | 'failed';

/** The canonical voice call lifecycle states. */
export type CellularCallStatus =
  | 'initiated'
  | 'ringing'
  | 'answered'
  | 'completed'
  | 'no_answer'
  | 'failed';

/** One canonical cellular event, vendor-normalized (module-internal shape). */
export type CanonicalCellularEvent =
  | {
      kind: 'sms_reply';
      provider: CellularProvider;
      /** The tenant's vendor account the envelope belongs to. */
      providerAccountId: string;
      providerEventId: string;
      fromNumber: string;
      toNumber: string;
      text: string;
      /** The carrier's own message id (transcript dedupe). */
      providerMessageId: string;
      sentAt: string | null;
    }
  | {
      kind: 'voice_reply';
      provider: CellularProvider;
      providerAccountId: string;
      providerEventId: string;
      providerCallId: string;
      fromNumber: string;
      toNumber: string;
      speech: string;
      recordingUrl: string | null;
      occurredAt: string | null;
    }
  | {
      kind: 'sms_receipt';
      provider: CellularProvider;
      providerAccountId: string;
      providerEventId: string;
      /** The outbound message the receipt refers to. */
      providerMessageId: string;
      status: CellularSmsReceiptStatus;
      detail: string | null;
      occurredAt: string | null;
    }
  | {
      kind: 'call_status';
      provider: CellularProvider;
      providerAccountId: string;
      providerEventId: string;
      providerCallId: string;
      callStatus: CellularCallStatus;
      durationSeconds: number | null;
      recordingUrl: string | null;
      occurredAt: string | null;
    };

/** Result of `receiveCellularEvent`. */
export interface CellularEventResult {
  /** false when the provider event id was already applied (redelivery dedupe). */
  applied: boolean;
  kind: CellularEventKind;
  /** The reply record, when the event carried an inbound message. */
  reply: CellularReply | null;
  /** The reach request whose state moved, when one did. */
  reach: CellularReach | null;
}

/** Input shape of `receiveCellularEvent` — the telecom webhook edge. */
export interface ReceiveCellularEventInput {
  provider: CellularProvider;
  /** Raw vendor-native JSON envelope (parsed by the vendor's PRIVATE adapter). */
  payload: unknown;
}

/** One applied provider event (the append-only ledger row). */
export interface CellularEventRecord {
  id: string;
  tenantId: string;
  provider: CellularProvider;
  /** The vendor's stable event id (dedupe key). */
  providerEventId: string;
  kind: CellularEventKind;
  /** The connection the envelope resolved onto. */
  connectionId: string | null;
  /** The canonical event as applied (vendor-neutral JSON). */
  event: CanonicalCellularEvent;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Transport port (provider-neutral delivery; implementations are
// module-internal — telecom vendor transports live inside adapters/)
// ---------------------------------------------------------------------------

/** The SMS send request handed to the transport. */
export interface CellularSmsRequest {
  provider: CellularProvider;
  tenantId: string;
  connectionId: string;
  fromNumber: string;
  toNumber: string;
  text: string;
  /** The module's segment estimate (cost control). */
  segments: number;
  /** The reach attempt this send belongs to (the transport's idempotency key). */
  attemptId: string;
}

/** The provider-neutral SMS receipt: 'accepted' = carrier took the message. */
export interface CellularSmsReceipt {
  status: 'accepted' | 'rejected' | 'failed';
  /** The carrier's own message id, when it returns one (receipt correlation). */
  providerMessageId: string | null;
  detail: string | null;
}

/** The voice call request: the transport places the call and speaks the text. */
export interface CellularVoiceRequest {
  provider: CellularProvider;
  tenantId: string;
  connectionId: string;
  fromNumber: string;
  toNumber: string;
  /** The text spoken to the recipient when the call is answered. */
  text: string;
  attemptId: string;
}

/** The provider-neutral voice call receipt. */
export interface CellularVoiceReceipt {
  /** 'answered' = the call was answered and the message spoken. */
  status: 'answered' | 'no_answer' | 'failed';
  /** The carrier's own call id, when it returns one (event correlation). */
  providerCallId: string | null;
  detail: string | null;
}

/**
 * The delivery port real telecom transports implement: one vendor-tagged
 * transport at a time, wired via `setCellularTransport` (the realtime
 * module's discipline — the wired transport's `provider` must match the
 * connection's vendor, else deliveries fail explicitly with
 * `provider_unavailable`). Transports that touch vendor SDKs/HTTP must
 * live inside `src/modules/cellular/adapters/` (IMPLEMENTATION-STACK §6
 * provider isolation); they are wired at process start. No transport is
 * wired by default — deliveries then fail explicitly with
 * `provider_unavailable` (the channels/realtime modules' honest "as
 * provider availability permits").
 */
export interface CellularTransport {
  /** The canonical vendor this transport delivers for. */
  readonly provider: CellularProvider;
  sendSms(request: CellularSmsRequest): Promise<CellularSmsReceipt>;
  placeVoiceCall(request: CellularVoiceRequest): Promise<CellularVoiceReceipt>;
}
