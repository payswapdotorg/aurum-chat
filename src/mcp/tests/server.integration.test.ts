// Integration tests for the MCP server surface (W039) against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port — with a REAL MCP
// client over the SDK's linked in-memory transports (the exact protocol
// path the stdio server serves, minus process spawning).
//
// W039 acceptance coverage:
//  * capability surface: tools/list returns the declared capability tools
//    with JSON Schemas (no raw database tools — pinned in the unit tests);
//  * tenant/principal context: every tool call runs as the configured
//    tenant member (verified at startup — fail-closed for non-members);
//  * policy checks: the W009 matrix gates reads ('mcp.read' @ OBSERVE):
//    forbidden → structured denial + audited 'denied_by_policy';
//  * audit events: every invocation appends exactly one immutable
//    `mcp.tool_invoked` event with provenance (actor = principal, source
//    = api/mcp) and tenant-scoped visibility;
//  * tenant isolation (ADR-0001): a second tenant's server sees none of
//    tenant A's data and none of its audit events.

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
  provisionTenant,
} from '@/modules/organizations/contract';
import { setAuthorityPolicy } from '@/modules/actions/contract';
import { listEvents } from '@/modules/events/contract';
import { createGoal } from '@/modules/goals/contract';
import {
  formBelief,
  recordUnknown,
} from '@/modules/epistemics/contract';
import { recordObservation } from '@/modules/observations/contract';
import { runMigrations } from '../../../scripts/migrate';
import { buildMcpTenantContext, verifyMcpPrincipal } from '../context';
import { createAurumMcpServer, toolDescriptor } from '../server';
import { AURUM_MCP_TOOLS } from '../registry';
import { McpToolError } from '../errors';

const T0 = '2026-09-14T09:15:00.000Z';
const D1 = '2026-12-01T00:00:00.000Z';

const platform = { principalId: newId(), authority: [ORGANIZATIONS_AUTHORITY_PROVISION] };

/** Start an MCP server + linked client for one tenant principal. */
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

/** Parse the JSON envelope the server returns for one tool call. */
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

let tenantAId: string;
let ownerAId: string;
let tenantBId: string;
let tenantBPrincipalId: string;
let memberGoalId: string;
let memberObservationId: string;
let memberUnknownId: string;
let memberBeliefId: string;
let ownerClient: Client;
let foreignClient: Client;

beforeAll(async () => {
  await runMigrations(getDb());

  // Tenant A with two principals: the owner (MCP requester) and an
  // unprovisioned stranger. Tenant B with its own owner.
  const tenantA = await provisionTenant(platform, {
    name: 'Acme Intelligence',
    ownerPrincipalId: (ownerAId = newId()),
  });
  tenantAId = tenantA.id;
  tenantBPrincipalId = newId();
  const tenantB = await provisionTenant(platform, {
    name: 'Globex Manufacturing',
    ownerPrincipalId: tenantBPrincipalId,
  });
  tenantBId = tenantB.id;

  // Seed tenant A through the owning modules' contracts (the MCP tools
  // must surface exactly this data, nothing else).
  const ownerCtx: TenantContext = { tenantId: tenantAId, principalId: ownerAId, authority: [] };
  const goal = await createGoal(ownerCtx, {
    title: 'Q4 churn reduction',
    objective: 'Reduce monthly customer churn.',
    desiredState: 'Churn is below 5% every month of the quarter.',
    metrics: [{ name: 'monthly-churn-ratio', unit: 'ratio', direction: 'at_most', threshold: 0.05 }],
    horizonStart: T0,
    horizonEnd: D1,
    owner: { kind: 'person', id: ownerAId, label: 'VP Customer Success' },
    priority: 'high',
    successCriteria: 'Three consecutive months at or below 5%.',
    actor: { kind: 'person', id: ownerAId },
    rationale: 'board-2026',
  });
  memberGoalId = goal.id;

  const observation = await recordObservation(ownerCtx, {
    kind: 'document.note',
    payload: { note: 'delivery report' },
    observedAt: T0,
    source: { kind: 'person', label: 'office-manager' },
    channel: 'ingestion',
    confidence: { value: 0.9, method: 'source_trust' },
  });
  memberObservationId = observation.id;

  const unknown = await recordUnknown(ownerCtx, {
    question: 'which warehouse causes the delivery delays?',
    consequence: 'without it we cannot fix the delivery slips promised to customers',
  });
  memberUnknownId = unknown.id;

  const belief = await formBelief(ownerCtx, {
    proposition: 'supplier Acme is reliable',
    confidence: { value: 0.7, method: 'evidence_weighing' },
    supportingObservationIds: [memberObservationId],
    alternatives: ['the good deliveries were cherry-picked'],
    disconfirmation: 'a late delivery observed after this quarter',
    validFrom: T0,
    rationale: 'weighing the delivery evidence',
  });
  memberBeliefId = belief.id;
  void memberBeliefId;

  ownerClient = await mcpClientFor({ tenantId: tenantAId, principalId: ownerAId, authority: [] });
  foreignClient = await mcpClientFor({
    tenantId: tenantBId,
    principalId: tenantBPrincipalId,
    authority: [],
  });
});

