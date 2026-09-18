// Unit tests for the workforce module's PURE logic — assessment.ts (the
// deterministic function from observed records to the interpretation
// layer: workload / fit / performance / staffing classifications,
// adverse findings, generated alternative explanations and alternatives,
// the lock-20 employment guards and the adverse-grounding guard) and
// validation.ts (the input/query guards). No database.

import { describe, expect, it } from 'vitest';
import {
  ALTERNATIVE_KIND_ORDER,
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
  type AssignmentInput,
} from '../assessment';
import {
  assertWorkforceTenantContext,
  DEFAULT_ALLOCATION,
  DEFAULT_WINDOW_WEEKS,
  DEFAULT_WORKLOAD_MARGIN,
  isAlternativeKind,
  isRecommendationKind,
  isWorkforceDecisionKind,
  requireWorkforceDecisionAuthority,
  validateAssessWorkforceInput,
  validateAssignRoleInput,
  validateListAssessmentsQuery,
  validateRecordDecisionInput,
  validateRecordSignalInput,
  validateRegisterRoleInput,
  validateReviseRoleInput,
  WORKFORCE_AUTHORITY_DECIDE,
} from '../validation';
import { WorkforceError } from '../errors';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CAP_A = '00000000-0000-4000-8000-0000000000a1';
const CAP_B = '00000000-0000-4000-8000-0000000000b1';
const CAP_C = '00000000-0000-4000-8000-0000000000c1';
const OBS_1 = '00000000-0000-4000-8000-000000000001';
const OBS_2 = '00000000-0000-4000-8000-000000000002';

const DEFAULT_OPTIONS = {
  windowWeeks: 4,
  workloadMargin: 0.15,
  performanceStrong: 0.75,
  performanceSatisfactory: 0.5,
};

type AssignmentOverrides = Partial<Omit<AssignmentInput, 'role'>> & {
  role?: Partial<AssignmentInput['role']>;
};

function assignmentOf(overrides: AssignmentOverrides = {}): AssignmentInput {
  const { role, ...rest } = overrides;
  return {
    assignmentId: '00000000-0000-4000-8000-0000000000aa',
    allocation: 1,
    role: {
      id: '00000000-0000-4000-8000-0000000000r1',
      roleKey: 'Support engineer',
      status: 'active',
      expectedWeeklyHours: 40,
      requiredCapabilities: [],
      ...role,
    },
    ...rest,
  };
}

const WORKLOAD_SIGNAL = (value: number, id = '00000000-0000-4000-8000-0000000000w1') => ({
  id,
  kind: 'workload' as const,
  value,
});

const PERF_SIGNAL = (value: number, id = '00000000-0000-4000-8000-0000000000p1') => ({
  id,
  kind: 'performance' as const,
  value,
});

// ---------------------------------------------------------------------------
// Workload
// ---------------------------------------------------------------------------

describe('computeWorkload', () => {
  it('classifies unassigned when there is no active assignment (signals still reported)', () => {
    const workload = computeWorkload([], [WORKLOAD_SIGNAL(50)], 0.15);
    expect(workload.status).toBe('unassigned');
    expect(workload.totalAllocation).toBe(0);
    expect(workload.committedWeeklyHours).toBe(0);
    expect(workload.observedWeeklyHours).toBe(50);
  });

  it('classifies overallocated when total allocation exceeds 1, even without signals', () => {
    const workload = computeWorkload(
      [assignmentOf({ allocation: 0.6 }), assignmentOf({ allocation: 0.6, role: { id: 'r2' } })],
      [],
      0.15,
    );
    expect(workload.status).toBe('overallocated');
    expect(workload.totalAllocation).toBeCloseTo(1.2, 10);
    expect(workload.committedWeeklyHours).toBe(48); // 0.6×40 + 0.6×40
    expect(workload.observedWeeklyHours).toBeNull();
  });

  it('ignores assignments whose role is retired', () => {
    const workload = computeWorkload(
      [assignmentOf({ role: { status: 'retired' } }), assignmentOf({ allocation: 0.5, role: { id: 'r2' } })],
      [],
      0.15,
    );
    expect(workload.status).toBe('insufficient_evidence'); // only the 0.5 assignment counts
    expect(workload.totalAllocation).toBe(0.5);
    expect(workload.committedWeeklyHours).toBe(20);
  });

  it('classifies overloaded beyond the margin', () => {
    const workload = computeWorkload([assignmentOf()], [WORKLOAD_SIGNAL(50)], 0.15);
    expect(workload.status).toBe('overloaded'); // 50 > 40×1.15 = 46
    expect(workload.observedWeeklyHours).toBe(50);
    expect(workload.workloadSignalCount).toBe(1);
    expect(workload.margin).toBe(0.15);
  });

  it('treats the margin boundary as at-capacity (inclusive)', () => {
    // 40 × 1.15 = 46 exactly — not strictly greater → at_capacity.
    expect(computeWorkload([assignmentOf()], [WORKLOAD_SIGNAL(46)], 0.15).status).toBe('at_capacity');
    // 40 × 0.85 = 34 exactly — not strictly less → at_capacity.
    expect(computeWorkload([assignmentOf()], [WORKLOAD_SIGNAL(34)], 0.15).status).toBe('at_capacity');
  });

  it('classifies underloaded below the margin', () => {
    const workload = computeWorkload([assignmentOf()], [WORKLOAD_SIGNAL(25)], 0.15);
    expect(workload.status).toBe('underloaded'); // 25 < 40×0.85 = 34
  });

  it('averages multiple workload signals', () => {
    const workload = computeWorkload(
      [assignmentOf()],
      [WORKLOAD_SIGNAL(40, 'w1'), WORKLOAD_SIGNAL(60, 'w2')],
      0.15,
    );
    expect(workload.observedWeeklyHours).toBe(50);
    expect(workload.workloadSignalCount).toBe(2);
    expect(workload.status).toBe('overloaded');
  });

  it('reports insufficient evidence honestly when assignments exist but no signal does', () => {
    const workload = computeWorkload([assignmentOf()], [], 0.15);
    expect(workload.status).toBe('insufficient_evidence');
    expect(workload.observedWeeklyHours).toBeNull();
  });

  it('a zero-hour signal is a real measurement (underloaded), not missing evidence', () => {
    expect(computeWorkload([assignmentOf()], [WORKLOAD_SIGNAL(0)], 0.15).status).toBe('underloaded');
  });
});

