// Unit tests for the org-lab module's pure logic (no database): the frozen
// vocabularies (node/edge kinds, staffing profiles, risk tolerances,
// lifecycles, dispositions, the mirrored W132/W134/coverage lists), the
// context guard, the input/query validators — and THE RANKING MATH
// (ranking.ts), the single deterministic definition of how the Lab ranks
// organization candidates under a ContextFingerprint.
//
// The honesty laws under test:
//
//   * THE CONTEXTUAL RULE — nothing in the ranker knows an industry or a
//     season name; the ONLY inputs are declared applicability hypotheses
//     and the observed fingerprint. The same candidate set under two
//     materially different fingerprints ranks a DIFFERENT candidate
//     first (the W135 acceptance, proven purely here and again against
//     the real service in org-lab-service.test.ts);
//   * the null-signal law — an absent fingerprint dimension is
//     'unobserved', never faked; a candidate that declares nothing the
//     fingerprint observed is 'agnostic' with fitScore null (never a
//     fabricated 0.5 in the REPORT);
//   * calibration is arithmetic over recorded evidence — Laplace-smoothed
//     so one sample can never swing the ranking wildly, cold start is
//     exactly neutral, and a strong positive history can overcome a fit
//     deficit while a negative history drags below a cold equal-fit peer;
//   * rejected-candidate evidence discipline — a rejected evaluation
//     REQUIRES rejection reasons, a recommended one carries none.

import { describe, expect, it } from 'vitest';
import { OrgLabError } from '../errors';
import {
  CANDIDATE_DISPOSITIONS,
  COVERAGE_SOURCE_REGISTRIES,
  DEFAULT_LIST_LIMIT,
  DURATION_CLASSES,
  MAX_LIST_LIMIT,
  MAX_PURPOSES_PER_NODE,
  MAX_SEASON_WINDOWS,
  MIN_EVALUATED_CANDIDATES,
  MODEL_BINDING_PURPOSES,
  ORG_CANDIDATE_STATUSES,
  ORG_EDGE_KINDS,
  ORG_NODE_KINDS,
  ORG_RECOMMENDATION_STATUSES,
  RISK_TOLERANCES,
  STAFFING_PROFILES,
  WORKLOAD_LEVELS,
  assertOrgLabTenantContext,
  isCandidateDisposition,
  isOrgNodeKind,
  isUuid,
  validateGetCandidateQuery,
  validateListCandidatesQuery,
  validateListRecommendationsQuery,
  validateRecordCalibrationInput,
  validateRecordRecommendationInput,
  validateRegisterCandidateInput,
  validateRetireCandidateInput,
  validateSearchOrganizationsQuery,
} from '../validation';
import {
  CALIBRATION_GAIN,
  NEUTRAL_FIT,
  calibrationAggregate,
  calibrationPolarity,
  contextualFit,
  observedStaffingProfile,
  rankOrganizationCandidates,
  rankScoreOf,
  smoothedSuccessRate,
} from '../ranking';
import { ORG_FIT_AXES } from '../types';
import type {
  CandidateApplicability,
  FitFingerprint,
  RankableCandidate,
} from '../types';

const UUID_A = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const UUID_B = '1c3f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e90';
const UUID_C = '2d4f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e91';

function expectCode(code: string, fn: () => unknown): void {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(OrgLabError);
    expect((error as OrgLabError).code).toBe(code);
  }
}

function ctx(): { tenantId: string; principalId: string; authority: string[] } {
  return { tenantId: UUID_A, principalId: UUID_B, authority: [] };
}

// ---------------------------------------------------------------------------
// Fixtures: one fully-observed fingerprint and three applicability postures
// ---------------------------------------------------------------------------

/** Every typed dimension observed — the richest honest fingerprint. */
const FULL_FINGERPRINT: FitFingerprint = {
  season: { window: 'spring', note: null },
  duration: { durationClass: 'short', estimatedSpan: '~6 weeks' },
  staffing: { headcount: 6, experienceMix: { novice: 5, intermediate: 1, expert: 0 }, note: null },
  workload: 'light',
  capabilities: { available: ['ride-dispatch', 'payments'], missing: [] },
  environment: { factors: ['urban', 'rainy-season'] },
  constraints: {
    budgetNote: 'lean budget',
    slaNote: '15m pickup SLA',
    qualityTarget: '4.8 stars',
    riskTolerance: 'risk-averse',
    verificationRequirements: ['dual-signoff'],
  },
  evidenceFreshness: { maxEvidenceAge: '48h', criticalFreshSurfaces: ['traffic-api', 'weather-api'] },
};

/** A materially different context for the SAME subject. */
const WINTER_FINGERPRINT: FitFingerprint = {
  season: { window: 'winter', note: null },
  duration: { durationClass: 'long', estimatedSpan: '~5 months' },
  staffing: { headcount: 4, experienceMix: { novice: 0, intermediate: 1, expert: 3 }, note: null },
  workload: 'heavy',
  capabilities: { available: ['freight-logistics'], missing: [] },
  environment: { factors: ['mountain', 'snow'] },
  constraints: {
    budgetNote: 'capital available',
    slaNote: '24h freight SLA',
    qualityTarget: 'zero damage',
    riskTolerance: 'risk-tolerant',
    verificationRequirements: ['carrier-insurance'],
  },
  evidenceFreshness: { maxEvidenceAge: '24h', criticalFreshSurfaces: ['weather-api', 'road-status'] },
};

