// ============================================================================
// workforce — the ONLY public surface of the workforce module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W019 — Workforce Intelligence:
// "Assess workload, role/capability fit, performance signals and staffing
//  needs while preserving alternative explanations and human decision
//  authority."
//
//   Roles (the expectation side)
//     registerRole       — register a named role expectation (version 1
//        'created', status minted 'active'). The role key is the
//        tenant-unique IMMUTABLE graph key: registering an existing key
//        fails with `role_key_conflict` — revise the winner instead. The
//        role carries its capability requirements (opaque forward
//        references to the capabilities module, W017) and the expected
//        weekly hours of a fully-allocated holder.
//     reviseRole         — append the next version. Omitted fields carry
//        over; `null` clears; `requiredCapabilities` replaces wholesale; a
//        `status` change must be the only change (surgical); a retired role
//        accepts nothing but a reactivation.
//     getRole / listRoles — current views (with assignment summaries),
//        filtered (key search, status), ordered by key.
//     getRoleVersion / listRoleVersions — the audit deep links.
//
//   Assignments (who holds which role, at which allocation)
//     assignRole         — assign one employee to one role (version 1
//        'assigned', status minted 'active'). The employee is an OPAQUE
//        people-module reference (id required) and is IMMUTABLE identity
//        content: (role, employee) is the graph key. The role must be
//        active — a retired role accepts no new assignment. Allocation is
//        the share of the employee's working capacity in (0, 1] (default 1).
//     reviseAssignment   — append the next version (allocation, evidence
//        list, note; surgical status transitions). The role and the
//        employee are immutable.
//     getAssignment / listAssignments — current views, filtered (role,
//        employee id, status). The view always reports the role's CURRENT
//        key/lifecycle, so a retired role's assignments are visible as
//        such (and assessments exclude them, with the count reported).
//     getAssignmentVersion / listAssignmentVersions — the audit deep links.
//
//   Signals (OBSERVED BEHAVIOR — immutable, never interpretation)
//     recordSignal       — record one measurement of observed behavior:
//        kind 'workload' (hours per week in [0, 168]) or 'performance'
//        (score in [0, 1]), with provenance (actor + principal) and
//        optional evidence observation references (W004). There is NO
//        update or delete operation, and PostgreSQL itself rejects
//        UPDATE/DELETE/TRUNCATE on the table (migration 001 triggers) — a
//        measurement is a fact; corrections are new signals.
//     getSignal / listSignals — by id, or filtered (employee, kind),
//        newest first.
//
//   Assessments (the INTERPRETATION — the §14 chain)
//     assessWorkforce    — compute and append the next assessment version
//        of one employee (version 1 'issued', later versions 'reassessed';
//        one identity per employee). The service gathers the observed
//        records (active assignments + their roles' current expectations,
//        in-window signals) and the employee's capability supplies READ
//        THROUGH THE CAPABILITIES CONTRACT (`listSupplies` — the documented
//        W017→W019 integration point), computes the deterministic
//        interpretation (assessment.ts): workload / fit / performance /
//        staffing classifications, adverse findings, scope honesty — then
//        merges the GENERATED alternative explanations and alternatives
//        with the caller's stated ones, and appends the whole thing as a
//        self-contained snapshot (evidence citations, recommendation with
//        module-minted employment-impact classification, confidence, and
//        the options it was computed under). EMPLOYMENT-IMPACTING
//        recommendations ('role_change', 'performance_action',
//        'termination') are guarded HERE and again by storage CHECK
//        constraints (lock 20): confidence < 1, ≥ 1 alternative
//        explanation, ≥ 2 distinct alternatives, ≥ 1 evidence reference;
//        'termination'/'performance_action' additionally require ≥ 1
//        adverse computed finding (grounding).
//     getAssessment / listAssessments — current views (with the decision
//        on the current version and decision counts), filtered (employee,
//        employment-impacting, recommendation kind).
//     getAssessmentVersion / listAssessmentVersions — the audit deep links
//        (each version is the full §14 chain snapshot: evidence →
//        assessment → alternative explanations → alternatives →
//        recommendation, lock 37).
//
//   Human decisions (the chain's AUTHORIZED HUMAN DECISION terminus)
//     recordDecision     — record the authorized human decision on one
//        assessment version (defaults to the current version). Requires
//        the 'workforce:decide' authority claim and a HUMAN decider (kind
//        'person', id required). Exactly one decision per version — the
//        first wins (`already_decided`); decisions are append-only and can
//        never be overwritten or erased. There is deliberately NO operation
//        that executes a recommendation, changes employment or even marks
//        one executed: Aurum never autonomously terminates a human employee
//        (lock 21) — employment changes belong to the people module (W002)
//        under their own authority, taken by humans after this chain.
//     getDecision / listDecisions — the decision trail, filtered
//        (assessment, decision kind).
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; access to another tenant's workforce
// intelligence (including versions, signals and decisions) is reported as
// `role_not_found` / `role_version_not_found` / `assignment_not_found` /
// `assignment_version_not_found` / `signal_not_found` /
// `assessment_not_found` / `assessment_version_not_found` /
// `decision_not_found` — no existence leak, including registrations
// against foreign-tenant ids and capability supplies read through the
// capabilities contract (they are tenant-scoped by that module).
//
// Dependency posture: this module imports the capabilities module's
// contract ONLY (the declared W017→W019 dependency) plus src/infra ports.
// People (employees), observations (evidence) and processes (context) are
// opaque forward references — the events/observations precedent.
// ============================================================================

