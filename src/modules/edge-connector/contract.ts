// ============================================================================
// edge-connector — the ONLY public surface of the edge-connector module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W088 — Aurum Edge Connector:
// "Provide a customer-controlled runtime for private/on-prem APIs, MCP,
//  OpenAPI, databases, files and approved browser adapters."
// Acceptance: "outbound-only connection where possible; signed
//  tenant-scoped jobs; local secret handling; capability allowlist;
//  health/version reporting; result normalization; no second
//  organizational truth store."
//
//   THE ENROLLMENT LIFECYCLE (tenant admin side)
//     registerEdgeRuntime — enroll a customer-controlled runtime: name,
//        the OPAQUE enrollment-key id (material stays customer-side and
//        in gateway wiring — never persisted), the connectivity kinds it
//        will serve and its INITIAL capability allowlist. One edge per
//        (tenant, name); starts 'pending'.
//     setEdgeAllowlist — replace the persisted allowlist (what the edge
//        may execute/see: capability key + mode + connectivity kind +
//        the OPAQUE secret reference and scopes the EDGE resolves
//        locally). Checked at dispatch AND (the runtime's own local
//        copy) at the edge boundary.
//     revokeEdgeRuntime — close the boundary: the dial-home channel
//        refuses everything afterwards ('edge_revoked').
//     getEdgeRuntime / listEdgeRuntimes / listEdgeHeartbeats /
//     listEdgeEvents — the visible surface: runtime + DERIVED health
//        (pending/connected/stale/revoked — computed from verified
//        heartbeat freshness, never stored), the append-only heartbeat
//        evidence (version/capability reports) and the lifecycle audit.
//
//   THE DIAL-HOME TRANSPORT (edge side — outbound-only; Aurum never
//   opens a connection toward the edge)
//     sendEdgeHeartbeat — liveness + the version/capability report; the
//        first verified heartbeat activates a pending runtime. The proof
//        is an HMAC over purpose/tenant/edge/nonce material with a
//        single-use request nonce (edge_authentication_replayed).
//     pullPendingEdgeJobs — fetch the oldest SIGNED job envelopes (the
//        queue sweeps expired ones first); each pull marks its jobs
//        'delivered'.
//     submitEdgeJobResult — submit the canonical result: the receipt in
//        the W084 taxonomy VERBATIM plus, for inspect jobs, the
//        normalized read state. First-write-wins: a repeated submission
//        returns the original outcome. Non-JSON results are rejected
//        loudly (`invalid_edge_result`) — provider objects never cross.
//
//   THE JOB DISPATCH (Aurum side)
//     issueEdgeJob — create one SIGNED tenant-scoped job envelope:
//        capability-allowlist-checked at dispatch, health-gated (honest
//        degradation `edge_not_connected` when no fresh edge exists),
//        nonce-minted (replay-resistant), idempotent by caller key.
//     verifyEdgeJobEnvelope — the full Aurum-side adjudication of a
//        presented envelope: signature, tenant scope, key id, expiry,
//        allowlist and nonce freshness (a delivered/completed envelope
//        is a replay).
//     getEdgeJob / listEdgeJobs — the job feed (execution state, the
//        canonical receipt, the normalized read state).
//
//   THE W084 COMPOSITION (result normalization — no second model)
//     createEdgeDeepActionTransport — a DeepActionTransport (the W084
//        port, imported from the deep-actions contract) whose
//        inspect/execute ride edge jobs: the deep-action
//        discover→inspect→propose→authorize→execute→verify→reconcile
//        pipeline executes against private/on-prem systems exactly as
//        against brokered SaaS systems, with its OWN evidence,
//        verification and reconciliation unchanged. Receipts use the
//        pipeline's taxonomy verbatim; job results are execution
//        evidence, never a second organizational truth store.
//
//   THE DETERMINISTIC RUNTIME + CONNECTIVITY DOUBLES (test-side, and
//   reference implementations for edge builders)
//     createInMemoryEdgeRuntime — the in-memory edge double that dials
//        home through the REAL contract calls, verifies envelopes with
//        its OWN key material, enforces its OWN local allowlist at the
//        boundary, resolves secret references LOCALLY and dispatches the
//        connectivity adapters (fixtures/doubles doctrine — no live
//        network in tests).
//     createDeterministicConnectivityAdapters + the six double
//     factories — one contract-level adapter per connectivity kind:
//     private-api, openapi, mcp, database, file-share, browser.
//     createHmacSigner — the EdgeSigner factory (wiring-time key
//     material; never persisted).
//
// LOCAL SECRET HANDLING (the acceptance's sharpest edge): Aurum
// persists only OPAQUE secret references + scopes (the allowlist rows)
// and the OPAQUE credentialRef that passes straight through job
// envelopes — secret VALUES never enter any table, envelope, log line
// or contract result; the edge resolves them locally. The enrollment
// key material lives in gateway wiring (wireEdgeSigner) and at the
// edge — only the OPAQUE key id is persisted.
//
// PROVIDER ISOLATION (lock 16): everything exported below is
// provider-neutral BY CONSTRUCTION. External systems appear only as
// plain-language capability keys, opaque external target strings and
// opaque credential references; the only edge-minted values on this
// surface are OPAQUE strings (receipt ids).
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext
// (or, on the dial-home side, an equivalently tenant-scoped
// EdgeAuthentication) and is tenant-scoped at the SQL layer; another
// tenant's edges, jobs, heartbeats, allowlist or events are
// indistinguishable from missing (`edge_not_found` / `job_not_found`)
// — no existence leak.
//
// Dependency posture (WORK-ITEM-CATALOG W088 ← W080, W082, W083, W084):
// W084 is imported directly (the DeepActionTransport shapes — result
// normalization rides the pipeline, never a fork); W082's opaque
// credentialRef discipline and W083's progressive-grants gate are
// exercised through the composed deep-action pipeline (the service
// tests run the full W081→W082→W083→W084 chain over the edge);
// W080's durable-run composition remains the deep-action module's own
// (a native edge-job workflow program is deliberately deferred — see
// the work item's DEFERRED note in the delivery report).
// ============================================================================