/** The honestly-empty fingerprint: every dimension absent (null-signal law). */
const EMPTY_FINGERPRINT: FitFingerprint = {
  season: null,
  duration: null,
  staffing: null,
  workload: null,
  capabilities: null,
  environment: null,
  constraints: null,
  evidenceFreshness: null,
};

function emptyApplicability(): CandidateApplicability {
  return {
    seasonWindows: [],
    durationClasses: [],
    staffingProfiles: [],
    workloadLevels: [],
    requiredCapabilities: [],
    requiredEnvironmentFactors: [],
    riskTolerances: [],
    requiredVerificationRequirements: [],
    freshSurfaces: [],
    budgetNote: null,
    qualityTarget: null,
    slaNote: null,
  };
}

/** Declares exactly what FULL_FINGERPRINT observes (all eight mechanical axes match). */
const SPRING_DECLARED: CandidateApplicability = {
  ...emptyApplicability(),
  seasonWindows: ['spring'],
  durationClasses: ['short'],
  staffingProfiles: ['novice-heavy'],
  workloadLevels: ['light'],
  requiredCapabilities: ['ride-dispatch'],
  requiredEnvironmentFactors: ['urban'],
  riskTolerances: ['risk-averse'],
  requiredVerificationRequirements: ['dual-signoff'],
  freshSurfaces: ['traffic-api'],
  budgetNote: 'cost-conscious crew',
  qualityTarget: 'high rating',
  slaNote: 'fast pickup',
};

/** Declares the opposite of everything FULL_FINGERPRINT observes. */
const WINTER_DECLARED: CandidateApplicability = {
  ...emptyApplicability(),
  seasonWindows: ['winter'],
  durationClasses: ['long'],
  staffingProfiles: ['expert-heavy'],
  workloadLevels: ['heavy'],
  requiredCapabilities: ['freight-logistics'],
  requiredEnvironmentFactors: ['mountain'],
  riskTolerances: ['risk-tolerant'],
  requiredVerificationRequirements: ['carrier-insurance'],
  freshSurfaces: ['road-status'],
};

// ---------------------------------------------------------------------------
// Vocabularies + guards
// ---------------------------------------------------------------------------

describe('W135 vocabularies', () => {
  it('exposes the §4/§5 node-kind comparison set and the edge vocabulary', () => {
    expect(ORG_NODE_KINDS).toEqual([
      'agent-body',
      'tenant-agent',
      'marketplace-agent-package',
      'marketplace-extension-package',
      'human-capability',
      'external-specialist',
    ]);
    expect(ORG_EDGE_KINDS).toEqual([
      'delegation',
      'review',
      'handoff',
      'escalation',
      'information-feed',
    ]);
    expect(isOrgNodeKind('human-capability')).toBe(true);
    expect(isOrgNodeKind('contractor')).toBe(false);
  });

  it('exposes the one-way lifecycles, the disposition discipline and the mirrored cross-module vocabularies', () => {
    expect(ORG_CANDIDATE_STATUSES).toEqual(['active', 'retired']);
    expect(ORG_RECOMMENDATION_STATUSES).toEqual(['recorded', 'calibrated']);
    expect(CANDIDATE_DISPOSITIONS).toEqual(['recommended', 'rejected']);
    expect(isCandidateDisposition('recommended')).toBe(true);
    expect(isCandidateDisposition('shortlisted')).toBe(false);
    // Mirrors, compiler-pinned to the frozen unions (drift fails typecheck).
    expect(MODEL_BINDING_PURPOSES).toEqual(['cognition', 'conversation', 'analysis', 'background']);
    expect(DURATION_CLASSES).toEqual(['short', 'medium', 'long', 'ongoing']);
    expect(WORKLOAD_LEVELS).toEqual(['light', 'normal', 'heavy', 'overloaded']);
    expect(RISK_TOLERANCES).toEqual(['risk-averse', 'balanced', 'risk-tolerant']);
    expect(STAFFING_PROFILES).toEqual([
      'novice-heavy',
      'intermediate-heavy',
      'expert-heavy',
      'mixed',
    ]);
    expect(COVERAGE_SOURCE_REGISTRIES).toEqual(['source', 'channel', 'meeting', 'integration']);
  });

  it('exposes the twelve acceptance fit axes in canonical order', () => {
    expect(ORG_FIT_AXES).toEqual([
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
    ]);
  });

  it('guards uuids and the explicit TenantContext (asserted, never ambient)', () => {
    expect(isUuid(UUID_A)).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(() => assertOrgLabTenantContext(ctx())).not.toThrow();
    expectCode('invalid_context', () => assertOrgLabTenantContext({ tenantId: '', principalId: UUID_B, authority: [] }));
    expectCode('invalid_context', () => assertOrgLabTenantContext(null as unknown as never));
  });
});

// ---------------------------------------------------------------------------
// registerCandidate validation
// ---------------------------------------------------------------------------

