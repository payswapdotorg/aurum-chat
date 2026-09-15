// Integration tests for the notifications module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W031
// acceptance: "Implement policy-controlled urgent/digest/escalation
// notification delivery with retries, dedupe, acknowledgment and audit."
//
//  * policies — claim-gated writes, upsert semantics, kind → default →
//    built-in resolution, escalation coherence (service AND storage
//    level), and the uniform cross-tenant not-found discipline
//    (ADR-0001);
//  * urgent delivery — immediate delivery through the channels contract
//    (W030) with an immutable transcript turn (W029), authority-gated by
//    the actions matrix (W009) under 'notification-delivery'/ASK;
//  * retries — transient transport outcomes retry within the policy
//    budget (leased, backs off), exhausted budgets fail, the provider's
//    explicit rejection fails immediately, missing connection
//    configuration is retryable;
//  * dedupe — duplicates inside the window are recorded as `suppressed`
//    (audited, never delivered); a new cycle starts after the window;
//  * digest — accumulation per (kind, recipient), one combined message
//    per window, batch cap, per-member attempt audit;
//  * escalation — unacknowledged escalation-class notifications escalate
//    to the fallback recipient exactly once; acknowledgment before the
//    deadline prevents escalation; the escalation delivery is gated
//    independently at escalation time;
//  * acknowledgment — first-wins, append-only, requires a delivered
//    notification whose policy demands it;
//  * authority gate — approval_required holds delivery until a human
//    approves (the pump re-checks the SAME request — no duplicate gate
//    history), forbidden blocks and records why;
//  * tenant isolation — another tenant's notifications, attempts,
//    acknowledgments and policies are indistinguishable from missing;
//  * storage discipline — the substantive notification record is
//    immutable history (only lifecycle state moves); attempts and
//    acknowledgments are append-only (PostgreSQL triggers reject
//    UPDATE/DELETE/TRUNCATE).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import * as notificationsContract from '../contract';
import {
  registerChannelConnection,
  setChannelTransport,
  type CanonicalDeliveryRequest,
  type ChannelTransport,
  type TransportReceipt,
} from '@/modules/channels/contract';
import {
  decideApproval,
  getActionRequest,
  listActionRequests,
  setAuthorityPolicy,
} from '@/modules/actions/contract';
import { listMessages } from '@/modules/conversations/contract';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from '@/infra/clock';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { NotificationsError } from '../errors';
import { runMigrations } from '../../../../scripts/migrate';

const {
  acknowledgeNotification,
  createNotification,
  escalateUnacknowledged,
  flushDueDigests,
  getNotification,
  getNotificationAcknowledgment,
  getNotificationPolicy,
  listNotificationAttempts,
  listNotificationPolicies,
  listNotifications,
  resolveNotificationPolicy,
  retryDueNotifications,
  setNotificationPolicy,
} = notificationsContract;

// Dedicated tenants per group so count/order assertions stay deterministic.
const tenantPolicies = newId();
const tenantUrgent = newId();
const tenantRetries = newId();
const tenantDedupe = newId();
const tenantDigest = newId();
const tenantEscalation = newId();
const tenantAck = newId();
const tenantGate = newId();
const tenantIsolation = newId();
const tenantStorage = newId();
const tenantNoConnection = newId();
const tenantB = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function policyAdmin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['notifications:administer'] };
}

function actionsAdmin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['actions:administer'] };
}

function approver(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['actions:approve'] };
}

async function expectCode(
  code: NotificationsError['code'],
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    throw new Error(`expected NotificationsError('${code}') but the call succeeded`);
  } catch (error) {
    expect(error).toBeInstanceOf(NotificationsError);
    expect((error as NotificationsError).code).toBe(code);
  }
}

/** A provider-neutral transport that records every delivery request. */
class RecordingTransport implements ChannelTransport {
  readonly requests: CanonicalDeliveryRequest[] = [];
  private static deliveryCounter = 0;
  private scripted: TransportReceipt[] = [];

  /** Queue exact receipts (consumed in order); unscripted sends deliver. */
  script(...receipts: TransportReceipt[]): void {
    this.scripted.push(...receipts);
  }

  async deliver(request: CanonicalDeliveryRequest): Promise<TransportReceipt> {
    this.requests.push(request);
    RecordingTransport.deliveryCounter += 1;
    const receipt = this.scripted.shift();
    if (receipt !== undefined) return receipt;
    return {
      status: 'delivered',
      providerMessageId: `prov-out-${String(RecordingTransport.deliveryCounter).padStart(6, '0')}`,
      detail: null,
    };
  }
}

let transport: RecordingTransport;

const BASE_TIME = Date.parse('2026-09-14T08:00:00Z');
let clockMs = BASE_TIME;

function advance(seconds: number): void {
  clockMs += seconds * 1_000;
}

const SLACK_RECIPIENT = { provider: 'slack' as const, providerAccountId: 'U777OPER' };
const EMAIL_RECIPIENT = { provider: 'email' as const, providerAccountId: 'manager@corp.example' };

beforeAll(async () => {
  await runMigrations(getDb());
  // One active sending connection per provider per delivering tenant.
  for (const tenantId of [
    tenantUrgent,
    tenantRetries,
    tenantDedupe,
    tenantDigest,
    tenantEscalation,
    tenantAck,
    tenantGate,
    tenantIsolation,
    tenantStorage,
  ]) {
    const ctx = member(tenantId);
    await registerChannelConnection(ctx, {
      provider: 'slack',
      providerAccountId: 'AURUMOPS',
      credentialRef: 'secret-store://slack',
    });
  }
  await registerChannelConnection(member(tenantEscalation), {
    provider: 'sms',
    providerAccountId: '+15550100001',
    credentialRef: 'secret-store://sms',
  });
  // Email preserves subjects through delivery — used by the tests that
  // assert the delivered subject line.
  for (const tenantId of [tenantUrgent, tenantDigest, tenantEscalation]) {
    await registerChannelConnection(member(tenantId), {
      provider: 'email',
      providerAccountId: 'aurum@corp.example',
      credentialRef: 'secret-store://email',
    });
  }
});

afterAll(async () => {
  setChannelTransport(null);
  await closeDb();
});

beforeEach(() => {
  clockMs = BASE_TIME;
  vi.spyOn(systemClock, 'now').mockImplementation(() => new Date(clockMs));
  transport = new RecordingTransport();
  setChannelTransport(transport);
});

afterEach(() => {
  vi.restoreAllMocks();
  setChannelTransport(null);
});

// ---------------------------------------------------------------------------
// Policy management
// ---------------------------------------------------------------------------

