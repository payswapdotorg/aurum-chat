// W044 — Tenant Isolation Verification · application-boundary sweep for the
// experience/platform modules: conversations (W029), channels (W030),
// notifications (W031), llm (W034), sources (W036), briefings (W032) and
// destinations (W037).
//
// Same doctrine as the other sweeps, plus the provider-boundary specifics:
//   * channel/LLM/source connections with the SAME provider account exist
//     independently per tenant (per-tenant namespaces on provider identity);
//   * transport ports are process-global infrastructure, so the sweep also
//     proves tenant-scoped resolution happens BEFORE any provider dispatch
//     (a foreign poll never reaches the transport);
//   * provider message dedupe keys are per-tenant;
//   * notifications (including acknowledgments and policy rows) never leak;
//   * webhook envelopes resolve only onto the calling tenant's sources.
//
// Process-global transports are wired per file and unwired in afterAll.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import {
  createConversation,
  getConversation,
  getMessage,
  listConversations,
  listMessages,
  recordExecutionLink,
  recordMessage,
} from '@/modules/conversations/contract';
import {
  completeIdentityChallenge,
  deliverIdentityChallenge,
  getChannelConnection,
  listChannelConnections,
  receiveInbound,
  registerChannelConnection,
  sendOutbound,
  setChannelConnectionStatus,
  setChannelTransport,
  type CanonicalDeliveryRequest,
  type ChannelTransport,
  type TransportReceipt,
} from '@/modules/channels/contract';
import {
  acknowledgeNotification,
  createNotification,
  getNotification,
  getNotificationAcknowledgment,
  getNotificationPolicy,
  listNotificationAttempts,
  listNotifications,
  retryDueNotifications,
  flushDueDigests,
  escalateUnacknowledged,
  setNotificationPolicy,
} from '@/modules/notifications/contract';
import {
  getAiProviderAccount,
  getAiProviderAccountSpend,
  getLlmExecution,
  invokeLlm,
  listAiProviderAccounts,
  listLlmExecutions,
  registerAiProviderAccount,
  setAiAvailability,
  setLlmTransport,
  updateAiProviderAccount,
  type LlmCapability,
  type LlmScope,
  type LlmTransport,
  type LlmTransportReceipt,
  type LlmTransportRequest,
} from '@/modules/llm/contract';
import {
  getSource,
  getSourceCheckpoint,
  listSourceCheckpoints,
  listSources,
  pollSource,
  receiveSourceWebhook,
  registerSource,
  replaySource,
  setSourceTransport,
  setSourceStatus,
  type CanonicalSourceRecord,
  type SourceFetchResult,
  type SourceTransport,
} from '@/modules/sources/contract';
import {
  BRIEFING_NOTIFICATION_KIND,
  generateBriefing,
  getBriefing,
  getBriefingPolicy,
  listBriefingPolicies,
  listBriefings,
  resolveBriefingPolicy,
  setBriefingPolicy,
} from '@/modules/briefings/contract';
import {
  dispatchDelivery,
  getDelivery,
  getDestination,
  listDeliveryAttempts,
  listDeliveries,
  listDestinations,
  registerDestination,
  replayDelivery,
  retryDelivery,
  setDestinationStatus,
  setDestinationTransport,
  type DestinationDeliveryRequest,
  type DestinationTransport,
  type TransportReceipt as DestinationReceipt,
} from '@/modules/destinations/contract';
import { decideApproval } from '@/modules/actions/contract';
import { recordUnknown } from '@/modules/epistemics/contract';
import { listObservations, recordObservation } from '@/modules/observations/contract';
import {
  assertTenantPartition,
  expectUniformNotFound,
  member,
  memberWith,
  OMNIPOTENT_AUTHORITY,
  omnipotent,
  runMigrations,
  storedTenantId,
} from './harness';

const tenantA = newId();
const tenantB = newId();
const tenantC = newId(); // no sources — webhook resolution control
const ctxA = member(tenantA);
const ctxB = member(tenantB);
const ctxC = member(tenantC);

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  setChannelTransport(null);
  setLlmTransport(null);
  setSourceTransport(null);
  setDestinationTransport(null);
  await closeDb();
});

// ---------------------------------------------------------------------------
// conversations (W029)
// ---------------------------------------------------------------------------

describe('W044 conversations — transcripts are tenant-scoped', () => {
  const messageInput = (conversationId?: string, providerMessageId = 'wamid.w044-iso') => ({
    direction: 'inbound' as const,
    actor: { kind: 'external' as const, label: 'unregistered customer' },
    channel: 'whatsapp' as const,
    payload: { text: 'the supplier meeting moved to Friday' },
    sentAt: '2026-09-14T09:15:00Z',
    conversationId,
    providerMessageId,
  });

  it('gives the same title and provider message id independent rows per tenant', async () => {
    const convA = await createConversation(ctxA, { title: 'Supplier escalation' });
    const convB = await createConversation(ctxB, { title: 'Supplier escalation' });
    expect(convA.id).not.toBe(convB.id);

    const messageA = await recordMessage(ctxA, messageInput(convA.id));
    const messageB = await recordMessage(ctxB, messageInput(convB.id));
    expect(messageA.id).not.toBe(messageB.id); // same providerMessageId, both recorded

    // In-tenant dedupe: replaying the same provider message id returns the
    // SAME row — the namespace that dedupes is (tenant, channel, key).
    const replayA = await recordMessage(ctxA, messageInput(convA.id));
    expect(replayA.id).toBe(messageA.id);
  });

  it('fails cross-tenant reads and writes uniformly', async () => {
    const convA = await createConversation(ctxA, { title: 'Iso Guard A' });
    const messageA = await recordMessage(ctxA, messageInput(convA.id, 'wamid.w044-iso-guard'));

    await expectUniformNotFound(
      'conversation_not_found',
      () => getConversation(ctxB, convA.id),
      () => getConversation(ctxB, newId()),
    );
    await expectUniformNotFound(
      'message_not_found',
      () => getMessage(ctxB, messageA.id),
      () => getMessage(ctxB, newId()),
    );
    // B cannot append into A's thread (a fresh provider message id, so the
    // per-tenant dedupe replay cannot short-circuit the probe)...
    await expect(
      recordMessage(ctxB, messageInput(convA.id, 'wamid.w044-foreign-append')),
    ).rejects.toMatchObject({
      code: 'conversation_not_found',
    });
    // ...nor link executions to A's messages.
    await expect(
      recordExecutionLink(ctxB, { messageId: messageA.id, executionId: newId(), role: 'triggered' }),
    ).rejects.toMatchObject({ code: 'message_not_found' });

    // Listings stay per-tenant (a foreign conversation filter is just empty,
    // never an error, never a leak).
    expect(await listConversations(ctxB, {})).toHaveLength(1);
    expect(await listMessages(ctxB, { conversationId: convA.id })).toEqual([]);
    expect((await listMessages(ctxA, { conversationId: convA.id })).map((message) => message.id)).toEqual([
      messageA.id,
    ]);
  });
});

