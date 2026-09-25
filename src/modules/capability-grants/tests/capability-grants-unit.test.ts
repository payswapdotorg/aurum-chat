// Unit tests for the capability-grants module's PURE logic (no database,
// no clock, no network): the deterministic human-readable reason builders
// (reason.ts — the acceptance core's language) and the validation guards
// (validation.ts).
//
// W083 acceptance mapping (pure half):
//   * "action invocation produces human-readable reason and exact
//     requested scope" — buildInvocationDenialReason must name the task,
//     the capability in plain language, what the connection holds and that
//     the write is stopped; deterministically (same inputs → same reason,
//     lock 10: no LLM composes authority language);
//   * buildAuthorityRequestReason must tell the approver why the narrowly
//     scoped authority is necessary, the data categories in play, what is
//     already held, and that approving grants EXACTLY the requested
//     capabilities — nothing more;
//   * §10 language discipline: reasons never contain provider names or
//     technical jargon (oauth, token, scope-key, provider).

import { describe, expect, it } from 'vitest';
import {
  buildAuthorityRequestReason,
  buildInvocationDenialReason,
  grantEventDetail,
  joinAnd,
} from '../reason';
import {
  assertGrantsTenantContext,
  isGrantRequestStatus,
  isGrantStatus,
  isInvocationOutcome,
  isUuid,
  partitionSurface,
  validateCapabilityKeys,
  validateTaskContext,
  validateInvokeCapabilityInput,
  validateRequestAuthorityInput,
} from '../validation';
import { CapabilityGrantsError } from '../errors';
import type { GrantedCapability } from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TASK = { description: 'File signed contracts into the CRM', requestedFor: 'Q3 close' };

const WRITE_CONTACTS = {
  key: 'write.customer-records',
  label: 'Edit customer records',
  dataCategories: ['customer-contacts'],
};
const WRITE_DEALS = {
  key: 'write.sales-pipeline',
  label: 'Create and update deals',
  dataCategories: ['deals'],
};

const grantedContacts: GrantedCapability = {
  key: 'write.customer-records',
  label: 'Edit customer records',
  grantId: '11111111-1111-4111-8111-111111111111',
};

// ---------------------------------------------------------------------------
// joinAnd
// ---------------------------------------------------------------------------

describe('joinAnd', () => {
  it('joins zero, one, two and many items', () => {
    expect(joinAnd([])).toBe('');
    expect(joinAnd(['a'])).toBe('a');
    expect(joinAnd(['a', 'b'])).toBe('a and b');
    expect(joinAnd(['a', 'b', 'c'])).toBe('a, b and c');
  });
});

// ---------------------------------------------------------------------------
// buildAuthorityRequestReason — the ask's human-readable why
// ---------------------------------------------------------------------------

describe('buildAuthorityRequestReason', () => {
  it('names the task, the capabilities and the minimal-grant promise', () => {
    const reason = buildAuthorityRequestReason({
      systemDisplayName: 'Acme CRM',
      taskContext: TASK,
      requested: [WRITE_CONTACTS],
      alreadyGranted: [],
      connectionMode: 'read-only',
    });
    expect(reason).toContain('the task "File signed contracts into the CRM" (for Q3 close)');
    expect(reason).toContain('needs write authority on Acme CRM');
    expect(reason).toContain('"Edit customer records"');
    expect(reason).toContain('Approving this request grants exactly "Edit customer records" — nothing more');
    expect(reason).toContain('it can be revoked at any time');
  });

  it('surfaces the data categories in play', () => {
    const reason = buildAuthorityRequestReason({
      systemDisplayName: 'Acme CRM',
      taskContext: TASK,
      requested: [WRITE_CONTACTS, WRITE_DEALS],
      alreadyGranted: [],
      connectionMode: 'read-only',
    });
    expect(reason).toContain('It would put "customer-contacts" and "deals" in play.');
  });

  it('contrasts what an active grant already covers (never re-asking it)', () => {
    const reason = buildAuthorityRequestReason({
      systemDisplayName: 'Acme CRM',
      taskContext: TASK,
      requested: [WRITE_DEALS],
      alreadyGranted: [grantedContacts],
      connectionMode: 'elevated',
    });
    expect(reason).toContain(
      'The connection already holds write authority for "Edit customer records".',
    );
  });

  it('states the read-only start when nothing is held', () => {
    const reason = buildAuthorityRequestReason({
      systemDisplayName: 'Acme CRM',
      taskContext: TASK,
      requested: [WRITE_CONTACTS],
      alreadyGranted: [],
      connectionMode: 'read-only',
    });
    expect(reason).toContain('The connection starts read-only: it can look, but not change anything.');
  });

  it('is deterministic (same inputs → the same reason)', () => {
    const input = {
      systemDisplayName: 'Acme CRM',
      taskContext: TASK,
      requested: [WRITE_CONTACTS, WRITE_DEALS],
      alreadyGranted: [grantedContacts],
      connectionMode: 'elevated' as const,
    };
    expect(buildAuthorityRequestReason(input)).toBe(buildAuthorityRequestReason(input));
  });

  it('omits the for-part when requestedFor is absent', () => {
    const reason = buildAuthorityRequestReason({
      systemDisplayName: 'Acme CRM',
      taskContext: { description: 'Fix the records' },
      requested: [WRITE_CONTACTS],
      alreadyGranted: [],
      connectionMode: 'read-only',
    });
    expect(reason).toContain('the task "Fix the records" needs');
    expect(reason).not.toContain('(for');
  });

  it('speaks outcomes, never technology (§10: no provider/oauth jargon)', () => {
    const reason = buildAuthorityRequestReason({
      systemDisplayName: 'Acme CRM',
      taskContext: TASK,
      requested: [WRITE_CONTACTS, WRITE_DEALS],
      alreadyGranted: [grantedContacts],
      connectionMode: 'elevated',
    });
    const banned = [/oauth/i, /token/i, /nango/i, /broker/i, /api/i, /webhook/i, /salesforce/i];
    for (const pattern of banned) expect(reason).not.toMatch(pattern);
  });
});

