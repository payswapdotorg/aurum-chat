// Integration tests for the channels module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W030
// acceptance: "Implement canonical adapters for WhatsApp, Telegram, Signal,
// Slack, X, Instagram, Facebook/Messenger, LinkedIn, email, SMS/voice and
// web as provider availability permits. Preserve provider isolation."
//
//  * connections — tenant-owned sending endpoints: idempotent registration,
//    filtered listing, status gating (enable/disable) and the uniform
//    cross-tenant not-found discipline (ADR-0001);
//  * inbound — provider webhooks normalize into canonical communication
//    events: on-sight identity registration (W002), immutable transcript
//    turns (W029), person attribution ONLY through verified, subject-linked
//    identities (lock 15), append-only thread routing (first mapping wins),
//    provider-message redelivery dedupe, and the service-clock fallback for
//    carriers that carry no sender clock;
//  * provider isolation — the persisted transcript payload is canonical:
//    provider envelope fragments (entry/changes/wa_id/messaging/…) never
//    reach the transcript; the public contract exports no adapter symbols;
//  * outbound — canonical content is adapter-formatted, delivered through
//    the provider-neutral transport port BEFORE the turn is recorded (the
//    transcript records what was actually sent), with explicit
//    provider_unavailable / delivery_rejected / delivery_failed states;
//  * verification challenges — issue (W002) + deliver over the sender's own
//    channel; the single-use code exists only inside the module and the
//    delivered message — the transcript turn carries a redaction marker and
//    NEVER the code (IMPLEMENTATION-STACK §8), and the channel-replied code
//    completes verification through the identity contract;
//  * storage discipline — channel_threads is append-only (PostgreSQL
//    triggers reject UPDATE/DELETE/TRUNCATE); connections are mutable
//    configuration (status) only.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import * as channelsContract from '../contract';
import {
  attestIdentity,
  attachVerifiedSubject,
  findExternalIdentityByProviderKey,
  getExternalIdentity,
} from '@/modules/identity/contract';
import { getConversation, listMessages } from '@/modules/conversations/contract';
import { createPerson } from '@/modules/people/contract';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { ChannelsError } from '../errors';
import { setChannelTransport } from '../service';
import type {
  CanonicalDeliveryRequest,
  ChannelTransport,
  TransportReceipt,
} from '../types';
import { runMigrations } from '../../../../scripts/migrate';

const {
  completeIdentityChallenge,
  deliverIdentityChallenge,
  getChannelConnection,
  getChannelTransport,
  listChannelConnections,
  receiveInbound,
  registerChannelConnection,
  sendOutbound,
  setChannelConnectionStatus,
} = channelsContract;

// Dedicated tenants per group so count/order assertions stay deterministic.
const tenantA = newId();
const tenantB = newId();
const tenantIsolation = newId();
const tenantThreads = newId();
const tenantOutbound = newId();
const tenantChallenges = newId();
const tenantImmutable = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function admin(tenantId: string): TenantContext {
  // interim authority claims for the identity module's attest/link workflow
  return { tenantId, principalId: newId(), authority: ['identity:attest', 'identity:link'] };
}

async function expectCode(
  code: ChannelsError['code'],
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    throw new Error(`expected ChannelsError('${code}') but the call succeeded`);
  } catch (error) {
    expect(error).toBeInstanceOf(ChannelsError);
    expect((error as ChannelsError).code).toBe(code);
  }
}

/** A provider-neutral transport that records every delivery request. */
class RecordingTransport implements ChannelTransport {
  readonly requests: CanonicalDeliveryRequest[] = [];
  private static deliveryCounter = 0;
  private nextReceipt: TransportReceipt | null = null;

  overrideReceipt(receipt: TransportReceipt): void {
    this.nextReceipt = receipt;
  }

  async deliver(request: CanonicalDeliveryRequest): Promise<TransportReceipt> {
    this.requests.push(request);
    // Every accepted delivery gets a UNIQUE provider message id so the
    // transcript's (tenant, channel, providerMessageId) dedupe never
    // collides across test deliveries.
    RecordingTransport.deliveryCounter += 1;
    return (
      this.nextReceipt ?? {
        status: 'delivered',
        providerMessageId: `prov-out-${String(RecordingTransport.deliveryCounter).padStart(6, '0')}`,
        detail: null,
      }
    );
  }
}

let transport: RecordingTransport;

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  setChannelTransport(null);
  await closeDb();
});

beforeEach(() => {
  transport = new RecordingTransport();
});

afterEach(() => {
  setChannelTransport(null);
});

// ---------------------------------------------------------------------------
// Fixtures — realistic provider webhook payloads
// ---------------------------------------------------------------------------

function whatsappPayload(
  from: string,
  messageText: string,
  wamid: string,
  timestamp = '1760426100',
): Record<string, unknown> {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { display_phone_number: '15550100000' },
              contacts: [{ profile: { name: 'Alice Wong' }, wa_id: from.replace('+', '') }],
              messages: [
                { from: from.replace('+', ''), id: wamid, timestamp, type: 'text', text: { body: messageText } },
              ],
            },
          },
        ],
      },
    ],
  };
}

