// Public domain types of the workforce module (W019 — Workforce
// Intelligence).
//
// The work item (spec/work-items/WORK-ITEM-CATALOG.md, W019):
// "Assess workload, role/capability fit, performance signals and staffing
//  needs while preserving alternative explanations and human decision
//  authority."
//
// ARCHITECTURE.md §14 (frozen) governs this module:
// "Workforce intelligence assesses role expectations, capabilities,
//  workload, process context, outcomes and alternatives. It must separate
//  observed behavior from interpretation. Employment-impacting results
//  follow `evidence → assessment → alternative explanations → alternatives
//  → recommendation → authorized human decision`.
//  Aurum never autonomously terminates a human employee."
//
// That quote fixes the shape of this module:
//
//   OBSERVED BEHAVIOR (the evidence side — never interpretation)
//     RoleExpectation — a role's EXPECTATIONS: required capabilities (opaque
//        forward references to the capabilities module, W017) and expected
//        weekly hours. Versioned understanding (identity + append-only
//        version chain) in the goals (W008)/capabilities (W017) discipline.
//     RoleAssignment — who holds which role at which allocation fraction
//        (share of the employee's working capacity). Versioned; the employee
//        is an opaque people-module (W002) reference, immutable identity
//        content.
//     WorkforceSignal — an immutable measurement of OBSERVED behavior: a
//        workload value (hours per week) or a performance value (normalized
//        outcome score in [0, 1]), recorded with provenance (actor +
//        principal + optional evidence observation references, W004).
//        Signals never carry interpretation and can never be mutated —
//        corrections are new signals.
//
//   INTERPRETATION (the assessment side — the §14 chain)
//     WorkforceAssessment — the computed interpretation of one employee at
//        one point in time: workload / role-capability fit / performance /
//        staffing classifications (deterministic pure functions of the
//        current records, assessment.ts), the ALTERNATIVE EXPLANATIONS that
//        must be preserved (lock 20), the ALTERNATIVES (courses of action),
//        the RECOMMENDATION, and its CONFIDENCE (uncertainty preserved —
//        GOVERNANCE.md "employee-impacting findings preserve evidence and
//        uncertainty"). Assessments are versioned per employee: a new
//        assessment of the same employee appends the next version.
//     WorkforceDecision — the authorized HUMAN decision on one assessment
//        version: the chain's terminus. Exactly one decision per version
//        (first wins), recorded by a human decider (kind 'person') holding
//        the 'workforce:decide' authority claim. Append-only.
//
// Lock 21 ("Aurum never autonomously terminates a human employee") is
// structural here: the module EXPOSES NO employment-status or execution
// operation at all. A 'termination' recommendation is representable (the
// architecture's chain explicitly contemplates employment-impacting
// recommendations) but it is the most heavily guarded kind — it requires
// adverse computed findings, preserved uncertainty, alternative
// explanations AND alternatives (enforced in validation and mirrored by
// storage CHECK constraints), and it still terminates in nothing but a
// recorded human decision. Employment changes themselves belong to the
// people module (W002) under their own authority; this module recommends
// and records decisions, nothing more.
//
// Cross-module posture (the W017→W019 dependency declared in
// WORK-ITEM-DEPENDENCY-GRAPH.md): the employee's capability supplies are
// read through the capabilities module's contract (`listSupplies` — the
// capabilities contract documents that "the workforce (W019) ... modules
// read a person's ... capabilities through THIS surface"); capability ids
// in role expectations are opaque uuid forward references to the same
// module. People (employees), observations (evidence) and processes
// (context) stay opaque references — the events/observations precedent —
// so no other module is a code dependency.

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/** The two kinds of observed behavior a workforce signal can measure. */
export type WorkforceSignalKind = 'workload' | 'performance';

/**
 * Lifecycle status of a role expectation or role assignment (versioned
 * content). Retired records are out of the operating scope: assignments
 * against retired roles never feed assessments (the retired supply
 * discipline of W017).
 */
export type WorkforceRecordStatus = 'active' | 'retired';

/** What kind of change one role-expectation version represents (service-minted). */
export type RoleChangeKind = 'created' | 'revised' | 'retired' | 'reactivated';