afterAll(async () => {
  await closeDb();
});

describe('startup is fail-closed for unverified principals', () => {
  it('rejects a principal that is not a member of the configured tenant', async () => {
    await expect(
      verifyMcpPrincipal({
        tenantId: tenantAId,
        principalId: newId(), // a stranger
        authority: [],
      }),
    ).rejects.toMatchObject({ code: 'invalid_config' });
  });

  it('rejects a tenant that does not exist', async () => {
    await expect(
      verifyMcpPrincipal({ tenantId: newId(), principalId: newId(), authority: [] }),
    ).rejects.toMatchObject({ code: 'invalid_config' });
  });
});

describe('tools/list (the capability surface over the real protocol)', () => {
  it('advertises the full registry with JSON Schemas', async () => {
    const { tools } = await ownerClient.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(AURUM_MCP_TOOLS.map(toolDescriptor).map((t) => t.name));
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(Object.keys(tool.inputSchema.properties ?? {}).length).toBeGreaterThan(0);
      expect(tool.description).toBeDefined();
    }
  });
});

describe('read tools surface the tenant’s data (tenant-scoped context)', () => {
  it('list_goals returns the seeded goal', async () => {
    const { isError, envelope } = await callTool(ownerClient, 'list_goals', { status: 'active' });
    expect(isError).toBe(false);
    const body = envelope as unknown as Envelope;
    expect(body.ok).toBe(true);
    expect(body.tool).toBe('list_goals');
    expect(Array.isArray(body.data)).toBe(true);
    const goals = body.data as { id: string; content: { title: string } }[];
    expect(goals).toHaveLength(1);
    expect(goals[0]!.id).toBe(memberGoalId);
    expect(goals[0]!.content.title).toBe('Q4 churn reduction');
  });

  it('get_goal returns one current view; a foreign id is not_found (no existence leak)', async () => {
    const ok = await callTool(ownerClient, 'get_goal', { goalId: memberGoalId });
    expect(ok.isError).toBe(false);
    expect((ok.envelope as unknown as Envelope).data).toMatchObject({ id: memberGoalId });

    const missing = await callTool(ownerClient, 'get_goal', { goalId: newId() });
    expect(missing.isError).toBe(true);
    const error = (missing.envelope as unknown as Envelope).error!;
    expect(error.code).toBe('not_found');
    expect(error.details).toMatchObject({ domainCode: 'goal_not_found' });
  });

  it('retrieves evidence: list_observations + get_observation', async () => {
    const list = await callTool(ownerClient, 'list_observations', { channel: 'ingestion' });
    const observations = (list.envelope as unknown as Envelope).data as { id: string }[];
    expect(observations.map((o) => o.id)).toEqual([memberObservationId]);

    const one = await callTool(ownerClient, 'get_observation', { observationId: memberObservationId });
    expect((one.envelope as unknown as Envelope).data).toMatchObject({ id: memberObservationId });
  });

  it('queries knowledge: unknowns, beliefs and claims', async () => {
    const unknowns = await callTool(ownerClient, 'list_unknowns', { status: 'open' });
    expect(
      (unknowns.envelope as unknown as Envelope).data as unknown as { id: string }[],
    ).toMatchObject([{ id: memberUnknownId }]);

    const beliefs = await callTool(ownerClient, 'list_beliefs', { status: 'active' });
    expect((beliefs.envelope as unknown as Envelope).data as unknown as { id: string }[]).toHaveLength(1);

    const claims = await callTool(ownerClient, 'list_claims', {});
    expect((claims.envelope as unknown as Envelope).data as unknown[]).toHaveLength(0);

    const belief = await callTool(ownerClient, 'get_belief', { beliefId: memberBeliefId });
    expect((belief.envelope as unknown as Envelope).data).toMatchObject({ id: memberBeliefId });
  });

  it('list_missions and list_agents start empty (no data invented)', async () => {
    const missions = await callTool(ownerClient, 'list_missions', {});
    expect((missions.envelope as unknown as Envelope).data).toEqual([]);

    const agents = await callTool(ownerClient, 'list_agents', {});
    expect((agents.envelope as unknown as Envelope).data).toEqual([]);
  });
});

