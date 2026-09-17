// Pure assessment logic of the workforce module (no database) — the
// deterministic function from the current observed-behavior records to the
// interpretation layer W019 owns: workload, role/capability fit,
// performance and staffing classifications, the generated ALTERNATIVE
// EXPLANATIONS and ALTERNATIVES that must precede employment-impacting
// recommendations (lock 20), the adverse-finding grounding, and the
// employment-impact guard checks.
//
// ARCHITECTURE.md §14: "It must separate observed behavior from
// interpretation." This file IS the separation boundary: every input is an
// observed record (assignment, role expectation, signal, capability
// supply); every output is interpretation, and every interpretation ships
// with its preserved alternatives and its scope honesty. Nothing here is
// persisted by this file, and nothing here consults a clock, a random
// source or an LLM — the same inputs always produce the same assessment
// (deterministic, so it can be recomputed and audited; lock 10 discipline:
// derived interpretation is computed, never trusted blindly, and the
// persisted version snapshot carries the exact computation).
//
// Documented invariants (all tested):
//  * Workload: 'unassigned' when no active assignment exists (observed
//    signals are still reported); 'overallocated' when the total allocation
//    exceeds 1 (structural overcommitment is a finding by itself);
//    otherwise observed hours classify 'overloaded' / 'underloaded' /
//    'at_capacity' against committed hours within the margin; with no
//    workload signal the honest answer is 'insufficient_evidence' — the
//    module never claims "at capacity" without observed evidence.
//  * Fit: required capabilities are the union across the considered active
//    roles (a capability required by two roles demands the MAX of the two
//    minimum levels). A requirement is met when an active recorded supply
//    of the employee reaches its minimum level. No requirements → 'unknown'
//    (the module does not invent a fit verdict from nothing); a missing
//    supply record is NOT evidence the employee lacks the capability —
//    that alternative explanation is always generated.
//  * Performance: the mean of performance signals in the window against
//    the strong/satisfactory thresholds; no signal → 'insufficient_evidence'.
//  * Staffing: derived from workload — relief (with the weekly-hours
//    reduction needed), surplus (with the apparently spare hours), adequate
//    or unknown. Hours outputs are rounded to 2 decimals for stable
//    persistence and comparison.
//  * Adverse findings: the canonical codes of every not-okay dimension.
//    'termination' and 'performance_action' recommendations require at
//    least one (ungrounded otherwise) — an employment-impacting adverse
//    action must be grounded in a computed finding, not in prose.
//  * Generated explanations/alternatives: deterministic text templates per
//    status; alternatives dedupe by kind in the vocabulary's canonical
//    order; caller-stated entries append after the generated ones (kinds
//    already present are not duplicated).

import type {
  AlternativeExplanation,
  AlternativeKind,
  AssessmentAlternative,
  AssessmentScope,
  FitAssessment,
  PerformanceAssessment,
  RecommendationKind,
  StaffingAssessment,
  WorkforceRecordStatus,
  WorkloadAssessment,
} from './types';

/** The recommendation kinds whose acceptance would impact a human employee's employment. */
export const EMPLOYMENT_IMPACTING_RECOMMENDATION_KINDS: readonly RecommendationKind[] = [
  'role_change',
  'performance_action',
  'termination',
];

/**
 * The adverse-action recommendation kinds that additionally require at
 * least one adverse computed finding (an employment-impacting adverse
 * action must be grounded in the assessment, not in prose). 'role_change'
 * is exempt: role changes may be neutral or positive (growth moves), so
 * only the lock-20 representation guards apply to it.
 */
export const ADVERSE_GROUNDED_RECOMMENDATION_KINDS: readonly RecommendationKind[] = [
  'performance_action',
  'termination',
];

/** The alternative vocabulary in canonical order (generated lists use it; dedupe keeps it). */
export const ALTERNATIVE_KIND_ORDER: readonly AlternativeKind[] = [
  'redistribute_work',
  'reassign',
  'train',
  'hire',
  'recruit_agent',
  'install_software',
  'outsource',
  'process_improvement',
  'investigate_further',
  'no_change',
];

