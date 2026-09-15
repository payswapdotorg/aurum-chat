// Unit tests for the actions module's pure logic (no database): the
// authority-level / action-kind / outcome vocabularies, the built-in
// default matrix, the deterministic gate evaluation
// (evaluateAuthorityMatrix) and its outcome→status/decision mappings,
// the approver-claim rules, the TenantContext shape, and the full
// validation/normalization surface of policy inputs, action inputs,
// approval decisions and queries. Storage-level guarantees (immutable
// request history, append-only decisions, tenant scoping, trigger
// enforcement) are covered by actions-service.test.ts.

import { describe, expect, it } from 'vitest';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  ACTION_REQUEST_STATUSES,
  ACTIONS_AUTHORITY_ADMINISTER,
  ACTIONS_AUTHORITY_APPROVE,
  AUTHORITY_LEVELS,
  AUTHORITY_OUTCOMES,
  CANONICAL_ACTION_KINDS,
  builtInDefaultMatrix,
  canAdminister,
  canApprove,
  evaluateAuthorityMatrix,
  isActionRequestStatus,
  isAuthorityLevel,
  isAuthorityOutcome,
  isCanonicalActionKind,
  kindScopedApproveClaim,
  policyDecisionForOutcome,
  statusForOutcome,
  type AuthorityLevelsPolicy,
  type AuthorityLevel,
} from '../matrix';
import { ActionsError } from '../errors';
import {
  assertActionsTenantContext,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_LIST_LIMIT,
  MAX_NOTE_CHARS,
  MAX_PAYLOAD_BYTES,
  validateAuthorizeActionInput,
  validateDecideApprovalInput,
  validateEvaluateAuthorityQuery,
  validateGetActionRequestQuery,
  validateListActionRequestsQuery,
  validateListApprovalDecisionsQuery,
  validateListPoliciesQuery,
  validatePolicySubjectQuery,
  validateSetAuthorityPolicyInput,
} from '../validation';
import type {
  AuthorizeActionInput,
  DecideApprovalInput,
  SetAuthorityPolicyInput,
} from '../types';

const UUID_A = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const UUID_B = '1c3a9f4b-2d5c-4e9b-8a4f-8b3c7d6e5f9a';

function expectCode(code: string, fn: () => void): void {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(ActionsError);
    expect((error as ActionsError).code).toBe(code);
  }
}

function context(overrides: Partial<TenantContext> = {}): TenantContext {
  return { tenantId: newId(), principalId: newId(), authority: [], ...overrides };
}

/** A minimal, fully valid policy input. */
function validPolicy(): SetAuthorityPolicyInput {
  return { actionKind: 'source-access', approvalLevels: ['EXECUTE'] };
}

/** A minimal, fully valid authorize input. */
function validAction(): AuthorizeActionInput {
  return {
    actionKind: 'employee-messaging',
    authorityLevel: 'ASK',
    payload: { question: 'who owns the supplier risk list?' },
  };
}

// ---------------------------------------------------------------------------
// Vocabularies (ARCHITECTURE.md §20)
// ---------------------------------------------------------------------------

describe('vocabularies (§20: OBSERVE/ANALYZE/RECOMMEND/ASK/PROPOSE/EXECUTE)', () => {
  it('declares the six authority levels, ordered, without duplicates', () => {
    expect([...AUTHORITY_LEVELS]).toEqual([
      'OBSERVE',
      'ANALYZE',
      'RECOMMEND',
      'ASK',
      'PROPOSE',
      'EXECUTE',
    ]);
    expect(new Set(AUTHORITY_LEVELS).size).toBe(AUTHORITY_LEVELS.length);
  });

  it('anchors the canonical action kinds of the §20 enumeration', () => {
    expect([...CANONICAL_ACTION_KINDS]).toEqual([
      'employee-messaging',
      'source-access',
      'data-export',
      'agent-recruitment',
      'agent-termination',
      'extension-deployment',
      'external-communication',
    ]);
    expect(new Set(CANONICAL_ACTION_KINDS).size).toBe(CANONICAL_ACTION_KINDS.length);
  });

  it('guards recognize members and reject everything else', () => {
    for (const level of AUTHORITY_LEVELS) expect(isAuthorityLevel(level)).toBe(true);
    for (const kind of CANONICAL_ACTION_KINDS) expect(isCanonicalActionKind(kind)).toBe(true);
    for (const outcome of AUTHORITY_OUTCOMES) expect(isAuthorityOutcome(outcome)).toBe(true);
    for (const status of ACTION_REQUEST_STATUSES) expect(isActionRequestStatus(status)).toBe(true);
    for (const bad of ['', 'Observe', 'observe', 'EXECUTE ', 42, null, undefined]) {
      expect(isAuthorityLevel(bad)).toBe(false);
      expect(isAuthorityOutcome(bad)).toBe(false);
      expect(isActionRequestStatus(bad)).toBe(false);
    }
    expect(isCanonicalActionKind('employee-messaging')).toBe(true);
    expect(isCanonicalActionKind('some-future-kind')).toBe(false); // open namespace
  });
});

