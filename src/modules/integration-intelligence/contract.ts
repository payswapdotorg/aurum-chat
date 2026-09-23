// ============================================================================
// integration-intelligence — the ONLY public surface of the module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W081 — Integration Intelligence:
// "Discover authorized organizational tooling, explain why connections
//  matter, recommend safe connections, support bulk approval, automatic
//  verification and a tenant-scoped Tool & System Inventory."
//
//   DISCOVERY SOURCES (the admin gate — no scanning, ever)
//     grantDiscoverySource — an admin (holding the
//        'integration-intelligence:administer' claim) authorizes a
//        registered source connector (W036) as a discovery source.
//        Re-granting a revoked grant reactivates it. This grant is the
//        ONLY authorization to discover: runDiscovery refuses un-granted,
//        cross-tenant and revoked sources with `discovery_not_authorized`
//        BEFORE any transport interaction — probing, port-scanning and
//        unauthenticated enumeration do not exist in this module at all
//        (the only fetch path is the sources module's authenticated
//        polling transport).
//     revokeDiscoverySource — the admin takes the authorization back;
//        discovery through that source refuses from then on.
//     getDiscoveryGrant / listDiscoveryGrants — tenant-scoped reads.
//     runDiscovery — poll the actively granted source(s) through the
//        sources contract; directory records become immutable
//        observations (W004, lineage `connector`), and each discovered
//        system is upserted into the tenant-scoped Tool & System
//        Inventory with its capability surface, data categories, health
//        and a deterministic why-it-matters explanation. A system with no
//        live recommendation gets a safe-by-default (read-only) one.
//
//   TOOL & SYSTEM INVENTORY (tenant-scoped — every row carries tenant_id)
//     getSystem / listSystems — filtered reads (connection status,
//        health, capability class, data category, name search).
//
//   RECOMMENDATIONS (ranked, safe-by-default, scope-explicit)
//     getRecommendation / listRecommendations — the proposal feed,
//        deterministically ordered (score DESC, system key ASC). Every
//        recommendation carries the frozen explanation the approver was
//        shown and the explicit scope impact: what would be READ and what
//        STAYS WRITE-GATED (write authority is W083's ask-later path).
//
//   BULK APPROVAL (through the actions module's authority — W009)
//     submitRecommendationBatch — submits 1..100 proposed recommendations
//        as ONE consequential action through the actions contract
//        (action kind 'integration-connection', authority level EXECUTE).
//        The built-in default matrix gates EXECUTE behind human approval,
//        so the batch sits `pending_approval` until decided; tenant
//        policy may auto-allow (policy approval) or forbid (policy
//        rejection) — either way the grant decision is W009's, never
//        bypassed. The approver-facing payload carries each system's
//        outcome-oriented explanation and scope impact.
//     decideRecommendationBatch — the human decision, delegated to the
//        actions contract (the 'actions:approve' claim, separation of
//        duties and first-decision-wins are enforced THERE) and mirrored
//        onto the batch and its recommendations.
//     getRecommendationBatch / listRecommendationBatches — batch reads.
//
//   AUTOMATIC VERIFICATION (post-connection)
//     connectSystem — transitions an APPROVED recommendation to connected
//        and records an automatic verification run for every promised
//        read capability: with a wired verification transport, which
//        capabilities actually verified reachable; without one, an honest
//        `pending` run (never a fake success — the sources module's
//        provider_unavailable discipline).
//     verifySystem — explicit re-verification of a connected system
//        (requires a wired transport; refuses `verification_unavailable`).
//     listVerificationRuns — the promised-vs-verified ledger.
//     setVerificationTransport / getVerificationTransport —
//        infrastructure wiring for the provider-neutral probe port (the
//        sources module's transport-port precedent; no default wired).
//
// DETERMINISM (lock 10 discipline): explanations, scores and scope impact
// are pure functions (explain.ts / recommend.ts, exported below for tests
// and downstream surfaces) of the discovered capability surface and the
// org's current goals (W008), unknowns (W007) and capability gaps (W017),
// read through their public contracts only. No LLM, no clock, no
// randomness participates.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; another tenant's grants, systems,
// recommendations, batches or verification runs are indistinguishable from
// missing ones — no existence leak, and discovery through another loan's
// source is refused as unauthorized (grants are tenant-scoped).
//
// Provider isolation (lock 16): nothing on this surface names a provider.
// The only provider-adjacent values are the OPAQUE source ids inherited
// from the sources module's provider-neutral contract; credential values
// never appear here at all.
// ============================================================================