/** Canonical severity-ish display order of the workload statuses (informational). */
export const WORKLOAD_STATUS_ORDER: readonly string[] = [
  'unassigned',
  'overallocated',
  'overloaded',
  'underloaded',
  'at_capacity',
  'insufficient_evidence',
];

/** Round an hours quantity to 2 decimals (stable persistence/comparison). */
export function roundHours(value: number): number {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// Inputs (all observed records; prepared by the service)
// ---------------------------------------------------------------------------

/** One considered active assignment with its role's current expectations. */
export interface AssignmentInput {
  assignmentId: string;
  allocation: number;
  role: {
    id: string;
    roleKey: string;
    status: WorkforceRecordStatus;
    expectedWeeklyHours: number;
    requiredCapabilities: { capabilityId: string; minLevel: number }[];
  };
}

/** One observed signal in the assessment window. */
export interface SignalInput {
  id: string;
  kind: 'workload' | 'performance';
  value: number;
}

/** One active recorded capability supply of the employee (from the capabilities contract). */
export interface SupplyInput {
  capabilityId: string;
  level: number;
}

/** Everything the pure computation needs (the service prepares and bounds it). */
export interface AssessmentInputs {
  assignments: AssignmentInput[]; // ACTIVE assignments only, in canonical order
  /** Active assignments excluded because their role is retired (count only). */
  excludedRetiredRoleAssignmentCount: number;
  /** Active assignments beyond the consideration bound (count only). */
  unconsideredAssignmentOverflowCount: number;
  workloadSignals: SignalInput[];
  performanceSignals: SignalInput[];
  supplies: SupplyInput[];
  options: {
    windowWeeks: number;
    workloadMargin: number;
    performanceStrong: number;
    performanceSatisfactory: number;
  };
  /** Union bound for distinct required capabilities across roles. */
  maxRequiredCapabilities: number;
}

// ---------------------------------------------------------------------------
// Workload
// ---------------------------------------------------------------------------

/** Deterministic workload classification (see file-header invariants). */
export function computeWorkload(
  assignments: AssignmentInput[],
  workloadSignals: SignalInput[],
  margin: number,
): WorkloadAssessment {
  const activeAssignments = assignments.filter((assignment) => assignment.role.status === 'active');
  const totalAllocation = activeAssignments.reduce((sum, a) => sum + a.allocation, 0);
  const committedWeeklyHours = roundHours(
    activeAssignments.reduce((sum, a) => sum + a.allocation * a.role.expectedWeeklyHours, 0),
  );
  const observedWeeklyHours =
    workloadSignals.length === 0
      ? null
      : roundHours(
          workloadSignals.reduce((sum, signal) => sum + signal.value, 0) / workloadSignals.length,
        );

  let status: WorkloadAssessment['status'];
  if (activeAssignments.length === 0) {
    status = 'unassigned';
  } else if (totalAllocation > 1) {
    status = 'overallocated';
  } else if (observedWeeklyHours === null) {
    status = 'insufficient_evidence';
  } else if (observedWeeklyHours > committedWeeklyHours * (1 + margin)) {
    status = 'overloaded';
  } else if (observedWeeklyHours < committedWeeklyHours * (1 - margin)) {
    status = 'underloaded';
  } else {
    status = 'at_capacity';
  }

  return {
    status,
    totalAllocation,
    committedWeeklyHours,
    observedWeeklyHours,
    workloadSignalCount: workloadSignals.length,
    margin,
  };
}

// ---------------------------------------------------------------------------
// Role/capability fit
// ---------------------------------------------------------------------------

/**
 * Deterministic fit classification: the union of the considered active
 * roles' capability requirements (max min-level per capability), each met
 * by the employee's best active recorded supply level.
 */
export function computeFit(
  assignments: AssignmentInput[],
  supplies: SupplyInput[],
  maxRequiredCapabilities: number,
): { fit: FitAssessment; scope: Pick<AssessmentScope, 'requiredCapabilityCount' | 'requiredCapabilityOverflowCount'> } {
  // Union of requirements across ACTIVE roles; duplicates demand the max.
  const required = new Map<string, number>();
  for (const assignment of assignments) {
    if (assignment.role.status !== 'active') continue;
    for (const requirement of assignment.role.requiredCapabilities) {
      const previous = required.get(requirement.capabilityId);
      if (previous === undefined || requirement.minLevel > previous) {
        required.set(requirement.capabilityId, requirement.minLevel);
      }
    }
  }
  // Best active supply level per capability.
  const supplied = new Map<string, number>();
  for (const supply of supplies) {
    const previous = supplied.get(supply.capabilityId);
    if (previous === undefined || supply.level > previous) {
      supplied.set(supply.capabilityId, supply.level);
    }
  }

  // Deterministic order: capability id ascending; bound the union honestly.
  const capabilityIds = [...required.keys()].sort();
  const considered = capabilityIds.slice(0, maxRequiredCapabilities);
  const requiredCapabilityOverflowCount = Math.max(0, capabilityIds.length - maxRequiredCapabilities);

  const details = considered.map((capabilityId) => {
    const requiredLevel = required.get(capabilityId)!;
    const suppliedLevel = supplied.get(capabilityId) ?? null;
    return {
      capabilityId,
      requiredLevel,
      suppliedLevel,
      met: suppliedLevel !== null && suppliedLevel >= requiredLevel,
    };
  });
  const metCount = details.filter((detail) => detail.met).length;

  let status: FitAssessment['status'];
  if (details.length === 0) status = 'unknown';
  else if (metCount === details.length) status = 'fits';
  else if (metCount === 0) status = 'does_not_fit';
  else status = 'partial';

  return {
    fit: {
      status,
      requiredCount: details.length,
      metCount,
      details,
      unmet: details.filter((detail) => !detail.met),
    },
    scope: {
      requiredCapabilityCount: details.length,
      requiredCapabilityOverflowCount,
    },
  };
}

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

/** Deterministic performance classification against the thresholds. */
export function computePerformance(
  performanceSignals: SignalInput[],
  strongThreshold: number,
  satisfactoryThreshold: number,
): PerformanceAssessment {
  const score =
    performanceSignals.length === 0
      ? null
      : performanceSignals.reduce((sum, signal) => sum + signal.value, 0) /
        performanceSignals.length;
  let status: PerformanceAssessment['status'];
  if (score === null) status = 'insufficient_evidence';
  else if (score >= strongThreshold) status = 'strong';
  else if (score >= satisfactoryThreshold) status = 'satisfactory';
  else status = 'needs_attention';
  return {
    status,
    score,
    signalCount: performanceSignals.length,
    strongThreshold,
    satisfactoryThreshold,
  };
}

// ---------------------------------------------------------------------------
// Staffing
// ---------------------------------------------------------------------------

/**
 * Deterministic staffing-need classification, derived from the workload
 * assessment (relief when overcommitted/overloaded, surplus when
 * underloaded/unassigned, adequate at capacity, unknown when unclassifiable).
 */
export function computeStaffing(workload: WorkloadAssessment): StaffingAssessment {
  switch (workload.status) {
    case 'overallocated': {
      // Hours above the full-allocation share of the commitment.
      const structural = roundHours(
        workload.committedWeeklyHours * (1 - 1 / workload.totalAllocation),
      );
      const observed =
        workload.observedWeeklyHours !== null
          ? roundHours(workload.observedWeeklyHours - workload.committedWeeklyHours)
          : null;
      const needed =
        observed !== null && observed > structural ? observed : structural;
      return { status: 'relief_needed', neededWeeklyHoursReduction: needed, surplusWeeklyHours: null };
    }
    case 'overloaded': {
      // observed > committed by more than the margin (totalAllocation ≤ 1 here).
      const observed = workload.observedWeeklyHours ?? 0;
      return {
        status: 'relief_needed',
        neededWeeklyHoursReduction: roundHours(observed - workload.committedWeeklyHours),
        surplusWeeklyHours: null,
      };
    }
    case 'underloaded':
      return {
        status: 'surplus',
        neededWeeklyHoursReduction: null,
        surplusWeeklyHours: roundHours(
          workload.committedWeeklyHours - (workload.observedWeeklyHours ?? 0),
        ),
      };
    case 'unassigned':
      // Structurally spare, but the surplus in hours is not measurable
      // without a capacity model — report the status, not invented numbers.
      return { status: 'surplus', neededWeeklyHoursReduction: null, surplusWeeklyHours: null };
    case 'at_capacity':
      return { status: 'adequate', neededWeeklyHoursReduction: null, surplusWeeklyHours: null };
    case 'insufficient_evidence':
    default:
      return { status: 'unknown', neededWeeklyHoursReduction: null, surplusWeeklyHours: null };
  }
}

// ---------------------------------------------------------------------------
// Adverse findings
// ---------------------------------------------------------------------------

/** The canonical adverse-finding codes of the not-okay dimensions (deterministic order). */
export function computeAdverseFindings(input: {
  workload: WorkloadAssessment;
  fit: FitAssessment;
  performance: PerformanceAssessment;
  staffing: StaffingAssessment;
}): string[] {
  const findings: string[] = [];
  if (input.workload.status === 'overallocated') findings.push('workload_overallocated');
  if (input.workload.status === 'overloaded') findings.push('workload_overloaded');
  if (input.workload.status === 'underloaded') findings.push('workload_underloaded');
  if (input.workload.status === 'unassigned') findings.push('workload_unassigned');
  if (input.fit.status === 'partial') findings.push('fit_partial');
  if (input.fit.status === 'does_not_fit') findings.push('fit_does_not_fit');
  if (input.performance.status === 'needs_attention') findings.push('performance_needs_attention');
  if (input.staffing.status === 'relief_needed') findings.push('staffing_relief_needed');
  if (input.staffing.status === 'surplus') findings.push('staffing_surplus');
  return findings;
}

// ---------------------------------------------------------------------------
// Generated alternative explanations (lock 20 — preserved readings)
// ---------------------------------------------------------------------------

/**
 * The module's deterministic alternative explanations for the computed
 * statuses. These are CANDIDATE readings of the evidence that compete with
 * the recommendation's implied reading; the caller may add more
 * ('stated'), and employment-impacting recommendations require at least
 * one explanation in total.
 */
export function generateAlternativeExplanations(input: {
  workload: WorkloadAssessment;
  fit: FitAssessment;
  performance: PerformanceAssessment;
  staffing: StaffingAssessment;
}): AlternativeExplanation[] {
  const explanations: string[] = [];
  switch (input.workload.status) {
    case 'overallocated':
      explanations.push(
        'Total active allocation exceeds one full-time employee: the overcommitment may be temporary (peak season, a deadline) or reflect double-booked assignments rather than sustained overload.',
      );
      break;
    case 'overloaded':
      explanations.push(
        'Observed working hours exceed committed hours: possible drivers include a temporary demand peak, coverage for an absent colleague, process inefficiency (rework, manual effort) or genuinely understaffed roles — the observed pattern alone does not distinguish them.',
      );
      break;
    case 'underloaded':
      explanations.push(
        'Observed working hours are below committed hours: the gap may reflect work not captured by the observed systems (a measurement gap), a deliberate partial arrangement, or genuinely spare capacity.',
      );
      break;
    case 'unassigned':
      explanations.push(
        'No active role assignment is recorded: the employee may be between roles, deliberately unassigned, or performing work that the role model does not represent — observed workload signals, if any, contradict the structural picture and deserve investigation.',
      );
      break;
    case 'insufficient_evidence':
      explanations.push(
        'No workload signal falls inside the assessment window: the absence of evidence is a measurement gap, not evidence of an adequate workload.',
      );
      break;
    case 'at_capacity':
    default:
      break;
  }
  if (input.fit.status === 'partial' || input.fit.status === 'does_not_fit') {
    explanations.push(
      'A required capability is not met by an active recorded supply: the capability graph may be incomplete (the capability is real but unrecorded), the role expectation may be aspirational or newer than the recorded evidence, or the shortfall may be genuine.',
    );
  }
  if (input.performance.status === 'needs_attention') {
    explanations.push(
      'Performance signals are below the satisfactory threshold: low scores may reflect workload interference (overload degrading throughput), unclear expectations, process or tooling friction, or a genuine capability gap — one window is weak evidence of a stable pattern.',
    );
  }
  if (input.performance.status === 'insufficient_evidence') {
    explanations.push(
      'No performance signal falls inside the assessment window: performance must not be assessed beyond what the evidence supports.',
    );
  }
  if (input.staffing.status === 'unknown') {
    explanations.push(
      'The staffing need cannot be classified from the current evidence; treating it as adequate would claim more than the records support.',
    );
  }
  return explanations.map((text) => ({ text, source: 'generated' as const }));
}

// ---------------------------------------------------------------------------
// Generated alternatives (courses of action)
// ---------------------------------------------------------------------------

/** The module's deterministic alternative courses of action for the computed statuses. */
export function generateAlternatives(input: {
  workload: WorkloadAssessment;
  fit: FitAssessment;
  performance: PerformanceAssessment;
  staffing: StaffingAssessment;
}): AssessmentAlternative[] {
  const kinds = new Set<string>();
  const overcommitted =
    input.workload.status === 'overallocated' ||
    input.workload.status === 'overloaded' ||
    input.staffing.status === 'relief_needed';
  const spare =
    input.workload.status === 'underloaded' ||
    input.workload.status === 'unassigned' ||
    input.staffing.status === 'surplus';
  const fitGap = input.fit.status === 'partial' || input.fit.status === 'does_not_fit';
  const needsAttention = input.performance.status === 'needs_attention';
  const unknown =
    input.workload.status === 'insufficient_evidence' ||
    input.performance.status === 'insufficient_evidence' ||
    input.staffing.status === 'unknown';

  if (overcommitted) {
    kinds.add('redistribute_work');
    kinds.add('hire');
    kinds.add('recruit_agent');
    kinds.add('outsource');
    kinds.add('process_improvement');
  }
  if (spare) {
    kinds.add('reassign');
    kinds.add('investigate_further');
    kinds.add('no_change');
  }
  if (fitGap) {
    kinds.add('train');
    kinds.add('reassign');
    kinds.add('hire');
    kinds.add('recruit_agent');
    kinds.add('install_software');
    kinds.add('outsource');
  }
  if (needsAttention) {
    kinds.add('train');
    kinds.add('process_improvement');
    kinds.add('investigate_further');
  }
  if (unknown) {
    kinds.add('investigate_further');
  }
  if (kinds.size === 0) {
    // Nothing adverse was computed: doing nothing IS an alternative and the
    // honest one to list first.
    kinds.add('no_change');
  }

  const descriptions: Record<string, string> = {
    redistribute_work: 'Redistribute work across the team to bring the committed load back within capacity.',
    reassign: 'Reassign the employee to work that better fits the current demand or their capabilities.',
    train: 'Develop the capability through training instead of acquiring it externally.',
    hire: 'Hire human capability to cover the unmet demand.',
    recruit_agent: 'Recruit a software agent to absorb part of the workload.',
    install_software: 'Install or adopt software that supplies the missing capability.',
    outsource: 'Outsource the affected work to an external supplier or partner.',
    process_improvement: 'Improve the process (reduce rework, manual effort, handoffs) before changing staffing.',
    investigate_further: 'Gather more evidence before acting — the current window does not support a stronger conclusion.',
    no_change: 'Keep the current staffing and assignments under periodic review.',
  };

  return [...ALTERNATIVE_KIND_ORDER]
    .filter((kind) => kinds.has(kind))
    .map((kind) => ({ kind, description: descriptions[kind]!, source: 'generated' as const }));
}

/**
 * Merges generated and caller-stated alternatives: generated entries first
 * (vocabulary order), then stated entries in input order, never duplicating
 * a kind that is already present. (Distinct kinds are what the lock-20
 * guard counts.)
 */
export function mergeAlternatives(
  generated: AssessmentAlternative[],
  stated: AssessmentAlternative[],
): AssessmentAlternative[] {
  const merged = [...generated];
  const present = new Set(generated.map((alternative) => alternative.kind));
  for (const alternative of stated) {
    if (!present.has(alternative.kind)) {
      merged.push(alternative);
      present.add(alternative.kind);
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Employment-impact guards (lock 20/21)
// ---------------------------------------------------------------------------

/** True when the recommendation kind is employment-impacting. */
export function isEmploymentImpacting(kind: RecommendationKind): boolean {
  return (EMPLOYMENT_IMPACTING_RECOMMENDATION_KINDS as readonly string[]).includes(kind);
}

/** The lock-20 representation requirements an employment-impacting recommendation must satisfy. */
export interface EmploymentGuardInput {
  recommendationKind: RecommendationKind;
  confidence: number;
  alternativeExplanations: AlternativeExplanation[];
  alternatives: AssessmentAlternative[];
  evidenceReferenceCount: number;
}

/** The first violated lock-20 requirement, or null when all hold (pure check). */
export function findEmploymentGuardViolation(
  input: EmploymentGuardInput,
): 'confidence' | 'explanations' | 'alternatives' | 'evidence' | null {
  if (!isEmploymentImpacting(input.recommendationKind)) return null;
  if (input.confidence >= 1) return 'confidence';
  if (input.alternativeExplanations.length < 1) return 'explanations';
  const distinctKinds = new Set(input.alternatives.map((alternative) => alternative.kind));
  if (distinctKinds.size < 2) return 'alternatives';
  if (input.evidenceReferenceCount < 1) return 'evidence';
  return null;
}

/** True when the adverse-grounding requirement holds for this kind (pure check). */
export function isRecommendationGrounded(
  kind: RecommendationKind,
  adverseFindings: readonly string[],
): boolean {
  if (!(ADVERSE_GROUNDED_RECOMMENDATION_KINDS as readonly string[]).includes(kind)) return true;
  return adverseFindings.length >= 1;
}

// ---------------------------------------------------------------------------
// The composed computation
// ---------------------------------------------------------------------------

/** The composed deterministic assessment computation (see file-header invariants). */
export interface AssessmentComputation {
  workload: WorkloadAssessment;
  fit: FitAssessment;
  performance: PerformanceAssessment;
  staffing: StaffingAssessment;
  scope: AssessmentScope;
  adverseFindings: string[];
  generatedExplanations: AlternativeExplanation[];
  generatedAlternatives: AssessmentAlternative[];
  consideredSignalIds: string[];
}

/** Computes the full deterministic interpretation from the observed records. */
export function computeWorkforceAssessment(inputs: AssessmentInputs): AssessmentComputation {
  const workload = computeWorkload(
    inputs.assignments,
    inputs.workloadSignals,
    inputs.options.workloadMargin,
  );
  const { fit, scope: fitScope } = computeFit(
    inputs.assignments,
    inputs.supplies,
    inputs.maxRequiredCapabilities,
  );
  const performance = computePerformance(
    inputs.performanceSignals,
    inputs.options.performanceStrong,
    inputs.options.performanceSatisfactory,
  );
  const staffing = computeStaffing(workload);
  const adverseFindings = computeAdverseFindings({ workload, fit, performance, staffing });
  const generatedExplanations = generateAlternativeExplanations({
    workload,
    fit,
    performance,
    staffing,
  });
  const generatedAlternatives = generateAlternatives({ workload, fit, performance, staffing });
  const activeAssignments = inputs.assignments.filter(
    (assignment) => assignment.role.status === 'active',
  );
  return {
    workload,
    fit,
    performance,
    staffing,
    scope: {
      consideredActiveAssignmentCount: activeAssignments.length,
      excludedRetiredRoleAssignmentCount: inputs.excludedRetiredRoleAssignmentCount,
      unconsideredAssignmentOverflowCount: inputs.unconsideredAssignmentOverflowCount,
      requiredCapabilityCount: fitScope.requiredCapabilityCount,
      requiredCapabilityOverflowCount: fitScope.requiredCapabilityOverflowCount,
    },
    adverseFindings,
    generatedExplanations,
    generatedAlternatives,
    consideredSignalIds: [...inputs.workloadSignals, ...inputs.performanceSignals].map(
      (signal) => signal.id,
    ),
  };
}