describe('notification policies', () => {
  it('policy writes require the administer claim; reads do not', async () => {
    const ctx = member(tenantPolicies);
    await expectCode('forbidden', () =>
      setNotificationPolicy(ctx, {
        notificationKind: 'goal.drift',
        deliveryClass: 'urgent',
        maxAttempts: 3,
        retryBackoffSeconds: 60,
        dedupeWindowSeconds: 300,
        digestWindowSeconds: 3600,
        requireAcknowledgment: false,
      }),
    );
    const created = await setNotificationPolicy(policyAdmin(tenantPolicies), {
      notificationKind: 'goal.drift',
      deliveryClass: 'digest',
      maxAttempts: 5,
      retryBackoffSeconds: 120,
      dedupeWindowSeconds: 600,
      digestWindowSeconds: 900,
      requireAcknowledgment: false,
      note: 'daily-ish digests',
    });
    expect(created.notificationKind).toBe('goal.drift');
    expect(created.deliveryClass).toBe('digest');
    expect(created.note).toBe('daily-ish digests');
    // Reads are visible to every tenant member.
    const read = await getNotificationPolicy(ctx, { notificationKind: 'goal.drift' });
    expect(read.id).toBe(created.id);
  });

  it('upserts update the same row; the default row is addressable as null', async () => {
    const admin = policyAdmin(tenantPolicies);
    const first = await setNotificationPolicy(admin, {
      notificationKind: null,
      deliveryClass: 'urgent',
      maxAttempts: 2,
      retryBackoffSeconds: 30,
      dedupeWindowSeconds: 60,
      digestWindowSeconds: 120,
      requireAcknowledgment: false,
    });
    const second = await setNotificationPolicy(admin, {
      notificationKind: null,
      deliveryClass: 'urgent',
      maxAttempts: 8,
      retryBackoffSeconds: 30,
      dedupeWindowSeconds: 60,
      digestWindowSeconds: 120,
      requireAcknowledgment: false,
    });
    expect(second.id).toBe(first.id);
    expect(second.maxAttempts).toBe(8);
    const listed = await listNotificationPolicies(member(tenantPolicies), {});
    expect(listed.some((policy) => policy.notificationKind === null && policy.maxAttempts === 8)).toBe(
      true,
    );
  });

  it('resolution: kind row → tenant default → built-in floor', async () => {
    const admin = policyAdmin(tenantPolicies);
    await setNotificationPolicy(admin, {
      notificationKind: null,
      deliveryClass: 'urgent',
      maxAttempts: 2,
      retryBackoffSeconds: 30,
      dedupeWindowSeconds: 60,
      digestWindowSeconds: 120,
      requireAcknowledgment: false,
    });
    await setNotificationPolicy(admin, {
      notificationKind: 'risk.detected',
      deliveryClass: 'escalation',
      maxAttempts: 4,
      retryBackoffSeconds: 45,
      dedupeWindowSeconds: 10,
      digestWindowSeconds: 60,
      requireAcknowledgment: true,
      escalationAfterSeconds: 300,
      escalationRecipient: { provider: 'sms', providerAccountId: '+15559990000' },
    });

    const fromKind = await resolveNotificationPolicy(member(tenantPolicies), {
      notificationKind: 'risk.detected',
    });
    expect(fromKind.source).toBe('kind');
    expect(fromKind.deliveryClass).toBe('escalation');
    expect(fromKind.escalationRecipient?.providerAccountId).toBe('+15559990000');

    const fromDefault = await resolveNotificationPolicy(member(tenantPolicies), {
      notificationKind: 'unknown.kind',
    });
    expect(fromDefault.source).toBe('tenant-default');
    expect(fromDefault.maxAttempts).toBe(2);

    // Another tenant resolves against the built-in floor (no leakage).
    const fromFloor = await resolveNotificationPolicy(member(tenantB), {
      notificationKind: 'risk.detected',
    });
    expect(fromFloor.source).toBe('built-in');
    expect(fromFloor.deliveryClass).toBe('urgent');

    await expectCode('invalid_policy_query', () =>
      resolveNotificationPolicy(member(tenantPolicies), {}),
    );
  });

  it('missing policies are uniformly not found (no cross-tenant leak)', async () => {
    await expectCode('policy_not_found', () =>
      getNotificationPolicy(member(tenantPolicies), { notificationKind: 'absent.kind' }),
    );
    await setNotificationPolicy(policyAdmin(tenantPolicies), {
      notificationKind: 'iso.kind',
      deliveryClass: 'urgent',
      maxAttempts: 3,
      retryBackoffSeconds: 60,
      dedupeWindowSeconds: 300,
      digestWindowSeconds: 3600,
      requireAcknowledgment: false,
    });
    await expectCode('policy_not_found', () =>
      getNotificationPolicy(member(tenantB), { notificationKind: 'iso.kind' }),
    );
  });

  it('the storage layer rejects incoherent escalation policy rows', async () => {
    await expect(
      getDb().query(
        `INSERT INTO notification_policies (
           tenant_id, notification_kind, delivery_class, max_attempts,
           retry_backoff_seconds, dedupe_window_seconds, digest_window_seconds,
           require_acknowledgment, escalation_after_seconds, escalation_recipient
         ) VALUES ($1, 'bad.escalation', 'escalation', 3, 60, 300, 3600, true, 300, NULL)`,
        [tenantPolicies],
      ),
    ).rejects.toThrow(/notification_policies_escalation_coherent/);
  });
});

// ---------------------------------------------------------------------------
// Urgent delivery
// ---------------------------------------------------------------------------

