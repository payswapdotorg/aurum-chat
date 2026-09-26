// Public domain types of the edge-connector module (W088 — Aurum Edge
// Connector).
//
// W088 owns the EDGE half of governed private-system execution
// (spec/work-items/WORK-ITEM-CATALOG.md):
//
//   "Provide a customer-controlled runtime for private/on-prem APIs, MCP,
//    OpenAPI, databases, files and approved browser adapters."
//   Acceptance: "outbound-only connection where possible; signed
//    tenant-scoped jobs; local secret handling; capability allowlist;
//    health/version reporting; result normalization; no second
//    organizational truth store."
//
// THE MODEL (each concept a tenant-scoped, auditable record):
//
//   * EdgeRuntime — a customer-controlled runtime registered by a tenant
//     admin. It never receives inbound connections from Aurum where
//     possible: the edge DIALS HOME (heartbeat + job pull + result submit —
//     the transport contract below). A runtime starts 'pending' and
//     becomes 'connected' on its first verified heartbeat; it goes stale
//     when heartbeats stop arriving, and dispatch to anything but a fresh
//     'connected' edge fails explicitly (`edge_not_connected`) — honest
//     degradation, never a fake success.
//   * EdgeAllowlistEntry — what the edge MAY execute/see: one plain-language
//     W081-style capability key (read.*/write.*), the connectivity kind it
//     rides, and the OPAQUE reference to the secret material the EDGE
//     holds locally (plus the scopes that secret covers). Secret VALUES
//     never appear anywhere in Aurum — only opaque references + scopes
//     (local secret handling). The allowlist is checked at DISPATCH
//     (issueEdgeJob) AND again at the EDGE BOUNDARY (the runtime's own
//     local copy refuses jobs outside it).
//   * EdgeHeartbeat — the append-only health/version evidence: reported
//     edge version, capabilities and queue depth, one row per received
//     heartbeat. The runtime row carries the latest report; the heartbeat
//     ledger keeps the history.
//   * EdgeJob — one unit of work for an edge: a canonical, SIGNED,
//     tenant-scoped job envelope (below) plus the durable state it walks
//     through: 'issued' → 'delivered' (pulled over the dial-home link) →
//     'succeeded' | 'rejected' | 'failed' (the edge submitted its result),
//     with 'expired' for envelopes that aged out. The persisted result is
//     EXECUTION EVIDENCE (the canonical receipt +, for inspect jobs, the
//     normalized read state) — never a second organizational truth store:
//     the W084 deep-action pipeline remains the reconciliation authority
//     and records its own evidence through the observations contract.
//   * EdgeEvent — the append-only lifecycle audit of the module.
//
// THE SIGNED JOB ENVELOPE (the only thing that crosses the edge boundary):
//   a plain JSON object {jobId, keyId, tenantId, edgeId, kind, capability-
//   Key, target, payload, credentialRef, systemKey, nonce, issuedAt,
//   expiresAt} plus an HMAC-SHA256 signature over its canonical
//   serialization. It is tenant-scoped (the edge verifies the tenant),
//   capability-scoped (both sides check the allowlist) and
//   replay-resistant (every envelope carries a fresh nonce; a consumed
//   nonce is refused on both sides). Provider objects never cross the
//   boundary — envelopes and canonical results only (lock 16).
//
// THE TRANSPORT CONTRACT (outbound-only posture — edge dials home):
//   a real edge runtime performs exactly three authenticated call shapes
//   against Aurum, in this order, over a connection IT initiates:
//     1. sendEdgeHeartbeat(auth, report)   — liveness + version report;
//     2. pullPendingEdgeJobs(auth, {limit}) — fetch signed envelopes;
//     3. submitEdgeJobResult(auth, result) — submit the canonical result.
//   `auth` is an EdgeAuthentication: tenant + edge ids plus an HMAC proof
//   over a purpose-, tenant-, edge- and nonce-scoped material string,
//   computed with the enrollment key the customer holds (Aurum stores only
//   the OPAQUE key id). The deterministic in-memory simulator exported by
//   this module's contract implements exactly this call sequence, so the
//   protocol is provable without a live network (the fixtures/doubles
//   doctrine; no live network in tests).
//
// RESULT NORMALIZATION (the W084 composition): edge results use the
// deep-actions transport taxonomy VERBATIM — receipts are
// {status: 'accepted' | 'rejected' | 'failed', receiptId, detail} and
// state reads are {found, state} — and `createEdgeDeepActionTransport`
// returns a DeepActionTransport (the W084 port) whose inspect/execute ride
// edge jobs. The deep-action discover→…→verify→reconcile pipeline stays
// the single reconciliation model: this module forks none of it.

