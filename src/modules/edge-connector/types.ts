// Public domain types of the edge-connector module (W088 — Aurum Edge
// Connector).
//
// W088 owns the CUSTOMER-CONTROLLED RUNTIME half of the integration
// journey's execution model (spec/work-items/WORK-ITEM-CATALOG.md):
//
//   "Provide a customer-controlled runtime for private/on-prem APIs, MCP,
//    OpenAPI, databases, files and approved browser adapters."
//   Acceptance: "outbound-only connection where possible; signed
//    tenant-scoped jobs; local secret handling; capability allowlist;
//    health/version reporting; result normalization; no second
//    organizational truth store."
//
// THE MODEL (three planes, one contract):
//
//   * THE GATEWAY SIDE (service.ts, PostgreSQL): edge registrations (a
//     broker-connection-CLASS record — W082's tenant-scoped, open-
//     vocabulary discipline), the signed job records with their
//     append-only lifecycle audit, and append-only health/status events.
//     Everything durable lives here — Aurum's PostgreSQL is the ONLY
//     organizational truth store.
//
//   * THE JOB ENVELOPE (envelope.ts): the core contract that crosses the
//     seam. Versioned (v1), tenant-scoped (tenantId mandatory),
//     capability-declared, idempotency-keyed and SIGNED (HMAC-SHA256 over
//     the canonical serialization). A job whose signature, tenant, version
//     or idempotency key fails validation is rejected loudly with a
//     machine-readable reason. Replay of an already-executed idempotency
//     key returns the recorded result, never a second external effect.
//
//   * THE EDGE RUNTIME (runtime.ts): the customer-controlled process the
//     tenant runs on their own infrastructure. It INITIATES every
//     connection to the gateway (the outbound-only claim protocol: claim
//     pending jobs for its tenant + allowlist, execute locally, report
//     normalized results). Credentials for the private systems live ONLY
//     on the edge (its local secret store); what crosses the wire is an
//     opaque `credentialRef` at most. The edge re-checks its OWN allowlist
//     before executing (defense in depth — the W083 gateway grant is
//     necessary, not sufficient), normalizes results into the canonical
//     deep-action shapes and screens them against its own secret values
//     before anything is reported. It holds NO domain state beyond
//     in-flight job scratch (bounded by the claim limit, expiring with
//     the claim lease).
//
// PROVIDER ISOLATION (lock 16, the W084 discipline): everything here is
// provider-neutral BY CONSTRUCTION. Private systems appear only as the
// open-vocabulary `systemClass` (api/mcp/openapi/database/file-share/
// browser/… — shape-checked, never a closed CHECK), the W081 plain-
// language capability keys, and opaque external target/receipt strings.
// The canonical request/response shapes are the deep-actions module's
// `DeepActionInspectRequest` / `DeepActionExecuteRequest` / `DeepActionState`
// / `DeepActionReceipt` — result normalization happens AT THE EDGE, so a
// provider-shaped object never even reaches the gateway's transport
// boundary (`invalid_edge_result` here mirrors deep-actions'
// `invalid_transport_result`).
//
// SECRET ISOLATION (GOVERNANCE mandatory invariant, the W082 discipline):
// `credentialRef` is an OPAQUE reference the EDGE resolves against its own
// local secret store; secret VALUES never reach a gateway table, event,
// envelope or error message. The edge token authenticates the edge to the
// gateway by SHA-256 digest only.

import type {
  DeepActionExecuteRequest,
  DeepActionInspectRequest,
  DeepActionReceipt,
  DeepActionState,
} from '@/modules/deep-actions/contract';

// ---------------------------------------------------------------------------
// Vocabularies (mirrored by migration CHECKs where they are closed)
// ---------------------------------------------------------------------------

/**
 * The lifecycle of one edge job:
 *   * 'pending'   — submitted and signed, awaiting an edge claim;
 *   * 'claimed'   — handed to an edge under a claim lease (lease expiry
 *     reverts it to 'pending' — the reclaim path);
 *   * 'succeeded' — the edge reported a CANONICAL result (recorded; a
 *     replay of the idempotency key returns it verbatim);
 *   * 'failed'    — the edge could not carry the job out (transient
 *     executor failure or a transient external receipt: no external
 *     effect was taken; a re-drive of the idempotency key retries);
 *   * 'refused'   — the edge REFUSED per its own policy (allowlist,
 *     signature verification, no executor): refused at the edge AND
 *     flagged at the gateway (the recorded refusal IS the flag).
 */
