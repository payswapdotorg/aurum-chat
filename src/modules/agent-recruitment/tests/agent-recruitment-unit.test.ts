// Unit tests for the agent-recruitment module's PURE logic —
// comparison.ts (the comparison vocabulary, the recommendation
// extraction, the deterministic gate→lifecycle routing and the gate
// descriptor) and validation.ts (the input/query guards). No database.

import { describe, expect, it } from 'vitest';
import {
  RECRUITMENT_ALTERNATIVE_KINDS,
  RECRUITMENT_PROPOSAL_STATUSES,
  RECRUITMENT_PROPOSAL_TERMINAL_STATUSES,
  alternativeCompare,
  alternativeKindRank,
  alternativesInCanonicalOrder,
  deciderForOutcome,
  gateDescriptor,
  isRecruitmentAlternativeKind,
  isRecruitmentProposalStatus,
  isTerminalProposalStatus,
  recommendationOf,
  statusForGateOutcome,
} from '../comparison';
import {
  MAX_ALTERNATIVES,
  MAX_JUSTIFICATION_CHARS,
  MIN_ALTERNATIVES,
  validateCreateRecruitmentProposalInput,
  validateGetRecruitmentProposalQuery,
  validateListRecruitmentProposalsQuery,
  validateRequestRecruitmentApprovalInput,
  validateSettleRecruitmentProposalInput,
  validateWithdrawRecruitmentProposalInput,
} from '../validation';
import { assertAgentRecruitmentTenantContext } from '../validation';
import { AgentRecruitmentError } from '../errors';
import type { TenantContext } from '@/infra/tenant';
import type { AgentPermissionScope } from '@/modules/agents/contract';
import type {
  CreateRecruitmentProposalInput,
  RecruitmentAlternative,
  RecruitmentAlternativeInput,
  RecruitmentAlternativeKind,
  RecruitmentProposalStatus,
} from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CAPABILITY_ID = '00000000-0000-4000-8000-0000000000c1';
const PROPOSAL_ID = '00000000-0000-4000-8000-0000000000d1';

function alternativeOf(overrides: Partial<RecruitmentAlternative> = {}): RecruitmentAlternative {
  return {
    id: '00000000-0000-4000-8000-0000000000a1',
    tenantId: '00000000-0000-4000-8000-0000000000e1',
    proposalId: PROPOSAL_ID,
    kind: 'train',
    summary: 'Train Ada on German-language support.',
    note: null,
    estimatedCostMinor: 450000,
    estimatedCostCurrency: 'USD',
    estimatedWeeks: 6,
    expectedLevel: 0.8,
    expectedCapacity: null,
    recommended: false,
    agentPermissions: null,
    impliedAuthorityLevel: null,
    ...overrides,
  };
}

function createInput(
  overrides: Partial<CreateRecruitmentProposalInput> = {},
): CreateRecruitmentProposalInput {
  return {
    title: 'Close the German-language support gap',
    capabilityId: CAPABILITY_ID,
    rationale: 'Support volume in German grew 3x; the gap now delays first response.',
    evidenceObservationIds: ['00000000-0000-4000-8000-0000000000o1'],
    alternatives: [
      {
        kind: 'train',
        summary: 'Train Ada on German-language support.',
        estimatedCostMinor: 450000,
        estimatedWeeks: 6,
        expectedLevel: 0.8,
      },
      {
        kind: 'recruit',
        summary: 'Recruit a German-support agent on the openai-assistants runtime.',
        estimatedCostMinor: 120000,
        estimatedWeeks: 1,
        expectedLevel: 1,
        recommended: true,
        agentPermissions: ['observe', 'analyze', 'recommend'],
      },
    ],
    ...overrides,
  };
}

function expectInvalidInput(fn: () => unknown): void {
  try {
    fn();
    throw new Error('expected AgentRecruitmentError but the call succeeded');
  } catch (error) {
    expect(error).toBeInstanceOf(AgentRecruitmentError);
    expect((error as AgentRecruitmentError).code).toBe('invalid_proposal_input');
  }
}

