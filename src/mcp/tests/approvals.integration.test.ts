// Integration tests for the MCP approval-workflow surface (W039) against
// the embedded PostgreSQL (PGlite, `:memory:`) with a REAL MCP client over
// linked in-memory transports.
//
// W039 acceptance coverage — the consequential side of the surface:
//  * request_investigation: default policy auto-allows PROPOSE → the
//    mission is created and audited;
//  * the W009 gate: when the tenant's matrix requires approval, the tool
//    records the proposal, does NOT execute, and returns the pending
//    request id;
//  * the human decision: decide_approval enforces the actions module's
//    claim gate ('actions:approve') and separation of duties (the
//    requesting principal can never decide its own request);
//  * completion of the flow: re-invoking with the same idempotencyKey
//    after the decision executes (approve) or refuses (reject) — exactly
//    once (replays recorded, no duplicate missions);
//  * propose_action: canonical §20 kinds through the matrix — allowed,
//    approval-required and forbidden outcomes;
//  * every consequential invocation is audited (executed /
//    approval_required / denied_by_policy), with the action request id
//    linking tool result, approvals feed and audit trail.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  ORGANIZATIONS_AUTHORITY_PROVISION,
  addTenantMember,
  provisionTenant,
} from '@/modules/organizations/contract';
import { setAuthorityPolicy } from '@/modules/actions/contract';
import { listEvents } from '@/modules/events/contract';
import { listMissions } from '@/modules/missions/contract';
import { runMigrations } from '../../../scripts/migrate';
import { buildMcpTenantContext } from '../context';
import { createAurumMcpServer } from '../server';

const platform = { principalId: newId(), authority: [ORGANIZATIONS_AUTHORITY_PROVISION] };

async function mcpClientFor(config: {
  tenantId: string;
  principalId: string;
  authority: string[];
}): Promise<Client> {
  const ctx = buildMcpTenantContext(config);
  const server = await createAurumMcpServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'aurum-test-client', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; envelope: Record<string, unknown> }> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: 'text'; text: string }[])[0]!.text;
  return { isError: result.isError === true, envelope: JSON.parse(text) as Record<string, unknown> };
}

interface Envelope {
  ok: boolean;
  tool: string;
  data?: unknown;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

function investigationArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Churn root cause',
    knowledgeObjective: 'Identify why churn spiked in October.',
    informationValue: 0.8,
    urgency: 'high',
    currentConfidence: 0.2,
    targetConfidence: 0.9,
    investigationBudgetAmount: 50000,
    investigationBudgetCurrency: 'EUR',
    rewardBudgetAmount: 1000,
    rewardBudgetCurrency: 'EUR',
    completionCriteria: 'A ranked driver list with supporting evidence.',
    justification: 'board concern about October churn',
    ...overrides,
  };
}

let tenantId: string;
let requesterId: string;
let approverId: string;
let requesterClient: Client;
let approverClient: Client;
let requesterCtx: TenantContext;
let gatedRequestId = '';
const administer: TenantContext = { tenantId: '', principalId: '', authority: ['actions:administer'] };

beforeAll(async () => {
  await runMigrations(getDb());

  requesterId = newId();
  const tenant = await provisionTenant(platform, {
    name: 'Acme Approvals',
    ownerPrincipalId: requesterId,
  });
  tenantId = tenant.id;
  approverId = newId();
  await addTenantMember(
    { tenantId, principalId: requesterId, authority: [] },
    { principalId: approverId, role: 'member' },
  );

  requesterCtx = { tenantId, principalId: requesterId, authority: [] };
  administer.tenantId = tenantId;
  administer.principalId = requesterId;

  requesterClient = await mcpClientFor({
    tenantId,
    principalId: requesterId,
    authority: [],
  });
  approverClient = await mcpClientFor({
    tenantId,
    principalId: approverId,
    authority: ['actions:approve'],
  });
});

afterAll(async () => {
  await closeDb();
});