function fullCandidateInput(): Record<string, unknown> {
  return {
    slug: 'spring-sprint-crew',
    label: 'Spring sprint crew',
    description: 'A §4 composition with the §5 comparison set at a glance.',
    composition: {
      nodes: [
        { nodeId: 'dispatch', kind: 'agent-body', role: 'Dispatch lead', ref: UUID_A, purposes: ['cognition', 'analysis'] },
        { nodeId: 'surge', kind: 'marketplace-agent-package', role: 'Surge analyst', ref: 'pkg-surge-1', label: 'Surge analytics pack' },
        { nodeId: 'steward', kind: 'human-capability', role: 'Fleet steward', ref: 'person-7', label: 'Maya' },
        { nodeId: 'auditor', kind: 'external-specialist', role: 'Compliance auditor' },
        { nodeId: 'tenant-agent', kind: 'tenant-agent', role: 'Support triage' },
        { nodeId: 'extension', kind: 'marketplace-extension-package', role: 'Routing extension', ref: 'ext-routing-2' },
      ],
      edges: [
        { fromNodeId: 'dispatch', toNodeId: 'surge', kind: 'delegation', note: 'surge windows' },
        { fromNodeId: 'steward', toNodeId: 'dispatch', kind: 'review', note: null },
        { fromNodeId: 'dispatch', toNodeId: 'tenant-agent', kind: 'handoff', note: null },
        { fromNodeId: 'tenant-agent', toNodeId: 'steward', kind: 'escalation', note: null },
        { fromNodeId: 'surge', toNodeId: 'dispatch', kind: 'information-feed', note: null },
      ],
      informationRoutes: [{ registry: 'source', ref: 'src-traffic', note: 'live traffic feed' }],
    },
    applicability: {
      seasonWindows: [' Spring ', 'spring', 'Q4'],
      durationClasses: ['short'],
      staffingProfiles: ['novice-heavy'],
      workloadLevels: ['light'],
      requiredCapabilities: ['ride-dispatch'],
      requiredEnvironmentFactors: ['urban'],
      riskTolerances: ['risk-averse'],
      requiredVerificationRequirements: ['dual-signoff'],
      freshSurfaces: ['traffic-api'],
      budgetNote: 'lean ops',
      qualityTarget: '4.8 stars',
      slaNote: '15m pickup',
    },
  };
}

