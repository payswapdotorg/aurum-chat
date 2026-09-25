// Integration tests for the cellular module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W087
// acceptance:
// "manager can tell Aurum 'Tell Sarah …'; Aurum resolves Sarah; sends
//  SMS when reachable; falls back to voice when policy permits; recipient
//  reply can return into Aurum; failed delivery is visible and retryable;
//  manager can optionally initiate an SMS/voice request to Aurum itself
//  when the manager has no usable Internet data."
//
//  * connections — creation, idempotent re-registration as the
//    re-authorization path, uniform cross-tenant not-found (ADR-0001),
//    disabled connections refusing delivery, ambiguity precision;
//  * policies — the administer claim, kind/default rows, resolution
//    order, the built-in floor;
//  * THE GOLDEN JOURNEY — "Tell Sarah": person resolution through the
//    VERIFIED phone identity (W002; lock 15 — unverified never resolves),
//    the W009 authority gate (allowed / approval_required → human
//    approval between pumps unlocks delivery / forbidden → blocked),
//    the SMS leg, carrier delivery receipts (delivered / undelivered →
//    budgeted retry), the VOICE FALLBACK (placed exactly when the policy
//    permits; answered / no-answer / placement failure), replies
//    returning into Aurum through the channels contract's canonical
//    inbound edge (transcript turn + on-sight identity + correlation),
//    and the manager-originated inbound path (a manager with no usable
//    Internet data texting/calling Aurum's own number);
//  * failed delivery is visible (failure code + optional W031 failure
//    notification to the asking manager) and retryable (a new delivery
//    cycle whose cost still obeys the lifetime cap);
//  * cost controls — the policy's segment rate and lifetime cap;
//  * dedupe — provider event redelivery applies exactly once (the
//    ledger row is the claim); carrier events referencing no attempt of
//    this tenant are observed, never errors;
//  * provider swap (GOVERNANCE evidence) — the same canonical journey
//    through twilio and telnyx yields identical canonical domain state
//    modulo the provider key and opaque ids, and the transport port
//    observes only provider-neutral requests;
//  * tenant isolation — another tenant's cellular state is
//    indistinguishable from missing; foreign event envelopes resolve to
//    nothing;
//  * storage discipline — reach requests' substantive fields, attempts,
//    replies and events are append-only/immutable at the storage level
//    (triggers).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.BLOB_READ_WRITE_TOKEN;

import * as cellularContract from '../contract';
import {
  attestIdentity,
  attachVerifiedSubject,
  getExternalIdentity,
  registerExternalIdentity,
} from '@/modules/identity/contract';
import { createEmployee, createPerson } from '@/modules/people/contract';
import { decideApproval, setAuthorityPolicy } from '@/modules/actions/contract';
import { listNotifications } from '@/modules/notifications/contract';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from '@/infra/clock';
import { closeDb, getDb, type DbRow } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { CellularError } from '../errors';
import { runMigrations } from '../../../../scripts/migrate';
import type {
  CellularProvider,
  CellularSmsRequest,
  CellularTransport,
  CellularVoiceRequest,
} from '../types';

const {
  getCellularConnection,
  getCellularReach,
  listCellularAttempts,
  listCellularConnections,
  listCellularEvents,
  listCellularReach,
  listCellularReplies,
  pumpCellularReach,
  reachAnyone,
  receiveCellularEvent,
  registerCellularConnection,
  retryCellularReach,
  setCellularConnectionStatus,
  setCellularPolicy,
  setCellularTransport,
} = cellularContract;

// Dedicated tenants per group so count/order assertions stay deterministic.
const tenantConnections = newId();
const tenantPolicies = newId();
const tenantGolden = newId();
const tenantVoice = newId();
const tenantManager = newId();
const tenantGate = newId();
const tenantFailure = newId();
const tenantCost = newId();
const tenantDedupe = newId();
const tenantSwap = newId();
const tenantIsolation = newId();
const tenantStorage = newId();
const tenantB = newId();

const BASE_TIME = Date.parse('2026-09-25T10:00:00Z');
let clockMs = BASE_TIME;

function member(tenantId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId: newId(), authority };
}

function admin(tenantId: string, extra: string[] = []): TenantContext {
  return member(tenantId, ['identity:attest', 'identity:link', ...extra]);
}