// ---------------------------------------------------------------------------
// buildInvocationDenialReason — the denial's human-readable why
// ---------------------------------------------------------------------------

describe('buildInvocationDenialReason', () => {
  it('names the needed capability, the task, the held state and the stopped write', () => {
    const reason = buildInvocationDenialReason({
      systemDisplayName: 'Acme CRM',
      taskContext: TASK,
      missing: [WRITE_CONTACTS],
      alreadyGranted: [],
      connectionMode: 'read-only',
    });
    expect(reason).toContain('the task "File signed contracts into the CRM" (for Q3 close)');
    expect(reason).toContain('requires write authority on Acme CRM ("Edit customer records")');
    expect(reason).toContain('The connection is read-only: it can look, but not change anything.');
    expect(reason).toContain('The write is stopped.');
    expect(reason).toContain('Ask for exactly this capability — and only it —');
  });

  it('contrasts the narrower grants the connection does hold', () => {
    const reason = buildInvocationDenialReason({
      systemDisplayName: 'Acme CRM',
      taskContext: TASK,
      missing: [WRITE_DEALS],
      alreadyGranted: [grantedContacts],
      connectionMode: 'elevated',
    });
    expect(reason).toContain(
      'The connection holds write authority only for "Edit customer records".',
    );
  });

  it('is deterministic (same inputs → the same reason)', () => {
    const input = {
      systemDisplayName: 'Acme CRM',
      taskContext: TASK,
      missing: [WRITE_CONTACTS],
      alreadyGranted: [grantedContacts],
      connectionMode: 'elevated' as const,
    };
    expect(buildInvocationDenialReason(input)).toBe(buildInvocationDenialReason(input));
  });

  it('speaks outcomes, never technology (§10)', () => {
    const reason = buildInvocationDenialReason({
      systemDisplayName: 'Acme CRM',
      taskContext: TASK,
      missing: [WRITE_CONTACTS],
      alreadyGranted: [],
      connectionMode: 'read-only',
    });
    const banned = [/oauth/i, /token/i, /nango/i, /broker/i, /api/i, /webhook/i, /salesforce/i];
    for (const pattern of banned) expect(reason).not.toMatch(pattern);
  });
});

// ---------------------------------------------------------------------------
// grantEventDetail
// ---------------------------------------------------------------------------