describe('argument and tool-name failures are structured protocol results', () => {
  it('an unknown tool is an invalid_arguments result naming the protocol rule', async () => {
    const { isError, envelope } = await callTool(ownerClient, 'drop_table', {});
    expect(isError).toBe(true);
    const body = envelope as unknown as Envelope;
    expect(body.ok).toBe(false);
    expect(body.error!.code).toBe('invalid_arguments');
    expect(body.error!.message).toContain("unknown tool 'drop_table'");
  });

  it('malformed arguments fail as invalid_arguments (not raw exceptions)', async () => {
    const badLimit = await callTool(ownerClient, 'list_goals', { limit: 0 });
    expect(badLimit.isError).toBe(true);
    expect((badLimit.envelope as unknown as Envelope).error!.code).toBe('invalid_arguments');

    const smuggledKey = await callTool(ownerClient, 'get_goal', { goalId: memberGoalId, extra: 1 });
    expect((smuggledKey.envelope as unknown as Envelope).error!.code).toBe('invalid_arguments');
    expect((smuggledKey.envelope as unknown as Envelope).error!.message).toContain('extra');
  });
});

describe('policy checks gate the read surface (W009 matrix)', () => {
  // Assigned in beforeAll — tenant ids exist only after provisioning.
  let administer: TenantContext;

  beforeAll(() => {
    administer = { tenantId: tenantAId, principalId: ownerAId, authority: ['actions:administer'] };
  });

  it("forbidding 'mcp.read' OBSERVE denies every read tool and audits the denial", async () => {
    await setAuthorityPolicy(administer, {
      actionKind: 'mcp.read',
      forbiddenLevels: ['OBSERVE'],
    });
    try {
      const denied = await callTool(ownerClient, 'list_goals', {});
      expect(denied.isError).toBe(true);
      const body = denied.envelope as unknown as Envelope;
      expect(body.error!.code).toBe('policy_denied');
      expect(body.error!.message).toContain("matrix outcome 'forbidden'");
      expect(body.error!.details).toMatchObject({
        policy: { actionKind: 'mcp.read', authorityLevel: 'OBSERVE', outcome: 'forbidden' },
      });

      // EVERY read tool is denied, not just the one that tripped first.
      const deniedBeliefs = await callTool(ownerClient, 'list_beliefs', {});
      expect((deniedBeliefs.envelope as unknown as Envelope).error!.code).toBe('policy_denied');
    } finally {
      await setAuthorityPolicy(administer, {
        actionKind: 'mcp.read',
        approvalLevels: [],
        forbiddenLevels: [],
      });
    }
  });

  it("approval-gating 'mcp.read' OBSERVE also denies (reads do not self-approve)", async () => {
    await setAuthorityPolicy(administer, {
      actionKind: 'mcp.read',
      approvalLevels: ['OBSERVE'],
    });
    try {
      const denied = await callTool(ownerClient, 'list_goals', {});
      expect((denied.envelope as unknown as Envelope).error!.code).toBe('policy_denied');
      expect((denied.envelope as unknown as Envelope).error!.message).toContain('approval_required');
    } finally {
      await setAuthorityPolicy(administer, {
        actionKind: 'mcp.read',
        approvalLevels: [],
        forbiddenLevels: [],
      });
    }
  });

  it('reads work again once the policy row is cleared (kind row → default → built-in)', async () => {
    const ok = await callTool(ownerClient, 'list_goals', {});
    expect(ok.isError).toBe(false);
  });
});