describe('urgent delivery', () => {
  it('delivers immediately through the channels contract and audits the attempt', async () => {
    const ctx = member(tenantUrgent);
    const result = await createNotification(ctx, {
      kind: 'approval.requested',
      recipient: EMAIL_RECIPIENT,
      subject: 'Approval requested: agent recruitment',
      body: 'Please review the proposed agent recruitment for the collections job.',
      data: { requestId: 'r-1' },
      correlationId: 'exec-42',
    });

    expect(result.deduped).toBe(false);
    const notification = result.notification;
    expect(notification.status).toBe('delivered');
    expect(notification.deliveryClass).toBe('urgent');
    expect(notification.policySource).toBe('built-in');
    expect(notification.maxAttempts).toBe(3);
    expect(notification.requireAcknowledgment).toBe(false);
    expect(notification.deliveredAt).toBe(new Date(BASE_TIME).toISOString());
    expect(notification.attemptsCount).toBe(1);
    expect(notification.actionRequestId).not.toBe(null);
    expect(notification.dedupedOfId).toBe(null);

    // The delivery went out over the provider-neutral transport.
    expect(transport.requests).toHaveLength(1);
    const request = transport.requests[0]!;
    expect(request.provider).toBe('email');
    expect(request.to.providerAccountId).toBe('manager@corp.example');
    expect(request.message.subject).toBe('Approval requested: agent recruitment');
    expect(request.message.text).toContain('agent recruitment');

    // The attempt audit: one approved, delivered, receipted attempt.
    const attempts = await listNotificationAttempts(ctx, { notificationId: notification.id });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.attemptKind).toBe('initial');
    expect(attempts[0]!.target).toBe('recipient');
    expect(attempts[0]!.outcome).toBe('delivered');
    expect(attempts[0]!.gateStatus).toBe('approved');
    expect(attempts[0]!.providerMessageId).not.toBe(null);
    expect(attempts[0]!.recipient.providerAccountId).toBe('manager@corp.example');

    // The channels contract recorded an immutable transcript turn (W029).
    const transcript = await listMessages(ctx, { channel: 'email', direction: 'outbound' });
    expect(transcript.length).toBeGreaterThanOrEqual(1);
    const payload = transcript[0]!.payload as { kind: string; content: { text: string } };
    expect(payload.kind).toBe('message');
    expect(payload.content.text).toContain('agent recruitment');

    // Listing filters work.
    const byStatus = await listNotifications(ctx, { status: 'delivered' });
    expect(byStatus.some((entry) => entry.id === notification.id)).toBe(true);
    const byKind = await listNotifications(ctx, { notificationKind: 'approval.requested' });
    expect(byKind).toHaveLength(1);
  });

  it('snapshots the resolved policy at creation (later edits do not rewrite it)', async () => {
    const admin = policyAdmin(tenantUrgent);
    await setNotificationPolicy(admin, {
      notificationKind: 'goal.drift',
      deliveryClass: 'urgent',
      maxAttempts: 7,
      retryBackoffSeconds: 11,
      dedupeWindowSeconds: 13,
      digestWindowSeconds: 17,
      requireAcknowledgment: false,
    });
    const first = await createNotification(member(tenantUrgent), {
      kind: 'goal.drift',
      recipient: SLACK_RECIPIENT,
      subject: 'Before edit',
      body: 'snapshot me',
    });
    expect(first.notification.maxAttempts).toBe(7);
    expect(first.notification.policySource).toBe('kind');

    await setNotificationPolicy(admin, {
      notificationKind: 'goal.drift',
      deliveryClass: 'digest',
      maxAttempts: 2,
      retryBackoffSeconds: 99,
      dedupeWindowSeconds: 99,
      digestWindowSeconds: 99,
      requireAcknowledgment: false,
    });
    const second = await createNotification(member(tenantUrgent), {
      kind: 'goal.drift',
      recipient: SLACK_RECIPIENT,
      subject: 'After edit',
      body: 'digest me',
    });
    expect(second.notification.deliveryClass).toBe('digest');
    expect(second.notification.status).toBe('pending'); // digest accumulates
    // The recorded first notification still carries its original snapshot.
    const reread = await getNotification(member(tenantUrgent), {
      notificationId: first.notification.id,
    });
    expect(reread.maxAttempts).toBe(7);
    expect(reread.deliveryClass).toBe('urgent');
    expect(reread.status).toBe('delivered');
  });
});

// ---------------------------------------------------------------------------
// Retries
// ---------------------------------------------------------------------------

describe('retries', () => {
  it('transient failures back off, retry within the budget, and succeed', async () => {
    await setNotificationPolicy(policyAdmin(tenantRetries), {
      notificationKind: 'supplier.alert',
      deliveryClass: 'urgent',
      maxAttempts: 3,
      retryBackoffSeconds: 30,
      dedupeWindowSeconds: 0,
      digestWindowSeconds: 60,
      requireAcknowledgment: false,
    });

    transport.script(
      { status: 'failed', providerMessageId: null, detail: 'upstream 503' },
      { status: 'failed', providerMessageId: null, detail: 'upstream 503 again' },
    );
    const ctx = member(tenantRetries);
    const created = await createNotification(ctx, {
      kind: 'supplier.alert',
      recipient: SLACK_RECIPIENT,
      subject: 'Supplier SLA breach',
      body: 'Supplier X missed the SLA.',
    });

    // First attempt failed transiently: pending, leased for the backoff.
    expect(created.notification.status).toBe('pending');
    expect(created.notification.attemptsCount).toBe(1);
    expect(created.notification.nextAttemptAt).toBe(new Date(BASE_TIME + 30_000).toISOString());

    // Too early: the pump does not pick it up.
    advance(10);
    const early = await retryDueNotifications(ctx, {});
    expect(early.processed).toBe(0);
    expect(early.delivered).toBe(0);

    // A second failure keeps it pending with one more attempt recorded.
    advance(20);
    const second = await retryDueNotifications(ctx, {});
    expect(second.processed).toBe(1);
    expect(second.delivered).toBe(0);
    expect(second.waiting).toBe(1);

    // Third attempt (unscripted) delivers.
    advance(30);
    const third = await retryDueNotifications(ctx, {});
    expect(third.delivered).toBe(1);

    const final = await getNotification(ctx, { notificationId: created.notification.id });
    expect(final.status).toBe('delivered');
    expect(final.attemptsCount).toBe(3);

    const attempts = await listNotificationAttempts(ctx, {
      notificationId: created.notification.id,
    });
    expect(attempts.map((attempt) => attempt.outcome)).toEqual([
      'transient_failure',
      'transient_failure',
      'delivered',
    ]);
    expect(attempts.map((attempt) => attempt.attemptKind)).toEqual(['initial', 'retry', 'retry']);
    expect(transport.requests).toHaveLength(3);
  });

  it('exhausted budgets fail terminally', async () => {
    await setNotificationPolicy(policyAdmin(tenantRetries), {
      notificationKind: 'flaky.kind',
      deliveryClass: 'urgent',
      maxAttempts: 2,
      retryBackoffSeconds: 5,
      dedupeWindowSeconds: 0,
      digestWindowSeconds: 60,
      requireAcknowledgment: false,
    });
    transport.script(
      { status: 'failed', providerMessageId: null, detail: 'nope' },
      { status: 'failed', providerMessageId: null, detail: 'nope again' },
    );
    const ctx = member(tenantRetries);
    const created = await createNotification(ctx, {
      kind: 'flaky.kind',
      recipient: SLACK_RECIPIENT,
      subject: 'Will exhaust',
      body: 'budget runs out',
    });
    expect(created.notification.status).toBe('pending');

    advance(5);
    const summary = await retryDueNotifications(ctx, {});
    expect(summary.failed).toBe(1);

    const final = await getNotification(ctx, { notificationId: created.notification.id });
    expect(final.status).toBe('failed');
    expect(final.attemptsCount).toBe(2);
    expect(final.nextAttemptAt).toBe(null);

    // Nothing further happens — the pump ignores terminal notifications.
    advance(60);
    const again = await retryDueNotifications(ctx, {});
    expect(again.processed).toBe(0);
    expect(transport.requests).toHaveLength(2);
  });

  it('the provider rejecting the delivery fails immediately (no retry burn)', async () => {
    transport.script({ status: 'rejected', providerMessageId: null, detail: 'recipient blocked' });
    const ctx = member(tenantRetries);
    const created = await createNotification(ctx, {
      kind: 'one.shot',
      recipient: SLACK_RECIPIENT,
      subject: 'Rejected',
      body: 'bad recipient',
    });
    expect(created.notification.status).toBe('failed');
    expect(created.notification.attemptsCount).toBe(1);
    const attempts = await listNotificationAttempts(ctx, {
      notificationId: created.notification.id,
    });
    expect(attempts[0]!.outcome).toBe('permanent_failure');
    expect(attempts[0]!.detail).toContain('recipient blocked');
    expect(transport.requests).toHaveLength(1);
  });

  it('missing connection configuration is retryable and recovers', async () => {
    // tenantNoConnection has NO slack connection: delivery fails
    // transiently (connection_not_found), then recovers once configured.
    const ctx = member(tenantNoConnection);
    const created = await createNotification(ctx, {
      kind: 'config.later',
      recipient: SLACK_RECIPIENT,
      subject: 'Waiting for configuration',
      body: 'no connection yet',
    });
    expect(created.notification.status).toBe('pending');
    const attempts = await listNotificationAttempts(ctx, {
      notificationId: created.notification.id,
    });
    expect(attempts[0]!.outcome).toBe('transient_failure');

    await registerChannelConnection(ctx, {
      provider: 'slack',
      providerAccountId: 'AURUMLATE',
      credentialRef: 'secret-store://slack',
    });
    advance(60); // built-in backoff
    const summary = await retryDueNotifications(ctx, {});
    expect(summary.delivered).toBe(1);
    const final = await getNotification(ctx, { notificationId: created.notification.id });
    expect(final.status).toBe('delivered');
  });
});

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

