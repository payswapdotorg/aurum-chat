// ============================================================================
// edge-connector — the ONLY public surface of the edge-connector module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W088 — Aurum Edge Connector:
// "Provide a customer-controlled runtime for private/on-prem APIs, MCP,
//  OpenAPI, databases, files and approved browser adapters."
// Acceptance: outbound-only connection where possible; signed
// tenant-scoped jobs; local secret handling; capability allowlist;
// health/version reporting; result normalization; no second
// organizational truth store.
//
//   THE GATEWAY SIDE (service — PostgreSQL is the only truth store)
//     registerEdgeRuntime — register one customer-controlled edge as a
//        broker-connection-CLASS record (tenant-scoped, open-vocabulary
//        keys, opaque references only; the edge token is stored ONLY as
//        its SHA-256 digest). Duplicate (tenant, edgeKey) is a loud
//        `edge_conflict` — a changed edge is a NEW key (retire the old).
//     retireEdgeRuntime — terminal retirement (evidence, not erasure).
//     updateEdgeAllowlist — the append-only-audited allowlist change
//        (every added/removed key is evidence; the digest moves with it).
//     getEdgeRuntime / listEdgeRuntimes — the registration feed with the
//        honestly-rendered health view (a silent edge is 'stale';
//        a diverged allowlist digest is flagged as drift, never silently
//        trusted).
//     submitEdgeJob — freeze the versioned, tenant-scoped,
//        capability-declared, idempotency-keyed envelope and SIGN it with
//        the wired signer (HMAC-SHA256; the secret is wiring
//        configuration — rows record only the signerKeyRef). First write
//        wins on the idempotency key: a terminal job replays its
//        recorded result (never a second external effect); a failed job
//        (no effect taken) re-drives.
//     claimEdgeJobs — THE OUTBOUND-ONLY CONNECTION POINT: the edge calls
//        in with its key + token and receives only its OWN tenant's
//        pending jobs inside its recorded allowlist scope, each carrying
//        the signed envelope. Claimed jobs hold a lease; an expired
//        lease is swept back to pending (auditable 'reclaimed').
//     reportEdgeJobResult — the normalized result crossing back: bound
//        to the exact signed envelope (digest mismatch = loud
//        `envelope_mismatch`), canonical shapes only (`invalid_edge_result`
//        otherwise — provider objects never cross the edge seam), a
//        refusal is FLAGGED (job 'refused' + evidence), a terminal job
//        replays its recorded outcome.
//     reportEdgeHeartbeat — health/version evidence: version, CURRENT
//        local allowlist digest and last-job stats (append-only status
//        event + report columns).
//
//   THE EDGE RUNTIME (runtime — the code the customer runs)
//     createEdgeRuntime — verify every claimed envelope (signature,
//        tenant, version, idempotency key — machine-readable reasons),
//        RE-CHECK its own allowlist before executing (defense in depth:
//        the gateway's W083 grant is necessary, not sufficient), resolve
//        opaque credentialRefs against its LOCAL secret store, execute
//        through the customer's executor wiring, NORMALIZE results into
//        the canonical deep-action shapes, SCREEN them against its own
//        secret values, and report. Holds only in-flight job scratch
//        (bounded by the claim limit, expiring with the lease).
//     createInMemoryGatewayClient — the deterministic in-process
//        gateway+edge pair (tests, embedded deployments; no real
//        network). Production wires an HTTPS adapter over the same
//        EdgeGatewayClient port.
//
//   THE TRANSPORT ADAPTER (the W084 composition)
//     createEdgeDispatchTransport — a DeepActionTransport whose
//        inspect/execute become signed edge jobs awaiting the edge's
//        normalized report; wire it with the deep-actions contract's
//        setDeepActionTransport to drive the whole gateway pipeline
//        through an edge.
//
// There is deliberately NO operation to rewrite a job's envelope,
// un-sign it, un-report a result or erase audit: the envelope is frozen
// at submit, the signature covers every field, results are immutable
// once reported, and corrections are NEW jobs (the deep-actions
// discipline mirrored onto the edge program).
//
// PROVIDER ISOLATION (lock 16): everything exported below is
// provider-neutral BY CONSTRUCTION. Private systems appear only as the
// open-vocabulary systemClass, the W081 plain-language capability keys
// and opaque external target/receipt strings. Credential VALUES never
// appear here — the opaque credentialRef passes straight through to the
// edge runtime's local secret store (the W082 discipline, one seam
// further out).
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext
// and is tenant-scoped at the SQL layer; another tenant's edges, jobs,
// health or audit rows are indistinguishable from missing
// (`edge_not_found` / `job_not_found`) — no existence leak.
//
// Dependency posture (WORK-ITEM-CATALOG W088 ← W080, W082, W083, W084):
// this module composes over the deep-actions contract only (the
// canonical transport shapes + the transport port it implements). The
// W080 durable-runtime discipline it rides is the claim LEASE (bounded,
// expiring scratch, reclaim sweep); the W082 broker discipline is the
// registration's open-vocabulary connection-class shape; the W083
// progressive-grant posture is the edge-side allowlist re-check; the
// W084 gateway is the transport adapter below.
// ============================================================================

