// Public domain types of the attention module (W051 — Unprompted Unknown
// Discovery, per ADR-0017).
//
// The work item (spec/work-items/WORK-ITEM-CATALOG.md, W051):
// "Implement goal-gap discovery per ADR-0017: material goal/evidence gaps
//  create candidate unknowns without a user question; candidate unknowns
//  contain impact, urgency, confidence gap and information value; only
//  material unknowns become missions; discovery is evidence-linked and
//  auditable; end-to-end synthetic proof exists."
//
// ADR-0017 (Goal Gap Discovery) decides what this module IS:
//
//   "Aurum derives consequential unknowns from active goals, desired state,
//    temporal state and evidence without requiring management to state the
//    exact question."
//
//   "Candidate unknowns carry: affected goals/decisions; missing knowledge;
//    evidence basis; decision impact; urgency; confidence gap; expected
//    information value; candidate acquisition paths."
//
//   "Mission creation is application-owned, policy-gated and auditable.
//    Unknown discovery is never an LLM assertion: the LLM may propose, the
//    application decides, records and links evidence."
//
//   "Unknown discovery becomes an unprompted, continuous capability driven
//    by goal-evaluation, not a question-answering feature. ... Only
//    material unknowns (sufficient decision impact and information value)
//    may become LearningMissions, through the policy gate."
//
// Two records carry that:
//
//   DiscoveryRun     — ONE explicit, durable goal-gap discovery pass: the
//                      unprompted capability's unit of work. It snapshots
//                      the materiality policy used (the policy gate is
//                      auditable per run), names its trigger and actor,
//                      optionally links the cognitive execution (W013)
//                      whose goal-evaluation drove it, and derives its
//                      candidate set from the tenant's ACTIVE goals
//                      evaluated against evidence. Runs are append-only:
//                      a pass is evidence of what Aurum attended to.
//
//   DiscoveryCandidate — ONE candidate unknown: a material-or-not goal/
//                      evidence gap carrying every ADR-0017 field (see
//                      `DiscoveryCandidate`). Its disposition records
//                      the application's decision: 'promoted' (material →
//                      an epistemics unknown was recorded AND a learning
//                      mission launched through the missions contract),
//                      'dismissed' (below the materiality policy — no
//                      unknown, no mission), or 'already_covered' (material
//                      but an active mission already closes this exact gap
//                      — discovery does not spam duplicates). Candidates
//                      are append-only: the decision trail cannot be
//                      rewritten.
//
// The derivation itself is PURE and lives in discovery.ts: goal snapshots
// plus evidence readings deterministically produce candidates — the
// question, consequence, impact, urgency, confidence gap, information
// value and acquisition paths are COMPUTED by the application, never
// supplied by a user (that is what makes discovery "unprompted"). The
// readings that feed it are evidence extraction (what the tenant's claims
// say about goal metrics), and explicit gap PROPOSALS are accepted at the
// same seam — "the LLM may propose, the application decides" — flowing
// through the identical validation, materiality gate and audit.
//
// Provider neutrality (lock 16): actors and acquisition paths are opaque
// references — kind + uuid id and/or human label — owned by their
// respective modules (people W002, world W005, sources W036, agents
// W021+). Affected goals are opaque forward references to goals module
// (W008) records, validated ACTIVE through the goals contract at write
// time (discovery evaluates current direction only). Evidence basis is
// claims and beliefs validated readable through the epistemics contract
// (W007) — raw observations enter discovery through the claims that cite
// them (the loop's epistemic-evaluation stage, W013), which keeps this
// module inside its declared dependency set (W007+W008+W011+W013 → W051).

import type { MissionCandidateKind } from '@/modules/missions/contract';

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/** What started one discovery pass. */
export type DiscoveryTriggerKind =
  | 'cognitive-execution' // a canonical loop's goal-evaluation drove it (originExecutionId required)
  | 'scheduled' // the continuous capability's periodic sweep
  | 'manual'; // an operator/worker invoked a pass (still no question required)

/** How one candidate entered the pass. */
export type CandidateSource = 'derived' | 'proposed';