export {
  // the enrollment lifecycle (tenant admin side)
  registerEdgeRuntime,
  revokeEdgeRuntime,
  setEdgeAllowlist,
  // the reads (runtime + derived health + evidence)
  getEdgeRuntime,
  listEdgeRuntimes,
  listEdgeHeartbeats,
  listEdgeEvents,
  // the job dispatch (Aurum side)
  issueEdgeJob,
  verifyEdgeJobEnvelope,
  getEdgeJob,
  listEdgeJobs,
  // the dial-home transport (edge side)
  sendEdgeHeartbeat,
  pullPendingEdgeJobs,
  submitEdgeJobResult,
  // the signer port wiring (infrastructure, not domain state)
  wireEdgeSigner,
  getWiredSigner,
  // shared canonicality helper
  isCanonicalEdgeValue,
  // module-owned constants
  EDGE_CONNECTOR_AUTHORITY_ADMINISTER,
} from './service';

// The W084 composition (result normalization).
export { createEdgeDeepActionTransport } from './transport';
export type { CreateEdgeDeepActionTransportOptions } from './transport';

// The signed-envelope core (pure; edge implementers verify with it).
export {
  EDGE_SIGNATURE_HEX_LENGTH,
  canonicalEnvelopeMaterial,
  canonicalJson,
  createHmacSigner,
  edgeAuthMaterial,
  verifyEnvelopeSignature,
} from './envelope';

// The deterministic runtime + connectivity doubles (the W082 adapter
// precedent: first-party doubles are exported through the contract).
export {
  createInMemoryEdgeRuntime,
  type InMemoryEdgeRuntime,
  type InMemoryEdgeRuntimeConfig,
  type LocalAllowlistEntry,
  type EdgeBoundaryRefusal,
  type EdgeExecutionRecord,
} from './runtime/simulator';
export {
  createBrowserDouble,
  createDatabaseDouble,
  createDeterministicConnectivityAdapters,
  createFileShareDouble,
  createMcpDouble,
  createOpenApiDouble,
  createPrivateApiDouble,
  recordAdapters,
  ScriptedEntityStore,
  type ConnectivityDoubleOptions,
  type EdgeAdapterRequest,
  type EdgeAdapterResult,
  type EdgeConnectivityAdapter,
  type ScriptedConnectivityDouble,
} from './runtime/adapters';