describe('audit events (every operation is audited — lock 32)', () => {
  it('every invocation appended an immutable mcp.tool_invoked event with provenance', async () => {
    const events = await listEvents(
      { tenantId: tenantAId, principalId: ownerAId, authority: [] },
      { type: 'mcp.tool_invoked', limit: 500 },
    );
    expect(events.length).toBeGreaterThanOrEqual(10);

    for (const event of events) {
      expect(event.source).toMatchObject({ kind: 'api', label: 'mcp' });
      expect(event.actor).toMatchObject({ kind: 'person', id: ownerAId });
      const payload = event.payload as { tool: string; outcome: string; policy?: unknown };
      expect(typeof payload.tool).toBe('string');
      expect(['executed', 'denied_by_policy', 'approval_required', 'forbidden', 'error']).toContain(
        payload.outcome,
      );
    }

    // Executions carry their result summary; denials carry the policy.
    const executed = events.filter(
      (event) => (event.payload as { outcome: string }).outcome === 'executed',
    );
    expect(executed.length).toBeGreaterThan(0);
    const denied = events.filter(
      (event) => (event.payload as { outcome: string }).outcome === 'denied_by_policy',
    );
    expect(denied.length).toBeGreaterThan(0);
    expect((denied[0]!.payload as { policy: { actionKind: string } }).policy.actionKind).toBe('mcp.read');

    // The read evaluations resolved through the tenant's policy row while
    // it existed (resolution trail is reconstructable).
    const deniedVia = (denied[0]!.payload as { policy: { resolvedVia: string } }).policy.resolvedVia;
    expect(['kind', 'tenant-default']).toContain(deniedVia);
  });
});

describe('tenant isolation (ADR-0001) at the MCP boundary', () => {
  it('a foreign tenant server sees none of tenant A’s data', async () => {
    const goals = await callTool(foreignClient, 'list_goals', {});
    expect((goals.envelope as unknown as Envelope).data).toEqual([]);

    const goal = await callTool(foreignClient, 'get_goal', { goalId: memberGoalId });
    expect(goal.isError).toBe(true);
    expect((goal.envelope as unknown as Envelope).error!.code).toBe('not_found');

    const observation = await callTool(foreignClient, 'get_observation', {
      observationId: memberObservationId,
    });
    expect((observation.envelope as unknown as Envelope).error!.code).toBe('not_found');
  });

  it('a foreign tenant’s audit trail contains only its own invocations', async () => {
    const foreignTenantEvents = await listEvents(
      { tenantId: tenantBId, principalId: tenantBPrincipalId, authority: [] },
      { type: 'mcp.tool_invoked', limit: 500 },
    );
    // Tenant B's server ran exactly the three read tools above; tenant A's
    // audit trail (10+ events) must be invisible from this context.
    expect(foreignTenantEvents.length).toBeGreaterThanOrEqual(3);
    for (const event of foreignTenantEvents) {
      expect(event.tenantId).toBe(tenantBId);
      const payload = event.payload as { tool: string };
      expect(['list_goals', 'get_goal', 'get_observation']).toContain(payload.tool);
    }
  });
});

describe('the server module exports are stable', () => {
  it('toolDescriptor maps definitions onto MCP descriptors verbatim', () => {
    const descriptors = AURUM_MCP_TOOLS.map(toolDescriptor);
    expect(descriptors.find((d) => d.name === 'request_investigation')?.annotations).toMatchObject({
      readOnlyHint: false,
    });
    expect(descriptors.find((d) => d.name === 'list_goals')?.annotations).toMatchObject({
      readOnlyHint: true,
    });
  });

  it('McpToolError carries its typed code', () => {
    const error = new McpToolError('policy_denied', 'denied', { policy: {} });
    expect(error.code).toBe('policy_denied');
    expect(error.name).toBe('McpToolError');
  });
});