export {
  assignRole,
  assessWorkforce,
  getAssignment,
  getAssignmentVersion,
  getAssessment,
  getAssessmentVersion,
  getDecision,
  getRole,
  getRoleVersion,
  getSignal,
  listAssignments,
  listAssignmentVersions,
  listAssessments,
  listAssessmentVersions,
  listDecisions,
  listRoles,
  listRoleVersions,
  listSignals,
  recordDecision,
  recordSignal,
  registerRole,
  reviseAssignment,
  reviseRole,
} from './service';

export { WorkforceError } from './errors';
export type { WorkforceErrorCode } from './errors';

export {
  ALTERNATIVE_KINDS,
  DEFAULT_ALLOCATION,
  DEFAULT_LIST_LIMIT,
  DEFAULT_PERFORMANCE_SATISFACTORY,
  DEFAULT_PERFORMANCE_STRONG,
  DEFAULT_WINDOW_WEEKS,
  DEFAULT_WORKLOAD_MARGIN,
  MAX_ADDITIONAL_ALTERNATIVES,
  MAX_ADDITIONAL_EXPLANATIONS,
  MAX_ASSIGNMENTS_PER_ASSESSMENT,
  MAX_EVIDENCE_REFS,
  MAX_KEY_LENGTH,
  MAX_LIST_LIMIT,
  MAX_REQUIRED_CAPABILITIES_PER_ASSESSMENT,
  MAX_REQUIRED_CAPABILITIES_PER_ROLE,
  MAX_SEARCH_LENGTH,
  MAX_SIGNALS_PER_ASSESSMENT,
  MAX_SUPPLIES_PER_ASSESSMENT,
  MAX_TEXT_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_WEEKLY_HOURS,
  MIN_WINDOW_WEEKS,
  MAX_WINDOW_WEEKS,
  RECOMMENDATION_KINDS,
  WORKFORCE_AUTHORITY_DECIDE,
  WORKFORCE_DECISION_KINDS,
  WORKFORCE_PARTY_KINDS,
  WORKFORCE_RECORD_STATUSES,
  WORKFORCE_SIGNAL_KINDS,
  escapeLike,
  isAlternativeKind,
  isRecommendationKind,
  isUuid,
  isWorkforceDecisionKind,
  isWorkforcePartyKind,
  isWorkforceRecordStatus,
  isWorkforceSignalKind,
  requireWorkforceDecisionAuthority,
} from './validation';

export type {
  ValidatedAlternativeAction,
  ValidatedAssessmentOptions,
  ValidatedAssignRoleInput,
  ValidatedAssessWorkforceInput,
  ValidatedDecider,
  ValidatedEmployee,
  ValidatedExplanation,
  ValidatedParty,
  ValidatedRecordDecisionInput,
  ValidatedRecordSignalInput,
  ValidatedRegisterRoleInput,
  ValidatedRequirements,
  ValidatedReviseAssignmentInput,
  ValidatedReviseRoleInput,
} from './validation';

export {
  ADVERSE_GROUNDED_RECOMMENDATION_KINDS,
  ALTERNATIVE_KIND_ORDER,
  EMPLOYMENT_IMPACTING_RECOMMENDATION_KINDS,
  WORKLOAD_STATUS_ORDER,
  computeAdverseFindings,
  computeFit,
  computePerformance,
  computeStaffing,
  computeWorkforceAssessment,
  computeWorkload,
  findEmploymentGuardViolation,
  generateAlternatives,
  generateAlternativeExplanations,
  isEmploymentImpacting,
  isRecommendationGrounded,
  mergeAlternatives,
  roundHours,
} from './assessment';
export type {
  AssessmentComputation,
  AssessmentInputs,
  AssignmentInput,
  EmploymentGuardInput,
  SignalInput,
  SupplyInput,
} from './assessment';

export type {
  AlternativeActionInput,
  AlternativeExplanation,
  AlternativeExplanationInput,
  AssessmentAlternative,
  AssessmentChangeKind,
  AssessmentContent,
  AssessmentOptions,
  AssessmentOptionsInput,
  AssessmentScope,
  AssignRoleInput,
  AssessWorkforceInput,
  AssignmentChangeKind,
  CapabilityFitDetail,
  EmployeeReference,
  EmploymentImpactingRecommendationKind,
  FitAssessment,
  FitStatus,
  GetAssignmentVersionQuery,
  GetAssessmentVersionQuery,
  GetDecisionQuery,
  GetRoleVersionQuery,
  GetSignalQuery,
  HumanDecider,
  ListAssignmentsQuery,
  ListAssessmentsQuery,
  ListAssessmentVersionsQuery,
  ListAssignmentVersionsQuery,
  ListDecisionsQuery,
  ListRoleVersionsQuery,
  ListRolesQuery,
  ListSignalsQuery,
  PerformanceAssessment,
  PerformanceStatus,
  RecordDecisionInput,
  RecordSignalInput,
  RecommendationKind,
  RegisterRoleInput,
  ReviseAssignmentInput,
  ReviseRoleInput,
  RoleAssignment,
  RoleAssignmentSummary,
  RoleAssignmentVersion,
  RoleCapabilityRequirement,
  RoleCapabilityRequirementInput,
  RoleChangeKind,
  RoleExpectation,
  RoleExpectationVersion,
  StaffingAssessment,
  StaffingStatus,
  StoredEmployeeReference,
  StoredHumanDecider,
  WorkforceAssessment,
  WorkforceAssessmentVersion,
  WorkforceChangeSummary,
  WorkforceDecision,
  WorkforceDecisionKind,
  WorkforceParty,
  WorkforcePartyInput,
  WorkforcePartyKind,
  WorkforceRecordStatus,
  WorkforceSignal,
  WorkforceSignalKind,
  WorkloadAssessment,
  WorkloadStatus,
} from './types';