describe('W135 registerCandidate validation', () => {
  it('round-trips the full §4 composition, normalizes and de-duplicates the declared hypotheses', () => {
    const valid = validateRegisterCandidateInput(fullCandidateInput());
    expect(valid.slug).toBe('spring-sprint-crew');
    expect(valid.composition.nodes).toHaveLength(6);
    expect(valid.composition.nodes[0]).toEqual({
      nodeId: 'dispatch',
      kind: 'agent-body',
      role: 'Dispatch lead',
      ref: UUID_A,
      label: null,
      purposes: ['cognition', 'analysis'],
    });
    expect(valid.composition.edges).toHaveLength(5);
    expect(valid.composition.informationRoutes).toEqual([
      { registry: 'source', ref: 'src-traffic', note: 'live traffic feed' },
    ]);
    // Trim + lowercase + de-dup, order preserved.
    expect(valid.applicability.seasonWindows).toEqual(['spring', 'q4']);
    expect(valid.applicability.durationClasses).toEqual(['short']);
    expect(valid.applicability.budgetNote).toBe('lean ops');
  });

  it('defaults the optional surfaces honestly (empty, never invented)', () => {
    const valid = validateRegisterCandidateInput({
      slug: 'minimal',
      label: 'Minimal',
      composition: { nodes: [{ nodeId: 'solo', kind: 'tenant-agent', role: 'Solo' }] },
    });
    expect(valid.description).toBeNull();
    expect(valid.composition.edges).toEqual([]);
    expect(valid.composition.informationRoutes).toEqual([]);
    expect(valid.applicability).toEqual(emptyApplicability());
  });

  it('enforces the slug grammar, node ids and the composition bounds', () => {
    const base = fullCandidateInput();
    expectCode('invalid_candidate_input', () =>
      validateRegisterCandidateInput({ ...base, slug: 'Bad_Slug' }),
    );
    expectCode('invalid_candidate_input', () =>
      validateRegisterCandidateInput({ ...base, composition: { nodes: [] } }),
    );
    expectCode('invalid_candidate_input', () => {
      const input = fullCandidateInput();
      (input.composition as Record<string, unknown>).nodes = [
        { nodeId: 'dupe', kind: 'tenant-agent', role: 'One' },
        { nodeId: 'dupe', kind: 'tenant-agent', role: 'Two' },
      ];
      return validateRegisterCandidateInput(input);
    });
    expectCode('invalid_candidate_input', () => {
      const input = fullCandidateInput();
      (input.composition as Record<string, unknown>).nodes = [
        { nodeId: 'solo', kind: 'contractor', role: 'Unknown kind' },
      ];
      return validateRegisterCandidateInput(input);
    });
  });

  it('enforces the agent-body seam: uuid refs, purposes on agent-body nodes only', () => {
    const withBadRef = fullCandidateInput();
    ((withBadRef.composition as Record<string, unknown>).nodes as Record<string, unknown>[])[0] = {
      nodeId: 'dispatch',
      kind: 'agent-body',
      role: 'Dispatch lead',
      ref: 'not-a-uuid',
    };
    expectCode('invalid_candidate_input', () => validateRegisterCandidateInput(withBadRef));

    const withPurposesOnHuman = fullCandidateInput();
    ((withPurposesOnHuman.composition as Record<string, unknown>).nodes as Record<string, unknown>[])[2] = {
      nodeId: 'steward',
      kind: 'human-capability',
      role: 'Fleet steward',
      purposes: ['cognition'],
    };
    expectCode('invalid_candidate_input', () => validateRegisterCandidateInput(withPurposesOnHuman));

    const withUnknownPurpose = fullCandidateInput();
    ((withUnknownPurpose.composition as Record<string, unknown>).nodes as Record<string, unknown>[])[0] = {
      nodeId: 'dispatch',
      kind: 'agent-body',
      role: 'Dispatch lead',
      ref: UUID_A,
      purposes: ['reasoning'],
    };
    expectCode('invalid_candidate_input', () => validateRegisterCandidateInput(withUnknownPurpose));

    const withTooManyPurposes = fullCandidateInput();
    ((withTooManyPurposes.composition as Record<string, unknown>).nodes as Record<string, unknown>[])[0] = {
      nodeId: 'dispatch',
      kind: 'agent-body',
      role: 'Dispatch lead',
      ref: UUID_A,
      purposes: Array.from({ length: MAX_PURPOSES_PER_NODE + 1 }, () => 'cognition'),
    };
    expectCode('invalid_candidate_input', () => validateRegisterCandidateInput(withTooManyPurposes));
  });

  it('enforces edge endpoints and route registries', () => {
    const dangling = fullCandidateInput();
    ((dangling.composition as Record<string, unknown>).edges as Record<string, unknown>[])[0] = {
      fromNodeId: 'dispatch',
      toNodeId: 'ghost-node',
      kind: 'delegation',
    };
    expectCode('invalid_candidate_input', () => validateRegisterCandidateInput(dangling));

    const selfLoop = fullCandidateInput();
    ((selfLoop.composition as Record<string, unknown>).edges as Record<string, unknown>[])[0] = {
      fromNodeId: 'dispatch',
      toNodeId: 'dispatch',
      kind: 'delegation',
    };
    expectCode('invalid_candidate_input', () => validateRegisterCandidateInput(selfLoop));

    const badRegistry = fullCandidateInput();
    ((badRegistry.composition as Record<string, unknown>).informationRoutes as Record<string, unknown>[])[0] = {
      registry: 'scroll',
      ref: 'src-traffic',
    };
    expectCode('invalid_candidate_input', () => validateRegisterCandidateInput(badRegistry));
  });

  it('validates the declared applicability vocabularies and bounds', () => {
    expectCode('invalid_candidate_input', () => {
      const input = fullCandidateInput();
      (input.applicability as Record<string, unknown>).durationClasses = ['ephemeral'];
      return validateRegisterCandidateInput(input);
    });
    expectCode('invalid_candidate_input', () => {
      const input = fullCandidateInput();
      (input.applicability as Record<string, unknown>).staffingProfiles = ['junior-heavy'];
      return validateRegisterCandidateInput(input);
    });
    expectCode('invalid_candidate_input', () => {
      const input = fullCandidateInput();
      (input.applicability as Record<string, unknown>).riskTolerances = ['risk-seeking'];
      return validateRegisterCandidateInput(input);
    });
    expectCode('invalid_candidate_input', () => {
      const input = fullCandidateInput();
      (input.applicability as Record<string, unknown>).seasonWindows = Array.from(
        { length: MAX_SEASON_WINDOWS + 1 },
        (_, index) => `season-${index}`,
      );
      return validateRegisterCandidateInput(input);
    });
  });

  it('validates retire/list/get queries (uuids, statuses, limits)', () => {
    expect(validateRetireCandidateInput({ candidateId: UUID_A, reason: '  superseded  ' }).reason).toBe('superseded');
    expectCode('invalid_candidate_input', () => validateRetireCandidateInput({ candidateId: UUID_A }));
    expect(validateGetCandidateQuery({ candidateId: UUID_A })).toEqual({ candidateId: UUID_A });
    expectCode('invalid_query', () => validateGetCandidateQuery({ candidateId: 'x' }));

    expect(validateListCandidatesQuery()).toEqual({ status: null, limit: DEFAULT_LIST_LIMIT });
    expect(validateListCandidatesQuery({ status: 'retired', limit: 10 })).toEqual({
      status: 'retired',
      limit: 10,
    });
    expectCode('invalid_query', () => validateListCandidatesQuery({ status: 'zombie' }));
    expectCode('invalid_query', () => validateListCandidatesQuery({ limit: MAX_LIST_LIMIT + 1 }));
    expectCode('invalid_query', () => validateListCandidatesQuery({ limit: 0 }));
  });
});

// ---------------------------------------------------------------------------
// recordRecommendation / recordCalibration validation
// ---------------------------------------------------------------------------

function recommendationInput(): Record<string, unknown> {
  return {
    goalId: UUID_A,
    fingerprintId: UUID_B,
    knowledgeObjective: 'A dispatch organization that holds a 15m pickup SLA in spring',
    evaluationConfig: {
      criteria: [
        { name: 'contextual fit', weight: 0.6 },
        { name: 'cost', weight: 0.4 },
      ],
      note: 'spring window evaluation',
    },
    candidates: [
      {
        candidateId: UUID_A,
        disposition: 'recommended',
        summary: 'Fits the observed spring/short/light context on every declared axis.',
        scores: [
          { name: 'contextual fit', value: 0.95 },
          { name: 'cost', value: 0.7 },
        ],
        evidenceRefs: ['search-2026-10-06'],
      },
      {
        candidateId: UUID_C,
        disposition: 'rejected',
        rejectionReasons: ['declared for winter freight, not spring rides'],
        summary: 'Material context misfit.',
      },
    ],
    expectedOutcomeIds: [UUID_B, UUID_C],
    derivedFrom: ['search-2026-10-06'],
    note: 'recorded after the contextual search',
  };
}

