// Public domain types of the org-lab module (W135 — Contextual
// Organizational Lab).
//
// The work item (spec/work-items/WORK-ITEM-CATALOG.md §W135):
// "Implement a Flauz-inspired Aurum Lab for organization candidates,
//  marketplace-agent selection, model occupancy, robust evaluation and
//  calibration."
// Acceptance: "organization search includes season/time window, duration,
// staffing, staff experience, workload, capability, environment, budget,
// quality, risk, verification and evidence freshness where relevant;
// rejected candidates are retained; recommendations are outcome-calibrated;
// same subject under materially different contexts may yield different best
// organizations."
//
// Design contract: spec/AGENT-BODY-LAB-CROSS-PLATFORM-ARCHITECTURE.md.
//   §2  "The Lab must condition organization selection on a
//        ContextFingerprint, not only a task type... These are hypotheses
//        for the Lab to test, not hardcoded industry rules."
//   §4  "An organization candidate is the composition of a goal and context
//        into role proposals, agent/body nodes, communication topology,
//        information routes, agent candidates, model occupancy and
//        evaluation evidence. Edges may represent delegation, review,
//        handoff, escalation and information-feed relationships. The
//        organization is evaluated as a system rather than as a bag of
//        model scores."
//   §5  "The Lab may compare tenant agents, marketplace AgentPackages,
//        capability/extension packages, human capabilities and external
//        specialist services. The Lab recommends. Marketplace governance,
//        Agent Recruitment, Action Policy and Agent Gateway authorize and
//        execute."
//   §10 "Lab: experimentation, recommendation and learning. The Lab never
//        grants authority, directly executes external agents, installs
//        marketplace packages or self-publishes roles."
//   §11 "Every contextual Lab recommendation retains goal revision, context
//        fingerprint, knowledge objective, candidates, marketplace
//        candidates, model occupancies, evaluation configuration, evidence,
//        outcomes, calibration and rejected alternatives. Historical
//        recommendations are immutable."
//
// THE CONTEXTUAL RULE (binding, the W134 inheritance): this module NEVER
// hardcodes an organization, a matching rule or a per-industry preference.
// Candidates carry CALLER-SUPPLIED contextual applicability hypotheses
// (which fingerprint values they are designed for); the search matches
// those declared hypotheses MECHANICALLY against the observed
// ContextFingerprint (the W134 seam — the Lab never re-derives context),
// and outcome calibration (recorded evidence from settled expected
// outcomes) modulates the ranking. The same subject under a materially
// different fingerprint may therefore rank a different candidate first —
// that divergence is DATA (two fingerprints, two declared hypotheses),
// never code.
//
// AUTHORITY BOUNDARIES (§10, the completion law): the Lab RECOMMENDS.
// Everything here is records and reads — no operation installs a
// marketplace package, recruits an agent, executes an external specialist
// or grants any authority. Those belong to Marketplace governance (W028),
// Agent Recruitment (W022), Action Policy (W009) and the Agent Gateway
// (W021) at the composition boundary (W136/W137 own the follow-through
// journeys; W141 the certification).
//
// Tenancy (ADR-0001): every record is tenant-scoped at the SQL layer;
// another tenant's candidates, recommendations and calibrations are
// indistinguishable from missing ones (uniform not-found, no existence
// leak).

import type { CoverageSourceRegistry } from '@/modules/coverage/contract';
import type {
  ContextDimensionKey,
  ContextFingerprint,
  DurationClass,
  WorkloadLevel,
} from '@/modules/context/contract';
import type { ModelBindingPurpose } from '@/modules/provider-fabric/contract';

// ---------------------------------------------------------------------------
// Candidate composition (§4)
// ---------------------------------------------------------------------------

/**
 * The §5 comparison set — the kinds of actor an organization candidate may
 * be composed of. Only 'agent-body' refs are validated at write time
 * (readable + active through the agent-body contract, the W133 seam —
 * their model occupancy is what the Lab tracks); every other kind is an
 * OPAQUE forward reference (id and/or label) owned by its registry:
 * tenant agents by the agents module (W021), marketplace packages by the
 * marketplace module (W028 — publication/installation governance stays
 * there, locks 26/27), human capabilities and external specialist services
 * by their tenants. The Lab records the comparison; the owners remain the
 * verification points (the outcomes module's opaque-target discipline).
 */
