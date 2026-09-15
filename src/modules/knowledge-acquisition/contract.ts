// ============================================================================
// knowledge-acquisition — the ONLY public surface of the module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W012 — Knowledge Acquisition Planner:
// "Choose the next information source/action among employees, managers,
//  systems, documents, external sources, agents and analyses. Verify
//  mission-driven targeted employee questioning."
//
// ARCHITECTURE.md §7: "Aurum has a Knowledge Acquisition Planner that
// selects among employees, managers, internal systems, documents,
// messages, structured business systems, external sources, agents and
// temporary analyses. ... Employees are first-class knowledge sources.
// Aurum may ask an employee targeted questions when policy permits,
// record the resulting contribution, assess evidence quality, update the
// mission, and reward useful contributions." Lock 17: the planner
// "decides where to investigate next; it does not blindly query all
// sources."
//
//   planNextAcquisition  — ONE deterministic planning pass over one
//      mission's current candidate menu: scores every candidate on the
//      separately represented ADR-0018 signals (relevance, reliability,
//      freshness, authority, expected quality, prior contribution value,
//      cost, access scope) with fixed policy/workflow-level weights,
//      excludes candidates that were already attempted for this mission,
//      whose access scope is forbidden, whose cost exceeds the mission's
//      remaining investigation budget, or — for persons — that do not
//      resolve to an active employee with a verified linked identity, or
//      that the tenant's ASK authority matrix forbids; then selects the
//      first eligible candidate in the deterministic order and persists
//      the full ranking rationale (auditable, ADR-0018). For an 'ask-person'
//      selection it composes the targeted, mission-derived question and
//      records the ASK policy evaluation ('allowed' questions may be
//      delivered; 'approval_required' questions are drafted but gated;
//      'forbidden' never selected).
//   recordAcquisitionOutcome — the terminal outcome of one plan
//      (answered / unavailable / failed; first write wins). An answered
//      acquisition MUST carry evidence: it is recorded as an immutable
//      observation through the observations contract with the acquired
//      source as provenance. Updating the mission's confidence from the
//      answer is the caller's job through the missions contract (W013
//      cognition orchestrates; W042/W043 build contributions and rewards
//      on top).
//   getAcquisitionPlan / listAcquisitionPlans — the planner's audit
//      trail: one decision with its rationale and outcome, or the
//      decision feed filtered by mission / decision / action, latest
//      first.
//
// There is deliberately NO operation to update or erase a plan, re-rank
// after the fact, un-answer an acquisition or delete history: planner
// decisions and outcomes are append-only evidence of how Aurum
// investigated (PostgreSQL triggers reject UPDATE/DELETE/TRUNCATE,
// migration 001). The planner also never SENDS anything — message
// delivery belongs to the channels module (W030) and notifications
// (W031); this module records what to ask, of whom, and whether policy
// permits asking.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext
// and is tenant-scoped at the SQL layer; another tenant's missions and
// plans are indistinguishable from missing ones (`mission_not_found` /
// `plan_not_found` — no existence leak).
//
// Dependency posture (WORK-ITEM-DEPENDENCY-GRAPH.md: W002 + W004 + W011
// → W012): this module imports ONLY module contracts — missions (W011,
// the planned-over records), people (W002, person/employee/identity
// resolution for targeted questioning), observations (W004, answer
// evidence) and actions (W009, the ASK authority matrix that §7's "when
// policy permits" and §20's uniform employee-messaging gate are defined
// in; read-only evaluation, no requests are recorded here). The
// MODULE-DEPENDENCY-MAP's `sources` edge (W036) does not exist yet and is
// not needed: system/document/external/agent/analysis candidates are
// opaque references on the mission menu.
// ============================================================================

export {
  getAcquisitionPlan,
  listAcquisitionPlans,
  planNextAcquisition,
  recordAcquisitionOutcome,
} from './service';

// Policy integration points (§7 "when policy permits" → W009's matrix).
export {
  ACQUISITION_CHANNEL,
  ANSWER_OBSERVATION_KIND,
  ASK_ACTION_KIND,
  ASK_AUTHORITY_LEVEL,
} from './service';

// Pure ranking/questioning logic (no database) — reusable by W052
// knowledge source ranking and unit-testable in isolation.
export {
  ACQUISITION_ACTIONS,
  ACQUISITION_ACTION_KINDS,
  CANDIDATE_KIND_ORDER,
  MAX_PERSON_NAME_LENGTH,
  SIGNAL_WEIGHTS,
  candidateKey,
  composeTargetedQuestion,
  computeCostShare,
  isAcquisitionActionKind,
  orderRankedCandidates,
  scoreCandidateSignals,
} from './ranking';

export { KnowledgeAcquisitionError } from './errors';
export type { KnowledgeAcquisitionErrorCode } from './errors';

export {
  ACCESS_SCOPES,
  ACQUISITION_OUTCOME_KINDS,
  DEFAULT_LIST_LIMIT,
  EXCLUSION_REASONS,
  MAX_CONFIDENCE_METHOD_LENGTH,
  MAX_COST_AMOUNT,
  MAX_LABEL_LENGTH,
  MAX_LIST_LIMIT,
  MAX_NOTE_LENGTH,
  MAX_PLAN_CANDIDATES,
  MAX_QUESTION_LENGTH,
  MAX_RATIONALE_LENGTH,
  PLAN_DECISIONS,
  isAccessScope,
  isAcquisitionOutcomeKind,
  isPlanDecision,
  isUuid,
} from './validation';

export type {
  ValidatedCandidateSignals,
  ValidatedListQuery,
  ValidatedOutcomeInput,
  ValidatedPlanInput,
} from './validation';

export type {
  AccessScope,
  AcquisitionActionKind,
  AcquisitionActor,
  AcquisitionActorInput,
  AcquisitionEvidenceInput,
  AcquisitionOutcomeKind,
  AcquisitionPlan,
  AcquisitionPlanOutcome,
  AskPolicyEvaluation,
  CandidateSignals,
  ExclusionReason,
  ListAcquisitionPlansQuery,
  PlanDecision,
  PlanNextAcquisitionInput,
  RankedCandidate,
  RecordAcquisitionOutcomeInput,
  SignalName,
} from './types';
