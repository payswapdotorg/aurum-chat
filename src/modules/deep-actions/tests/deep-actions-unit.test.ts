// Unit tests for the deep-actions module's PURE logic (W084): the
// deterministic reconciliation (reconcile.ts — the acceptance's mismatch
// detection and its human-readable language) and the validation guards
// (validation.ts — the plan's frozen shape). No database, no clock, no
// network (IMPLEMENTATION-STACK §7).

import { describe, expect, it } from 'vitest';
import {
  buildMismatchReason,
  buildMismatchUnknownConsequence,
  buildMismatchUnknownQuestion,
  clampDetail,
  describeMismatch,
  joinAnd,
  jsonDeepEqual,
  reconcileOperation,
  verifyReceipt,
} from '../reconcile';
import {
  isDeepActionStatus,
  readCapabilityKeyOf,
  validateCreateDeepActionInput,
  validateListDeepActionsQuery,
} from '../validation';
import { DeepActionsError } from '../errors';

const TASK = { description: 'Close out the Q3 renewal', requestedFor: 'Q3 close' };

function operation(overrides: Record<string, unknown> = {}) {
  return {
    key: 'file-crm',
    connectionId: '0b7b8a44-6707-48c7-93c5-13ab1d5c0f21',
    capabilityKey: 'write.customer-records',
    target: 'cust-1042',
    payload: { stage: 'onboarding-complete' },
    expectation: { stage: 'onboarding-complete' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// jsonDeepEqual
// ---------------------------------------------------------------------------

describe('jsonDeepEqual', () => {
  it('compares primitives and null', () => {
    expect(jsonDeepEqual(1, 1)).toBe(true);
    expect(jsonDeepEqual('a', 'a')).toBe(true);
    expect(jsonDeepEqual(true, true)).toBe(true);
    expect(jsonDeepEqual(null, null)).toBe(true);
    expect(jsonDeepEqual(1, '1')).toBe(false);
    expect(jsonDeepEqual(null, undefined)).toBe(false);
    expect(jsonDeepEqual(0, null)).toBe(false);
  });

  it('compares arrays order-sensitively and objects by key', () => {
    expect(jsonDeepEqual([1, 2], [1, 2])).toBe(true);
    expect(jsonDeepEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonDeepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(jsonDeepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it('compares nested structures', () => {
    expect(
      jsonDeepEqual({ items: [{ id: 1, tags: ['x', 'y'] }] }, { items: [{ tags: ['x', 'y'], id: 1 }] }),
    ).toBe(true);
    expect(
      jsonDeepEqual({ items: [{ id: 1 }] }, { items: [{ id: 2 }] }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reconcileOperation — the acceptance's mismatch detection
// ---------------------------------------------------------------------------

describe('reconcileOperation', () => {
  it('matches when every expectation entry holds (subset semantics)', () => {
    const verdict = reconcileOperation(
      { stage: 'onboarding-complete', score: 82 },
      { stage: 'onboarding-complete', score: 82, owner: 'Dana', extra: { deep: true } },
      { stage: 'onboarding' },
    );
    expect(verdict.matched).toBe(true);
    expect(verdict.mismatches).toEqual([]);
    expect(verdict.stateUnchanged).toBe(false);
  });

  it('detects a changed field with its path, expected and actual values', () => {
    const verdict = reconcileOperation(
      { stage: 'resolved', priority: 'low' },
      { stage: 'open', priority: 'low' },
      { stage: 'open', priority: 'low' },
    );
    expect(verdict.matched).toBe(false);
    expect(verdict.mismatches).toHaveLength(1);
    expect(verdict.mismatches[0]).toEqual({
      path: 'stage',
      expected: 'resolved',
      actual: 'open',
    });
  });

  it('detects an absent field (actual undefined, not null)', () => {
    const verdict = reconcileOperation(
      { stage: 'resolved' },
      { priority: 'low' },
      { priority: 'low' },
    );
    expect(verdict.matched).toBe(false);
    expect(verdict.mismatches[0]).toEqual({ path: 'stage', expected: 'resolved', actual: undefined });
  });

  it('descends into nested expectation objects and reports dotted paths', () => {
    const verdict = reconcileOperation(
      { renewal: { status: 'signed', seats: 25 } },
      { renewal: { status: 'signed', seats: 10 } },
      { renewal: { status: 'negotiating', seats: 10 } },
    );
    expect(verdict.matched).toBe(false);
    expect(verdict.mismatches).toEqual([{ path: 'renewal.seats', expected: 25, actual: 10 }]);
  });

  it('requires array expectations to match exactly', () => {
    const verdict = reconcileOperation(
      { tags: ['a', 'b'] },
      { tags: ['a'] },
      { tags: [] },
    );
    expect(verdict.matched).toBe(false);
    expect(verdict.mismatches[0]).toEqual({ path: 'tags', expected: ['a', 'b'], actual: ['a'] });
  });

  it('flags the unchanged state — accepted but nothing moved', () => {
    const pre = { status: 'open', priority: 'high' };
    const verdict = reconcileOperation({ status: 'resolved' }, pre, pre);
    expect(verdict.matched).toBe(false);
    expect(verdict.stateUnchanged).toBe(true);
  });

  it('reports changed-but-wrong as not unchanged', () => {
    const verdict = reconcileOperation(
      { status: 'resolved' },
      { status: 'escalated' },
      { status: 'open' },
    );
    expect(verdict.matched).toBe(false);
    expect(verdict.stateUnchanged).toBe(false);
  });

  it('treats a not-found target as a null observed state', () => {
    const verdict = reconcileOperation({ status: 'resolved' }, null, { status: 'open' });
    expect(verdict.matched).toBe(false);
    expect(verdict.mismatches[0]).toEqual({ path: 'status', expected: 'resolved', actual: undefined });
  });
});

// ---------------------------------------------------------------------------
// verifyReceipt — the action-receipt half of VERIFY
// ---------------------------------------------------------------------------

describe('verifyReceipt', () => {
  it('verifies an accepted receipt, with or without a provider receipt id', () => {
    expect(verifyReceipt('accepted', 'rcpt-042')).toEqual({
      verified: true,
      reason: 'the external system accepted the write (provider receipt rcpt-042)',
    });
    expect(verifyReceipt('accepted', null).verified).toBe(true);
    expect(verifyReceipt('accepted', null).reason).toContain('no provider receipt id');
  });

  it('refuses rejected, failed and missing receipts deterministically', () => {
    expect(verifyReceipt('rejected', 'rcpt-1').verified).toBe(false);
    expect(verifyReceipt('rejected', 'rcpt-1').reason).toContain('permanently refused');
    expect(verifyReceipt('failed', null).verified).toBe(false);
    expect(verifyReceipt('failed', null).reason).toContain('resumable');
    expect(verifyReceipt(null, null).verified).toBe(false);
    expect(verifyReceipt(null, null).reason).toContain('never executed');
  });
});

// ---------------------------------------------------------------------------
// Deterministic human-readable language
// ---------------------------------------------------------------------------

describe('deterministic reconciliation language', () => {
  it('renders mismatch entries for humans', () => {
    expect(describeMismatch({ path: 'stage', expected: 'resolved', actual: 'open' })).toBe(
      "'stage' (expected \"resolved\", observed \"open\")",
    );
    expect(describeMismatch({ path: 'x', expected: 1, actual: undefined })).toBe(
      "'x' (expected 1, observed absent)",
    );
  });

  it('joins lists in plain language', () => {
    expect(joinAnd([])).toBe('');
    expect(joinAnd(['a'])).toBe('a');
    expect(joinAnd(['a', 'b'])).toBe('a and b');
    expect(joinAnd(['a', 'b', 'c'])).toBe('a, b and c');
  });

  it('builds the mismatch reason grounded in the records', () => {
    const reason = buildMismatchReason({
      taskDescription: 'Close out the Q3 renewal',
      systemDisplayName: 'Acme CRM',
      operationKey: 'file-crm',
      target: 'cust-1042',
      mismatches: [{ path: 'stage', expected: 'onboarding-complete', actual: 'onboarding' }],
      stateUnchanged: true,
    });
    expect(reason).toContain('"Close out the Q3 renewal"');
    expect(reason).toContain("'Acme CRM'");
    expect(reason).toContain("'file-crm'");
    expect(reason).toContain("'cust-1042'");
    expect(reason).toContain("'stage'");
    expect(reason).toContain('identical to the pre-execution state');
    expect(reason).toContain('preserved as evidence');
    // Changed-but-wrong reads the other branch.
    const changed = buildMismatchReason({
      taskDescription: 'd',
      systemDisplayName: 's',
      operationKey: 'k',
      target: 't',
      mismatches: [{ path: 'p', expected: 1, actual: 2 }],
      stateUnchanged: false,
    });
    expect(changed).toContain('changed, but not to what the approved plan promised');
  });

  it('builds the attention unknown question and consequence', () => {
    const question = buildMismatchUnknownQuestion({
      taskDescription: 'Close out the Q3 renewal',
      systemDisplayName: 'Acme CRM',
      operationKey: 'file-crm',
      target: 'cust-1042',
    });
    expect(question).toContain('Why did the authorized action "Close out the Q3 renewal"');
    expect(question).toContain("'cust-1042'");
    expect(question).toContain('in Acme CRM');
    expect(question).toContain("operation 'file-crm'");

    const single = buildMismatchUnknownConsequence({
      systemDisplayName: 'Acme CRM',
      target: 'cust-1042',
      mismatchCount: 1,
    });
    expect(single).toContain('Acme CRM');
    expect(single).toContain("'cust-1042'");
    expect(single).not.toContain('other target');

    const multi = buildMismatchUnknownConsequence({
      systemDisplayName: 'Acme CRM',
      target: 'cust-1042',
      mismatchCount: 3,
    });
    expect(multi).toContain('2 other targets');
  });

  it('clamps detail strings to the audit bound', () => {
    expect(clampDetail('short')).toBe('short');
    const long = 'x'.repeat(600);
    expect(clampDetail(long).length).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Validation — the frozen plan
// ---------------------------------------------------------------------------

describe('validateCreateDeepActionInput', () => {
  it('accepts a multi-system plan and freezes it', () => {
    const valid = validateCreateDeepActionInput({
      taskContext: TASK,
      operations: [
        operation(),
        operation({
          key: 'close-ticket',
          capabilityKey: 'write.support-desk',
          target: 'tick-9001',
        }),
      ],
      idempotencyKey: 'renewal-q3',
    });
    expect(valid.taskContext.description).toBe('Close out the Q3 renewal');
    expect(valid.taskContext.requestedFor).toBe('Q3 close');
    expect(valid.operations).toHaveLength(2);
    expect(valid.operations[1]!.target).toBe('tick-9001');
    expect(valid.idempotencyKey).toBe('renewal-q3');
  });

  it('derives the read capability key of a write capability class', () => {
    expect(readCapabilityKeyOf('write.customer-records')).toBe('read.customer-records');
    expect(readCapabilityKeyOf('write.support-desk')).toBe('read.support-desk');
  });

  it('rejects unknown fields, empty plans, duplicates and oversized plans', () => {
    expect(() => validateCreateDeepActionInput({ taskContext: TASK, operations: [] })).toThrow(
      DeepActionsError,
    );
    expect(() =>
      validateCreateDeepActionInput({
        taskContext: TASK,
        operations: [operation({ id: 'smuggled' } as unknown as Record<string, unknown>)],
      }),
    ).toThrow(/unknown field 'id'/);
    expect(() =>
      validateCreateDeepActionInput({
        taskContext: TASK,
        operations: [operation(), operation()],
      }),
    ).toThrow(/duplicate operation key 'file-crm'/);
    expect(() =>
      validateCreateDeepActionInput({
        taskContext: TASK,
        operations: Array.from({ length: 17 }, (_, index) =>
          operation({ key: `op-${index}` }),
        ),
      }),
    ).toThrow(/at most 16/);
  });

  it('requires WRITE capability keys of the W081 vocabulary', () => {
    expect(() =>
      validateCreateDeepActionInput({
        taskContext: TASK,
        operations: [operation({ capabilityKey: 'read.customer-records' })],
      }),
    ).toThrow(/WRITE capability key/);
    expect(() =>
      validateCreateDeepActionInput({
        taskContext: TASK,
        operations: [operation({ capabilityKey: 'admin' })],
      }),
    ).toThrow(/WRITE capability key/);
  });

  it('requires object payloads and non-empty expectations', () => {
    expect(() =>
      validateCreateDeepActionInput({
        taskContext: TASK,
        operations: [operation({ payload: ['not', 'an', 'object'] })],
      }),
    ).toThrow(/payload.*plain JSON object/);
    expect(() =>
      validateCreateDeepActionInput({
        taskContext: TASK,
        operations: [operation({ expectation: {} })],
      }),
    ).toThrow(/at least one expected field/);
  });

  it('rejects unserializable values — provider objects cannot cross at the boundary either', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      validateCreateDeepActionInput({
        taskContext: TASK,
        operations: [operation({ payload: cyclic })],
      }),
    ).toThrow(/JSON-serializable/);
  });
});

// ---------------------------------------------------------------------------
// Vocabulary guards
// ---------------------------------------------------------------------------

describe('vocabulary guards', () => {
  it('knows the phase statuses', () => {
    for (const status of ['draft', 'discovered', 'inspected', 'proposed', 'authorized', 'executed', 'verified', 'reconciled', 'mismatched', 'rejected', 'failed']) {
      expect(isDeepActionStatus(status)).toBe(true);
    }
    expect(isDeepActionStatus('completed')).toBe(false);
    expect(isDeepActionStatus(null)).toBe(false);
  });

  it('validates the list query with defaults and bounds', () => {
    expect(validateListDeepActionsQuery(undefined)).toEqual({ status: null, limit: 50 });
    expect(validateListDeepActionsQuery({ status: 'mismatched' }).status).toBe('mismatched');
    expect(() =>
      validateListDeepActionsQuery({ status: 'nope' } as unknown as { status: string }),
    ).toThrow(DeepActionsError);
    expect(() => validateListDeepActionsQuery({ limit: 0 })).toThrow(DeepActionsError);
    expect(() => validateListDeepActionsQuery({ limit: 501 })).toThrow(DeepActionsError);
    expect(() =>
      validateListDeepActionsQuery({ unknown: true } as unknown as { unknown: boolean }),
    ).toThrow(DeepActionsError);
  });
});
