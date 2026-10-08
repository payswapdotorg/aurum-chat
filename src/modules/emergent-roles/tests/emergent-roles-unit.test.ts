// Unit tests for the emergent-roles module's pure layer (validation.ts)
// — no database, no clock, no TenantContext reads. Covers the W138
// input-surface laws:
//
//   * the vocabularies and their guards (statuses, origin kinds, gap
//     source kinds, terminality);
//   * recordGapEvidence input validation — the per-kind source shapes
//     (exactly the right refs, uuids only), observation bounds;
//   * createRoleProposal input validation — slug grammar, the
//     RECURRENCE FLOOR (2..16 DISTINCT citations: one gap is not a
//     recurring gap), demand shapes (distinct capabilities, the W017
//     [0,1] proficiency semantics), alternative shapes (labels
//     distinct, evaluation REQUIRED), the evaluation summary (all
//     three questions required), the provenance rules (org-lab
//     REQUIRES its recommendation; tenant-operator must not carry one);
//   * transition/review/submission/activation input validation;
//   * query validation — limit bounds, vocabulary filters,
//     proposal-scoped list shapes;
//   * the TenantContext assertion.

import { describe, expect, it } from 'vitest';
import {
  GAP_EVIDENCE_SOURCE_KINDS,
  MAX_ALTERNATIVES,
  MAX_DEMAND_LEVEL,
  MAX_EVIDENCE_CITATIONS,
  MIN_EVIDENCE_CITATIONS,
  ROLE_PROPOSAL_ORIGIN_KINDS,
  ROLE_PROPOSAL_STATUSES,
  ROLE_PROPOSAL_TERMINAL_STATUSES,
  assertEmergentRolesTenantContext,
  isGapEvidenceSourceKind,
  isRoleProposalOriginKind,
  isRoleProposalStatus,
  isTerminalRoleProposalStatus,
  isUuid,
  validateCreateRoleProposalInput,
  validateGetGapEvidenceQuery,
  validateGetRoleProposalQuery,
  validateListGapEvidenceQuery,
  validateListRoleProposalsQuery,
  validateProposalScopedListQuery,
  validateRecordGapEvidenceInput,
  validateRecordMarketplaceSubmissionInput,
  validateRecordProposalReviewInput,
  validateRecordRoleActivationInput,
  validateSubmitRoleProposalInput,
  validateWithdrawRoleProposalInput,
} from '../validation';
import { EmergentRolesError } from '../errors';

function expectCode(code: EmergentRolesError['code'], fn: () => unknown): EmergentRolesError {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(EmergentRolesError);
    const typed = error as EmergentRolesError;
    expect(typed.code).toBe(code);
    return typed;
  }
}

const UUID = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
const UUID2 = '12345678-1234-4123-8123-123456789abc';
const UUID3 = 'abcdef01-2345-4c67-8901-234567890abc';
const UUID4 = 'b4567890-1234-4c67-8901-234567890abc';

function validProposalInput(): Record<string, unknown> {
  return {
    slug: 'site-surveyor-role',
    title: 'Site Surveyor',
    origin: { kind: 'tenant-operator' },
    evidenceCitationIds: [UUID, UUID2],
    demands: [
      { capabilityId: UUID3, minimumLevel: 0.8 },
      { capabilityId: UUID4, minimumLevel: 0.5, note: 'supporting demand' },
    ],
    alternatives: [
      {
        label: 'Train an employee',
        description: 'Six-week training program.',
        evaluation: 'Too slow for the recurring spring window.',
      },
      {
        label: 'Hire a human surveyor',
        evaluation: 'Cost exceeds the budget envelope for the gap size.',
      },
    ],
    evaluation: {
      rationale: 'A specialist surveyor role closes the observed gap directly.',
      whyNow: 'The gap recurred across two consecutive seasons.',
      gapRecurrence: 'The site-survey capability missed expectations repeatedly.',
    },
  };
}

function validGapInput(): Record<string, unknown> {
  return {
    capabilityId: UUID,
    source: { kind: 'learning-outcome', outcomeId: UUID2 },
    observation: 'The spring window missed its survey-completion target.',
  };
}