function telegramPayload(text: string, messageId: number): Record<string, unknown> {
  return {
    message: {
      message_id: messageId,
      from: { id: 98765, first_name: 'Bob', last_name: 'Tan' },
      chat: { id: -100123, type: 'private' },
      date: 1_760_426_100,
      text,
    },
  };
}

function slackPayload(text: string, ts: string): Record<string, unknown> {
  return {
    type: 'event_callback',
    team_id: 'T1234TEAM',
    event: { type: 'message', user: 'U123ABC', text, ts, channel: 'C456DEF' },
  };
}

function emailPayload(subject: string, text: string, messageId: string): Record<string, unknown> {
  return {
    from: 'Erin Chu <Erin.Chu@Corp.com>',
    to: 'ops@tenant.example',
    subject,
    text,
    messageId,
    date: 'Mon, 14 Sep 2026 09:15:00 +0000',
  };
}

function smsPayload(body: string, sid: string): Record<string, unknown> {
  return { From: '+15551234567', To: '+15550100000', Body: body, MessageSid: sid };
}

function voicePayload(speech: string, eventKey: string): Record<string, unknown> {
  return {
    CallSid: 'CA1234567890',
    From: '+15551234567',
    To: '+15550100000',
    SpeechResult: speech,
    EventKey: eventKey,
  };
}

function webPayload(text: string, messageId: string): Record<string, unknown> {
  return {
    sessionId: 'sess-2026-10-14-1',
    visitorId: 'visitor-9',
    visitorName: 'Frank Ibe',
    messageId,
    sentAt: '2026-10-14T10:00:00Z',
    text,
  };
}

function xPayload(text: string, id: string): Record<string, unknown> {
  return {
    direct_message_events: [
      { id, created_timestamp: '1760426100123', text, sender_id: '224466', recipient_id: '112233' },
    ],
    users: { '224466': { name: 'Dana Reed', screen_name: 'danareed' } },
  };
}

function instagramPayload(text: string, mid: string): Record<string, unknown> {
  return {
    entry: [{ messaging: [{ sender: { id: '771100' }, recipient: { id: '178900' }, timestamp: 1_760_426_100_123, message: { mid, text } }] }],
  };
}

function facebookPayload(text: string, mid: string): Record<string, unknown> {
  return {
    entry: [{ messaging: [{ sender: { id: '5150' }, recipient: { id: '9999' }, timestamp: 1_760_426_100_123, message: { mid, text } }] }],
  };
}

function linkedinPayload(text: string, messageId: string): Record<string, unknown> {
  return {
    conversationId: 'urn:li:messagingThread:abc123',
    senderId: 'member-42',
    sentAt: '2026-10-14T09:00:00Z',
    text,
    messageId,
  };
}