describe('request_investigation under the default (built-in) policy', () => {
  it('auto-allows PROPOSE, creates the mission and audits the execution', async () => {
    const { isError, envelope } = await callTool(
      requesterClient,
      'request_investigation',
      investigationArgs({ idempotencyKey: 'inv:default' }),
    );
    expect(isError).toBe(false);
    const body = envelope as unknown as Envelope;
    expect(body.ok).toBe(true);
    const mission = body.data as { id: string; content: { title: string; status: string } };
    expect(mission.content.title).toBe('Churn root cause');
    expect(mission.content.status).toBe('active');

    // The mission is visible through the read surface, in the requester's tenant.
    const missions = await listMissions(requesterCtx, {});
    expect(missions.map((m) => m.id)).toContain(mission.id);

    // The audit event records the execution with the policy snapshot.
    const events = await listEvents(requesterCtx, { type: 'mcp.tool_invoked' });
    const executed = events.find(
      (event) =>
        (event.payload as { tool: string; outcome: string }).tool === 'request_investigation' &&
        (event.payload as { outcome: string }).outcome === 'executed',
    );
    expect(executed).toBeDefined();
    expect((executed!.payload as { policy: { actionKind: string } }).policy.actionKind).toBe(
      'mcp.request-investigation',
    );
  });
});