export {
  // discovery sources (the admin gate)
  grantDiscoverySource,
  revokeDiscoverySource,
  getDiscoveryGrant,
  listDiscoveryGrants,
  // the authorized survey
  runDiscovery,
  // tool & system inventory
  getSystem,
  listSystems,
  // recommendations
  getRecommendation,
  listRecommendations,
  // bulk approval through the actions authority (W009)
  submitRecommendationBatch,
  decideRecommendationBatch,
  getRecommendationBatch,
  listRecommendationBatches,
  // connection + automatic verification
  connectSystem,
  verifySystem,
  listVerificationRuns,
  // verification transport wiring (infrastructure, not domain state)
  setVerificationTransport,
  getVerificationTransport,
} from './service';

export { IntegrationError } from './errors';
export type { IntegrationErrorCode } from './errors';

// Module-owned constants (the authority claim and the canonical W009
// action kind of a consequential system connection).
export {
  INTEGRATION_ACTION_KIND,
  INTEGRATION_AUTHORITY_ADMINISTER,
} from './service';

// The canonical directory-record convention (what a discovery source's
// adapter/transport emits) and the pure derivation helpers.
export {
  DISCOVERY_RECORD_KIND,
  classifyDirectoryRecord,
  deriveCapabilitySurface,
  systemKeyOf,
} from './discovery';
export type { DiscoveredSystemManifest } from './discovery';

// The pure deterministic-intelligence surface (unit-tested; the capabilities
// module's gap.ts precedent for exporting pure logic through contracts).
export { explainWhyItMatters, joinAnd, keywordMatchesToken, keywordsForSystem, textMatchesKeywords, tokenize } from './explain';
export { SCORE_WEIGHTS, buildRecommendationDraft, scopeImpactOf, scoreRecommendation } from './recommend';

// The plain-language capability-class registry (read-only knowledge base —
// labels for surfaces; provider-neutral by construction).
export {
  CAPABILITY_CLASSES,
  CAPABILITY_CLASS_KEYS,
  DATA_CATEGORIES,
  DATA_CATEGORY_KEYS,
  OUTCOME_DIMENSION_ORDER,
  capabilityClassOf,
  dataCategoryOf,
} from './vocabulary';

// Validation vocabularies + guards (the house pattern).
export {
  DEFAULT_DISCOVERY_MAX_RECORDS,
  DEFAULT_LIST_LIMIT,
  DISCOVERY_GRANT_STATUSES,
  MAX_BATCH_RECOMMENDATIONS,
  MAX_DISCOVERY_MAX_RECORDS,
  MAX_EVIDENCE_OBSERVATIONS,
  MAX_LIST_LIMIT,
  RECOMMENDATION_BATCH_STATUSES,
  RECOMMENDATION_STATUSES,
  SYSTEM_CONNECTION_STATUSES,
  SYSTEM_HEALTHS,
  assertIntegrationTenantContext,
  isDiscoveryGrantStatus,
  isRecommendationBatchStatus,
  isRecommendationStatus,
  isSystemConnectionStatus,
  isSystemHealth,
  isUuid,
} from './validation';

export type {
  ValidatedGrantInput,
  ValidatedListGrantsQuery,
  ValidatedListRecommendationsQuery,
  ValidatedListSystemsQuery,
  ValidatedRunDiscoveryInput,
  ValidatedSubmitBatchInput,
  ValidatedRevokeInput,
  ValidatedDecideBatchInput,
  ValidatedListBatchesQuery,
  ValidatedListVerificationRunsQuery,
} from './validation';

export type {
  CapabilityClass,
  CapabilityProbeRequest,
  CapabilityProbeResult,
  ConnectSystemInput,
  ConnectSystemResult,
  DataCategory,
  DecideBatchInput,
  DiscoveryGrant,
  DiscoveryGrantStatus,
  DiscoveryRunResult,
  DiscoverySourceRun,
  ExplanationOrgContext,
  GetDiscoveryGrantQuery,
  GetRecommendationBatchQuery,
  GetRecommendationQuery,
  GetSystemQuery,
  GrantDiscoverySourceInput,
  GrantDiscoverySourceResult,
  InventorySystem,
  ListDiscoveryGrantsQuery,
  ListRecommendationBatchesQuery,
  ListRecommendationsQuery,
  ListSystemsQuery,
  ListVerificationRunsQuery,
  OutcomeDimension,
  Recommendation,
  RecommendationBatch,
  RecommendationBatchStatus,
  RecommendationStatus,
  RevokeDiscoverySourceInput,
  RunDiscoveryInput,
  ScopeImpact,
  SubmitBatchInput,
  SystemCapability,
  SystemConnectionStatus,
  SystemHealth,
  VerificationProbeOutcome,
  VerificationProbeResult,
  VerificationRun,
  VerificationStatus,
  VerificationTransport,
  VerifySystemInput,
  WhyItMatters,
} from './types';