/**
 * The deterministic gap kinds the pure derivation produces (plus 'custom'
 * for seam proposals). Locks the audit vocabulary:
 *  * 'driver'  — a metric has readings and is OFF its target: what DRIVES
 *    it there is the missing knowledge (the deepest, most consequential
 *    gap: corrective action cannot be chosen);
 *  * 'reading' — a goal metric has NO reading at all: the metric's current
 *    value is the missing knowledge (the goal cannot even be evaluated);
 *  * 'standing' — a metric-less goal with insufficient evidence confidence:
 *    its standing against the desired state is the missing knowledge;
 *  * 'custom'  — a proposal at the bounded-reasoning seam.
 */
export type GapKind = 'driver' | 'reading' | 'standing' | 'custom';

/** The application's decision on one candidate (the policy gate's output). */
export type CandidateDisposition = 'promoted' | 'dismissed' | 'already_covered';

/** How urgently the missing knowledge is needed (the missions vocabulary). */
export type CandidateUrgency = 'critical' | 'high' | 'medium' | 'low';

/** Kinds of parties that can drive a discovery pass. */
export type DiscoveryPartyKind = 'person' | 'team' | 'agent' | 'system' | 'external';

/**
 * One candidate acquisition path — where the missing knowledge may come
 * from. Same shape and vocabulary as the missions module's candidate
 * sources (§6/§7): whatever is recorded here becomes the launched
 * mission's candidate menu, so the W012 planner can act on it directly.
 */
export type AcquisitionPathKind = MissionCandidateKind;

// ---------------------------------------------------------------------------
// Shared reference shapes
// ---------------------------------------------------------------------------

/**
 * A provider-neutral party reference (lock 16): an opaque uuid `id` owned
 * by the respective module and/or a human-readable `label`. At least one
 * must be present — the party driving discovery must be traceable.
 */
export interface DiscoveryParty {
  kind: DiscoveryPartyKind;
  id?: string | null;
  label?: string | null;
}

/** Input shape of `DiscoveryParty`. */
export interface DiscoveryPartyInput {
  kind: DiscoveryPartyKind;
  id?: string | null;
  label?: string | null;
}

/**
 * One affected-goal reference: an opaque uuid forward reference to a goals
 * module (W008) record plus an optional human label. Validated ACTIVE
 * through the goals contract at write time — ADR-0017 derives unknowns
 * from ACTIVE goals (current direction), and the missions module's
 * affected-goals precedent keeps the reference opaque with no
 * cross-module foreign key.
 */
export interface CandidateGoalRef {
  goalId: string;
  label?: string | null;
}

/** Input shape of `CandidateGoalRef`. */
export interface CandidateGoalRefInput {
  goalId: string;
  label?: string | null;
}

/**
 * One candidate acquisition path: a provider-neutral kind plus an opaque
 * uuid `id` and/or a human-readable `label` (at least one — a path must be
 * traceable). Deliberately unvalidated beyond shape here: the W012
 * planner validates routes when it drives acquisition.
 */
export interface AcquisitionPath {
  kind: AcquisitionPathKind;
  id?: string | null;
  label?: string | null;
}

/** Input shape of `AcquisitionPath`. */
export interface AcquisitionPathInput {
  kind: AcquisitionPathKind;
  id?: string | null;
  label?: string | null;
}

// ---------------------------------------------------------------------------
// The materiality policy (ADR-0017's policy gate)
// ---------------------------------------------------------------------------

/**
 * The materiality policy of one discovery pass — the deterministic gate
 * ADR-0017 requires: "Only material unknowns (sufficient decision impact
 * AND information value) may become LearningMissions, through the policy
 * gate." A candidate is material when its decision impact is at least
 * `impactThreshold` AND its expected information value is at least
 * `valueThreshold`. The policy used is snapshotted onto every run, so each
 * promotion/dismissal is reconstructable against the thresholds that
 * governed it (auditable policy, not a silent judgment).
 */
export interface MaterialityPolicy {
  /** Minimum decision impact, (0, 1]. Default 0.5. */
  impactThreshold: number;
  /** Minimum expected information value, (0, 1]. Default 0.5. */
  valueThreshold: number;
}