// ---------------------------------------------------------------------------
// channels (W030)
// ---------------------------------------------------------------------------

/** Deterministic fake channel transport (no provider SDK, no network). */
class RecordingChannelTransport implements ChannelTransport {
  readonly requests: CanonicalDeliveryRequest[] = [];
  private counter = 0;
  async deliver(request: CanonicalDeliveryRequest): Promise<TransportReceipt> {
    this.requests.push(request);
    this.counter += 1;
    return {
      status: 'delivered',
      providerMessageId: `prov-out-${String(this.counter).padStart(6, '0')}`,
      detail: null,
    };
  }
}

function whatsappPayload(from: string, text: string, wamid: string) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { display_phone_number: '15550100000' },
              contacts: [{ profile: { name: 'Alice Wong' }, wa_id: from.replace('+', '') }],
              messages: [{ from: from.replace('+', ''), id: wamid, timestamp: '1760426100', type: 'text', text: { body: text } }],
            },
          },
        ],
      },
    ],
  };
}

describe('W044 channels — connections, threads and identities are tenant-scoped', () => {
  it('gives the same provider account independent connections per tenant', async () => {
    const first = await registerChannelConnection(ctxA, {
      provider: 'whatsapp',
      providerAccountId: ' 1555 010 0000 ',
      displayName: 'Alpha Ops WhatsApp',
      credentialRef: 'secret-store://whatsapp/alpha',
    });
    const second = await registerChannelConnection(ctxB, {
      provider: 'whatsapp',
      providerAccountId: '15550100000',
      displayName: 'Beta Ops WhatsApp',
      credentialRef: 'secret-store://whatsapp/beta',
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(first.connection.id).not.toBe(second.connection.id);

    expect((await listChannelConnections(ctxB, {})).map((connection) => connection.id)).not.toContain(
      first.connection.id,
    );
  });

  it('fails cross-tenant connection reads and writes uniformly', async () => {
    const { connection } = await registerChannelConnection(ctxA, {
      provider: 'slack',
      providerAccountId: 'ALPHAOPS',
      credentialRef: 'secret-store://slack/alpha',
    });

    await expectUniformNotFound(
      'connection_not_found',
      () => getChannelConnection(ctxB, connection.id),
      () => getChannelConnection(ctxB, newId()),
    );
    await expect(
      setChannelConnectionStatus(ctxB, { connectionId: connection.id, status: 'disabled' }),
    ).rejects.toMatchObject({ code: 'connection_not_found' });
    // A's connection is still active after B's probe.
    expect((await getChannelConnection(ctxA, connection.id)).status).toBe('active');
  });

  it('keeps inbound identity resolution and challenge delivery in-tenant', async () => {
    const transport = new RecordingChannelTransport();
    setChannelTransport(transport);

    const { connection } = await registerChannelConnection(ctxA, {
      provider: 'whatsapp',
      providerAccountId: '15550100001',
      displayName: 'Alpha Ops WhatsApp',
      credentialRef: 'secret-store://whatsapp/alpha',
    });
    const { connection: connectionB } = await registerChannelConnection(ctxB, {
      provider: 'whatsapp',
      providerAccountId: '15550100001',
      displayName: 'Beta Ops WhatsApp',
      credentialRef: 'secret-store://whatsapp/beta',
    });

    // The same external WhatsApp account messages BOTH tenants: each tenant
    // auto-registers its OWN identity for it (per-tenant namespace).
    const inboundA = await receiveInbound(ctxA, {
      provider: 'whatsapp',
      payload: whatsappPayload('+15551234567', 'alpha thread', 'wamid.w044.a'),
    });
    const inboundB = await receiveInbound(ctxB, {
      provider: 'whatsapp',
      payload: whatsappPayload('+15551234567', 'beta thread', 'wamid.w044.b'),
    });
    expect(inboundA.identity.id).not.toBe(inboundB.identity.id);
    expect(inboundA.message.conversationId).not.toBe(inboundB.message.conversationId);

    // B cannot deliver a challenge to A's identity, nor complete one.
    await expect(
      deliverIdentityChallenge(ctxB, { identityId: inboundA.identity.id }),
    ).rejects.toMatchObject({ code: 'invalid_provenance' });
    await expect(
      completeIdentityChallenge(ctxB, { identityId: inboundA.identity.id, code: '000000' }),
    ).rejects.toMatchObject({ code: 'invalid_provenance' });

    // B cannot thread an outbound message into A's conversation.
    await expect(
      sendOutbound(ctxB, {
        provider: 'whatsapp',
        connectionId: connectionB.id,
        to: { providerAccountId: '+15551234567', displayName: null },
        content: { text: 'pwned', attachments: [] },
        conversationId: inboundA.message.conversationId,
      }),
    ).rejects.toMatchObject({ code: 'conversation_not_found' });

    // A's own flow works end-to-end after every B probe.
    const reply = await sendOutbound(ctxA, {
      provider: 'whatsapp',
      connectionId: connection.id,
      to: { providerAccountId: '+15551234567', displayName: null },
      content: { text: 'the order ships today', attachments: [] },
      conversationId: inboundA.message.conversationId,
    });
    expect(reply.message.conversationId).toBe(inboundA.message.conversationId);
    expect((await listMessages(ctxA, { conversationId: inboundA.message.conversationId })).length).toBe(2);
    expect(await listMessages(ctxB, { conversationId: inboundA.message.conversationId })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// notifications (W031)
// ---------------------------------------------------------------------------

describe('W044 notifications — notifications, policies and pumps are tenant-scoped', () => {
  const notificationAdminA = memberWith(tenantA, ['notifications:administer']);

  it('delivers same-key notifications independently per tenant', async () => {
    const transport = new RecordingChannelTransport();
    setChannelTransport(transport);
    // Each tenant registers its own email-capable channel connection.
    await registerChannelConnection(ctxA, {
      provider: 'email',
      providerAccountId: 'ops@alpha.example',
      credentialRef: 'secret-store://email/alpha',
    });
    await registerChannelConnection(ctxB, {
      provider: 'email',
      providerAccountId: 'ops@beta.example',
      credentialRef: 'secret-store://email/beta',
    });
    // A pins an acknowledgment-requiring policy for its own kind (policy
    // writes are explicit: every governing field is provided).
    await setNotificationPolicy(notificationAdminA, {
      notificationKind: 'w044.ack.kind',
      deliveryClass: 'urgent',
      maxAttempts: 3,
      retryBackoffSeconds: 60,
      dedupeWindowSeconds: 300,
      digestWindowSeconds: 3600,
      requireAcknowledgment: true,
    });

    const createdA = await createNotification(ctxA, {
      kind: 'w044.ack.kind',
      recipient: { provider: 'email', providerAccountId: 'manager@corp.example' },
      subject: 'Approval requested A',
      body: 'Alpha body.',
      dedupeKey: 'w044-iso-key',
    });
    const createdB = await createNotification(ctxB, {
      kind: 'w044.ack.kind',
      recipient: { provider: 'email', providerAccountId: 'manager@corp.example' },
      subject: 'Approval requested B',
      body: 'Beta body.',
      dedupeKey: 'w044-iso-key',
    });
    expect(createdA.notification.id).not.toBe(createdB.notification.id);
    expect(createdA.notification.status).toBe('delivered');
    expect(createdB.notification.status).toBe('delivered');

    // A acknowledges its notification; B cannot even see it.
    await acknowledgeNotification(ctxA, { notificationId: createdA.notification.id, note: 'on it' });
    await expectUniformNotFound(
      'notification_not_found',
      () => getNotification(ctxB, { notificationId: createdA.notification.id }),
      () => getNotification(ctxB, { notificationId: newId() }),
    );
    await expect(
      listNotificationAttempts(ctxB, { notificationId: createdA.notification.id }),
    ).rejects.toMatchObject({ code: 'notification_not_found' });
    await expect(
      acknowledgeNotification(ctxB, { notificationId: createdA.notification.id }),
    ).rejects.toMatchObject({ code: 'notification_not_found' });
    await expect(
      getNotificationAcknowledgment(ctxB, { notificationId: createdA.notification.id }),
    ).rejects.toMatchObject({ code: 'notification_not_found' });

    // Policies are per-tenant: A's kind-scoped policy is invisible in B.
    await setNotificationPolicy(notificationAdminA, {
      notificationKind: 'w044.iso.kind',
      deliveryClass: 'digest',
      maxAttempts: 3,
      retryBackoffSeconds: 60,
      dedupeWindowSeconds: 600,
      digestWindowSeconds: 3600,
      requireAcknowledgment: false,
    });
    await expectUniformNotFound(
      'policy_not_found',
      () => getNotificationPolicy(ctxB, { notificationKind: 'w044.iso.kind' }),
      () => getNotificationPolicy(ctxB, { notificationKind: 'never.registered' }),
    );

    // Pumps only ever touch the calling tenant's rows.
    const retryB = await retryDueNotifications(ctxB, {});
    expect(retryB.processed).toBe(0);
    const digestB = await flushDueDigests(ctxB, {});
    expect(digestB.groups).toBe(0);
    const escalationB = await escalateUnacknowledged(ctxB, {});
    expect(escalationB.escalatedCandidates).toBe(0);

    // A's acknowledgment is intact and visible only in A.
    const ackA = await getNotificationAcknowledgment(ctxA, { notificationId: createdA.notification.id });
    expect(ackA?.note).toBe('on it');
    expect((await listNotifications(ctxB, {})).map((notification) => notification.id)).not.toContain(
      createdA.notification.id,
    );
    // The omnipotent principal of B is blind too.
    await expect(
      getNotification(omnipotent(tenantB), { notificationId: createdA.notification.id }),
    ).rejects.toMatchObject({ code: 'notification_not_found' });
  });
});

// ---------------------------------------------------------------------------
// llm (W034)
// ---------------------------------------------------------------------------

/** Deterministic fake LLM transport (openai-native dialect, no network). */
class FakeLlmTransport implements LlmTransport {
  readonly requests: LlmTransportRequest[] = [];
  async send(request: LlmTransportRequest): Promise<LlmTransportReceipt> {
    this.requests.push(request);
    return {
      status: 'delivered',
      payload: {
        id: 'chatcmpl-fake-000001',
        choices: [{ message: { role: 'assistant', content: 'The canonical answer.' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
      providerExecutionId: 'fake-000001',
      detail: null,
    };
  }
}

describe('W044 llm — accounts, executions and availability are tenant-scoped', () => {
  const llmAdminA = memberWith(tenantA, ['llm:administer']);
  const llmAdminB = memberWith(tenantB, ['llm:administer']);

  function accountInput() {
    return {
      provider: 'openai' as const,
      label: 'ops',
      credentialRef: 'secret-store://openai/ops',
      scopes: ['cognition', 'conversation', 'analysis', 'background'] as LlmScope[],
      capabilities: ['text-generation', 'embedding'] as LlmCapability[],
      maxDataClassification: 'restricted' as const,
      priority: 0,
    };
  }

  it('gives the same provider label independent accounts per tenant', async () => {
    const { account: accountA } = await registerAiProviderAccount(llmAdminA, accountInput());
    const { account: accountB } = await registerAiProviderAccount(llmAdminB, accountInput());
    expect(accountA.id).not.toBe(accountB.id);
    expect((await listAiProviderAccounts(ctxB, {})).map((account) => account.id)).not.toContain(
      accountA.id,
    );
  });

  it('fails cross-tenant account reads and writes uniformly', async () => {
    const { account: accountA } = await registerAiProviderAccount(llmAdminA, accountInput());

    await expectUniformNotFound(
      'account_not_found',
      () => getAiProviderAccount(ctxB, { accountId: accountA.id }),
      () => getAiProviderAccount(ctxB, { accountId: newId() }),
    );
    await expectUniformNotFound(
      'account_not_found',
      () => getAiProviderAccountSpend(ctxB, { accountId: accountA.id }),
      () => getAiProviderAccountSpend(ctxB, { accountId: newId() }),
    );
    await expect(
      updateAiProviderAccount(llmAdminB, { accountId: accountA.id, status: 'disabled' }),
    ).rejects.toMatchObject({ code: 'account_not_found' });
    await expect(
      setAiAvailability(llmAdminB, { accountId: accountA.id, model: 'gpt-4o', state: 'unavailable' }),
    ).rejects.toMatchObject({ code: 'account_not_found' });
    expect((await getAiProviderAccount(ctxA, { accountId: accountA.id })).status).toBe('active');
  });

  it('isolates executions, routing pins and the provider transport per tenant', async () => {
    const transport = new FakeLlmTransport();
    setLlmTransport(transport);

    const { account: accountA } = await registerAiProviderAccount(llmAdminA, accountInput());
    const { account: accountB } = await registerAiProviderAccount(llmAdminB, accountInput());

    const chatRequest = {
      capability: 'text-generation' as const,
      scope: 'cognition' as const,
      dataClassification: 'internal' as const,
      messages: [
        { role: 'system' as const, content: 'Answer in one word.' },
        { role: 'user' as const, content: 'Is the gateway provider-neutral?' },
      ],
    };
    const executionA = await invokeLlm(ctxA, chatRequest);
    expect(executionA.status).toBe('completed');
    const executionB = await invokeLlm(ctxB, chatRequest);
    expect(executionB.accountId).toBe(accountB.id); // routed to B's own account

    const requestsBefore = transport.requests.length;
    await expectUniformNotFound(
      'execution_not_found',
      () => getLlmExecution(ctxB, { executionId: executionA.id }),
      () => getLlmExecution(ctxB, { executionId: newId() }),
    );
    // Pinning to a foreign account is a uniform account_not_found.
    await expect(
      invokeLlm(ctxB, { ...chatRequest, pinnedAccountId: accountA.id }),
    ).rejects.toMatchObject({ code: 'account_not_found' });
    expect((await listLlmExecutions(ctxB, {})).map((execution) => execution.id)).not.toContain(
      executionA.id,
    );
    expect(transport.requests.length).toBe(requestsBefore); // no provider dispatch happened
    // The omnipotent principal of B is blind too.
    await expect(
      getLlmExecution(omnipotent(tenantB), { executionId: executionA.id }),
    ).rejects.toMatchObject({ code: 'execution_not_found' });
    expect((await getLlmExecution(ctxA, { executionId: executionA.id })).accountId).toBe(accountA.id);
  });
});

// ---------------------------------------------------------------------------
// sources (W036)
// ---------------------------------------------------------------------------

/** Deterministic fake source transport (scripted records, no network). */
class ScriptedSourceTransport implements SourceTransport {
  readonly requests: unknown[] = [];
  private scripted: SourceFetchResult[] = [];
  script(result: SourceFetchResult): void {
    this.scripted.push(result);
  }
  async fetch(): Promise<SourceFetchResult> {
    const next = this.scripted.shift();
    if (next === undefined) return { records: [], nextCursor: null, hasMore: false };
    return next;
  }
}

describe('W044 sources — connections, checkpoints and ingestion are tenant-scoped', () => {
  function sourceInput() {
    return {
      provider: 'salesforce' as const,
      providerAccountId: '00Dxx0000000001',
      displayName: 'Acme CRM',
      authKind: 'oauth' as const,
      credentialRef: 'secret-store://salesforce/acme',
      oauthScopes: ['crm.read'],
      oauthExpiresAt: '2027-01-01T00:00:00Z',
    };
  }

  it('gives the same provider account independent sources per tenant', async () => {
    const { source: sourceA } = await registerSource(ctxA, sourceInput());
    const { source: sourceB } = await registerSource(ctxB, sourceInput());
    expect(sourceA.id).not.toBe(sourceB.id);
    expect((await listSources(ctxB, {})).map((source) => source.id)).not.toContain(sourceA.id);
  });

  it('fails cross-tenant reads, status changes and replays uniformly', async () => {
    const { source: sourceA } = await registerSource(ctxA, sourceInput());

    await expectUniformNotFound(
      'source_not_found',
      () => getSource(ctxB, sourceA.id),
      () => getSource(ctxB, newId()),
    );
    await expect(
      setSourceStatus(ctxB, { sourceId: sourceA.id, status: 'disabled' }),
    ).rejects.toMatchObject({ code: 'source_not_found' });
    await expect(
      getSourceCheckpoint(ctxB, { sourceId: sourceA.id }),
    ).rejects.toMatchObject({ code: 'source_not_found' });
    await expect(
      listSourceCheckpoints(ctxB, { sourceId: sourceA.id }),
    ).rejects.toMatchObject({ code: 'source_not_found' });
    await expect(
      replaySource(ctxB, { sourceId: sourceA.id, fromStart: true }),
    ).rejects.toMatchObject({ code: 'source_not_found' });
    expect((await getSource(ctxA, sourceA.id)).status).toBe('active');
  });

  it('never reaches the shared transport for a foreign poll, and keeps ingested evidence per-tenant', async () => {
    const transport = new ScriptedSourceTransport();
    setSourceTransport(transport);

    const { source: sourceA } = await registerSource(ctxA, sourceInput());
    await registerSource(ctxB, sourceInput());

    const record = (id: string): CanonicalSourceRecord => ({
      providerRecordId: id,
      kind: 'crm.opportunity.updated',
      payload: { recordId: id, alphaSecret: 'w044-alpha' },
      occurredAt: '2026-09-14T10:15:00Z',
    });
    transport.script({ records: [record('sf-alpha-1')], nextCursor: 'cursor-alpha', hasMore: false });

    const pollA = await pollSource(ctxA, { sourceId: sourceA.id });
    expect(pollA.ingested).toBe(1);

    // B polling A's source id fails BEFORE any transport dispatch.
    const requestsBefore = transport.requests.length;
    await expect(pollSource(ctxB, { sourceId: sourceA.id })).rejects.toMatchObject({
      code: 'source_not_found',
    });
    expect(transport.requests.length).toBe(requestsBefore);

    // The observation A ingested is invisible to B.
    expect(await listObservations(ctxB, { sourceKind: 'source', sourceId: sourceA.id })).toEqual([]);
    const observationsA = await listObservations(ctxA, { sourceKind: 'source', sourceId: sourceA.id });
    expect(observationsA).toHaveLength(1);
  });

  it('resolves webhook envelopes only onto the calling tenant sources', async () => {
    const { source: sourceA } = await registerSource(ctxA, sourceInput());
    const envelope = {
      organizationId: '00Dxx0000000001',
      events: [
        {
          id: 'evt-w044-1',
          changeType: 'UPDATE',
          entity: 'Opportunity',
          occurredAt: '2026-09-14T10:15:00Z',
          record: { recordId: 'sf-webhook-1' },
        },
      ],
    };

    // A resolves its own envelope.
    const resultA = await receiveSourceWebhook(ctxA, { provider: 'salesforce', payload: envelope });
    expect(resultA.ingested).toBe(1);

    // Tenant C (no sources at all) cannot resolve the same envelope.
    await expect(
      receiveSourceWebhook(ctxC, { provider: 'salesforce', payload: envelope }),
    ).rejects.toMatchObject({ code: 'source_not_found' });
    // The omnipotent principal of C is equally blind.
    await expect(
      receiveSourceWebhook(omnipotent(tenantC), { provider: 'salesforce', payload: envelope }),
    ).rejects.toMatchObject({ code: 'source_not_found' });
    expect(await listObservations(ctxC, {})).toEqual([]);
    expect((await getSource(ctxA, sourceA.id)).status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// briefings (W032)
// ---------------------------------------------------------------------------

describe('W044 briefings — policies, generations and handoffs are tenant-scoped', () => {
  const briefingsAdminA = memberWith(tenantA, ['briefings:administer']);
  const briefingsAdminB = memberWith(tenantB, ['briefings:administer']);

  it('gives the same policy keys and idempotency keys independent rows per tenant', async () => {
    // The natural keys — (tenant, section kind) on policies, (tenant,
    // idempotency key) on briefings — coexist per tenant: B's same-key
    // write lands in B only and never moves A's rows.
    const policyA = await setBriefingPolicy(briefingsAdminA, {
      sectionKind: 'unknowns',
      maxItems: 5,
      windowSeconds: 600,
      note: 'alpha tight unknowns',
    });
    const policyB = await setBriefingPolicy(briefingsAdminB, {
      sectionKind: 'unknowns',
      maxItems: 20,
      windowSeconds: 86_400,
      note: 'beta wide unknowns',
    });
    expect(policyA.id).not.toBe(policyB.id);
    expect((await getBriefingPolicy(ctxA, { sectionKind: 'unknowns' })).maxItems).toBe(5);
    expect((await getBriefingPolicy(ctxB, { sectionKind: 'unknowns' })).maxItems).toBe(20);

    // The tenant-wide DEFAULT row is an independent key per tenant too.
    await setBriefingPolicy(briefingsAdminA, { sectionKind: null, maxItems: 12, note: 'alpha default' });
    await setBriefingPolicy(briefingsAdminB, { sectionKind: null, maxItems: 24, note: 'beta default' });
    expect((await getBriefingPolicy(ctxA, { sectionKind: null })).note).toBe('alpha default');
    expect((await getBriefingPolicy(ctxB, { sectionKind: null })).note).toBe('beta default');

    // The same generation key yields two independent briefings...
    const generatedA = await generateBriefing(ctxA, { idempotencyKey: 'w044-briefing-key' });
    const generatedB = await generateBriefing(ctxB, { idempotencyKey: 'w044-briefing-key' });
    expect(generatedA.briefing.id).not.toBe(generatedB.briefing.id);
    expect(generatedA.deduped).toBe(false);
    expect(generatedB.deduped).toBe(false);
    // ...and replays dedupe only inside the tenant that recorded the key.
    const replayA = await generateBriefing(ctxA, { idempotencyKey: 'w044-briefing-key' });
    expect(replayA.deduped).toBe(true);
    expect(replayA.briefing.id).toBe(generatedA.briefing.id);
  });

  it('fails cross-tenant reads uniformly and keeps listings disjoint', async () => {
    const generatedA = await generateBriefing(ctxA, { idempotencyKey: 'w044-briefing-read' });
    // A kind-keyed policy row only A owns is indistinguishable from a
    // kind B never configured.
    const driftA = await setBriefingPolicy(briefingsAdminA, {
      sectionKind: 'goal-drift',
      maxItems: 7,
      note: 'alpha drift',
    });
    await expectUniformNotFound(
      'policy_not_found',
      () => getBriefingPolicy(ctxB, { sectionKind: 'goal-drift' }),
      () => getBriefingPolicy(ctxB, { sectionKind: 'capability-gaps' }),
    );
    await expectUniformNotFound(
      'briefing_not_found',
      () => getBriefing(ctxB, { briefingId: generatedA.briefing.id }),
      () => getBriefing(ctxB, { briefingId: newId() }),
    );

    // The omnipotent principal of B — every repository claim plus the
    // briefings module's own 'briefings:administer' — is still blind:
    // authority authorizes policy writes, never tenant scope.
    const blind = memberWith(tenantB, [...OMNIPOTENT_AUTHORITY, 'briefings:administer']);
    await expect(getBriefing(blind, { briefingId: generatedA.briefing.id })).rejects.toMatchObject({
      code: 'briefing_not_found',
    });
    await expect(getBriefingPolicy(blind, { sectionKind: 'goal-drift' })).rejects.toMatchObject({
      code: 'policy_not_found',
    });

    // Policy resolution reads the calling tenant's own rows only.
    const resolvedA = await resolveBriefingPolicy(ctxA, { sectionKind: 'unknowns' });
    const resolvedB = await resolveBriefingPolicy(ctxB, { sectionKind: 'unknowns' });
    expect(resolvedA.maxItems).toBe(5); // A's kind row from the namespace probe
    expect(resolvedB.maxItems).toBe(20); // B's own kind row, never A's
    expect(resolvedB.policy?.id).not.toBe(resolvedA.policy?.id);

    // Listings stay per-tenant.
    expect((await listBriefings(ctxB, {})).map((briefing) => briefing.id)).not.toContain(
      generatedA.briefing.id,
    );
    expect((await listBriefingPolicies(ctxB, {})).map((policy) => policy.id)).not.toContain(driftA.id);
    expect((await listBriefingPolicies(ctxA, {})).map((policy) => policy.id)).toContain(driftA.id);
  });

  it('compiles sections only from the calling tenant evidence and hands delivery off in-tenant', async () => {
    // Both tenants carry the SAME open unknown; each compiled briefing
    // deep-links only its own tenant's record.
    const unknownInput = {
      question: 'which supplier causes the delivery delays?',
      consequence: 'without it we cannot fix the delivery slips',
    };
    const unknownA = await recordUnknown(ctxA, unknownInput);
    const unknownB = await recordUnknown(ctxB, unknownInput);

    const briefingA = (await generateBriefing(ctxA, { idempotencyKey: 'w044-sections-a' })).briefing;
    const briefingB = (await generateBriefing(ctxB, { idempotencyKey: 'w044-sections-b' })).briefing;
    const unknownsA = briefingA.sections.find((section) => section.sectionKind === 'unknowns')!;
    const unknownsB = briefingB.sections.find((section) => section.sectionKind === 'unknowns')!;
    expect(unknownsA.items).toHaveLength(1);
    expect(unknownsB.items).toHaveLength(1);
    const detailA = unknownsA.items[0]!.detail;
    const detailB = unknownsB.items[0]!.detail;
    expect(detailA.section).toBe('unknowns');
    expect(detailB.section).toBe('unknowns');
    if (detailA.section === 'unknowns') {
      expect(detailA.unknownId).toBe(unknownA.id);
    }
    if (detailB.section === 'unknowns') {
      expect(detailB.unknownId).toBe(unknownB.id);
    }
    expect(JSON.stringify(briefingB)).not.toContain(unknownA.id);
    expect(JSON.stringify(briefingA)).not.toContain(unknownB.id);

    // The delivery handoff (W031) is per tenant: both tenants pin the
    // SAME recipient on their default policy and register their own
    // email connection; each generated briefing pushes exactly one
    // notification of its own.
    setChannelTransport(new RecordingChannelTransport());
    await registerChannelConnection(ctxA, {
      provider: 'email',
      providerAccountId: 'brief@alpha.example',
      credentialRef: 'secret-store://email/alpha-brief',
    });
    await registerChannelConnection(ctxB, {
      provider: 'email',
      providerAccountId: 'brief@beta.example',
      credentialRef: 'secret-store://email/beta-brief',
    });
    const recipient = { provider: 'email' as const, providerAccountId: 'manager@corp.example' };
    await setBriefingPolicy(briefingsAdminA, { sectionKind: null, deliveryRecipient: recipient });
    await setBriefingPolicy(briefingsAdminB, { sectionKind: null, deliveryRecipient: recipient });

    const deliveredA = await generateBriefing(ctxA, { idempotencyKey: 'w044-handoff-a' });
    const deliveredB = await generateBriefing(ctxB, { idempotencyKey: 'w044-handoff-b' });
    expect(deliveredA.deliveredNotificationId).not.toBeNull();
    expect(deliveredB.deliveredNotificationId).not.toBeNull();
    expect(deliveredA.deliveredNotificationId).not.toBe(deliveredB.deliveredNotificationId);

    // A's briefing-delivery notification is invisible to B (the
    // notifications module's own uniform discipline) and absent from B's
    // feed; B's own handoff notification is present in B.
    const notificationA = deliveredA.deliveredNotificationId!;
    await expectUniformNotFound(
      'notification_not_found',
      () => getNotification(ctxB, { notificationId: notificationA }),
      () => getNotification(ctxB, { notificationId: newId() }),
    );
    expect((await listNotifications(ctxB, {})).map((notification) => notification.id)).not.toContain(
      notificationA,
    );
    const own = await getNotification(ctxB, { notificationId: deliveredB.deliveredNotificationId! });
    expect(own.notificationKind).toBe(BRIEFING_NOTIFICATION_KIND);
    expect(own.recipient.providerAccountId).toBe('manager@corp.example');
    // The briefing carries the one-way delivery link in A only.
    expect(
      (await getBriefing(ctxA, { briefingId: deliveredA.briefing.id })).deliveryNotificationId,
    ).toBe(notificationA);
  });

  it('stores every generated row under the generating tenant only', async () => {
    // Briefings are append-only history with no id-addressed mutation
    // surface; the strongest write probe is generative: B generating with
    // A's EXACT idempotency key creates B's own row — never a replay of
    // A's — and A's feed never moves.
    const writtenA = await generateBriefing(ctxA, { idempotencyKey: 'w044-storage-key' });
    const feedA = (await listBriefings(ctxA, {})).map((briefing) => briefing.id);
    const writtenB = await generateBriefing(ctxB, { idempotencyKey: 'w044-storage-key' });
    expect((await listBriefings(ctxA, {})).map((briefing) => briefing.id)).toEqual(feedA);
    expect(writtenB.briefing.id).not.toBe(writtenA.briefing.id);

    // Raw-row verification (reads only): every row B wrote is stored
    // under B, and A's counterpart rows under A.
    expect(await storedTenantId('briefings', writtenA.briefing.id)).toBe(tenantA);
    expect(await storedTenantId('briefings', writtenB.briefing.id)).toBe(tenantB);
    expect(await storedTenantId('briefing_sections', writtenB.briefing.sections[0]!.id)).toBe(tenantB);
    const policyRowA = await setBriefingPolicy(briefingsAdminA, { sectionKind: 'risks', maxItems: 3 });
    const policyRowB = await setBriefingPolicy(briefingsAdminB, { sectionKind: 'risks', maxItems: 9 });
    expect(await storedTenantId('briefing_policies', policyRowA.id)).toBe(tenantA);
    expect(await storedTenantId('briefing_policies', policyRowB.id)).toBe(tenantB);
  });
});

// ---------------------------------------------------------------------------
// destinations (W037)
// ---------------------------------------------------------------------------

/** Deterministic fake destination transport (no provider SDK, no network). */
class RecordingDestinationTransport implements DestinationTransport {
  readonly requests: DestinationDeliveryRequest[] = [];
  private counter = 0;
  async deliver(request: DestinationDeliveryRequest): Promise<DestinationReceipt> {
    this.requests.push(request);
    this.counter += 1;
    return {
      status: 'delivered',
      providerDeliveryId: `ack-${String(this.counter).padStart(6, '0')}`,
      detail: null,
    };
  }
}

describe('W044 destinations — connectors, deliveries and audits are tenant-scoped', () => {
  const approverA = memberWith(tenantA, ['actions:approve']);
  const approverB = memberWith(tenantB, ['actions:approve']);

  function destinationInput(account: string) {
    return {
      provider: 'webhook' as const,
      providerAccountId: `https://hooks.acme.com/aurum/${account}`,
      displayName: 'Acme BI webhook',
      authKind: 'credentials' as const,
      credentialRef: 'secret-store://webhook/acme',
    };
  }

  function batch(recordId: string) {
    return [{ recordId, data: { name: 'Expand to EU', value: 42_000 } }];
  }

  it('gives the same provider account independent connectors per tenant', async () => {
    const first = await registerDestination(ctxA, destinationInput('w044'));
    const second = await registerDestination(ctxB, destinationInput('w044'));
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(first.destination.id).not.toBe(second.destination.id);

    // The re-authorization path is per tenant: re-registering the SAME
    // account in B moves B's authorization fields and reports
    // created: false — A's connector keeps its own credential.
    const reauthorized = await registerDestination(ctxB, {
      ...destinationInput('w044'),
      credentialRef: 'secret-store://webhook/acme-beta-2',
    });
    expect(reauthorized.created).toBe(false);
    expect(reauthorized.destination.id).toBe(second.destination.id);
    expect(reauthorized.destination.credentialRef).toBe('secret-store://webhook/acme-beta-2');
    expect((await getDestination(ctxA, first.destination.id)).credentialRef).toBe(
      'secret-store://webhook/acme',
    );

    expect((await listDestinations(ctxB, {})).map((destination) => destination.id)).not.toContain(
      first.destination.id,
    );
  });

  it('fails cross-tenant reads of connectors, deliveries and attempts uniformly', async () => {
    const { destination: destinationA } = await registerDestination(ctxA, destinationInput('read'));
    const { delivery: deliveryA } = await dispatchDelivery(ctxA, {
      destinationId: destinationA.id,
      kind: 'w044.export.read',
      records: batch('opp-read-a'),
    });
    // The built-in default matrix gates EXECUTE behind a human approval —
    // the delivery sits pending with nothing dispatched yet.
    expect(deliveryA.status).toBe('pending');

    await expectUniformNotFound(
      'destination_not_found',
      () => getDestination(ctxB, destinationA.id),
      () => getDestination(ctxB, newId()),
    );
    await expectUniformNotFound(
      'delivery_not_found',
      () => getDelivery(ctxB, { deliveryId: deliveryA.id }),
      () => getDelivery(ctxB, { deliveryId: newId() }),
    );
    await expect(
      listDeliveryAttempts(ctxB, { deliveryId: deliveryA.id }),
    ).rejects.toMatchObject({ code: 'delivery_not_found' });

    // The omnipotent principal of B is equally blind: the destinations
    // module consults no authority claims of its own (its gate is the
    // policy-driven actions matrix, claims-blind by design).
    await expect(getDestination(omnipotent(tenantB), destinationA.id)).rejects.toMatchObject({
      code: 'destination_not_found',
    });
    await expect(
      getDelivery(omnipotent(tenantB), { deliveryId: deliveryA.id }),
    ).rejects.toMatchObject({ code: 'delivery_not_found' });

    // Listings stay per-tenant (a foreign destinationId filter in B's
    // ledger is just empty, never an error, never a leak).
    expect((await listDestinations(ctxB, {})).map((destination) => destination.id)).not.toContain(
      destinationA.id,
    );
    expect((await listDeliveries(ctxB, {})).map((delivery) => delivery.id)).not.toContain(
      deliveryA.id,
    );
    expect(await listDeliveries(ctxB, { destinationId: destinationA.id })).toEqual([]);
  });

  it('rejects cross-tenant writes with the foreign records untouched', async () => {
    const transport = new RecordingDestinationTransport();
    setDestinationTransport(transport);

    const { destination: destinationA } = await registerDestination(ctxA, destinationInput('guard'));
    const { delivery: deliveryA } = await dispatchDelivery(ctxA, {
      destinationId: destinationA.id,
      kind: 'w044.export.guard',
      records: batch('opp-guard-a'),
    });
    const ledgerB = (await listDeliveries(ctxB, {})).map((delivery) => delivery.id);
    const ledgerA = (await listDeliveries(ctxA, {})).map((delivery) => delivery.id);

    // B cannot disable A's connector...
    await expect(
      setDestinationStatus(ctxB, { destinationId: destinationA.id, status: 'disabled' }),
    ).rejects.toMatchObject({ code: 'destination_not_found' });
    expect((await getDestination(ctxA, destinationA.id)).status).toBe('active');

    // ...nor dispatch through it — the failure happens BEFORE any
    // transport call and leaves no delivery row anywhere.
    const requestsBefore = transport.requests.length;
    await expect(
      dispatchDelivery(ctxB, {
        destinationId: destinationA.id,
        kind: 'w044.export.pwned',
        records: batch('opp-pwned'),
      }),
    ).rejects.toMatchObject({ code: 'destination_not_found' });
    expect(transport.requests.length).toBe(requestsBefore); // nothing left the system
    expect((await listDeliveries(ctxB, {})).map((delivery) => delivery.id)).toEqual(ledgerB);

    // Even the fully-claimed principal of B cannot dispatch over A's
    // connector (authority authorizes operations, never tenant scope).
    await expect(
      dispatchDelivery(omnipotent(tenantB), {
        destinationId: destinationA.id,
        kind: 'w044.export.pwned',
        records: batch('opp-pwned-2'),
      }),
    ).rejects.toMatchObject({ code: 'destination_not_found' });

    // B can neither pump nor replay A's pending delivery.
    await expect(retryDelivery(ctxB, { deliveryId: deliveryA.id })).rejects.toMatchObject({
      code: 'delivery_not_found',
    });
    await expect(replayDelivery(ctxB, { deliveryId: deliveryA.id })).rejects.toMatchObject({
      code: 'delivery_not_found',
    });
    expect((await listDeliveries(ctxB, {})).map((delivery) => delivery.id)).toEqual(ledgerB);
    // A's delivery is untouched by every B probe.
    expect((await getDelivery(ctxA, { deliveryId: deliveryA.id })).status).toBe('pending');
    expect((await listDeliveries(ctxA, {})).map((delivery) => delivery.id)).toEqual(ledgerA);
  });

  it('authorizes provenance evidence per tenant', async () => {
    const { destination: destinationA } = await registerDestination(ctxA, destinationInput('evidence'));
    const { destination: destinationB } = await registerDestination(ctxB, destinationInput('evidence'));
    const ledgerA = (await listDeliveries(ctxA, {})).map((delivery) => delivery.id);
    const ledgerB = (await listDeliveries(ctxB, {})).map((delivery) => delivery.id);

    const observationInput = (name: string, usage: string[]) => ({
      kind: 'findings.opportunity',
      payload: { name },
      observedAt: '2026-09-14T09:30:00Z',
      source: { kind: 'source' as const, label: 'w044-harness' },
      channel: 'ingestion',
      permissions: { visibility: 'tenant' as const, usage },
      confidence: { value: 0.8, method: 'source_trust' },
    });
    const observationA = await recordObservation(ctxA, observationInput('Expand to EU', []));
    const classifiedA = await recordObservation(ctxA, observationInput('Classified', ['no-export']));

    // B citing A's observation as provenance is indistinguishable from
    // citing a missing one — the evidence layer never leaks existence.
    const stolenExport = (provenanceObservationIds: string[]) =>
      dispatchDelivery(ctxB, {
        destinationId: destinationB.id,
        kind: 'w044.export.stolen',
        records: batch('opp-stolen'),
        provenanceObservationIds,
      });
    await expectUniformNotFound(
      'evidence_not_found',
      () => stolenExport([observationA.id]),
      () => stolenExport([newId()]),
    );

    // A no-export-tagged observation can never leave through a
    // destination — and the rejection burns no delivery row.
    await expect(
      dispatchDelivery(ctxA, {
        destinationId: destinationA.id,
        kind: 'w044.export.classified',
        records: batch('opp-classified'),
        provenanceObservationIds: [classifiedA.id],
      }),
    ).rejects.toMatchObject({ code: 'evidence_export_forbidden' });
    expect((await listDeliveries(ctxA, {})).map((delivery) => delivery.id)).toEqual(ledgerA);
    expect((await listDeliveries(ctxB, {})).map((delivery) => delivery.id)).toEqual(ledgerB);
  });

  it('keeps delivery keys and the authority gate per tenant', async () => {
    const transport = new RecordingDestinationTransport();
    setDestinationTransport(transport);

    const { destination: destinationA } = await registerDestination(ctxA, destinationInput('keyed'));
    const { destination: destinationB } = await registerDestination(ctxB, destinationInput('keyed'));

    // The same caller key yields independent deliveries per tenant, and
    // replays dedupe only inside the tenant that recorded the key.
    const exportA = await dispatchDelivery(ctxA, {
      destinationId: destinationA.id,
      kind: 'w044.export.keyed',
      records: batch('opp-keyed-a'),
      idempotencyKey: 'w044-export-key',
    });
    const exportB = await dispatchDelivery(ctxB, {
      destinationId: destinationB.id,
      kind: 'w044.export.keyed',
      records: batch('opp-keyed-b'),
      idempotencyKey: 'w044-export-key',
    });
    expect(exportA.delivery.id).not.toBe(exportB.delivery.id);
    const replayA = await dispatchDelivery(ctxA, {
      destinationId: destinationA.id,
      kind: 'w044.export.keyed',
      records: batch('opp-keyed-a'),
      idempotencyKey: 'w044-export-key',
    });
    expect(replayA.created).toBe(false);
    expect(replayA.delivery.id).toBe(exportA.delivery.id);

    // The authority gate holds each export for a human approval; nothing
    // reaches the shared transport while it waits.
    expect(exportA.delivery.status).toBe('pending');
    expect(exportB.delivery.status).toBe('pending');
    expect(transport.requests).toHaveLength(0);

    // A's human approves the gate; A's pump completes the delivery.
    await decideApproval(approverA, {
      requestId: exportA.delivery.actionRequestId!,
      decision: 'approve',
    });
    const pumpedA = await retryDelivery(ctxA, { deliveryId: exportA.delivery.id });
    expect(pumpedA.delivery.status).toBe('delivered');
    expect(pumpedA.attempt?.outcome).toBe('delivered');
    expect(transport.requests).toHaveLength(1);
    // The one request that left the system was A's own connector.
    expect(transport.requests[0]!.tenantId).toBe(tenantA);
    expect(transport.requests[0]!.destinationId).toBe(destinationA.id);
    // The physical audit is readable only in A.
    expect(await listDeliveryAttempts(ctxA, { deliveryId: exportA.delivery.id })).toHaveLength(1);

    // B's own gated lifecycle completes independently through the SAME
    // shared transport — each tenant dispatches only its own connector.
    await decideApproval(approverB, {
      requestId: exportB.delivery.actionRequestId!,
      decision: 'approve',
    });
    const pumpedB = await retryDelivery(ctxB, { deliveryId: exportB.delivery.id });
    expect(pumpedB.delivery.status).toBe('delivered');
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[1]!.tenantId).toBe(tenantB);
    expect(transport.requests[1]!.destinationId).toBe(destinationB.id);
  });
});

// ---------------------------------------------------------------------------
// Row-partition integrity over the whole migrated schema
// ---------------------------------------------------------------------------

describe('W044 repository boundary — row partition integrity', () => {
  it('stores every row of every tenant-scoped table under a sweep tenant only', async () => {
    await assertTenantPartition([tenantA, tenantB, tenantC]);
  });
});