// ---------------------------------------------------------------------------
// Vocabularies (mirrored by migration CHECKs)
// ---------------------------------------------------------------------------

/**
 * The connectivity kinds an edge may serve — the work item's surface:
 * private/on-prem APIs, OpenAPI-described endpoints, MCP servers,
 * databases, file shares and approved browser adapters.
 */
export type EdgeConnectivityKind =
  | 'private-api'
  | 'openapi'
  | 'mcp'
  | 'database'
  | 'file-share'
  | 'browser';

/** The lifecycle status of a registered edge runtime. */
export type EdgeRuntimeStatus = 'pending' | 'connected' | 'revoked';

/**
 * The DERIVED health of an edge runtime (computed from status +
 * last-seen freshness, never stored): 'pending' (registered, never
 * heartbeated), 'connected' (fresh heartbeat), 'stale' (heartbeat older
 * than the runtime's stale-after window), 'revoked'.
 */
export type EdgeHealth = 'pending' | 'connected' | 'stale' | 'revoked';

/** The forward-only state of one edge job. */
export type EdgeJobState =
  | 'issued'
  | 'delivered'
  | 'succeeded'
  | 'rejected'
  | 'failed'
  | 'expired';

/**
 * The canonical receipt taxonomy — the W084 deep-action transport
 * vocabulary VERBATIM ('accepted' the edge took the job, 'rejected' a
 * permanent boundary refusal, 'failed' transient — the job stays
 * resumable from the caller's perspective).
 */
export type EdgeReceiptStatus = 'accepted' | 'rejected' | 'failed';

/** The append-only lifecycle event vocabulary. */
export type EdgeEventType =
  | 'registered'
  | 'allowlist-updated'
  | 'heartbeat-received'
  | 'revoked'
  | 'job-issued'
  | 'job-delivered'
  | 'job-succeeded'
  | 'job-failed'
  | 'job-rejected'
  | 'job-expired';

// ---------------------------------------------------------------------------
// The capability allowlist
// ---------------------------------------------------------------------------

/** What an allowlist entry may be asked to do with a capability. */
export type EdgeCapabilityMode = 'read' | 'write';

/** Input shape of one allowlist entry (registration / replacement). */
export interface EdgeAllowlistEntryInput {
  /** The plain-language W081-style capability key ('read.…'/'write.…'). */
  capabilityKey: string;
  /** Which half of the read/write vocabulary the key names. */
  mode: EdgeCapabilityMode;
  /** The connectivity kind this capability rides at the edge. */
  connectivity: EdgeConnectivityKind;
  /**
   * OPAQUE reference to the secret material the EDGE holds locally (e.g.
   * 'edge-vault://crm-readonly'). Aurum persists the reference and its
   * scopes — the VALUE never leaves the customer's edge.
   */
  secretRef: string;
  /** What the referenced secret may access (plain scope strings). */
  secretScopes: string[];
}

/** One persisted allowlist entry of one edge runtime. */
export interface EdgeAllowlistEntry {
  id: string;
  tenantId: string;
  edgeId: string;
  capabilityKey: string;
  mode: EdgeCapabilityMode;
  connectivity: EdgeConnectivityKind;
  secretRef: string;
  secretScopes: string[];
  createdAt: string;
}

// ---------------------------------------------------------------------------
// The edge runtime
// ---------------------------------------------------------------------------

