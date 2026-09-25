// ============================================================================
// cellular — the ONLY public surface of the cellular module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W087 — Cellular Reachability and Communication Fallback:
// "Implement outcome-oriented 'Reach Anyone' using SMS and voice, telecom
//  provider adapters, verified phone identity, delivery/reply state,
//  routing, cost and policy controls. Recipient must not need Internet
//  or Aurum."
//
//   registerCellularConnection — register (or RE-AUTHORIZE) one
//      tenant-owned telecom account per vendor account with its E.164
//      sending number. `credentialRef` is an OPAQUE secret-store
//      reference; credential values never reach domain tables.
//      Re-registering updates the authorization fields (credential
//      reference, sending number, display name) and reports
//      `created: false` (the realtime module's connection discipline).
//   getCellularConnection / listCellularConnections /
//   setCellularConnectionStatus — tenant-scoped reads and the
//      enable/disable lifecycle (uniform not-found discipline).
//   setCellularPolicy / getCellularPolicy / resolveCellularPolicy /
//   listCellularPolicies — the ROUTING/COST CONTROLS, keyed by reach
//      kind with a tenant-wide default row and a built-in floor (the
//      actions/notifications resolution discipline): the voice-fallback
//      mode ('forbidden' by default — a voice call is intrusive and
//      costs more; 'on_sms_failure' is the work item's "falls back to
//      voice when policy permits"), the SMS retry budget and backoff,
//      the segment limit, the COST MODEL (integer minor units + ISO
//      currency) and the lifetime cost cap per reach. Policy writes
//      require the 'cellular:administer' claim. Every request SNAPSHOTS
//      its resolved policy; later policy edits never rewrite what
//      governs a recorded request.
//   reachAnyone — the OUTCOME-ORIENTED ASK ("Tell Sarah …"): resolve
//      the recipient — a person's VERIFIED phone identity (W002; lock
//      15: unverified accounts never resolve to employees) or an
//      honestly-classified raw E.164 number — gate the communication
//      through the W009 authority matrix (kind 'employee-messaging' for
//      verified employees, 'external-communication' otherwise, at the
//      ASK level, stable idempotency key per request), record the
//      durable intent, and deliver the first SMS attempt when the gate
//      allows. Approval-required requests wait visibly
//      ('awaiting_approval') until a human decides; forbidden requests
//      are 'blocked', never sent. An optional `failureNotification`
//      target receives a W031 notification on terminal failure/blocking.
//   retryCellularReach — reopen a terminally failed (or stuck
//      in-flight voice) request: a NEW delivery cycle (counters reset,
//      lifetime cost does not — the cap spans every cycle). Blocked
//      requests never reopen: the authority decision is stable per
//      request; a policy change requires a new request.
//   pumpCellularReach — the worker seam: re-check the authority gate of
//      waiting requests (a human approval between pumps unlocks
//      delivery) and deliver due retries (backoff elapsed). Nothing in
//      this module owns background time.
//   receiveCellularEvent — the CELLULAR WEBHOOK EDGE: a carrier
//      envelope (vendor key + raw JSON payload) is parsed by the
//      vendor's PRIVATE adapter into canonical cellular events — SMS
//      replies, voice speech, delivery receipts, call lifecycle.
//      Message-shaped events are delegated to the channels contract's
//      canonical inbound edge (W030) through the relay envelope its
//      adapters document (a carrier webhook normalized to Twilio-style
//      field names; the twilio envelope is that shape natively, the
//      telnyx adapter performs the documented normalization), so every
//      reply lands as a canonical conversation transcript turn with
//      on-sight identity registration (W002) — REPLY AND
//      MANAGER-ORIGINATED REQUESTS RETURN INTO AURUM through the
//      identical path (a manager with no usable Internet data can text
//      or call Aurum's own number). The cellular module additionally
//      correlates the reply to its reach request ('replied') and
//      records the reply row; receipts and call events refine the
//      delivery state (DLR → delivered/undelivered; call answered/
//      completed → delivered). One application per provider event id
//      (the append-only ledger row IS the claim); carrier events that
//      reference no attempt of this tenant are observed and recorded,
//      never errors.
//   getCellularReach / listCellularReach / listCellularAttempts /
//   listCellularReplies / listCellularEvents — the delivery/reply state
//      surface: the request feed (with policy snapshots, attempt
//      counters, cycle, cost and lifecycle timestamps), the append-only
//      attempt audit (what was sent, through which connection, at what
//      estimated cost, with the carrier's receipts), the inbound
//      record (replies + manager-originated requests, with identity/
//      person attribution and transcript references), and the provider
//      event ledger.
//   setCellularTransport / getCellularTransport — infrastructure wiring
//      for the provider-neutral delivery port (sendSms +
//      placeVoiceCall). Vendor transports that touch SDKs/HTTP must
//      live inside this module's adapters/ folder (IMPLEMENTATION-STACK
//      §6 provider isolation); no transport is wired by default, so
//      deliveries fail explicitly with `provider_unavailable`.
//
// PROVIDER ISOLATION (lock 16 / MODULE-DEPENDENCY-MAP provider
// boundaries): everything exported below is provider-neutral by
// construction. Telecom vendors appear only as this module's canonical
// `CellularProvider` key ('twilio' | 'telnyx' — multiple telecom
// adapters, the work item's explicit scope); the only provider-minted
// values on this surface are OPAQUE strings (account ids, message ids,
// call ids, event ids, recording references). Vendor webhook
// envelopes, SDK objects and call descriptors are parsed inside
// `adapters/` and never leave. The transport port is the seam: swapping
// Twilio for Telnyx (or adding a vendor) touches no domain contract —
// the same canonical journey through both vendors yields identical
// canonical domain state modulo provider key + opaque ids.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext
// and is tenant-scoped at the SQL layer; access to another tenant's
// cellular state is reported as `connection_not_found` /
// `reach_not_found` / `policy_not_found` — no existence leak.
//
// Dependency posture (WORK-ITEM-CATALOG W087 ← W002, W009, W030,
// W031): this module imports ONLY module contracts — the identity and
// people contracts (W002 — the verified phone identity resolution and
// reply attribution), the actions contract (W009 — the authority gate
// every reach passes before anything is sent), the channels contract
// (W030 — the canonical inbound edge replies and manager-originated
// requests return into Aurum through) and the notifications contract
// (W031 — the failure/blocking visibility delivered through the
// ordinary notification machinery). The cellular module is the
// reachability/routing/cost authority; the channels module remains the
// generic delivery mechanism, never the reachability decision-maker.
// ============================================================================