export type OrgNodeKind =
  | 'agent-body'
  | 'tenant-agent'
  | 'marketplace-agent-package'
  | 'marketplace-extension-package'
  | 'human-capability'
  | 'external-specialist';

/**
 * The §4 edge vocabulary: "Edges may represent delegation, review, handoff,
 * escalation and information-feed relationships."
 */
export type OrgEdgeKind = 'delegation' | 'review' | 'handoff' | 'escalation' | 'information-feed';

/** One node of a candidate's composition: a role proposal filled by an actor. */
export interface OrgNode {
  /** Unique within the candidate (slug grammar — deterministic referencing). */
  nodeId: string;
  kind: OrgNodeKind;
  /** The role proposal this node fills in the organization (1..128 chars). */
  role: string;
  /** Opaque registry reference; required for 'agent-body' (the body id). */
  ref: string | null;
  /** Human-readable label for the referenced actor. */
  label: string | null;
  /**
   * Model-occupancy requirements (agent-body nodes only): the purposes a
   * binding must actively possess this body through for the organization
   * to be executable. Snapshotted — read-only — at recommendation time
   * through the agent-body + provider-fabric seams.
   */
  purposes: ModelBindingPurpose[];
}

/** One communication-topology edge between two nodes (§4). */
export interface OrgEdge {
  fromNodeId: string;
  toNodeId: string;
  kind: OrgEdgeKind;
  note: string | null;
}

/**
 * One information route (§4): an opaque reference into one of the coverage
 * module's source registries — the same vocabulary W134's preferred
 * sources use, so the Lab's information routes and the strategy layer's
 * source choices speak one grammar. Prospective by design (the W134
 * PreferredSource discipline): refs are deliberately not cross-module
 * validated.
 */
export interface OrgInformationRoute {
  registry: CoverageSourceRegistry;
  ref: string;
  note: string | null;
}

/** The full §4 composition of an organization candidate. */
export interface OrgComposition {
  nodes: OrgNode[];
  edges: OrgEdge[];
  informationRoutes: OrgInformationRoute[];
}

// ---------------------------------------------------------------------------
// Contextual applicability (the declared hypotheses — THE CONTEXTUAL RULE)
// ---------------------------------------------------------------------------

/**
 * The staffing profiles a candidate may declare itself designed for. The
 * profile a fingerprint's staffing observes is DERIVED deterministically
 * from its experience mix (the dominant bucket at ≥ 50% share, 'mixed'
 * otherwise) — a pure, documented derivation, never a domain assumption
 * about which profile is "better".
 */
export type StaffingProfile = 'novice-heavy' | 'intermediate-heavy' | 'expert-heavy' | 'mixed';

/**
 * The risk postures a candidate may declare (the fingerprint's
 * constraints.riskTolerance vocabulary, mirrored).
 */
export type RiskTolerance = 'risk-averse' | 'balanced' | 'risk-tolerant';

/**
 * A candidate's DECLARED contextual applicability — the hypotheses under
 * which the candidate organization asserts it is a strong fit. Every field
 * is caller-supplied content; the Lab matches these declarations
 * mechanically against an observed ContextFingerprint and never invents,
 * defaults or industry-codes a declaration (the null-signal law inherited
 * from the fingerprint: absent means absent).
 *
 * Mechanical axes (match/misfit/agnostic/unobserved in the search's fit
 * report): seasonWindows, durationClasses, staffingProfiles,
 * workloadLevels, requiredCapabilities, requiredEnvironmentFactors,
 * riskTolerances, requiredVerificationRequirements, freshSurfaces.
 *
 * Advisory axes (surfaced both ways — the fingerprint's free-text
 * budget/quality/SLA posture and the candidate's declared posture — but
 * never string-matched, because mechanical free-text matching would be
 * fabricated precision): budgetNote, qualityTarget, slaNote.
 */
