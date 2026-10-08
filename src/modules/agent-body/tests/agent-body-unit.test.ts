// Unit tests for the agent-body module's pure logic (no database): the
// frozen vocabularies (body/attachment lifecycles, policy-check outcomes,
// the locally mirrored W132 purpose list), the context guard, and the
// input/query validators — including the honesty laws that make W133's
// acceptance testable in isolation:
//
//   * identity is immutable — an update carrying `role` is refused, and an
//     update carrying nothing at all is refused;
//   * the five §1 policy descriptors are honest plain-JSON-or-null —
//     arrays/scalars rejected, credential-shaped keys rejected at ANY
//     depth, serialized size bounded;
//   * hooks and binding ids are opaque references — raw-credential-looking
//     values refused;
//   * the policy-check payload is a closed shape { outcome, basis,
//     checkedBy, checkedAt } with a strict ISO checkedAt (recorded
//     verbatim, never re-minted);
//   * the recorded ruling: only 'compatible' may activate an attachment.

import { describe, expect, it } from 'vitest';
import { AgentBodyError } from '../errors';
import {
  AGENT_BODY_STATUSES,
  BODY_BINDING_STATUSES,
  DEFAULT_LIST_LIMIT,
  MAX_CAPABILITIES,
  MAX_HOOKS,
  MODEL_BINDING_PURPOSES,
  POLICY_CHECK_OUTCOMES,
  assertAgentBodyTenantContext,
  isAgentBodyStatus,
  isAttachablePolicyOutcome,
  isBodyBindingStatus,
  isModelBindingPurpose,
  isPolicyCheckOutcome,
  isUuid,
  validateAttachModelBindingInput,
  validateCreateAgentBodyInput,
  validateDetachModelBindingInput,
  validateGetActiveBindingQuery,
  validateGetAgentBodyQuery,
  validateGetBodyBindingsQuery,
  validateListAgentBodiesQuery,
  validatePolicyCheckPayload,
  validateUpdateAgentBodyInput,
} from '../validation';

const UUID_A = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const UUID_B = '1c3f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e90';
const INSTANT = '2026-10-06T12:00:00.000Z';

function expectCode(code: string, fn: () => unknown): void {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentBodyError);
    expect((error as AgentBodyError).code).toBe(code);
  }
}

function minimalCreateInput(): Record<string, unknown> {
  return { role: 'ride-agent', label: 'Ride Agent' };
}

function fullCreateInput(): Record<string, unknown> {
  return {
    role: 'ride-agent',
    label: 'Ride Agent',
    description: 'A specialist body',
    communicationBehavior: { tone: 'concise' },
    informationAcquisitionBehavior: { askBeforeSearching: true },
    companyContextAccess: { surfaces: ['support-tickets'], readOnly: true },
    memoryPolicy: { retentionDays: 180 },
    escalationBehavior: { escalateTo: 'human' },
    permittedCapabilities: ['company-query:run', 'goals:read'],
    evidenceHooks: [{ registry: 'observation', ref: UUID_A }],
    learningHooks: [{ registry: 'learning', ref: UUID_B }],
  };
}

function compatibleCheck(): Record<string, unknown> {
  return {
    outcome: 'compatible',
    basis: 'tenant provider policy v3',
    checkedBy: 'system:policy-engine',
    checkedAt: INSTANT,
  };
}

function attachInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bodyId: UUID_A,
    bindingId: 'fabric-binding-opaque-ref',
    purpose: 'cognition',
    policyCheck: compatibleCheck(),
    ...overrides,
  };
}