/** What kind of change one role-assignment version represents (service-minted). */
export type AssignmentChangeKind = 'assigned' | 'revised' | 'retired' | 'reactivated';

/** What kind of change one assessment version represents (service-minted). */
export type AssessmentChangeKind = 'issued' | 'reassessed';

/** Deterministic workload classification of one employee. */
export type WorkloadStatus =
  | 'unassigned' // no active role assignments
  | 'overallocated' // total allocation across active assignments exceeds 1
  | 'overloaded' // observed weekly hours exceed committed hours by more than the margin
  | 'underloaded' // observed weekly hours fall below committed hours by more than the margin
  | 'at_capacity' // structurally committed and observed workload agree
  | 'insufficient_evidence'; // assignments exist, no workload signal in the window

/** Deterministic role/capability fit classification of one employee. */
export type FitStatus =
  | 'unknown' // the employee's active roles require no capabilities
  | 'fits' // every required capability is met by an active recorded supply
  | 'partial' // some required capabilities are met
  | 'does_not_fit'; // no required capability is met

/** Deterministic performance classification of one employee. */
export type PerformanceStatus =
  | 'strong' // mean performance score at/above the strong threshold
  | 'satisfactory' // at/above the satisfactory threshold
  | 'needs_attention' // below the satisfactory threshold
  | 'insufficient_evidence'; // no performance signal in the window

/** Deterministic staffing-need classification of one employee. */
export type StaffingStatus =
  | 'adequate' // workload at capacity — no staffing action indicated
  | 'relief_needed' // overallocated/overloaded — offload or add capacity
  | 'surplus' // underloaded/unassigned — spare capacity
  | 'unknown'; // cannot be classified honestly from the evidence

/**
 * The recommendation kinds this module can carry. The three
 * EMPLOYMENT-IMPACTING kinds ('role_change', 'performance_action',
 * 'termination') are guarded by the lock-20 representation requirements and
 * (for the two adverse-action kinds) by adverse-grounding; see
 * assessment.ts and migrations/001-workforce.sql.
 */
export type RecommendationKind =
  | 'redistribute_work'
  | 'training'
  | 'hire'
  | 'role_change'
  | 'performance_action'
  | 'process_improvement'
  | 'automation'
  | 'monitor'
  | 'no_action'
  | 'termination';

/** The employment-impacting recommendation kinds (lock 20/21 guard scope). */
export type EmploymentImpactingRecommendationKind =
  | 'role_change'
  | 'performance_action'
  | 'termination';

/**
 * The courses of action an assessment may list as ALTERNATIVES — the
 * acquisition/option vocabulary of ARCHITECTURE.md §13 (train, reassign,
 * hire, recruit agent, install software, outsource) plus workload actions
 * and epistemic actions (investigate further, no change).
 */
export type AlternativeKind =
  | 'redistribute_work'
  | 'reassign'
  | 'train'
  | 'hire'
  | 'recruit_agent'
  | 'install_software'
  | 'outsource'
  | 'process_improvement'
  | 'investigate_further'
  | 'no_change';

/** The human decisions recordable on one assessment version. */
export type WorkforceDecisionKind =
  | 'accepted'
  | 'rejected'
  | 'superseded'
  | 'more_information_needed';

// ---------------------------------------------------------------------------
// Provider-neutral parties
// ---------------------------------------------------------------------------

/** Audit-actor kinds (the events envelope's actor vocabulary minus `source`). */
export type WorkforcePartyKind = 'person' | 'team' | 'agent' | 'system' | 'external';

/**
 * A provider-neutral party reference (lock 16): an opaque `id` owned by the
 * respective module, a human-readable `label`, or both. Audit actors
 * (kind person/team/agent/system/external) are the events-envelope
 * vocabulary; employees and human deciders have dedicated shapes below.
 */
export interface WorkforceParty {
  kind: WorkforcePartyKind;
  id?: string | null;
  label?: string | null;
}

/** Input shape of `WorkforceParty`. */
export interface WorkforcePartyInput {
  kind: WorkforcePartyKind;
  id?: string | null;
  label?: string | null;
}

