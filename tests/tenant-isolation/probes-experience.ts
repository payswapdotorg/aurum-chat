// W044 — Tenant Isolation Verification: probes for the human-experience and
// capability modules (conversations, channels, notifications, actions, llm).
//
// Same protocol as probes-foundation.ts: two tenants seeded through public
// contracts only; the runner enforces the uniform read/list/write invariants
// documented in tests/tenant-isolation/harness.ts. Authority-gated write
// probes carry their claims so the not-found discipline — not a claim
// failure — is what gets exercised. Outbound channel/LLM deliveries go
// through the process-wide fake transports installed by
// tests/tenant-isolation.test.ts.

import { expect } from 'vitest';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  createConversation,
  getConversation,
  getMessage,
  listConversations,
  listExecutionLinks,
  listMessages,
  recordExecutionLink,
  recordMessage,
} from '@/modules/conversations/contract';
import { createPerson } from '@/modules/people/contract';
import {
  completeIdentityChallenge,
  deliverIdentityChallenge,
  getChannelConnection,
  listChannelConnections,
  receiveInbound,
  registerChannelConnection,
  sendOutbound,
  setChannelConnectionStatus,
} from '@/modules/channels/contract';
import {
  acknowledgeNotification,
  createNotification,
  getNotification,
  getNotificationAcknowledgment,
  getNotificationPolicy,
  listNotificationAttempts,
  listNotificationPolicies,
  listNotifications,
  NOTIFICATIONS_AUTHORITY_ADMINISTER,
  resolveNotificationPolicy,
  setNotificationPolicy,
} from '@/modules/notifications/contract';
import {
  ACTIONS_AUTHORITY_ADMINISTER,
  ACTIONS_AUTHORITY_APPROVE,
  authorizeAction,
  decideApproval,
  evaluateActionAuthority,
  getActionRequest,
  getAuthorityPolicy,
  listActionRequests,
  listApprovalDecisions,
  listAuthorityPolicies,
  setAuthorityPolicy,
  type AuthorityLevel,
} from '@/modules/actions/contract';
import {
  getAiProviderAccount,
  getAiProviderAccountSpend,
  getAiAvailability,
  getHotSwapVerification,
  getLlmExecution,
  getLlmUsageSummary,
  invokeLlm,
  listAiProviderAccounts,
  listLlmExecutions,
  LLM_AUTHORITY_ADMINISTER,
  registerAiProviderAccount,
  setAiAvailability,
  updateAiProviderAccount,
  verifyProviderHotSwap,
} from '@/modules/llm/contract';
import { member, W044_T0, type ModuleProbe } from './harness';

// ---------------------------------------------------------------------------
// conversations
// ---------------------------------------------------------------------------