describe('W133 vocabularies', () => {
  it('exposes the one-way body lifecycle and the one-way attachment lifecycle', () => {
    expect(AGENT_BODY_STATUSES).toEqual(['active', 'retired']);
    expect(BODY_BINDING_STATUSES).toEqual(['active', 'superseded', 'detached']);
    expect(isAgentBodyStatus('active')).toBe(true);
    expect(isAgentBodyStatus('retired')).toBe(true);
    expect(isAgentBodyStatus('revived')).toBe(false);
    expect(isBodyBindingStatus('superseded')).toBe(true);
    expect(isBodyBindingStatus('deleted')).toBe(false);
  });

  it('mirrors the frozen W132 purpose list locally (the contract exports types only)', () => {
    expect(MODEL_BINDING_PURPOSES).toEqual(['cognition', 'conversation', 'analysis', 'background']);
    for (const purpose of MODEL_BINDING_PURPOSES) {
      expect(isModelBindingPurpose(purpose)).toBe(true);
    }
    expect(isModelBindingPurpose('reasoning')).toBe(false);
    expect(isModelBindingPurpose(42)).toBe(false);
  });

  it('exposes the policy-check outcome vocabulary and the attachable ruling', () => {
    expect(POLICY_CHECK_OUTCOMES).toEqual(['compatible', 'incompatible', 'unknown']);
    expect(isPolicyCheckOutcome('compatible')).toBe(true);
    expect(isPolicyCheckOutcome('maybe')).toBe(false);
    // The recorded ruling: ONLY 'compatible' may activate. 'incompatible'
    // refuses outright; 'unknown' is treated identically — an unverified
    // compatibility can never activate.
    expect(isAttachablePolicyOutcome('compatible')).toBe(true);
    expect(isAttachablePolicyOutcome('incompatible')).toBe(false);
    expect(isAttachablePolicyOutcome('unknown')).toBe(false);
  });

  it('guards uuid shapes (malformed ids are not-found upstream)', () => {
    expect(isUuid(UUID_A)).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid(null)).toBe(false);
  });
});

describe('W133 context guard', () => {
  it('asserts the explicit TenantContext (invalid_context on any malformation)', () => {
    expectCode('invalid_context', () => assertAgentBodyTenantContext({ tenantId: '', principalId: UUID_A, authority: [] }));
    expectCode('invalid_context', () => assertAgentBodyTenantContext({ tenantId: UUID_A, principalId: '  ', authority: [] }));
    expectCode('invalid_context', () =>
      assertAgentBodyTenantContext({ tenantId: UUID_A, principalId: UUID_B, authority: 'none' as unknown as string[] }),
    );
    expect(() =>
      assertAgentBodyTenantContext({ tenantId: UUID_A, principalId: UUID_B, authority: [] }),
    ).not.toThrow();
  });
});