/**
 * The assessed subject: an opaque reference to a people-module (W002)
 * employee. The id is REQUIRED — an employment-relevant record must be
 * traceable to a specific employee record (labels alone are not identity).
 * Use the same id the capabilities module's supplies carry as
 * `supplier.id`, so capability fit can be read through that contract.
 */
export interface EmployeeReference {
  id: string;
  label?: string | null;
}

/** The human decider of a workforce decision: always a person, always traceable. */
export interface HumanDecider {
  kind: 'person';
  id: string;
  label?: string | null;
}

/** The decider party as stored/returned (kind is always 'person'). */
export interface StoredHumanDecider {
  kind: 'person';
  id: string;
  label: string | null;
}

// ---------------------------------------------------------------------------
// Role expectations
// ---------------------------------------------------------------------------

/** One capability requirement of a role: an opaque capabilities-module (W017) capability id + minimum level. */
export interface RoleCapabilityRequirement {
  capabilityId: string;
  /** Minimum proficiency in [0, 1]; 0 = presence suffices. */
  minLevel: number;
}

/** Input shape of a role capability requirement (minLevel defaults to 0). */
export interface RoleCapabilityRequirementInput {
  capabilityId: string;
  minLevel?: number;
}

/** Input shape of `registerRole`. */
export interface RegisterRoleInput {
  /** Tenant-unique immutable graph key (1..200 chars). */
  roleKey: string;
  title?: string | null;
  description?: string | null;
  /** Required capabilities (≤ 32; replaces wholesale on revision). */
  requiredCapabilities?: RoleCapabilityRequirementInput[];
  /** Expected weekly hours a fully-allocated holder commits, in (0, 168]. */
  expectedWeeklyHours: number;
  actor: WorkforcePartyInput;
  rationale?: string | null;
}

/** Patch shape of `reviseRole` (undefined = carry over, null = clear). */
export interface ReviseRoleInput {
  roleId: string;
  title?: string | null;
  description?: string | null;
  requiredCapabilities?: RoleCapabilityRequirementInput[];
  expectedWeeklyHours?: number;
  /** Lifecycle change; must be the only change in its revision (surgical). */
  status?: WorkforceRecordStatus;
  actor: WorkforcePartyInput;
  rationale?: string | null;
}

/** Audit summary shared by all current views. */
export interface WorkforceChangeSummary {
  kind: RoleChangeKind | AssignmentChangeKind | AssessmentChangeKind;
  actor: WorkforceParty;
  changedByPrincipal: string;
  rationale: string | null;
  recordedAt: string;
}

/** The current view of a role expectation. */
export interface RoleExpectation {
  id: string;
  tenantId: string;
  /** Immutable tenant-unique graph key. */
  roleKey: string;
  version: number;
  title: string | null;
  description: string | null;
  requiredCapabilities: RoleCapabilityRequirement[];
  expectedWeeklyHours: number;
  status: WorkforceRecordStatus;
  /** Assignment summary over the CURRENT assignment versions. */
  assignmentSummary: RoleAssignmentSummary;
  createdAt: string;
  updatedAt: string;
  lastChange: WorkforceChangeSummary;
}

/** How many assignments of each status a role currently has. */
export interface RoleAssignmentSummary {
  activeCount: number;
  retiredCount: number;
}

/** One append-only version of a role expectation — the audit record (self-contained). */
export interface RoleExpectationVersion {
  id: string;
  tenantId: string;
  roleId: string;
  version: number;
  changeKind: RoleChangeKind;
  roleKey: string;
  title: string | null;
  description: string | null;
  requiredCapabilities: RoleCapabilityRequirement[];
  expectedWeeklyHours: number;
  status: WorkforceRecordStatus;
  actor: WorkforceParty;
  changedByPrincipal: string;
  rationale: string | null;
  recordedAt: string;
}

// ---------------------------------------------------------------------------
// Role assignments
// ---------------------------------------------------------------------------

/** Input shape of `assignRole`. */
export interface AssignRoleInput {
  roleId: string;
  /** The employee holding the role (opaque people-module reference). */
  employee: EmployeeReference;
  /** Share of the employee's working capacity in (0, 1]; default 1. */
  allocation?: number;
  /** Observation (W004) ids cited as evidence (≤ 32, opaque forward references). */
  evidenceObservationIds?: string[];
  note?: string | null;
  actor: WorkforcePartyInput;
  rationale?: string | null;
}