describe('vocabularies and guards', () => {
  it('freezes the status, origin-kind and gap-source-kind vocabularies', () => {
    expect(ROLE_PROPOSAL_STATUSES).toEqual([
      'draft',
      'under_review',
      'approved',
      'rejected',
      'fulfilled',
      'withdrawn',
    ]);
    expect(ROLE_PROPOSAL_TERMINAL_STATUSES).toEqual(['rejected', 'fulfilled', 'withdrawn']);
    expect(ROLE_PROPOSAL_ORIGIN_KINDS).toEqual(['org-lab', 'tenant-operator']);
    expect(GAP_EVIDENCE_SOURCE_KINDS).toEqual([
      'learning-outcome',
      'org-lab-recommendation',
      'execution-run',
    ]);
  });

  it('guards the vocabulary values', () => {
    expect(isRoleProposalStatus('draft')).toBe(true);
    expect(isRoleProposalStatus('active')).toBe(false);
    expect(isTerminalRoleProposalStatus('withdrawn')).toBe(true);
    expect(isTerminalRoleProposalStatus('under_review')).toBe(false);
    expect(isRoleProposalOriginKind('org-lab')).toBe(true);
    expect(isRoleProposalOriginKind('lab')).toBe(false);
    expect(isGapEvidenceSourceKind('learning-outcome')).toBe(true);
    expect(isGapEvidenceSourceKind('company-model')).toBe(false);
    expect(isUuid(UUID)).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
  });

  it('asserts the explicit TenantContext (ADR-0001)', () => {
    expect(() =>
      assertEmergentRolesTenantContext({ tenantId: 't', principalId: 'p', authority: [] }),
    ).not.toThrow();
    expect(() => assertEmergentRolesTenantContext({ tenantId: 't', authority: [] })).toThrow(
      EmergentRolesError,
    );
    expect(() => assertEmergentRolesTenantContext(null)).toThrow(EmergentRolesError);
    expectCode('invalid_context', () =>
      assertEmergentRolesTenantContext({ tenantId: '', principalId: 'p', authority: [] }),
    );
  });
});

describe('recordGapEvidence input validation', () => {
  it('accepts a well-formed gap record and retains the source verbatim', () => {
    const valid = validateRecordGapEvidenceInput(validGapInput());
    expect(valid.capabilityId).toBe(UUID);
    expect(valid.source).toEqual({ kind: 'learning-outcome', outcomeId: UUID2 });
    expect(valid.observation).toBe(
      'The spring window missed its survey-completion target.',
    );
  });

  it('accepts each of the three seam source shapes and rejects mixed refs', () => {
    const recommendation = validateRecordGapEvidenceInput({
      ...validGapInput(),
      source: { kind: 'org-lab-recommendation', recommendationId: UUID2 },
    });
    expect(recommendation.source).toEqual({
      kind: 'org-lab-recommendation',
      recommendationId: UUID2,
    });
    const run = validateRecordGapEvidenceInput({
      ...validGapInput(),
      source: { kind: 'execution-run', planId: UUID2, runId: UUID3 },
    });
    expect(run.source).toEqual({ kind: 'execution-run', planId: UUID2, runId: UUID3 });
    expectCode('invalid_gap_input', () =>
      validateRecordGapEvidenceInput({
        ...validGapInput(),
        source: { kind: 'execution-run', planId: UUID2 },
      }),
    );
    expectCode('invalid_gap_input', () =>
      validateRecordGapEvidenceInput({
        ...validGapInput(),
        source: { kind: 'no-such-seam', outcomeId: UUID2 },
      }),
    );
  });

  it('bounds the observation and requires uuids', () => {
    expectCode('invalid_gap_input', () =>
      validateRecordGapEvidenceInput({ ...validGapInput(), observation: '' }),
    );
    expectCode('invalid_gap_input', () =>
      validateRecordGapEvidenceInput({ ...validGapInput(), observation: 'x'.repeat(2001) }),
    );
    expectCode('invalid_gap_input', () =>
      validateRecordGapEvidenceInput({ ...validGapInput(), capabilityId: 'nope' }),
    );
    expectCode('invalid_gap_input', () =>
      validateRecordGapEvidenceInput({ ...validGapInput(), source: null }),
    );
  });
});

