// ============================================================================
// attention — the ONLY public surface of the attention module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W051 — Unprompted Unknown Discovery:
// "Implement goal-gap discovery per ADR-0017: material goal/evidence gaps
//  create candidate unknowns without a user question; candidate unknowns
//  contain impact, urgency, confidence gap and information value; only
//  material unknowns become missions; discovery is evidence-linked and
//  auditable; end-to-end synthetic proof exists."
//
// MODULE PLACEMENT: `attention` is the frozen module map's L2 member
// (ARCHITECTURE.md §26; IMPLEMENTATION-STACK §10; MODULE-DEPENDENCY-MAP
// L2 "epistemics, goals, attention, investigation, missions,
// knowledge-acquisition, cognition"). §19's connection list places
// attention exactly where this capability sits — "…goals, attention,
// unknowns, learning missions…" — and §12's chain ends "attention
// decision → mission or recommendation", which is ADR-0017's materiality
// gate verbatim. No other catalog work item claims the attention module;
// W051 owns it.
//
// ADR-0017 (Goal Gap Discovery) decides the semantics:
//   "Aurum derives consequential unknowns from active goals, desired
//    state, temporal state and evidence without requiring management to
//    state the exact question." — discovery takes NO question. The run
//    input carries a trigger, budgets, an actor, metric READINGS (what
//    the tenant's claims say about goal metrics — evidence extraction)
//    and optional gap PROPOSALS at the bounded-reasoning seam ("the LLM
//    may propose, the application decides, records and links evidence").
//    The unknown's question, consequence, decision impact, urgency,
//    confidence gap, expected information value and candidate acquisition
//    paths are COMPUTED by the deterministic derivation (discovery.ts,
//    exported below) from the tenant's ACTIVE goals, their horizons and
//    the readings.
//
//   runGoalGapDiscovery — ONE explicit, durable, unprompted discovery
//      pass over the tenant's active goals (all of them, or a `goalIds`
//      scope): validates the loop linkage (an originating cognitive
//      execution, W013) when present, evaluates every goal against its
//      evidence, derives the candidates, then decides each through the
//      MATERIALIZATION POLICY GATE (decision impact AND expected
//      information value at/above the run's snapshotted thresholds):
//      material+uncovered candidates are promoted THROUGH the sibling
//      contracts — an epistemics unknown (W007 recordUnknown: goal
//      subject, evidence basis linked, note naming the run) plus a
//      learning mission (W011 createMission, driven by the run's actor
//      with a deterministic definition); below-threshold candidates are
//      recorded 'dismissed'; material candidates whose exact gap key
//      already has an ACTIVE mission are recorded 'already_covered'
//      (continuous discovery does not spam duplicates — a returning need
//      after a terminal mission is a NEW unknown+mission, the missions
//      module's own discipline).
//
//   getDiscoveryRun / getDiscoveryCandidate / listDiscoveryRuns — the
//      audit surface: one run with its full decided candidate chain, one
//      candidate deep-linked by id, and the run feed (filtered by trigger
//      kind, originating execution, affected goal, disposition; newest
//      first; disposition counts included).
//
// There is deliberately NO operation to update or erase a run, re-decide
// a candidate, un-promote, un-cover or delete anything: discovery runs
// and candidate decisions are append-only evidence of what Aurum
// attended to and decided (PostgreSQL triggers reject
// UPDATE/DELETE/TRUNCATE on both tables, migration 001). Every promotion
// is reconstructable — which goal, which evidence, which policy, which
// decision (ADR-0017's consequence clause) — and W052 (source ranking)
// and W055 (unknown-discovery precision/recall) build on exactly these
// records.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext
// and is tenant-scoped at the SQL layer; another tenant's runs and
// candidates are indistinguishable from missing ones (`run_not_found` /
// `candidate_not_found` — no existence leak), and the validated
// cross-module references (goals, evidence, the originating execution)
// are uniformly invalid_*_ref for the same reason.
//
// Dependency posture (WORK-ITEM-DEPENDENCY-GRAPH.md:
// W007 + W008 + W011 + W013 → W051): this module imports ONLY module
// contracts — epistemics (W007: unknown recording + claim/belief
// evidence validation), goals (W008: active-goal evaluation), missions
// (W011: mission creation + coverage checks) and cognition (W013: the
// originating-execution link). Nothing else.
// ============================================================================