/** Patch shape of `reviseAssignment` (undefined = carry over; the role and employee are immutable). */
export interface ReviseAssignmentInput {
  assignmentId: string;
  allocation?: number;
  status?: WorkforceRecordStatus;
  /** Replaces the previous evidence list wholesale. */
  evidenceObservationIds?: string[];
  note?: string | null;
  actor: WorkforcePartyInput;
  rationale?: string | null;
}

/** The current view of a role assignment. */
export interface RoleAssignment {
  id: string;
  tenantId: string;
  roleId: string;
  /** Lightweight reference to the role's current identity + lifecycle. */
  role: { id: string; roleKey: string; status: WorkforceRecordStatus };
  /** Immutable identity content: who holds the role. */
  employee: StoredEmployeeReference;
  version: number;
  allocation: number;
  status: WorkforceRecordStatus;
  evidenceObservationIds: string[];
  note: string | null;
  createdAt: string;
  updatedAt: string;
  lastChange: WorkforceChangeSummary;
}

/** The employee reference as stored/returned. */
export interface StoredEmployeeReference {
  id: string;
  label: string | null;
}

/** One append-only version of a role assignment — the audit record (self-contained). */
export interface RoleAssignmentVersion {
  id: string;
  tenantId: string;
  assignmentId: string;
  roleId: string;
  version: number;
  changeKind: AssignmentChangeKind;
  employee: StoredEmployeeReference;
  allocation: number;
  status: WorkforceRecordStatus;
  evidenceObservationIds: string[];
  note: string | null;
  actor: WorkforceParty;
  changedByPrincipal: string;
  rationale: string | null;
  recordedAt: string;
}

// ---------------------------------------------------------------------------
// Workforce signals (observed behavior — immutable)
// ---------------------------------------------------------------------------

/** Input shape of `recordSignal`. */
export interface RecordSignalInput {
  employee: EmployeeReference;
  kind: WorkforceSignalKind;
  /** Workload: hours per week in [0, 168]; performance: score in [0, 1]. */
  value: number;
  evidenceObservationIds?: string[];
  note?: string | null;
  actor: WorkforcePartyInput;
}

/** An immutable observed-behavior measurement with provenance. */
export interface WorkforceSignal {
  id: string;
  tenantId: string;
  employee: StoredEmployeeReference;
  kind: WorkforceSignalKind;
  value: number;
  evidenceObservationIds: string[];
  note: string | null;
  actor: WorkforceParty;
  recordedByPrincipal: string;
  /** ISO 8601. */
  recordedAt: string;
}

// ---------------------------------------------------------------------------
// The assessment (interpretation)
// ---------------------------------------------------------------------------

/** The deterministic workload assessment of one employee. */
export interface WorkloadAssessment {
  status: WorkloadStatus;
  /** Sum of allocations over considered active assignments (0 when unassigned). */
  totalAllocation: number;
  /** Sum of allocation × role expectedWeeklyHours over considered active assignments. */
  committedWeeklyHours: number;
  /** Mean observed weekly hours from workload signals in the window; null when none. */
  observedWeeklyHours: number | null;
  workloadSignalCount: number;
  /** The workload margin used (observed vs committed tolerance). */
  margin: number;
}

/** One required capability's fit result. */
export interface CapabilityFitDetail {
  capabilityId: string;
  requiredLevel: number;
  /** Best active recorded supply level of this employee; null when none is recorded. */
  suppliedLevel: number | null;
  met: boolean;
}

/** The deterministic role/capability fit assessment of one employee. */
export interface FitAssessment {
  status: FitStatus;
  requiredCount: number;
  metCount: number;
  /** Every required capability with its fit result (the full evidence snapshot). */
  details: CapabilityFitDetail[];
  /** The unmet requirements (the subset with met = false). */
  unmet: CapabilityFitDetail[];
}

/** The deterministic performance assessment of one employee. */
export interface PerformanceAssessment {
  status: PerformanceStatus;
  /** Mean performance signal score in the window; null when none. */
  score: number | null;
  signalCount: number;
  strongThreshold: number;
  satisfactoryThreshold: number;
}