export interface CandidateApplicability {
  /** Season/time windows the candidate declares for ('spring', 'q4', ...). */
  seasonWindows: string[];
  durationClasses: DurationClass[];
  staffingProfiles: StaffingProfile[];
  workloadLevels: WorkloadLevel[];
  /** Capabilities that must be in the fingerprint's available list. */
  requiredCapabilities: string[];
  /** Environment factors that must be in the fingerprint's factor list. */
  requiredEnvironmentFactors: string[];
  riskTolerances: RiskTolerance[];
  /** Verification requirements that must be covered by the fingerprint. */
  requiredVerificationRequirements: string[];
  /** Evidence surfaces the candidate's information routes keep fresh. */
  freshSurfaces: string[];
  /** Advisory: the candidate's declared budget posture (never matched). */
  budgetNote: string | null;
  /** Advisory: the candidate's declared quality posture (never matched). */
  qualityTarget: string | null;
  /** Advisory: the candidate's declared SLA posture (never matched). */
  slaNote: string | null;
}

/** Input shape of `CandidateApplicability` (every field optional). */
export interface CandidateApplicabilityInput {
  seasonWindows?: string[];
  durationClasses?: DurationClass[];
  staffingProfiles?: StaffingProfile[];
  workloadLevels?: WorkloadLevel[];
  requiredCapabilities?: string[];
  requiredEnvironmentFactors?: string[];
  riskTolerances?: RiskTolerance[];
  requiredVerificationRequirements?: string[];
  freshSurfaces?: string[];
  budgetNote?: string | null;
  qualityTarget?: string | null;
  slaNote?: string | null;
}

// ---------------------------------------------------------------------------
// The candidate (registry record)
// ---------------------------------------------------------------------------

export type OrgCandidateStatus = 'active' | 'retired';

/**
 * One registered organization candidate: the tenant's reusable
 * organization blueprint. The composition and applicability are IMMUTABLE
 * from registration (a changed design is a NEW candidate with a new slug —
 * the actions module's discipline; rewriting a design under evaluation
 * would corrupt the calibration history that references it). The lifecycle
 * is the one-way active → retired transition.
 */