describe('request_investigation behind the approval gate', () => {
  it('records the proposal, does NOT execute, and waits for a human', async () => {
    await setAuthorityPolicy(administer, {
      actionKind: 'mcp.request-investigation',
      approvalLevels: ['PROPOSE'],
    });

    const { isError, envelope } = await callTool(
      requesterClient,
      'request_investigation',
      investigationArgs({ title: 'Gated churn mission', idempotencyKey: 'inv:1' }),
    );
    expect(isError).toBe(false);
    const body = envelope as unknown as Envelope;
    expect(body.ok).toBe(true);
    const data = body.data as { status: string; requestId: string; actionKind: string };
    expect(data.status).toBe('approval_required');
    expect(data.actionKind).toBe('mcp.request-investigation');
    expect(typeof data.requestId).toBe('string');

    // Nothing was executed: the gated mission does not exist yet.
    const missions = await listMissions(requesterCtx, {});
    expect(missions.find((m) => m.content.title === 'Gated churn mission')).toBeUndefined();

    // The pending request is visible in the approvals feed.
    const feed = await callTool(requesterClient, 'list_action_requests', { status: 'pending' });
    const requests = (feed.envelope as unknown as Envelope).data as { id: string; status: string }[];
    expect(requests.map((r) => r.id)).toContain(data.requestId);

    // The invocation was audited as approval_required.
    const events = await listEvents(requesterCtx, { type: 'mcp.tool_invoked' });
    const pending = events.find(
      (event) => (event.payload as { tool: string; outcome: string }).outcome === 'approval_required',
    );
    expect(pending).toBeDefined();
    expect((pending!.payload as { requestId: string | null }).requestId).toBe(data.requestId);

    // Remember the request for the following tests.
    gatedRequestId = data.requestId;
  });

  it('rejects a decision by a principal without the approve claim (claim gate)', async () => {
    const { isError, envelope } = await callTool(requesterClient, 'decide_approval', {
      requestId: gatedRequestId,
      decision: 'approve',
      note: 'trying to self-approve',
    });
    // requester lacks 'actions:approve' AND is the requester (both trip
    // the module's own gates — surfaced as 'forbidden').
    expect(isError).toBe(true);
    expect((envelope as unknown as Envelope).error!.code).toBe('forbidden');
  });

  it('rejects a self-decision even WITH the claim (separation of duties)', async () => {
    // An approver-claim server for the REQUESTING principal: the claim
    // passes, the separation-of-duties check still refuses.
    const selfDecider = await mcpClientFor({
      tenantId,
      principalId: requesterId,
      authority: ['actions:approve'],
    });
    const { isError, envelope } = await callTool(selfDecider, 'decide_approval', {
      requestId: gatedRequestId,
      decision: 'approve',
    });
    expect(isError).toBe(true);
    const error = (envelope as unknown as Envelope).error!;
    expect(error.code).toBe('forbidden');
    expect(error.message).toContain('separation of duties');
  });

  it('an authorized different principal approves the request', async () => {
    const { isError, envelope } = await callTool(approverClient, 'decide_approval', {
      requestId: gatedRequestId,
      decision: 'approve',
      note: 'board asked for it',
    });
    expect(isError).toBe(false);
    const data = (envelope as unknown as Envelope).data as { id: string; status: string };
    expect(data.id).toBe(gatedRequestId);
    expect(data.status).toBe('approved');

    // The decision trail is readable through the MCP surface.
    const inspected = await callTool(requesterClient, 'get_action_request', {
      requestId: gatedRequestId,
    });
    const detail = (inspected.envelope as unknown as Envelope).data as {
      request: { status: string };
      decisions: { decision: string; decidedBy: string; principalId: string | null }[];
    };
    expect(detail.request.status).toBe('approved');
    // An approval_required request records NO policy decision — the human
    // decision is the first and only one (first decision wins).
    expect(detail.decisions).toHaveLength(1);
    expect(detail.decisions[0]).toMatchObject({
      decision: 'approve',
      decidedBy: 'principal',
      principalId: approverId,
    });
  });

  it('re-invoking with the same idempotencyKey completes the flow exactly once', async () => {
    const before = (await listMissions(requesterCtx, {})).length;

    const first = await callTool(
      requesterClient,
      'request_investigation',
      investigationArgs({ title: 'Gated churn mission', idempotencyKey: 'inv:1' }),
    );
    expect(first.isError).toBe(false);
    const mission = (first.envelope as unknown as Envelope).data as { id: string };
    expect(mission.id).toBeDefined();

    const afterFirst = (await listMissions(requesterCtx, {})).length;
    expect(afterFirst).toBe(before + 1);

    // A further retry replays the recorded execution — no second mission.
    const retry = await callTool(
      requesterClient,
      'request_investigation',
      investigationArgs({ title: 'Gated churn mission', idempotencyKey: 'inv:1' }),
    );
    expect(retry.isError).toBe(false);
    const replayed = (retry.envelope as unknown as Envelope).data as {
      status: string;
      replayed: boolean;
    };
    expect(replayed.status).toBe('executed');
    expect(replayed.replayed).toBe(true);
    expect((await listMissions(requesterCtx, {})).length).toBe(afterFirst);
  });

  it('a rejected proposal refuses the re-invocation (policy_denied, no execution)', async () => {
    const proposed = await callTool(
      requesterClient,
      'request_investigation',
      investigationArgs({ title: 'Doomed mission', idempotencyKey: 'inv:2' }),
    );
    const { requestId } = (proposed.envelope as unknown as Envelope).data as { requestId: string };

    const rejected = await callTool(approverClient, 'decide_approval', {
      requestId,
      decision: 'reject',
      note: 'already covered',
    });
    expect(((rejected.envelope as unknown as Envelope).data as { status: string }).status).toBe('rejected');

    const retried = await callTool(
      requesterClient,
      'request_investigation',
      investigationArgs({ title: 'Doomed mission', idempotencyKey: 'inv:2' }),
    );
    expect(retried.isError).toBe(true);
    const error = (retried.envelope as unknown as Envelope).error!;
    expect(error.code).toBe('policy_denied');
    expect((await listMissions(requesterCtx, {})).find((m) => m.content.title === 'Doomed mission')).toBeUndefined();
  });
});

