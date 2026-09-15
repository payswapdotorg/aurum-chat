// Unit tests for the notifications module's pure logic (no database):
// input validation/normalization, the policy floor and resolution, the
// digest/escalation composers, the delivery-error classification, the
// authority-gate key builders and the timing predicates.
//
// W031 acceptance covered here (pure halves):
//  * policy-controlled: the built-in floor, kind → default → built-in
//    resolution, and the escalation-coherence rules that make a policy
//    row well-formed;
//  * urgent/digest/escalation composition: digest batches are bounded and
//    excerpted explicitly; escalation messages carry the reason;
//  * retries: the channels-error classification that decides transient
//    (retryable) vs permanent;
//  * dedupe: the window predicate with exact boundary semantics;
//  * acknowledgment + audit vocabulary: statuses, first-wins rules are
//    storage-level (service tests prove them).

import { describe, expect, it } from 'vitest';
import { ChannelsError } from '@/modules/channels/contract';
import { NotificationsError } from '../errors';
import {
  BUILT_IN_DEFAULT_POLICY,
  DIGEST_EXCERPT_LENGTH,
  MAX_DIGEST_MEMBERS,
  builtInDefaultPolicy,
  classifyDeliveryError,
  composeDigestMessage,
  composeEscalationMessage,
  deliveryGateKey,
  escalationGateKey,
  isDedupeWindowOpen,
  isDigestCycleDue,
  isEscalationDue,
  isNotificationDeliveryClass,
  isNotificationStatus,
  nextRetryAt,
  NOTIFICATION_ACTION_KIND,
  NOTIFICATION_AUTHORITY_LEVEL,
  recipientLabel,
  resolveNotificationPolicy,
} from '../policy';
import type { NotificationPolicy } from '../types';
import {
  assertNotificationsTenantContext,
  canAdministerNotificationPolicies,
  isNotificationKindSlug,
  isUuid,
  validateAcknowledgeNotificationInput,
  validateCreateNotificationInput,
  validateEscalateUnacknowledgedQuery,
  validateFlushDigestsQuery,
  validateListNotificationsQuery,
  validateRetryDueQuery,
  validateSetNotificationPolicyInput,
} from '../validation';

function expectCode(code: NotificationsError['code'], fn: () => unknown): void {
  try {
    fn();
    throw new Error(`expected NotificationsError('${code}') but the call succeeded`);
  } catch (error) {
    expect(error).toBeInstanceOf(NotificationsError);
    expect((error as NotificationsError).code).toBe(code);
  }
}

const GOOD_CONTEXT = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  principalId: '22222222-2222-4222-8222-222222222222',
  authority: [],
};

// The actions module's idempotency-key pattern (migrations/002, W009) —
// the gate keys must be legal against it.
const ACTIONS_IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;

function policyRow(overrides: Partial<NotificationPolicy> = {}): NotificationPolicy {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    tenantId: GOOD_CONTEXT.tenantId,
    notificationKind: 'test.kind',
    deliveryClass: 'urgent',
    maxAttempts: 5,
    retryBackoffSeconds: 120,
    dedupeWindowSeconds: 600,
    digestWindowSeconds: 1800,
    requireAcknowledgment: false,
    escalationAfterSeconds: null,
    escalationRecipient: null,
    note: null,
    createdAt: '2026-09-14T00:00:00Z',
    updatedAt: '2026-09-14T00:00:00Z',
    ...overrides,
  };
}

const BASE_POLICY_INPUT = {
  deliveryClass: 'urgent',
  maxAttempts: 3,
  retryBackoffSeconds: 60,
  dedupeWindowSeconds: 300,
  digestWindowSeconds: 3600,
  requireAcknowledgment: false,
} as const;

// ---------------------------------------------------------------------------
// Context + shape guards
// ---------------------------------------------------------------------------