export interface OrgCandidate {
  id: string;
  tenantId: string;
  /** Tenant-unique immutable slug (identity). */
  slug: string;
  label: string;
  description: string | null;
  composition: OrgComposition;
  applicability: CandidateApplicability;
  status: OrgCandidateStatus;
  /** Why the candidate was retired ('retired' only). */
  lifecycleNote: string | null;
  retiredAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Input shape of `registerCandidate`. */
export interface RegisterCandidateInput {
  slug: string;
  label: string;
  description?: string | null;
  composition: {
    nodes: OrgNodeInput[];
    edges?: OrgEdgeInput[];
    informationRoutes?: OrgInformationRouteInput[];
  };
  applicability?: CandidateApplicabilityInput;
}

/** Input shape of `OrgNode`. */
export interface OrgNodeInput {
  nodeId: string;
  kind: OrgNodeKind;
  role: string;
  ref?: string | null;
  label?: string | null;
  /** Agent-body nodes only: the purposes requiring an active binding. */
  purposes?: ModelBindingPurpose[];
}

/** Input shape of `OrgEdge`. */
export interface OrgEdgeInput {
  fromNodeId: string;
  toNodeId: string;
  kind: OrgEdgeKind;
  note?: string | null;
}

/** Input shape of `OrgInformationRoute`. */
export interface OrgInformationRouteInput {
  registry: CoverageSourceRegistry;
  ref: string;
  note?: string | null;
}

/** Input shape of `retireCandidate`. */
export interface RetireCandidateInput {
  candidateId: string;
  /** Required reason (1..512 chars), retained. */
  reason: string;
}

/** Query shape of `getCandidate`. */
export interface GetCandidateQuery {
  candidateId: string;
}

/** Query shape of `listCandidates`. */
export interface ListCandidatesQuery {
  status?: OrgCandidateStatus;
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Contextual fit (the pure search vocabulary)
// ---------------------------------------------------------------------------

/**
 * The fit axes the search reports — the twelve acceptance dimensions
 * ("season/time window, duration, staffing, staff experience, workload,
 * capability, environment, budget, quality, risk, verification and
 * evidence freshness") plus SLA (the architecture §2 latency/SLA context
 * member), mapped onto the fingerprint's eight typed dimension families
 * (constraints contributes budget/quality/risk/verification/SLA;
 * evidenceFreshness contributes evidence freshness).
 */
export type OrgFitAxis =
  | 'season'
  | 'duration'
  | 'staffing'
  | 'workload'
  | 'capabilities'
  | 'environment'
  | 'budget'
  | 'quality'
  | 'risk'
  | 'verification'
  | 'evidence-freshness'
  | 'sla';

/** All fit axes in canonical (acceptance-listing) order. */
export const ORG_FIT_AXES: readonly OrgFitAxis[] = [
  'season',
  'duration',
  'staffing',
  'workload',
  'capabilities',
  'environment',
  'budget',
  'quality',
  'risk',
  'verification',
  'evidence-freshness',
  'sla',
];

/**
 * One axis's verdict under a fingerprint:
 *  * 'match'      — the candidate declared this axis and the observed
 *                   context satisfies the declaration;
 *  * 'misfit'     — the candidate declared this axis and the observed
 *                   context violates it;
 *  * 'agnostic'   — the axis is observed but the candidate declares
 *                   nothing for it (context-agnostic — neutral);
 *  * 'unobserved' — the fingerprint honestly lacks this dimension (the
 *                   null-signal law: absent, never faked);
 *  * 'advisory'   — a free-text axis (budget/quality/SLA) that is observed:
 *                   both postures are surfaced in the report but never
 *                   mechanically matched.
 */
export type DimensionVerdict = 'match' | 'misfit' | 'agnostic' | 'unobserved' | 'advisory';

/** One axis's fit report entry (human-auditable: declared vs observed). */
export interface DimensionFit {
  axis: OrgFitAxis;
  verdict: DimensionVerdict;
  /** What the candidate declared for this axis (human summary). */
  declared: string;
  /** What the fingerprint observed for this axis (human summary). */
  observed: string;
}

// ---------------------------------------------------------------------------
// Calibration (the outcome-calibrated recommendation vocabulary)
// ---------------------------------------------------------------------------

/**
 * The recommendation-facing calibration aggregate per candidate — the
 * W054 intervention-prior shape: AGGREGATES and evidence REFERENCES,
 * deliberately never per-recommendation outcome labels (the ADR-0019
 * no-leak law). A candidate with no calibrated recommendations has NO
 * calibration at all (the cold, no-evidence state — null).
 */
export interface CalibrationSummary {
  candidateId: string;
  /** Calibrated recommendations in which this candidate was recommended. */
  sampleSize: number;
  /** Those whose calibration polarity was positive. */
  successes: number;
  /** Those whose calibration polarity was negative (retained evidence). */
  failures: number;
  /** successes / sampleSize, in [0, 1]. */
  successRate: number;
  /** The calibrated recommendation ids, ascending by calibration time. */
  evidenceRecommendationIds: string[];
}

/** The deterministic polarity of one calibrated recommendation. */
export type CalibrationPolarity = 'positive' | 'negative';

/** One frozen realized expected-outcome record on a calibration. */
export interface RealizedOutcomeRecord {
  outcomeId: string;
  realizedValue: number;
  varianceVsExpected: number;
  /** The learning module's frozen deterministic verdict (consumed, never re-derived). */
  assessment: 'met' | 'exceeded' | 'missed';
  fromMeasurementId: string;
  settledAt: string;
}

/** The calibration record appended to a recommendation (§11 "calibration"). */
export interface OrgCalibration {
  polarity: CalibrationPolarity;
  realized: RealizedOutcomeRecord[];
  note: string | null;
  calibratedBy: string;
  calibratedAt: string;
}

// ---------------------------------------------------------------------------
// The recommendation (the §11 evidence object)
// ---------------------------------------------------------------------------

export type OrgRecommendationStatus = 'recorded' | 'calibrated';

/** The disposition of one evaluated candidate inside a recommendation. */
export type CandidateDisposition = 'recommended' | 'rejected';

/** One named evaluation criterion of the evaluation configuration. */
export interface EvaluationCriterion {
  name: string;
  /** Relative weight in [0, 1], when stated. */
  weight: number | null;
}

/** One scored criterion on a candidate's evaluation record. */
export interface EvaluationScore {
  /** Must name a criterion of the recommendation's evaluation config. */
  name: string;
  /** The score in [0, 1]. */
  value: number;
}

/**
 * The evaluation configuration (§11) — the criteria the evaluations were
 * produced against, recorded with the recommendation so the recorded
 * scores stay interpretable forever.
 */
export interface EvaluationConfig {
  criteria: EvaluationCriterion[];
  note: string | null;
}

/** Input shape of `EvaluationConfig`. */
export interface EvaluationConfigInput {
  criteria: { name: string; weight?: number | null }[];
  note?: string | null;
}

/** The per-candidate evaluation record (input shape). */
export interface CandidateEvaluationInput {
  candidateId: string;
  disposition: CandidateDisposition;
  /** Required (1..8) iff rejected; must be empty iff recommended. */
  rejectionReasons?: string[];
  /** The system-level evaluation narrative (1..2000 chars). */
  summary: string;
  /** Optional scores against the evaluation config's criteria. */
  scores?: EvaluationScore[];
  /** Opaque evidence references (≤ 32). */
  evidenceRefs?: string[];
  /**
   * Agent evaluations (W024) cited as measured evidence — validated
   * readable at write time through the agent-evaluation contract. The
   * individual-agent measurement evidence feeding the system-level
   * evaluation (§4: "evaluated as a system", composed from real records).
   */
  agentEvaluationIds?: string[];
}

/** The retained per-candidate evaluation record (read shape). */
export interface CandidateEvaluationRecord {
  candidateId: string;
  disposition: CandidateDisposition;
  rejectionReasons: string[];
  summary: string;
  scores: EvaluationScore[];
  evidenceRefs: string[];
  agentEvaluationIds: string[];
  /** Deterministic order within the recommendation. */
  position: number;
}

/**
 * One model-occupancy snapshot row (§11 "model occupancies") — the
 * read-only composition through the W133 agent-body seam (the body's
 * active attachment for the purpose, its OPAQUE fabric binding id stored
 * VERBATIM) and the W132 provider-fabric seam (the tenant's current
 * active binding for the purpose). null = honestly unoccupied at snapshot
 * time. The Lab never creates, swaps or detaches bindings — the fabric
 * and the body own those paths.
 */
export interface OccupancySnapshot {
  nodeId: string;
  role: string;
  purpose: ModelBindingPurpose;
  bodyId: string;
  /** The active agent-body attachment's opaque fabric binding id, verbatim. */
  bodyBindingId: string | null;
  /** The fabric's current active binding id for this purpose, verbatim. */
  fabricBindingId: string | null;
}

/**
 * One expected-outcome record (§11 "outcomes") — the outcome-calibration
 * seam. The outcome is a REAL learning-module (W040) outcome, validated
 * readable and OPEN at record time; its immutable definition is snapshotted
 * so the recommendation commits to its expected value BEFORE realization
 * (the W054 prediction-hygiene discipline). Calibration later consumes the
 * learning module's frozen realization — never a re-derivation.
 */
export interface ExpectedOutcomeRecord {
  outcomeId: string;
  metricName: string;
  metricUnit: string;
  direction: 'at_least' | 'at_most';
  baseline: number;
  expected: number;
}

/** Input shape of `recordRecommendation`. */
export interface RecordRecommendationInput {
  goalId: string;
  fingerprintId: string;
  /** Optional W134 info-strategy link (validated readable when present). */
  strategyId?: string | null;
  /** §11 knowledge objective: what this organization must know/achieve. */
  knowledgeObjective: string;
  evaluationConfig: EvaluationConfigInput;
  /** 2..32 evaluated candidates, distinct ids, at most one 'recommended'. */
  candidates: CandidateEvaluationInput[];
  /** 1..16 learning-module outcomes (validated OPEN at record time). */
  expectedOutcomeIds: string[];
  /** Opaque evidence links (≤ 32). */
  derivedFrom?: string[];
  note?: string | null;
}

/** Input shape of `recordCalibration`. */
export interface RecordCalibrationInput {
  recommendationId: string;
  note?: string | null;
}

/** The full §11 recommendation view. */
export interface OrgRecommendation {
  id: string;
  tenantId: string;
  goalId: string;
  /** §11 "goal revision": the goal's current version at record time. */
  goalVersion: number;
  fingerprintId: string;
  strategyId: string | null;
  knowledgeObjective: string;
  evaluationConfig: EvaluationConfig;
  /** The recommended candidate, or null ("no clear winner" is honest). */
  recommendedCandidateId: string | null;
  status: OrgRecommendationStatus;
  note: string | null;
  derivedFrom: string[];
  recordedBy: string;
  recordedAt: string;
  calibratedAt: string | null;
  /** ALL evaluated candidates — recommended AND rejected, all retained. */
  candidates: CandidateEvaluationRecord[];
  /** The recommended candidate's agent-body occupancy at record time. */
  modelOccupancy: OccupancySnapshot[];
  expectedOutcomes: ExpectedOutcomeRecord[];
  calibration: OrgCalibration | null;
}

/** `listRecommendations` summary row (deep-link with `getRecommendation`). */
export interface OrgRecommendationSummary {
  id: string;
  tenantId: string;
  goalId: string;
  fingerprintId: string;
  strategyId: string | null;
  recommendedCandidateId: string | null;
  status: OrgRecommendationStatus;
  /** How many candidates were evaluated (retained, incl. rejected). */
  candidateCount: number;
  /** How many candidates were rejected (retained negative alternatives). */
  rejectedCount: number;
  knowledgeObjective: string;
  recordedAt: string;
  calibratedAt: string | null;
}

// ---------------------------------------------------------------------------
// Search (the contextually-conditioned organization search)
// ---------------------------------------------------------------------------

/** Query shape of `searchOrganizations`. */
export interface SearchOrganizationsQuery {
  /** The subject goal (validated ACTIVE — searches serve current direction). */
  goalId: string;
  /**
   * The ContextFingerprint the search is conditioned on (validated
   * readable through the context contract and derived FOR this goal —
   * the Lab never re-derives context; W134 owns it).
   */
  fingerprintId: string;
  /** 1..500, default 50. */
  limit?: number;
}

/** One ranked search result. */
export interface OrgSearchResult {
  candidateId: string;
  slug: string;
  label: string;
  status: OrgCandidateStatus;
  /** The deterministic blended score the ordering used. */
  rankScore: number;
  /** The raw contextual fit in [0, 1]; null = no declared-relevant signal. */
  fitScore: number | null;
  /** Per-axis fit report (all twelve dimensions, canonical order). */
  dimensions: DimensionFit[];
  /** The candidate's calibration aggregate, or null (cold start). */
  calibration: CalibrationSummary | null;
  /** The composition's node-kind census (the §5 comparison set at a glance). */
  nodeKinds: Readonly<Record<OrgNodeKind, number>>;
}

/** Query shape of `getRecommendation`. */
export interface GetRecommendationQuery {
  recommendationId: string;
}

/** Query shape of `getCandidateCalibration`. */
export interface GetCandidateCalibrationQuery {
  candidateId: string;
}

/** Query shape of `listRecommendations`. All filters AND-combined. */
export interface ListRecommendationsQuery {
  goalId?: string;
  fingerprintId?: string;
  /** Only recommendations that evaluated this candidate. */
  candidateId?: string;
  status?: OrgRecommendationStatus;
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Pure-function parameter types (ranking.ts)
// ---------------------------------------------------------------------------

/** The candidate slice the pure ranker needs (no database in sight). */
export interface RankableCandidate {
  candidateId: string;
  slug: string;
  applicability: CandidateApplicability;
}

/** The pure ranker's output before search-result assembly. */
export interface RankedCandidate {
  candidateId: string;
  slug: string;
  rankScore: number;
  fitScore: number | null;
  dimensions: DimensionFit[];
}

/**
 * The fingerprint slice the pure fit function reads — exactly the eight
 * typed context dimensions (the W134 vocabulary, consumed as-is).
 */
export type FitFingerprint = Pick<
  ContextFingerprint,
  'season' | 'duration' | 'staffing' | 'workload' | 'capabilities' | 'environment' | 'constraints' | 'evidenceFreshness'
>;

/** Re-exported so fit-vocabulary consumers have one import point. */
export type { ContextDimensionKey };