describe('grantEventDetail', () => {
  it('names the granted labels and the authorizing request', () => {
    expect(grantEventDetail({ capabilityLabels: ['Edit customer records'], via: 'req-1' })).toBe(
      'granted "Edit customer records" via request req-1',
    );
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('assertGrantsTenantContext', () => {
  it('accepts a well-formed context and rejects malformed ones', () => {
    expect(() =>
      assertGrantsTenantContext({ tenantId: 't', principalId: 'p', authority: [] }),
    ).not.toThrow();
    expect(() =>
      assertGrantsTenantContext({ tenantId: '', principalId: 'p', authority: [] }),
    ).toThrow(CapabilityGrantsError);
    expect(() =>
      assertGrantsTenantContext({ tenantId: 't', principalId: 'p', authority: 'admin' as unknown as string[] }),
    ).toThrow(CapabilityGrantsError);
  });
});

describe('validateTaskContext', () => {
  it('accepts a task with description and optional requestedFor', () => {
    expect(validateTaskContext(TASK, 'taskContext')).toEqual({
      description: 'File signed contracts into the CRM',
      requestedFor: 'Q3 close',
    });
    expect(validateTaskContext({ description: '  Fix  ' }, 'taskContext')).toEqual({
      description: 'Fix',
      requestedFor: null,
    });
  });

  it('rejects missing, empty, oversized and unknown-keyed task contexts', () => {
    expect(() => validateTaskContext(null, 'taskContext')).toThrow(CapabilityGrantsError);
    expect(() => validateTaskContext({ description: '  ' }, 'taskContext')).toThrow(CapabilityGrantsError);
    expect(() => validateTaskContext({ description: 'x'.repeat(2001) }, 'taskContext')).toThrow(
      CapabilityGrantsError,
    );
    expect(() => validateTaskContext({ description: 'x', why: 'no' }, 'taskContext')).toThrow(
      CapabilityGrantsError,
    );
    expect(() => validateTaskContext({ description: 'x', requestedFor: '' }, 'taskContext')).toThrow(
      CapabilityGrantsError,
    );
  });
});

describe('validateCapabilityKeys', () => {
  it('accepts 1..32 unique keys and rejects the rest', () => {
    expect(validateCapabilityKeys(['write.customer-records'], 'capabilityKeys')).toEqual([
      'write.customer-records',
    ]);
    const thirtyTwo = Array.from({ length: 32 }, (_, i) => `key-${i}`);
    expect(validateCapabilityKeys(thirtyTwo, 'capabilityKeys')).toHaveLength(32);
    const thirtyThree = Array.from({ length: 33 }, (_, i) => `key-${i}`);
    expect(() => validateCapabilityKeys(thirtyThree, 'capabilityKeys')).toThrow(CapabilityGrantsError);
    expect(() => validateCapabilityKeys([], 'capabilityKeys')).toThrow(CapabilityGrantsError);
    expect(() => validateCapabilityKeys(['a', 'a'], 'capabilityKeys')).toThrow(CapabilityGrantsError);
    expect(() => validateCapabilityKeys([''], 'capabilityKeys')).toThrow(CapabilityGrantsError);
    expect(() => validateCapabilityKeys('write.x' as unknown as string[], 'capabilityKeys')).toThrow(
      CapabilityGrantsError,
    );
  });
});

describe('validateInvokeCapabilityInput / validateRequestAuthorityInput', () => {
  const UUID = '12345678-1234-4124-8124-123456789012';

  it('validates a well-formed invocation input and rejects unknown keys', () => {
    expect(
      validateInvokeCapabilityInput({
        connectionId: UUID,
        capabilityKey: 'write.customer-records',
        taskContext: TASK,
      }),
    ).toEqual({ connectionId: UUID, capabilityKey: 'write.customer-records', taskContext: validateTaskContext(TASK, 'x') });
    expect(() =>
      validateInvokeCapabilityInput({
        connectionId: UUID,
        capabilityKey: 'write.customer-records',
        taskContext: TASK,
        grantId: UUID,
      } as Parameters<typeof validateInvokeCapabilityInput>[0]),
    ).toThrow(CapabilityGrantsError);
    expect(() =>
      validateInvokeCapabilityInput({ connectionId: 'nope', capabilityKey: 'k', taskContext: TASK }),
    ).toThrow(CapabilityGrantsError);
  });

  it('validates a well-formed authority request input', () => {
    expect(
      validateRequestAuthorityInput({
        connectionId: UUID,
        capabilityKeys: ['write.customer-records', 'read.customer-records'],
        taskContext: TASK,
      }),
    ).toEqual({
      connectionId: UUID,
      capabilityKeys: ['write.customer-records', 'read.customer-records'],
      taskContext: validateTaskContext(TASK, 'x'),
    });
  });
});

describe('vocabulary guards', () => {
  it('guards every status/outcome vocabulary', () => {
    expect(isGrantRequestStatus('pending_approval')).toBe(true);
    expect(isGrantRequestStatus('approved')).toBe(true);
    expect(isGrantRequestStatus('nonsense')).toBe(false);
    expect(isGrantStatus('active')).toBe(true);
    expect(isGrantStatus('revoked')).toBe(true);
    expect(isGrantStatus('missing')).toBe(false);
    expect(isInvocationOutcome('allowed')).toBe(true);
    expect(isInvocationOutcome('denied')).toBe(true);
    expect(isInvocationOutcome('maybe')).toBe(false);
  });

  it('guards uuids', () => {
    expect(isUuid('12345678-1234-4124-8124-123456789012')).toBe(true);
    expect(isUuid('nope')).toBe(false);
  });
});

describe('partitionSurface', () => {
  it('splits a surface into read and write keys', () => {
    const surface = [
      { key: 'read.customer-records', mode: 'read' as const },
      { key: 'write.customer-records', mode: 'write' as const },
      { key: 'write.sales-pipeline', mode: 'write' as const },
    ];
    expect(partitionSurface(surface)).toEqual({
      read: ['read.customer-records'],
      write: ['write.customer-records', 'write.sales-pipeline'],
    });
  });
});