describe('notifications validation — context and guards', () => {
  it('accepts a well-formed TenantContext and rejects malformed ones', () => {
    expect(() => assertNotificationsTenantContext(GOOD_CONTEXT)).not.toThrow();
    expectCode('invalid_context', () =>
      assertNotificationsTenantContext({ ...GOOD_CONTEXT, tenantId: ' ' }),
    );
    expectCode('invalid_context', () =>
      assertNotificationsTenantContext({ ...GOOD_CONTEXT, principalId: '' }),
    );
    expectCode('invalid_context', () =>
      assertNotificationsTenantContext({ ...GOOD_CONTEXT, authority: 'admin' as unknown as string[] }),
    );
  });

  it('kind slugs follow the canonical pattern; uuids are recognized', () => {
    expect(isNotificationKindSlug('approval.requested')).toBe(true);
    expect(isNotificationKindSlug('goal-drift')).toBe(true);
    expect(isNotificationKindSlug('a:b:c')).toBe(true);
    expect(isNotificationKindSlug('')).toBe(false);
    expect(isNotificationKindSlug('.leading-dot')).toBe(false);
    expect(isNotificationKindSlug('has space')).toBe(false);
    expect(isNotificationKindSlug('x'.repeat(129))).toBe(false);
    expect(isUuid('33333333-3333-4333-8333-333333333333')).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
  });

  it('delivery-class and status vocabularies are closed', () => {
    for (const klass of ['urgent', 'digest', 'escalation']) {
      expect(isNotificationDeliveryClass(klass)).toBe(true);
    }
    expect(isNotificationDeliveryClass('instant')).toBe(false);
    for (const status of [
      'pending', 'delivered', 'escalating', 'escalated',
      'failed', 'blocked', 'suppressed', 'escalation_failed',
    ]) {
      expect(isNotificationStatus(status)).toBe(true);
    }
    expect(isNotificationStatus('sent')).toBe(false);
  });

  it('policy administration is claim-gated', () => {
    expect(canAdministerNotificationPolicies([])).toBe(false);
    expect(canAdministerNotificationPolicies(['notifications:administer'])).toBe(true);
    expect(canAdministerNotificationPolicies(['other:claim', 'notifications:administer'])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createNotification input validation
// ---------------------------------------------------------------------------

describe('notifications validation — create input', () => {
  const good = {
    kind: 'approval.requested',
    recipient: { provider: 'slack' as const, providerAccountId: 'U123ABC' },
    subject: 'Approval requested',
    body: 'Please review the proposed agent recruitment.',
  };

  it('accepts and normalizes a minimal input', () => {
    const valid = validateCreateNotificationInput(good);
    expect(valid.kind).toBe('approval.requested');
    expect(valid.recipient).toEqual({ provider: 'slack', providerAccountId: 'U123ABC', displayName: null });
    expect(valid.subject).toBe('Approval requested');
    expect(valid.data).toBe(null);
    expect(valid.dedupeKey).toBe(null);
    expect(valid.correlationId).toBe(null);
    expect(valid.connectionId).toBe(null);
  });

  it('accepts all optional fields and normalizes empties to null', () => {
    const valid = validateCreateNotificationInput({
      ...good,
      recipient: { provider: 'email', providerAccountId: 'ops@corp.example', displayName: 'Ops' },
      data: { risk: 'high', ids: [1, 2] },
      dedupeKey: 'approval:42',
      correlationId: 'exec-9',
      connectionId: '44444444-4444-4444-8444-444444444444',
    });
    expect(valid.recipient?.displayName).toBe('Ops');
    expect(valid.data).toEqual({ risk: 'high', ids: [1, 2] });
    expect(valid.dedupeKey).toBe('approval:42');
    expect(valid.correlationId).toBe('exec-9');
    expect(valid.connectionId).toBe('44444444-4444-4444-8444-444444444444');
  });

  it('rejects unknown keys — callers cannot smuggle id, tenantId or status', () => {
    expectCode('invalid_notification_input', () =>
      validateCreateNotificationInput({ ...good, id: 'x' } as unknown as Parameters<typeof validateCreateNotificationInput>[0]),
    );
    expectCode('invalid_notification_input', () =>
      validateCreateNotificationInput({ ...good, tenantId: 'x' } as unknown as Parameters<typeof validateCreateNotificationInput>[0]),
    );
    expectCode('invalid_notification_input', () =>
      validateCreateNotificationInput({ ...good, status: 'delivered' } as unknown as Parameters<typeof validateCreateNotificationInput>[0]),
    );
  });

  it('rejects malformed kinds, recipients, subjects and bodies', () => {
    expectCode('invalid_notification_input', () =>
      validateCreateNotificationInput({ ...good, kind: 'not a slug' }),
    );
    expectCode('invalid_notification_input', () =>
      validateCreateNotificationInput({
        ...good,
        recipient: { provider: 'carrier-pigeon', providerAccountId: 'x' },
      } as unknown as Parameters<typeof validateCreateNotificationInput>[0]),
    );
    expectCode('invalid_notification_input', () =>
      validateCreateNotificationInput({ ...good, recipient: { provider: 'slack' } } as unknown as Parameters<typeof validateCreateNotificationInput>[0]),
    );
    expectCode('invalid_notification_input', () =>
      validateCreateNotificationInput({ ...good, recipient: { provider: 'slack', providerAccountId: '' } } as unknown as Parameters<typeof validateCreateNotificationInput>[0]),
    );
    expectCode('invalid_notification_input', () =>
      validateCreateNotificationInput({ ...good, subject: '' }),
    );
    expectCode('invalid_notification_input', () =>
      validateCreateNotificationInput({ ...good, subject: 'x'.repeat(201) }),
    );
    expectCode('invalid_notification_input', () =>
      validateCreateNotificationInput({ ...good, body: 'x'.repeat(4097) }),
    );
  });

  it('data must be plain, finite JSON within the size bound', () => {
    expectCode('invalid_notification_input', () =>
      validateCreateNotificationInput({ ...good, data: () => 1 }),
    );
    expectCode('invalid_notification_input', () =>
      validateCreateNotificationInput({ ...good, data: Number.NaN }),
    );
    expectCode('invalid_notification_input', () =>
      validateCreateNotificationInput({ ...good, data: 'x'.repeat(65_537) }),
    );
  });

  it('dedupe keys follow the emitter-key pattern', () => {
    expectCode('invalid_notification_input', () =>
      validateCreateNotificationInput({ ...good, dedupeKey: 'has space' }),
    );
    expectCode('invalid_notification_input', () =>
      validateCreateNotificationInput({ ...good, dedupeKey: 'x'.repeat(201) }),
    );
    expect(validateCreateNotificationInput({ ...good, dedupeKey: 'evt:2026-09-14.001' }).dedupeKey).toBe(
      'evt:2026-09-14.001',
    );
  });
});

// ---------------------------------------------------------------------------
// Policy input validation
// ---------------------------------------------------------------------------

describe('notifications validation — policy input', () => {
  it('accepts a complete urgent policy and a complete escalation policy', () => {
    const urgent = validateSetNotificationPolicyInput({
      notificationKind: 'goal.drift',
      ...BASE_POLICY_INPUT,
    });
    expect(urgent.notificationKind).toBe('goal.drift');
    expect(urgent.deliveryClass).toBe('urgent');
    expect(urgent.escalationAfterSeconds).toBe(null);
    expect(urgent.escalationRecipient).toBe(null);

    const escalation = validateSetNotificationPolicyInput({
      notificationKind: 'risk.detected',
      deliveryClass: 'escalation',
      maxAttempts: 4,
      retryBackoffSeconds: 30,
      dedupeWindowSeconds: 60,
      digestWindowSeconds: 600,
      requireAcknowledgment: true,
      escalationAfterSeconds: 900,
      escalationRecipient: { provider: 'sms', providerAccountId: '+15550001111' },
      note: 'critical risks',
    });
    expect(escalation.escalationRecipient).toEqual({
      provider: 'sms',
      providerAccountId: '+15550001111',
      displayName: null,
    });
    expect(escalation.note).toBe('critical risks');
  });

  it('policy writes are explicit: every governing field is required', () => {
    const { ...withoutAttempts } = { ...BASE_POLICY_INPUT, notificationKind: null, maxAttempts: undefined };
    expectCode('invalid_policy_input', () =>
      validateSetNotificationPolicyInput(withoutAttempts as Parameters<typeof validateSetNotificationPolicyInput>[0]),
    );
    expectCode('invalid_policy_input', () =>
      validateSetNotificationPolicyInput({ ...BASE_POLICY_INPUT, retryBackoffSeconds: undefined }),
    );
    expectCode('invalid_policy_input', () =>
      validateSetNotificationPolicyInput({ ...BASE_POLICY_INPUT, requireAcknowledgment: 'yes' as unknown as boolean }),
    );
  });

  it('rejects out-of-bounds numbers and unknown fields', () => {
    expectCode('invalid_policy_input', () =>
      validateSetNotificationPolicyInput({ ...BASE_POLICY_INPUT, maxAttempts: 0 }),
    );
    expectCode('invalid_policy_input', () =>
      validateSetNotificationPolicyInput({ ...BASE_POLICY_INPUT, maxAttempts: 11 }),
    );
    expectCode('invalid_policy_input', () =>
      validateSetNotificationPolicyInput({ ...BASE_POLICY_INPUT, retryBackoffSeconds: 0 }),
    );
    expectCode('invalid_policy_input', () =>
      validateSetNotificationPolicyInput({ ...BASE_POLICY_INPUT, dedupeWindowSeconds: -1 }),
    );
    expectCode('invalid_policy_input', () =>
      validateSetNotificationPolicyInput({ ...BASE_POLICY_INPUT, digestWindowSeconds: 0 }),
    );
    expectCode('invalid_policy_input', () =>
      validateSetNotificationPolicyInput({ ...BASE_POLICY_INPUT, escalationAfterSeconds: 2_592_001 }),
    );
    expectCode('invalid_policy_input', () =>
      validateSetNotificationPolicyInput({
        ...BASE_POLICY_INPUT,
        unknownField: true,
      } as unknown as Parameters<typeof validateSetNotificationPolicyInput>[0]),
    );
  });

  it('escalation coherence: the escalation class demands ack + deadline + recipient', () => {
    expectCode('invalid_policy_input', () =>
      validateSetNotificationPolicyInput({
        ...BASE_POLICY_INPUT,
        deliveryClass: 'escalation',
        requireAcknowledgment: false,
        escalationAfterSeconds: 900,
        escalationRecipient: { provider: 'sms', providerAccountId: '+15550001111' },
      }),
    );
    expectCode('invalid_policy_input', () =>
      validateSetNotificationPolicyInput({
        ...BASE_POLICY_INPUT,
        deliveryClass: 'escalation',
        requireAcknowledgment: true,
        escalationRecipient: { provider: 'sms', providerAccountId: '+15550001111' },
      }),
    );
    expectCode('invalid_policy_input', () =>
      validateSetNotificationPolicyInput({
        ...BASE_POLICY_INPUT,
        deliveryClass: 'escalation',
        requireAcknowledgment: true,
        escalationAfterSeconds: 900,
      }),
    );
  });

  it('escalation coherence: other classes carry none of the escalation configuration', () => {
    expectCode('invalid_policy_input', () =>
      validateSetNotificationPolicyInput({
        ...BASE_POLICY_INPUT,
        escalationAfterSeconds: 900,
      }),
    );
    expectCode('invalid_policy_input', () =>
      validateSetNotificationPolicyInput({
        ...BASE_POLICY_INPUT,
        escalationRecipient: { provider: 'sms', providerAccountId: '+15550001111' },
      }),
    );
  });

  it('escalation recipients must be canonical channel parties', () => {
    expectCode('invalid_policy_input', () =>
      validateSetNotificationPolicyInput({
        ...BASE_POLICY_INPUT,
        deliveryClass: 'escalation',
        requireAcknowledgment: true,
        escalationAfterSeconds: 900,
        escalationRecipient: { provider: 'fax', providerAccountId: 'x' },
      } as unknown as Parameters<typeof validateSetNotificationPolicyInput>[0]),
    );
    expectCode('invalid_policy_input', () =>
      validateSetNotificationPolicyInput({
        ...BASE_POLICY_INPUT,
        deliveryClass: 'escalation',
        requireAcknowledgment: true,
        escalationAfterSeconds: 900,
        escalationRecipient: { provider: 'sms' },
      } as unknown as Parameters<typeof validateSetNotificationPolicyInput>[0]),
    );
  });
});

// ---------------------------------------------------------------------------
// Query validation
// ---------------------------------------------------------------------------

describe('notifications validation — queries', () => {
  it('list queries validate filters and limits', () => {
    const valid = validateListNotificationsQuery({
      notificationKind: 'goal.drift',
      status: 'pending',
      deliveryClass: 'digest',
      provider: 'slack',
      recipientAccountId: 'U123',
      dedupeKey: 'k:1',
    });
    expect(valid.notificationKind).toBe('goal.drift');
    expect(valid.status).toBe('pending');
    expect(valid.limit).toBe(50);
    expectCode('invalid_notification_query', () =>
      validateListNotificationsQuery({ status: 'sent' } as unknown as Parameters<typeof validateListNotificationsQuery>[0]),
    );
    expectCode('invalid_notification_query', () =>
      validateListNotificationsQuery({ limit: 0 } as Parameters<typeof validateListNotificationsQuery>[0]),
    );
    expectCode('invalid_notification_query', () =>
      validateListNotificationsQuery({ limit: 501 } as Parameters<typeof validateListNotificationsQuery>[0]),
    );
  });

  it('acknowledgment inputs validate id and note bounds', () => {
    const valid = validateAcknowledgeNotificationInput({
      notificationId: '33333333-3333-4333-8333-333333333333',
      note: 'seen',
    });
    expect(valid.note).toBe('seen');
    expectCode('invalid_notification_input', () =>
      validateAcknowledgeNotificationInput({ notificationId: 'nope' }),
    );
    expectCode('invalid_notification_input', () =>
      validateAcknowledgeNotificationInput({
        notificationId: '33333333-3333-4333-8333-333333333333',
        note: 'x'.repeat(2001),
      }),
    );
  });

  it('pump queries validate their limits', () => {
    expect(validateRetryDueQuery({}).limit).toBe(20);
    expect(validateRetryDueQuery({ limit: 100 }).limit).toBe(100);
    expectCode('invalid_notification_query', () => validateRetryDueQuery({ limit: 101 }));
    expect(validateFlushDigestsQuery({}).limit).toBe(10);
    expect(validateFlushDigestsQuery({ limit: 50 }).limit).toBe(50);
    expectCode('invalid_notification_query', () => validateFlushDigestsQuery({ limit: 51 }));
    expect(validateEscalateUnacknowledgedQuery({}).limit).toBe(20);
    expectCode('invalid_notification_query', () => validateEscalateUnacknowledgedQuery({ limit: 0 }));
  });
});

// ---------------------------------------------------------------------------
// The built-in floor + resolution
// ---------------------------------------------------------------------------

describe('notifications policy — built-in floor and resolution', () => {
  it('the built-in floor is urgent delivery with a modest retry budget', () => {
    expect(BUILT_IN_DEFAULT_POLICY.deliveryClass).toBe('urgent');
    expect(BUILT_IN_DEFAULT_POLICY.maxAttempts).toBe(3);
    expect(BUILT_IN_DEFAULT_POLICY.retryBackoffSeconds).toBe(60);
    expect(BUILT_IN_DEFAULT_POLICY.dedupeWindowSeconds).toBe(300);
    expect(BUILT_IN_DEFAULT_POLICY.digestWindowSeconds).toBe(3600);
    expect(BUILT_IN_DEFAULT_POLICY.requireAcknowledgment).toBe(false);
    expect(BUILT_IN_DEFAULT_POLICY.escalationAfterSeconds).toBe(null);
    expect(BUILT_IN_DEFAULT_POLICY.escalationRecipient).toBe(null);
  });

  it('builtInDefaultPolicy hands out defensive copies', () => {
    const first = builtInDefaultPolicy();
    first.maxAttempts = 99;
    const second = builtInDefaultPolicy();
    expect(second.maxAttempts).toBe(3);
  });

  it('resolution order: kind row → tenant default → built-in', () => {
    const kindRow = policyRow({ deliveryClass: 'digest', digestWindowSeconds: 900 });
    const defaultRow = policyRow({ notificationKind: null, deliveryClass: 'escalation' });

    const fromKind = resolveNotificationPolicy('test.kind', kindRow, defaultRow);
    expect(fromKind.source).toBe('kind');
    expect(fromKind.policy?.id).toBe(kindRow.id);
    expect(fromKind.deliveryClass).toBe('digest');
    expect(fromKind.digestWindowSeconds).toBe(900);

    const fromDefault = resolveNotificationPolicy('other.kind', null, defaultRow);
    expect(fromDefault.source).toBe('tenant-default');
    expect(fromDefault.policy?.id).toBe(defaultRow.id);
    expect(fromDefault.deliveryClass).toBe('escalation');

    const fromFloor = resolveNotificationPolicy('other.kind', null, null);
    expect(fromFloor.source).toBe('built-in');
    expect(fromFloor.policy).toBe(null);
    expect(fromFloor.deliveryClass).toBe('urgent');
    expect(fromFloor.maxAttempts).toBe(3);
  });

  it('the kind row wins even when a default exists (snapshot carries its fields)', () => {
    const kindRow = policyRow({
      maxAttempts: 10,
      retryBackoffSeconds: 7_200,
      dedupeWindowSeconds: 0,
    });
    const resolved = resolveNotificationPolicy('test.kind', kindRow, null);
    expect(resolved.maxAttempts).toBe(10);
    expect(resolved.retryBackoffSeconds).toBe(7_200);
    expect(resolved.dedupeWindowSeconds).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Authority-gate vocabulary
// ---------------------------------------------------------------------------

describe('notifications policy — the W009 authority-gate vocabulary', () => {
  it('the gate kind and level are the documented constants', () => {
    expect(NOTIFICATION_ACTION_KIND).toBe('notification-delivery');
    expect(NOTIFICATION_AUTHORITY_LEVEL).toBe('ASK');
  });

  it('gate keys are stable and legal actions-module idempotency keys', () => {
    const id = '33333333-3333-4333-8333-333333333333';
    expect(deliveryGateKey(id)).toBe(`notification-delivery:${id}`);
    expect(escalationGateKey(id)).toBe(`notification-escalation:${id}`);
    expect(deliveryGateKey(id)).not.toBe(escalationGateKey(id));
    expect(ACTIONS_IDEMPOTENCY_PATTERN.test(deliveryGateKey(id))).toBe(true);
    expect(ACTIONS_IDEMPOTENCY_PATTERN.test(escalationGateKey(id))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Delivery-error classification (retries)
// ---------------------------------------------------------------------------

describe('notifications policy — delivery-error classification', () => {
  it('transient outcomes retry; permanent ones do not', () => {
    const transient = [
      'provider_unavailable',
      'delivery_failed',
      'connection_not_found',
      'connection_ambiguous',
      'connection_disabled',
    ] as const;
    for (const code of transient) {
      expect(classifyDeliveryError(new ChannelsError(code, 'x'))).toBe('transient');
    }
    expect(classifyDeliveryError(new ChannelsError('delivery_rejected', 'bad recipient'))).toBe(
      'permanent',
    );
    // Codes that cannot occur through this module's pre-validated path are
    // permanent — failing fast rather than burning the retry budget.
    expect(classifyDeliveryError(new ChannelsError('invalid_channel_input', 'x'))).toBe('permanent');
    expect(classifyDeliveryError(new ChannelsError('invalid_provenance', 'x'))).toBe('permanent');
  });
});

// ---------------------------------------------------------------------------
// Message composition
// ---------------------------------------------------------------------------

describe('notifications policy — digest composition', () => {
  const members = [
    { subject: 'Goal drift on revenue', body: 'Revenue is 12% below target.', createdAt: '2026-09-14T08:00:00Z' },
    { subject: 'Goal drift on margin', body: 'Margin is 3 points below target.', createdAt: '2026-09-14T09:00:00Z' },
  ];

  it('composes one bounded message: header + one line per member', () => {
    const message = composeDigestMessage('goal.drift', members);
    expect(message.subject).toBe('Digest: goal.drift (2 notifications)');
    expect(message.text).toContain("Digest of 'goal.drift' — 2 notifications:");
    expect(message.text).toContain('• [2026-09-14T08:00:00Z] Goal drift on revenue — Revenue is 12% below target.');
    expect(message.text).toContain('• [2026-09-14T09:00:00Z] Goal drift on margin');
    expect(message.text.length).toBeLessThan(16_384);
  });

  it('long bodies are excerpted with an explicit truncation marker', () => {
    const long = 'x'.repeat(DIGEST_EXCERPT_LENGTH + 50);
    const message = composeDigestMessage('k', [
      { subject: 's', body: long, createdAt: '2026-09-14T08:00:00Z' },
    ]);
    expect(message.text).toContain(`${'x'.repeat(DIGEST_EXCERPT_LENGTH)}… [truncated]`);
    expect(message.text).not.toContain(long);
  });

  it('composition is bounded: empty and oversized batches are invariant violations', () => {
    expect(() => composeDigestMessage('k', [])).toThrow(/internal invariant violation/);
    const tooMany = Array.from({ length: MAX_DIGEST_MEMBERS + 1 }, (_, index) => ({
      subject: `s${index}`,
      body: 'b',
      createdAt: '2026-09-14T08:00:00Z',
    }));
    expect(() => composeDigestMessage('k', tooMany)).toThrow(/internal invariant violation/);
  });

  it('the worst legal batch stays under the channels text bound', () => {
    const worst = Array.from({ length: MAX_DIGEST_MEMBERS }, () => ({
      subject: 's'.repeat(200),
      body: 'b'.repeat(4_096),
      createdAt: '2026-09-14T08:00:00.000Z',
    }));
    const message = composeDigestMessage('goal.drift.very-long-kind-name', worst);
    expect(message.text.length).toBeLessThanOrEqual(16_384);
    expect(message.subject.length).toBeLessThanOrEqual(200);
  });
});

describe('notifications policy — escalation composition', () => {
  it('the escalation message prefixes the subject and states the reason', () => {
    const message = composeEscalationMessage(
      'Critical risk detected',
      'Supplier X missed the contractual SLA.',
      'slack:U123ABC',
      '2026-09-14T08:00:00Z',
      900,
    );
    expect(message.subject).toBe('Escalation: Critical risk detected');
    expect(message.text).toContain('Supplier X missed the contractual SLA.');
    expect(message.text).toContain('delivered to slack:U123ABC at 2026-09-14T08:00:00Z');
    expect(message.text).toContain('unacknowledged after 900 seconds');
  });

  it('the escalation subject re-bounds to the channel subject limit', () => {
    const message = composeEscalationMessage('s'.repeat(300), 'b', 'p:a', '2026-09-14T08:00:00Z', 60);
    expect(message.subject).toHaveLength(200);
    expect(message.subject.startsWith('Escalation: ')).toBe(true);
  });

  it('recipientLabel is the canonical provider:account form', () => {
    expect(recipientLabel('slack', 'U123ABC')).toBe('slack:U123ABC');
  });
});

// ---------------------------------------------------------------------------
// Timing predicates (dedupe window, digest cycle, escalation deadline)
// ---------------------------------------------------------------------------

describe('notifications policy — timing predicates', () => {
  const created = new Date('2026-09-14T08:00:00Z');

  it('dedupe windows are strictly open — the boundary starts a new cycle', () => {
    expect(isDedupeWindowOpen(created, 300, new Date('2026-09-14T08:04:59Z'))).toBe(true);
    expect(isDedupeWindowOpen(created, 300, new Date('2026-09-14T08:05:00Z'))).toBe(false);
    expect(isDedupeWindowOpen(created, 300, new Date('2026-09-14T08:05:01Z'))).toBe(false);
    // A zero window disables dedupe entirely.
    expect(isDedupeWindowOpen(created, 0, new Date('2026-09-14T08:00:01Z'))).toBe(false);
  });

  it('digest cycles become due at the boundary (inclusive)', () => {
    expect(isDigestCycleDue(created, 3600, new Date('2026-09-14T08:59:59Z'))).toBe(false);
    expect(isDigestCycleDue(created, 3600, new Date('2026-09-14T09:00:00Z'))).toBe(true);
    expect(isDigestCycleDue(created, 3600, new Date('2026-09-14T09:00:01Z'))).toBe(true);
  });

  it('escalation deadlines become due at the boundary (inclusive)', () => {
    expect(isEscalationDue(created, 900, new Date('2026-09-14T08:14:59Z'))).toBe(false);
    expect(isEscalationDue(created, 900, new Date('2026-09-14T08:15:00Z'))).toBe(true);
  });

  it('nextRetryAt applies the fixed policy backoff', () => {
    const from = new Date('2026-09-14T08:00:00Z');
    expect(nextRetryAt(from, 60).getTime()).toBe(Date.parse('2026-09-14T08:01:00Z'));
  });
});