export {
  // the registration lifecycle
  registerEdgeRuntime,
  retireEdgeRuntime,
  updateEdgeAllowlist,
  // registration reads (honest health rendering)
  getEdgeRuntime,
  listEdgeRuntimes,
  // the job lifecycle (submit → claim → report)
  submitEdgeJob,
  claimEdgeJobs,
  reportEdgeJobResult,
  // health/version reporting
  reportEdgeHeartbeat,
  // job reads
  getEdgeJob,
  listEdgeJobs,
  listEdgeJobEvents,
  listEdgeStatusEvents,
  listEdgeAllowlistEvents,
  // the signer wiring (infrastructure, not domain state)
  createHmacSigner,
  setEdgeJobSigner,
  getEdgeJobSigner,
  // the W084 composition (the deep-action transport adapter)
  createEdgeDispatchTransport,
} from './service';

export { createEdgeRuntime, createInMemoryGatewayClient } from './runtime';

export { EdgeConnectorError } from './errors';
export type { EdgeConnectorErrorCode } from './errors';

// Module-owned constants.
export {
  DEFAULT_TRANSPORT_POLL_MS,
  DEFAULT_TRANSPORT_TIMEOUT_MS,
} from './service';

// The pure signed-envelope surface (unit-tested; exported for tests and
// downstream surfaces exactly like the deep-actions reconciliation
// helpers — the envelope is a computation, not an opinion).
export {
  allowlistDigestOf,
  canonicalEnvelopeBytes,
  canonicalJson,
  digestOf,
  envelopeDigest,
  signEnvelope,
  verifySignedEnvelope,
} from './envelope';

// The pure health/staleness surface (unit-tested; the honest rendering).
export {
  DEFAULT_LEASE_MS,
  DEFAULT_STALE_AFTER_MS,
  resolveAllowlistDrift,
  resolveEdgeHealth,
  resolveEdgeHealthView,
} from './health';

// The pure result-normalization + secret-screening surface (unit-tested).
export { MAX_RESULT_BYTES, normalizeEdgeJobResult, screenForSecrets } from './normalize';
export type { EdgeResultNormalization } from './normalize';

// Validation vocabularies + guards (the house pattern).
export {
  DEFAULT_CLAIM_LIMIT,
  DEFAULT_LIST_LIMIT,
  EDGE_ALLOWLIST_CHANGES,
  EDGE_JOB_EVENT_TYPES,
  EDGE_JOB_KINDS,
  EDGE_JOB_STATUSES,
  EDGE_REFUSAL_REASONS,
  EDGE_REGISTRATION_STATUSES,
  EDGE_STATUS_EVENT_TYPES,
  EDGE_SYSTEM_CLASSES,
  MAX_ALLOWLIST_KEYS,
  MAX_CAPABILITY_KEY_LENGTH,
  MAX_CLAIM_LIMIT,
  MAX_EDGE_KEY_LENGTH,
  MAX_EDGE_TOKEN_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_LEASE_MS,
  MAX_LIST_LIMIT,
  MAX_NOTE_LENGTH,
  MAX_REASON_LENGTH,
  MAX_VALUE_BYTES,
  MAX_VERSION_LENGTH,
  MIN_CAPABILITY_KEY_LENGTH,
  MIN_EDGE_TOKEN_LENGTH,
  MIN_LEASE_MS,
  assertEdgeTenantContext,
  checkAllowlist,
  checkEdgeJobRequest,
  isEdgeAllowlistChange,
  isEdgeJobEventType,
  isEdgeJobKind,
  isEdgeJobStatus,
  isEdgeKeyShape,
  isEdgeRegistrationStatus,
  isEdgeStatusEventType,
  isHex64,
  isMachineReadableReason,
  isPlainJsonValue,
  isSystemClassShape,
  isUuid,
} from './validation';

export type {
  ValidatedClaimInput,
  ValidatedGetEdgeQuery,
  ValidatedHeartbeatInput,
  ValidatedListEdgesQuery,
  ValidatedListJobsQuery,
  ValidatedRegisterInput,
  ValidatedReportInput,
  ValidatedRetireInput,
  ValidatedSubmitJobInput,
  ValidatedUpdateAllowlistInput,
} from './validation';

export type {
  ClaimEdgeJobsInput,
  ClaimEdgeJobsResult,
  EdgeAllowlistChange,
  EdgeAllowlistEventView,
  EdgeDispatchTransportConfig,
  EdgeExecutorInput,
  EdgeGatewayClient,
  EdgeHealthView,
  EdgeJobEnvelope,
  EdgeJobEventView,
  EdgeJobEventType,
  EdgeJobExecutor,
  EdgeJobKind,
  EdgeJobOutcome,
  EdgeJobRejectionReason,
  EdgeJobRequest,
  EdgeJobResult,
  EdgeJobSigner,
  EdgeJobStatus,
  EdgeJobView,
  EdgeRegistrationStatus,
  EdgeRegistrationView,
  EdgeResolvedHealth,
  EdgeRuntime,
  EdgeRuntimeStats,
  EdgeScratchEntry,
  EdgeStatusEventView,
  EdgeStatusEventType,
  EnvelopeVerification,
  GetEdgeJobQuery,
  GetEdgeQuery,
  HeartbeatInput,
  ListEdgeAllowlistEventsQuery,
  ListEdgeJobsQuery,
  ListEdgeJobEventsQuery,
  ListEdgeStatusEventsQuery,
  ListEdgesQuery,
  RegisterEdgeInput,
  RegisterEdgeResult,
  ReportEdgeJobInput,
  ReportEdgeJobResult,
  RetireEdgeInput,
  SignedEdgeJob,
  SubmitEdgeJobInput,
  SubmitEdgeJobResult,
  UpdateEdgeAllowlistInput,
} from './types';
export { EDGE_JOB_ENVELOPE_VERSION } from './types';