describe('W135 recordRecommendation validation', () => {
  it('round-trips the full §11 evidence input', () => {
    const valid = validateRecordRecommendationInput(recommendationInput());
    expect(valid.goalId).toBe(UUID_A);
    expect(valid.strategyId).toBeNull();
    expect(valid.evaluationConfig.criteria).toEqual([
      { name: 'contextual fit', weight: 0.6 },
      { name: 'cost', weight: 0.4 },
    ]);
    expect(valid.candidates).toHaveLength(2);
    expect(valid.candidates[0]!.disposition).toBe('recommended');
    expect(valid.candidates[0]!.rejectionReasons).toEqual([]);
    expect(valid.candidates[1]!.rejectionReasons).toEqual(['declared for winter freight, not spring rides']);
    expect(valid.expectedOutcomeIds).toEqual([UUID_B, UUID_C]);
    expect(valid.derivedFrom).toEqual(['search-2026-10-06']);
  });

  it('enforces the evaluation-config discipline (criteria uniqueness, weights, bounds)', () => {
    expectCode('invalid_recommendation_input', () => {
      const input = recommendationInput();
      (input.evaluationConfig as Record<string, unknown>).criteria = [];
      return validateRecordRecommendationInput(input);
    });
    expectCode('invalid_recommendation_input', () => {
      const input = recommendationInput();
      (input.evaluationConfig as Record<string, unknown>).criteria = [
        { name: 'fit', weight: 0.5 },
        { name: 'fit', weight: 0.5 },
      ];
      return validateRecordRecommendationInput(input);
    });
    expectCode('invalid_recommendation_input', () => {
      const input = recommendationInput();
      (input.evaluationConfig as Record<string, unknown>).criteria = [{ name: 'fit', weight: 1.5 }];
      return validateRecordRecommendationInput(input);
    });
  });

  it('enforces the score discipline (known criteria, no dupes, [0,1] values)', () => {
    expectCode('invalid_recommendation_input', () => {
      const input = recommendationInput();
      ((input.candidates as Record<string, unknown>[])[0] as Record<string, unknown>).scores = [
        { name: 'unknown criterion', value: 0.5 },
      ];
      return validateRecordRecommendationInput(input);
    });
    expectCode('invalid_recommendation_input', () => {
      const input = recommendationInput();
      ((input.candidates as Record<string, unknown>[])[0] as Record<string, unknown>).scores = [
        { name: 'cost', value: 1.2 },
      ];
      return validateRecordRecommendationInput(input);
    });
    expectCode('invalid_recommendation_input', () => {
      const input = recommendationInput();
      ((input.candidates as Record<string, unknown>[])[0] as Record<string, unknown>).scores = [
        { name: 'cost', value: 0.1 },
        { name: 'cost', value: 0.2 },
      ];
      return validateRecordRecommendationInput(input);
    });
  });

  it('enforces the rejection-reason discipline (retained evidence)', () => {
    expectCode('invalid_recommendation_input', () => {
      const input = recommendationInput();
      ((input.candidates as Record<string, unknown>[])[1] as Record<string, unknown>).rejectionReasons = [];
      return validateRecordRecommendationInput(input);
    });
    expectCode('invalid_recommendation_input', () => {
      const input = recommendationInput();
      ((input.candidates as Record<string, unknown>[])[0] as Record<string, unknown>).rejectionReasons = ['why is the winner carrying reasons'];
      return validateRecordRecommendationInput(input);
    });
  });

  it('enforces the evaluated-candidate set discipline (2..32, distinct, at most one winner)', () => {
    expect(MIN_EVALUATED_CANDIDATES).toBe(2);
    expectCode('invalid_recommendation_input', () => {
      const input = recommendationInput();
      (input.candidates as unknown[]).pop();
      return validateRecordRecommendationInput(input);
    });
    expectCode('invalid_recommendation_input', () => {
      const input = recommendationInput();
      ((input.candidates as Record<string, unknown>[])[1] as Record<string, unknown>).disposition = 'recommended';
      return validateRecordRecommendationInput(input);
    });
    expectCode('invalid_recommendation_input', () => {
      const input = recommendationInput();
      ((input.candidates as Record<string, unknown>[])[1] as Record<string, unknown>).candidateId = UUID_A;
      return validateRecordRecommendationInput(input);
    });
    expect(
      validateRecordRecommendationInput({
        ...recommendationInput(),
        candidates: [
          { candidateId: UUID_A, disposition: 'rejected', rejectionReasons: ['no clear winner'], summary: 'None fits.' },
          { candidateId: UUID_C, disposition: 'rejected', rejectionReasons: ['also wrong'], summary: 'Also wrong.' },
        ],
      }).candidates,
    ).toHaveLength(2); // zero recommended is the honest no-winner case
  });

  it('validates expected outcomes, evidence refs and the calibration input', () => {
    expectCode('invalid_recommendation_input', () => {
      const input = recommendationInput();
      input.expectedOutcomeIds = [];
      return validateRecordRecommendationInput(input);
    });
    expectCode('invalid_recommendation_input', () => {
      const input = recommendationInput();
      (input.expectedOutcomeIds as unknown[]).push('not-a-uuid');
      return validateRecordRecommendationInput(input);
    });
    expect(validateRecordCalibrationInput({ recommendationId: UUID_A }).note).toBeNull();
    expectCode('invalid_calibration_input', () => validateRecordCalibrationInput({ recommendationId: 'x' }));
    expect(validateRecordCalibrationInput({ recommendationId: UUID_A, note: '  kept  ' }).note).toBe('kept');
  });

  it('validates the search and recommendation list queries', () => {
    expect(validateSearchOrganizationsQuery({ goalId: UUID_A, fingerprintId: UUID_B })).toEqual({
      goalId: UUID_A,
      fingerprintId: UUID_B,
      limit: DEFAULT_LIST_LIMIT,
    });
    expectCode('invalid_query', () => validateSearchOrganizationsQuery({ goalId: UUID_A }));
    expectCode('invalid_query', () => validateSearchOrganizationsQuery({ goalId: 'x', fingerprintId: UUID_B }));

    const listValid = validateListRecommendationsQuery({
      goalId: UUID_A,
      candidateId: UUID_C,
      status: 'calibrated',
      limit: 5,
    });
    expect(listValid).toEqual({
      goalId: UUID_A,
      fingerprintId: null,
      candidateId: UUID_C,
      status: 'calibrated',
      limit: 5,
    });
    expect(validateListRecommendationsQuery().limit).toBe(DEFAULT_LIST_LIMIT);
    expectCode('invalid_query', () => validateListRecommendationsQuery({ status: 'pending' }));
    expectCode('invalid_query', () => validateListRecommendationsQuery({ goalId: 'x' }));
  });
});

