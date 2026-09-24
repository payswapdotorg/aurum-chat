// Public domain types of the integration-intelligence module (W081 —
// Integration Intelligence).
//
// W081 owns the authorized-discovery half of the ideal integration journey
// (spec/FINAL-TECH-LEAD-HANDOFF-POST-S002-2026-09-23.md §11):
//
//   Connect organization → Aurum surveys AUTHORIZED tools → explains why
//   each matters → recommends safe connections → admin approves (W009) →
//   automatic verification → tenant-scoped Tool & System Inventory.
//
// Five concepts, one per mandate bullet:
//
//   1. DISCOVERY SOURCES — an admin-authorized grant over a source-adapter
//      connector (the sources module, W036). Discovery happens ONLY through
//      sources an admin explicitly granted; there is deliberately NO
//      network-probing surface in this module at all (no host lists, no
//      port sweeps, no unauthenticated enumeration — the work item forbids
//      uncontrolled scanning, and the only fetch path is the sources
//      module's authenticated polling transport).
//
//   2. TOOL & SYSTEM INVENTORY — tenant-scoped records of every discovered
//      system: identity, capability surface, data categories and health.
//
//   3. WHY-IT-MATTERS EXPLANATIONS — deterministic, outcome-oriented
//      explanations of what connecting a system would unlock, grounded in
//      the org's own goals/unknowns/gaps where available and otherwise in
//      the system's capability classes. Plain organizational language —
//      outcomes (quality, speed, cost, privacy, policy), never provider
//      jargon (§10 UX requirements).
//
//   4. RECOMMENDATIONS — ranked, safe-by-default (read-only) connection
//      proposals with explicit scope impact (what would be read, what
//      stays write-gated), grouped into batches whose approval routes
//      through the actions module's authority matrix (W009) — no
//      consequential connection grant bypasses policy.
//
//   5. AUTOMATIC VERIFICATION — post-connection records of which promised
//      capabilities actually verified reachable.
//
// Provider neutrality (lock 16): nothing here names a provider. A
// discovered system is described by WHAT IT DOES FOR THE ORGANIZATION
// (capability classes, data categories), not by which vendor built it; the
// only provider-adjacent values are the opaque source ids inherited from
// the sources module's provider-neutral contract. Credential values never
// appear on this surface — the sources module's `credentialRef` stays
// opaque and internal to it.

// ---------------------------------------------------------------------------
// Vocabularies (mirrored by migration CHECKs)
// ---------------------------------------------------------------------------

/** Lifecycle of an admin-authorized discovery grant. */
export type DiscoveryGrantStatus = 'active' | 'revoked';

/** Health of a discovered system (latest evidence wins). */
export type SystemHealth = 'unknown' | 'healthy' | 'degraded' | 'unreachable';

/** Connection lifecycle of an inventory system. */
export type SystemConnectionStatus = 'discovered' | 'connected' | 'disconnected';

/** Lifecycle of a connection recommendation. */
export type RecommendationStatus =
  | 'proposed'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'connected';

/** Lifecycle of a recommendation batch (mirrors its W009 action request). */
export type RecommendationBatchStatus =
  | 'pending_request'
  | 'pending_approval'
  | 'approved'
  | 'rejected';

/** Outcome of one verification run. */
export type VerificationStatus = 'pending' | 'verified' | 'partial' | 'failed';

/** Outcome of one capability probe inside a verification run. */
export type VerificationProbeOutcome = 'pending' | 'verified' | 'unreachable';

/** The outcome dimensions §10 lets users care about (canonical order). */
export type OutcomeDimension = 'quality' | 'speed' | 'cost' | 'privacy' | 'policy';

// ---------------------------------------------------------------------------
// Capability-class registry (the plain-language knowledge base)
// ---------------------------------------------------------------------------

/** One class of organizational capability a system can carry. */
export interface CapabilityClass {
  /** Registry key (the canonical identity — never provider-named). */
  key: string;
  /** Plain-language label for surfaces. */
  label: string;
  /** Verb phrase: what connecting would let Aurum do (summary building block). */
  connectionLead: string;
  /** Outcome-oriented statements connecting unlocks (§10 dimensions). */
  outcomes: { dimension: OutcomeDimension; text: string }[];
  /** Keywords used to ground the class in the org's goals/unknowns/gaps. */
  keywords: string[];
  /** What a read-only connection would let Aurum read. */
  readCapabilities: { key: string; label: string }[];
  /** What stays write-gated (progressive authority — §10). */
  writeCapabilities: { key: string; label: string }[];
  /** Data categories this class puts in play. */
  dataCategories: string[];
}

/** One category of organizational data a system may hold. */
export interface DataCategory {
  key: string;
  label: string;
  keywords: string[];
}