/** The deterministic staffing-need assessment of one employee. */
export interface StaffingAssessment {
  status: StaffingStatus;
  /** Weekly hours of load to offload (relief_needed only). */
  neededWeeklyHoursReduction: number | null;
  /** Weekly hours apparently spare (surplus only; null when not measurable). */
  surplusWeeklyHours: number | null;
}

/** Honest scope counts of one assessment computation (bounded inputs, reported). */
export interface AssessmentScope {
  /** Active assignments considered. */
  consideredActiveAssignmentCount: number;
  /** Active assignments excluded because their role is retired. */
  excludedRetiredRoleAssignmentCount: number;
  /** Active assignments beyond the consideration bound (not considered). */
  unconsideredAssignmentOverflowCount: number;
  /** Distinct required capabilities after the union across roles. */
  requiredCapabilityCount: number;
  /** Required capabilities beyond the union bound (not considered). */
  requiredCapabilityOverflowCount: number;
}

/**
 * An alternative EXPLANATION — a preserved reading of the evidence that
 * competes with the recommendation's implied reading (lock 20).
 * `source: 'generated'` explanations are the module's deterministic
 * candidates; `source: 'stated'` ones were supplied by the caller.
 */
export interface AlternativeExplanation {
  text: string;
  source: 'generated' | 'stated';
}

/**
 * An ALTERNATIVE course of action (§13's acquisition options and workload
 * actions). `source` as above.
 */
export interface AssessmentAlternative {
  kind: AlternativeKind;
  description: string;
  source: 'generated' | 'stated';
}

/** The assessment options (all snapshotted on every version for reproducibility, lock 37). */
export interface AssessmentOptions {
  /** Signal window in weeks (1..52); default 4. */
  windowWeeks: number;
  /** Observed-vs-committed tolerance in [0, 1]; default 0.15. */
  workloadMargin: number;
  /** Performance score at/above which the status is 'strong' ([0, 1]; default 0.75). */
  performanceStrong: number;
  /** Performance score at/above which the status is 'satisfactory' ([0, 1]; default 0.5). */
  performanceSatisfactory: number;
}

/** Input shape of `AssessmentOptions` (all optional, defaults apply). */
export interface AssessmentOptionsInput {
  windowWeeks?: number;
  workloadMargin?: number;
  performanceStrong?: number;
  performanceSatisfactory?: number;
}

/** Caller-supplied alternative explanation. */
export interface AlternativeExplanationInput {
  text: string;
}

/** Caller-supplied alternative course of action. */
export interface AlternativeActionInput {
  kind: AlternativeKind;
  description: string;
}

/** Input shape of `assessWorkforce`. */
export interface AssessWorkforceInput {
  employee: EmployeeReference;
  recommendation: {
    kind: RecommendationKind;
    /** The recommendation's human-readable statement (1..2000 chars). */
    text: string;
  };
  /** The assessment's overall confidence in [0, 1] (< 1 required when employment-impacting). */
  confidence: number;
  options?: AssessmentOptionsInput;
  /** Caller-added alternative explanations (module-generated ones are always included). */
  additionalAlternativeExplanations?: AlternativeExplanationInput[];
  /** Caller-added alternatives (module-generated ones are always included). */
  additionalAlternatives?: AlternativeActionInput[];
  /** Observation (W004) ids cited directly as evidence (≤ 32). */
  evidenceObservationIds?: string[];
  actor: WorkforcePartyInput;
  rationale?: string | null;
}

/** The computed interpretation, as stored per version and returned. */
export interface AssessmentContent {
  workload: WorkloadAssessment;
  fit: FitAssessment;
  performance: PerformanceAssessment;
  staffing: StaffingAssessment;
  scope: AssessmentScope;
  /**
   * The adverse computed findings (canonical codes, e.g. 'workload_overloaded'),
   * grounding requirement for 'termination' / 'performance_action'.
   */
  adverseFindings: string[];
  alternativeExplanations: AlternativeExplanation[];
  alternatives: AssessmentAlternative[];
  recommendation: {
    kind: RecommendationKind;
    text: string;
    employmentImpacting: boolean;
  };
  confidence: number;
  options: AssessmentOptions;
  /** Signal ids that fed this assessment. */
  consideredSignalIds: string[];
  /** Observation ids cited directly by the caller. */
  evidenceObservationIds: string[];
}