describe('createRoleProposal input validation', () => {
  it('accepts a well-formed proposal and retains the whole case', () => {
    const valid = validateCreateRoleProposalInput(validProposalInput());
    expect(valid.slug).toBe('site-surveyor-role');
    expect(valid.origin).toEqual({ kind: 'tenant-operator', recommendationId: null });
    expect(valid.evidenceCitationIds).toEqual([UUID, UUID2]);
    expect(valid.demands).toHaveLength(2);
    expect(valid.demands[1]!.note).toBe('supporting demand');
    expect(valid.alternatives).toHaveLength(2);
    expect(valid.alternatives[1]!.description).toBeNull();
    expect(valid.evaluation.whyNow).toBe('The gap recurred across two consecutive seasons.');
  });

  it('enforces the slug grammar and the title bounds', () => {
    expectCode('invalid_proposal_input', () =>
      validateCreateRoleProposalInput({ ...validProposalInput(), slug: 'Not_A_Slug' }),
    );
    expectCode('invalid_proposal_input', () =>
      validateCreateRoleProposalInput({ ...validProposalInput(), slug: '' }),
    );
    expectCode('invalid_proposal_input', () =>
      validateCreateRoleProposalInput({ ...validProposalInput(), title: '' }),
    );
    expectCode('invalid_proposal_input', () =>
      validateCreateRoleProposalInput({
        ...validProposalInput(),
        title: 'x'.repeat(201),
      }),
    );
  });

  it('THE RECURRENCE FLOOR: one gap is not a recurring gap', () => {
    expect(MIN_EVIDENCE_CITATIONS).toBe(2);
    expectCode('invalid_proposal_input', () =>
      validateCreateRoleProposalInput({
        ...validProposalInput(),
        evidenceCitationIds: [UUID],
      }),
    );
    expectCode('invalid_proposal_input', () =>
      validateCreateRoleProposalInput({
        ...validProposalInput(),
        evidenceCitationIds: [],
      }),
    );
    const tooMany = Array.from(
      { length: MAX_EVIDENCE_CITATIONS + 1 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expectCode('invalid_proposal_input', () =>
      validateCreateRoleProposalInput({
        ...validProposalInput(),
        evidenceCitationIds: tooMany,
      }),
    );
  });

  it('rejects duplicate citations — one record cannot pose as two gaps', () => {
    expectCode('invalid_proposal_input', () =>
      validateCreateRoleProposalInput({
        ...validProposalInput(),
        evidenceCitationIds: [UUID, UUID],
      }),
    );
  });

  it('requires distinct capabilities across demands, with the W017 level semantics', () => {
    expectCode('invalid_proposal_input', () =>
      validateCreateRoleProposalInput({
        ...validProposalInput(),
        demands: [
          { capabilityId: UUID3, minimumLevel: 0.8 },
          { capabilityId: UUID3, minimumLevel: 0.4 },
        ],
      }),
    );
    expectCode('invalid_proposal_input', () =>
      validateCreateRoleProposalInput({
        ...validProposalInput(),
        demands: [{ capabilityId: UUID3, minimumLevel: 1.5 }],
      }),
    );
    expectCode('invalid_proposal_input', () =>
      validateCreateRoleProposalInput({
        ...validProposalInput(),
        demands: [{ capabilityId: UUID3, minimumLevel: -0.1 }],
      }),
    );
    expect(MAX_DEMAND_LEVEL).toBe(1);
    expectCode('invalid_proposal_input', () =>
      validateCreateRoleProposalInput({ ...validProposalInput(), demands: [] }),
    );
  });

  it('requires every alternative to carry its evaluation, with distinct labels', () => {
    expectCode('invalid_proposal_input', () =>
      validateCreateRoleProposalInput({
        ...validProposalInput(),
        alternatives: [{ label: 'Train an employee' }],
      }),
    );
    expectCode('invalid_proposal_input', () =>
      validateCreateRoleProposalInput({
        ...validProposalInput(),
        alternatives: [
          { label: 'Same', evaluation: 'First.' },
          { label: 'Same', evaluation: 'Second.' },
        ],
      }),
    );
    expectCode('invalid_proposal_input', () =>
      validateCreateRoleProposalInput({ ...validProposalInput(), alternatives: [] }),
    );
    expect(MAX_ALTERNATIVES).toBe(8);
  });

  it('requires the full structured evaluation summary', () => {
    for (const field of ['rationale', 'whyNow', 'gapRecurrence']) {
      expectCode('invalid_proposal_input', () =>
        validateCreateRoleProposalInput({
          ...validProposalInput(),
          evaluation: { ...validProposalInput().evaluation as Record<string, unknown>, [field]: '' },
        }),
      );
    }
    expectCode('invalid_proposal_input', () =>
      validateCreateRoleProposalInput({ ...validProposalInput(), evaluation: null }),
    );
  });

  it('provenance rules: org-lab REQUIRES its recommendation; tenant-operator must not carry one', () => {
    expectCode('invalid_proposal_input', () =>
      validateCreateRoleProposalInput({
        ...validProposalInput(),
        origin: { kind: 'org-lab' },
      }),
    );
    const labValid = validateCreateRoleProposalInput({
      ...validProposalInput(),
      origin: { kind: 'org-lab', recommendationId: UUID },
    });
    expect(labValid.origin).toEqual({ kind: 'org-lab', recommendationId: UUID });
    expectCode('invalid_proposal_input', () =>
      validateCreateRoleProposalInput({
        ...validProposalInput(),
        origin: { kind: 'tenant-operator', recommendationId: UUID },
      }),
    );
  });
});

describe('transition, review, submission and activation input validation', () => {
  it('validates the submit/withdraw transition inputs', () => {
    expect(validateSubmitRoleProposalInput({ proposalId: UUID }).proposalId).toBe(UUID);
    expectCode('invalid_transition_input', () =>
      validateSubmitRoleProposalInput({ proposalId: 'nope' }),
    );
    const withdraw = validateWithdrawRoleProposalInput({ proposalId: UUID, reason: 'Obsolete.' });
    expect(withdraw.reason).toBe('Obsolete.');
    expectCode('invalid_transition_input', () =>
      validateWithdrawRoleProposalInput({ proposalId: UUID, reason: '' }),
    );
    expectCode('invalid_transition_input', () =>
      validateWithdrawRoleProposalInput({ proposalId: UUID, reason: 'x'.repeat(513) }),
    );
  });

  it('validates the review input', () => {
    const review = validateRecordProposalReviewInput({
      proposalId: UUID,
      actionRequestId: UUID2,
    });
    expect(review.actionRequestId).toBe(UUID2);
    expectCode('invalid_review_input', () =>
      validateRecordProposalReviewInput({ proposalId: UUID }),
    );
  });

  it('validates the marketplace submission input', () => {
    const submission = validateRecordMarketplaceSubmissionInput({
      proposalId: UUID,
      packageId: UUID2,
      note: 'Through the governed chain.',
    });
    expect(submission.note).toBe('Through the governed chain.');
    expect(
      validateRecordMarketplaceSubmissionInput({ proposalId: UUID, packageId: UUID2 }).note,
    ).toBeNull();
    expectCode('invalid_submission_input', () =>
      validateRecordMarketplaceSubmissionInput({ proposalId: UUID, packageId: 'nope' }),
    );
  });

  it('validates the activation input', () => {
    const activation = validateRecordRoleActivationInput({
      proposalId: UUID,
      recruitmentProposalId: UUID2,
    });
    expect(activation.recruitmentProposalId).toBe(UUID2);
    expectCode('invalid_activation_input', () =>
      validateRecordRoleActivationInput({ proposalId: UUID, recruitmentProposalId: null }),
    );
  });
});

describe('query validation', () => {
  it('validates the deep-link queries', () => {
    expect(validateGetRoleProposalQuery({ proposalId: UUID }).proposalId).toBe(UUID);
    expectCode('invalid_query', () => validateGetRoleProposalQuery({}));
    expect(validateGetGapEvidenceQuery({ gapEvidenceId: UUID }).gapEvidenceId).toBe(UUID);
    expectCode('invalid_query', () => validateGetGapEvidenceQuery({ gapEvidenceId: 'x' }));
  });

  it('validates the list queries (filters, vocabulary, limit bounds)', () => {
    const proposals = validateListRoleProposalsQuery({
      status: 'approved',
      originKind: 'org-lab',
      limit: 10,
    });
    expect(proposals).toEqual({ status: 'approved', originKind: 'org-lab', limit: 10 });
    expect(validateListRoleProposalsQuery(undefined)).toEqual({
      status: null,
      originKind: null,
      limit: 50,
    });
    expectCode('invalid_query', () =>
      validateListRoleProposalsQuery({ status: 'active' }),
    );
    expectCode('invalid_query', () =>
      validateListRoleProposalsQuery({ originKind: 'lab' }),
    );
    expectCode('invalid_query', () => validateListRoleProposalsQuery({ limit: 0 }));
    expectCode('invalid_query', () => validateListRoleProposalsQuery({ limit: 501 }));

    const gaps = validateListGapEvidenceQuery({
      capabilityId: UUID,
      sourceKind: 'execution-run',
    });
    expect(gaps).toEqual({ capabilityId: UUID, sourceKind: 'execution-run', limit: 50 });
    expectCode('invalid_query', () => validateListGapEvidenceQuery({ sourceKind: 'outcome' }));
    expectCode('invalid_query', () => validateListGapEvidenceQuery({ capabilityId: 'nope' }));
  });

  it('validates the proposal-scoped list queries', () => {
    const scoped = validateProposalScopedListQuery({ proposalId: UUID, limit: 5 });
    expect(scoped).toEqual({ proposalId: UUID, limit: 5 });
    expectCode('invalid_query', () => validateProposalScopedListQuery({ proposalId: 'nope' }));
    expectCode('invalid_query', () =>
      validateProposalScopedListQuery({ proposalId: UUID, limit: -1 }),
    );
  });
});