// ---------------------------------------------------------------------------
// The ranking math (ranking.ts — the pure core of the search)
// ---------------------------------------------------------------------------

describe('W135 observedStaffingProfile (the deterministic derivation)', () => {
  it('derives the dominant bucket at >= 50% share, mixed otherwise, null when honestly absent', () => {
    expect(observedStaffingProfile(FULL_FINGERPRINT.staffing)).toBe('novice-heavy');
    expect(observedStaffingProfile(WINTER_FINGERPRINT.staffing)).toBe('expert-heavy');
    expect(
      observedStaffingProfile({
        headcount: 4,
        experienceMix: { novice: 2, intermediate: 1, expert: 1 },
        note: null,
      }),
    ).toBe('novice-heavy');
    expect(
      observedStaffingProfile({
        headcount: 4,
        experienceMix: { novice: 1, intermediate: 2, expert: 1 },
        note: null,
      }),
    ).toBe('intermediate-heavy');
    expect(
      observedStaffingProfile({
        headcount: 5,
        experienceMix: { novice: 2, intermediate: 2, expert: 1 },
        note: null,
      }),
    ).toBe('mixed');
    expect(observedStaffingProfile(null)).toBeNull();
    expect(observedStaffingProfile({ headcount: null, experienceMix: null, note: null })).toBeNull();
    expect(
      observedStaffingProfile({
        headcount: 0,
        experienceMix: { novice: 0, intermediate: 0, expert: 0 },
        note: null,
      }),
    ).toBeNull();
  });
});