function expectInvalidQuery(fn: () => unknown): void {
  try {
    fn();
    throw new Error('expected AgentRecruitmentError but the call succeeded');
  } catch (error) {
    expect(error).toBeInstanceOf(AgentRecruitmentError);
    expect((error as AgentRecruitmentError).code).toBe('invalid_query');
  }
}

// ---------------------------------------------------------------------------
// comparison.ts — the vocabulary and the recommendation
// ---------------------------------------------------------------------------

describe('comparison vocabulary', () => {
  it('lists the six acquisition kinds in the work item order', () => {
    expect(RECRUITMENT_ALTERNATIVE_KINDS).toEqual([
      'train',
      'reassign',
      'hire',
      'automate',
      'recruit',
      'install',
    ]);
  });

  it('recognizes exactly the six kinds', () => {
    for (const kind of RECRUITMENT_ALTERNATIVE_KINDS) {
      expect(isRecruitmentAlternativeKind(kind)).toBe(true);
    }
    expect(isRecruitmentAlternativeKind('outsource')).toBe(false);
    expect(isRecruitmentAlternativeKind('recruit-agent-team')).toBe(false);
    expect(isRecruitmentAlternativeKind(42)).toBe(false);
    expect(isRecruitmentAlternativeKind(null)).toBe(false);
  });

  it('ranks kinds in canonical order', () => {
    expect(alternativeKindRank('train')).toBeLessThan(alternativeKindRank('reassign'));
    expect(alternativeKindRank('install')).toBeGreaterThan(alternativeKindRank('recruit'));
  });

  it('sorts alternatives into canonical kind order', () => {
    const sorted = alternativesInCanonicalOrder([
      alternativeOf({ kind: 'install', id: '00000000-0000-4000-8000-0000000000a3' }),
      alternativeOf({ kind: 'train', id: '00000000-0000-4000-8000-0000000000a1' }),
      alternativeOf({ kind: 'recruit', id: '00000000-0000-4000-8000-0000000000a2' }),
    ]);
    expect(sorted.map((alternative) => alternative.kind)).toEqual(['train', 'recruit', 'install']);
    // Deterministic on kind ties by id.
    expect(
      alternativeCompare(
        alternativeOf({ id: '00000000-0000-4000-8000-0000000000b2' }),
        alternativeOf({ id: '00000000-0000-4000-8000-0000000000b1' }),
      ),
    ).toBeGreaterThan(0);
  });

  it('extracts the recommendation, tolerating none and duplicates', () => {
    expect(recommendationOf([])).toBeNull();
    expect(
      recommendationOf([alternativeOf({ recommended: false }), alternativeOf({ recommended: false })]),
    ).toBeNull();
    const recommended = alternativeOf({ kind: 'recruit', recommended: true });
    expect(recommendationOf([alternativeOf(), recommended])).toBe(recommended);
    // Total under (illegal) duplicate recommendations: canonical order wins.
    const first = alternativeOf({ kind: 'train', recommended: true, id: '00000000-0000-4000-8000-0000000000f1' });
    const second = alternativeOf({ kind: 'hire', recommended: true, id: '00000000-0000-4000-8000-0000000000f2' });
    expect(recommendationOf([second, first])).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// comparison.ts — the lifecycle and the gate routing
// ---------------------------------------------------------------------------

describe('lifecycle routing', () => {
  it('lists the five proposal statuses with the terminal partition', () => {
    expect(RECRUITMENT_PROPOSAL_STATUSES).toEqual([
      'proposed',
      'awaiting_approval',
      'approved',
      'rejected',
      'withdrawn',
    ]);
    expect(RECRUITMENT_PROPOSAL_TERMINAL_STATUSES).toEqual(['approved', 'rejected', 'withdrawn']);
    expect(isRecruitmentProposalStatus('proposed')).toBe(true);
    expect(isRecruitmentProposalStatus('draft')).toBe(false);
    expect(isTerminalProposalStatus('approved')).toBe(true);
    expect(isTerminalProposalStatus('awaiting_approval')).toBe(false);
  });

  it('routes every gate outcome onto the lifecycle deterministically', () => {
    expect(statusForGateOutcome('allowed')).toBe('approved');
    expect(statusForGateOutcome('approval_required')).toBe('awaiting_approval');
    expect(statusForGateOutcome('forbidden')).toBe('rejected');
  });

  it('derives the decider from the frozen outcome', () => {
    expect(deciderForOutcome('allowed')).toBe('policy');
    expect(deciderForOutcome('forbidden')).toBe('policy');
    expect(deciderForOutcome('approval_required')).toBe('principal');
  });
});

// ---------------------------------------------------------------------------
// comparison.ts — the gate descriptor
// ---------------------------------------------------------------------------

describe('gateDescriptor', () => {
  it('carries what an approver needs, bounded and plain', () => {
    const descriptor = gateDescriptor({
      proposalId: PROPOSAL_ID,
      title: 'Close the German-language support gap',
      capabilityId: CAPABILITY_ID,
      capabilityName: 'German-language support',
      gapStatus: 'level_shortfall',
      alternativeKinds: ['train', 'recruit'],
      recommendation: {
        kind: 'recruit',
        summary: 'Recruit a German-support agent.',
        estimatedCostMinor: 120000,
        estimatedCostCurrency: 'USD',
        estimatedWeeks: 1,
      },
    });
    expect(descriptor).toEqual({
      subject: 'agent-recruitment-proposal',
      proposalId: PROPOSAL_ID,
      title: 'Close the German-language support gap',
      capabilityId: CAPABILITY_ID,
      capabilityName: 'German-language support',
      gapStatus: 'level_shortfall',
      alternativeKinds: ['train', 'recruit'],
      recommended: {
        kind: 'recruit',
        summary: 'Recruit a German-support agent.',
        estimatedCostMinor: 120000,
        estimatedCostCurrency: 'USD',
        estimatedWeeks: 1,
      },
    });
    // Serializable plain JSON (the actions payload discipline).
    expect(() => JSON.stringify(descriptor)).not.toThrow();
  });

  it('represents an undecided comparison with a null recommendation', () => {
    const descriptor = gateDescriptor({
      proposalId: PROPOSAL_ID,
      title: 'T',
      capabilityId: CAPABILITY_ID,
      capabilityName: 'C',
      gapStatus: null,
      alternativeKinds: ['train', 'hire'],
      recommendation: null,
    });
    expect(descriptor.recommended).toBeNull();
    expect(descriptor.gapStatus).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validation.ts — the context guard
// ---------------------------------------------------------------------------

describe('context guard', () => {
  it('accepts a well-formed TenantContext and rejects the rest', () => {
    expect(() =>
      assertAgentRecruitmentTenantContext({
        tenantId: 't1',
        principalId: 'p1',
        authority: [],
      }),
    ).not.toThrow();
    expect(() => assertAgentRecruitmentTenantContext(null as unknown as TenantContext)).toThrow(
      AgentRecruitmentError,
    );
    expect(() =>
      assertAgentRecruitmentTenantContext({ tenantId: '', principalId: 'p1', authority: [] }),
    ).toThrow(AgentRecruitmentError);
    expect(() =>
      assertAgentRecruitmentTenantContext({
        tenantId: 't1',
        principalId: 'p1',
        authority: 'none' as unknown as [],
      }),
    ).toThrow(AgentRecruitmentError);
  });
});

// ---------------------------------------------------------------------------
// validation.ts — proposal creation (the comparison rules)
// ---------------------------------------------------------------------------

describe('create input validation', () => {
  it('normalizes a full, well-formed comparison', () => {
    const valid = validateCreateRecruitmentProposalInput(createInput());
    expect(valid.title).toBe('Close the German-language support gap');
    expect(valid.capabilityId).toBe(CAPABILITY_ID);
    expect(valid.evidenceObservationIds).toHaveLength(1);
    expect(valid.alternatives).toHaveLength(2);
    const recruit = valid.alternatives.find((alternative) => alternative.kind === 'recruit');
    expect(recruit?.estimatedCostCurrency).toBe('USD'); // defaulted
    expect(recruit?.agentPermissions).toEqual(['observe', 'analyze', 'recommend']); // canonical order
    expect(recruit?.recommended).toBe(true);
    const train = valid.alternatives.find((alternative) => alternative.kind === 'train');
    expect(train?.recommended).toBe(false); // defaulted
    expect(train?.agentPermissions).toBeNull();
  });

  it('rejects unknown fields, bad shapes and bad ids', () => {
    expectInvalidInput(() =>
      validateCreateRecruitmentProposalInput({ ...createInput(), extra: 1 } as never),
    );
    expectInvalidInput(() => validateCreateRecruitmentProposalInput(null as never));
    expectInvalidInput(() =>
      validateCreateRecruitmentProposalInput({ ...createInput(), capabilityId: 'not-a-uuid' }),
    );
    expectInvalidInput(() => validateCreateRecruitmentProposalInput({ ...createInput(), title: '' }));
    expectInvalidInput(() =>
      validateCreateRecruitmentProposalInput({ ...createInput(), title: 'x'.repeat(201) }),
    );
    expectInvalidInput(() => validateCreateRecruitmentProposalInput({ ...createInput(), rationale: '' }));
  });

  it('bounds the evidence list', () => {
    const ids = Array.from({ length: 33 }, (_, index) => `obs-${index}`);
    expectInvalidInput(() =>
      validateCreateRecruitmentProposalInput({ ...createInput(), evidenceObservationIds: ids }),
    );
    expectInvalidInput(() =>
      validateCreateRecruitmentProposalInput({
        ...createInput(),
        evidenceObservationIds: ['x'.repeat(201)],
      }),
    );
    expect(() =>
      validateCreateRecruitmentProposalInput({
        ...createInput(),
        evidenceObservationIds: undefined,
      }),
    ).not.toThrow();
  });

  it('requires a comparison: 2..6 alternatives with distinct kinds', () => {
    const one = [createInput().alternatives[0]!];
    expectInvalidInput(() =>
      validateCreateRecruitmentProposalInput({ ...createInput(), alternatives: one }),
    );
    const seven: RecruitmentAlternativeInput[] = [
      ...createInput().alternatives,
      { kind: 'reassign', summary: 'r' },
      { kind: 'hire', summary: 'h' },
      { kind: 'automate', summary: 'a' },
      { kind: 'install', summary: 'i' },
      { kind: 'train', summary: 't2' },
    ];
    expect(seven).toHaveLength(7);
    expectInvalidInput(() =>
      validateCreateRecruitmentProposalInput({ ...createInput(), alternatives: seven }),
    );
    expectInvalidInput(() =>
      validateCreateRecruitmentProposalInput({
        ...createInput(),
        alternatives: [createInput().alternatives[0]!, { ...createInput().alternatives[0]!, summary: 'again' }],
      }),
    );
    expectInvalidInput(() =>
      validateCreateRecruitmentProposalInput({ ...createInput(), alternatives: 'nope' as never }),
    );
    expect(() =>
      validateCreateRecruitmentProposalInput({
        ...createInput(),
        alternatives: [...createInput().alternatives, { kind: 'hire', summary: 'Hire a fluent speaker.' }],
      }),
    ).not.toThrow();
  });

  it('allows at most one recommendation', () => {
    expectInvalidInput(() =>
      validateCreateRecruitmentProposalInput({
        ...createInput(),
        alternatives: [
          { kind: 'train', summary: 't', recommended: true },
          { kind: 'hire', summary: 'h', recommended: true },
        ],
      }),
    );
    expect(() =>
      validateCreateRecruitmentProposalInput({
        ...createInput(),
        alternatives: [
          { kind: 'train', summary: 't' },
          { kind: 'hire', summary: 'h' },
        ],
      }),
    ).not.toThrow();
  });

  it('validates every alternative dimension', () => {
    const withFirst = (overrides: Record<string, unknown>) =>
      validateCreateRecruitmentProposalInput({
        ...createInput(),
        alternatives: [{ kind: 'train', summary: 't', ...overrides }, { kind: 'hire', summary: 'h' }],
      });

    expectInvalidInput(() => withFirst({ kind: 'outsource' }));
    expectInvalidInput(() => withFirst({ summary: '' }));
    expectInvalidInput(() => withFirst({ summary: 'x'.repeat(2001) }));
    expectInvalidInput(() => withFirst({ note: 'x'.repeat(2001) }));
    expectInvalidInput(() => withFirst({ estimatedCostMinor: -1 }));
    expectInvalidInput(() => withFirst({ estimatedCostMinor: 1.5 }));
    expectInvalidInput(() => withFirst({ estimatedCostMinor: 1_000_000_000_000_001 }));
    expectInvalidInput(() => withFirst({ estimatedCostCurrency: 'usd' }));
    expectInvalidInput(() => withFirst({ estimatedCostCurrency: 'USDD' }));
    // A currency without a cost prices nothing.
    expectInvalidInput(() => withFirst({ estimatedCostCurrency: 'EUR' }));
    expectInvalidInput(() => withFirst({ estimatedWeeks: 0 }));
    expectInvalidInput(() => withFirst({ estimatedWeeks: 521 }));
    expectInvalidInput(() => withFirst({ estimatedWeeks: 2.5 }));
    expectInvalidInput(() => withFirst({ expectedLevel: 1.1 }));
    expectInvalidInput(() => withFirst({ expectedLevel: -0.1 }));
    expectInvalidInput(() => withFirst({ expectedCapacity: -1 }));
    expectInvalidInput(() => withFirst({ expectedCapacity: 1_000_000_001 }));
    expectInvalidInput(() => withFirst({ recommended: 'yes' }));
    expectInvalidInput(() => withFirst({ unknownField: true } as never));

    // A cost without a currency defaults to USD.
    const valid = withFirst({ estimatedCostMinor: 500 });
    expect(valid.alternatives[0]?.estimatedCostCurrency).toBe('USD');
  });

  it('confines agent permissions to recruit alternatives and the closed vocabulary', () => {
    expectInvalidInput(() =>
      validateCreateRecruitmentProposalInput({
        ...createInput(),
        alternatives: [
          { kind: 'train', summary: 't', agentPermissions: ['observe'] },
          { kind: 'hire', summary: 'h' },
        ],
      }),
    );
    expectInvalidInput(() =>
      validateCreateRecruitmentProposalInput({
        ...createInput(),
        alternatives: [
          { kind: 'recruit', summary: 'r', agentPermissions: ['fly'] as unknown as AgentPermissionScope[] },
          { kind: 'hire', summary: 'h' },
        ],
      }),
    );
    expectInvalidInput(() =>
      validateCreateRecruitmentProposalInput({
        ...createInput(),
        alternatives: [
          { kind: 'recruit', summary: 'r', agentPermissions: [] },
          { kind: 'hire', summary: 'h' },
        ],
      }),
    );
    // Deduplicated and canonically ordered.
    const valid = validateCreateRecruitmentProposalInput({
      ...createInput(),
      alternatives: [
        { kind: 'recruit', summary: 'r', agentPermissions: ['execute', 'observe', 'analyze', 'observe'] },
        { kind: 'hire', summary: 'h' },
      ],
    });
    expect(valid.alternatives[0]?.agentPermissions).toEqual(['observe', 'analyze', 'execute']);
  });

  it(`enforces the ${MIN_ALTERNATIVES}..${MAX_ALTERNATIVES} bounds as constants`, () => {
    expect(MIN_ALTERNATIVES).toBe(2);
    expect(MAX_ALTERNATIVES).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// validation.ts — approval request, settlement, withdrawal, queries
// ---------------------------------------------------------------------------

describe('operation input validation', () => {
  it('validates the approval request (justification bound mirrors the gate)', () => {
    expect(MAX_JUSTIFICATION_CHARS).toBe(512);
    const valid = validateRequestRecruitmentApprovalInput({ proposalId: PROPOSAL_ID });
    expect(valid.justification).toBeNull();
    expect(
      validateRequestRecruitmentApprovalInput({
        proposalId: PROPOSAL_ID,
        justification: '  cheapest and fastest  ',
      }).justification,
    ).toBe('cheapest and fastest');
    expectInvalidInput(() =>
      validateRequestRecruitmentApprovalInput({ proposalId: 'nope' }),
    );
    expectInvalidInput(() =>
      validateRequestRecruitmentApprovalInput({
        proposalId: PROPOSAL_ID,
        justification: 'x'.repeat(513),
      }),
    );
    expectInvalidInput(() =>
      validateRequestRecruitmentApprovalInput({ proposalId: PROPOSAL_ID, extra: 1 } as never),
    );
  });

  it('validates the settle input', () => {
    expect(validateSettleRecruitmentProposalInput({ proposalId: PROPOSAL_ID })).toEqual({
      proposalId: PROPOSAL_ID,
    });
    expectInvalidQuery(() => validateSettleRecruitmentProposalInput({ proposalId: 'x' }));
    expectInvalidQuery(() => validateSettleRecruitmentProposalInput(null as never));
  });

  it('validates the withdrawal (reason required, bounded)', () => {
    expect(
      validateWithdrawRecruitmentProposalInput({ proposalId: PROPOSAL_ID, reason: 'superseded' }).reason,
    ).toBe('superseded');
    expectInvalidInput(() =>
      validateWithdrawRecruitmentProposalInput({ proposalId: PROPOSAL_ID, reason: '' }),
    );
    expectInvalidInput(() =>
      validateWithdrawRecruitmentProposalInput({ proposalId: PROPOSAL_ID, reason: 'x'.repeat(513) }),
    );
  });

  it('validates the queries', () => {
    expect(validateGetRecruitmentProposalQuery({ proposalId: PROPOSAL_ID })).toEqual({
      proposalId: PROPOSAL_ID,
    });
    expectInvalidQuery(() => validateGetRecruitmentProposalQuery({ proposalId: 'x' }));

    expect(validateListRecruitmentProposalsQuery({})).toEqual({
      status: null,
      capabilityId: null,
      recommendedKind: null,
      limit: 50,
    });
    expect(
      validateListRecruitmentProposalsQuery({
        status: 'awaiting_approval',
        capabilityId: CAPABILITY_ID,
        recommendedKind: 'recruit',
        limit: 500,
      }),
    ).toEqual({
      status: 'awaiting_approval',
      capabilityId: CAPABILITY_ID,
      recommendedKind: 'recruit',
      limit: 500,
    });
    expectInvalidQuery(() =>
      validateListRecruitmentProposalsQuery({ status: 'draft' as unknown as RecruitmentProposalStatus }),
    );
    expectInvalidQuery(() =>
      validateListRecruitmentProposalsQuery({
        recommendedKind: 'outsource' as unknown as RecruitmentAlternativeKind,
      }),
    );
    expectInvalidQuery(() => validateListRecruitmentProposalsQuery({ capabilityId: 'x' }));
    expectInvalidQuery(() => validateListRecruitmentProposalsQuery({ limit: 0 }));
    expectInvalidQuery(() => validateListRecruitmentProposalsQuery({ limit: 501 }));
    expectInvalidQuery(() => validateListRecruitmentProposalsQuery({ extra: 1 } as never));
  });
});
