// Unit tests for the automation module's PURE logic — roi.ts (the
// deterministic expected-ROI and target-met functions) and validation.ts
// (the input/query guards). No database.

import { describe, expect, it } from 'vitest';
import { expectedRoiOf, outcomeTargetMet } from '../roi';
import {
  AUTOMATION_EVIDENCE_KINDS,
  AUTOMATION_PARTY_KINDS,
  AUTOMATION_PERIODS,
  AUTOMATION_SOLUTION_TYPES,
  AUTOMATION_STATUSES,
  DEFAULT_LIST_LIMIT,
  isAutomationEvidenceKind,
  isAutomationPartyKind,
  isAutomationPeriod,
  isAutomationSolutionType,
  isAutomationStatus,
  isOutcomeDirection,
  isUuid,
  validateListQuery,
  validateMeasurementInput,
  validateMeasurementQuery,
  validateMeasurementsQuery,
  validateOpportunityQuery,
  validateRegisterInput,
  validateReviseInput,
  validateVersionQuery,
} from '../validation';
import { AutomationError } from '../errors';
import type { RegisterAutomationOpportunityInput } from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROCESS_ID = '00000000-0000-4000-8000-0000000000a1';
const FINDING_1 = '00000000-0000-4000-8000-0000000000b1';
const FINDING_2 = '00000000-0000-4000-8000-0000000000b2';
const CAPABILITY_ID = '00000000-0000-4000-8000-0000000000c1';
const ACTOR = { kind: 'person' as const, id: 'person-1', label: 'Ops lead' };

function registrationOf(
  overrides: Partial<RegisterAutomationOpportunityInput> = {},
): RegisterAutomationOpportunityInput {
  return {
    name: 'Automate invoice data entry',
    processId: PROCESS_ID,
    findingIds: [FINDING_1, FINDING_2],
    capabilityId: CAPABILITY_ID,
    description: 'Manual entry of scanned invoices into the ERP',
    frequencyCount: 600,
    period: 'month',
    currency: 'EUR',
    currentCostMinor: 900_000,
    errorRate: 0.08,
    solutionTypes: ['recruit_agent', 'install_extension'],
    expectedSavingsMinor: 600_000,
    expectedInvestmentMinor: 240_000,
    roiHorizonPeriods: 12,
    outcome: {
      metricName: 'manual handling minutes per month',
      metricUnit: 'minutes',
      direction: 'at_most',
      baseline: 1200,
      target: 240,
    },
    actor: ACTOR,
    rationale: 'Q3 process review',
    ...overrides,
  };
}

