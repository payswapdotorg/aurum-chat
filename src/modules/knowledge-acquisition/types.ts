// Public domain types of the knowledge-acquisition module (W012 —
// Knowledge Acquisition Planner).
//
// ARCHITECTURE.md §7 (frozen): "Aurum has a Knowledge Acquisition Planner
// that selects among employees, managers, internal systems, documents,
// messages, structured business systems, external sources, agents and
// temporary analyses." Lock 17: "Knowledge Acquisition Planner decides
// where to investigate next; it does not blindly query all sources."
// The work item:
// "Choose the next information source/action among employees, managers,
//  systems, documents, external sources, agents and analyses. Verify
//  mission-driven targeted employee questioning."
//
// The planner is MISSION-DRIVEN by construction: the menu it chooses from
// is the mission's `candidateSources` (W011 — missions/types.ts calls that
// array "the W012 planner's menu"), and the question it composes for a
// person is derived from the mission's knowledge objective. Per plan call
// it selects the NEXT BEST information-gathering action — one source, one
// action — never "query everyone": candidates a previous plan already
// chose for the same mission are excluded (lock 17), candidates whose
// estimated cost exceeds the mission's remaining investigation budget are
// excluded (§6 "investigation budget"), and candidates whose explicit
// access scope or the tenant's ASK authority matrix forbids them are
// excluded (ADR-0018: learning never overrides explicit access policy).
//
// ADR-0018 (accepted at lock 2.1) binds the planner's selection: ranking
// signals — semantic relevance, historical reliability, recency/freshness,
// authority, access scope, expected answer/evidence quality, investigation
// cost and prior contribution value — are SEPARATELY represented, the
// ranking rationale is persisted and auditable, and ranking is
// deterministic at the policy/workflow level: the same inputs and the same
// learned state produce the same ordering. The signal VALUES are caller
// input at this layer (W013 cognition and W052 knowledge source ranking
// compute them from memory, the world model and the CompanyModel); the
// planner owns the deterministic evaluation, selection, budgeting,
// questioning and the persisted rationale.
//
// Employees and managers are first-class knowledge sources (lock 9):
// a `person` candidate that resolves to an active employee with a verified
// linked channel identity is ASKABLE, and asking is policy-gated — the
// planner evaluates the actions module's authority matrix (W009) for the
// canonical 'employee-messaging' kind at the ASK level (§7 "when policy
// permits"; §20 "The authority matrix applies uniformly to employee
// messaging"). The planner never sends anything: it records the targeted
// question and the policy evaluation; delivery belongs to the channels
// module (W030) and notifications (W031), driven by cognition (W013).
//
// Storage discipline (the missions/events precedent): planner decisions
// (`acquisition_plans`) and their outcomes (`acquisition_outcomes`) are
// append-only evidence of how Aurum investigated — UPDATE/DELETE/TRUNCATE
// are rejected by PostgreSQL triggers. A plan is never rewritten; a later
// plan is a new row. First outcome on a plan wins; there is no un-answer.