const conversationsProbe: ModuleProbe = {
  module: 'conversations',
  setup: async () => {
    const tenantA = newId();
    const tenantB = newId();
    const ctxA = member(tenantA);
    const ctxB = member(tenantB);

    const seed = async (ctx: TenantContext) => {
      const person = await createPerson(member(ctx.tenantId), { fullName: 'W044 Speaker' });
      const conversation = await createConversation(ctx, { title: 'W044 Thread' });
      const message = await recordMessage(ctx, {
        conversationId: conversation.id,
        direction: 'inbound',
        actor: { kind: 'external', label: 'W044 Customer' },
        channel: 'whatsapp',
        payload: { text: 'w044 inbound' },
        sentAt: W044_T0,
        providerMessageId: 'w044-msg-1',
      });
      const executionId = newId();
      const link = await recordExecutionLink(ctx, {
        messageId: message.id,
        executionId,
        role: 'triggered',
      });
      return { person, conversation, message, link };
    };

    const a = await seed(ctxA);
    const b = await seed(ctxB); // same provider message id, other tenant

    const ids = {
      conversation: a.conversation.id,
      message: a.message.id,
      person: a.person.id,
      link: a.link.id,
    };
    const idsB = {
      conversation: b.conversation.id,
      message: b.message.id,
      person: b.person.id,
      link: b.link.id,
    };
    const idKeys = ['conversation', 'message', 'person', 'link'];

    return {
      module: 'conversations',
      ctxA,
      ctxB,
      ids,
      idsB,
      idKeys,
      contextProbe: (ctx) => getConversation(ctx, ids.conversation!),
      reads: [
        {
          name: 'getConversation',
          code: 'conversation_not_found',
          run: (ctx, probeIds) => getConversation(ctx, probeIds.conversation!),
        },
        {
          name: 'getMessage',
          code: 'message_not_found',
          run: (ctx, probeIds) => getMessage(ctx, probeIds.message!),
        },
      ],
      lists: [
        { name: 'listConversations', run: (ctx) => listConversations(ctx, {}) },
        {
          name: 'listMessages of another tenant\'s thread',
          run: (ctx, probeIds) => listMessages(ctx, { conversationId: probeIds.conversation! }),
        },
        {
          name: 'listExecutionLinks of another tenant\'s thread',
          run: (ctx, probeIds) => listExecutionLinks(ctx, { conversationId: probeIds.conversation! }),
        },
      ],
      writes: [
        {
          name: 'recordMessage into another tenant\'s thread',
          code: 'conversation_not_found',
          run: (ctx, probeIds) =>
            recordMessage(ctx, {
              conversationId: probeIds.conversation!,
              direction: 'inbound',
              actor: { kind: 'external', label: 'W044 Impostor' },
              channel: 'whatsapp',
              payload: { text: 'w044 hijack' },
              sentAt: W044_T0,
            }),
        },
        {
          name: 'recordMessage attributing another tenant\'s person',
          code: 'invalid_provenance',
          run: (ctx, probeIds) =>
            recordMessage(ctx, {
              direction: 'inbound',
              actor: { kind: 'person', personId: probeIds.person! },
              channel: 'whatsapp',
              payload: { text: 'w044 hijack' },
              sentAt: W044_T0,
            }),
        },
        {
          name: 'recordExecutionLink onto another tenant\'s message',
          code: 'message_not_found',
          run: (ctx, probeIds) =>
            recordExecutionLink(ctx, {
              messageId: probeIds.message!,
              executionId: newId(),
              role: 'triggered',
            }),
        },
        {
          name: 'recordExecutionLink onto another tenant\'s thread',
          code: 'conversation_not_found',
          run: (ctx, probeIds) =>
            recordExecutionLink(ctx, {
              conversationId: probeIds.conversation!,
              executionId: newId(),
              role: 'triggered',
            }),
        },
      ],
      checks: [
        {
          name: 'the same provider message id records independently in both tenants',
          run: async () => {
            expect(a.message.id).not.toBe(b.message.id);
            expect((await getMessage(ctxA, a.message.id)).id).toBe(a.message.id);
            expect((await getMessage(ctxB, b.message.id)).id).toBe(b.message.id);
          },
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// channels
// ---------------------------------------------------------------------------

/** WhatsApp webhook envelope, provider-native shape (parsed by the adapter). */
function whatsappPayload(from: string, text: string, wamid: string): Record<string, unknown> {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { display_phone_number: '15550100000' },
              contacts: [{ profile: { name: 'W044 Alice' }, wa_id: from.replace('+', '') }],
              messages: [
                {
                  from: from.replace('+', ''),
                  id: wamid,
                  timestamp: '1760426100',
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

const channelsProbe: ModuleProbe = {
  module: 'channels',
  setup: async () => {
    const tenantA = newId();
    const tenantB = newId();
    const ctxA = member(tenantA);
    const ctxB = member(tenantB);

    const seed = async (ctx: TenantContext) => {
      const { connection } = await registerChannelConnection(ctx, {
        provider: 'whatsapp',
        providerAccountId: ' 1555 010 0000',
        displayName: 'W044 Ops',
        credentialRef: 'secret-store://whatsapp/w044',
      });
      const inbound = await receiveInbound(ctx, {
        provider: 'whatsapp',
        payload: whatsappPayload('+15551234567', 'w044 inbound', 'wamid.w044.1'),
      });
      const sent = await sendOutbound(ctx, {
        provider: 'whatsapp',
        connectionId: connection.id,
        to: { providerAccountId: '+15551234567', displayName: 'W044 Alice' },
        content: { text: 'w044 reply', attachments: [] },
      });
      return { connection, inbound, sent };
    };

    // same connection account and the same webhook message id in BOTH tenants
    const a = await seed(ctxA);
    const b = await seed(ctxB);

    const ids = {
      connection: a.connection.id,
      identity: a.inbound.identity.id,
      conversation: a.inbound.message.conversationId,
      message: a.inbound.message.id,
    };
    const idsB = {
      connection: b.connection.id,
      identity: b.inbound.identity.id,
      conversation: b.inbound.message.conversationId,
      message: b.inbound.message.id,
    };
    const idKeys = ['connection', 'identity', 'conversation', 'message'];

    return {
      module: 'channels',
      ctxA,
      ctxB,
      ids,
      idsB,
      idKeys,
      contextProbe: (ctx) => getChannelConnection(ctx, ids.connection!),
      reads: [
        {
          name: 'getChannelConnection',
          code: 'connection_not_found',
          run: (ctx, probeIds) => getChannelConnection(ctx, probeIds.connection!),
        },
      ],
      lists: [
        { name: 'listChannelConnections', run: (ctx) => listChannelConnections(ctx, {}) },
        {
          name: 'listMessages of the channel-driven transcript (conversations contract)',
          run: (ctx, probeIds) => listMessages(ctx, { conversationId: probeIds.conversation! }),
        },
      ],
      writes: [
        {
          name: 'setChannelConnectionStatus',
          code: 'connection_not_found',
          run: (ctx, probeIds) =>
            setChannelConnectionStatus(ctx, { connectionId: probeIds.connection!, status: 'disabled' }),
        },
        {
          name: 'sendOutbound threading into another tenant\'s conversation',
          code: 'conversation_not_found',
          run: (ctx, probeIds) =>
            sendOutbound(ctx, {
              provider: 'whatsapp',
              conversationId: probeIds.conversation!,
              to: { providerAccountId: '+15551234567', displayName: 'W044 Alice' },
              content: { text: 'w044 hijack', attachments: [] },
            }),
        },
        {
          name: 'deliverIdentityChallenge for another tenant\'s identity',
          code: 'invalid_provenance',
          run: (ctx, probeIds) => deliverIdentityChallenge(ctx, { identityId: probeIds.identity! }),
        },
        {
          name: 'completeIdentityChallenge for another tenant\'s identity',
          code: 'invalid_provenance',
          run: (ctx, probeIds) =>
            completeIdentityChallenge(ctx, { identityId: probeIds.identity!, code: '123456' }),
        },
      ],
      checks: [
        {
          name: 'the same connection account and webhook message id produce distinct per-tenant records',
          run: async () => {
            expect(a.connection.id).not.toBe(b.connection.id);
            expect(a.inbound.identity.id).not.toBe(b.inbound.identity.id);
            expect(a.inbound.message.id).not.toBe(b.inbound.message.id);
            expect((await getChannelConnection(ctxA, a.connection.id)).id).toBe(a.connection.id);
            expect((await getChannelConnection(ctxB, b.connection.id)).id).toBe(b.connection.id);
          },
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// notifications
// ---------------------------------------------------------------------------

const notificationsProbe: ModuleProbe = {
  module: 'notifications',
  setup: async () => {
    const tenantA = newId();
    const tenantB = newId();
    const ctxA = member(tenantA);
    const ctxB = member(tenantB);

    const seed = async (ctx: TenantContext, policyKind: string) => {
      // per-tenant sending connection (same account string in both tenants)
      await registerChannelConnection(ctx, {
        provider: 'slack',
        providerAccountId: 'W044OPS',
        credentialRef: 'secret-store://slack/w044',
      });
      const policyAdmin = member(ctx.tenantId, [NOTIFICATIONS_AUTHORITY_ADMINISTER]);
      const policy = await setNotificationPolicy(policyAdmin, {
        notificationKind: policyKind,
        deliveryClass: 'digest',
        maxAttempts: 5,
        retryBackoffSeconds: 120,
        dedupeWindowSeconds: 600,
        digestWindowSeconds: 900,
        requireAcknowledgment: false,
        note: 'w044',
      });
      // built-in urgent floor → immediate delivery through the fake transport
      const created = await createNotification(ctx, {
        kind: 'w044.urgent',
        recipient: { provider: 'slack', providerAccountId: 'U-W044' },
        subject: 'W044 subject',
        body: 'W044 body',
        correlationId: 'w044-exec',
      });
      return { policy, notification: created.notification };
    };

    // tenant A owns the 'w044.kind' policy row; tenant B sets a different kind
    // so the uniform not-found read against 'w044.kind' stays meaningful.
    const a = await seed(ctxA, 'w044.kind');
    const b = await seed(ctxB, 'w044.kind.b');

    const ids = { notification: a.notification.id, policy: a.policy.id };
    const idsB = { notification: b.notification.id, policy: b.policy.id };
    const idKeys = ['notification', 'policy'];

    return {
      module: 'notifications',
      ctxA,
      ctxB,
      ids,
      idsB,
      idKeys,
      contextProbe: (ctx) => getNotification(ctx, { notificationId: ids.notification! }),
      reads: [
        {
          name: 'getNotification',
          code: 'notification_not_found',
          run: (ctx, probeIds) => getNotification(ctx, { notificationId: probeIds.notification! }),
        },
        {
          name: 'listNotificationAttempts',
          code: 'notification_not_found',
          run: (ctx, probeIds) =>
            listNotificationAttempts(ctx, { notificationId: probeIds.notification! }),
        },
        {
          name: 'getNotificationAcknowledgment',
          code: 'notification_not_found',
          run: (ctx, probeIds) =>
            getNotificationAcknowledgment(ctx, { notificationId: probeIds.notification! }),
        },
        {
          name: 'getNotificationPolicy',
          code: 'policy_not_found',
          run: (ctx) => getNotificationPolicy(ctx, { notificationKind: 'w044.kind' }),
        },
      ],
      lists: [
        { name: 'listNotifications', run: (ctx) => listNotifications(ctx, {}) },
        { name: 'listNotificationPolicies', run: (ctx) => listNotificationPolicies(ctx, {}) },
      ],
      writes: [
        {
          name: 'acknowledgeNotification',
          code: 'notification_not_found',
          run: (ctx, probeIds) =>
            acknowledgeNotification(ctx, { notificationId: probeIds.notification!, note: 'w044' }),
        },
      ],
      checks: [
        {
          name: 'policy resolution never crosses tenants (built-in floor, not the other tenant\'s row)',
          run: async () => {
            const resolvedA = await resolveNotificationPolicy(ctxA, { notificationKind: 'w044.kind' });
            const resolvedB = await resolveNotificationPolicy(ctxB, { notificationKind: 'w044.kind' });
            expect(resolvedA.maxAttempts).toBe(5); // tenant A's own digest row
            expect(resolvedB.maxAttempts).toBe(3); // the built-in urgent floor
          },
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

const actionsProbe: ModuleProbe = {
  module: 'actions',
  setup: async () => {
    const tenantA = newId();
    const tenantB = newId();
    const ctxA = member(tenantA);
    const ctxB = member(tenantB);

    const seed = async (
      ctx: TenantContext,
      forbiddenLevels: AuthorityLevel[],
      approvalLevels: AuthorityLevel[],
      secondPolicy: boolean,
    ) => {
      const admin = member(ctx.tenantId, [ACTIONS_AUTHORITY_ADMINISTER]);
      const policy = await setAuthorityPolicy(admin, {
        actionKind: 'source-access',
        forbiddenLevels,
        approvalLevels,
        note: 'w044',
      });
      let policy2 = policy;
      if (secondPolicy) {
        policy2 = await setAuthorityPolicy(admin, {
          actionKind: 'data-export',
          approvalLevels: ['EXECUTE'],
          note: 'w044',
        });
      }
      const requester = member(ctx.tenantId);
      const request = await authorizeAction(requester, {
        actionKind: 'agent-recruitment',
        authorityLevel: 'EXECUTE',
        payload: { w044: true },
        justification: 'w044',
      });
      const approver = member(ctx.tenantId, [ACTIONS_AUTHORITY_APPROVE]);
      await decideApproval(approver, { requestId: request.id, decision: 'approve', note: 'w044' });
      return { policy, policy2, request };
    };

    // tenant A forbids OBSERVE via its kind row and additionally owns a
    // 'data-export' row tenant B never sets (the not-found read target);
    // tenant B gates OBSERVE instead — the same key, independent values.
    const a = await seed(ctxA, ['OBSERVE'], [], true);
    const b = await seed(ctxB, [], ['OBSERVE'], false);

    const ids = { request: a.request.id, policy: a.policy.id, policy2: a.policy2.id };
    const idsB = { request: b.request.id, policy: b.policy.id, policy2: b.policy.id };
    const idKeys = ['request', 'policy', 'policy2'];
    const approverB = member(tenantB, [ACTIONS_AUTHORITY_APPROVE]);

    return {
      module: 'actions',
      ctxA,
      ctxB,
      ids,
      idsB,
      idKeys,
      contextProbe: (ctx) => getActionRequest(ctx, { requestId: ids.request! }),
      reads: [
        {
          name: 'getActionRequest',
          code: 'action_request_not_found',
          run: (ctx, probeIds) => getActionRequest(ctx, { requestId: probeIds.request! }),
        },
        {
          name: 'listApprovalDecisions',
          code: 'action_request_not_found',
          run: (ctx, probeIds) => listApprovalDecisions(ctx, { requestId: probeIds.request! }),
        },
        {
          name: 'getAuthorityPolicy',
          code: 'policy_not_found',
          run: (ctx) => getAuthorityPolicy(ctx, { actionKind: 'data-export' }),
        },
      ],
      lists: [
        { name: 'listActionRequests', run: (ctx) => listActionRequests(ctx, {}) },
        { name: 'listAuthorityPolicies', run: (ctx) => listAuthorityPolicies(ctx, {}) },
      ],
      writes: [
        {
          name: 'decideApproval',
          code: 'action_request_not_found',
          run: (_ctx, probeIds) =>
            decideApproval(approverB, {
              requestId: probeIds.request!,
              decision: 'reject',
              note: 'w044 cross-tenant',
            }),
        },
      ],
      checks: [
        {
          name: 'authority policies never leak across tenants (same kind, independent rows)',
          run: async () => {
            const evaluationA = await evaluateActionAuthority(ctxA, {
              actionKind: 'source-access',
              authorityLevel: 'OBSERVE',
            });
            const evaluationB = await evaluateActionAuthority(ctxB, {
              actionKind: 'source-access',
              authorityLevel: 'OBSERVE',
            });
            expect(evaluationA.outcome).toBe('forbidden'); // tenant A's kind row
            expect(evaluationB.outcome).not.toBe('forbidden'); // tenant B is unaffected
            const policyB = await getAuthorityPolicy(ctxB, { actionKind: 'source-access' });
            expect(policyB.id).not.toBe(ids.policy);
          },
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// llm
// ---------------------------------------------------------------------------

const llmProbe: ModuleProbe = {
  module: 'llm',
  setup: async () => {
    const tenantA = newId();
    const tenantB = newId();
    const ctxA = member(tenantA);
    const ctxB = member(tenantB);

    const chatRequest = {
      capability: 'text-generation' as const,
      scope: 'cognition' as const,
      dataClassification: 'internal' as const,
      messages: [{ role: 'user' as const, content: 'w044?' }],
    };

    const seed = async (ctx: TenantContext) => {
      const admin = member(ctx.tenantId, [LLM_AUTHORITY_ADMINISTER]);
      const { account } = await registerAiProviderAccount(admin, {
        provider: 'openai',
        label: 'w044', // same (provider, label) natural key in both tenants
        credentialRef: 'secret-store://openai/w044',
        scopes: ['cognition', 'conversation', 'analysis', 'background'],
        capabilities: ['text-generation', 'embedding'],
        maxDataClassification: 'restricted',
        priority: 100,
        budgetMinor: null,
      });
      const execution = await invokeLlm(member(ctx.tenantId), { ...chatRequest });
      const { verification } = await verifyProviderHotSwap(member(ctx.tenantId), {
        ...chatRequest,
        targetA: { accountId: account.id, model: 'gpt-4o' },
        targetB: { accountId: account.id, model: 'gpt-4o-mini' },
      });
      // a manual availability entry so listing availability has own-tenant content
      await setAiAvailability(admin, {
        accountId: account.id,
        model: 'gpt-4o-mini',
        state: 'available',
        reason: 'w044 probe',
      });
      return { account, execution, verification };
    };

    const a = await seed(ctxA);
    const b = await seed(ctxB);

    const ids = { account: a.account.id, execution: a.execution.id, verification: a.verification.id };
    const idsB = {
      account: b.account.id,
      execution: b.execution.id,
      verification: b.verification.id,
    };
    const idKeys = ['account', 'execution', 'verification'];
    const llmAdminB = member(tenantB, [LLM_AUTHORITY_ADMINISTER]);

    return {
      module: 'llm',
      ctxA,
      ctxB,
      ids,
      idsB,
      idKeys,
      contextProbe: (ctx) => getAiProviderAccount(ctx, { accountId: ids.account! }),
      reads: [
        {
          name: 'getAiProviderAccount',
          code: 'account_not_found',
          run: (ctx, probeIds) => getAiProviderAccount(ctx, { accountId: probeIds.account! }),
        },
        {
          name: 'getAiProviderAccountSpend',
          code: 'account_not_found',
          run: (ctx, probeIds) => getAiProviderAccountSpend(ctx, { accountId: probeIds.account! }),
        },
        {
          name: 'getLlmExecution',
          code: 'execution_not_found',
          run: (ctx, probeIds) => getLlmExecution(ctx, { executionId: probeIds.execution! }),
        },
        {
          name: 'getHotSwapVerification',
          code: 'verification_not_found',
          run: (ctx, probeIds) => getHotSwapVerification(ctx, { verificationId: probeIds.verification! }),
        },
      ],
      lists: [
        { name: 'listAiProviderAccounts', run: (ctx) => listAiProviderAccounts(ctx, {}) },
        { name: 'listLlmExecutions', run: (ctx) => listLlmExecutions(ctx, {}) },
        { name: 'getAiAvailability', run: (ctx) => getAiAvailability(ctx, {}) },
      ],
      writes: [
        {
          name: 'updateAiProviderAccount',
          code: 'account_not_found',
          run: (_ctx, probeIds) =>
            updateAiProviderAccount(llmAdminB, { accountId: probeIds.account!, priority: 42 }),
        },
        {
          name: 'setAiAvailability',
          code: 'account_not_found',
          run: (_ctx, probeIds) =>
            setAiAvailability(llmAdminB, {
              accountId: probeIds.account!,
              model: 'gpt-4o',
              state: 'unavailable',
              reason: 'w044 cross-tenant',
            }),
        },
      ],
      checks: [
        {
          name: 'the same (provider, label) registers as distinct per-tenant accounts',
          run: async () => {
            expect(a.account.id).not.toBe(b.account.id);
            expect((await getAiProviderAccount(ctxA, { accountId: a.account.id })).id).toBe(
              a.account.id,
            );
            expect((await getAiProviderAccount(ctxB, { accountId: b.account.id })).id).toBe(
              b.account.id,
            );
          },
        },
        {
          // usage rows aggregate by (provider, model, capability) and carry no
          // account id, so the leak proof is the count: each tenant sees only
          // its own executions (1 invocation + 2 hot-swap executions each) —
          // an unscoped query would double every number.
          name: 'usage summaries never mix tenants (per-tenant execution counts)',
          run: async () => {
            const rowsA = await getLlmUsageSummary(ctxA, {});
            const rowsB = await getLlmUsageSummary(ctxB, {});
            const totalA = rowsA.reduce((sum, row) => sum + row.executions, 0);
            const totalB = rowsB.reduce((sum, row) => sum + row.executions, 0);
            expect(totalA).toBe(3);
            expect(totalB).toBe(3);
          },
        },
      ],
    };
  },
};

export const experienceProbes: ModuleProbe[] = [
  conversationsProbe,
  channelsProbe,
  notificationsProbe,
  actionsProbe,
  llmProbe,
];