/** Input of `registerEdgeRuntime` (the enrollment record). */
export interface RegisterEdgeRuntimeInput {
  /** Human-readable runtime name, unique within the tenant (1..200). */
  name: string;
  /** Optional plain-language description (1..2000). */
  description?: string | null;
  /**
   * OPAQUE identifier of the enrollment/signing key the customer holds
   * (1..64). Aurum stores the id so the wired signer can be keyed — the
   * key material itself is wiring-time configuration, never persisted.
   */
  signingKeyId: string;
  /** The connectivity kinds this edge is expected to serve (1..6). */
  connectivity: EdgeConnectivityKind[];
  /** The initial capability allowlist (1..64 entries; unique keys). */
  allowlist: EdgeAllowlistEntryInput[];
  /** Heartbeat staleness window in seconds (30..86400, default 300). */
  staleAfterSeconds?: number | null;
  /** Expected heartbeat cadence in seconds (10..86400, default 60). */
  heartbeatIntervalSeconds?: number | null;
}

/** The registered edge runtime (persisted). */
export interface EdgeRuntime {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  status: EdgeRuntimeStatus;
  /** OPAQUE enrollment-key identifier (key material stays customer-side). */
  signingKeyId: string;
  /** Connectivity kinds the runtime is registered to serve. */
  connectivity: EdgeConnectivityKind[];
  /** Latest heartbeat-reported version (null before the first report). */
  reportedVersion: string | null;
  /** Latest heartbeat-reported capabilities (null before the first report). */
  reportedCapabilities: EdgeConnectivityKind[] | null;
  staleAfterSeconds: number;
  heartbeatIntervalSeconds: number;
  /** Time of the last VERIFIED heartbeat (null while pending). */
  lastSeenAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** The full runtime view: the runtime, derived health, and allowlist. */
export interface EdgeRuntimeDetail {
  runtime: EdgeRuntime;
  health: EdgeHealth;
  /** Time of the most recent heartbeat record (null when none). */
  lastHeartbeatAt: string | null;
  allowlist: EdgeAllowlistEntry[];
}

/** A runtime row with its derived health (the list view). */
export interface EdgeRuntimeSummary {
  runtime: EdgeRuntime;
  health: EdgeHealth;
  lastHeartbeatAt: string | null;
}

/** Input of `revokeEdgeRuntime`. */
export interface RevokeEdgeRuntimeInput {
  edgeId: string;
  /** Plain-language reason recorded on the revocation (1..2000). */
  reason?: string | null;
}

/** Input of `setEdgeAllowlist` (wholesale replacement, admin-gated). */
export interface SetEdgeAllowlistInput {
  edgeId: string;
  allowlist: EdgeAllowlistEntryInput[];
}

/** Input of `getEdgeRuntime`. */
export interface GetEdgeRuntimeQuery {
  edgeId: string;
}

/** Query of `listEdgeRuntimes`. */
export interface ListEdgeRuntimesQuery {
  health?: EdgeHealth;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query of `listEdgeHeartbeats`. */
export interface ListEdgeHeartbeatsQuery {
  edgeId: string;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query of `listEdgeEvents`. */
export interface ListEdgeEventsQuery {
  edgeId: string;
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Heartbeats (append-only health/version evidence)
// ---------------------------------------------------------------------------

/** The report an edge submits with each dial-home heartbeat. */
export interface EdgeHeartbeatReport {
  /** The edge's own version string (semver, 1..64). */
  version: string;
  /** Connectivity kinds this running version serves (optional). */
  capabilities?: EdgeConnectivityKind[] | null;
  /** Jobs the edge knows are still awaiting its action (0..1_000_000). */
  pendingJobs?: number | null;
}

/** One received heartbeat (append-only). */
export interface EdgeHeartbeat {
  id: string;
  tenantId: string;
  edgeId: string;
  /** Monotonic per-edge position (the audit feed orders deterministically). */
  position: number;
  reportedVersion: string;
  reportedCapabilities: EdgeConnectivityKind[];
  reportedPendingJobs: number | null;
  receivedAt: string;
}

/** Result of `sendEdgeHeartbeat` (the record + the updated runtime). */
export interface EdgeHeartbeatResult {
  heartbeat: EdgeHeartbeat;
  runtime: EdgeRuntime;
}

/** One append-only lifecycle event of the module (edge- or job-scoped). */
export interface EdgeEvent {
  id: string;
  tenantId: string;
  edgeId: string;
  event: EdgeEventType;
  detail: string | null;
  recordedBy: string;
  recordedAt: string;
}

// ---------------------------------------------------------------------------
// The signed job envelope
// ---------------------------------------------------------------------------

/** What a job asks the edge to do. */
export type EdgeJobKind = 'inspect' | 'execute';

/**
 * THE JOB ENVELOPE — the canonical, provider-neutral unit of work that
 * crosses the edge boundary. Everything on it is plain JSON; the only
 * provider-adjacent values are OPAQUE strings (the credentialRef the edge
 * resolves LOCALLY against its own secret store, and the external target).
 * Secret VALUES never appear on it.
 */
export interface EdgeJobEnvelope {
  /** The job's id (uuid). */
  jobId: string;
  /** The OPAQUE enrollment-key id that signed this envelope. */
  keyId: string;
  /** The owning tenant (the edge verifies this is ITS tenant). */
  tenantId: string;
  /** The edge runtime the job is addressed to. */
  edgeId: string;
  kind: EdgeJobKind;
  /** The plain-language capability this job exercises (allowlist-scoped). */
  capabilityKey: string;
  /** Opaque external entity reference (provider-side id; never interpreted). */
  target: string;
  /** The canonical payload (write payload for 'execute'; null for 'inspect'). */
  payload: unknown;
  /**
   * OPAQUE credential reference passed straight through for the edge to
   * resolve locally (the W082 discipline: values never cross).
   */
  credentialRef: string | null;
  /** Advisory plain-language system key (the W081 descriptor, when known). */
  systemKey: string | null;
  /** Fresh per-job nonce — the replay guard (uuid). */
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

/** An envelope plus its HMAC-SHA256 signature over the canonical form. */
export interface SignedEdgeJobEnvelope {
  envelope: EdgeJobEnvelope;
  signature: string;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/** Input of `issueEdgeJob` (the dispatch call — Aurum side). */
export interface IssueEdgeJobInput {
  edgeId: string;
  kind: EdgeJobKind;
  /** The capability this job exercises (must be in the edge's allowlist). */
  capabilityKey: string;
  /** Opaque external entity reference (1..200). */
  target: string;
  /** The canonical write payload (required object for 'execute'; null for 'inspect'). */
  payload?: Record<string, unknown> | null;
  /** Opaque credential reference passed through to the edge (1..200). */
  credentialRef?: string | null;
  /** Advisory plain-language system key (3..312). */
  systemKey?: string | null;
  /** Caller-supplied dedupe key; a recorded key replays the original
   * outcome — unless the recorded attempt transiently failed or expired,
   * in which case a fresh attempt is issued under an attempt-suffixed
   * key (the W084 retry discipline). */
  idempotencyKey?: string | null;
  /** Envelope lifetime in seconds (10..86400, default 300). */
  ttlSeconds?: number | null;
}

/** Result of `issueEdgeJob`. */
export interface IssueEdgeJobResult {
  job: EdgeJob;
  /** The signed envelope handed to the edge (canonical + signature). */
  envelope: SignedEdgeJobEnvelope;
  /** false when a recorded idempotency key replayed an existing job. */
  created: boolean;
}

/** The persisted edge job — the envelope's durable state and result. */
export interface EdgeJob {
  id: string;
  tenantId: string;
  edgeId: string;
  /** The caller-supplied idempotency key (null when none was given). */
  jobKey: string | null;
  kind: EdgeJobKind;
  capabilityKey: string;
  target: string;
  payload: unknown;
  credentialRef: string | null;
  systemKey: string | null;
  state: EdgeJobState;
  nonce: string;
  /** Canonical receipt of a completed job (the W084 taxonomy). */
  receiptStatus: EdgeReceiptStatus | null;
  /** The edge's opaque receipt id (null when it gave none). */
  receiptId: string | null;
  receiptDetail: string | null;
  /**
   * The normalized read state of a completed 'inspect' job — execution
   * evidence ({found, state}), not organizational truth (W084 owns
   * reconciliation).
   */
  resultState: { found: boolean; state: unknown } | null;
  issuedAt: string;
  expiresAt: string;
  deliveredAt: string | null;
  completedAt: string | null;
  createdBy: string;
}

/** The canonical result an edge submits for one job. */
export interface EdgeJobResult {
  /** The receipt — the W084 transport taxonomy verbatim. */
  receipt: {
    status: EdgeReceiptStatus;
    /** The edge's own opaque receipt id (1..200, null when none). */
    receiptId: string | null;
    detail: string | null;
  };
  /** The normalized read state — REQUIRED for 'inspect' jobs. */
  state?: { found: boolean; state: unknown } | null;
}

/** Query of `getEdgeJob`. */
export interface GetEdgeJobQuery {
  jobId: string;
}

/** Query of `listEdgeJobs`. */
export interface ListEdgeJobsQuery {
  edgeId?: string;
  state?: EdgeJobState;
  /** 1..500, default 50. */
  limit?: number;
}

/** Input of `pullPendingEdgeJobs` (edge dial-home). */
export interface PullPendingEdgeJobsInput {
  /** How many envelopes to pull (1..50, default 10). */
  limit?: number;
}

/** Result of `pullPendingEdgeJobs`. */
export interface PullPendingEdgeJobsResult {
  envelopes: SignedEdgeJobEnvelope[];
  /** How many stale jobs were expired while sweeping the queue. */
  expiredCount: number;
}

/** Input of `submitEdgeJobResult` (edge dial-home). */
export interface SubmitEdgeJobResultInput {
  jobId: string;
  result: EdgeJobResult;
}

/** Result of `submitEdgeJobResult`. */
export interface SubmitEdgeJobResultResult {
  job: EdgeJob;
  /** false when the job was already completed (idempotent first-write-wins). */
  submitted: boolean;
}

// ---------------------------------------------------------------------------
// The dial-home authentication (EdgeAuthentication)
// ---------------------------------------------------------------------------

/** The three authenticated call shapes of the dial-home transport. */
export type EdgeAuthPurpose = 'heartbeat' | 'pull' | 'submit';

/**
 * The edge's dial-home authentication: tenant + edge identity plus an
 * HMAC-SHA256 proof (hex) over the canonical purpose-scoped material
 * string, computed with the enrollment key the CUSTOMER holds. Aurum
 * verifies the proof through the wired signer and never stores the key.
 */
export interface EdgeAuthentication {
  tenantId: string;
  edgeId: string;
  /** Fresh per-call nonce (replayed nonces are refused). */
  requestNonce: string;
  /** HMAC proof over `edge-auth:v1:<purpose>:<tenantId>:<edgeId>:<nonce>`. */
  proof: string;
}

/**
 * The edge signer port — wiring-time infrastructure that holds the
 * enrollment key material (per opaque key id). No signer is wired by
 * default: issuance and verification fail explicitly
 * (`signer_unavailable`) rather than faking success.
 */
export interface EdgeSigner {
  /** HMAC-SHA256 hex signature of `material` under the key `keyId`. */
  sign(keyId: string, material: string): string;
  /** Verifies a signature (false when the key id is unknown). */
  verify(keyId: string, material: string, signature: string): boolean;
}

// ---------------------------------------------------------------------------
// The W084 composition (result normalization)
// ---------------------------------------------------------------------------

/**
 * How the edge's dial-home loop is advanced while a transport call waits:
 * production wiring waits for the edge's own polling loop to complete the
 * job; tests drive the deterministic simulator's dial-home cycle. The
 * transport NEVER opens a connection toward the edge (outbound-only
 * posture) — it issues the job and awaits completion through this hook.
 */
export interface EdgeJobDriver {
  /** Advance the edge until `jobId` reaches a terminal state. */
  (job: { jobId: string }): Promise<void>;
}