import type { AuthorityOutcome, PolicyResolutionSource } from '@/modules/actions/contract';
import type { MissionCandidateKind, MissionParty } from '@/modules/missions/contract';

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * The acquisition action the planner maps onto each candidate kind
 * (§7's menu → the action to perform). `person` covers employees and
 * managers (the missions module's candidate vocabulary); `analysis`
 * covers temporary analyses Aurum may run itself.
 */
export type AcquisitionActionKind =
  | 'ask-person'
  | 'query-system'
  | 'retrieve-document'
  | 'fetch-external'
  | 'commission-agent'
  | 'run-analysis';

/** What one planning pass concluded. */
export type PlanDecision = 'selected' | 'no_candidate';

/**
 * Explicit access scope of one candidate (ADR-0018 "access scope" signal).
 * `forbidden` excludes the candidate outright — caller-supplied ranking
 * signals can never override it ("learned source reliability modulates
 * ranking without overriding explicit access policy").
 */
export type AccessScope = 'allowed' | 'approval_required' | 'forbidden';

/**
 * Why one candidate was excluded from selection. The service evaluates the
 * gates in a fixed order per candidate (already_attempted → access →
 * person resolution/employment/reachability/ASK policy → budget) and
 * records the FIRST failing gate, so the persisted rationale is
 * deterministic.
 */
export type ExclusionReason =
  | 'already_attempted'
  | 'access_forbidden'
  | 'person_unresolvable'
  | 'employee_inactive'
  | 'person_unreachable'
  | 'ask_policy_forbidden'
  | 'over_budget';

/** The six positive ADR-0018 ranking signals the score weighs. */
export type SignalName =
  | 'relevance'
  | 'reliability'
  | 'authority'
  | 'freshness'
  | 'expectedQuality'
  | 'priorContributionValue';

/** Terminal outcome of one planned acquisition action. */
export type AcquisitionOutcomeKind = 'answered' | 'unavailable' | 'failed';

// ---------------------------------------------------------------------------
// Planning input
// ---------------------------------------------------------------------------

/** The party driving one planning pass (audit trail). */
export type AcquisitionActor = MissionParty;

export interface AcquisitionActorInput {
  kind: MissionParty['kind'];
  id?: string | null;
  label?: string | null;
}

/**
 * One candidate's ranking signals (ADR-0018), supplied by the caller for
 * every candidate in the mission's current menu. The six positive signals
 * are comparable scores in [0, 1]; `cost` is an integer amount of MINOR
 * UNITS denominated in the mission's investigation-budget currency
 * (IMPLEMENTATION-STACK §8 money convention; no cross-currency conversion
 * exists); `access` is the explicit access scope.
 *
 * `kind`/`id`/`label` identify WHICH menu candidate the signals describe:
 * an id-bearing candidate is matched by (kind, id), a label-only candidate
 * by (kind, label) — the missions module's own candidate identity rule.
 */
export interface CandidateSignals {
  kind: MissionCandidateKind;
  id?: string | null;
  label?: string | null;
  /** Semantic relevance to the mission's knowledge objective. */
  relevance: number;
  /** Historical reliability of the source. */
  reliability: number;
  /** Recency/freshness of the source's knowledge. */
  freshness: number;
  /** Authority of the source on the subject. */
  authority: number;
  /** Expected answer/evidence quality. */
  expectedQuality: number;
  /** Prior contribution value of the source. */
  priorContributionValue: number;
  /** Estimated investigation cost (minor units, mission budget currency). */
  cost: number;
  /** Explicit access scope; `forbidden` excludes the candidate. */
  access: AccessScope;
}

/** Input shape of `planNextAcquisition`. */
export interface PlanNextAcquisitionInput {
  /** The mission to plan the next acquisition action for. */
  missionId: string;
  /**
   * Ranking signals for EVERY candidate in the mission's CURRENT menu
   * (matched by (kind, id) or (kind, label)); extra or missing entries
   * are rejected — the planner never invents signals it was not given.
   */
  candidates: CandidateSignals[];
  /** Who/what is driving this planning pass (audit trail). */
  actor: AcquisitionActorInput;
  /** Why now — optional, recorded on the plan. */
  rationale?: string | null;
}

// ---------------------------------------------------------------------------
// Ranking rationale (persisted per plan)
// ---------------------------------------------------------------------------

/** The ADR-0018 signal vector as persisted on one ranked candidate. */
export interface PersistedSignals {
  relevance: number;
  reliability: number;
  freshness: number;
  authority: number;
  expectedQuality: number;
  priorContributionValue: number;
  cost: number;
  access: AccessScope;
}

/**
 * One candidate's evaluation inside the persisted ranking rationale: the
 * candidate reference, its separately represented signals, its
 * deterministic score, its cost share of the mission's investigation
 * budget, the signal that dominates its score, and — when it was not
 * selected — the deterministic first failing gate.
 */
export interface RankedCandidate {
  candidate: {
    kind: MissionCandidateKind;
    id: string | null;
    label: string | null;
  };
  signals: PersistedSignals;
  /**
   * Deterministic composite score (weighted signal sum minus the cost
   * penalty), rounded to 6 decimals. Range [−0.15, 0.95] by construction
   * of SIGNAL_WEIGHTS.
   */
  score: number;
  /** The candidate's cost as a share of the mission budget, [0, 1]. */
  costShare: number;
  /** The highest-weighted signal contribution — why it scores what it scores. */
  dominantSignal: SignalName;
  status: 'eligible' | 'excluded';
  /** First failing gate when `status` is 'excluded'; null otherwise. */
  exclusion: ExclusionReason | null;
}

/**
 * The actions-module authority evaluation that governed person candidates
 * of this plan (present whenever the planned menu contained at least one
 * `person` candidate): asking an employee a question is an ASK-level
 * 'employee-messaging' action, and the matrix decides whether policy
 * permits it (§7), gates it behind approval, or forbids it (§20).
 */
export interface AskPolicyEvaluation {
  outcome: AuthorityOutcome;
  resolvedVia: PolicyResolutionSource;
}

// ---------------------------------------------------------------------------
// Outcome input
// ---------------------------------------------------------------------------

/**
 * The evidence an answered acquisition produced. Recorded as an immutable
 * observation through the observations contract (W004) with the acquired
 * source as provenance — acquired knowledge enters the loop as evidence,
 * never as authoritative truth (lock 5/10).
 */
export interface AcquisitionEvidenceInput {
  /** The answer/knowledge content — any plain JSON value (non-null). */
  payload: unknown;
  /** Calibrated confidence in the evidence (value in [0, 1]; a lowercase method slug). */
  confidence: {
    value: number;
    method: string;
    basis?: string | null;
  };
  /** Strict ISO 8601; defaults to the commit time (the service clock). */
  observedAt?: string;
}

/** Input shape of `recordAcquisitionOutcome`. */
export interface RecordAcquisitionOutcomeInput {
  planId: string;
  outcome: AcquisitionOutcomeKind;
  /** Required for 'unavailable' and 'failed' — terminal whys are recorded. */
  note?: string | null;
  /** Required for 'answered' — the evidence the acquisition produced. */
  evidence?: AcquisitionEvidenceInput;
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

/** The terminal outcome recorded on one plan (first outcome wins). */
export interface AcquisitionPlanOutcome {
  planId: string;
  outcome: AcquisitionOutcomeKind;
  note: string | null;
  /**
   * Observation id of the recorded answer evidence ('answered' only) —
   * an opaque forward reference to an observations module (W004) record.
   */
  evidenceObservationId: string | null;
  recordedByPrincipal: string;
  /** ISO 8601. */
  recordedAt: string;
}

/**
 * One persisted planner decision — the append-only audit record of WHERE
 * Aurum decided to investigate next and WHY (ADR-0018: ranking rationale
 * is persisted and auditable), plus the outcome that was later recorded
 * on it, if any.
 */
export interface AcquisitionPlan {
  id: string;
  tenantId: string;
  /** The mission this plan was computed for (opaque forward reference). */
  missionId: string;
  /** The mission version this plan was computed against (what the planner saw). */
  missionVersion: number;
  decision: PlanDecision;
  /** The chosen candidate ('selected' only). */
  chosen: {
    kind: MissionCandidateKind;
    id: string | null;
    label: string | null;
  } | null;
  /** The acquisition action mapped onto the chosen candidate ('selected' only). */
  action: AcquisitionActionKind | null;
  /**
   * The targeted, mission-derived question ('ask-person' only): composed
   * deterministically from the mission's title + knowledge objective and
   * addressed to the resolved employee.
   */
  question: string | null;
  /**
   * The ASK authority evaluation that governed person candidates of this
   * plan (present whenever the menu contained person candidates), whether
   * or not a person was chosen.
   */
  askPolicy: AskPolicyEvaluation | null;
  /** The full deterministic ranking rationale (every menu candidate). */
  ranked: RankedCandidate[];
  /** Remaining investigation budget (minor units) BEFORE this plan's commitment. */
  budgetRemaining: number;
  budgetCurrency: string;
  /** The chosen candidate's estimated cost ('selected' only). */
  estimatedCost: number | null;
  actor: AcquisitionActor;
  /** The authenticated TenantContext principal that committed the plan. */
  plannedByPrincipal: string;
  rationale: string | null;
  /** ISO 8601 — when Aurum committed this plan (service clock). */
  recordedAt: string;
  /** The outcome later recorded on this plan, if any. */
  outcome: AcquisitionPlanOutcome | null;
}

/** Query shape of `listAcquisitionPlans`. */
export interface ListAcquisitionPlansQuery {
  /** Plans for one mission. */
  missionId?: string;
  decision?: PlanDecision;
  action?: AcquisitionActionKind;
  /** 1..500, default 50. */
  limit?: number;
}