export {
  // Connections
  getCellularConnection,
  listCellularConnections,
  registerCellularConnection,
  setCellularConnectionStatus,
  // Policies (routing/cost controls)
  getCellularPolicy,
  listCellularPolicies,
  resolveCellularPolicy,
  setCellularPolicy,
  // Reach — the outcome-oriented core
  reachAnyone,
  retryCellularReach,
  // The worker seam
  pumpCellularReach,
  // The carrier webhook edge
  receiveCellularEvent,
  // Reads
  getCellularReach,
  listCellularAttempts,
  listCellularEvents,
  listCellularReach,
  listCellularReplies,
  // Transport wiring
  getCellularTransport,
  setCellularTransport,
} from './service';

export { CellularError } from './errors';
export type { CellularErrorCode } from './errors';

export {
  // Vocabularies
  CELLULAR_PROVIDERS,
  CELLULAR_LEGS,
  CELLULAR_REACH_KINDS,
  CELLULAR_RECIPIENT_KINDS,
  CELLULAR_REACH_STATUSES,
  CELLULAR_FAILURE_CODES,
  CELLULAR_ATTEMPT_STATUSES,
  CELLULAR_CONNECTION_STATUSES,
  CELLULAR_POLICY_SOURCES,
  CELLULAR_VOICE_FALLBACK_MODES,
  // The built-in floor + pure resolution/routing/cost logic
  BUILT_IN_DEFAULT_POLICY,
  SMS_SEGMENT_CHARACTERS,
  // The W009 gate vocabulary + failure-visibility kind
  CELLULAR_REACH_AUTHORITY_LEVEL,
  CELLULAR_FAILURE_NOTIFICATION_KIND,
  CELLULAR_AUTHORITY_ADMINISTER,
  fitsCostCap,
  isCellularProvider,
  isCellularReachKind,
  isCellularReachStatus,
  isCellularVoiceFallbackMode,
  reachActionKindFor,
  reachGateKey,
  resolveCellularPolicyRows,
  shouldFallBackToVoice,
  smsAttemptCostMinor,
  smsSegmentsOf,
  voiceAttemptCostMinor,
} from './policy';

export {
  DEFAULT_LIST_LIMIT,
  DEFAULT_PUMP_LIMIT,
  MAX_LIST_LIMIT,
  MAX_PUMP_LIMIT,
  MAX_TEXT_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_CREDENTIAL_REF_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_PROVIDER_ACCOUNT_ID_LENGTH,
  MAX_PROVIDER_EVENT_ID_LENGTH,
  MAX_SMS_MAX_ATTEMPTS,
  MAX_MAX_SMS_SEGMENTS,
  MAX_RETRY_BACKOFF_SECONDS,
  MIN_SMS_MAX_ATTEMPTS,
  MIN_MAX_SMS_SEGMENTS,
  MIN_RETRY_BACKOFF_SECONDS,
  canAdministerCellularPolicies,
  isE164,
  isUuid,
  validateCanonicalCellularEvent,
} from './validation';

export type {
  ValidatedListConnectionsQuery,
  ValidatedPolicySubjectQuery,
  ValidatedReachInput,
  ValidatedRegisterConnectionInput,
  ValidatedSetConnectionStatusInput,
  ValidatedSetPolicyInput,
} from './validation';

export type {
  CanonicalCellularEvent,
  CellularAttempt,
  CellularCallStatus,
  CellularConnection,
  CellularConnectionStatus,
  CellularEventKind,
  CellularEventRecord,
  CellularEventResult,
  CellularFailureCode,
  CellularInboundKind,
  CellularLeg,
  CellularNotificationTarget,
  CellularPolicy,
  CellularPolicySource,
  CellularProvider,
  CellularPumpSummary,
  CellularReach,
  CellularReachKind,
  CellularReachStatus,
  CellularRecipientKind,
  CellularReply,
  CellularSmsReceipt,
  CellularSmsReceiptStatus,
  CellularSmsRequest,
  CellularTransport,
  CellularVoiceFallbackMode,
  CellularVoiceReceipt,
  CellularVoiceRequest,
  GetCellularReachQuery,
  ListCellularAttemptsQuery,
  ListCellularConnectionsQuery,
  ListCellularEventsQuery,
  ListCellularPoliciesQuery,
  ListCellularReachQuery,
  ListCellularRepliesQuery,
  ReachAnyoneInput,
  ReceiveCellularEventInput,
  RegisterCellularConnectionInput,
  RegisterCellularConnectionResult,
  ResolvedCellularPolicy,
  RetryCellularReachInput,
  SetCellularConnectionStatusInput,
  SetCellularPolicyInput,
} from './types';