function signalPayload(text: string): Record<string, unknown> {
  return {
    envelope: { sourceNumber: '+15559900111', sourceName: 'Carol Diaz', timestamp: 1_760_426_100_123, message: text },
  };
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

describe('channel connections', () => {
  it('registers idempotently (first registration wins) and round-trips', async () => {
    const ctx = member(tenantA);
    const first = await registerChannelConnection(ctx, {
      provider: 'whatsapp',
      providerAccountId: ' 1555 010 0000 ',
      displayName: 'Ops WhatsApp',
      credentialRef: 'secret-store://whatsapp/ops',
    });
    expect(first.created).toBe(true);
    expect(first.connection).toMatchObject({
      tenantId: tenantA,
      provider: 'whatsapp',
      providerAccountId: '+15550100000',
      displayName: 'Ops WhatsApp',
      credentialRef: 'secret-store://whatsapp/ops',
      status: 'active',
      createdBy: ctx.principalId,
    });

    const again = await registerChannelConnection(ctx, {
      provider: 'whatsapp',
      providerAccountId: '+15550100000',
      displayName: 'A different name',
      credentialRef: 'secret-store://whatsapp/other',
    });
    expect(again.created).toBe(false);
    expect(again.connection.id).toBe(first.connection.id);
    expect(again.connection.displayName).toBe('Ops WhatsApp'); // first wins

    const read = await getChannelConnection(ctx, first.connection.id);
    expect(read).toEqual(first.connection);
  });

  it('reports missing, malformed and cross-tenant connections as connection_not_found', async () => {
    const ctx = member(tenantA);
    const foreign = await registerChannelConnection(member(tenantB), {
      provider: 'slack',
      providerAccountId: 'TWORKSPACE',
      credentialRef: 'ref',
    });
    await expectCode('connection_not_found', () => getChannelConnection(ctx, newId()));
    await expectCode('connection_not_found', () => getChannelConnection(ctx, 'not-a-uuid'));
    await expectCode('connection_not_found', () => getChannelConnection(ctx, foreign.connection.id));
  });

  it('lists with provider/status filters and validates account shapes per provider', async () => {
    const ctx = member(tenantB);
    await registerChannelConnection(ctx, { provider: 'email', providerAccountId: 'Ops@Tenant.example', credentialRef: 'r1' });
    await registerChannelConnection(ctx, { provider: 'slack', providerAccountId: 'TWORKSPACE', credentialRef: 'r2' });

    const emailOnly = await listChannelConnections(ctx, { provider: 'email' });
    expect(emailOnly).toHaveLength(1);
    expect(emailOnly[0]!.providerAccountId).toBe('ops@tenant.example'); // adapter-normalized

    await expectCode('invalid_channel_input', () =>
      registerChannelConnection(ctx, { provider: 'slack', providerAccountId: 'has space', credentialRef: 'r3' }),
    );
    await expectCode('invalid_channel_input', () =>
      registerChannelConnection(ctx, { provider: 'email', providerAccountId: 'not-an-address', credentialRef: 'r4' }),
    );

    const all = await listChannelConnections(ctx, {});
    expect(all.map((connection) => connection.provider).sort()).toEqual(['email', 'slack']);
  });

  it('gates sending on the connection status', async () => {
    const ctx = member(tenantB);
    const { connection } = await registerChannelConnection(ctx, {
      provider: 'sms',
      providerAccountId: '+15550100000',
      credentialRef: 'r',
    });

    const disabled = await setChannelConnectionStatus(ctx, { connectionId: connection.id, status: 'disabled' });
    expect(disabled.status).toBe('disabled');

    setChannelTransport(transport);
    await expectCode('connection_disabled', () =>
      sendOutbound(ctx, {
        provider: 'sms',
        to: { providerAccountId: '+15551234567', displayName: null },
        content: { text: 'hello', attachments: [] },
      }),
    );

    const reenabled = await setChannelConnectionStatus(ctx, { connectionId: connection.id, status: 'active' });
    expect(reenabled.status).toBe('active');
    const sent = await sendOutbound(ctx, {
      provider: 'sms',
      to: { providerAccountId: '+15551234567', displayName: null },
      content: { text: 'hello', attachments: [] },
    });
    expect(sent.message.direction).toBe('outbound');

    await expectCode('connection_not_found', () =>
      setChannelConnectionStatus(member(tenantA), { connectionId: connection.id, status: 'disabled' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

describe('inbound canonicalization (receiveInbound)', () => {
  it('registers the sender identity on sight and records a canonical transcript turn', async () => {
    const ctx = member(tenantA);
    const result = await receiveInbound(ctx, {
      provider: 'whatsapp',
      payload: whatsappPayload('+15551234567', 'supplier meeting moved to Friday', 'wamid.0001'),
    });

    expect(result.identityCreated).toBe(true);
    expect(result.identity).toMatchObject({
      tenantId: tenantA,
      provider: 'whatsapp',
      providerAccountId: '+15551234567',
      status: 'unverified',
    });
    expect(result.threadKey).toBe('+15550100000|+15551234567');

    const message = result.message;
    expect(message.tenantId).toBe(tenantA);
    expect(message.direction).toBe('inbound');
    expect(message.channel).toBe('whatsapp');
    expect(message.providerMessageId).toBe('wamid.0001');
    expect(message.sentAt).toBe(new Date(1_760_426_100_000).toISOString());
    // Unverified sender → external actor (lock 15: no pseudo-employees).
    expect(message.actor.kind).toBe('external');
    expect(message.actor.identityId).toBe(result.identity.id);
    // Canonical payload — provider-neutral by construction.
    expect(message.payload).toEqual({
      kind: 'message',
      content: { text: 'supplier meeting moved to Friday', attachments: [] },
    });
  });

  it('routes provider threads to one conversation (first mapping wins)', async () => {
    const ctx = member(tenantThreads);
    const first = await receiveInbound(ctx, {
      provider: 'whatsapp',
      payload: whatsappPayload('+15551234567', 'first turn', 'wamid.1001', '1760426100'),
    });
    const second = await receiveInbound(ctx, {
      provider: 'whatsapp',
      payload: whatsappPayload('+15551234567', 'second turn', 'wamid.1002', '1760426200'),
    });
    expect(second.message.conversationId).toBe(first.message.conversationId);
    expect(second.identityCreated).toBe(false);

    const conversation = await getConversation(ctx, first.message.conversationId);
    expect(conversation.messageCount).toBe(2);

    const transcript = await listMessages(ctx, { conversationId: conversation.id });
    expect(transcript.map((message) => message.payload)).toEqual([
      { kind: 'message', content: { text: 'first turn', attachments: [] } },
      { kind: 'message', content: { text: 'second turn', attachments: [] } },
    ]);
  });

  it('redelivered provider messages replay the original turn', async () => {
    const ctx = member(tenantThreads);
    const first = await receiveInbound(ctx, {
      provider: 'whatsapp',
      payload: whatsappPayload('+15559900111', 'only once', 'wamid.2001'),
    });
    const replay = await receiveInbound(ctx, {
      provider: 'whatsapp',
      payload: whatsappPayload('+15559900111', 'only once', 'wamid.2001'),
    });
    expect(replay.message.id).toBe(first.message.id);
    const messages = await listMessages(ctx, { channel: 'whatsapp', limit: 500 });
    const forAccount = messages.filter((message) => message.actor.identityId === first.identity.id);
    expect(forAccount).toHaveLength(1);
  });

  it('threads emails by normalized subject and titles the conversation', async () => {
    const ctx = member(tenantThreads);
    const first = await receiveInbound(ctx, {
      provider: 'email',
      payload: emailPayload('Q4 planning', 'the numbers are in', '<m1@corp.com>'),
    });
    const reply = await receiveInbound(ctx, {
      provider: 'email',
      payload: emailPayload('Re: Q4 planning', 'thanks, reviewing', '<m2@corp.com>'),
    });
    expect(reply.message.conversationId).toBe(first.message.conversationId);
    expect(first.message.providerMessageId).toBe('<m1@corp.com>');
    expect(first.message.actor).toMatchObject({ kind: 'external', label: 'Erin Chu' });

    const conversation = await getConversation(ctx, first.message.conversationId);
    expect(conversation.title).toBe('Q4 planning');
  });

  it('attributes inbound turns to a person only through a verified, linked identity', async () => {
    const adminCtx = admin(tenantA);
    const person = await createPerson(adminCtx, { fullName: 'Alice Ackermann' });

    // First contact: unverified → external.
    const first = await receiveInbound(adminCtx, {
      provider: 'whatsapp',
      payload: whatsappPayload('+15557770101', 'first contact', 'wamid.3001'),
    });
    expect(first.message.actor.kind).toBe('external');

    // Admin attests + links the identity (W002 workflow).
    await attestIdentity(adminCtx, { identityId: first.identity.id, evidence: 'checked in person' });
    await attachVerifiedSubject(adminCtx, { identityId: first.identity.id, subjectId: person.id });

    // Same account again: verified + linked → person.
    const second = await receiveInbound(adminCtx, {
      provider: 'whatsapp',
      payload: whatsappPayload('+15557770101', 'speaking again', 'wamid.3002'),
    });
    expect(second.message.actor.kind).toBe('person');
    expect(second.message.actor.id).toBe(person.id);
    expect(second.message.actor.identityId).toBe(first.identity.id);
  });

  it('normalizes every remaining provider webhook into canonical turns', async () => {
    const ctx = member(tenantA);

    const cases: Array<{
      provider: string;
      payload: Record<string, unknown>;
      threadKey: string | null;
      sentAt: string | null;
      account: string;
      label: string | null;
    }> = [
      { provider: 'telegram', payload: telegramPayload('shipment landed', 42), threadKey: 'chat:-100123', sentAt: new Date(1_760_426_100_000).toISOString(), account: '98765', label: 'Bob Tan' },
      { provider: 'slack', payload: slackPayload('deploy finished', '1760426100.001500'), threadKey: 'C456DEF', sentAt: new Date(1_760_426_100_001).toISOString(), account: 'U123ABC', label: null },
      { provider: 'sms', payload: smsPayload('gate code 4711', 'SM0001'), threadKey: '+15550100000|+15551234567', sentAt: null, account: '+15551234567', label: null },
      { provider: 'voice', payload: voicePayload('please check the invoice', 'CA1:turn-1'), threadKey: 'CA1234567890', sentAt: null, account: '+15551234567', label: null },
      { provider: 'web', payload: webPayload('where is the tracker?', 'web-0001'), threadKey: 'sess-2026-10-14-1', sentAt: '2026-10-14T10:00:00.000Z', account: 'visitor-9', label: 'Frank Ibe' },
      { provider: 'x', payload: xPayload('competitor slashed prices', '15001'), threadKey: '112233|224466', sentAt: new Date(1_760_426_100_123).toISOString(), account: '224466', label: 'Dana Reed' },
      { provider: 'instagram', payload: instagramPayload('the reel is live', 'm_9x'), threadKey: '178900|771100', sentAt: new Date(1_760_426_100_123).toISOString(), account: '771100', label: null },
      { provider: 'facebook', payload: facebookPayload('on site', 'mid.1'), threadKey: '5150|9999', sentAt: new Date(1_760_426_100_123).toISOString(), account: '5150', label: null },
      { provider: 'linkedin', payload: linkedinPayload('contract draft attached', 'urn:li:message:77'), threadKey: 'urn:li:messagingThread:abc123', sentAt: '2026-10-14T09:00:00.000Z', account: 'member-42', label: null },
      { provider: 'signal', payload: signalPayload('permits cleared'), threadKey: '+15559900111', sentAt: new Date(1_760_426_100_123).toISOString(), account: '+15559900111', label: 'Carol Diaz' },
    ];

    for (const testCase of cases) {
      const result = await receiveInbound(ctx, {
        provider: testCase.provider as never,
        payload: testCase.payload,
      });
      expect(result.message.channel, testCase.provider).toBe(testCase.provider);
      expect(result.identity.providerAccountId, testCase.provider).toBe(testCase.account);
      expect(result.threadKey, testCase.provider).toBe(testCase.threadKey);
      expect(result.message.actor.kind, testCase.provider).toBe('external');
      if (testCase.sentAt !== null) {
        expect(result.message.sentAt, testCase.provider).toBe(testCase.sentAt);
      }
      // Carriers without a sender clock still get an honest service-clock sentAt.
      expect(typeof result.message.sentAt, testCase.provider).toBe('string');
    }
  });

  it('never lets provider envelope fragments reach the transcript payload', async () => {
    const ctx = member(tenantA);
    const results = [
      await receiveInbound(ctx, { provider: 'whatsapp', payload: whatsappPayload('+15551112222', 'wa text', 'wamid.5001') }),
      await receiveInbound(ctx, { provider: 'telegram', payload: telegramPayload('tg text', 77) }),
      await receiveInbound(ctx, { provider: 'slack', payload: slackPayload('slack text', '1760426100.0001') }),
      await receiveInbound(ctx, { provider: 'x', payload: xPayload('x text', '15002') }),
      await receiveInbound(ctx, { provider: 'instagram', payload: instagramPayload('ig text', 'm_ig') }),
    ];
    const forbidden = ['entry', 'changes', 'wa_id', 'direct_message_events', 'event_callback', 'message_id', 'first_name', 'sourceNumber'];
    for (const result of results) {
      const serialized = JSON.stringify(result.message.payload);
      for (const fragment of forbidden) {
        expect(serialized.includes(fragment), `${result.message.channel}/${fragment}`).toBe(false);
      }
    }
  });

  it('rejects unsupported events and malformed payloads without persisting anything', async () => {
    const ctx = member(newId());
    await expectCode('unsupported_provider_event', () =>
      receiveInbound(ctx, { provider: 'slack', payload: { type: 'url_verification', challenge: 'abc' } }),
    );
    await expectCode('unsupported_provider_event', () =>
      receiveInbound(ctx, { provider: 'whatsapp', payload: { entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.1', status: 'delivered' }] } }] }] } }),
    );
    await expectCode('invalid_provider_payload', () =>
      receiveInbound(ctx, { provider: 'telegram', payload: { message: { message_id: 1, chat: { id: 1 }, date: 1, text: 'x' } } }),
    );

    // Nothing was registered or recorded in this tenant for those senders.
    expect(
      await findExternalIdentityByProviderKey(ctx, { provider: 'slack', providerAccountId: 'U999ZZZ' }),
    ).toBeNull();
    const recorded = await listMessages(ctx, { limit: 500 });
    expect(recorded).toHaveLength(0);
  });

  it('isolates tenants end-to-end (identities, transcripts, threads)', async () => {
    const ctxA = member(tenantIsolation);
    const ctxB = member(tenantB);
    const payload = whatsappPayload('+15553330444', 'tenant scoped', 'wamid.6001');

    const inA = await receiveInbound(ctxA, { provider: 'whatsapp', payload });
    const inB = await receiveInbound(ctxB, { provider: 'whatsapp', payload });

    expect(inA.identity.id).not.toBe(inB.identity.id);
    expect(inA.message.conversationId).not.toBe(inB.message.conversationId);

    const crossMessages = await listMessages(ctxA, { conversationId: inB.message.conversationId });
    expect(crossMessages).toHaveLength(0);
    // Cross-tenant conversations are not visible from the other tenant
    // (conversations contract's uniform not-found, exercised through the
    // same tenant scoping the channels module applies).
    await expect(getConversation(ctxA, inB.message.conversationId)).rejects.toMatchObject({
      code: 'conversation_not_found',
    });
  });
});

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

describe('outbound delivery (sendOutbound)', () => {
  it('fails explicitly when no transport is wired (provider availability)', async () => {
    const ctx = member(tenantOutbound);
    await registerChannelConnection(ctx, { provider: 'whatsapp', providerAccountId: '15550100000', credentialRef: 'r' });
    expect(getChannelTransport()).toBeNull();
    await expectCode('provider_unavailable', () =>
      sendOutbound(ctx, {
        provider: 'whatsapp',
        to: { providerAccountId: '+15551234567', displayName: 'Alice' },
        content: { text: 'hello', attachments: [] },
      }),
    );
  });

  it('delivers through the provider-neutral transport, then records what was sent', async () => {
    const ctx = member(tenantOutbound);
    const { connection } = await registerChannelConnection(ctx, {
      provider: 'whatsapp',
      providerAccountId: '15550100001',
      displayName: 'Ops WhatsApp',
      credentialRef: 'r',
    });
    setChannelTransport(transport);

    const result = await sendOutbound(ctx, {
      provider: 'whatsapp',
      connectionId: connection.id,
      to: { providerAccountId: ' 1555 123 4567 ', displayName: 'Alice' },
      content: { text: 'the meeting is confirmed', attachments: [] },
    });

    // The transport request is provider-neutral and carries no provider envelope.
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]).toMatchObject({
      provider: 'whatsapp',
      tenantId: tenantOutbound,
      purpose: 'message',
      from: { providerAccountId: '+15550100001', displayName: 'Ops WhatsApp' },
      to: { providerAccountId: '+15551234567', displayName: 'Alice' },
    });
    expect(transport.requests[0]!.message.text).toBe('the meeting is confirmed');

    // The transcript records what was actually sent, with the transport's
    // provider message id and the connection as the system actor.
    expect(result.receipt.status).toBe('delivered');
    expect(result.message).toMatchObject({
      direction: 'outbound',
      channel: 'whatsapp',
      providerMessageId: result.receipt.providerMessageId,
    });
    expect(result.message.actor).toEqual({
      kind: 'system',
      id: null,
      label: 'Ops WhatsApp',
      identityId: null,
    });
    expect(result.message.payload).toEqual({
      kind: 'message',
      to: { providerAccountId: '+15551234567', displayName: 'Alice' },
      subject: null,
      content: { text: 'the meeting is confirmed', attachments: [] },
    });
    expect(connection.status).toBe('active');
  });

  it('threads an outbound turn into an existing conversation and rejects foreign threads', async () => {
    const ctx = member(tenantOutbound);
    const { connection } = await registerChannelConnection(ctx, { provider: 'whatsapp', providerAccountId: '15550100000', credentialRef: 'r' });
    setChannelTransport(transport);

    const inbound = await receiveInbound(ctx, {
      provider: 'whatsapp',
      payload: whatsappPayload('+15552223333', 'question about the order', 'wamid.7001'),
    });
    const reply = await sendOutbound(ctx, {
      provider: 'whatsapp',
      connectionId: connection.id,
      to: { providerAccountId: '+15552223333', displayName: null },
      content: { text: 'the order ships today', attachments: [] },
      conversationId: inbound.message.conversationId,
    });
    expect(reply.message.conversationId).toBe(inbound.message.conversationId);

    await expectCode('conversation_not_found', () =>
      sendOutbound(ctx, {
        provider: 'whatsapp',
        connectionId: connection.id,
        to: { providerAccountId: '+15552223333', displayName: null },
        content: { text: 'x', attachments: [] },
        conversationId: newId(),
      }),
    );
    // Cross-tenant conversations are indistinguishable from missing ones.
    const foreign = await receiveInbound(member(tenantB), {
      provider: 'whatsapp',
      payload: whatsappPayload('+15552223333', 'other tenant', 'wamid.7002'),
    });
    await expectCode('conversation_not_found', () =>
      sendOutbound(ctx, {
        provider: 'whatsapp',
        connectionId: connection.id,
        to: { providerAccountId: '+15552223333', displayName: null },
        content: { text: 'x', attachments: [] },
        conversationId: foreign.message.conversationId,
      }),
    );
  });

  it('maps transport outcomes to explicit errors and records nothing on failure', async () => {
    const ctx = member(tenantOutbound);
    await registerChannelConnection(ctx, { provider: 'slack', providerAccountId: 'TWORKSPACE', credentialRef: 'r' });
    setChannelTransport(transport);

    const before = await listMessages(ctx, { channel: 'slack', direction: 'outbound' });

    transport.overrideReceipt({ status: 'rejected', providerMessageId: null, detail: 'user is deactivated' });
    await expectCode('delivery_rejected', () =>
      sendOutbound(ctx, {
        provider: 'slack',
        to: { providerAccountId: 'U123ABC', displayName: null },
        content: { text: 'hello', attachments: [] },
      }),
    );

    transport.overrideReceipt({ status: 'failed', providerMessageId: null, detail: 'upstream 503' });
    await expectCode('delivery_failed', () =>
      sendOutbound(ctx, {
        provider: 'slack',
        to: { providerAccountId: 'U123ABC', displayName: null },
        content: { text: 'hello', attachments: [] },
      }),
    );

    const after = await listMessages(ctx, { channel: 'slack', direction: 'outbound' });
    expect(after).toEqual(before); // nothing was sent → nothing recorded
  });

  it('resolves the sending connection explicitly or auto-selects the unique active one', async () => {
    const ctx = member(tenantOutbound);
    const email1 = await registerChannelConnection(ctx, { provider: 'email', providerAccountId: 'ops@tenant.example', displayName: 'Ops mailbox', credentialRef: 'r1' });
    const email2 = await registerChannelConnection(ctx, { provider: 'email', providerAccountId: 'alerts@tenant.example', credentialRef: 'r2' });
    setChannelTransport(transport);

    // Two active connections → ambiguous without an explicit id.
    await expectCode('connection_ambiguous', () =>
      sendOutbound(ctx, {
        provider: 'email',
        to: { providerAccountId: 'erin.chu@corp.com', displayName: null },
        content: { text: 'hello', attachments: [] },
      }),
    );

    // Explicit id wins; the receipt's subject default flows into the payload.
    const explicit = await sendOutbound(ctx, {
      provider: 'email',
      connectionId: email1.connection.id,
      to: { providerAccountId: 'Erin.Chu@Corp.com', displayName: 'Erin' },
      content: { text: 'quarterly summary', attachments: [] },
    });
    expect(explicit.message.payload).toMatchObject({
      kind: 'message',
      subject: 'quarterly summary',
      to: { providerAccountId: 'erin.chu@corp.com' },
    });

    // A connection of another provider is not a valid sender.
    const slack = await registerChannelConnection(ctx, { provider: 'slack', providerAccountId: 'TWORKSPACE2', credentialRef: 'r3' });
    await expectCode('invalid_channel_input', () =>
      sendOutbound(ctx, {
        provider: 'email',
        connectionId: slack.connection.id,
        to: { providerAccountId: 'erin.chu@corp.com', displayName: null },
        content: { text: 'x', attachments: [] },
      }),
    );

    // Disabling one of the two leaves a unique active connection.
    await setChannelConnectionStatus(ctx, { connectionId: email2.connection.id, status: 'disabled' });
    const auto = await sendOutbound(ctx, {
      provider: 'email',
      to: { providerAccountId: 'erin.chu@corp.com', displayName: null },
      content: { text: 'auto-selected', attachments: [] },
    });
    expect(auto.message.actor.label).toBe('Ops mailbox');

    // No active connection at all — and the distinction matters: the tenant
    // HAS email connections, they are all disabled.
    await setChannelConnectionStatus(ctx, { connectionId: email1.connection.id, status: 'disabled' });
    await expectCode('connection_disabled', () =>
      sendOutbound(ctx, {
        provider: 'email',
        to: { providerAccountId: 'erin.chu@corp.com', displayName: null },
        content: { text: 'x', attachments: [] },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Verification challenges
// ---------------------------------------------------------------------------

describe('identity verification challenges (delivery assigned to W030)', () => {
  let challengeAccountCounter = 0;

  async function setupIdentityAndConnection(): Promise<{
    ctx: TenantContext;
    identityId: string;
    account: string;
  }> {
    // Every test gets a FRESH account + challenge so identity lifecycle
    // states (pending/verified) never bleed between tests.
    challengeAccountCounter += 1;
    const account = `+1555666${String(challengeAccountCounter).padStart(4, '0')}`;
    const ctx = member(tenantChallenges);
    const result = await receiveInbound(ctx, {
      provider: 'whatsapp',
      payload: whatsappPayload(account, 'hi, this is Grace', `wamid.8${String(challengeAccountCounter).padStart(3, '0')}`),
    });
    await registerChannelConnection(ctx, {
      provider: 'whatsapp',
      providerAccountId: '15550100000',
      displayName: 'Ops WhatsApp',
      credentialRef: 'r',
    });
    return { ctx, identityId: result.identity.id, account };
  }

  it('delivers the single-use code over the channel and NEVER persists it', async () => {
    const { ctx, identityId, account } = await setupIdentityAndConnection();
    setChannelTransport(transport);

    const delivery = await deliverIdentityChallenge(ctx, { identityId });
    expect(delivery.identityId).toBe(identityId);
    expect(delivery.expiresAt).toBeTruthy();
    expect(delivery.receipt.status).toBe('delivered');

    // The transport DID carry the code (six digits inside the message text).
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]).toMatchObject({ purpose: 'verification', tenantId: tenantChallenges });
    const codeMatch = /(\d{6})/.exec(transport.requests[0]!.message.text);
    expect(codeMatch).not.toBeNull();
    const code = codeMatch![1]!;

    // The identity moved to `pending` (challenge issued, W002).
    const identity = await getExternalIdentity(ctx, identityId);
    expect(identity.status).toBe('pending');

    // The transcript turn proves the delivery but carries a redaction marker
    // — the credential value is absent from the ENTIRE recorded payload.
    expect(delivery.message.direction).toBe('outbound');
    expect(delivery.message.channel).toBe('whatsapp');
    expect(delivery.message.payload).toMatchObject({
      kind: 'verification_code',
      to: { providerAccountId: account },
      redaction: { reason: expect.stringContaining('never stored in transcripts') },
    });
    expect(JSON.stringify(delivery.message.payload)).not.toContain(code);
  });

  it('completes verification from the channel-replied code', async () => {
    const { ctx, identityId, account } = await setupIdentityAndConnection();
    setChannelTransport(transport);
    await deliverIdentityChallenge(ctx, { identityId });
    const code = /(\d{6})/.exec(transport.requests[0]!.message.text)![1]!;

    // The account holder replies over the channel; the reply is a normal
    // inbound turn, and its text is fed back through the channels contract.
    await receiveInbound(ctx, {
      provider: 'whatsapp',
      payload: whatsappPayload(account, code, 'wamid.8002'),
    });

    const verified = await completeIdentityChallenge(ctx, { identityId, code });
    expect(verified.status).toBe('verified');
    expect(verified.verificationMethod).toBe('challenge_response');

    // Inbound turns from the now-verified account are person-attributable
    // (once linked to a subject — lock 15).
    const adminCtx = admin(tenantChallenges);
    const person = await createPerson(adminCtx, { fullName: 'Grace Ho' });
    await attachVerifiedSubject(adminCtx, { identityId, subjectId: person.id });
    const after = await receiveInbound(ctx, {
      provider: 'whatsapp',
      payload: whatsappPayload(account, 'verified now', 'wamid.8003'),
    });
    expect(after.message.actor.kind).toBe('person');
  });

  it('enforces challenge semantics (mismatch, not-active, eligibility, tenancy)', async () => {
    const { ctx, identityId } = await setupIdentityAndConnection();
    setChannelTransport(transport);

    // No challenge issued yet.
    await expectCode('challenge_not_active', () =>
      completeIdentityChallenge(ctx, { identityId, code: '000000' }),
    );

    await deliverIdentityChallenge(ctx, { identityId });
    await expectCode('challenge_code_mismatch', () =>
      completeIdentityChallenge(ctx, { identityId, code: '000000' }),
    );

    // Foreign identity → uniform invalid provenance (no leak).
    await expectCode('invalid_provenance', () =>
      deliverIdentityChallenge(member(tenantB), { identityId }),
    );
    await expectCode('invalid_provenance', () =>
      completeIdentityChallenge(member(tenantB), { identityId, code: '123456' }),
    );

    // Already-verified identities are not eligible for a new challenge.
    const adminCtx = admin(tenantChallenges);
    await attestIdentity(adminCtx, { identityId, evidence: 'in-person check' });
    await expectCode('identity_not_eligible', () => deliverIdentityChallenge(ctx, { identityId }));
  });

  it('requires an active sending connection for the identity provider', async () => {
    const ctx = member(tenantChallenges);
    const result = await receiveInbound(ctx, {
      provider: 'telegram',
      payload: telegramPayload('verify me', 99),
    });
    setChannelTransport(transport);
    await expectCode('connection_not_found', () =>
      deliverIdentityChallenge(ctx, { identityId: result.identity.id }),
    );
  });
});

// ---------------------------------------------------------------------------
// Storage discipline + public-surface isolation
// ---------------------------------------------------------------------------

describe('storage discipline and provider isolation of the surface', () => {
  it('channel_threads is append-only (PostgreSQL rejects UPDATE/DELETE/TRUNCATE)', async () => {
    const ctx = member(tenantImmutable);
    const result = await receiveInbound(ctx, {
      provider: 'whatsapp',
      payload: whatsappPayload('+15554440505', 'immutable routing', 'wamid.9001'),
    });
    const db = getDb();
    const mapping = await db.query<{ id: string }>(
      `SELECT id FROM channel_threads WHERE tenant_id = $1 AND provider = 'whatsapp'`,
      [tenantImmutable],
    );
    expect(mapping.rows).toHaveLength(1);
    const id = mapping.rows[0]!.id;

    await expect(db.query(`UPDATE channel_threads SET conversation_id = gen_random_uuid() WHERE id = $1`, [id])).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM channel_threads WHERE id = $1`, [id])).rejects.toThrow(/append-only/);
    await expect(db.query(`TRUNCATE channel_threads`)).rejects.toThrow(/append-only/);

    // The mapping still routes (nothing changed).
    const again = await receiveInbound(ctx, {
      provider: 'whatsapp',
      payload: whatsappPayload('+15554440505', 'still routed', 'wamid.9002'),
    });
    expect(again.message.conversationId).toBe(result.message.conversationId);
  });

  it('channel_connections carries tenant scoping at the storage layer', async () => {
    const ctx = member(tenantImmutable);
    await registerChannelConnection(ctx, { provider: 'web', providerAccountId: 'widget-origin-1', credentialRef: 'r' });
    const rows = await getDb().query<{ tenant_id: string }>(
      `SELECT tenant_id FROM channel_connections WHERE provider = 'web'`,
    );
    expect(rows.rows.every((row) => row.tenant_id === tenantImmutable || row.tenant_id === tenantB || row.tenant_id === tenantOutbound)).toBe(true);
    expect(rows.rows.some((row) => row.tenant_id === tenantImmutable)).toBe(true);
  });

  it('exports no adapter symbols through the public contract', () => {
    const exported = Object.keys(channelsContract);
    const forbidden = [
      'getChannelAdapter',
      'allChannelAdapters',
      'whatsappAdapter',
      'telegramAdapter',
      'signalAdapter',
      'slackAdapter',
      'xAdapter',
      'instagramAdapter',
      'facebookAdapter',
      'linkedinAdapter',
      'emailAdapter',
      'smsAdapter',
      'voiceAdapter',
      'webAdapter',
    ];
    for (const symbol of forbidden) {
      expect(exported, symbol).not.toContain(symbol);
    }
  });
});