describe('validateCreateAgentBodyInput', () => {
  it('normalizes the minimal input: unstated descriptors are honest nulls, no capabilities, no hooks', () => {
    const valid = validateCreateAgentBodyInput(minimalCreateInput());
    expect(valid.role).toBe('ride-agent');
    expect(valid.label).toBe('Ride Agent');
    expect(valid.description).toBeNull();
    expect(valid.communicationBehavior).toBeNull();
    expect(valid.informationAcquisitionBehavior).toBeNull();
    expect(valid.companyContextAccess).toBeNull();
    expect(valid.memoryPolicy).toBeNull();
    expect(valid.escalationBehavior).toBeNull();
    expect(valid.permittedCapabilities).toEqual([]);
    expect(valid.evidenceHooks).toEqual([]);
    expect(valid.learningHooks).toEqual([]);
  });

  it('round-trips the full §1 payload verbatim', () => {
    const valid = validateCreateAgentBodyInput(fullCreateInput());
    expect(valid.communicationBehavior).toEqual({ tone: 'concise' });
    expect(valid.informationAcquisitionBehavior).toEqual({ askBeforeSearching: true });
    expect(valid.companyContextAccess).toEqual({ surfaces: ['support-tickets'], readOnly: true });
    expect(valid.memoryPolicy).toEqual({ retentionDays: 180 });
    expect(valid.escalationBehavior).toEqual({ escalateTo: 'human' });
    expect(valid.permittedCapabilities).toEqual(['company-query:run', 'goals:read']);
    expect(valid.evidenceHooks).toEqual([{ registry: 'observation', ref: UUID_A }]);
    expect(valid.learningHooks).toEqual([{ registry: 'learning', ref: UUID_B }]);
  });

  it('rejects unknown keys and credential-shaped keys at the top level', () => {
    expectCode('invalid_body_input', () =>
      validateCreateAgentBodyInput({ ...minimalCreateInput(), extra: 'nope' }),
    );
    expectCode('invalid_body_input', () =>
      validateCreateAgentBodyInput({ ...minimalCreateInput(), apiKey: 'sk-abcdef' }),
    );
    expectCode('invalid_body_input', () => validateCreateAgentBodyInput('not an object'));
  });

  it('rejects a malformed role (the tenant-unique identity grammar)', () => {
    expectCode('invalid_body_input', () =>
      validateCreateAgentBodyInput({ ...minimalCreateInput(), role: 'Bad Role' }),
    );
    expectCode('invalid_body_input', () =>
      validateCreateAgentBodyInput({ ...minimalCreateInput(), role: '' }),
    );
    expectCode('invalid_body_input', () =>
      validateCreateAgentBodyInput({ ...minimalCreateInput(), role: '-leading-hyphen' }),
    );
  });

  it('rejects non-object policy descriptors — honest plain-JSON-or-null, never arrays or scalars', () => {
    expectCode('invalid_body_input', () =>
      validateCreateAgentBodyInput({ ...minimalCreateInput(), memoryPolicy: ['not', 'an', 'object'] }),
    );
    expectCode('invalid_body_input', () =>
      validateCreateAgentBodyInput({ ...minimalCreateInput(), memoryPolicy: 'strict' }),
    );
    expectCode('invalid_body_input', () =>
      validateCreateAgentBodyInput({ ...minimalCreateInput(), memoryPolicy: 42 }),
    );
    // null IS legal: "not stated".
    expect(
      validateCreateAgentBodyInput({ ...minimalCreateInput(), memoryPolicy: null }).memoryPolicy,
    ).toBeNull();
  });

  it('rejects credential-shaped keys at ANY depth inside a policy descriptor', () => {
    expectCode('invalid_body_input', () =>
      validateCreateAgentBodyInput({
        ...minimalCreateInput(),
        communicationBehavior: { nested: { apiKey: 'leak' } },
      }),
    );
    expectCode('invalid_body_input', () =>
      validateCreateAgentBodyInput({
        ...minimalCreateInput(),
        memoryPolicy: { stages: [{ name: 'recall', secret: 'x' }] },
      }),
    );
  });

  it('bounds the serialized size and nesting depth of a policy descriptor', () => {
    const oversized = { blob: 'x'.repeat(20000) };
    expectCode('invalid_body_input', () =>
      validateCreateAgentBodyInput({ ...minimalCreateInput(), memoryPolicy: oversized }),
    );
    const deep: Record<string, unknown> = {};
    let cursor: Record<string, unknown> = deep;
    for (let i = 0; i < 12; i += 1) {
      cursor['next'] = {};
      cursor = cursor['next'] as Record<string, unknown>;
    }
    expectCode('invalid_body_input', () =>
      validateCreateAgentBodyInput({ ...minimalCreateInput(), memoryPolicy: deep }),
    );
  });

  it('validates permitted capability keys: grammar, size, count, no duplicates', () => {
    expectCode('invalid_body_input', () =>
      validateCreateAgentBodyInput({ ...minimalCreateInput(), permittedCapabilities: ['Not A Key'] }),
    );
    expectCode('invalid_body_input', () =>
      validateCreateAgentBodyInput({ ...minimalCreateInput(), permittedCapabilities: ['company-query:run', 'company-query:run'] }),
    );
    expectCode('invalid_body_input', () =>
      validateCreateAgentBodyInput({
        ...minimalCreateInput(),
        permittedCapabilities: Array.from({ length: MAX_CAPABILITIES + 1 }, (_, i) => `cap-${i}`),
      }),
    );
    // Colons are legal (the capability-key grammar).
    expect(
      validateCreateAgentBodyInput({ ...minimalCreateInput(), permittedCapabilities: ['a:b:c'] })
        .permittedCapabilities,
    ).toEqual(['a:b:c']);
  });

  it('validates hook references: shape, grammar, size, count, duplicates, credential-looking refs', () => {
    expectCode('invalid_body_input', () =>
      validateCreateAgentBodyInput({ ...minimalCreateInput(), evidenceHooks: 'observation' }),
    );
    expectCode('invalid_body_input', () =>
      validateCreateAgentBodyInput({ ...minimalCreateInput(), evidenceHooks: [{ registry: 'obs', ref: UUID_A, extra: 1 }] }),
    );
    expectCode('invalid_body_input', () =>
      validateCreateAgentBodyInput({ ...minimalCreateInput(), evidenceHooks: [{ registry: 'bad registry!', ref: UUID_A }] }),
    );
    expectCode('invalid_body_input', () =>
      validateCreateAgentBodyInput({ ...minimalCreateInput(), evidenceHooks: [{ registry: 'observation', ref: '' }] }),
    );
    expectCode('invalid_body_input', () =>
      validateCreateAgentBodyInput({ ...minimalCreateInput(), evidenceHooks: [{ registry: 'observation', ref: 'sk-abcdefghijklmnopqrstuvwxyz' }] }),
    );
    expectCode('invalid_body_input', () =>
      validateCreateAgentBodyInput({
        ...minimalCreateInput(),
        evidenceHooks: [
          { registry: 'observation', ref: UUID_A },
          { registry: 'observation', ref: UUID_A },
        ],
      }),
    );
    expectCode('invalid_body_input', () =>
      validateCreateAgentBodyInput({
        ...minimalCreateInput(),
        learningHooks: Array.from({ length: MAX_HOOKS + 1 }, (_, i) => ({
          registry: 'observation',
          ref: `ref-${i}`,
        })),
      }),
    );
  });
});