// ---------------------------------------------------------------------------
// Fit
// ---------------------------------------------------------------------------

describe('computeFit', () => {
  it('reports unknown when the active roles require no capabilities', () => {
    const { fit } = computeFit([assignmentOf()], [], 64);
    expect(fit.status).toBe('unknown');
    expect(fit.requiredCount).toBe(0);
    expect(fit.details).toEqual([]);
  });

  it('meets a requirement when the supply reaches the minimum (inclusive)', () => {
    const { fit } = computeFit(
      [assignmentOf({ role: { requiredCapabilities: [{ capabilityId: CAP_A, minLevel: 0.8 }] } })],
      [{ capabilityId: CAP_A, level: 0.8 }],
      64,
    );
    expect(fit.status).toBe('fits');
    expect(fit.metCount).toBe(1);
    expect(fit.unmet).toEqual([]);
  });

  it('reports the shortfall when the supply is below the minimum', () => {
    const { fit } = computeFit(
      [assignmentOf({ role: { requiredCapabilities: [{ capabilityId: CAP_A, minLevel: 0.8 }] } })],
      [{ capabilityId: CAP_A, level: 0.7 }],
      64,
    );
    expect(fit.status).toBe('does_not_fit');
    expect(fit.unmet).toEqual([
      { capabilityId: CAP_A, requiredLevel: 0.8, suppliedLevel: 0.7, met: false },
    ]);
  });

  it('a missing supply record is unmet with suppliedLevel null — not evidence of absence', () => {
    const { fit } = computeFit(
      [assignmentOf({ role: { requiredCapabilities: [{ capabilityId: CAP_A, minLevel: 0 }] } })],
      [],
      64,
    );
    expect(fit.status).toBe('does_not_fit');
    expect(fit.unmet[0]!.suppliedLevel).toBeNull();
    expect(fit.unmet[0]!.requiredLevel).toBe(0); // presence suffices, but no record exists
  });

  it('classifies partial when some requirements are met', () => {
    const { fit } = computeFit(
      [
        assignmentOf({
          role: {
            requiredCapabilities: [
              { capabilityId: CAP_A, minLevel: 0.8 },
              { capabilityId: CAP_B, minLevel: 0.5 },
            ],
          },
        }),
      ],
      [{ capabilityId: CAP_A, level: 0.9 }],
      64,
    );
    expect(fit.status).toBe('partial');
    expect(fit.metCount).toBe(1);
    expect(fit.requiredCount).toBe(2);
  });

  it('unions requirements across roles, demanding the max minimum', () => {
    const { fit } = computeFit(
      [
        assignmentOf({ role: { requiredCapabilities: [{ capabilityId: CAP_A, minLevel: 0.5 }] } }),
        assignmentOf({ role: { id: 'r2', requiredCapabilities: [{ capabilityId: CAP_A, minLevel: 0.9 }] } }),
      ],
      [{ capabilityId: CAP_A, level: 0.8 }],
      64,
    );
    expect(fit.requiredCount).toBe(1);
    expect(fit.details[0]!.requiredLevel).toBe(0.9);
    expect(fit.details[0]!.met).toBe(false);
  });

  it('uses the best (max) supply level when several supplies exist', () => {
    const { fit } = computeFit(
      [assignmentOf({ role: { requiredCapabilities: [{ capabilityId: CAP_A, minLevel: 0.6 }] } })],
      [
        { capabilityId: CAP_A, level: 0.4 },
        { capabilityId: CAP_A, level: 0.9 },
      ],
      64,
    );
    expect(fit.details[0]!.suppliedLevel).toBe(0.9);
    expect(fit.details[0]!.met).toBe(true);
  });

  it('ignores requirements of retired roles', () => {
    const { fit } = computeFit(
      [assignmentOf({ role: { status: 'retired', requiredCapabilities: [{ capabilityId: CAP_A, minLevel: 1 }] } })],
      [],
      64,
    );
    expect(fit.status).toBe('unknown');
  });

  it('bounds the union and reports the overflow honestly', () => {
    const requirements = [CAP_A, CAP_B, CAP_C].map((capabilityId) => ({
      capabilityId,
      minLevel: 0.5,
    }));
    const { fit, scope } = computeFit([assignmentOf({ role: { requiredCapabilities: requirements } })], [], 2);
    expect(fit.requiredCount).toBe(2);
    expect(scope.requiredCapabilityCount).toBe(2);
    expect(scope.requiredCapabilityOverflowCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

describe('computePerformance', () => {
  it('reports insufficient evidence without signals', () => {
    const performance = computePerformance([], 0.75, 0.5);
    expect(performance.status).toBe('insufficient_evidence');
    expect(performance.score).toBeNull();
    expect(performance.signalCount).toBe(0);
  });

  it('classifies strong at/above the strong threshold (inclusive)', () => {
    expect(computePerformance([PERF_SIGNAL(0.75)], 0.75, 0.5).status).toBe('strong');
    expect(computePerformance([PERF_SIGNAL(0.9)], 0.75, 0.5).status).toBe('strong');
  });

  it('classifies satisfactory between the thresholds', () => {
    const performance = computePerformance([PERF_SIGNAL(0.6)], 0.75, 0.5);
    expect(performance.status).toBe('satisfactory');
    expect(performance.score).toBeCloseTo(0.6, 10);
  });

  it('classifies needs_attention below the satisfactory threshold (boundary inclusive)', () => {
    expect(computePerformance([PERF_SIGNAL(0.5)], 0.75, 0.5).status).toBe('satisfactory');
    expect(computePerformance([PERF_SIGNAL(0.49)], 0.75, 0.5).status).toBe('needs_attention');
  });

  it('averages multiple signals', () => {
    const performance = computePerformance(
      [PERF_SIGNAL(0.2, 'p1'), PERF_SIGNAL(0.8, 'p2')],
      0.75,
      0.5,
    );
    expect(performance.score).toBeCloseTo(0.5, 10);
    expect(performance.status).toBe('satisfactory');
    expect(performance.signalCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Staffing
// ---------------------------------------------------------------------------

describe('computeStaffing', () => {
  it('relief for overallocated: hours above the full-allocation share', () => {
    // committed 48 at allocation 1.2 → the full-allocation share is 40;
    // the structural excess is 48 × (1 − 1/1.2) = 8.
    const workload = computeWorkload(
      [assignmentOf({ allocation: 0.6 }), assignmentOf({ allocation: 0.6, role: { id: 'r2' } })],
      [],
      0.15,
    );
    const staffing = computeStaffing(workload);
    expect(staffing.status).toBe('relief_needed');
    expect(staffing.neededWeeklyHoursReduction).toBe(8);
    expect(staffing.surplusWeeklyHours).toBeNull();
  });

  it('relief for overallocated takes the larger observed excess when present', () => {
    const workload = computeWorkload(
      [assignmentOf({ allocation: 0.6 }), assignmentOf({ allocation: 0.6, role: { id: 'r2' } })],
      [WORKLOAD_SIGNAL(60)],
      0.15,
    );
    const staffing = computeStaffing(workload);
    expect(staffing.neededWeeklyHoursReduction).toBe(12); // observed 60 − committed 48
  });

  it('relief for overloaded: observed minus committed', () => {
    const workload = computeWorkload([assignmentOf()], [WORKLOAD_SIGNAL(50)], 0.15);
    const staffing = computeStaffing(workload);
    expect(staffing.status).toBe('relief_needed');
    expect(staffing.neededWeeklyHoursReduction).toBe(10);
  });

  it('surplus for underloaded: committed minus observed', () => {
    const workload = computeWorkload([assignmentOf()], [WORKLOAD_SIGNAL(25)], 0.15);
    const staffing = computeStaffing(workload);
    expect(staffing.status).toBe('surplus');
    expect(staffing.surplusWeeklyHours).toBe(15);
    expect(staffing.neededWeeklyHoursReduction).toBeNull();
  });

  it('surplus for unassigned without inventing hours (not measurable)', () => {
    const staffing = computeStaffing(computeWorkload([], [], 0.15));
    expect(staffing.status).toBe('surplus');
    expect(staffing.surplusWeeklyHours).toBeNull();
    expect(staffing.neededWeeklyHoursReduction).toBeNull();
  });

  it('adequate at capacity; unknown without evidence', () => {
    expect(computeStaffing(computeWorkload([assignmentOf()], [WORKLOAD_SIGNAL(40)], 0.15)).status).toBe(
      'adequate',
    );
    expect(computeStaffing(computeWorkload([assignmentOf()], [], 0.15)).status).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Adverse findings
// ---------------------------------------------------------------------------

describe('computeAdverseFindings', () => {
  it('collects the canonical codes of every not-okay dimension, in order', () => {
    const workload = computeWorkload([assignmentOf()], [WORKLOAD_SIGNAL(60)], 0.15); // overloaded
    const { fit } = computeFit(
      [assignmentOf({ role: { requiredCapabilities: [{ capabilityId: CAP_A, minLevel: 0.9 }, { capabilityId: CAP_B, minLevel: 0.5 }] } })],
      [{ capabilityId: CAP_A, level: 1 }],
      64,
    ); // partial
    const performance = computePerformance([PERF_SIGNAL(0.2)], 0.75, 0.5); // needs_attention
    const staffing = computeStaffing(workload); // relief_needed
    expect(
      computeAdverseFindings({ workload, fit, performance, staffing }),
    ).toEqual(['workload_overloaded', 'fit_partial', 'performance_needs_attention', 'staffing_relief_needed']);
  });

  it('an all-okay assessment has no adverse findings', () => {
    const workload = computeWorkload([assignmentOf()], [WORKLOAD_SIGNAL(40)], 0.15);
    const { fit } = computeFit(
      [assignmentOf({ role: { requiredCapabilities: [{ capabilityId: CAP_A, minLevel: 0.5 }] } })],
      [{ capabilityId: CAP_A, level: 0.9 }],
      64,
    );
    const performance = computePerformance([PERF_SIGNAL(0.9)], 0.75, 0.5);
    const staffing = computeStaffing(workload);
    expect(computeAdverseFindings({ workload, fit, performance, staffing })).toEqual([]);
  });

  it('unassigned and underloaded are adverse findings too', () => {
    const unassigned = computeWorkload([], [], 0.15);
    expect(computeAdverseFindings({ workload: unassigned, fit: { status: 'unknown', requiredCount: 0, metCount: 0, details: [], unmet: [] }, performance: computePerformance([], 0.75, 0.5), staffing: computeStaffing(unassigned) })).toEqual([
      'workload_unassigned',
      'staffing_surplus',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Generated alternative explanations / alternatives
// ---------------------------------------------------------------------------

describe('generateAlternativeExplanations', () => {
  it('generates a candidate explanation for every adverse or unknown dimension', () => {
    const workload = computeWorkload([assignmentOf()], [WORKLOAD_SIGNAL(60)], 0.15); // overloaded
    const { fit } = computeFit(
      [assignmentOf({ role: { requiredCapabilities: [{ capabilityId: CAP_A, minLevel: 0.9 }] } })],
      [],
      64,
    ); // does_not_fit
    const performance = computePerformance([PERF_SIGNAL(0.2)], 0.75, 0.5); // needs_attention
    const staffing = computeStaffing(workload);
    const explanations = generateAlternativeExplanations({ workload, fit, performance, staffing });
    expect(explanations).toHaveLength(3); // overloaded + fit gap + performance
    expect(explanations.every((explanation) => explanation.source === 'generated')).toBe(true);
    expect(explanations[0]!.text).toContain('temporary demand peak');
    expect(explanations[1]!.text).toContain('capability graph may be incomplete');
    expect(explanations[2]!.text).toContain('workload interference');
  });

  it('generates a measurement-gap explanation for insufficient evidence', () => {
    const workload = computeWorkload([assignmentOf()], [], 0.15);
    const explanations = generateAlternativeExplanations({
      workload,
      fit: { status: 'unknown', requiredCount: 0, metCount: 0, details: [], unmet: [] },
      performance: computePerformance([], 0.75, 0.5),
      staffing: computeStaffing(workload),
    });
    expect(explanations.some((explanation) => explanation.text.includes('measurement gap'))).toBe(true);
    expect(explanations.some((explanation) => explanation.text.includes('No performance signal'))).toBe(true);
  });

  it('generates nothing for an all-okay assessment (the caller may still state one)', () => {
    const workload = computeWorkload([assignmentOf()], [WORKLOAD_SIGNAL(40)], 0.15);
    const explanations = generateAlternativeExplanations({
      workload,
      fit: { status: 'fits', requiredCount: 1, metCount: 1, details: [], unmet: [] },
      performance: computePerformance([PERF_SIGNAL(0.9)], 0.75, 0.5),
      staffing: computeStaffing(workload),
    });
    expect(explanations).toEqual([]);
  });
});

describe('generateAlternatives', () => {
  const okay = {
    workload: computeWorkload([assignmentOf()], [WORKLOAD_SIGNAL(40)], 0.15),
    fit: { status: 'fits' as const, requiredCount: 1, metCount: 1, details: [], unmet: [] },
    performance: computePerformance([PERF_SIGNAL(0.9)], 0.75, 0.5),
    staffing: { status: 'adequate' as const, neededWeeklyHoursReduction: null, surplusWeeklyHours: null },
  };

  it('lists doing nothing first when nothing adverse was computed', () => {
    const alternatives = generateAlternatives(okay);
    expect(alternatives.map((alternative) => alternative.kind)).toEqual(['no_change']);
  });

  it('proposes offloading options for overcommitment', () => {
    const overloaded = { ...okay, workload: computeWorkload([assignmentOf()], [WORKLOAD_SIGNAL(60)], 0.15) };
    const alternatives = generateAlternatives({ ...overloaded, staffing: computeStaffing(overloaded.workload) });
    expect(alternatives.map((alternative) => alternative.kind)).toEqual([
      'redistribute_work',
      'hire',
      'recruit_agent',
      'outsource',
      'process_improvement',
    ]);
  });

  it('proposes acquisition options (§13 vocabulary) for a capability gap', () => {
    const alternatives = generateAlternatives({
      ...okay,
      fit: { status: 'does_not_fit', requiredCount: 1, metCount: 0, details: [], unmet: [] },
    });
    expect(alternatives.map((alternative) => alternative.kind)).toEqual([
      'reassign',
      'train',
      'hire',
      'recruit_agent',
      'install_software',
      'outsource',
    ]);
  });

  it('proposes development and investigation options for attention-needing performance', () => {
    const alternatives = generateAlternatives({
      ...okay,
      performance: computePerformance([PERF_SIGNAL(0.2)], 0.75, 0.5),
    });
    expect(alternatives.map((alternative) => alternative.kind)).toEqual([
      'train',
      'process_improvement',
      'investigate_further',
    ]);
  });

  it('deduplicates kinds across dimensions and keeps the vocabulary order', () => {
    const workload = computeWorkload([assignmentOf()], [WORKLOAD_SIGNAL(60)], 0.15); // overloaded
    const alternatives = generateAlternatives({
      workload,
      fit: { status: 'partial', requiredCount: 2, metCount: 1, details: [], unmet: [] },
      performance: computePerformance([PERF_SIGNAL(0.2)], 0.75, 0.5),
      staffing: computeStaffing(workload),
    });
    const kinds = alternatives.map((alternative) => alternative.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    const ranks = kinds.map((kind) => ALTERNATIVE_KIND_ORDER.indexOf(kind));
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    expect(kinds).toContain('train');
    expect(kinds).toContain('redistribute_work');
  });

  it('proposes investigation when evidence is insufficient', () => {
    const unknown = {
      workload: computeWorkload([assignmentOf()], [], 0.15),
      fit: { status: 'unknown' as const, requiredCount: 0, metCount: 0, details: [], unmet: [] },
      performance: computePerformance([], 0.75, 0.5),
      staffing: { status: 'unknown' as const, neededWeeklyHoursReduction: null, surplusWeeklyHours: null },
    };
    expect(generateAlternatives(unknown).map((a) => a.kind)).toEqual(['investigate_further']);
  });
});

describe('mergeAlternatives', () => {
  it('appends stated alternatives after generated ones without duplicating kinds', () => {
    const merged = mergeAlternatives(
      [
        { kind: 'no_change', description: 'generated', source: 'generated' },
      ],
      [
        { kind: 'no_change', description: 'stated duplicate', source: 'stated' },
        { kind: 'hire', description: 'stated new', source: 'stated' },
      ],
    );
    expect(merged.map((alternative) => alternative.kind)).toEqual(['no_change', 'hire']);
    expect(merged[0]!.source).toBe('generated');
    expect(merged[1]!.source).toBe('stated');
  });
});

describe('roundHours', () => {
  it('rounds to two decimals', () => {
    expect(roundHours(46.00000000001)).toBe(46);
    expect(roundHours(8.333333333)).toBe(8.33);
    expect(roundHours(12.5)).toBe(12.5);
    expect(roundHours(7.126)).toBe(7.13);
  });
});

// ---------------------------------------------------------------------------
// Employment guards (lock 20) and grounding
// ---------------------------------------------------------------------------

describe('findEmploymentGuardViolation', () => {
  const satisfied = {
    recommendationKind: 'termination' as const,
    confidence: 0.8,
    alternativeExplanations: [{ text: 'maybe a peak', source: 'generated' as const }],
    alternatives: [
      { kind: 'reassign' as const, description: 'a', source: 'generated' as const },
      { kind: 'hire' as const, description: 'b', source: 'stated' as const },
    ],
    evidenceReferenceCount: 2,
  };

  it('non-impacting recommendations are never guarded', () => {
    expect(
      findEmploymentGuardViolation({
        ...satisfied,
        recommendationKind: 'monitor',
        confidence: 1,
        alternativeExplanations: [],
        alternatives: [],
        evidenceReferenceCount: 0,
      }),
    ).toBeNull();
  });

  it('detects certain confidence (uncertainty must be preserved)', () => {
    expect(findEmploymentGuardViolation({ ...satisfied, confidence: 1 })).toBe('confidence');
    expect(findEmploymentGuardViolation({ ...satisfied, confidence: 0.999 })).toBeNull();
  });

  it('detects missing alternative explanations', () => {
    expect(
      findEmploymentGuardViolation({ ...satisfied, alternativeExplanations: [] }),
    ).toBe('explanations');
  });

  it('detects fewer than two DISTINCT alternatives', () => {
    expect(
      findEmploymentGuardViolation({
        ...satisfied,
        alternatives: [satisfied.alternatives[0]!],
      }),
    ).toBe('alternatives');
    expect(
      findEmploymentGuardViolation({
        ...satisfied,
        alternatives: [
          { kind: 'hire', description: 'a', source: 'stated' },
          { kind: 'hire', description: 'b', source: 'stated' },
        ],
      }),
    ).toBe('alternatives');
  });

  it('detects missing evidence references', () => {
    expect(findEmploymentGuardViolation({ ...satisfied, evidenceReferenceCount: 0 })).toBe(
      'evidence',
    );
  });

  it('all three employment-impacting kinds are guarded', () => {
    for (const kind of ['role_change', 'performance_action', 'termination'] as const) {
      expect(findEmploymentGuardViolation({ ...satisfied, recommendationKind: kind })).toBeNull();
      expect(
        findEmploymentGuardViolation({ ...satisfied, recommendationKind: kind, confidence: 1 }),
      ).toBe('confidence');
    }
    expect(isEmploymentImpacting('role_change')).toBe(true);
    expect(isEmploymentImpacting('hire')).toBe(false);
  });
});

describe('isRecommendationGrounded', () => {
  it('termination and performance_action require an adverse finding', () => {
    expect(isRecommendationGrounded('termination', [])).toBe(false);
    expect(isRecommendationGrounded('performance_action', [])).toBe(false);
    expect(isRecommendationGrounded('termination', ['fit_partial'])).toBe(true);
    expect(isRecommendationGrounded('performance_action', ['performance_needs_attention'])).toBe(true);
  });

  it('other kinds are exempt (role changes may be neutral or positive)', () => {
    expect(isRecommendationGrounded('role_change', [])).toBe(true);
    expect(isRecommendationGrounded('monitor', [])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The composed computation
// ---------------------------------------------------------------------------

describe('computeWorkforceAssessment', () => {
  it('composes the dimensions and reports honest scope counts', () => {
    const computation = computeWorkforceAssessment({
      assignments: [
        assignmentOf({
          role: { requiredCapabilities: [{ capabilityId: CAP_A, minLevel: 0.5 }] },
        }),
        assignmentOf({ allocation: 0.5, role: { id: 'r2', expectedWeeklyHours: 20 } }),
        assignmentOf({ allocation: 0.5, role: { id: 'r3', status: 'retired' } }),
      ],
      excludedRetiredRoleAssignmentCount: 1,
      unconsideredAssignmentOverflowCount: 0,
      workloadSignals: [WORKLOAD_SIGNAL(55, 'w1')],
      performanceSignals: [PERF_SIGNAL(0.3, 'p1')],
      supplies: [{ capabilityId: CAP_A, level: 0.9 }],
      options: DEFAULT_OPTIONS,
      maxRequiredCapabilities: 64,
    });
    // committed = 40 + 0.5×20 = 50; allocation 1.5 > 1 → overallocated
    expect(computation.workload.status).toBe('overallocated');
    expect(computation.workload.committedWeeklyHours).toBe(50);
    expect(computation.fit.status).toBe('fits');
    expect(computation.performance.status).toBe('needs_attention');
    expect(computation.staffing.status).toBe('relief_needed');
    expect(computation.scope).toEqual({
      consideredActiveAssignmentCount: 2,
      excludedRetiredRoleAssignmentCount: 1,
      unconsideredAssignmentOverflowCount: 0,
      requiredCapabilityCount: 1,
      requiredCapabilityOverflowCount: 0,
    });
    expect(computation.consideredSignalIds).toEqual(['w1', 'p1']);
    expect(computation.adverseFindings).toContain('workload_overallocated');
    expect(computation.generatedExplanations.length).toBeGreaterThan(0);
    expect(computation.generatedAlternatives.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const ACTOR = { kind: 'person' as const, id: 'p1', label: 'Ops lead' };
const EMPLOYEE = { id: 'employee-1', label: 'Ada' };

function expectWorkforceCode(code: string, fn: () => unknown): void {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkforceError);
    expect((error as WorkforceError).code).toBe(code);
  }
}

describe('validation — registerRole', () => {
  const base = {
    roleKey: 'Support engineer',
    expectedWeeklyHours: 40,
    actor: ACTOR,
  };

  it('normalizes a valid registration with defaults', () => {
    const valid = validateRegisterRoleInput(base);
    expect(valid.requiredCapabilities).toEqual([]);
    expect(valid.title).toBeNull();
  });

  it('rejects unknown keys, bad hours and bad requirements', () => {
    expectWorkforceCode('invalid_role_input', () =>
      validateRegisterRoleInput({ ...base, id: 'smuggled' }),
    );
    expectWorkforceCode('invalid_role_input', () =>
      validateRegisterRoleInput({ ...base, expectedWeeklyHours: 0 }),
    );
    expectWorkforceCode('invalid_role_input', () =>
      validateRegisterRoleInput({ ...base, expectedWeeklyHours: 169 }),
    );
    expectWorkforceCode('invalid_role_input', () =>
      validateRegisterRoleInput({
        ...base,
        requiredCapabilities: [{ capabilityId: 'not-a-uuid', minLevel: 0.5 }],
      }),
    );
    expectWorkforceCode('invalid_role_input', () =>
      validateRegisterRoleInput({
        ...base,
        requiredCapabilities: [{ capabilityId: CAP_A, minLevel: 1.5 }],
      }),
    );
    expectWorkforceCode('invalid_role_input', () =>
      validateRegisterRoleInput({ ...base, actor: { kind: 'person' } }),
    );
  });

  it('defaults minLevel to 0 (presence suffices) and deduplicates by max', () => {
    const valid = validateRegisterRoleInput({
      ...base,
      requiredCapabilities: [{ capabilityId: CAP_A }, { capabilityId: CAP_A, minLevel: 0.7 }],
    });
    expect(valid.requiredCapabilities).toEqual([{ capabilityId: CAP_A, minLevel: 0.7 }]);
  });
});

describe('validation — reviseRole', () => {
  const base = { roleId: CAP_A, actor: ACTOR };

  it('requires at least one change', () => {
    expectWorkforceCode('invalid_role_input', () => validateReviseRoleInput({ ...base }));
  });

  it('rejects status combined with content (surgical rule)', () => {
    expectWorkforceCode('invalid_role_input', () =>
      validateReviseRoleInput({ ...base, status: 'retired', title: 'New title' }),
    );
  });
});

describe('validation — assignRole', () => {
  const base = { roleId: CAP_A, employee: EMPLOYEE, actor: ACTOR };

  it('defaults allocation to full and validates the employee reference', () => {
    const valid = validateAssignRoleInput(base);
    expect(valid.allocation).toBe(DEFAULT_ALLOCATION);
    expectWorkforceCode('invalid_assignment_input', () =>
      validateAssignRoleInput({ ...base, employee: { label: 'no id' } }),
    );
    expectWorkforceCode('invalid_assignment_input', () =>
      validateAssignRoleInput({ ...base, allocation: 0 }),
    );
    expectWorkforceCode('invalid_assignment_input', () =>
      validateAssignRoleInput({ ...base, allocation: 1.5 }),
    );
    expectWorkforceCode('invalid_assignment_input', () =>
      validateAssignRoleInput({
        ...base,
        evidenceObservationIds: Array.from({ length: 33 }, () => OBS_1),
      }),
    );
  });

  it('deduplicates evidence observation ids', () => {
    const valid = validateAssignRoleInput({
      ...base,
      evidenceObservationIds: [OBS_1, OBS_2, OBS_1.toUpperCase()],
    });
    expect(valid.evidenceObservationIds).toEqual([OBS_1, OBS_2]);
  });
});

describe('validation — recordSignal', () => {
  const base = { employee: EMPLOYEE, kind: 'workload' as const, value: 40, actor: ACTOR };

  it('bounds workload values by the week and performance values by [0, 1]', () => {
    expect(validateRecordSignalInput(base).value).toBe(40);
    expectWorkforceCode('invalid_signal_input', () =>
      validateRecordSignalInput({ ...base, value: 169 }),
    );
    const performance = { ...base, kind: 'performance' as const };
    expect(validateRecordSignalInput({ ...performance, value: 1 }).value).toBe(1);
    expectWorkforceCode('invalid_signal_input', () =>
      validateRecordSignalInput({ ...performance, value: 1.01 }),
    );
    expectWorkforceCode('invalid_signal_input', () => validateRecordSignalInput({ ...base, kind: 'mood' }));
  });
});

describe('validation — assessWorkforce', () => {
  const base = {
    employee: EMPLOYEE,
    recommendation: { kind: 'monitor' as const, text: 'Watch the load this month.' },
    confidence: 0.7,
    actor: ACTOR,
  };

  it('applies the documented option defaults', () => {
    const valid = validateAssessWorkforceInput(base);
    expect(valid.options).toEqual({
      windowWeeks: DEFAULT_WINDOW_WEEKS,
      workloadMargin: DEFAULT_WORKLOAD_MARGIN,
      performanceStrong: 0.75,
      performanceSatisfactory: 0.5,
    });
  });

  it('rejects impossible option combinations and out-of-range values', () => {
    expectWorkforceCode('invalid_assessment_input', () =>
      validateAssessWorkforceInput({
        ...base,
        options: { performanceStrong: 0.4, performanceSatisfactory: 0.6 },
      }),
    );
    expectWorkforceCode('invalid_assessment_input', () =>
      validateAssessWorkforceInput({ ...base, confidence: 1.2 }),
    );
    expectWorkforceCode('invalid_assessment_input', () =>
      validateAssessWorkforceInput({ ...base, options: { windowWeeks: 53 } }),
    );
    expectWorkforceCode('invalid_assessment_input', () =>
      validateAssessWorkforceInput({ ...base, recommendation: { kind: 'promote', text: 'x' } }),
    );
  });

  it('rejects smuggled computed content (audit fields are minted, never supplied)', () => {
    expectWorkforceCode('invalid_assessment_input', () =>
      validateAssessWorkforceInput({
        ...base,
        employmentImpacting: true,
      }),
    );
    expectWorkforceCode('invalid_assessment_input', () =>
      validateAssessWorkforceInput({
        ...base,
        additionalAlternatives: [{ kind: 'hire', description: 'x', source: 'stated' }],
      }),
    );
  });

  it('validates the alternative vocabularies', () => {
    expectWorkforceCode('invalid_assessment_input', () =>
      validateAssessWorkforceInput({
        ...base,
        additionalAlternatives: [{ kind: 'promote_everyone', description: 'x' }],
      }),
    );
  });
});

describe('validation — recordDecision', () => {
  const base = {
    assessmentId: CAP_A,
    decision: 'accepted' as const,
    decider: { kind: 'person' as const, id: 'manager-1' },
  };

  it('requires a human decider with an id', () => {
    expect(validateRecordDecisionInput(base).decider.kind).toBe('person');
    expectWorkforceCode('invalid_decision_input', () =>
      validateRecordDecisionInput({ ...base, decider: { kind: 'agent', id: 'bot-1' } }),
    );
    expectWorkforceCode('invalid_decision_input', () =>
      validateRecordDecisionInput({ ...base, decider: { kind: 'person', label: 'no id' } }),
    );
    expectWorkforceCode('invalid_decision_input', () =>
      validateRecordDecisionInput({ ...base, decision: 'executed' }),
    );
    expectWorkforceCode('invalid_decision_input', () =>
      validateRecordDecisionInput({ ...base, version: 0 }),
    );
  });
});

describe('validation — queries and context', () => {
  it('bounds list limits', () => {
    expectWorkforceCode('invalid_query', () =>
      validateListAssessmentsQuery({ limit: 501 }),
    );
    expect(validateListAssessmentsQuery({}).limit).toBe(50);
    expectWorkforceCode('invalid_query', () =>
      validateListAssessmentsQuery({ employmentImpacting: 'yes' as unknown as boolean }),
    );
  });

  it('rejects unknown query keys', () => {
    expectWorkforceCode('invalid_query', () =>
      validateListAssessmentsQuery({ employeeKey: 'x' }),
    );
  });

  it('validates the tenant context shape', () => {
    expectWorkforceCode('invalid_context', () =>
      assertWorkforceTenantContext({ tenantId: '', principalId: 'p', authority: [] }),
    );
    expectWorkforceCode('invalid_context', () =>
      assertWorkforceTenantContext({ tenantId: 't', principalId: 'p', authority: 'all' as unknown as string[] }),
    );
  });

  it('gates decisions behind the workforce:decide claim', () => {
    const ctx = { tenantId: 't', principalId: 'p', authority: [] };
    expectWorkforceCode('forbidden', () => requireWorkforceDecisionAuthority(ctx));
    expect(() =>
      requireWorkforceDecisionAuthority({ ...ctx, authority: [WORKFORCE_AUTHORITY_DECIDE] }),
    ).not.toThrow();
  });

  it('exposes the vocabulary guards', () => {
    expect(isRecommendationKind('termination')).toBe(true);
    expect(isRecommendationKind('execution')).toBe(false);
    expect(isAlternativeKind('train')).toBe(true);
    expect(isWorkforceDecisionKind('accepted')).toBe(true);
  });
});