export type EdgeJobStatus = 'pending' | 'claimed' | 'succeeded' | 'failed' | 'refused';

/** The canonical read/write job kinds (the deep-action transport paths). */
export type EdgeJobKind = 'inspect' | 'execute';

/** The lifecycle of an edge registration (retire is terminal). */
export type EdgeRegistrationStatus = 'active' | 'retired';

/** The append-only edge-job lifecycle audit vocabulary. */
export type EdgeJobEventType =
  | 'created'
  | 'claimed'
  | 'reclaimed'
  | 'succeeded'
  | 'failed'
  | 'refused'
  | 'replayed'
  | 'redriven';

/** The append-only edge status-event vocabulary (health evidence). */
export type EdgeStatusEventType = 'registered' | 'retired' | 'heartbeat' | 'allowlist-changed';

/** The append-only allowlist-audit vocabulary. */
export type EdgeAllowlistChange = 'added' | 'removed';

/**
 * The honestly-rendered resolved health of an edge: a silent edge (no
 * heartbeat within the staleness window, or never seen at all) is
 * 'stale' — never guessed healthy, never hidden.
 */
export type EdgeResolvedHealth = 'healthy' | 'stale';

// ---------------------------------------------------------------------------
// The signed job envelope (the core contract — envelope.ts)
// ---------------------------------------------------------------------------

/** The envelope version this module signs and verifies (forward-only). */
export const EDGE_JOB_ENVELOPE_VERSION = 1;

/** The canonical request a job carries (the deep-action transport shapes). */
export type EdgeJobRequest = DeepActionInspectRequest | DeepActionExecuteRequest;

/** The canonical normalized result a job reports back. */
export type EdgeJobResult = DeepActionState | DeepActionReceipt;

/**
 * The versioned, tenant-scoped, capability-declared, idempotency-keyed
 * job envelope — the ONLY thing that crosses the seam toward the edge.
 * Frozen at submit; signed (HMAC-SHA256) over its canonical
 * serialization; any field tamper breaks the signature.
 */
export interface EdgeJobEnvelope {
  /** The envelope version (forward-only; verifiers reject others loudly). */
  v: typeof EDGE_JOB_ENVELOPE_VERSION;
  /** The job id (equals the gateway job row id; uuid). */
  jobId: string;
  /** MANDATORY tenant scope (uuid) — verified against the claiming edge. */
  tenantId: string;
  /** The edge registration this job is submitted to (open vocabulary). */
  edgeKey: string;
  /** The private-system class the job targets (open vocabulary). */
  systemClass: string;
  /** The job kind: 'inspect' (state read) or 'execute' (canonical write). */
  kind: EdgeJobKind;
  /** The declared capability the job exercises (W081 plain-language key). */
  capabilityKey: string;
  /** The idempotency key (replay of an executed key returns the result). */
  idempotencyKey: string;
  /** The canonical request (never a secret VALUE — a credentialRef at most). */
  request: EdgeJobRequest;
  /** When the gateway submitted the job (ISO 8601). */
  submittedAt: string;
  /** The submitting principal (audit; never a secret). */
  submittedBy: string;
}

/** A signed job: the envelope plus its HMAC-SHA256 signature and key ref. */
export interface SignedEdgeJob {
  envelope: EdgeJobEnvelope;
  /** Hex HMAC-SHA256 over the canonical envelope bytes. */
  signature: string;
  /** The signing key's REFERENCE (wiring identity — never the key itself). */
  signerKeyRef: string;
}

/**
 * Machine-readable rejection reasons of envelope verification (the W088
 * discipline: signature, tenant, version or idempotency failures are
 * rejected with a code, never a vague error). Open vocabulary,
 * shape-checked — first-party codes live in EDGE_REFUSAL_REASONS.
 */
export type EdgeJobRejectionReason =
  | 'invalid_envelope'
  | 'unsupported_version'
  | 'bad_signature'
  | 'tenant_mismatch'
  | 'edge_mismatch'
  | 'invalid_idempotency_key';

/** Verdict of {@link verifySignedEnvelope}: accepted, or a coded rejection. */
export type EnvelopeVerification =
  | { ok: true }
  | { ok: false; reason: EdgeJobRejectionReason; detail: string };

// ---------------------------------------------------------------------------
// The signer (wiring configuration — never persisted plaintext)
// ---------------------------------------------------------------------------