/** Input shape of `MaterialityPolicy` (both optional; defaults applied). */
export interface MaterialityPolicyInput {
  impactThreshold?: number;
  valueThreshold?: number;
}

// ---------------------------------------------------------------------------
// Run input: readings (evidence extraction) + proposals (the seam)
// ---------------------------------------------------------------------------

/**
 * One metric reading — what the tenant's evidence says about ONE metric of
 * ONE active goal. This is EVIDENCE EXTRACTION, not a question: the value
 * and its claim provenance come from the epistemic layer (claims derived
 * from observations by the loop's epistemic-evaluation stage), and the
 * derivation in discovery.ts computes the unknown from it. `driverConfidence`
 * states how confident the current evidence already is about WHAT DRIVES
 * the metric (extracted from beliefs when any exist; 0 when nothing is
 * known — the purest gap).
 */
export interface MetricReadingInput {
  goalId: string;
  /** Must be a metric declared on that goal's current version. */
  metricName: string;
  /** The metric's current value according to the cited evidence. */
  value: number;
  /** Confidence the evidence already pins the DRIVERS of the metric; [0, 1], default 0. */
  driverConfidence?: number;
  /** 1..16 claim uuids — the reading's evidence basis (validated readable, W007). */
  evidenceClaimIds: string[];
  /** 0..16 belief uuids additionally bearing on the drivers. */
  evidenceBeliefIds?: string[];
}

/**
 * One gap proposal at the bounded-reasoning seam — ADR-0017: "the LLM may
 * propose, the application decides, records and links evidence." A proposal
 * carries the FULL candidate field set; the service validates it, gates it
 * with the same materiality policy, and records it with the same audit as
 * a derived candidate. It is never promoted on the proposer's say-so: only
 * the deterministic policy gate decides.
 */
export interface GapProposalInput {
  /** Stable gap identity for cross-run coverage detection (e.g. 'churn|driver'). */
  gapKey: string;
  /** 1..4 active goal refs the gap affects (primary first). */
  affectedGoals: CandidateGoalRefInput[];
  /** The missing knowledge as a question (what Aurum cannot answer). */
  missingKnowledge: string;
  /** Why the gap matters — the consequence of not closing it. */
  consequence: string;
  /** Decision impact, [0, 1]. */
  decisionImpact: number;
  urgency: CandidateUrgency;
  /** Confidence gap: what is known now, [0, 1). */
  currentConfidence: number;
  /** Confidence gap: what the decision needs, (current, 1]. */
  requiredConfidence: number;
  /** Expected information value, [0, 1]. */
  informationValue: number;
  /** 0..16 claim uuids of the evidence basis. */
  evidenceClaimIds?: string[];
  /** 0..16 belief uuids of the evidence basis. */
  evidenceBeliefIds?: string[];
  /** 0..8 candidate acquisition paths. */
  acquisitionPaths?: AcquisitionPathInput[];
}

// ---------------------------------------------------------------------------
// runGoalGapDiscovery
// ---------------------------------------------------------------------------