describe('propose_action (the canonical §20 kinds through the matrix)', () => {
  it('records an agent-recruitment proposal under the default policy (auto-approved)', async () => {
    const { isError, envelope } = await callTool(requesterClient, 'propose_action', {
      actionKind: 'agent-recruitment',
      payload: { role: 'market-scout', rationale: 'competitor watch needs a dedicated agent' },
      justification: 'environment watch gap',
      idempotencyKey: 'recruit:scout-1',
    });
    expect(isError).toBe(false);
    const data = (envelope as unknown as Envelope).data as {
      id: string;
      status: string;
      actionKind: string;
      evaluation: { outcome: string };
    };
    expect(data.status).toBe('approved');
    expect(data.actionKind).toBe('agent-recruitment');
    expect(data.evaluation.outcome).toBe('allowed');

    // Re-proposing with the same key replays the recorded execution
    // (end-to-end dedupe — no second request, no second audit event).
    const replay = await callTool(requesterClient, 'propose_action', {
      actionKind: 'agent-recruitment',
      payload: { role: 'market-scout', rationale: 'competitor watch needs a dedicated agent' },
      idempotencyKey: 'recruit:scout-1',
    });
    expect(replay.envelope as unknown as Envelope).toMatchObject({
      ok: true,
      data: { status: 'executed', replayed: true, requestId: data.id },
    });
  });

  it('records an approval-gated proposal as pending (nothing executed)', async () => {
    await setAuthorityPolicy(administer, {
      actionKind: 'agent-recruitment',
      approvalLevels: ['PROPOSE'],
    });
    const { isError, envelope } = await callTool(requesterClient, 'propose_action', {
      actionKind: 'agent-recruitment',
      payload: { role: 'collections-agent', rationale: 'overdue invoice follow-up' },
      justification: 'finance request',
    });
    expect(isError).toBe(false);
    const data = (envelope as unknown as Envelope).data as { status: string; requestId: string };
    expect(data.status).toBe('approval_required');
    expect(typeof data.requestId).toBe('string');

    // The approvals feed exposes it for a human decision.
    const feed = await callTool(approverClient, 'list_action_requests', {
      actionKind: 'agent-recruitment',
      status: 'pending',
    });
    const requests = (feed.envelope as unknown as Envelope).data as { id: string }[];
    expect(requests.map((r) => r.id)).toContain(data.requestId);
  });

  it('refuses a proposal the matrix forbids outright', async () => {
    await setAuthorityPolicy(administer, {
      actionKind: 'agent-termination',
      forbiddenLevels: ['PROPOSE'],
    });
    const { isError, envelope } = await callTool(requesterClient, 'propose_action', {
      actionKind: 'agent-termination',
      payload: { agentId: newId(), reason: 'underperforming' },
      justification: 'review outcome',
    });
    expect(isError).toBe(true);
    const error = (envelope as unknown as Envelope).error!;
    expect(error.code).toBe('policy_denied');
    expect(error.message).toContain("matrix outcome 'forbidden'");
    expect(error.details).toMatchObject({ policy: { actionKind: 'agent-termination' } });
  });

  it('rejects non-canonical action kinds at the argument boundary', async () => {
    const { isError, envelope } = await callTool(requesterClient, 'propose_action', {
      actionKind: 'format-c-drive',
      payload: {},
    });
    expect(isError).toBe(true);
    expect((envelope as unknown as Envelope).error!.code).toBe('invalid_arguments');
  });
});

describe('the consequential audit trail (lock 32 / §24 reconstruction)', () => {
  it('records every outcome class with its action request linkage', async () => {
    const events = await listEvents(requesterCtx, { type: 'mcp.tool_invoked', limit: 500 });
    const payloads = events.map((event) => event.payload as {
      tool: string;
      outcome: string;
      requestId?: string | null;
      policy?: { actionKind: string; outcome: string } | null;
    });

    // executed (both the default-policy creation and the post-approval
    // completion), approval_required, denied_by_policy and forbidden
    // (claim/separation-of-duties refusals) all appear.
    const outcomes = new Set(payloads.map((p) => p.outcome));
    expect(outcomes.has('executed')).toBe(true);
    expect(outcomes.has('approval_required')).toBe(true);
    expect(outcomes.has('denied_by_policy')).toBe(true);
    expect(outcomes.has('forbidden')).toBe(true);

    // Every approval_required / executed gated event links its request.
    const gated = payloads.filter((p) => p.tool === 'request_investigation');
    for (const payload of gated) {
      if (payload.outcome === 'executed' || payload.outcome === 'approval_required') {
        expect(typeof payload.requestId).toBe('string');
        expect(payload.policy?.actionKind).toBe('mcp.request-investigation');
      }
    }
  });
});