/**
 * The gateway-side job signer. The secret lives ONLY inside the wiring
 * (closure/ambient config); rows record `keyRef`, never the key. Wired
 * via setEdgeJobSigner; submissions without a signer fail loudly
 * (`signer_unavailable`) — the gateway refuses to fake unsigned jobs.
 */
export interface EdgeJobSigner {
  /** The signing key's reference (recorded on jobs; a wiring identity). */
  readonly keyRef: string;
  /** Hex HMAC-SHA256 over the payload bytes. */
  sign(payload: Buffer): string;
}

// ---------------------------------------------------------------------------
// The edge runtime (runtime.ts — the customer-controlled side)
// ---------------------------------------------------------------------------

/**
 * The port through which the edge runtime reaches the gateway. The EDGE
 * initiates every call (the outbound-only connection); the gateway never
 * reaches into the edge. Production wires an HTTPS adapter; tests and
 * embedded deployments wire the in-memory client (createInMemoryGateway
 * Client) — deterministic, no real network.
 */
export interface EdgeGatewayClient {
  /** Claim pending jobs for this edge's tenant + allowlist scope. */
  claimJobs(request: { limit: number; leaseMs: number }): Promise<{ jobs: SignedEdgeJob[] }>;
  /** Report one executed job's outcome (result, failure or refusal). */
  reportJobResult(request: {
    jobId: string;
    executedEnvelopeDigest: string;
    outcome: EdgeJobOutcome;
  }): Promise<{ replayed: boolean }>;
  /** Report heartbeat, version, allowlist digest and last-job stats. */
  heartbeat(request: {
    version: string;
    allowlistDigest: string;
    stats: EdgeRuntimeStats;
  }): Promise<void>;
}

/** One job outcome reported by an edge (canonical result or coded verdict). */
export type EdgeJobOutcome =
  | { kind: 'result'; result: EdgeJobResult }
  | { kind: 'failed'; reason: string }
  | { kind: 'refused'; reason: string };

/** What one executor receives: canonical request + a LOCAL secret resolver. */
export interface EdgeExecutorInput {
  kind: EdgeJobKind;
  capabilityKey: string;
  systemClass: string;
  request: EdgeJobRequest;
  /**
   * Resolve an opaque credentialRef against the edge's LOCAL secret
   * store. Returns null when the ref is unknown — the executor then
   * fails honestly; the VALUE never leaves the edge through this port.
   */
  resolveCredential(credentialRef: string): string | null;
}

/**
 * The executor port: the customer's wiring for one capability against one
 * private system (an HTTP client, an MCP client, a database driver, a
 * file-share mount, an approved browser adapter…). Returns the RAW
 * outcome; the runtime normalizes it into the canonical deep-action
 * shapes and screens it for local secret values before anything is
 * reported. A throw is a local failure (reported as 'executor_error' —
 * the raw message stays on the edge, never crossing with a secret).
 */
export interface EdgeJobExecutor {
  execute(input: EdgeExecutorInput): Promise<unknown>;
}

/** The runtime telemetry an edge reports with every heartbeat. */
export interface EdgeRuntimeStats {
  jobsClaimed: number;
  jobsSucceeded: number;
  jobsFailed: number;
  jobsRefused: number;
  lastJobAt: string | null;
}

/** One in-flight scratch entry of the edge runtime (bounded, expiring). */
export interface EdgeScratchEntry {
  jobId: string;
  capabilityKey: string;
  claimedAt: string;
  expiresAt: string;
}

/** The customer-controlled runtime handle (start/stop + observability). */
export interface EdgeRuntime {
  /** Start the claim/execute/report + heartbeat loop. */
  start(): void;
  /** Stop the loop (in-flight scratch ages out with its leases). */
  stop(): void;
  /** Drive ONE claim→execute→report cycle manually (tests/diagnostics). */
  pollOnce(): Promise<void>;
  /** Send one heartbeat manually (tests/diagnostics). */
  heartbeatOnce(): Promise<void>;
  /**
   * Process ONE already-claimed signed job (the verification → allowlist
   * re-check → execute → normalize → screen → report path). Exposed for
   * tests and controlled drains; pollOnce uses it internally.
   */
  processSignedJob(signed: SignedEdgeJob): Promise<void>;
  /** The in-flight scratch (bounded by the claim limit, expiring with leases). */
  readonly scratch: readonly EdgeScratchEntry[];
  /** The current local allowlist (re-checked before every execution). */
  readonly allowlist: readonly string[];
  /** The local telemetry counters (runtime state, NOT domain truth). */
  readonly stats: EdgeRuntimeStats;
}