// ---------------------------------------------------------------------------
// Why-it-matters explanations
// ---------------------------------------------------------------------------

/** The org context an explanation is grounded in (all optional). */
export interface ExplanationOrgContext {
  goals: { id: string; title: string; text: string }[];
  unknowns: { id: string; question: string; text: string }[];
  gaps: { capabilityId: string; capabilityName: string }[];
}

/** A deterministic explanation of what connecting a system would unlock. */
export interface WhyItMatters {
  /** Whether the org's own goals/unknowns/gaps grounded it, or the classes alone. */
  basis: 'org-context' | 'capability-class';
  /** 1-4 plain-language sentences (§10: outcomes, not technology). */
  summary: string;
  /** The outcome statements connecting would unlock, canonically ordered. */
  outcomes: { dimension: OutcomeDimension; text: string }[];
  /** Which org records grounded the explanation (≤ 3 of each kind, in order). */
  groundedIn: {
    goals: { id: string; title: string }[];
    unknowns: { id: string; question: string }[];
    gaps: { capabilityId: string; capabilityName: string }[];
  };
}

// ---------------------------------------------------------------------------
// Tool & System Inventory
// ---------------------------------------------------------------------------

/** One capability on a system's surface (derived from its classes). */
export interface SystemCapability {
  /** `read.<class>` or `write.<class>` plus any extra class-local keys. */
  key: string;
  capabilityClass: string;
  label: string;
  mode: 'read' | 'write';
  dataCategories: string[];
}

/** A discovered system — one row of the tenant-scoped Tool & System Inventory. */
export interface InventorySystem {
  id: string;
  tenantId: string;
  /** The discovery grant whose authorized poll surfaced this system. */
  grantId: string;
  /** The granted source (sources module id — opaque). */
  sourceId: string;
  /** Canonical identity: `${sourceId}:${externalId}` (tenant-unique). */
  systemKey: string;
  /** The directory's stable opaque id for this system. */
  externalId: string;
  displayName: string;
  description: string | null;
  /** Registry keys (validated vocabulary). */
  capabilityClasses: string[];
  /** The full capability surface (read + write-gated descriptors). */
  capabilities: SystemCapability[];
  /** Sorted union of the categories its capabilities put in play. */
  dataCategories: string[];
  health: SystemHealth;
  connectionStatus: SystemConnectionStatus;
  whyItMatters: WhyItMatters;
  /** Observation ids evidencing the latest discoveries (≤ 10, newest first). */
  evidenceObservationIds: string[];
  discoveredBy: string;
  discoveredAt: string;
  lastObservedAt: string | null;
  updatedAt: string;
}

export interface ListSystemsQuery {
  connectionStatus?: SystemConnectionStatus;
  health?: SystemHealth;
  /** Registry key the system's classes must include. */
  capabilityClass?: string;
  /** Data category the system must cover. */
  dataCategory?: string;
  /** Case-insensitive substring on the display name. */
  search?: string;
  /** 1..500, default 50. */
  limit?: number;
}