describe('W135 contextualFit (the twelve-axis report)', () => {
  it('reports match on every mechanical axis a matching declaration satisfies', () => {
    const { dimensions, fitScore } = contextualFit(SPRING_DECLARED, FULL_FINGERPRINT);
    const byAxis = new Map(dimensions.map((entry) => [entry.axis, entry.verdict]));
    expect(dimensions).toHaveLength(ORG_FIT_AXES.length);
    expect(byAxis.get('season')).toBe('match');
    expect(byAxis.get('duration')).toBe('match');
    expect(byAxis.get('staffing')).toBe('match');
    expect(byAxis.get('workload')).toBe('match');
    expect(byAxis.get('capabilities')).toBe('match');
    expect(byAxis.get('environment')).toBe('match');
    expect(byAxis.get('risk')).toBe('match');
    expect(byAxis.get('verification')).toBe('match');
    expect(byAxis.get('evidence-freshness')).toBe('match');
    // The free-text axes are advisory: both postures surfaced, never matched.
    expect(byAxis.get('budget')).toBe('advisory');
    expect(byAxis.get('quality')).toBe('advisory');
    expect(byAxis.get('sla')).toBe('advisory');
    expect(fitScore).toBe(1);
    const budget = dimensions.find((entry) => entry.axis === 'budget')!;
    expect(budget.declared).toBe('cost-conscious crew');
    expect(budget.observed).toContain('lean budget');
  });

  it('reports misfit on every violated declaration (fit 0), with human-auditable summaries', () => {
    const { dimensions, fitScore } = contextualFit(WINTER_DECLARED, FULL_FINGERPRINT);
    const byAxis = new Map(dimensions.map((entry) => [entry.axis, entry.verdict]));
    expect(byAxis.get('season')).toBe('misfit');
    expect(byAxis.get('duration')).toBe('misfit');
    expect(byAxis.get('staffing')).toBe('misfit');
    expect(byAxis.get('workload')).toBe('misfit');
    expect(byAxis.get('capabilities')).toBe('misfit');
    expect(byAxis.get('environment')).toBe('misfit');
    expect(byAxis.get('risk')).toBe('misfit');
    expect(byAxis.get('verification')).toBe('misfit');
    expect(byAxis.get('evidence-freshness')).toBe('misfit');
    expect(fitScore).toBe(0);
    const season = dimensions.find((entry) => entry.axis === 'season')!;
    expect(season.declared).toContain('winter');
    expect(season.observed).toContain('spring');
  });

  it('blends verdicts per axis (one match, one misfit -> 0.5) and matches case-insensitively', () => {
    const half: CandidateApplicability = {
      ...emptyApplicability(),
      seasonWindows: ['SPRING'],
      durationClasses: ['long'],
    };
    const { dimensions, fitScore } = contextualFit(half, FULL_FINGERPRINT);
    const byAxis = new Map(dimensions.map((entry) => [entry.axis, entry.verdict]));
    expect(byAxis.get('season')).toBe('match'); // normalized matching
    expect(byAxis.get('duration')).toBe('misfit');
    expect(byAxis.get('workload')).toBe('agnostic'); // observed, not declared
    expect(fitScore).toBe(0.5);
  });

  it('treats an undeclaring candidate as agnostic with fitScore null (never a fabricated 0.5)', () => {
    const { dimensions, fitScore } = contextualFit(emptyApplicability(), FULL_FINGERPRINT);
    for (const entry of dimensions) {
      if (entry.axis === 'budget' || entry.axis === 'quality' || entry.axis === 'sla') {
        expect(entry.verdict).toBe('advisory');
      } else {
        expect(entry.verdict).toBe('agnostic');
        expect(entry.declared).toBe('(nothing declared)');
      }
    }
    expect(fitScore).toBeNull();
  });

  it('reports unobserved honestly when the fingerprint lacks dimensions (the null-signal law)', () => {
    const { dimensions, fitScore } = contextualFit(SPRING_DECLARED, EMPTY_FINGERPRINT);
    for (const entry of dimensions) {
      expect(entry.verdict).toBe('unobserved');
      expect(entry.observed).toBe('(not observed)');
    }
    expect(fitScore).toBeNull();
  });

  it('surfaces advisory axes as unobserved when the constraints lack the free-text member', () => {
    const { dimensions } = contextualFit(
      emptyApplicability(),
      { ...FULL_FINGERPRINT, constraints: { ...FULL_FINGERPRINT.constraints!, budgetNote: null } },
    );
    const budget = dimensions.find((entry) => entry.axis === 'budget')!;
    expect(budget.verdict).toBe('unobserved');
    const sla = dimensions.find((entry) => entry.axis === 'sla')!;
    expect(sla.verdict).toBe('advisory');
  });
});

describe('W135 calibration arithmetic', () => {
  it('Laplace-smooths the success rate so one sample can never swing to 0 or 1', () => {
    expect(smoothedSuccessRate(null)).toBe(0.5);
    expect(smoothedSuccessRate({ candidateId: UUID_A, sampleSize: 0, successes: 0, failures: 0, successRate: 0, evidenceRecommendationIds: [] })).toBe(0.5);
    expect(smoothedSuccessRate({ candidateId: UUID_A, sampleSize: 1, successes: 1, failures: 0, successRate: 1, evidenceRecommendationIds: [UUID_A] })).toBeCloseTo(2 / 3);
    expect(smoothedSuccessRate({ candidateId: UUID_A, sampleSize: 1, successes: 0, failures: 1, successRate: 0, evidenceRecommendationIds: [UUID_A] })).toBeCloseTo(1 / 3);
    expect(smoothedSuccessRate({ candidateId: UUID_A, sampleSize: 8, successes: 8, failures: 0, successRate: 1, evidenceRecommendationIds: [] })).toBeCloseTo(9 / 10);
  });

  it('blends fit with calibration: cold is exactly neutral, null fit uses the neutral baseline', () => {
    const cold: Parameters<typeof rankScoreOf>[1] = null;
    expect(rankScoreOf(0.8, cold)).toBe(0.8);
    expect(rankScoreOf(null, cold)).toBe(NEUTRAL_FIT);
    const positive = { candidateId: UUID_A, sampleSize: 2, successes: 2, failures: 0, successRate: 1, evidenceRecommendationIds: [UUID_A, UUID_B] };
    const negative = { candidateId: UUID_A, sampleSize: 2, successes: 0, failures: 2, successRate: 0, evidenceRecommendationIds: [UUID_A, UUID_B] };
    // factor = 1 + CALIBRATION_GAIN * (smoothed - 0.5)
    expect(rankScoreOf(1, positive)).toBeCloseTo(1 + CALIBRATION_GAIN * (0.75 - 0.5));
    expect(rankScoreOf(1, negative)).toBeCloseTo(1 + CALIBRATION_GAIN * (0.25 - 0.5));
    expect(rankScoreOf(null, positive)).toBeCloseTo(NEUTRAL_FIT * (1 + CALIBRATION_GAIN * 0.25));
  });

  it('derives polarity strictly: positive iff every realized outcome met or exceeded', () => {
    expect(calibrationPolarity([{ assessment: 'met' }])).toBe('positive');
    expect(calibrationPolarity([{ assessment: 'exceeded' }, { assessment: 'met' }])).toBe('positive');
    expect(calibrationPolarity([{ assessment: 'met' }, { assessment: 'missed' }])).toBe('negative');
    expect(calibrationPolarity([{ assessment: 'missed' }])).toBe('negative');
  });

  it('aggregates polarities into the recommendation-facing summary (or null when cold)', () => {
    expect(calibrationAggregate([])).toBeNull();
    const summary = calibrationAggregate([
      { recommendationId: UUID_A, polarity: 'positive' },
      { recommendationId: UUID_B, polarity: 'negative' },
      { recommendationId: UUID_C, polarity: 'positive' },
    ])!;
    expect(summary.candidateId).toBe(''); // filled by the caller
    expect(summary.sampleSize).toBe(3);
    expect(summary.successes).toBe(2);
    expect(summary.failures).toBe(1);
    expect(summary.successRate).toBeCloseTo(2 / 3);
    expect(summary.evidenceRecommendationIds).toEqual([UUID_A, UUID_B, UUID_C]);
  });
});