async function expectCode(
  code: CellularError['code'],
  fn: () => Promise<unknown> | unknown,
): Promise<void> {
  try {
    await fn();
    throw new Error(`expected CellularError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof CellularError)) throw error;
    expect(error.code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// The scripted transports (provider-neutral; records every request)
// ---------------------------------------------------------------------------

class ScriptedCellularTransport implements CellularTransport {
  readonly provider: CellularProvider;
  readonly smsRequests: CellularSmsRequest[] = [];
  readonly voiceRequests: CellularVoiceRequest[] = [];
  smsOutcome: 'accepted' | 'rejected' | 'failed' = 'accepted';
  voiceOutcome: 'answered' | 'no_answer' | 'failed' = 'answered';
  /** Unique per instance: vendors guarantee provider id uniqueness per account. */
  private readonly idPrefix = newId().slice(0, 8);
  private messageSeq = 0;
  private callSeq = 0;

  constructor(provider: CellularProvider = 'twilio') {
    this.provider = provider;
  }

  /** The provider message id of this transport's n-th accepted SMS send. */
  messageId(n: number): string {
    return `SM_${this.idPrefix}_${n}`;
  }

  /** The provider call id of this transport's n-th placed call. */
  callId(n: number): string {
    return `CA_${this.idPrefix}_${n}`;
  }

  async sendSms(request: CellularSmsRequest) {
    this.smsRequests.push(request);
    return {
      status: this.smsOutcome,
      providerMessageId:
        this.smsOutcome === 'accepted' ? this.messageId(++this.messageSeq) : null,
      detail: this.smsOutcome === 'accepted' ? null : `scripted ${this.smsOutcome}`,
    };
  }

  async placeVoiceCall(request: CellularVoiceRequest) {
    this.voiceRequests.push(request);
    return {
      status: this.voiceOutcome,
      providerCallId: this.callId(++this.callSeq),
      detail: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Envelope builders (the documented adapter shapes — see adapters/*.ts)
// ---------------------------------------------------------------------------

const TENANT_NUMBER = '+15550100000';

function twilioInboundSms(
  from: string,
  text: string,
  messageSid: string,
  to: string = TENANT_NUMBER,
  account = 'AC_test',
): unknown {
  return { From: from, To: to, Body: text, MessageSid: messageSid, AccountSid: account };
}

function twilioDlr(messageSid: string, status: 'delivered' | 'undelivered' | 'failed'): unknown {
  return { MessageSid: messageSid, MessageStatus: status, AccountSid: 'AC_test' };
}

function twilioSpeech(
  callSid: string,
  text: string,
  eventKey: string,
  from = '+15551234567',
  to: string = TENANT_NUMBER,
): unknown {
  return {
    CallSid: callSid,
    From: from,
    To: to,
    AccountSid: 'AC_test',
    EventKey: eventKey,
    SpeechResult: text,
  };
}

function twilioCallStatus(
  callSid: string,
  callStatus: string,
  eventKey: string,
  extra: Record<string, unknown> = {},
  from = '+15551234567',
  to: string = TENANT_NUMBER,
): unknown {
  return {
    CallSid: callSid,
    From: from,
    To: to,
    AccountSid: 'AC_test',
    EventKey: eventKey,
    CallStatus: callStatus,
    ...extra,
  };
}

function telnyxInboundSms(
  from: string,
  text: string,
  messageId: string,
  eventId: string,
  to: string = TENANT_NUMBER,
): unknown {
  return {
    data: {
      event_type: 'message.received',
      id: eventId,
      occurred_at: '2026-09-25T10:01:00Z',
      account_id: 'profile_test',
      payload: {
        id: messageId,
        from: { phone_number: from },
        to: { phone_number: to },
        text,
      },
    },
  };
}

function telnyxDlr(
  messageId: string,
  eventId: string,
  status: 'delivered' | 'failed',
): unknown {
  return {
    data: {
      event_type: 'message.delivery_updated',
      id: eventId,
      occurred_at: '2026-09-25T10:02:00Z',
      account_id: 'profile_test',
      payload: { id: messageId, status },
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture: a verified person with a phone identity ("Sarah")
// ---------------------------------------------------------------------------

let phoneSeq = 0;

/** A fresh E.164 number per fixture (identities are (tenant, provider,
 *  number)-keyed — shared-tenant test groups must not collide). */
function uniquePhone(): string {
  phoneSeq += 1;
  return `+1555${String(300_000 + phoneSeq).padStart(8, '0')}`;
}

async function createVerifiedPhonePerson(
  ctx: TenantContext,
  fullName: string,
  phoneNumber: string,
  employee: boolean,
  provider: 'sms' | 'voice' = 'sms',
): Promise<{ personId: string; employeeId: string | null; identityId: string }> {
  const person = await createPerson(ctx, { fullName });
  let employeeId: string | null = null;
  if (employee) {
    const employment = await createEmployee(ctx, { personId: person.id, title: 'Ops' });
    employeeId = employment.id;
  }
  const { identity } = await registerExternalIdentity(ctx, {
    provider,
    providerAccountId: phoneNumber,
  });
  await attestIdentity(ctx, { identityId: identity.id, evidence: `checked in person (${fullName})` });
  await attachVerifiedSubject(ctx, { identityId: identity.id, subjectId: person.id });
  return { personId: person.id, employeeId, identityId: identity.id };
}

async function registerTestConnection(
  ctx: TenantContext,
  provider: CellularProvider = 'twilio',
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const { connection } = await registerCellularConnection(ctx, {
    provider,
    providerAccountId: provider === 'twilio' ? 'AC_test' : 'profile_test',
    phoneNumber: TENANT_NUMBER,
    credentialRef: 'secret-store:cellular/1',
    ...overrides,
  });
  return connection.id;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let transport: ScriptedCellularTransport;
let telnyxTransport: ScriptedCellularTransport;

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  setCellularTransport(null);
  await closeDb();
});

beforeEach(() => {
  clockMs = BASE_TIME;
  vi.spyOn(systemClock, 'now').mockImplementation(() => new Date(clockMs));
  transport = new ScriptedCellularTransport('twilio');
  telnyxTransport = new ScriptedCellularTransport('telnyx');
  setCellularTransport(transport);
});

afterEach(() => {
  vi.restoreAllMocks();
  setCellularTransport(null);
});

/** Advance the service clock past one retry backoff window. */
function elapse(seconds: number): void {
  clockMs += seconds * 1_000;
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

describe('cellular connections', () => {
  it('registers, re-authorizes, lists and disables a telecom account', async () => {
    const ctx = member(tenantConnections);
    const first = await registerCellularConnection(ctx, {
      provider: 'twilio',
      providerAccountId: '  AC-main  ',
      phoneNumber: '+15550100000',
      credentialRef: 'secret-store:twilio/1',
      displayName: 'Ops number',
    });
    expect(first.created).toBe(true);
    expect(first.connection.provider).toBe('twilio');
    expect(first.connection.providerAccountId).toBe('AC-main');
    expect(first.connection.phoneNumber).toBe('+15550100000');
    expect(first.connection.status).toBe('active');

    // Re-registration is the re-authorization path: identity stays,
    // authorization fields move (the realtime module's discipline).
    const again = await registerCellularConnection(ctx, {
      provider: 'twilio',
      providerAccountId: 'AC-main',
      phoneNumber: '+15550100001',
      credentialRef: 'secret-store:twilio/2',
    });
    expect(again.created).toBe(false);
    expect(again.connection.id).toBe(first.connection.id);
    expect(again.connection.phoneNumber).toBe('+15550100001');
    expect(again.connection.credentialRef).toBe('secret-store:twilio/2');

    const read = await getCellularConnection(ctx, { connectionId: first.connection.id });
    expect(read.id).toBe(first.connection.id);

    const listed = await listCellularConnections(ctx, { provider: 'twilio' });
    expect(listed.map((c) => c.id)).toContain(first.connection.id);

    const disabled = await setCellularConnectionStatus(ctx, {
      connectionId: first.connection.id,
      status: 'disabled',
    });
    expect(disabled.status).toBe('disabled');
  });

  it('hides another tenant\'s connections uniformly (ADR-0001)', async () => {
    const ctxA = member(tenantConnections);
    const ctxB = member(tenantB);
    const { connection } = await registerCellularConnection(ctxA, {
      provider: 'telnyx',
      providerAccountId: 'profile-x',
      phoneNumber: '+15550100009',
      credentialRef: 'secret-store:telnyx/1',
    });
    await expectCode('connection_not_found', () =>
      getCellularConnection(ctxB, { connectionId: connection.id }),
    );
    await expectCode('connection_not_found', () =>
      setCellularConnectionStatus(ctxB, { connectionId: connection.id, status: 'disabled' }),
    );
    await expectCode('connection_not_found', () =>
      getCellularConnection(ctxB, { connectionId: 'not-a-uuid' }),
    );
  });

  it('refuses delivery without any connection, with precision when all are disabled', async () => {
    const tenantEmpty = newId();
    const ctx = member(tenantEmpty);
    await expectCode('connection_not_found', () =>
      reachAnyone(ctx, { phoneNumber: '+15551234567', kind: 'tell', text: 'Hi' }),
    );

    const tenantDisabled = newId();
    const ctxDisabled = member(tenantDisabled);
    await registerTestConnection(ctxDisabled);
    await setCellularConnectionStatus(ctxDisabled, {
      connectionId: (await listCellularConnections(ctxDisabled, {}))[0]!.id,
      status: 'disabled',
    });
    await expectCode('connection_disabled', () =>
      reachAnyone(ctxDisabled, { phoneNumber: '+15551234567', kind: 'tell', text: 'Hi' }),
    );
  });

  it('demands an explicit connection when several are active', async () => {
    const tenantAmbiguous = newId();
    const ctx = member(tenantAmbiguous);
    await registerTestConnection(ctx);
    await registerTestConnection(ctx, 'telnyx');
    await expectCode('connection_ambiguous', () =>
      reachAnyone(ctx, { phoneNumber: '+15551234567', kind: 'tell', text: 'Hi' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

describe('cellular policies', () => {
  it('requires the administer claim to write', async () => {
    const ctx = member(tenantPolicies);
    await expectCode('forbidden', () =>
      setCellularPolicy(ctx, { voiceFallback: 'on_sms_failure' }),
    );
  });

  it('upserts kind/default rows and resolves kind → default → built-in', async () => {
    const ctx = member(tenantPolicies, ['cellular:administer']);
    const kindRow = await setCellularPolicy(ctx, {
      reachKind: 'ask',
      voiceFallback: 'on_sms_failure',
      smsMaxAttempts: 5,
      currency: 'EUR',
    });
    expect(kindRow.reachKind).toBe('ask');
    expect(kindRow.voiceFallback).toBe('on_sms_failure');

    const defaultRow = await setCellularPolicy(ctx, {
      voiceFallback: 'on_sms_failure',
      maxSmsSegments: 2,
    });
    expect(defaultRow.reachKind).toBeNull();

    const resolvedAsk = await cellularContract.resolveCellularPolicy(ctx, { reachKind: 'ask' });
    expect(resolvedAsk.source).toBe('kind');
    expect(resolvedAsk.smsMaxAttempts).toBe(5);
    expect(resolvedAsk.currency).toBe('EUR');

    const resolvedTell = await cellularContract.resolveCellularPolicy(ctx, { reachKind: 'tell' });
    expect(resolvedTell.source).toBe('tenant-default');
    expect(resolvedTell.maxSmsSegments).toBe(2);

    // An unknown-tenant resolution is the built-in floor.
    const resolvedFresh = await cellularContract.resolveCellularPolicy(member(newId()), {});
    expect(resolvedFresh.source).toBe('built-in');
    expect(resolvedFresh.voiceFallback).toBe('forbidden');

    const listed = await cellularContract.listCellularPolicies(ctx, {});
    expect(listed.map((p) => p.reachKind)).toEqual(['ask', null]); // NULLS LAST

    const exact = await cellularContract.getCellularPolicy(ctx, { reachKind: 'ask' });
    expect(exact.id).toBe(kindRow.id);
    await expectCode('policy_not_found', () =>
      cellularContract.getCellularPolicy(member(newId()), {}),
    );
  });
});

// ---------------------------------------------------------------------------
// THE GOLDEN JOURNEY — "Tell Sarah …"
// ---------------------------------------------------------------------------

describe('reach anyone — the golden journey', () => {
  it('resolves Sarah\'s verified phone identity, sends the SMS, confirms delivery, and returns her reply into Aurum', async () => {
    const ctx = admin(tenantGolden);
    const phone = uniquePhone();
    const sarah = await createVerifiedPhonePerson(ctx, 'Sarah Chen', phone, true);
    await registerTestConnection(ctx);

    // "Tell Sarah the demo moved to 15:00." — the outcome-oriented ask.
    const reach = await reachAnyone(ctx, {
      personId: sarah.personId,
      kind: 'tell',
      text: 'The demo moved to 15:00 today.',
    });
    // Resolution: verified employee → employee-messaging gate (allowed by
    // the default matrix), first SMS attempt delivered synchronously.
    expect(reach.recipientKind).toBe('verified_employee');
    expect(reach.personId).toBe(sarah.personId);
    expect(reach.employeeId).toBe(sarah.employeeId);
    expect(reach.identityId).toBe(sarah.identityId);
    expect(reach.phoneNumber).toBe(phone);
    expect(reach.actionKind).toBe('employee-messaging');
    expect(reach.status).toBe('sent');
    expect(reach.sentAt).not.toBeNull();
    expect(reach.smsAttemptsCount).toBe(1);
    expect(reach.policySource).toBe('built-in');
    expect(reach.voiceFallback).toBe('forbidden');
    expect(reach.actionRequestId).not.toBeNull();
    expect(transport.smsRequests).toHaveLength(1);
    expect(transport.smsRequests[0]!.toNumber).toBe(phone);
    expect(transport.smsRequests[0]!.fromNumber).toBe(TENANT_NUMBER);
    expect(transport.smsRequests[0]!.text).toBe('The demo moved to 15:00 today.');
    expect(transport.smsRequests[0]!.segments).toBe(1);

    // The attempt audit: what was sent, through which connection, at what
    // estimated cost (the built-in floor's rates).
    const attempts = await listCellularAttempts(ctx, { reachRequestId: reach.id });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.leg).toBe('sms');
    expect(attempts[0]!.status).toBe('sent');
    expect(attempts[0]!.gateStatus).toBe('approved');
    expect(attempts[0]!.providerMessageId).toBe(transport.messageId(1));
    expect(attempts[0]!.costMinor).toBeGreaterThan(0);

    // The carrier confirms delivery (DLR).
    const dlr = await receiveCellularEvent(ctx, {
      provider: 'twilio',
      payload: twilioDlr(transport.messageId(1), 'delivered'),
    });
    expect(dlr.applied).toBe(true);
    expect(dlr.reach?.status).toBe('delivered');
    expect(dlr.reach?.deliveredAt).not.toBeNull();

    // Sarah replies over SMS — the reply RETURNS INTO AURUM through the
    // channels contract's canonical inbound edge (transcript turn with
    // identity attribution) and is correlated to the reach request.
    const reply = await receiveCellularEvent(ctx, {
      provider: 'twilio',
      payload: twilioInboundSms(phone, 'Got it — see you at 15:00.', 'SM_reply_1'),
    });
    expect(reply.applied).toBe(true);
    expect(reply.kind).toBe('sms_reply');
    expect(reply.reply).not.toBeNull();
    expect(reply.reply!.inboundKind).toBe('reach_reply');
    expect(reply.reply!.reachRequestId).toBe(reach.id);
    expect(reply.reply!.fromNumber).toBe(phone);
    expect(reply.reply!.text).toBe('Got it — see you at 15:00.');
    expect(reply.reply!.identityId).toBe(sarah.identityId);
    expect(reply.reply!.personId).toBe(sarah.personId);
    expect(reply.reply!.employeeId).toBe(sarah.employeeId);
    // The canonical transcript turn (channels contract, W030): the reply
    // is a real conversation message attributed to Sarah's identity.
    expect(reply.reply!.messageId).not.toBeNull();
    expect(reply.reply!.conversationId).not.toBeNull();
    const identity = await getExternalIdentity(ctx, sarah.identityId);
    expect(identity.status).toBe('verified');

    // The reach request reached the strongest outcome.
    const final = await getCellularReach(ctx, { reachRequestId: reach.id });
    expect(final.status).toBe('replied');
    expect(final.repliedAt).not.toBeNull();
    expect(final.deliveredAt).not.toBeNull();
    expect(final.nextAttemptAt).toBeNull();

    const replies = await listCellularReplies(ctx, { reachRequestId: reach.id });
    expect(replies).toHaveLength(1);
    const events = await listCellularEvents(ctx, { provider: 'twilio' });
    expect(events.map((e) => e.kind).sort()).toEqual(['sms_receipt', 'sms_reply']);
  });

  it('refuses to reach a person without a verified phone identity (lock 15)', async () => {
    const ctx = admin(tenantGolden);
    await registerTestConnection(ctx);
    const person = await createPerson(ctx, { fullName: 'No Phone' });
    await expectCode('person_not_reachable', () =>
      reachAnyone(ctx, { personId: person.id, kind: 'tell', text: 'Hi' }),
    );

    // An unverified identity never resolves to a person.
    const { identity } = await registerExternalIdentity(ctx, {
      provider: 'sms',
      providerAccountId: '+15559990000',
    });
    expect(identity.status).toBe('unverified');
    const reach = await reachAnyone(ctx, {
      phoneNumber: '+15559990000',
      kind: 'tell',
      text: 'Are you the courier?',
    });
    expect(reach.recipientKind).toBe('unverified_identity');
    expect(reach.actionKind).toBe('external-communication');
    expect(reach.status).toBe('sent');

    // A completely unknown number is classified honestly.
    const raw = await reachAnyone(ctx, {
      phoneNumber: '+15558887777',
      kind: 'tell',
      text: 'Delivery at the front desk.',
    });
    expect(raw.recipientKind).toBe('unknown_number');
    expect(raw.actionKind).toBe('external-communication');
  });

  it('rejects messages the resolved policy\'s segment limit refuses', async () => {
    const ctx = member(tenantGolden, ['cellular:administer']);
    await registerTestConnection(ctx);
    await setCellularPolicy(ctx, { maxSmsSegments: 1 });
    await expectCode('message_too_long', () =>
      reachAnyone(ctx, {
        phoneNumber: '+15551234567',
        kind: 'tell',
        text: 'a'.repeat(200),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// The voice fallback (the routing decision)
// ---------------------------------------------------------------------------

describe('voice fallback', () => {
  it('falls back to a voice call when the SMS leg terminally fails and policy permits', async () => {
    const ctx = admin(tenantVoice, ['cellular:administer']);
    const sarah = await createVerifiedPhonePerson(ctx, 'Sarah Chen', uniquePhone(), true);
    await registerTestConnection(ctx);
    await setCellularPolicy(ctx, {
      voiceFallback: 'on_sms_failure',
      smsMaxAttempts: 2,
      retryBackoffSeconds: 60,
    });

    transport.smsOutcome = 'failed'; // transient transport failure
    let reach = await reachAnyone(ctx, {
      personId: sarah.personId,
      kind: 'tell',
      text: 'The demo moved to 15:00.',
    });
    expect(reach.status).toBe('pending'); // retry scheduled (the lease)
    expect(reach.smsAttemptsCount).toBe(1);
    expect(reach.nextAttemptAt).not.toBeNull();

    // The pump advances the retry once the backoff elapsed.
    elapse(61);
    const pump1 = await pumpCellularReach(ctx, {});
    expect(pump1.processed).toBe(1);
    expect(pump1.attempted).toBe(1);
    reach = await getCellularReach(ctx, { reachRequestId: reach.id });
    expect(reach.smsAttemptsCount).toBe(2);

    // Budget exhausted → the SMS leg is terminal → the voice fallback.
    expect(transport.voiceRequests).toHaveLength(1);
    expect(transport.voiceRequests[0]!.text).toBe('The demo moved to 15:00.');
    expect(reach.status).toBe('delivered'); // the call was answered
    expect(reach.deliveredAt).not.toBeNull();
    expect(reach.voiceAttemptsCount).toBe(1);
    const attempts = await listCellularAttempts(ctx, { reachRequestId: reach.id });
    expect(attempts.map((a) => `${a.leg}:${a.status}`).sort()).toEqual([
      'sms:failed',
      'sms:failed',
      'voice:answered',
    ]);

    // Sarah answers by speaking during the call: the reply returns into
    // Aurum (channels transcript) and is correlated BY THE CALL.
    const reply = await receiveCellularEvent(ctx, {
      provider: 'twilio',
      payload: twilioSpeech(transport.callId(1), 'Yes, I will be there.', 'evt_speech_1'),
    });
    expect(reply.reply?.inboundKind).toBe('reach_reply');
    expect(reply.reach?.status).toBe('replied');

    // The call completes with its duration and recording captured.
    const completed = await receiveCellularEvent(ctx, {
      provider: 'twilio',
      payload: twilioCallStatus(
        transport.callId(1),
        'completed',
        'evt_completed_1',
        { CallDuration: 42, RecordingUrl: 'https://recordings.invalid/CA1' },
      ),
    });
    expect(completed.applied).toBe(true);
    const finalAttempts = await listCellularAttempts(ctx, { reachRequestId: reach.id });
    expect(finalAttempts.filter((a) => a.leg === 'voice')[0]!.status).toBe('completed');
    expect(finalAttempts.filter((a) => a.leg === 'voice')[0]!.durationSeconds).toBe(42);
  });

  it('never places a voice call when the policy forbids it (the conservative default)', async () => {
    const ctx = admin(tenantVoice, ['cellular:administer']);
    const sarah = await createVerifiedPhonePerson(ctx, 'Sarah Chen', uniquePhone(), true);
    await registerTestConnection(ctx);
    // The tenant-default row the previous test left behind is explicitly
    // reset — this test proves the FORBIDDEN mode, not the built-in floor.
    await setCellularPolicy(ctx, { voiceFallback: 'forbidden' });
    transport.smsOutcome = 'rejected'; // permanent: the SMS leg is terminal
    const reach = await reachAnyone(ctx, {
      personId: sarah.personId,
      kind: 'tell',
      text: 'The demo moved to 15:00.',
    });
    expect(reach.status).toBe('failed');
    expect(reach.failureCode).toBe('sms_rejected');
    expect(transport.voiceRequests).toHaveLength(0);
  });

  it('fails the request when the fallback call is not answered or cannot be placed', async () => {
    const ctx = admin(tenantVoice, ['cellular:administer']);
    const sarah = await createVerifiedPhonePerson(ctx, 'Sarah Chen', uniquePhone(), true);
    await registerTestConnection(ctx);
    await setCellularPolicy(ctx, { voiceFallback: 'on_sms_failure' });
    transport.smsOutcome = 'rejected';
    transport.voiceOutcome = 'no_answer';
    const reach = await reachAnyone(ctx, {
      personId: sarah.personId,
      kind: 'tell',
      text: 'The demo moved to 15:00.',
    });
    expect(reach.status).toBe('failed');
    expect(reach.failureCode).toBe('voice_no_answer');
    expect(transport.voiceRequests).toHaveLength(1);
  });

  it('an unwired transport is an explicit, retryable provider_unavailable failure', async () => {
    const ctx = admin(tenantVoice, ['cellular:administer']);
    const sarah = await createVerifiedPhonePerson(ctx, 'Sarah Chen', uniquePhone(), true);
    await registerTestConnection(ctx);
    await setCellularPolicy(ctx, { voiceFallback: 'on_sms_failure', smsMaxAttempts: 1 });
    setCellularTransport(null); // nothing wired
    const reach = await reachAnyone(ctx, {
      personId: sarah.personId,
      kind: 'tell',
      text: 'Hi',
    });
    // The voice leg could not be placed: explicit provider_unavailable.
    expect(reach.status).toBe('failed');
    expect(reach.failureCode).toBe('provider_unavailable');
  });
});

// ---------------------------------------------------------------------------
// The manager-originated path (no usable Internet data)
// ---------------------------------------------------------------------------

describe('manager-originated SMS/voice requests', () => {
  it('lets a manager text Aurum\'s number and the request returns into Aurum with attribution', async () => {
    const ctx = admin(tenantManager);
    const managerPhone = uniquePhone();
    const manager = await createVerifiedPhonePerson(ctx, 'Morgan Boss', managerPhone, true);
    await registerTestConnection(ctx);

    // No open reach request: the manager's text IS the request (the
    // manager has no usable Internet data — the SMS IS the channel).
    const result = await receiveCellularEvent(ctx, {
      provider: 'twilio',
      payload: twilioInboundSms(managerPhone, 'Where do we stand on the Acme deal?', 'SM_mgr_1'),
    });
    expect(result.applied).toBe(true);
    expect(result.reply).not.toBeNull();
    expect(result.reply!.inboundKind).toBe('inbound_request');
    expect(result.reply!.reachRequestId).toBeNull();
    expect(result.reply!.personId).toBe(manager.personId);
    expect(result.reply!.employeeId).toBe(manager.employeeId);
    expect(result.reply!.messageId).not.toBeNull();
    expect(result.reply!.conversationId).not.toBeNull();
    expect(result.reach).toBeNull();
  });

  it('lets a manager call Aurum\'s number and speak — the voice request returns into Aurum', async () => {
    const ctx = admin(tenantManager);
    const managerPhone = uniquePhone();
    // The manager's verified identity is the VOICE provider account — the
    // call's on-sight registration attributes her (cross-modality
    // unification of one person across sms+voice is W095's declared job).
    const manager = await createVerifiedPhonePerson(ctx, 'Morgan Boss', managerPhone, true, 'voice');
    await registerTestConnection(ctx);

    // The call itself is observed (ledger) and the speech becomes the
    // manager's request through the canonical voice edge.
    const ringing = await receiveCellularEvent(ctx, {
      provider: 'twilio',
      payload: twilioCallStatus('CA_inbound_1', 'ringing', 'evt_ring_1', {}, managerPhone),
    });
    expect(ringing.applied).toBe(true);

    const speech = await receiveCellularEvent(ctx, {
      provider: 'twilio',
      payload: twilioSpeech(
        'CA_inbound_1',
        'Summarize the Acme deal status for me.',
        'evt_mgr_speech_1',
        managerPhone,
      ),
    });
    expect(speech.reply!.inboundKind).toBe('inbound_request');
    expect(speech.reply!.channel).toBe('voice');
    expect(speech.reply!.personId).toBe(manager.personId);
    expect(speech.reply!.messageId).not.toBeNull();
  });

  it('records unverified inbound senders without person attribution (lock 15)', async () => {
    const ctx = admin(tenantManager);
    await registerTestConnection(ctx);
    const result = await receiveCellularEvent(ctx, {
      provider: 'twilio',
      payload: twilioInboundSms('+15556660000', 'who is this?', 'SM_stranger_1'),
    });
    expect(result.reply!.inboundKind).toBe('inbound_request');
    expect(result.reply!.personId).toBeNull();
    expect(result.reply!.employeeId).toBeNull();
    expect(result.reply!.identityId).not.toBeNull(); // registered on sight
  });
});

// ---------------------------------------------------------------------------
// The W009 authority gate
// ---------------------------------------------------------------------------

describe('the authority gate', () => {
  it('holds a reach until a human approves it, then a pump unlocks delivery', async () => {
    const requester = member(tenantGate);
    const ctxAdmin = admin(tenantGate, ['actions:administer']);
    const sarah = await createVerifiedPhonePerson(ctxAdmin, 'Sarah Chen', uniquePhone(), true);
    await registerTestConnection(ctxAdmin);

    // Employee messaging now REQUIRES approval at the ASK level.
    await setAuthorityPolicy(ctxAdmin, {
      actionKind: 'employee-messaging',
      approvalLevels: ['ASK'],
    });

    let reach = await reachAnyone(requester, {
      personId: sarah.personId,
      kind: 'tell',
      text: 'The demo moved to 15:00.',
    });
    expect(reach.status).toBe('awaiting_approval');
    expect(transport.smsRequests).toHaveLength(0); // nothing was sent

    // Pumps re-check the same gate request while it is pending.
    let pump = await pumpCellularReach(requester, {});
    expect(pump.waiting).toBe(1);
    expect(transport.smsRequests).toHaveLength(0);

    // A human (not the requester — separation of duties) approves.
    const approver = member(tenantGate, ['actions:approve']);
    await decideApproval(approver, { requestId: reach.actionRequestId!, decision: 'approve' });

    pump = await pumpCellularReach(requester, {});
    expect(pump.attempted).toBe(1);
    expect(pump.sent).toBe(1);
    reach = await getCellularReach(requester, { reachRequestId: reach.id });
    expect(reach.status).toBe('sent');
  });

  it('blocks a forbidden reach outright and never reopens it', async () => {
    const requester = member(tenantGate);
    const ctxAdmin = admin(tenantGate, ['actions:administer']);
    const sarah = await createVerifiedPhonePerson(ctxAdmin, 'Sarah Chen', uniquePhone(), true);
    await registerTestConnection(ctxAdmin);

    await setAuthorityPolicy(ctxAdmin, {
      actionKind: 'employee-messaging',
      forbiddenLevels: ['ASK'],
    });

    const reach = await reachAnyone(requester, {
      personId: sarah.personId,
      kind: 'tell',
      text: 'The demo moved to 15:00.',
    });
    expect(reach.status).toBe('blocked');
    expect(transport.smsRequests).toHaveLength(0);
    await expectCode('reach_not_retryable', () =>
      retryCellularReach(requester, { reachRequestId: reach.id }),
    );
  });
});

// ---------------------------------------------------------------------------
// Failure visibility + retryability (W031 notification)
// ---------------------------------------------------------------------------

describe('failed delivery is visible and retryable', () => {
  it('records the failure code, notifies the asking manager through the notifications contract, and retries into a new cycle', async () => {
    const requester = member(tenantFailure);
    const ctxAdmin = admin(tenantFailure);
    const sarah = await createVerifiedPhonePerson(ctxAdmin, 'Sarah Chen', uniquePhone(), true);
    await registerTestConnection(ctxAdmin);

    transport.smsOutcome = 'rejected';
    const reach = await reachAnyone(requester, {
      personId: sarah.personId,
      kind: 'tell',
      text: 'The demo moved to 15:00.',
      failureNotification: { provider: 'email', providerAccountId: 'boss@example.com' },
    });
    expect(reach.status).toBe('failed');
    expect(reach.failureCode).toBe('sms_rejected');

    // The asking manager was told through the W031 machinery.
    const notifications = await listNotifications(requester, {
      notificationKind: 'cellular-reach-failed',
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.recipient.providerAccountId).toBe('boss@example.com');
    expect(notifications[0]!.correlationId).toBe(reach.id);

    // Retry: a new delivery cycle — the transport now accepts.
    transport.smsOutcome = 'accepted';
    const retried = await retryCellularReach(requester, { reachRequestId: reach.id });
    expect(retried.cycle).toBe(2);
    expect(retried.smsAttemptsCount).toBe(1);
    expect(retried.failureCode).toBeNull();
    expect(retried.status).toBe('sent');
    expect(retried.costMinorTotal).toBeGreaterThan(0); // lifetime cost spans cycles

    const attempts = await listCellularAttempts(requester, { reachRequestId: reach.id });
    expect(attempts).toHaveLength(2);
    expect(attempts.map((a) => a.status)).toEqual(['rejected', 'sent']);
    expect(attempts.map((a) => a.cycle)).toEqual([1, 2]);
  });

  it('refuses to retry requests that are not terminally failed', async () => {
    const ctx = admin(tenantFailure);
    const sarah = await createVerifiedPhonePerson(ctx, 'Sarah Chen', uniquePhone(), true);
    await registerTestConnection(ctx);
    const reach = await reachAnyone(ctx, {
      personId: sarah.personId,
      kind: 'tell',
      text: 'Hi',
    });
    expect(reach.status).toBe('sent');
    await expectCode('reach_not_retryable', () =>
      retryCellularReach(ctx, { reachRequestId: reach.id }),
    );
  });

  it('a failed DLR retries within the snapshot budget', async () => {
    const ctx = admin(tenantFailure, ['cellular:administer']);
    const sarah = await createVerifiedPhonePerson(ctx, 'Sarah Chen', uniquePhone(), true);
    await registerTestConnection(ctx);
    await setCellularPolicy(ctx, { smsMaxAttempts: 2, retryBackoffSeconds: 30 });

    const reach = await reachAnyone(ctx, {
      personId: sarah.personId,
      kind: 'tell',
      text: 'The demo moved to 15:00.',
    });
    expect(reach.status).toBe('sent');

    // The carrier reports a failed delivery: retry scheduled.
    const undelivered = await receiveCellularEvent(ctx, {
      provider: 'twilio',
      payload: twilioDlr(transport.messageId(1), 'undelivered'),
    });
    expect(undelivered.reach?.status).toBe('pending');
    expect(undelivered.reach?.nextAttemptAt).not.toBeNull();

    // Before the backoff elapses the pump does nothing.
    elapse(10);
    const idle = await pumpCellularReach(ctx, {});
    expect(idle.attempted).toBe(0);

    // After it: the retry delivers.
    elapse(25);
    const pumped = await pumpCellularReach(ctx, {});
    expect(pumped.attempted).toBe(1);
    expect(pumped.sent).toBe(1);
    const final = await getCellularReach(ctx, { reachRequestId: reach.id });
    expect(final.status).toBe('sent');
    expect(final.smsAttemptsCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Cost controls
// ---------------------------------------------------------------------------

describe('cost controls', () => {
  it('terminally fails a reach whose next leg would exceed the lifetime cap', async () => {
    const ctx = admin(tenantCost, ['cellular:administer']);
    const sarah = await createVerifiedPhonePerson(ctx, 'Sarah Chen', uniquePhone(), true);
    await registerTestConnection(ctx);
    await setCellularPolicy(ctx, { smsSegmentCostMinor: 5, maxCostPerReachMinor: 4 });

    const reach = await reachAnyone(ctx, {
      personId: sarah.personId,
      kind: 'tell',
      text: 'Hi',
    });
    expect(reach.status).toBe('failed');
    expect(reach.failureCode).toBe('cost_cap_exceeded');
    expect(transport.smsRequests).toHaveLength(0); // nothing was sent
    const attempts = await listCellularAttempts(ctx, { reachRequestId: reach.id });
    expect(attempts).toHaveLength(0);
  });

  it('accumulates lifetime cost across legs and cycles (the cap spans them)', async () => {
    const ctx = admin(tenantCost, ['cellular:administer']);
    const sarah = await createVerifiedPhonePerson(ctx, 'Sarah Chen', uniquePhone(), true);
    await registerTestConnection(ctx);
    await setCellularPolicy(ctx, { smsSegmentCostMinor: 10, maxCostPerReachMinor: 10 });

    const reach = await reachAnyone(ctx, { personId: sarah.personId, kind: 'tell', text: 'Hi' });
    expect(reach.status).toBe('sent');
    expect(reach.costMinorTotal).toBe(10);

    // A retry cycle would cost another 10 — over the lifetime cap.
    transport.smsOutcome = 'rejected';
    const failed = await receiveCellularEvent(ctx, {
      provider: 'twilio',
      payload: twilioDlr(transport.messageId(1), 'failed'),
    });
    // Budget (3 by default) still holds → pending; retry is refused by the cap.
    expect(failed.reach?.status).toBe('pending');
    elapse(120);
    const pump = await pumpCellularReach(ctx, {});
    expect(pump.failed).toBe(1);
    const final = await getCellularReach(ctx, { reachRequestId: reach.id });
    expect(final.failureCode).toBe('cost_cap_exceeded');
    expect(final.costMinorTotal).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Dedupe + ledger discipline
// ---------------------------------------------------------------------------

describe('provider event dedupe and ledger', () => {
  it('applies each provider event exactly once (redelivery is a no-op)', async () => {
    const ctx = admin(tenantDedupe);
    await registerTestConnection(ctx);

    const payload = twilioInboundSms('+15556660000', 'first contact', 'SM_dup_1');
    const first = await receiveCellularEvent(ctx, { provider: 'twilio', payload });
    expect(first.applied).toBe(true);

    // Redelivery of the SAME envelope: deduped (the ledger row is the claim).
    const second = await receiveCellularEvent(ctx, { provider: 'twilio', payload });
    expect(second.applied).toBe(false);
    expect(second.reply).toBeNull();

    const replies = await listCellularReplies(ctx, {});
    expect(replies).toHaveLength(1);
    const events = await listCellularEvents(ctx, { provider: 'twilio' });
    expect(events).toHaveLength(1);
    expect(events[0]!.providerEventId).toBe('SM_dup_1');
  });

  it('rejects envelopes whose account belongs to no connection of this tenant', async () => {
    const ctx = admin(tenantDedupe);
    await registerTestConnection(ctx);
    await expectCode('connection_not_found', () =>
      receiveCellularEvent(ctx, {
        provider: 'twilio',
        // The envelope belongs to an account this tenant never registered.
        payload: twilioInboundSms('+15556660000', 'hi', 'SM_foreign', TENANT_NUMBER, 'AC_foreign'),
      }),
    );
  });

  it('observes carrier events that reference no attempt of this tenant (never an error)', async () => {
    const ctx = admin(newId());
    await registerTestConnection(ctx);
    const result = await receiveCellularEvent(ctx, {
      provider: 'twilio',
      payload: twilioDlr('SM_somebody_elses_message', 'delivered'),
    });
    expect(result.applied).toBe(true);
    expect(result.reach).toBeNull();
    const events = await listCellularEvents(ctx, {});
    expect(events).toHaveLength(1);

    const call = await receiveCellularEvent(ctx, {
      provider: 'twilio',
      payload: twilioCallStatus('CA_inbound_9', 'completed', 'evt_inbound_9'),
    });
    expect(call.applied).toBe(true);
    expect(call.reach).toBeNull();
  });

  it('rejects malformed envelopes with the canonical codes', async () => {
    const ctx = admin(tenantDedupe);
    await registerTestConnection(ctx);
    await expectCode('invalid_provider_payload', () =>
      receiveCellularEvent(ctx, { provider: 'twilio', payload: 'not-an-object' }),
    );
    await expectCode('unsupported_provider_event', () =>
      receiveCellularEvent(ctx, {
        provider: 'twilio',
        payload: twilioDlr('SM1', 'queued' as never),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Provider swap (GOVERNANCE evidence)
// ---------------------------------------------------------------------------

describe('provider swap: twilio → telnyx', () => {
  interface JourneyState {
    status: string;
    recipientKind: string;
    actionKind: string;
    policySource: string;
    smsAttemptsCount: number;
    costMinorTotal: number;
    attemptsShape: { leg: string; status: string; gateStatus: string }[];
    replyShape: { inboundKind: string; channel: string; text: string }[];
  }

  async function runJourney(provider: 'twilio' | 'telnyx'): Promise<JourneyState> {
    const tenant = provider === 'twilio' ? tenantSwap : newId();
    const ctx = admin(tenant);
    const phone = uniquePhone();
    const sarah = await createVerifiedPhonePerson(ctx, 'Sarah Chen', phone, true);
    await registerTestConnection(ctx, provider);
    const transportOf = provider === 'twilio' ? transport : telnyxTransport;
    setCellularTransport(transportOf);

    const reach = await reachAnyone(ctx, {
      personId: sarah.personId,
      kind: 'tell',
      text: 'The demo moved to 15:00.',
    });

    if (provider === 'twilio') {
      await receiveCellularEvent(ctx, {
        provider,
        payload: twilioDlr((transportOf as ScriptedCellularTransport).messageId(1), 'delivered'),
      });
      const reply = await receiveCellularEvent(ctx, {
        provider,
        payload: twilioInboundSms(phone, 'Got it.', 'SM_swap_reply'),
      });
      expect(reply.reply?.messageId).not.toBeNull();
    } else {
      await receiveCellularEvent(ctx, {
        provider,
        payload: telnyxDlr((transportOf as ScriptedCellularTransport).messageId(1), 'evt_swap_dlr', 'delivered'),
      });
      const reply = await receiveCellularEvent(ctx, {
        provider,
        payload: telnyxInboundSms(phone, 'Got it.', 'msg_swap_reply', 'evt_swap_reply'),
      });
      expect(reply.reply?.messageId).not.toBeNull();
    }

    const fresh = await getCellularReach(ctx, { reachRequestId: reach.id });
    const attempts = await listCellularAttempts(ctx, { reachRequestId: reach.id });
    const replies = await listCellularReplies(ctx, { reachRequestId: reach.id });
    setCellularTransport(transport); // restore the default wiring
    return {
      status: fresh.status,
      recipientKind: fresh.recipientKind,
      actionKind: fresh.actionKind,
      policySource: fresh.policySource,
      smsAttemptsCount: fresh.smsAttemptsCount,
      costMinorTotal: fresh.costMinorTotal,
      attemptsShape: attempts.map((a) => ({ leg: a.leg, status: a.status, gateStatus: a.gateStatus })),
      replyShape: replies.map((r) => ({ inboundKind: r.inboundKind, channel: r.channel, text: r.text })),
    };
  }

  it('the same canonical journey through both vendors yields identical domain state', async () => {
    const twilioState = await runJourney('twilio');
    const telnyxState = await runJourney('telnyx');
    expect(telnyxState).toEqual(twilioState);
  });

  it('the transport port observes only provider-neutral requests', async () => {
    const ctx = admin(tenantSwap);
    const phone = uniquePhone();
    const sarah = await createVerifiedPhonePerson(ctx, 'Sarah Chen', phone, true);
    const connectionId = await registerTestConnection(ctx, 'telnyx');
    setCellularTransport(telnyxTransport);
    await reachAnyone(ctx, {
      personId: sarah.personId,
      kind: 'tell',
      text: 'Hi',
      connectionId,
    });
    setCellularTransport(transport);
    expect(telnyxTransport.smsRequests).toHaveLength(1);
    const request = telnyxTransport.smsRequests[0]!;
    expect(request.provider).toBe('telnyx');
    expect(request.connectionId).toBeDefined();
    expect(request.fromNumber).toBe(TENANT_NUMBER);
    expect(request.toNumber).toBe(phone);
    // No vendor object crossed the seam: the request is the canonical shape.
    expect(Object.keys(request).sort()).toEqual([
      'attemptId',
      'connectionId',
      'fromNumber',
      'provider',
      'segments',
      'tenantId',
      'text',
      'toNumber',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('tenant isolation', () => {
  it("another tenant's cellular state is indistinguishable from missing", async () => {
    const ctxA = admin(tenantIsolation);
    const ctxB = member(tenantB);
    const phone = uniquePhone();
    const sarah = await createVerifiedPhonePerson(ctxA, 'Sarah Chen', phone, true);
    await registerTestConnection(ctxA);
    const reach = await reachAnyone(ctxA, {
      personId: sarah.personId,
      kind: 'tell',
      text: 'Hi',
    });

    await expectCode('reach_not_found', () => getCellularReach(ctxB, { reachRequestId: reach.id }));
    await expectCode('reach_not_found', () =>
      listCellularAttempts(ctxB, { reachRequestId: reach.id }),
    );
    await expectCode('reach_not_found', () =>
      listCellularReplies(ctxB, { reachRequestId: reach.id }),
    );
    await expectCode('reach_not_found', () =>
      retryCellularReach(ctxB, { reachRequestId: reach.id }),
    );
    expect(await listCellularReach(ctxB, {})).toEqual([]);
    expect(await listCellularReplies(ctxB, {})).toEqual([]);
    expect(await listCellularEvents(ctxB, {})).toEqual([]);

    // A's person is invisible to B — reaching her number from B classifies
    // it honestly as unknown (no cross-tenant leak through resolution).
    await registerTestConnection(member(tenantB), 'telnyx');
    const bReach = await reachAnyone(member(tenantB, []), {
      phoneNumber: phone,
      kind: 'tell',
      text: 'Hi from B',
    });
    expect(bReach.recipientKind).toBe('unknown_number');
    expect(bReach.personId).toBeNull();

    // Foreign event envelopes resolve to nothing for B (the envelope's
    // account belongs to A's connection, not B's).
    await expectCode('connection_not_found', () =>
      receiveCellularEvent(ctxB, { provider: 'twilio', payload: twilioInboundSms(phone, 'x', 'SM_iso') }),
    );
  });
});

// ---------------------------------------------------------------------------
// Storage discipline (append-only / immutable at the storage level)
// ---------------------------------------------------------------------------

describe('storage discipline', () => {
  it('protects the substantive reach record and the append-only trails', async () => {
    const ctx = admin(tenantStorage);
    const phone = uniquePhone();
    const sarah = await createVerifiedPhonePerson(ctx, 'Sarah Chen', phone, true);
    await registerTestConnection(ctx);
    const reach = await reachAnyone(ctx, { personId: sarah.personId, kind: 'tell', text: 'Hi' });
    await receiveCellularEvent(ctx, {
      provider: 'twilio',
      payload: twilioInboundSms(phone, 'ok', 'SM_storage_1'),
    });

    const db = getDb();
    // Reach substantive fields are immutable.
    await expect(
      db.query(`UPDATE cellular_reach_requests SET text = 'tampered' WHERE id = $1`, [reach.id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.query(`UPDATE cellular_reach_requests SET phone_number = '+15550000000' WHERE id = $1`, [reach.id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.query(`DELETE FROM cellular_reach_requests WHERE id = $1`, [reach.id]),
    ).rejects.toThrow(/immutable history/);

    // Lifecycle fields DO move (the guard allows exactly those).
    await db.query(`UPDATE cellular_reach_requests SET failure_code = NULL, updated_at = now() WHERE id = $1`, [reach.id]);

    const attemptId = (await db.query<DbRow & { id: string }>(
      `SELECT id FROM cellular_attempts WHERE reach_request_id = $1 LIMIT 1`,
      [reach.id],
    )).rows[0]!.id;
    await expect(
      db.query(`UPDATE cellular_attempts SET text = 'tampered' WHERE id = $1`, [attemptId]),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.query(`DELETE FROM cellular_attempts WHERE id = $1`, [attemptId]),
    ).rejects.toThrow(/immutable history/);
    // The receipt lifecycle moves.
    await db.query(`UPDATE cellular_attempts SET receipt_at = now() WHERE id = $1`, [attemptId]);

    const replyRow = (await db.query<DbRow & { id: string }>(
      `SELECT id FROM cellular_replies LIMIT 1`,
    )).rows[0]!;
    await expect(
      db.query(`DELETE FROM cellular_replies WHERE id = $1`, [replyRow.id]),
    ).rejects.toThrow(/append-only/);

    const eventRow = (await db.query<DbRow & { id: string }>(
      `SELECT id FROM cellular_events LIMIT 1`,
    )).rows[0]!;
    await expect(
      db.query(`UPDATE cellular_events SET kind = 'call_status' WHERE id = $1`, [eventRow.id]),
    ).rejects.toThrow(/append-only/);
  });
});