describe('dedupe', () => {
  it('duplicates inside the window are suppressed (audited, never delivered)', async () => {
    await setNotificationPolicy(policyAdmin(tenantDedupe), {
      notificationKind: 'duplicate.prone',
      deliveryClass: 'urgent',
      maxAttempts: 3,
      retryBackoffSeconds: 60,
      dedupeWindowSeconds: 300,
      digestWindowSeconds: 3600,
      requireAcknowledgment: false,
    });
    const ctx = member(tenantDedupe);
    const input = {
      kind: 'duplicate.prone',
      recipient: SLACK_RECIPIENT,
      subject: 'Same event',
      body: 'event 42 happened',
      dedupeKey: 'event:42',
    };

    const original = await createNotification(ctx, input);
    expect(original.deduped).toBe(false);
    expect(original.notification.status).toBe('delivered');

    const duplicate = await createNotification(ctx, input);
    expect(duplicate.deduped).toBe(true);
    expect(duplicate.notification.status).toBe('suppressed');
    expect(duplicate.notification.dedupedOfId).toBe(original.notification.id);
    expect(duplicate.notification.deliveredAt).toBe(null);

    // Only ONE delivery ever went out for the pair.
    expect(transport.requests).toHaveLength(1);

    // A different recipient, kind or key is NOT a duplicate.
    const otherRecipient = await createNotification(ctx, {
      ...input,
      recipient: { provider: 'slack', providerAccountId: 'U999OTHER' },
    });
    expect(otherRecipient.deduped).toBe(false);
    const otherKey = await createNotification(ctx, { ...input, dedupeKey: 'event:43' });
    expect(otherKey.deduped).toBe(false);
    expect(transport.requests).toHaveLength(3);

    // Suppressed duplicates are listable for audit.
    const suppressed = await listNotifications(ctx, { status: 'suppressed' });
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]!.dedupeKey).toBe('event:42');
  });

  it('a new cycle starts once the window has fully elapsed', async () => {
    await setNotificationPolicy(policyAdmin(tenantDedupe), {
      notificationKind: 'window.bound',
      deliveryClass: 'urgent',
      maxAttempts: 3,
      retryBackoffSeconds: 60,
      dedupeWindowSeconds: 120,
      digestWindowSeconds: 3600,
      requireAcknowledgment: false,
    });
    const ctx = member(tenantDedupe);
    const input = {
      kind: 'window.bound',
      recipient: SLACK_RECIPIENT,
      subject: 'Cycle',
      body: 'window semantics',
      dedupeKey: 'cycle:1',
    };

    const first = await createNotification(ctx, input);
    advance(119);
    const insideWindow = await createNotification(ctx, input);
    expect(insideWindow.deduped).toBe(true);

    advance(1); // exactly at the boundary: the window is closed
    const afterWindow = await createNotification(ctx, input);
    expect(afterWindow.deduped).toBe(false);
    expect(afterWindow.notification.status).toBe('delivered');
    expect(transport.requests).toHaveLength(2);

    // Suppressed rows never extend the window: the third create matched
    // the FIRST notification (created at BASE_TIME), not the suppressed
    // duplicate at BASE_TIME+119s.
    expect(afterWindow.notification.dedupedOfId).toBe(null);
    expect(first.notification.status).toBe('delivered');
  });

  it('a zero dedupe window disables dedupe', async () => {
    await setNotificationPolicy(policyAdmin(tenantDedupe), {
      notificationKind: 'no.dedupe',
      deliveryClass: 'urgent',
      maxAttempts: 3,
      retryBackoffSeconds: 60,
      dedupeWindowSeconds: 0,
      digestWindowSeconds: 3600,
      requireAcknowledgment: false,
    });
    const ctx = member(tenantDedupe);
    const input = {
      kind: 'no.dedupe',
      recipient: SLACK_RECIPIENT,
      subject: 'Every one',
      body: 'delivered',
      dedupeKey: 'always:new',
    };
    await createNotification(ctx, input);
    await createNotification(ctx, input);
    expect(transport.requests).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

describe('digest', () => {
  it('accumulates per (kind, recipient) and delivers one combined message per window', async () => {
    await setNotificationPolicy(policyAdmin(tenantDigest), {
      notificationKind: 'goal.digest',
      deliveryClass: 'digest',
      maxAttempts: 3,
      retryBackoffSeconds: 30,
      dedupeWindowSeconds: 0,
      digestWindowSeconds: 60,
      requireAcknowledgment: false,
    });
    const ctx = member(tenantDigest);
    const subjects = ['Revenue drift', 'Margin drift', 'Churn drift'];
    for (const [index, subject] of subjects.entries()) {
      const created = await createNotification(ctx, {
        kind: 'goal.digest',
        recipient: EMAIL_RECIPIENT,
        subject,
        body: `Detail ${index} about the drift.`,
      });
      expect(created.notification.status).toBe('pending');
      expect(created.notification.deliveryClass).toBe('digest');
    }
    // Nothing delivered before the window closes.
    expect(transport.requests).toHaveLength(0);
    const notYetDue = await flushDueDigests(ctx, {});
    expect(notYetDue.groups).toBe(0);

    advance(60);
    const summary = await flushDueDigests(ctx, {});
    expect(summary.groups).toBe(1);
    expect(summary.delivered).toBe(1);
    expect(summary.membersDelivered).toBe(3);

    // ONE combined message: header + every member line.
    expect(transport.requests).toHaveLength(1);
    const request = transport.requests[0]!;
    expect(request.message.subject).toBe('Digest: goal.digest (3 notifications)');
    expect(request.message.text).toContain("Digest of 'goal.digest' — 3 notifications:");
    for (const subject of subjects) {
      expect(request.message.text).toContain(subject);
    }
    expect(request.message.text).toContain('Detail 1 about the drift.');

    // Every member reached `delivered` with a digest attempt row.
    const delivered = await listNotifications(ctx, { status: 'delivered' });
    expect(delivered).toHaveLength(3);
    const attempts = await listNotificationAttempts(ctx, { notificationId: delivered[0]!.id });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.attemptKind).toBe('digest');
    expect(attempts[0]!.outcome).toBe('delivered');
    expect(attempts[0]!.providerMessageId).not.toBe(null);

    // A later window starts a fresh cycle.
    advance(60);
    await createNotification(ctx, {
      kind: 'goal.digest',
      recipient: EMAIL_RECIPIENT,
      subject: 'Late drift',
      body: 'arrived after the flush',
    });
    const second = await flushDueDigests(ctx, {});
    expect(second.groups).toBe(0); // the new cycle's window just started
    advance(60);
    const third = await flushDueDigests(ctx, {});
    expect(third.delivered).toBe(1);
    expect(third.membersDelivered).toBe(1);
    expect(transport.requests).toHaveLength(2);
  });

  it('digest cycles are keyed per (kind, recipient) and capped per batch', async () => {
    await setNotificationPolicy(policyAdmin(tenantDigest), {
      notificationKind: 'cap.kind',
      deliveryClass: 'digest',
      maxAttempts: 3,
      retryBackoffSeconds: 30,
      dedupeWindowSeconds: 0,
      digestWindowSeconds: 60,
      requireAcknowledgment: false,
    });
    const ctx = member(tenantDigest);
    for (let index = 0; index < 20; index += 1) {
      await createNotification(ctx, {
        kind: 'cap.kind',
        recipient: SLACK_RECIPIENT,
        subject: `Member ${index}`,
        body: `Body ${index}`,
      });
    }
    // A different recipient with the same kind is its own cycle.
    await createNotification(ctx, {
      kind: 'cap.kind',
      recipient: { provider: 'slack', providerAccountId: 'U111OTHER' },
      subject: 'Other recipient',
      body: 'separate cycle',
    });

    advance(60);
    const summary = await flushDueDigests(ctx, { limit: 10 });
    // Two groups (two recipients); the shared-recipient batch capped at 16.
    expect(summary.groups).toBe(2);
    expect(summary.delivered).toBe(2);
    expect(summary.membersDelivered).toBe(17);

    const stillPending = await listNotifications(ctx, { status: 'pending' });
    expect(stillPending).toHaveLength(4);
    // The leftovers are due immediately (their cycle elapsed); a second
    // pass flushes them as their own batch.
    const second = await flushDueDigests(ctx, {});
    expect(second.membersDelivered).toBe(4);
    expect(await listNotifications(ctx, { status: 'pending' })).toHaveLength(0);
  });

  it('digest flush failures are audited and retried within the budget', async () => {
    await setNotificationPolicy(policyAdmin(tenantDigest), {
      notificationKind: 'digest.retry',
      deliveryClass: 'digest',
      maxAttempts: 2,
      retryBackoffSeconds: 15,
      dedupeWindowSeconds: 0,
      digestWindowSeconds: 30,
      requireAcknowledgment: false,
    });
    const ctx = member(tenantDigest);
    await createNotification(ctx, {
      kind: 'digest.retry',
      recipient: SLACK_RECIPIENT,
      subject: 'Digest retry',
      body: 'flush will fail first',
    });
    advance(30);
    transport.script({ status: 'failed', providerMessageId: null, detail: 'flush 503' });
    const first = await flushDueDigests(ctx, {});
    expect(first.delivered).toBe(0);
    expect(first.membersWaiting).toBe(1);

    // The members stay pending under the backoff lease.
    const pending = await listNotifications(ctx, { status: 'pending' });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.nextAttemptAt).not.toBe(null);
    const attempts = await listNotificationAttempts(ctx, { notificationId: pending[0]!.id });
    expect(attempts[0]!.attemptKind).toBe('digest');
    expect(attempts[0]!.outcome).toBe('transient_failure');

    advance(15);
    const second = await flushDueDigests(ctx, {});
    expect(second.delivered).toBe(1);
    expect(second.membersDelivered).toBe(1);
    expect(transport.requests).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Escalation + acknowledgment
// ---------------------------------------------------------------------------

describe('escalation and acknowledgment', () => {
  const ESCALATION_FALLBACK = {
    provider: 'email' as const,
    providerAccountId: 'duty-manager@corp.example',
  };

  const ESCALATION_INPUT = {
    kind: 'risk.critical',
    recipient: SLACK_RECIPIENT,
    subject: 'Critical risk detected',
    body: 'The supplier missed the contractual SLA for the second time.',
  };

  async function escalationPolicy(kind = 'risk.critical'): Promise<void> {
    await setNotificationPolicy(policyAdmin(tenantEscalation), {
      notificationKind: kind,
      deliveryClass: 'escalation',
      maxAttempts: 3,
      retryBackoffSeconds: 10,
      dedupeWindowSeconds: 0,
      digestWindowSeconds: 60,
      requireAcknowledgment: true,
      escalationAfterSeconds: 30,
      escalationRecipient: ESCALATION_FALLBACK,
    });
  }

  it('delivers immediately; unacknowledged escalation-class notifications escalate past the deadline', async () => {
    await escalationPolicy();
    const ctx = member(tenantEscalation);
    const created = await createNotification(ctx, ESCALATION_INPUT);
    expect(created.notification.status).toBe('delivered');
    expect(created.notification.deliveryClass).toBe('escalation');
    expect(created.notification.requireAcknowledgment).toBe(true);
    expect(created.notification.escalationAfterSeconds).toBe(30);
    expect(created.notification.escalationRecipient?.providerAccountId).toBe(
      'duty-manager@corp.example',
    );

    // Before the deadline nothing escalates.
    advance(29);
    const early = await escalateUnacknowledged(ctx, {});
    expect(early.escalatedCandidates).toBe(0);
    expect(transport.requests).toHaveLength(1);

    // At the deadline the escalation fires at the fallback recipient.
    advance(1);
    const summary = await escalateUnacknowledged(ctx, {});
    expect(summary.escalatedCandidates).toBe(1);
    expect(summary.escalated).toBe(1);

    const final = await getNotification(ctx, { notificationId: created.notification.id });
    expect(final.status).toBe('escalated');
    expect(final.escalatedAt).toBe(new Date(BASE_TIME + 30_000).toISOString());
    expect(final.escalationActionRequestId).not.toBe(null);

    // Two deliveries: the original (slack) and the escalation (email —
    // a different provider, so the escalation auto-selects that
    // provider's connection instead of reusing the original's).
    expect(transport.requests).toHaveLength(2);
    const escalationSend = transport.requests[1]!;
    expect(escalationSend.provider).toBe('email');
    expect(escalationSend.to.providerAccountId).toBe('duty-manager@corp.example');
    expect(escalationSend.message.subject).toBe(`Escalation: ${ESCALATION_INPUT.subject}`);
    expect(escalationSend.message.text).toContain(ESCALATION_INPUT.body);
    expect(escalationSend.message.text).toContain('unacknowledged after 30 seconds');
    expect(escalationSend.message.text).toContain('slack:U777OPER');

    // The audit shows both attempts against their own targets.
    const attempts = await listNotificationAttempts(ctx, {
      notificationId: created.notification.id,
    });
    expect(attempts.map((attempt) => [attempt.attemptKind, attempt.target, attempt.outcome])).toEqual([
      ['initial', 'recipient', 'delivered'],
      ['escalation', 'escalation', 'delivered'],
    ]);

    // Escalation happens exactly once.
    advance(120);
    const again = await escalateUnacknowledged(ctx, {});
    expect(again.escalatedCandidates).toBe(0);
    expect(transport.requests).toHaveLength(2);
  });

  it('acknowledgment before the deadline prevents escalation; late acknowledgment still lands', async () => {
    await escalationPolicy('risk.ack.first');
    const ctx = member(tenantEscalation);
    const created = await createNotification(ctx, {
      ...ESCALATION_INPUT,
      kind: 'risk.ack.first',
      subject: 'Will be acknowledged',
    });
    advance(10);
    const ack = await acknowledgeNotification(ctx, {
      notificationId: created.notification.id,
      note: 'On it — contacting the supplier.',
    });
    expect(ack.acknowledgedBy).toBe(ctx.principalId);
    expect(ack.note).toBe('On it — contacting the supplier.');

    advance(60);
    const summary = await escalateUnacknowledged(ctx, {});
    expect(summary.escalatedCandidates).toBe(0);
    const final = await getNotification(ctx, { notificationId: created.notification.id });
    expect(final.status).toBe('delivered');
    expect(final.escalatedAt).toBe(null);
    expect(transport.requests).toHaveLength(1);

    // The acknowledgment is readable back and first-wins.
    const read = await getNotificationAcknowledgment(ctx, {
      notificationId: created.notification.id,
    });
    expect(read?.id).toBe(ack.id);
    await expectCode('already_acknowledged', () =>
      acknowledgeNotification(member(tenantEscalation), {
        notificationId: created.notification.id,
      }),
    );
  });

  it('acknowledgment is possible after escalation and stops escalation retries', async () => {
    await escalationPolicy('risk.ack.late');
    const ctx = member(tenantEscalation);
    const created = await createNotification(ctx, {
      ...ESCALATION_INPUT,
      kind: 'risk.ack.late',
      subject: 'Late ack',
    });
    advance(30);
    await escalateUnacknowledged(ctx, {});
    const ack = await acknowledgeNotification(ctx, { notificationId: created.notification.id });
    expect(ack).not.toBe(null);
    const final = await getNotification(ctx, { notificationId: created.notification.id });
    expect(final.status).toBe('escalated');
    expect(final.acknowledgedAt).not.toBe(null);
  });

  it('escalation delivery retries within its own budget', async () => {
    await setNotificationPolicy(policyAdmin(tenantEscalation), {
      notificationKind: 'risk.flaky',
      deliveryClass: 'escalation',
      maxAttempts: 2,
      retryBackoffSeconds: 10,
      dedupeWindowSeconds: 0,
      digestWindowSeconds: 60,
      requireAcknowledgment: true,
      escalationAfterSeconds: 30,
      escalationRecipient: { provider: 'sms', providerAccountId: '+15559990000' },
    });
    const ctx = member(tenantEscalation);
    const created = await createNotification(ctx, {
      ...ESCALATION_INPUT,
      kind: 'risk.flaky',
      subject: 'Flaky escalation',
    });
    advance(30);
    transport.script({ status: 'failed', providerMessageId: null, detail: 'sms 503' });
    const first = await escalateUnacknowledged(ctx, {});
    expect(first.escalated).toBe(0);
    expect(first.waiting).toBe(1);
    let current = await getNotification(ctx, { notificationId: created.notification.id });
    expect(current.status).toBe('escalating');
    expect(current.escalationAttemptsCount).toBe(1);

    // The escalation retry rides the retry pump.
    advance(10);
    const retry = await retryDueNotifications(ctx, {});
    expect(retry.escalationsProcessed).toBe(1);
    expect(retry.escalated).toBe(1);
    current = await getNotification(ctx, { notificationId: created.notification.id });
    expect(current.status).toBe('escalated');

    const attempts = await listNotificationAttempts(ctx, {
      notificationId: created.notification.id,
    });
    expect(attempts.map((attempt) => attempt.attemptKind)).toEqual([
      'initial',
      'escalation',
      'escalation',
    ]);
  });

  it('acknowledgment rules: not required, and not acknowledgeable before delivery', async () => {
    const admin = policyAdmin(tenantAck);
    // requires acknowledgment, but is a digest — nothing delivered yet.
    await setNotificationPolicy(admin, {
      notificationKind: 'ack.digest',
      deliveryClass: 'digest',
      maxAttempts: 3,
      retryBackoffSeconds: 10,
      dedupeWindowSeconds: 0,
      digestWindowSeconds: 3600,
      requireAcknowledgment: true,
    });
    const ctx = member(tenantAck);
    const digestCreated = await createNotification(ctx, {
      kind: 'ack.digest',
      recipient: SLACK_RECIPIENT,
      subject: 'Pending digest',
      body: 'not delivered yet',
    });
    await expectCode('notification_not_acknowledgeable', () =>
      acknowledgeNotification(ctx, { notificationId: digestCreated.notification.id }),
    );

    // Built-in kinds do not require acknowledgment.
    const plain = await createNotification(ctx, {
      kind: 'plain.info',
      recipient: SLACK_RECIPIENT,
      subject: 'No ack needed',
      body: 'informational',
    });
    await expectCode('acknowledgment_not_required', () =>
      acknowledgeNotification(ctx, { notificationId: plain.notification.id }),
    );
    expect(await getNotificationAcknowledgment(ctx, { notificationId: plain.notification.id })).toBe(
      null,
    );
  });
});

// ---------------------------------------------------------------------------
// The W009 authority gate
// ---------------------------------------------------------------------------

describe('the authority gate (W009)', () => {
  it('approval_required holds delivery until a human approves; the pump re-checks the SAME request', async () => {
    const admin = actionsAdmin(tenantGate);
    const ctx = member(tenantGate);

    // Gate ASK of 'notification-delivery' behind human approval.
    await setAuthorityPolicy(admin, {
      actionKind: 'notification-delivery',
      approvalLevels: ['ASK'],
      forbiddenLevels: [],
    });

    const created = await createNotification(ctx, {
      kind: 'gate.gated',
      recipient: SLACK_RECIPIENT,
      subject: 'Held by the gate',
      body: 'waiting for approval',
    });
    expect(created.notification.status).toBe('pending');
    expect(created.notification.deliveredAt).toBe(null);
    expect(created.notification.actionRequestId).not.toBe(null);
    // Nothing was sent and nothing was attempted — the gate decided first.
    expect(transport.requests).toHaveLength(0);
    expect(
      await listNotificationAttempts(ctx, { notificationId: created.notification.id }),
    ).toHaveLength(0);

    const request = await getActionRequest(ctx, { requestId: created.notification.actionRequestId! });
    expect(request.status).toBe('pending');
    expect(request.actionKind).toBe('notification-delivery');
    expect(request.authorityLevel).toBe('ASK');

    // The pump re-checks but the request is still pending.
    const held = await retryDueNotifications(ctx, {});
    expect(held.processed).toBe(1);
    expect(held.waiting).toBe(1);
    expect(transport.requests).toHaveLength(0);

    // A DIFFERENT principal (separation of duties) approves.
    const decision = await decideApproval(approver(tenantGate), {
      requestId: request.id,
      decision: 'approve',
    });
    expect(decision.status).toBe('approved');

    // The pump delivers — without creating a second gate request.
    const released = await retryDueNotifications(ctx, {});
    expect(released.delivered).toBe(1);
    const final = await getNotification(ctx, { notificationId: created.notification.id });
    expect(final.status).toBe('delivered');

    const gateRequests = await listActionRequests(ctx, { actionKind: 'notification-delivery' });
    const forThisNotification = gateRequests.filter(
      (entry) => entry.id === created.notification.actionRequestId,
    );
    expect(forThisNotification).toHaveLength(1);
    expect(transport.requests).toHaveLength(1);
  });

  it('a forbidden level blocks the notification and records why', async () => {
    const admin = actionsAdmin(tenantGate);
    const ctx = member(tenantGate);
    await setAuthorityPolicy(admin, {
      actionKind: 'notification-delivery',
      approvalLevels: [],
      forbiddenLevels: ['ASK'],
    });

    const created = await createNotification(ctx, {
      kind: 'gate.blocked',
      recipient: SLACK_RECIPIENT,
      subject: 'Forbidden',
      body: 'never sent',
    });
    expect(created.notification.status).toBe('blocked');
    expect(created.notification.deliveredAt).toBe(null);
    expect(transport.requests).toHaveLength(0);

    const attempts = await listNotificationAttempts(ctx, {
      notificationId: created.notification.id,
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.outcome).toBe('blocked');
    expect(attempts[0]!.gateStatus).toBe('rejected');
    expect(attempts[0]!.detail).toContain('notification-delivery');

    // Blocked is terminal — the pump ignores it.
    advance(120);
    const pump = await retryDueNotifications(ctx, {});
    expect(pump.processed).toBe(0);
  });

  it('the escalation delivery is gated independently at escalation time', async () => {
    const admin = actionsAdmin(tenantGate);
    const ctx = member(tenantGate);
    // Allow delivery again for the original send.
    await setAuthorityPolicy(admin, {
      actionKind: 'notification-delivery',
      approvalLevels: [],
      forbiddenLevels: [],
    });
    await setNotificationPolicy(policyAdmin(tenantGate), {
      notificationKind: 'gate.escalation',
      deliveryClass: 'escalation',
      maxAttempts: 3,
      retryBackoffSeconds: 10,
      dedupeWindowSeconds: 0,
      digestWindowSeconds: 60,
      requireAcknowledgment: true,
      escalationAfterSeconds: 30,
      escalationRecipient: { provider: 'sms', providerAccountId: '+15559990000' },
    });

    const created = await createNotification(ctx, {
      kind: 'gate.escalation',
      recipient: SLACK_RECIPIENT,
      subject: 'Escalation will be blocked',
      body: 'delivered, never escalated',
    });
    expect(created.notification.status).toBe('delivered');

    // Policy tightens between delivery and the escalation deadline: the
    // escalation is authorized against the CURRENT matrix.
    await setAuthorityPolicy(admin, {
      actionKind: 'notification-delivery',
      approvalLevels: [],
      forbiddenLevels: ['ASK'],
    });
    advance(30);
    const summary = await escalateUnacknowledged(ctx, {});
    expect(summary.escalatedCandidates).toBe(1);
    expect(summary.escalationFailed).toBe(1);

    const final = await getNotification(ctx, { notificationId: created.notification.id });
    expect(final.status).toBe('escalation_failed');
    expect(final.escalatedAt).toBe(null);
    expect(transport.requests).toHaveLength(1); // only the original delivery

    const attempts = await listNotificationAttempts(ctx, {
      notificationId: created.notification.id,
    });
    expect(attempts[1]!.attemptKind).toBe('escalation');
    expect(attempts[1]!.target).toBe('escalation');
    expect(attempts[1]!.outcome).toBe('blocked');
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('tenant isolation (ADR-0001)', () => {
  it("another tenant's notifications, attempts and acknowledgments are indistinguishable from missing", async () => {
    const ctx = member(tenantIsolation);
    const created = await createNotification(ctx, {
      kind: 'iso.kind',
      recipient: SLACK_RECIPIENT,
      subject: 'Isolated',
      body: 'tenant-scoped',
    });
    const notificationId = created.notification.id;
    expect(created.notification.status).toBe('delivered');

    const foreign = member(tenantB);
    await expectCode('notification_not_found', () =>
      getNotification(foreign, { notificationId }),
    );
    await expectCode('notification_not_found', () =>
      listNotificationAttempts(foreign, { notificationId }),
    );
    await expectCode('notification_not_found', () =>
      acknowledgeNotification(foreign, { notificationId }),
    );
    await expectCode('notification_not_found', () =>
      getNotificationAcknowledgment(foreign, { notificationId }),
    );
    // Foreign pumps never see the notification either.
    expect((await retryDueNotifications(foreign, {})).processed).toBe(0);
    expect((await flushDueDigests(foreign, {})).groups).toBe(0);
    expect((await escalateUnacknowledged(foreign, {})).escalatedCandidates).toBe(0);
    // Foreign lists show nothing.
    expect(await listNotifications(foreign, { notificationKind: 'iso.kind' })).toHaveLength(0);
  });

  it('notifications carry tenant scoping at the storage layer', async () => {
    await createNotification(member(tenantIsolation), {
      kind: 'iso.kind',
      recipient: SLACK_RECIPIENT,
      subject: 'Storage scoped',
      body: 'tenant_id everywhere',
    });
    const rows = await getDb().query<{ tenant_id: string }>(
      `SELECT tenant_id FROM notifications WHERE notification_kind = 'iso.kind'`,
    );
    expect(rows.rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.rows.every((row) => row.tenant_id === tenantIsolation)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Storage discipline
// ---------------------------------------------------------------------------

describe('storage discipline', () => {
  it('notifications: only lifecycle state may move (UPDATE of substantive fields, DELETE, TRUNCATE rejected)', async () => {
    const ctx = member(tenantStorage);
    const created = await createNotification(ctx, {
      kind: 'immutable.kind',
      recipient: SLACK_RECIPIENT,
      subject: 'Immutable history',
      body: 'substantive fields never change',
      data: { keep: true },
    });
    const id = created.notification.id;
    const db = getDb();

    await expect(
      db.query(`UPDATE notifications SET subject = 'hacked' WHERE tenant_id = $1 AND id = $2`, [
        tenantStorage,
        id,
      ]),
    ).rejects.toThrow(/immutable history/);
    await expect(
      db.query(`UPDATE notifications SET body = 'hacked' WHERE tenant_id = $1 AND id = $2`, [
        tenantStorage,
        id,
      ]),
    ).rejects.toThrow(/immutable history/);
    await expect(
      db.query(`UPDATE notifications SET delivery_class = 'digest' WHERE tenant_id = $1 AND id = $2`, [
        tenantStorage,
        id,
      ]),
    ).rejects.toThrow(/immutable history/);
    await expect(
      db.query(`DELETE FROM notifications WHERE tenant_id = $1 AND id = $2`, [tenantStorage, id]),
    ).rejects.toThrow(/immutable history/);
    await expect(db.query(`TRUNCATE notifications`)).rejects.toThrow(/immutable history/);

    // The lifecycle state DID move (delivered) and still reads correctly.
    const reread = await getNotification(ctx, { notificationId: id });
    expect(reread.status).toBe('delivered');
    expect(reread.subject).toBe('Immutable history');
  });

  it('notification_attempts and notification_acknowledgments are append-only', async () => {
    const ctx = member(tenantStorage);
    const created = await createNotification(ctx, {
      kind: 'audit.kind',
      recipient: SLACK_RECIPIENT,
      subject: 'Audit trail',
      body: 'append-only evidence',
    });
    const notificationId = created.notification.id;
    const db = getDb();

    const attempt = await db.query<{ id: string }>(
      `SELECT id FROM notification_attempts WHERE tenant_id = $1 AND notification_id = $2`,
      [tenantStorage, notificationId],
    );
    expect(attempt.rows).toHaveLength(1);
    const attemptId = attempt.rows[0]!.id;
    await expect(
      db.query(`UPDATE notification_attempts SET detail = 'rewritten' WHERE id = $1`, [attemptId]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`DELETE FROM notification_attempts WHERE id = $1`, [attemptId]),
    ).rejects.toThrow(/append-only/);
    await expect(db.query(`TRUNCATE notification_attempts`)).rejects.toThrow(/append-only/);

    const ack = await db.query<{ id: string }>(
      `SELECT id FROM notification_acknowledgments WHERE tenant_id = $1 AND notification_id = $2`,
      [tenantStorage, notificationId],
    );
    expect(ack.rows).toHaveLength(0); // nothing to acknowledge (built-in policy)
    await expect(db.query(`TRUNCATE notification_acknowledgments`)).rejects.toThrow(/append-only/);
  });

  it('the acknowledgment table enforces first-wins at the storage level', async () => {
    const db = getDb();
    await expect(
      db.query(
        `INSERT INTO notification_acknowledgments (tenant_id, notification_id, acknowledged_by, acknowledged_at)
         SELECT tenant_id, id, 'ghost-acker', now() FROM notifications WHERE tenant_id = $1 AND status = 'delivered'`,
        [tenantStorage],
      ),
    ).resolves.toBeTruthy();
    await expect(
      db.query(
        `INSERT INTO notification_acknowledgments (tenant_id, notification_id, acknowledged_by, acknowledged_at)
         SELECT tenant_id, id, 'second-acker', now() FROM notifications WHERE tenant_id = $1 AND status = 'delivered'`,
        [tenantStorage],
      ),
    ).rejects.toThrow(/notification_acknowledgments_first_wins/);
  });
});

// ---------------------------------------------------------------------------
// Public-surface isolation
// ---------------------------------------------------------------------------

describe('public-surface isolation', () => {
  it('exports no service internals through the public contract', () => {
    const exported = Object.keys(notificationsContract);
    const forbidden = [
      'findNotificationRow',
      'authorizeDeliveryGate',
      'attemptOriginalDelivery',
      'attemptEscalationDelivery',
      'recordAttempt',
      'recordGateRequest',
      'sendThroughChannel',
      'lookupPolicyRow',
      'resolvePolicy',
    ];
    for (const symbol of forbidden) {
      expect(exported, symbol).not.toContain(symbol);
    }
  });
});