// ---------------------------------------------------------------------------
// The built-in default matrix (the deterministic floor)
// ---------------------------------------------------------------------------

describe('builtInDefaultMatrix (the deterministic floor)', () => {
  it('allows the informational/interrogative levels and gates EXECUTE', () => {
    const matrix = builtInDefaultMatrix();
    expect(matrix.approvalLevels).toEqual(['EXECUTE']);
    expect(matrix.forbiddenLevels).toEqual([]);
  });

  it('hands out defensive copies — mutating a returned matrix changes nothing', () => {
    const first = builtInDefaultMatrix();
    first.approvalLevels.push('OBSERVE');
    first.forbiddenLevels.push('ASK');
    const second = builtInDefaultMatrix();
    expect(second.approvalLevels).toEqual(['EXECUTE']);
    expect(second.forbiddenLevels).toEqual([]);
    // and the floor's behavior is unchanged
    expect(evaluateAuthorityMatrix(null, 'OBSERVE')).toBe('allowed');
    expect(evaluateAuthorityMatrix(null, 'EXECUTE')).toBe('approval_required');
  });
});

// ---------------------------------------------------------------------------
// The deterministic gate evaluation (W009 acceptance core)
// ---------------------------------------------------------------------------

describe('evaluateAuthorityMatrix (deterministic gate evaluation)', () => {
  it('falls back to the built-in floor when no policy applies', () => {
    expect(evaluateAuthorityMatrix(null, 'OBSERVE')).toBe('allowed');
    expect(evaluateAuthorityMatrix(null, 'ANALYZE')).toBe('allowed');
    expect(evaluateAuthorityMatrix(null, 'RECOMMEND')).toBe('allowed');
    expect(evaluateAuthorityMatrix(null, 'ASK')).toBe('allowed');
    expect(evaluateAuthorityMatrix(null, 'PROPOSE')).toBe('allowed');
    expect(evaluateAuthorityMatrix(null, 'EXECUTE')).toBe('approval_required');
  });

  it('evaluates explicit policies: approval-gated, forbidden, allowed', () => {
    const policy: AuthorityLevelsPolicy = {
      approvalLevels: ['ASK', 'PROPOSE'],
      forbiddenLevels: ['EXECUTE'],
    };
    expect(evaluateAuthorityMatrix(policy, 'OBSERVE')).toBe('allowed');
    expect(evaluateAuthorityMatrix(policy, 'ANALYZE')).toBe('allowed');
    expect(evaluateAuthorityMatrix(policy, 'RECOMMEND')).toBe('allowed');
    expect(evaluateAuthorityMatrix(policy, 'ASK')).toBe('approval_required');
    expect(evaluateAuthorityMatrix(policy, 'PROPOSE')).toBe('approval_required');
    expect(evaluateAuthorityMatrix(policy, 'EXECUTE')).toBe('forbidden');
  });

  it('treats empty level lists as everything-allowed', () => {
    const open: AuthorityLevelsPolicy = { approvalLevels: [], forbiddenLevels: [] };
    for (const level of AUTHORITY_LEVELS) {
      expect(evaluateAuthorityMatrix(open, level)).toBe('allowed');
    }
  });

  it('is total: forbidden wins over approval (overlap defense stays deterministic)', () => {
    // Overlapping data is rejected by validation and by the policy
    // trigger, but the evaluator stays deterministic regardless: the
    // stricter rule wins.
    const overlapping = {
      approvalLevels: ['EXECUTE'] as AuthorityLevel[],
      forbiddenLevels: ['EXECUTE'] as AuthorityLevel[],
    };
    expect(evaluateAuthorityMatrix(overlapping, 'EXECUTE')).toBe('forbidden');
  });

  it('is deterministic: identical inputs always yield identical outputs', () => {
    const policies: (AuthorityLevelsPolicy | null)[] = [
      null,
      { approvalLevels: [], forbiddenLevels: [] },
      { approvalLevels: ['EXECUTE'], forbiddenLevels: [] },
      { approvalLevels: ['ASK', 'EXECUTE'], forbiddenLevels: ['PROPOSE'] },
      { approvalLevels: ['OBSERVE'], forbiddenLevels: ['ANALYZE', 'RECOMMEND', 'EXECUTE'] },
    ];
    for (const policy of policies) {
      for (const level of AUTHORITY_LEVELS) {
        const first = evaluateAuthorityMatrix(policy, level);
        for (let i = 0; i < 5; i += 1) {
          expect(evaluateAuthorityMatrix(policy, level)).toBe(first);
        }
      }
    }
  });

  it('maps outcomes onto request statuses and policy decisions', () => {
    expect(statusForOutcome('allowed')).toBe('approved');
    expect(statusForOutcome('approval_required')).toBe('pending');
    expect(statusForOutcome('forbidden')).toBe('rejected');
    expect(policyDecisionForOutcome('allowed')).toBe('approve');
    expect(policyDecisionForOutcome('forbidden')).toBe('reject');
    expect(policyDecisionForOutcome('approval_required')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Approver claims
// ---------------------------------------------------------------------------

describe('authority claims (administer / approve)', () => {
  it('reserves the administer claim for matrix management', () => {
    expect(ACTIONS_AUTHORITY_ADMINISTER).toBe('actions:administer');
    expect(canAdminister([])).toBe(false);
    expect(canAdminister(['actions:approve'])).toBe(false);
    expect(canAdminister([ACTIONS_AUTHORITY_ADMINISTER])).toBe(true);
    expect(canAdminister(['identity:attest', ACTIONS_AUTHORITY_ADMINISTER])).toBe(true);
  });

  it('reserves the global approve claim for decisions of any kind', () => {
    expect(ACTIONS_AUTHORITY_APPROVE).toBe('actions:approve');
    for (const kind of CANONICAL_ACTION_KINDS) {
      expect(canApprove([ACTIONS_AUTHORITY_APPROVE], kind)).toBe(true);
    }
    expect(canApprove([], 'agent-recruitment')).toBe(false);
    expect(canApprove(['actions:administer'], 'agent-recruitment')).toBe(false);
  });

  it('scopes kind-scoped approve claims to exactly their kind', () => {
    expect(kindScopedApproveClaim('agent-recruitment')).toBe('actions:approve:agent-recruitment');
    expect(canApprove([kindScopedApproveClaim('agent-recruitment')], 'agent-recruitment')).toBe(true);
    expect(canApprove([kindScopedApproveClaim('agent-recruitment')], 'agent-termination')).toBe(false);
    expect(canApprove([kindScopedApproveClaim('agent-recruitment'), ACTIONS_AUTHORITY_APPROVE], 'data-export')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TenantContext shape
// ---------------------------------------------------------------------------

describe('assertActionsTenantContext', () => {
  it('accepts a well-formed context (claims validated as strings)', () => {
    expect(() => assertActionsTenantContext(context())).not.toThrow();
    expect(() => assertActionsTenantContext(context({ authority: ['actions:approve'] }))).not.toThrow();
  });

  it('rejects malformed contexts with invalid_context', () => {
    expectCode('invalid_context', () => assertActionsTenantContext({ tenantId: '', principalId: newId(), authority: [] }));
    expectCode('invalid_context', () => assertActionsTenantContext({ tenantId: newId(), principalId: '  ', authority: [] }));
    expectCode('invalid_context', () => assertActionsTenantContext({ tenantId: newId(), principalId: newId(), authority: 'actions:approve' as never }));
    expectCode('invalid_context', () =>
      assertActionsTenantContext({ tenantId: newId(), principalId: newId(), authority: ['ok', 42] as never }),
    );
  });
});

// ---------------------------------------------------------------------------
// Policy input validation
// ---------------------------------------------------------------------------

describe('validateSetAuthorityPolicyInput', () => {
  it('accepts and normalizes a minimal default policy (null kind)', () => {
    const valid = validateSetAuthorityPolicyInput({ approvalLevels: ['EXECUTE'] });
    expect(valid).toEqual({
      actionKind: null,
      approvalLevels: ['EXECUTE'],
      forbiddenLevels: [],
      note: null,
    });
  });

  it('normalizes level lists: deduplicated and canonical order', () => {
    const valid = validateSetAuthorityPolicyInput({
      actionKind: 'source-access',
      approvalLevels: ['EXECUTE', 'ASK', 'EXECUTE', 'PROPOSE', 'ASK'],
      forbiddenLevels: [],
    });
    expect(valid.approvalLevels).toEqual(['ASK', 'PROPOSE', 'EXECUTE']);
  });

  it('rejects unknown levels, non-arrays and malformed kinds', () => {
    expectCode('invalid_policy_input', () =>
      validateSetAuthorityPolicyInput({ approvalLevels: ['OBSERVE', 'execute' as AuthorityLevel] }),
    );
    expectCode('invalid_policy_input', () =>
      validateSetAuthorityPolicyInput({ approvalLevels: 'EXECUTE' as never }),
    );
    expectCode('invalid_policy_input', () =>
      validateSetAuthorityPolicyInput({ actionKind: 'has space' }),
    );
    expectCode('invalid_policy_input', () => validateSetAuthorityPolicyInput({ actionKind: '-leading' }));
  });

  it('rejects a level that is both approval-gated and forbidden', () => {
    expectCode('invalid_policy_input', () =>
      validateSetAuthorityPolicyInput({ approvalLevels: ['EXECUTE'], forbiddenLevels: ['EXECUTE'] }),
    );
  });

  it('rejects unknown fields (no smuggling of id/tenantId/timestamps)', () => {
    for (const smuggled of ['id', 'tenantId', 'createdAt', 'updatedAt']) {
      expectCode('invalid_policy_input', () =>
        validateSetAuthorityPolicyInput({ ...validPolicy(), [smuggled]: newId() } as never),
      );
    }
  });

  it('bounds the note', () => {
    expectCode('invalid_policy_input', () =>
      validateSetAuthorityPolicyInput({ ...validPolicy(), note: 'x'.repeat(MAX_NOTE_CHARS + 1) }),
    );
    expect(validateSetAuthorityPolicyInput({ ...validPolicy(), note: '  tight enough  ' }).note).toBe('tight enough');
  });
});

// ---------------------------------------------------------------------------
// Action input validation (the gate)
// ---------------------------------------------------------------------------

describe('validateAuthorizeActionInput', () => {
  it('accepts a minimal action and normalizes optionals to null', () => {
    const valid = validateAuthorizeActionInput(validAction());
    expect(valid.actionKind).toBe('employee-messaging');
    expect(valid.authorityLevel).toBe('ASK');
    expect(valid.payload).toEqual({ question: 'who owns the supplier risk list?' });
    expect(valid.justification).toBeNull();
    expect(valid.idempotencyKey).toBeNull();
  });

  it('rejects caller-smuggled identity/lifecycle/evaluation fields', () => {
    for (const smuggled of [
      'id',
      'tenantId',
      'status',
      'requestedBy',
      'requestedAt',
      'decidedAt',
      'evaluation',
      'outcome',
    ]) {
      expectCode('invalid_action_input', () =>
        validateAuthorizeActionInput({ ...validAction(), [smuggled]: newId() } as never),
      );
    }
  });

  it('rejects malformed kinds and non-level authority levels', () => {
    expectCode('invalid_action_input', () =>
      validateAuthorizeActionInput({ ...validAction(), actionKind: 'not a kind!' }),
    );
    expectCode('invalid_action_input', () =>
      validateAuthorizeActionInput({ ...validAction(), authorityLevel: 'DO' as never }),
    );
  });

  it('requires a non-null plain-JSON payload', () => {
    expectCode('invalid_action_input', () => validateAuthorizeActionInput({ ...validAction(), payload: null }));
    expectCode('invalid_action_input', () => validateAuthorizeActionInput({ ...validAction(), payload: undefined }));
    expectCode('invalid_action_input', () =>
      validateAuthorizeActionInput({ ...validAction(), payload: new Date() }),
    );
    expectCode('invalid_action_input', () =>
      validateAuthorizeActionInput({ ...validAction(), payload: { when: undefined } }),
    );
    expectCode('invalid_action_input', () =>
      validateAuthorizeActionInput({ ...validAction(), payload: { big: 10n } }),
    );
    expectCode('invalid_action_input', () =>
      validateAuthorizeActionInput({ ...validAction(), payload: { inf: Number.POSITIVE_INFINITY } }),
    );
    // deep plain JSON survives
    expect(() =>
      validateAuthorizeActionInput({
        ...validAction(),
        payload: { nested: { list: [1, 'two', false, null], depth: { ok: true } } },
      }),
    ).not.toThrow();
  });

  it('bounds the payload size (large artifacts belong in object storage)', () => {
    const oversized = { blob: 'x'.repeat(MAX_PAYLOAD_BYTES) };
    expectCode('invalid_action_input', () =>
      validateAuthorizeActionInput({ ...validAction(), payload: oversized }),
    );
  });

  it('validates the idempotency key shape and the justification length', () => {
    expectCode('invalid_action_input', () =>
      validateAuthorizeActionInput({ ...validAction(), idempotencyKey: 'not a key!' }),
    );
    expectCode('invalid_action_input', () =>
      validateAuthorizeActionInput({ ...validAction(), idempotencyKey: `k${'-'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH)}` }),
    );
    expect(() =>
      validateAuthorizeActionInput({ ...validAction(), idempotencyKey: 'cognition:W013:retry-17' }),
    ).not.toThrow();
    expectCode('invalid_action_input', () =>
      validateAuthorizeActionInput({ ...validAction(), justification: 'x'.repeat(513) }),
    );
  });
});

// ---------------------------------------------------------------------------
// Decision input validation
// ---------------------------------------------------------------------------

describe('validateDecideApprovalInput', () => {
  it('accepts approve/reject with an optional note', () => {
    expect(validateDecideApprovalInput({ requestId: UUID_A, decision: 'approve' })).toEqual({
      requestId: UUID_A,
      decision: 'approve',
      note: null,
    });
    expect(
      validateDecideApprovalInput({ requestId: UUID_B, decision: 'reject', note: '  too risky  ' }).note,
    ).toBe('too risky');
  });

  it('rejects any other decision value, malformed ids and unknown fields', () => {
    const input: DecideApprovalInput = { requestId: UUID_A, decision: 'approve' };
    expectCode('invalid_decision', () =>
      validateDecideApprovalInput({ ...input, decision: 'maybe' as never }),
    );
    expectCode('invalid_decision', () => validateDecideApprovalInput({ ...input, requestId: 'not-a-uuid' }));
    expectCode('invalid_decision', () =>
      validateDecideApprovalInput({ ...input, decidedBy: 'principal' } as never),
    );
  });
});

// ---------------------------------------------------------------------------
// Query validation
// ---------------------------------------------------------------------------

describe('query validation', () => {
  it('policy subject queries: null kind addresses the default, kinds are canonical slugs', () => {
    expect(validatePolicySubjectQuery({}).actionKind).toBeNull();
    expect(validatePolicySubjectQuery({ actionKind: null }).actionKind).toBeNull();
    expect(validatePolicySubjectQuery({ actionKind: 'data-export' }).actionKind).toBe('data-export');
    expectCode('invalid_query', () => validatePolicySubjectQuery({ actionKind: 'bad kind' }));
    expectCode('invalid_query', () => validatePolicySubjectQuery({ extra: 1 } as never));
  });

  it('evaluation queries need a concrete kind and a valid level', () => {
    expect(validateEvaluateAuthorityQuery({ actionKind: 'source-access', authorityLevel: 'OBSERVE' })).toEqual({
      actionKind: 'source-access',
      authorityLevel: 'OBSERVE',
    });
    expectCode('invalid_query', () =>
      validateEvaluateAuthorityQuery({ actionKind: 'source-access', authorityLevel: 'nope' as never }),
    );
    expectCode('invalid_query', () => validateEvaluateAuthorityQuery({ actionKind: 'x!', authorityLevel: 'ASK' }));
  });

  it('list queries bound the limit', () => {
    expect(validateListPoliciesQuery({}).limit).toBe(50);
    expect(validateListPoliciesQuery({ limit: MAX_LIST_LIMIT }).limit).toBe(MAX_LIST_LIMIT);
    expectCode('invalid_query', () => validateListPoliciesQuery({ limit: 0 }));
    expectCode('invalid_query', () => validateListPoliciesQuery({ limit: MAX_LIST_LIMIT + 1 }));
    expectCode('invalid_query', () => validateListPoliciesQuery({ limit: 1.5 }));
  });

  it('request queries: uuid shape, canonical filters, status vocabulary', () => {
    expect(validateGetActionRequestQuery({ requestId: UUID_A }).requestId).toBe(UUID_A);
    expectCode('invalid_query', () => validateGetActionRequestQuery({ requestId: 'nope' }));

    const listValid = validateListActionRequestsQuery({
      actionKind: 'agent-recruitment',
      authorityLevel: 'EXECUTE',
      status: 'pending',
      requestedBy: UUID_B,
      limit: 10,
    });
    expect(listValid).toEqual({
      actionKind: 'agent-recruitment',
      authorityLevel: 'EXECUTE',
      status: 'pending',
      requestedBy: UUID_B,
      limit: 10,
    });
    expectCode('invalid_query', () => validateListActionRequestsQuery({ status: 'decided' as never }));
    expectCode('invalid_query', () => validateListActionRequestsQuery({ requestedBy: '' }));
    expectCode('invalid_query', () => validateListActionRequestsQuery({ unknown: true } as never));

    expect(validateListApprovalDecisionsQuery({ requestId: UUID_A }).requestId).toBe(UUID_A);
    expectCode('invalid_query', () => validateListApprovalDecisionsQuery({ requestId: UUID_A, extra: null } as never));
  });
});