// ---------------------------------------------------------------------------
// Persisted views (the gateway side — PostgreSQL is the only truth store)
// ---------------------------------------------------------------------------

/** The resolved, honestly-rendered health of one edge registration. */
export interface EdgeHealthView {
  status: EdgeResolvedHealth;
  /** When the edge was last seen (null = never heartbeat-ed → 'stale'). */
  lastSeenAt: string | null;
  /** The version the edge last reported (null = never reported). */
  reportedVersion: string | null;
  /** The allowlist digest the edge last reported (null = never reported). */
  reportedAllowlistDigest: string | null;
  /**
   * True when the last reported digest differs from the registration's
   * recorded allowlist digest — the edge's local allowlist has DRIFTED
   * from what the gateway has on file (surfaced honestly, never silently
   * trusted; the drift flag is the gateway-side view of the edge-side
   * allowlist re-check being the real enforcement).
   */
  allowlistDrift: boolean;
}

/** One edge registration (a broker-connection-class record, tenant-scoped). */
export interface EdgeRegistrationView {
  id: string;
  tenantId: string;
  edgeKey: string;
  label: string;
  /** Open vocabulary (api/mcp/openapi/database/file-share/browser/…). */
  systemClass: string;
  /** The version declared at registration time. */
  version: string;
  status: EdgeRegistrationStatus;
  /** The recorded allowlist (capability keys) + its digest. */
  allowlist: string[];
  allowlistDigest: string;
  /** Gateway-measured counters (claims and terminal reports observed here). */
  stats: EdgeRuntimeStats;
  health: EdgeHealthView;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** One signed job record (the gateway's durable view of it). */
export interface EdgeJobView {
  id: string;
  tenantId: string;
  edgeId: string;
  edgeKey: string;
  kind: EdgeJobKind;
  systemClass: string;
  capabilityKey: string;
  idempotencyKey: string;
  status: EdgeJobStatus;
  /** Claim attempts (claim + redrive both increment). */
  attempts: number;
  claimedBy: string | null;
  claimedAt: string | null;
  leaseExpiresAt: string | null;
  /** The recorded canonical result (terminal only; verbatim on replay). */
  result: EdgeJobResult | null;
  /** Machine-readable failure code (status 'failed'). */
  failureReason: string | null;
  /** Machine-readable refusal code (status 'refused' — the flag). */
  refusalReason: string | null;
  reportedAt: string | null;
  envelope: EdgeJobEnvelope;
  envelopeDigest: string;
  /** The envelope's HMAC-SHA256 signature (hex) — verifiable by any key holder. */
  signature: string;
  signerKeyRef: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** One append-only edge-job lifecycle event. */
export interface EdgeJobEventView {
  id: string;
  tenantId: string;
  jobId: string;
  position: number;
  event: EdgeJobEventType;
  detail: string | null;
  recordedBy: string;
  recordedAt: string;
}

/** One append-only edge status event (health evidence). */
export interface EdgeStatusEventView {
  id: string;
  tenantId: string;
  edgeId: string;
  event: EdgeStatusEventType;
  /** The edge-reported version (heartbeat/registered rows). */
  version: string | null;
  /** The edge-reported allowlist digest (heartbeat rows). */
  allowlistDigest: string | null;
  /** The edge-reported last-job stats (heartbeat rows). */
  stats: EdgeRuntimeStats | null;
  detail: string | null;
  recordedBy: string;
  occurredAt: string;
}

/** One append-only allowlist-audit row (allowlist changes are audited). */
export interface EdgeAllowlistEventView {
  id: string;
  tenantId: string;
  edgeId: string;
  change: EdgeAllowlistChange;
  capabilityKey: string;
  note: string | null;
  recordedBy: string;
  occurredAt: string;
}

// ---------------------------------------------------------------------------
// Operation inputs
// ---------------------------------------------------------------------------

/** Input of `registerEdgeRuntime` (idempotent per (tenant, edgeKey)). */
export interface RegisterEdgeInput {
  edgeKey: string;
  label: string;
  systemClass: string;
  version: string;
  /** The capability keys this edge declares it will execute. */
  allowlist: string[];
  /**
   * The edge token VALUE — supplied once at registration, stored only as
   * its SHA-256 digest; the edge itself holds the value locally.
   */
  edgeToken: string;
}

/** Result of `registerEdgeRuntime`. */
export interface RegisterEdgeResult {
  registration: EdgeRegistrationView;
  created: boolean;
}

/** Input of `updateEdgeAllowlist` (append-only audited). */
export interface UpdateEdgeAllowlistInput {
  edgeId: string;
  add: string[];
  remove: string[];
  note?: string | null;
}

/** Input of `retireEdgeRuntime`. */
export interface RetireEdgeInput {
  edgeId: string;
}

/** Input of `submitEdgeJob` (signed by the wired signer on first submit). */
export interface SubmitEdgeJobInput {
  edgeKey: string;
  kind: EdgeJobKind;
  capabilityKey: string;
  idempotencyKey: string;
  request: EdgeJobRequest;
}

/** Result of `submitEdgeJob`. */
export interface SubmitEdgeJobResult {
  job: EdgeJobView;
  /** false when an existing idempotency key was replayed or re-driven. */
  created: boolean;
  /** true when a TERMINAL job was replayed (recorded result returned). */
  replayed: boolean;
}

/** Input of `claimEdgeJobs` (the outbound-only claim, edge-authenticated). */
export interface ClaimEdgeJobsInput {
  edgeKey: string;
  /** The edge token VALUE (verified against the stored digest). */
  edgeToken: string;
  /** Max jobs to claim this round (1..64, default 8). */
  limit?: number;
  /** The claim lease (default DEFAULT_LEASE_MS; expiry reverts to pending). */
  leaseMs?: number;
}

/** Result of `claimEdgeJobs`. */
export interface ClaimEdgeJobsResult {
  jobs: SignedEdgeJob[];
  /** Jobs whose expired leases were swept back to pending this round. */
  reclaimedJobIds: string[];
}

/** Input of `reportEdgeJobResult` (the normalized result crossing back). */
export interface ReportEdgeJobInput {
  edgeKey: string;
  edgeToken: string;
  jobId: string;
  /** SHA-256 hex of the canonical envelope the edge actually executed. */
  executedEnvelopeDigest: string;
  outcome: EdgeJobOutcome;
}

/** Result of `reportEdgeJobResult`. */
export interface ReportEdgeJobResult {
  job: EdgeJobView;
  /** true when an already-terminal job's recorded outcome was returned. */
  replayed: boolean;
}

/** Input of `reportEdgeHeartbeat` (health/version/stats evidence). */
export interface HeartbeatInput {
  edgeKey: string;
  edgeToken: string;
  version: string;
  /** Digest of the edge's CURRENT local allowlist (drift is surfaced). */
  allowlistDigest: string;
  stats: EdgeRuntimeStats;
}

/** Query of `getEdgeRuntime` (exactly one of edgeId / edgeKey). */
export interface GetEdgeQuery {
  edgeId?: string;
  edgeKey?: string;
}

/** Query of `listEdgeRuntimes`. */
export interface ListEdgesQuery {
  status?: EdgeRegistrationStatus;
  limit?: number;
}

/** Query of `getEdgeJob`. */
export interface GetEdgeJobQuery {
  jobId: string;
}

/** Query of `listEdgeJobs`. */
export interface ListEdgeJobsQuery {
  status?: EdgeJobStatus;
  edgeKey?: string;
  limit?: number;
}

/** Query of `listEdgeJobEvents`. */
export interface ListEdgeJobEventsQuery {
  jobId: string;
  limit?: number;
}

/** Query of `listEdgeStatusEvents`. */
export interface ListEdgeStatusEventsQuery {
  edgeId: string;
  limit?: number;
}

/** Query of `listEdgeAllowlistEvents`. */
export interface ListEdgeAllowlistEventsQuery {
  edgeId: string;
  limit?: number;
}

/** Configuration of `createEdgeDispatchTransport` (the DeepActionTransport adapter). */
export interface EdgeDispatchTransportConfig {
  /** The tenant context the dispatching pipeline runs under. */
  context: import('@/infra/tenant').TenantContext;
  /** The edge the canonical reads/writes are dispatched to. */
  edgeKey: string;
  /** Result-poll interval in ms (default 250). */
  pollMs?: number;
  /** Give-up horizon in ms (default 30000; the deadline rides the clock). */
  timeoutMs?: number;
}