export {
  getDiscoveryCandidate,
  getDiscoveryRun,
  listDiscoveryRuns,
  runGoalGapDiscovery,
} from './service';

export { AttentionError } from './errors';
export type { AttentionErrorCode } from './errors';

// The deterministic goal-gap derivation and the materiality policy gate —
// the single definitions, pure and total, reusable by downstream modules
// (W052 knowledge source ranking, W055 quality measurement) and
// unit-testable in isolation (the knowledge-acquisition ranking.ts and
// cognition signals.ts precedent).
export {
  // fixed derivation constants
  HORIZON_BUMP_DAYS,
  NEUTRAL_SEVERITY,
  PRIORITY_RANK,
  REQUIRED_CONFIDENCE,
  URGENCY_BANDS,
  // pure scoring primitives
  acquisitionPathsFromGoalSources,
  decisionImpactFor,
  gapKeyFor,
  informationValueFor,
  relativeShortfall,
  requiredConfidenceFor,
  round4,
  targetDescription,
  urgencyFromPriority,
  // the derivation and the gate
  deriveGoalGapCandidates,
  evaluateMateriality,
} from './discovery';
export type {
  DerivedGapCandidate,
  DerivationInput,
  GoalEvidenceSnapshot,
  GoalEvidenceSourceSnapshot,
  GoalMetricSnapshot,
  GoalSnapshot,
  MaterialityDecision,
  ReadingSnapshot,
} from './discovery';

export {
  ACQUISITION_PATH_KINDS,
  CANDIDATE_DISPOSITIONS,
  CANDIDATE_SOURCES,
  CANDIDATE_URGENCIES,
  DEFAULT_IMPACT_THRESHOLD,
  DEFAULT_LIST_LIMIT,
  DEFAULT_VALUE_THRESHOLD,
  DISCOVERY_PARTY_KINDS,
  DISCOVERY_TRIGGER_KINDS,
  GAP_KINDS,
  MAX_ACQUISITION_PATHS,
  MAX_BUDGET_AMOUNT,
  MAX_CONSEQUENCE_LENGTH,
  MAX_EVIDENCE_REFS,
  MAX_GAP_KEY_LENGTH,
  MAX_GOAL_LABEL_LENGTH,
  MAX_GOAL_REFS_PER_CANDIDATE,
  MAX_LIST_LIMIT,
  MAX_METRIC_NAME_LENGTH,
  MAX_MISSING_KNOWLEDGE_LENGTH,
  MAX_PARTY_LABEL_LENGTH,
  MAX_PROPOSALS_PER_RUN,
  MAX_RATIONALE_LENGTH,
  MAX_READINGS_PER_RUN,
  MAX_SCOPED_GOALS,
  MAX_TRIGGER_LABEL_LENGTH,
  MIN_POLICY_THRESHOLD,
  isAcquisitionPathKind,
  isCandidateDisposition,
  isCandidateSource,
  isCandidateUrgency,
  isDiscoveryPartyKind,
  isDiscoveryTriggerKind,
  isGapKind,
  isUuid,
} from './validation';

export type {
  ValidatedAcquisitionPath,
  ValidatedBudget,
  ValidatedGoalRef,
  ValidatedListQuery,
  ValidatedParty,
  ValidatedProposal,
  ValidatedReading,
  ValidatedRunInput,
} from './validation';

export type {
  AcquisitionPath,
  AcquisitionPathInput,
  AcquisitionPathKind,
  CandidateDisposition,
  CandidateGoalRef,
  CandidateGoalRefInput,
  CandidateSource,
  CandidateUrgency,
  DiscoveryCandidate,
  DiscoveryParty,
  DiscoveryPartyInput,
  DiscoveryPartyKind,
  DiscoveryRun,
  DiscoveryRunCounts,
  DiscoveryRunSummary,
  DiscoveryTriggerKind,
  GapKind,
  GapProposalInput,
  GetDiscoveryCandidateQuery,
  GetDiscoveryRunQuery,
  ListDiscoveryRunsQuery,
  MaterialityPolicy,
  MaterialityPolicyInput,
  MetricReadingInput,
  RunGoalGapDiscoveryInput,
} from './types';