/** The current view of a workforce assessment. */
export interface WorkforceAssessment {
  id: string;
  tenantId: string;
  employee: StoredEmployeeReference;
  version: number;
  changeKind: AssessmentChangeKind;
  /** The full computed interpretation (self-contained snapshot). */
  content: AssessmentContent;
  versionCount: number;
  /** Decisions ever recorded on this assessment (all versions). */
  decisionCount: number;
  /** The decision on the CURRENT version, when one exists. */
  decision: WorkforceDecision | null;
  createdAt: string;
  updatedAt: string;
  lastChange: WorkforceChangeSummary;
}

/** One append-only version of an assessment — the audit record (self-contained). */
export interface WorkforceAssessmentVersion {
  id: string;
  tenantId: string;
  assessmentId: string;
  version: number;
  changeKind: AssessmentChangeKind;
  employee: StoredEmployeeReference;
  content: AssessmentContent;
  actor: WorkforceParty;
  changedByPrincipal: string;
  rationale: string | null;
  recordedAt: string;
}

// ---------------------------------------------------------------------------
// Human decisions
// ---------------------------------------------------------------------------

/** Input shape of `recordDecision`. */
export interface RecordDecisionInput {
  assessmentId: string;
  /** Assessment version decided; defaults to the current version. */
  version?: number;
  decision: WorkforceDecisionKind;
  /** The human decider — kind 'person' with a required id. */
  decider: HumanDecider;
  rationale?: string | null;
  /** Optional note on what happens next. */
  followUpNote?: string | null;
}

/** The authorized human decision on one assessment version (append-only). */
export interface WorkforceDecision {
  id: string;
  tenantId: string;
  assessmentId: string;
  assessmentVersion: number;
  decision: WorkforceDecisionKind;
  decider: StoredHumanDecider;
  decidedByPrincipal: string;
  rationale: string | null;
  followUpNote: string | null;
  /** ISO 8601. */
  decidedAt: string;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Query shape of `listRoles` (over CURRENT versions only). */
export interface ListRolesQuery {
  /** Case-insensitive substring on the role key. */
  search?: string;
  status?: WorkforceRecordStatus;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `getRoleVersion`. */
export interface GetRoleVersionQuery {
  roleId: string;
  version: number;
}

/** Query shape of `listRoleVersions`. */
export interface ListRoleVersionsQuery {
  roleId: string;
}

/** Query shape of `listAssignments` (over CURRENT versions only). */
export interface ListAssignmentsQuery {
  roleId?: string;
  /** Exact match on the employee reference id. */
  employeeId?: string;
  status?: WorkforceRecordStatus;
  limit?: number;
}

/** Query shape of `getAssignmentVersion`. */
export interface GetAssignmentVersionQuery {
  assignmentId: string;
  version: number;
}

/** Query shape of `listAssignmentVersions`. */
export interface ListAssignmentVersionsQuery {
  assignmentId: string;
}

/** Query shape of `getSignal`. */
export interface GetSignalQuery {
  signalId: string;
}

/** Query shape of `listSignals` (newest first). */
export interface ListSignalsQuery {
  employeeId?: string;
  kind?: WorkforceSignalKind;
  limit?: number;
}

/** Query shape of `getAssessmentVersion`. */
export interface GetAssessmentVersionQuery {
  assessmentId: string;
  version: number;
}

/** Query shape of `listAssessmentVersions`. */
export interface ListAssessmentVersionsQuery {
  assessmentId: string;
}

/** Query shape of `listAssessments` (over CURRENT versions only). */
export interface ListAssessmentsQuery {
  employeeId?: string;
  employmentImpacting?: boolean;
  recommendationKind?: RecommendationKind;
  limit?: number;
}

/** Query shape of `getDecision`. */
export interface GetDecisionQuery {
  decisionId: string;
}

/** Query shape of `listDecisions`. */
export interface ListDecisionsQuery {
  assessmentId?: string;
  decisionKind?: WorkforceDecisionKind;
  limit?: number;
}