export { EdgeConnectorError } from './errors';
export type { EdgeConnectorErrorCode } from './errors';

// Validation vocabularies + guards (the house pattern).
export {
  DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
  DEFAULT_LIST_LIMIT,
  DEFAULT_PULL_LIMIT,
  DEFAULT_STALE_AFTER_SECONDS,
  DEFAULT_TTL_SECONDS,
  EDGE_CONNECTIVITY_KINDS,
  EDGE_EVENT_TYPES,
  EDGE_JOB_KINDS,
  EDGE_JOB_STATES,
  EDGE_RECEIPT_STATUSES,
  EDGE_RUNTIME_STATUSES,
  MAX_ALLOWLIST_ENTRIES,
  MAX_CAPABILITY_KEY_LENGTH,
  MAX_CREDENTIAL_REF_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_HEARTBEAT_PENDING_JOBS,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_LIST_LIMIT,
  MAX_NAME_LENGTH,
  MAX_PAYLOAD_BYTES,
  MAX_PULL_LIMIT,
  MAX_RECEIPT_DETAIL_LENGTH,
  MAX_RECEIPT_ID_LENGTH,
  MAX_REQUEST_NONCE_LENGTH,
  MAX_RESULT_STATE_BYTES,
  MAX_SECRET_REF_LENGTH,
  MAX_SECRET_SCOPES,
  MAX_SECRET_SCOPE_LENGTH,
  MAX_SIGNING_KEY_ID_LENGTH,
  MAX_SYSTEM_KEY_LENGTH,
  MAX_TARGET_LENGTH,
  MAX_VERSION_LENGTH,
  MIN_CAPABILITY_KEY_LENGTH,
  MIN_TTL_SECONDS,
  assertEdgeTenantContext,
  isEdgeConnectivityKind,
  isEdgeEventType,
  isEdgeJobKind,
  isEdgeJobState,
  isEdgeReceiptStatus,
  isEdgeRuntimeStatus,
  isUuid,
  modeOfCapabilityKey,
  readCapabilityKeyOf,
  validateEdgeAuthentication,
  validateEdgeHeartbeatReport,
  validateEdgeJobResult,
  validateIssueEdgeJobInput,
  validateRegisterEdgeRuntimeInput,
  validateSetEdgeAllowlistInput,
  validateVerifyEdgeJobEnvelopeInput,
} from './validation';
export type {
  ValidatedAllowlistEntry,
  ValidatedIssueJobInput,
  ValidatedRegisterInput,
} from './validation';

export type {
  EdgeAllowlistEntry,
  EdgeAllowlistEntryInput,
  EdgeAuthentication,
  EdgeAuthPurpose,
  EdgeCapabilityMode,
  EdgeConnectivityKind,
  EdgeEvent,
  EdgeEventType,
  EdgeHealth,
  EdgeHeartbeat,
  EdgeHeartbeatReport,
  EdgeHeartbeatResult,
  EdgeJob,
  EdgeJobDriver,
  EdgeJobEnvelope,
  EdgeJobKind,
  EdgeJobResult,
  EdgeJobState,
  EdgeReceiptStatus,
  EdgeRuntime,
  EdgeRuntimeDetail,
  EdgeRuntimeStatus,
  EdgeRuntimeSummary,
  EdgeSigner,
  GetEdgeJobQuery,
  GetEdgeRuntimeQuery,
  IssueEdgeJobInput,
  IssueEdgeJobResult,
  ListEdgeHeartbeatsQuery,
  ListEdgeEventsQuery,
  ListEdgeJobsQuery,
  ListEdgeRuntimesQuery,
  PullPendingEdgeJobsInput,
  PullPendingEdgeJobsResult,
  RegisterEdgeRuntimeInput,
  RevokeEdgeRuntimeInput,
  SetEdgeAllowlistInput,
  SignedEdgeJobEnvelope,
  SubmitEdgeJobResultInput,
  SubmitEdgeJobResultResult,
} from './types';