describe('validateUpdateAgentBodyInput', () => {
  it('REFUSES the role key — identity is immutable', () => {
    expectCode('invalid_body_input', () =>
      validateUpdateAgentBodyInput({ bodyId: UUID_A, role: 'renamed', label: 'New label' }),
    );
  });

  it('refuses an update that carries no mutable field at all', () => {
    expectCode('invalid_body_input', () => validateUpdateAgentBodyInput({ bodyId: UUID_A }));
    expectCode('invalid_body_input', () => validateUpdateAgentBodyInput({ bodyId: 'not-a-uuid', label: 'x' }));
  });

  it('keeps partial semantics: undefined fields stay unchanged, null/[] clear', () => {
    const valid = validateUpdateAgentBodyInput({
      bodyId: UUID_A,
      label: 'Revised',
      memoryPolicy: null,
      permittedCapabilities: [],
    });
    expect(valid.bodyId).toBe(UUID_A);
    expect(valid.label).toBe('Revised');
    expect(valid.description).toBeUndefined();
    expect(valid.memoryPolicy).toBeNull();
    expect(valid.permittedCapabilities).toEqual([]);
    expect(valid.communicationBehavior).toBeUndefined();
    expect(valid.evidenceHooks).toBeUndefined();
  });
});

describe('validateListAgentBodiesQuery and the get queries', () => {
  it('defaults the list query (object form) and validates status/limit', () => {
    expect(validateListAgentBodiesQuery(undefined)).toEqual({
      status: null,
      limit: DEFAULT_LIST_LIMIT,
    });
    expect(validateListAgentBodiesQuery({})).toEqual({ status: null, limit: DEFAULT_LIST_LIMIT });
    expect(validateListAgentBodiesQuery({ status: 'active', limit: 5 })).toEqual({
      status: 'active',
      limit: 5,
    });
    expectCode('invalid_query', () => validateListAgentBodiesQuery({ status: 'paused' }));
    expectCode('invalid_query', () => validateListAgentBodiesQuery({ limit: 0 }));
    expectCode('invalid_query', () => validateListAgentBodiesQuery({ limit: 'ten' }));
    expectCode('invalid_query', () => validateListAgentBodiesQuery({ extra: 1 }));
  });

  it('validates the body-scoped get queries', () => {
    expect(validateGetAgentBodyQuery({ bodyId: UUID_A })).toEqual({ bodyId: UUID_A });
    expectCode('invalid_query', () => validateGetAgentBodyQuery({ bodyId: 'nope' }));
    expectCode('invalid_query', () => validateGetAgentBodyQuery({}));

    expect(validateGetActiveBindingQuery({ bodyId: UUID_A, purpose: 'cognition' })).toEqual({
      bodyId: UUID_A,
      purpose: 'cognition',
    });
    expectCode('invalid_query', () =>
      validateGetActiveBindingQuery({ bodyId: UUID_A, purpose: 'reasoning' }),
    );

    expect(
      validateGetBodyBindingsQuery({ bodyId: UUID_A, purpose: 'analysis', status: 'superseded', limit: 10 }),
    ).toEqual({ bodyId: UUID_A, purpose: 'analysis', status: 'superseded', limit: 10 });
    expect(validateGetBodyBindingsQuery({ bodyId: UUID_A })).toEqual({
      bodyId: UUID_A,
      purpose: null,
      status: null,
      limit: DEFAULT_LIST_LIMIT,
    });
    expectCode('invalid_query', () =>
      validateGetBodyBindingsQuery({ bodyId: UUID_A, status: 'deleted' }),
    );
  });
});