/** Input shape of `runGoalGapDiscovery`. */
export interface RunGoalGapDiscoveryInput {
  /** What started this pass. */
  trigger: {
    kind: DiscoveryTriggerKind;
    label?: string | null;
  };
  /**
   * The cognitive execution (W013) whose goal-evaluation drove this pass —
   * the loop linkage. Validated readable through the cognition contract at
   * write time. REQUIRED for 'cognitive-execution' triggers.
   */
  originExecutionId?: string | null;
  /**
   * Scope the pass to these goals (each validated active); omitted =
   * evaluate every active goal (bounded by the goals module's list limit).
   */
  goalIds?: string[];
  /** Evidence extraction: metric readings per goal. Defaults to []. */
  readings?: MetricReadingInput[];
  /** Gap proposals at the bounded-reasoning seam. Defaults to []. */
  proposals?: GapProposalInput[];
  /** The materiality policy (defaults: 0.5 / 0.5). */
  policy?: MaterialityPolicyInput;
  /**
   * The investigation budget each launched mission starts with (integer
   * minor units + ISO currency; the operator driving discovery sets the
   * spending policy — the module never invents money).
   */
  investigationBudget: { amount: number; currency: string };
  /** The reward budget each launched mission starts with. */
  rewardBudget: { amount: number; currency: string };
  /** Who/what is driving the pass (drives mission creation). */
  actor: DiscoveryPartyInput;
  /** Why — optional, recorded on the run. */
  rationale?: string | null;
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

/**
 * One recorded candidate unknown — the ADR-0017 field set plus the
 * application's decision. Field-for-field:
 *  * affectedGoals       — "affected goals/decisions" (goal refs; the
 *                          consequence text carries the decision impact);
 *  * missingKnowledge    — "missing knowledge" (the question);
 *  * consequence         — why the gap matters (epistemics unknown shape);
 *  * decisionImpact      — "decision impact" ([0, 1]);
 *  * urgency             — "urgency";
 *  * currentConfidence / requiredConfidence — "confidence gap";
 *  * informationValue    — "expected information value" ([0, 1]);
 *  * evidenceClaimIds / evidenceBeliefIds — "evidence basis" (W007);
 *  * acquisitionPaths    — "candidate acquisition paths" (§7 menu).
 */
export interface DiscoveryCandidate {
  id: string;
  tenantId: string;
  runId: string;
  /** Stable gap identity (derived deterministically; proposals supply it). */
  gapKey: string;
  source: CandidateSource;
  gapKind: GapKind;
  affectedGoals: CandidateGoalRef[];
  missingKnowledge: string;
  consequence: string;
  decisionImpact: number;
  urgency: CandidateUrgency;
  currentConfidence: number;
  requiredConfidence: number;
  informationValue: number;
  evidenceClaimIds: string[];
  evidenceBeliefIds: string[];
  acquisitionPaths: AcquisitionPath[];
  disposition: CandidateDisposition;
  /** The epistemics unknown recorded on promotion ('promoted' only). */
  epistemicsUnknownId: string | null;
  /** The learning mission launched on promotion ('promoted' only). */
  missionId: string | null;
  /** The active mission that already closes this gap ('already_covered' only). */
  coveredByMissionId: string | null;
  /** ISO 8601 — when the candidate was decided (service clock). */
  recordedAt: string;
}

/** Disposition counts of one run (derived from its candidate set). */
export interface DiscoveryRunCounts {
  total: number;
  promoted: number;
  dismissed: number;
  alreadyCovered: number;
}

/**
 * The current view of one discovery pass: identity, trigger, actor, the
 * policy that governed it, the per-mission budgets it launches with, and
 * the full decided candidate set (ascending by decision order).
 */
export interface DiscoveryRun {
  id: string;
  tenantId: string;
  trigger: { kind: DiscoveryTriggerKind; label: string | null };
  originExecutionId: string | null;
  actor: DiscoveryParty;
  policy: MaterialityPolicy;
  investigationBudget: { amount: number; currency: string };
  rewardBudget: { amount: number; currency: string };
  counts: DiscoveryRunCounts;
  candidates: DiscoveryCandidate[];
  rationale: string | null;
  /** The authenticated principal that ran the pass. */
  ranByPrincipal: string;
  /** ISO 8601 — when the pass was committed (service clock). */
  recordedAt: string;
}

/** Query shape of `getDiscoveryRun`. */
export interface GetDiscoveryRunQuery {
  runId: string;
}

/** Query shape of `getDiscoveryCandidate`. */
export interface GetDiscoveryCandidateQuery {
  candidateId: string;
}

/** Query shape of `listDiscoveryRuns` (run summaries, newest first). */
export interface ListDiscoveryRunsQuery {
  triggerKind?: DiscoveryTriggerKind;
  /** Runs linked to this cognitive execution. */
  originExecutionId?: string;
  /** Runs with at least one candidate affecting this goals-module record. */
  affectedGoalId?: string;
  /** Runs with at least one candidate in this disposition. */
  disposition?: CandidateDisposition;
  /** 1..500, default 50. */
  limit?: number;
}

/**
 * One run summary of `listDiscoveryRuns` — the run without the embedded
 * candidate list (deep-link with `getDiscoveryRun`).
 */
export type DiscoveryRunSummary = Omit<DiscoveryRun, 'candidates'>;