export interface GetSystemQuery {
  systemId: string;
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

/** The explicit scope impact of one connection proposal (§10 progressive authority). */
export interface ScopeImpact {
  /** Always 'read-only' in W081 — safe by default (write authority is W083's ask-later path). */
  connectionMode: 'read-only';
  /** What a connection would let Aurum READ. */
  wouldRead: { key: string; label: string; dataCategories: string[] }[];
  /** What stays write-gated behind explicit later authority (W083). */
  staysWriteGated: { key: string; label: string }[];
  /** The data categories in play. */
  dataCategories: string[];
}

/** One ranked, safe-by-default connection proposal. */
export interface Recommendation {
  id: string;
  tenantId: string;
  systemId: string;
  /** Frozen system identity for deterministic ranking (system_key). */
  systemKey: string;
  /** The batch this recommendation was submitted with (null until submitted). */
  batchId: string | null;
  status: RecommendationStatus;
  /** Deterministic value score (see recommend.ts for the formula). */
  score: number;
  connectionMode: 'read-only';
  /** Frozen at proposal time — what the approver was shown. */
  whyItMatters: WhyItMatters;
  scopeImpact: ScopeImpact;
  proposedBy: string;
  proposedAt: string;
  decidedAt: string | null;
  connectedAt: string | null;
  updatedAt: string;
}

export interface ListRecommendationsQuery {
  status?: RecommendationStatus;
  systemId?: string;
  batchId?: string;
  /** 1..500, default 50. */
  limit?: number;
}

export interface GetRecommendationQuery {
  recommendationId: string;
}

// ---------------------------------------------------------------------------
// Batches (bulk approval through the actions authority — W009)
// ---------------------------------------------------------------------------

/** A group of recommendations submitted for one approval decision. */
export interface RecommendationBatch {
  id: string;
  tenantId: string;
  /** The actions module's ActionRequest id (the W009 gate record). */
  actionRequestId: string | null;
  status: RecommendationBatchStatus;
  recommendationCount: number;
  submittedBy: string;
  submittedAt: string;
  decidedAt: string | null;
  updatedAt: string;
}

export interface SubmitBatchInput {
  recommendationIds: string[];
  justification?: string | null;
}

export interface DecideBatchInput {
  batchId: string;
  decision: 'approve' | 'reject';
  note?: string | null;
}

export interface GetRecommendationBatchQuery {
  batchId: string;
}

export interface ListRecommendationBatchesQuery {
  status?: RecommendationBatchStatus;
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface GrantDiscoverySourceInput {
  /** A source registered in THIS tenant (sources module id — opaque). */
  sourceId: string;
  note?: string | null;
}

export interface RevokeDiscoverySourceInput {
  /** The grant id (not the source id — one grant per source per tenant). */
  grantId: string;
}

/** An admin-authorized discovery connector over a registered source. */
export interface DiscoveryGrant {
  id: string;
  tenantId: string;
  sourceId: string;
  status: DiscoveryGrantStatus;
  grantedBy: string;
  grantedAt: string;
  revokedBy: string | null;
  revokedAt: string | null;
  note: string | null;
}

/** Result of `grantDiscoverySource` (re-granting a revoked grant reactivates it). */
export interface GrantDiscoverySourceResult {
  grant: DiscoveryGrant;
  created: boolean;
}

export interface GetDiscoveryGrantQuery {
  grantId: string;
}

export interface ListDiscoveryGrantsQuery {
  status?: DiscoveryGrantStatus;
  /** 1..500, default 50. */
  limit?: number;
}

export interface RunDiscoveryInput {
  /** Poll exactly this granted source; omit/null to poll every actively granted one. */
  sourceId?: string | null;
  /** 1..200 records per source poll (default 100). */
  maxRecords?: number;
}

/** What one granted source's discovery pass produced. */
export interface DiscoverySourceRun {
  grantId: string;
  sourceId: string;
  /** Records the provider returned for this window. */
  fetched: number;
  /** Records that became new observations. */
  ingested: number;
  /** Records suppressed by the sources dedupe ledger. */
  duplicates: number;
  /** Observations that were not directory system records (ignored). */
  ignored: number;
  systemsCreated: number;
  systemsUpdated: number;
  recommendationsCreated: number;
}

export interface DiscoveryRunResult {
  runs: DiscoverySourceRun[];
}

// ---------------------------------------------------------------------------
// Verification (post-connection, automatic)
// ---------------------------------------------------------------------------

/** One capability probe's result inside a verification run. */
export interface VerificationProbeResult {
  capabilityKey: string;
  outcome: VerificationProbeOutcome;
  detail: string | null;
}

/** A post-connection verification record: which promised capabilities verified reachable. */
export interface VerificationRun {
  id: string;
  tenantId: string;
  systemId: string;
  recommendationId: string;
  status: VerificationStatus;
  /** Per promised read-capability probe results (the promised-vs-verified ledger). */
  results: VerificationProbeResult[];
  promisedCount: number;
  verifiedCount: number;
  /** Whether a verification transport was wired when the run was recorded. */
  transportWired: boolean;
  verifiedAt: string | null;
  createdAt: string;
}

export interface ConnectSystemInput {
  /** The APPROVED recommendation to connect (the grant's unit of authority). */
  recommendationId: string;
}

/** Result of `connectSystem` — the connected pair plus its automatic verification run. */
export interface ConnectSystemResult {
  recommendation: Recommendation;
  system: InventorySystem;
  verification: VerificationRun;
}

export interface VerifySystemInput {
  systemId: string;
}

export interface ListVerificationRunsQuery {
  systemId?: string;
  recommendationId?: string;
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Verification transport port (module-internal wiring, sources precedent)
// ---------------------------------------------------------------------------

/** The provider-neutral probe request handed to the verification transport. */
export interface CapabilityProbeRequest {
  systemId: string;
  systemKey: string;
  displayName: string;
  capabilityKey: string;
  capabilityLabel: string;
  dataCategories: string[];
}

/** One probe outcome: is the promised capability reachable through the connection? */
export interface CapabilityProbeResult {
  reachable: boolean;
  detail?: string | null;
}

/**
 * The verification port real transports implement. Implementations that
 * touch providers/HTTP must live at the integration boundary (adapter
 * layer); they are wired at process start via `setVerificationTransport`.
 * No transport is wired by default — explicit verification then refuses
 * with `verification_unavailable` (never a fake success), and connection-
 * time automatic verification records an honest `pending` run.
 */
export interface VerificationTransport {
  probe(request: CapabilityProbeRequest): Promise<CapabilityProbeResult>;
}
