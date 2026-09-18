// W044 — Tenant Isolation Verification · application-boundary sweep for the
// experience/platform modules: conversations (W029), channels (W030),
// notifications (W031), llm (W034) and sources (W036).
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
import { listObservations } from '@/modules/observations/contract';
import { assertTenantPartition, expectUniformNotFound, member, memberWith, omnipotent, runMigrations } from './harness';

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
// Row-partition integrity over the whole migrated schema
// ---------------------------------------------------------------------------

describe('W044 repository boundary — row partition integrity', () => {
  it('stores every row of every tenant-scoped table under a sweep tenant only', async () => {
    await assertTenantPartition([tenantA, tenantB, tenantC]);
  });
});