describe('W135 rankOrganizationCandidates (THE CONTEXTUAL RULE, purely)', () => {
  const candidates: RankableCandidate[] = [
    { candidateId: 'c-spring', slug: 'a-spring-crew', applicability: SPRING_DECLARED },
    { candidateId: 'c-winter', slug: 'b-winter-brigade', applicability: WINTER_DECLARED },
    { candidateId: 'c-agnostic', slug: 'c-generalist', applicability: emptyApplicability() },
  ];

  it('ranks the spring design first under the spring fingerprint and the winter design first under the winter fingerprint — same candidates, different contexts, different best', () => {
    const underSpring = rankOrganizationCandidates(FULL_FINGERPRINT, candidates, new Map());
    expect(underSpring.map((entry) => entry.candidateId)).toEqual(['c-spring', 'c-agnostic', 'c-winter']);
    expect(underSpring[0]!.fitScore).toBe(1);

    const underWinter = rankOrganizationCandidates(WINTER_FINGERPRINT, candidates, new Map());
    expect(underWinter.map((entry) => entry.candidateId)).toEqual(['c-winter', 'c-agnostic', 'c-spring']);
    expect(underWinter[0]!.fitScore).toBe(1);
  });

  it('orders deterministically (rankScore DESC, slug ASC) and reports the agnostic baseline', () => {
    const ranked = rankOrganizationCandidates(FULL_FINGERPRINT, candidates, new Map());
    expect(ranked[1]!.candidateId).toBe('c-agnostic');
    expect(ranked[1]!.fitScore).toBeNull();
    expect(ranked[1]!.rankScore).toBe(NEUTRAL_FIT);
    // Same score, slug ASC tie-break.
    const twins: RankableCandidate[] = [
      { candidateId: 'x', slug: 'beta', applicability: emptyApplicability() },
      { candidateId: 'y', slug: 'alpha', applicability: emptyApplicability() },
    ];
    expect(rankOrganizationCandidates(FULL_FINGERPRINT, twins, new Map()).map((entry) => entry.slug)).toEqual([
      'alpha',
      'beta',
    ]);
  });

  it('lets strong positive outcome evidence overcome a fit deficit, and drags negative evidence below a cold equal-fit peer', () => {
    // c-fit declares 8 of the 9 mechanical axes matching, one misfit
    // (environment): fit 8/9. With 3/3 positive samples the smoothed rate
    // is 4/5 -> factor 1.15 -> 8/9 * 1.15 > 1.0: the outcome-calibrated
    // candidate beats the cold fit-1.0 candidate. EVIDENCE OVERTAKES FIT.
    const almostSpring: CandidateApplicability = {
      ...SPRING_DECLARED,
      requiredEnvironmentFactors: ['desert'], // the one misfit
    };
    const calibrated = rankOrganizationCandidates(
      FULL_FINGERPRINT,
      [
        { candidateId: 'c-almost', slug: 'a-almost-spring', applicability: almostSpring },
        { candidateId: 'c-spring', slug: 'b-spring-crew', applicability: SPRING_DECLARED },
      ],
      new Map([
        [
          'c-almost',
          { candidateId: 'c-almost', sampleSize: 3, successes: 3, failures: 0, successRate: 1, evidenceRecommendationIds: [] },
        ],
      ]),
    );
    expect(calibrated[0]!.candidateId).toBe('c-almost');
    expect(calibrated[0]!.fitScore).toBeCloseTo(8 / 9);
    expect(calibrated[0]!.rankScore).toBeGreaterThan(1);
    expect(calibrated[0]!.rankScore).toBeGreaterThan(calibrated[0]!.fitScore!);
    expect(calibrated[1]!.rankScore).toBe(1); // cold, fit 1.0 — beaten by evidence

    // fit 1.0 with one negative sample: smoothed 1/3 -> factor ~0.9167,
    // so a cold equal-fit peer takes the lead. FAILURE IS RETAINED AND
    // IT COSTS.
    const punished = rankOrganizationCandidates(
      FULL_FINGERPRINT,
      [
        { candidateId: 'c-spring', slug: 'a-spring-crew', applicability: SPRING_DECLARED },
        { candidateId: 'c-cold', slug: 'b-cold-peer', applicability: { ...emptyApplicability(), seasonWindows: ['spring', 'winter'], durationClasses: ['short', 'long'] } },
      ],
      new Map([
        [
          'c-spring',
          { candidateId: 'c-spring', sampleSize: 1, successes: 0, failures: 1, successRate: 0, evidenceRecommendationIds: [] },
        ],
      ]),
    );
    expect(punished[0]!.candidateId).toBe('c-cold'); // the negative evidence lost the lead
    expect(punished[1]!.rankScore).toBeLessThan(punished[1]!.fitScore!);
  });
});