describe('validatePolicyCheckPayload', () => {
  it('accepts the closed shape and round-trips it verbatim', () => {
    const valid = validatePolicyCheckPayload(compatibleCheck());
    expect(valid).toEqual({
      outcome: 'compatible',
      basis: 'tenant provider policy v3',
      checkedBy: 'system:policy-engine',
      checkedAt: INSTANT,
    });
  });

  it('rejects a non-object, unknown keys, a bad outcome, and a non-ISO checkedAt', () => {
    expectCode('invalid_binding_input', () => validatePolicyCheckPayload('compatible'));
    expectCode('invalid_binding_input', () =>
      validatePolicyCheckPayload({ ...compatibleCheck(), extra: true }),
    );
    expectCode('invalid_binding_input', () =>
      validatePolicyCheckPayload({ ...compatibleCheck(), outcome: 'maybe' }),
    );
    expectCode('invalid_binding_input', () =>
      validatePolicyCheckPayload({ ...compatibleCheck(), checkedAt: '2026-10-06 12:00' }),
    );
    expectCode('invalid_binding_input', () =>
      validatePolicyCheckPayload({ ...compatibleCheck(), basis: '' }),
    );
    expectCode('invalid_binding_input', () =>
      validatePolicyCheckPayload({ ...compatibleCheck(), checkedBy: '' }),
    );
  });
});

describe('validateAttachModelBindingInput / validateDetachModelBindingInput', () => {
  it('validates the attach input (opaque bindingId, frozen purpose, verbatim policy check)', () => {
    const valid = validateAttachModelBindingInput(attachInput());
    expect(valid.bodyId).toBe(UUID_A);
    expect(valid.bindingId).toBe('fabric-binding-opaque-ref');
    expect(valid.purpose).toBe('cognition');
    expect(valid.policyCheck.outcome).toBe('compatible');
    expectCode('invalid_binding_input', () =>
      validateAttachModelBindingInput(attachInput({ bodyId: 'nope' })),
    );
    expectCode('invalid_binding_input', () =>
      validateAttachModelBindingInput(attachInput({ purpose: 'reasoning' })),
    );
    expectCode('invalid_binding_input', () =>
      validateAttachModelBindingInput(attachInput({ bindingId: 'sk-abcdefghijklmnopqrstuvwxyz' })),
    );
    expectCode('invalid_binding_input', () =>
      validateAttachModelBindingInput(attachInput({ bindingId: '' })),
    );
    expectCode('invalid_binding_input', () => validateAttachModelBindingInput(attachInput({ extra: 1 })));
  });

  it('validates the detach input (a required recorded reason)', () => {
    const valid = validateDetachModelBindingInput({
      bodyId: UUID_A,
      purpose: 'conversation',
      reason: 'tenant paused conversational possession',
    });
    expect(valid.purpose).toBe('conversation');
    expect(valid.reason).toBe('tenant paused conversational possession');
    expectCode('invalid_binding_input', () =>
      validateDetachModelBindingInput({ bodyId: UUID_A, purpose: 'conversation', reason: '' }),
    );
    expectCode('invalid_binding_input', () =>
      validateDetachModelBindingInput({ bodyId: UUID_A, purpose: 'conversation' }),
    );
    expectCode('invalid_binding_input', () =>
      validateDetachModelBindingInput({ bodyId: UUID_A, reason: 'missing purpose' }),
    );
  });
});