/** Sync error-code assertion — validation throws before any I/O. */
function expectCode(code: string, fn: () => unknown): void {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(AutomationError);
    expect((error as AutomationError).code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// roi.ts — expectedRoiOf
// ---------------------------------------------------------------------------

describe('roi.ts — expectedRoiOf', () => {
  it('computes net benefit, ratio and payback from the committed figures', () => {
    const roi = expectedRoiOf({
      currency: 'EUR',
      period: 'month',
      expectedSavingsMinor: 600_000,
      expectedInvestmentMinor: 240_000,
      roiHorizonPeriods: 12,
    });
    // net benefit: 600000 × 12 − 240000 = 6,960,000 minor units
    expect(roi.expectedNetBenefitMinor).toBe(6_960_000);
    // ratio: 6960000 / 240000 = 29
    expect(roi.expectedRoiRatio).toBe(29);
    // payback: 240000 / 600000 = 0.4 periods
    expect(roi.expectedPaybackPeriods).toBe(0.4);
    expect(roi.currency).toBe('EUR');
    expect(roi.period).toBe('month');
    expect(roi.expectedSavingsMinor).toBe(600_000);
    expect(roi.expectedInvestmentMinor).toBe(240_000);
    expect(roi.horizonPeriods).toBe(12);
  });

  it('returns a null ratio when there is no outlay (ROI is undefined without investment)', () => {
    const roi = expectedRoiOf({
      currency: 'USD',
      period: 'year',
      expectedSavingsMinor: 100,
      expectedInvestmentMinor: 0,
      roiHorizonPeriods: 3,
    });
    expect(roi.expectedNetBenefitMinor).toBe(300);
    expect(roi.expectedRoiRatio).toBeNull();
    // nothing to recover — payback is immediate
    expect(roi.expectedPaybackPeriods).toBe(0);
  });

  it('returns a null payback when the expected savings are zero (never pays back)', () => {
    const roi = expectedRoiOf({
      currency: 'USD',
      period: 'year',
      expectedSavingsMinor: 0,
      expectedInvestmentMinor: 500,
      roiHorizonPeriods: 5,
    });
    expect(roi.expectedNetBenefitMinor).toBe(-500);
    expect(roi.expectedRoiRatio).toBe(-1);
    expect(roi.expectedPaybackPeriods).toBeNull();
  });

  it('breaks exactly even at savings × horizon = investment', () => {
    const roi = expectedRoiOf({
      currency: 'JPY',
      period: 'quarter',
      expectedSavingsMinor: 250,
      expectedInvestmentMinor: 1000,
      roiHorizonPeriods: 4,
    });
    expect(roi.expectedNetBenefitMinor).toBe(0);
    expect(roi.expectedRoiRatio).toBe(0);
    expect(roi.expectedPaybackPeriods).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// roi.ts — outcomeTargetMet
// ---------------------------------------------------------------------------

describe('roi.ts — outcomeTargetMet', () => {
  it('at_least: observed >= target is a success', () => {
    expect(outcomeTargetMet('at_least', 100, 150)).toBe(true);
    expect(outcomeTargetMet('at_least', 100, 100)).toBe(true);
    expect(outcomeTargetMet('at_least', 100, 99.99)).toBe(false);
  });

  it('at_most: observed <= target is a success', () => {
    expect(outcomeTargetMet('at_most', 240, 210)).toBe(true);
    expect(outcomeTargetMet('at_most', 240, 240)).toBe(true);
    expect(outcomeTargetMet('at_most', 240, 240.01)).toBe(false);
  });

  it('handles negative metric values (net margins and the like)', () => {
    expect(outcomeTargetMet('at_least', -5, 0)).toBe(true);
    expect(outcomeTargetMet('at_most', -5, -10)).toBe(true);
    expect(outcomeTargetMet('at_most', -5, -4)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validation.ts — vocabularies
// ---------------------------------------------------------------------------

describe('validation.ts — vocabularies', () => {
  it('guards the eight solution types ARCHITECTURE §13 names verbatim', () => {
    expect(AUTOMATION_SOLUTION_TYPES).toEqual([
      'train_employee',
      'reassign_work',
      'hire_human',
      'recruit_agent',
      'recruit_agent_team',
      'install_extension',
      'build_extension',
      'outsource',
    ]);
    for (const kind of AUTOMATION_SOLUTION_TYPES) {
      expect(isAutomationSolutionType(kind)).toBe(true);
    }
    expect(isAutomationSolutionType('hire_a_robot')).toBe(false);
    expect(isAutomationSolutionType(null)).toBe(false);
  });

  it('guards the periods, statuses, party kinds, evidence kinds and directions', () => {
    expect(AUTOMATION_PERIODS).toEqual(['day', 'week', 'month', 'quarter', 'year']);
    expect(AUTOMATION_STATUSES).toEqual(['candidate', 'accepted', 'dismissed']);
    expect(AUTOMATION_PARTY_KINDS).toEqual(['person', 'team', 'agent', 'system', 'external']);
    expect(AUTOMATION_EVIDENCE_KINDS).toEqual([
      'observation',
      'event',
      'document',
      'report',
      'system',
      'metric',
    ]);
    for (const period of AUTOMATION_PERIODS) expect(isAutomationPeriod(period)).toBe(true);
    for (const status of AUTOMATION_STATUSES) expect(isAutomationStatus(status)).toBe(true);
    for (const kind of AUTOMATION_PARTY_KINDS) expect(isAutomationPartyKind(kind)).toBe(true);
    for (const kind of AUTOMATION_EVIDENCE_KINDS) expect(isAutomationEvidenceKind(kind)).toBe(true);
    expect(isAutomationPeriod('fortnight')).toBe(false);
    expect(isAutomationStatus('active')).toBe(false); // not a lifecycle copy of capabilities
    expect(isAutomationPartyKind('source')).toBe(false);
    expect(isAutomationEvidenceKind('dream')).toBe(false);
    expect(isOutcomeDirection('at_least')).toBe(true);
    expect(isOutcomeDirection('at_most')).toBe(true);
    expect(isOutcomeDirection('exact')).toBe(false);
  });

  it('guards uuids', () => {
    expect(isUuid('00000000-0000-4000-8000-0000000000p1')).toBe(false); // 'p' is not hex
    expect(isUuid(PROCESS_ID)).toBe(true);
    expect(isUuid(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validation.ts — registration
// ---------------------------------------------------------------------------

describe('validation.ts — validateRegisterInput', () => {
  it('normalizes the happy path (trims, dedupes, canonical solution order)', () => {
    const valid = validateRegisterInput(
      registrationOf({
        name: '  Automate invoice data entry  ',
        solutionTypes: ['install_extension', 'recruit_agent', 'recruit_agent'],
        findingIds: [FINDING_1, FINDING_1, FINDING_2],
      }),
    );
    expect(valid.name).toBe('Automate invoice data entry');
    expect(valid.findingIds).toEqual([FINDING_1, FINDING_2]);
    expect(valid.solutionTypes).toEqual(['recruit_agent', 'install_extension']);
    expect(valid.capabilityId).toBe(CAPABILITY_ID);
    expect(valid.outcome).toEqual({
      metricName: 'manual handling minutes per month',
      metricUnit: 'minutes',
      direction: 'at_most',
      baseline: 1200,
      target: 240,
    });
  });

  it('accepts a missing capability (the reference is optional)', () => {
    const valid = validateRegisterInput(registrationOf({ capabilityId: undefined }));
    expect(valid.capabilityId).toBeNull();
    expect(validateRegisterInput(registrationOf({ capabilityId: null })).capabilityId).toBeNull();
  });

  it('rejects unknown fields — audit fields are not caller-forgeable', () => {
    expectCode(
      'invalid_registration',
      () => validateRegisterInput(registrationOf({ ...({ id: 'smuggled' } as object) })),
    );
    expectCode(
      'invalid_registration',
      () =>
        validateRegisterInput(
          registrationOf({ ...({ tenantId: 'smuggled' } as object) }),
        ),
    );
    expectCode(
      'invalid_registration',
      () => validateRegisterInput(registrationOf({ ...({ version: 7 } as object) })),
    );
  });

  it('rejects a missing or malformed process reference', () => {
    expectCode(
      'invalid_registration',
      () => validateRegisterInput(registrationOf({ processId: 'not-a-uuid' })),
    );
    expectCode(
      'invalid_registration',
      () =>
        validateRegisterInput(
          registrationOf({ ...({ processId: undefined } as object) }),
        ),
    );
  });

  it('requires at least one cited process finding (evidence-backed, lock 19)', () => {
    expectCode(
      'invalid_registration',
      () => validateRegisterInput(registrationOf({ findingIds: [] })),
    );
    expectCode(
      'invalid_registration',
      () => validateRegisterInput(registrationOf({ findingIds: ['nope'] })),
    );
  });

  it('rejects malformed frequency, period, currency, cost, error rate and horizon', () => {
    expectCode(
      'invalid_registration',
      () => validateRegisterInput(registrationOf({ frequencyCount: 0 })),
    );
    expectCode(
      'invalid_registration',
      () => validateRegisterInput(registrationOf({ frequencyCount: 1.5 })),
    );
    expectCode('invalid_registration', () => validateRegisterInput(registrationOf({ period: 'decade' as never })));
    expectCode('invalid_registration', () => validateRegisterInput(registrationOf({ currency: 'eur' })));
    expectCode('invalid_registration', () => validateRegisterInput(registrationOf({ currency: 'EURO' })));
    expectCode(
      'invalid_registration',
      () => validateRegisterInput(registrationOf({ currentCostMinor: -1 })),
    );
    expectCode(
      'invalid_registration',
      () => validateRegisterInput(registrationOf({ currentCostMinor: 10.5 })),
    );
    expectCode('invalid_registration', () => validateRegisterInput(registrationOf({ errorRate: 1.2 })));
    expectCode('invalid_registration', () => validateRegisterInput(registrationOf({ errorRate: -0.1 })));
    expectCode(
      'invalid_registration',
      () => validateRegisterInput(registrationOf({ roiHorizonPeriods: 0 })),
    );
  });

  it('rejects an empty or unknown solution-type list', () => {
    expectCode(
      'invalid_registration',
      () => validateRegisterInput(registrationOf({ solutionTypes: [] })),
    );
    expectCode(
      'invalid_registration',
      () => validateRegisterInput(registrationOf({ solutionTypes: ['outsource', 'magic' as never] })),
    );
  });

  it('rejects a malformed outcome-measurement plan', () => {
    expectCode(
      'invalid_registration',
      () =>
        validateRegisterInput(
          registrationOf({ outcome: { ...registrationOf().outcome, direction: 'exact' as never } }),
        ),
    );
    expectCode(
      'invalid_registration',
      () =>
        validateRegisterInput(
          registrationOf({ outcome: { ...registrationOf().outcome, baseline: Number.NaN } }),
        ),
    );
    expectCode(
      'invalid_registration',
      () =>
        validateRegisterInput(
          registrationOf({
            outcome: { ...registrationOf().outcome, ...({ metricName: '' } as object) },
          }),
        ),
    );
    expectCode(
      'invalid_registration',
      () => validateRegisterInput(registrationOf({ ...({ outcome: null } as object) })),
    );
  });

  it('requires a traceable actor', () => {
    expectCode(
      'invalid_registration',
      () => validateRegisterInput(registrationOf({ actor: { kind: 'person' } })),
    );
    expectCode(
      'invalid_registration',
      () => validateRegisterInput(registrationOf({ actor: { kind: 'source' as never, id: 'x' } })),
    );
  });
});

// ---------------------------------------------------------------------------
// validation.ts — revision
// ---------------------------------------------------------------------------

describe('validation.ts — validateReviseInput', () => {
  it('collects the patch fields and tracks what changed', () => {
    const valid = validateReviseInput({
      opportunityId: PROCESS_ID,
      frequencyCount: 650,
      errorRate: 0.09,
      actor: ACTOR,
    });
    expect(valid.patch.frequencyCount).toBe(650);
    expect(valid.patch.errorRate).toBe(0.09);
    expect(valid.changed).toEqual(['frequencyCount', 'errorRate']);
    expect(valid.expectedVersion).toBeNull();
  });

  it('resolves the tri-state capability patch', () => {
    expect(
      validateReviseInput({ opportunityId: PROCESS_ID, capabilityId: null, actor: ACTOR }).patch
        .capabilityId,
    ).toBeNull();
    expect(
      validateReviseInput({ opportunityId: PROCESS_ID, capabilityId: FINDING_1, actor: ACTOR })
        .patch.capabilityId,
    ).toBe(FINDING_1);
  });

  it('merges a partial outcome-plan patch', () => {
    const valid = validateReviseInput({
      opportunityId: PROCESS_ID,
      outcome: { target: 180 },
      actor: ACTOR,
    });
    expect(valid.patch.outcome).toEqual({ target: 180 });
  });

  it('has no key for the immutable identity content (name, process)', () => {
    expectCode(
      'invalid_revision',
      () =>
        validateReviseInput({
          opportunityId: PROCESS_ID,
          ...({ name: 'New name' } as object),
          actor: ACTOR,
        }),
    );
    expectCode(
      'invalid_revision',
      () =>
        validateReviseInput({
          opportunityId: PROCESS_ID,
          ...({ processId: FINDING_1 } as object),
          actor: ACTOR,
        }),
    );
  });

  it('rejects a revision that changes nothing', () => {
    expectCode('invalid_revision', () => validateReviseInput({ opportunityId: PROCESS_ID, actor: ACTOR }));
  });

  it('rejects a status change bundled with content (transitions are surgical)', () => {
    expectCode(
      'invalid_revision',
      () =>
        validateReviseInput({
          opportunityId: PROCESS_ID,
          status: 'accepted',
          frequencyCount: 700,
          actor: ACTOR,
        }),
    );
  });

  it('accepts a surgical status transition alone', () => {
    const valid = validateReviseInput({
      opportunityId: PROCESS_ID,
      status: 'accepted',
      actor: ACTOR,
    });
    expect(valid.patch.status).toBe('accepted');
    expect(valid.changed).toEqual(['status']);
  });

  it('rejects an unknown status or a malformed expectedVersion', () => {
    expectCode(
      'invalid_revision',
      () => validateReviseInput({ opportunityId: PROCESS_ID, status: 'active' as never, actor: ACTOR }),
    );
    expectCode(
      'invalid_revision',
      () =>
        validateReviseInput({
          opportunityId: PROCESS_ID,
          frequencyCount: 2,
          expectedVersion: 0,
          actor: ACTOR,
        }),
    );
  });

  it('rejects an empty finding list on revision (evidence must stay non-empty)', () => {
    expectCode(
      'invalid_revision',
      () => validateReviseInput({ opportunityId: PROCESS_ID, findingIds: [], actor: ACTOR }),
    );
  });
});

// ---------------------------------------------------------------------------
// validation.ts — measurement
// ---------------------------------------------------------------------------

describe('validation.ts — validateMeasurementInput', () => {
  it('validates and dedupes the evidence references', () => {
    const valid = validateMeasurementInput({
      opportunityId: PROCESS_ID,
      value: 210,
      note: 'First month after the agent went live',
      evidence: [
        { kind: 'metric', id: 'metric-17', label: 'ERP time report' },
        { kind: 'metric', id: 'metric-17', label: 'duplicate' },
      ],
      actor: ACTOR,
    });
    expect(valid.value).toBe(210);
    expect(valid.evidence).toEqual([{ kind: 'metric', id: 'metric-17', label: 'ERP time report' }]);
  });

  it('rejects malformed values and untraceable evidence', () => {
    expectCode(
      'invalid_measurement',
      () => validateMeasurementInput({ opportunityId: PROCESS_ID, value: Infinity, actor: ACTOR }),
    );
    expectCode(
      'invalid_measurement',
      () =>
        validateMeasurementInput({
          opportunityId: PROCESS_ID,
          value: 1,
          evidence: [{ kind: 'hunch' as never }],
          actor: ACTOR,
        }),
    );
    expectCode(
      'invalid_measurement',
      () =>
        validateMeasurementInput({
          opportunityId: PROCESS_ID,
          value: 1,
          evidence: [{ kind: 'metric' }], // no id, no label
          actor: ACTOR,
        }),
    );
    expectCode(
      'invalid_measurement',
      () => validateMeasurementInput({ opportunityId: 'nope', value: 1, actor: ACTOR }),
    );
  });
});

// ---------------------------------------------------------------------------
// validation.ts — queries
// ---------------------------------------------------------------------------

describe('validation.ts — queries', () => {
  it('validates the list query (defaults, bounds, unknown keys)', () => {
    expect(validateListQuery({})).toEqual({
      name: null,
      search: null,
      status: null,
      processId: null,
      solutionType: null,
      limit: DEFAULT_LIST_LIMIT,
    });
    expect(
      validateListQuery({ name: 'x', search: 'y', status: 'accepted', processId: PROCESS_ID, solutionType: 'outsource', limit: 500 }),
    ).toEqual({
      name: 'x',
      search: 'y',
      status: 'accepted',
      processId: PROCESS_ID,
      solutionType: 'outsource',
      limit: 500,
    });
    expectCode('invalid_query', () => validateListQuery({ limit: 0 }));
    expectCode('invalid_query', () => validateListQuery({ limit: 501 }));
    expectCode('invalid_query', () => validateListQuery({ status: 'active' as never }));
    expectCode('invalid_query', () => validateListQuery({ solutionType: 'magic' as never }));
    expectCode('invalid_query', () => validateListQuery({ ...({ bogus: 1 } as object) }));
  });

  it('validates the point queries', () => {
    expect(validateOpportunityQuery({ opportunityId: PROCESS_ID })).toEqual({
      opportunityId: PROCESS_ID,
    });
    expect(validateVersionQuery({ opportunityId: PROCESS_ID, version: 3 })).toEqual({
      opportunityId: PROCESS_ID,
      version: 3,
    });
    expect(validateMeasurementsQuery({ opportunityId: PROCESS_ID })).toEqual({
      opportunityId: PROCESS_ID,
    });
    expect(validateMeasurementQuery({ measurementId: FINDING_1 })).toEqual({
      measurementId: FINDING_1,
    });
    expectCode('invalid_query', () => validateOpportunityQuery({ opportunityId: 'x' }));
    expectCode('invalid_query', () => validateVersionQuery({ opportunityId: PROCESS_ID, version: 0 }));
    expectCode('invalid_query', () => validateMeasurementsQuery({ extra: 1 } as never));
    expectCode('invalid_query', () => validateMeasurementQuery({ measurementId: 'x' }));
  });
});
