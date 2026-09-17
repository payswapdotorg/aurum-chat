// Integration tests for the api module (W038 — Public API) against the
// embedded PostgreSQL (PGlite, `:memory:`) through the db port, exercising
// the FULL kernel pipeline (handleApiRequest) exactly as the Next.js
// adapter drives it. Covers the work item's acceptance:
//
//  * VERSIONED tenant-scoped API: every request flows through /api/v1;
//    a presented key resolves onto exactly one tenant; every delegated
//    call carries that tenant's explicit TenantContext; cross-tenant ids
//    are indistinguishable from missing ones (ADR-0001 — no existence
//    leak, asserted across goals, missions, deliveries and keys).
//  * CAPABILITY-ORIENTED OPERATIONS: reads of goals/unknowns/beliefs/
//    missions/knowledge/observations/capabilities/agents/approvals and
//    writes of missions ("requesting investigation"), the W009 approval
//    workflow (proposing agent recruitment through the authority matrix +
//    deciding it, with the domain's own claim gate and separation of
//    duties intact), api keys and webhooks — all through module contracts.
//  * NO RAW PERSISTENCE: the kernel's handlers only ever call contracts
//    (enforced structurally by `bun run arch`; behaviorally, everything
//    below runs through handleApiRequest).
//  * AUTHENTICATION: bearer keys verify against sha-256 hashes (raw key
//    shown exactly once), revoked keys and removed memberships die
//    immediately, capability scopes gate every route, and key
//    administration is the documented fail-closed double gate
//    ('api:administer' scope AND authority claim).
//  * AUDITED (lock 32 / ADR-0005): every authenticated operation appends
//    an immutable `api.operation` event (actor = principal, source =
//    'api', correlation = request id); unauthenticated attempts append
//    nothing (no tenant to scope them to).
//  * WEBHOOKS: subscriptions match event-type patterns; audited events
//    auto-fanout; the explicit pump delivers with the frozen envelope and
//    the documented HMAC scheme, retries transient failures with
//    exponential backoff, fails terminally on subscriber rejection,
//    exhausts its attempt budget, and supports test pings, explicit
//    redelivery and deactivation.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { systemClock } from '@/infra/clock';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../scripts/migrate';
import * as api from '../contract';
import * as actions from '@/modules/actions/contract';
import * as agents from '@/modules/agents/contract';
import * as capabilities from '@/modules/capabilities/contract';
import * as epistemics from '@/modules/epistemics/contract';
import * as events from '@/modules/events/contract';
import * as goals from '@/modules/goals/contract';
import * as memory from '@/modules/memory/contract';
import * as observations from '@/modules/observations/contract';
import * as organizations from '@/modules/organizations/contract';
import type * as missions from '@/modules/missions/contract';

const { handleApiRequest } = api;

// Deterministic clock (the sources/identity test precedent): every
// timestamp below is a function of this counter, so backoff windows can
// be crossed by advancing it.
let clockMs = Date.parse('2026-09-14T12:00:00.000Z');
function advanceClock(seconds: number): void {
  clockMs += seconds * 1000;
}

interface CapturedDelivery {
  request: api.WebhookTransportRequest;
  signature: string | null;
}

/** The fake transport's secret store: secretRef → signing secret. */
const SECRET_STORE: Record<string, string> = {
  'secret-store://webhooks/main': 'whsig_main_subscriber_secret',
};
let transportBehavior: (
  request: api.WebhookTransportRequest,
) => api.WebhookTransportReceipt = () => ({ ok: true, statusCode: 200, latencyMs: 5 });
const captured: CapturedDelivery[] = [];

const fakeTransport: api.WebhookTransport = {
  async deliver(request) {
    // A real transport resolves the secret behind the opaque ref and signs
    // `${timestamp}.${body}` — exactly the documented scheme.
    const secret = request.secretRef === null ? null : (SECRET_STORE[request.secretRef] ?? null);
    const signature =
      secret === null ? null : api.computeWebhookSignature(secret, request.timestamp, request.body);
    captured.push({ request, signature });
    return transportBehavior(request);
  },
};

// --- tenants, principals, contexts, keys -----------------------------------

const platform: organizations.PlatformContext = { principalId: newId(), authority: ['organizations:provision'] };

let tenantMain: organizations.Tenant;
let tenantIso: organizations.Tenant;
let tenantWebhook: organizations.Tenant;
let tenantRetry: organizations.Tenant;
let tenantKeys: organizations.Tenant;
let tenantMembership: organizations.Tenant;

const ownerMain = newId();
const ownerIso = newId();
const ownerWebhook = newId();
const ownerRetry = newId();
const ownerKeys = newId();
const ownerMembership = newId();
const approverMain = newId();
const tempMember = newId();

let mainKey = '';
let readonlyKey = '';
let approverKey = '';
let isoKey = '';
let webhookKey = '';
let retryKey = '';
let keysAdminKey = '';
let membershipKey = '';

let goalId = '';
let observationId = '';
let knowledgeId = '';
let unknownId = '';
let beliefId = '';
let capabilityId = '';
let agentId = '';
let missionId = '';
let pendingRequestId = '';

function ctx(tenantId: string, principalId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId, authority };
}

function adminCtx(tenantId: string, principalId: string): TenantContext {
  return ctx(tenantId, principalId, ['api:administer']);
}

/** Drive the kernel exactly as the Next.js adapter does. */
async function call(
  key: string | null,
  method: string,
  path: string,
  options: { query?: Record<string, string>; body?: unknown } = {},
): Promise<api.ApiResponse> {
  const headers: Record<string, string> = {};
  if (key !== null) headers.authorization = `Bearer ${key}`;
  return handleApiRequest({ method, path, headers, query: options.query ?? {}, body: options.body });
}

async function callExpectJson<T = unknown>(
  key: string | null,
  method: string,
  path: string,
  options: { query?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const response = await call(key, method, path, options);
  return { status: response.status, body: response.body as T };
}

function errorOf(response: api.ApiResponse): { code: string; message: string } {
  const body = response.body as { error?: { code?: string; message?: string } };
  return { code: body?.error?.code ?? '', message: body?.error?.message ?? '' };
}

const READ_SCOPES = [
  'goals:read',
  'missions:read',
  'missions:write',
  'epistemics:read',
  'knowledge:read',
  'evidence:read',
  'capabilities:read',
  'agents:read',
  'approvals:read',
  'approvals:write',
];

beforeAll(async () => {
  vi.spyOn(systemClock, 'now').mockImplementation(() => new Date(clockMs));
  await runMigrations(getDb());

  tenantMain = await organizations.provisionTenant(platform, {
    name: 'Main Co',
    ownerPrincipalId: ownerMain,
  });
  tenantIso = await organizations.provisionTenant(platform, {
    name: 'Iso Co',
    ownerPrincipalId: ownerIso,
  });
  tenantWebhook = await organizations.provisionTenant(platform, {
    name: 'Webhook Co',
    ownerPrincipalId: ownerWebhook,
  });
  tenantRetry = await organizations.provisionTenant(platform, {
    name: 'Retry Co',
    ownerPrincipalId: ownerRetry,
  });
  tenantKeys = await organizations.provisionTenant(platform, {
    name: 'Keys Co',
    ownerPrincipalId: ownerKeys,
  });
  tenantMembership = await organizations.provisionTenant(platform, {
    name: 'Membership Co',
    ownerPrincipalId: ownerMembership,
  });
  await organizations.addTenantMember(adminCtx(tenantMain.id, ownerMain), {
    principalId: approverMain,
    role: 'member',
  });
  await organizations.addTenantMember(adminCtx(tenantMembership.id, ownerMembership), {
    principalId: tempMember,
    role: 'member',
  });

  // Keys are minted through the CONTRACT (the future auth module's entry
  // point): raw values exist only in this test's memory.
  mainKey = (
    await api.createApiKey(adminCtx(tenantMain.id, ownerMain), {
      label: 'main-integration',
      scopes: READ_SCOPES,
    })
  ).key;
  readonlyKey = (
    await api.createApiKey(adminCtx(tenantMain.id, ownerMain), {
      label: 'readonly',
      scopes: ['goals:read'],
    })
  ).key;
  approverKey = (
    await api.createApiKey(adminCtx(tenantMain.id, ownerMain), {
      label: 'approver',
      principalId: approverMain,
      scopes: ['approvals:read', 'approvals:write'],
      authority: ['actions:approve'],
    })
  ).key;
  isoKey = (
    await api.createApiKey(adminCtx(tenantIso.id, ownerIso), {
      label: 'iso',
      scopes: [
        'goals:read',
        'missions:read',
        'epistemics:read',
        'knowledge:read',
        'evidence:read',
        'webhooks:manage',
      ],
    })
  ).key;
  webhookKey = (
    await api.createApiKey(adminCtx(tenantWebhook.id, ownerWebhook), {
      label: 'webhooks',
      scopes: ['webhooks:manage', 'goals:read'],
    })
  ).key;
  retryKey = (
    await api.createApiKey(adminCtx(tenantRetry.id, ownerRetry), {
      label: 'retry',
      scopes: ['webhooks:manage', 'goals:read'],
    })
  ).key;
  keysAdminKey = (
    await api.createApiKey(adminCtx(tenantKeys.id, ownerKeys), {
      label: 'keys-admin',
      scopes: ['api:administer'],
      authority: ['api:administer'],
    })
  ).key;
  membershipKey = (
    await api.createApiKey(adminCtx(tenantMembership.id, ownerMembership), {
      label: 'temp-member',
      principalId: tempMember,
      scopes: ['goals:read'],
    })
  ).key;
});

afterAll(async () => {
  vi.restoreAllMocks();
  api.setApiWebhookTransport(null);
  await closeDb();
});

// ---------------------------------------------------------------------------
// discovery + routing
// ---------------------------------------------------------------------------

describe('W038 public api: versioned surface', () => {
  it('serves the discovery document without authentication', async () => {
    const { status, body } = await callExpectJson<api.ApiDiscoveryDocument>(null, 'GET', '/api/v1');
    expect(status).toBe(200);
    expect(body.version).toBe('v1');
    expect(body.path).toBe('/api/v1');
    expect(body.operations.length).toBeGreaterThan(20);
    expect(body.operations.map((operation) => operation.operation)).toContain('missions.create');
  });

  it('rejects paths outside the versioned surface and wrong methods', async () => {
    const outside = await call(mainKey, 'GET', '/api/v2/goals');
    expect(outside.status).toBe(404);
    expect(errorOf(outside).code).toBe('route_not_found');

    const wrongMethod = await call(mainKey, 'PUT', '/api/v1/missions');
    expect(wrongMethod.status).toBe(405);
    expect(errorOf(wrongMethod).code).toBe('method_not_allowed');
    expect(wrongMethod.headers?.allow).toBe('GET, POST');

    const unknown = await call(mainKey, 'GET', '/api/v1/nope');
    expect(unknown.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// authentication + authorization
// ---------------------------------------------------------------------------

describe('W038 public api: authentication', () => {
  it('rejects missing, malformed and unknown credentials uniformly', async () => {
    for (const key of [null, 'not-a-key', 'aurum_short', 'aurum_' + 'a'.repeat(43)]) {
      const response = await call(key, 'GET', '/api/v1/goals');
      expect(response.status).toBe(401);
      expect(errorOf(response).code).toBe('unauthenticated');
    }
  });

  it('rejects a key whose principal lost tenant membership', async () => {
    const before = await call(membershipKey, 'GET', '/api/v1/goals');
    expect(before.status).toBe(200);
    await organizations.removeTenantMember(adminCtx(tenantMembership.id, ownerMembership), {
      principalId: tempMember,
    });
    const after = await call(membershipKey, 'GET', '/api/v1/goals');
    expect(after.status).toBe(403);
    expect(errorOf(after).code).toBe('principal_not_member');
  });

  it('gates operations on the key capability scopes', async () => {
    const response = await call(readonlyKey, 'POST', '/api/v1/missions', {
      body: { title: 'x' },
    });
    expect(response.status).toBe(403);
    expect(errorOf(response).code).toBe('missing_scope');
    expect(errorOf(response).message).toContain('missions:write');
  });

  it('stamps last_used_at on authenticated use', async () => {
    // readonlyKey was authenticated by the scope-gate probe above.
    const keys = await api.listApiKeys(adminCtx(tenantMain.id, ownerMain));
    expect(keys.find((k) => k.label === 'readonly')?.lastUsedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// capability-oriented reads (each through the owning contract)
// ---------------------------------------------------------------------------

describe('W038 public api: goals', () => {
  it('lists and reads seeded goals + versions', async () => {
    const created = await goals.createGoal(ctx(tenantMain.id, ownerMain), {
      title: 'Q4 churn reduction',
      objective: 'Reduce monthly customer churn.',
      desiredState: 'Churn is below 5% every month of the quarter.',
      metrics: [{ name: 'monthly-churn-ratio', unit: 'ratio', direction: 'at_most', threshold: 0.05 }],
      horizonEnd: '2026-12-01T00:00:00.000Z',
      owner: { kind: 'person', id: ownerMain, label: 'VP Customer Success' },
      priority: 'high',
      successCriteria: 'Three consecutive months at or below 5%.',
      actor: { kind: 'person', id: ownerMain },
    });
    goalId = created.id;

    const list = await callExpectJson<{ items: goals.Goal[] }>(mainKey, 'GET', '/api/v1/goals');
    expect(list.status).toBe(200);
    expect(list.body.items.map((item) => item.id)).toContain(goalId);

    const one = await callExpectJson<goals.Goal>(mainKey, 'GET', `/api/v1/goals/${goalId}`);
    expect(one.status).toBe(200);
    expect(one.body.content.title).toBe('Q4 churn reduction');

    const versions = await callExpectJson<{ items: goals.GoalVersion[] }>(
      mainKey,
      'GET',
      `/api/v1/goals/${goalId}/versions`,
    );
    expect(versions.status).toBe(200);
    expect(versions.body.items).toHaveLength(1);

    const version = await callExpectJson<goals.GoalVersion>(
      mainKey,
      'GET',
      `/api/v1/goals/${goalId}/versions/1`,
    );
    expect(version.status).toBe(200);
    expect(version.body.version).toBe(1);
  });

  it('validates query parameters before delegating', async () => {
    const response = await call(mainKey, 'GET', '/api/v1/goals', { query: { limit: 'zero' } });
    expect(response.status).toBe(400);
    expect(errorOf(response).code).toBe('invalid_query');
  });

  it('hides another tenant\'s goal completely (404, no leak)', async () => {
    const response = await call(isoKey, 'GET', `/api/v1/goals/${goalId}`);
    expect(response.status).toBe(404);
    expect(errorOf(response).code).toBe('goal_not_found');
    const missing = await call(mainKey, 'GET', `/api/v1/goals/${newId()}`);
    expect(missing.status).toBe(404);
  });
});

describe('W038 public api: evidence, knowledge, epistemics', () => {
  it('exposes observations with lineage', async () => {
    const observation = await observations.recordObservation(ctx(tenantMain.id, ownerMain), {
      kind: 'metric.sample',
      payload: { metric: 'churn', value: 0.07 },
      observedAt: '2026-09-14T10:00:00.000Z',
      source: { kind: 'system', label: 'billing-export' },
      channel: 'ingestion',
      confidence: { value: 0.95, method: 'direct-read' },
    });
    observationId = observation.id;

    const list = await callExpectJson<{ items: observations.Observation[] }>(
      mainKey,
      'GET',
      '/api/v1/observations',
    );
    expect(list.status).toBe(200);
    expect(list.body.items.map((item) => item.id)).toContain(observationId);

    const lineage = await callExpectJson<observations.ObservationLineageResult>(
      mainKey,
      'GET',
      `/api/v1/observations/${observationId}/lineage`,
    );
    expect(lineage.status).toBe(200);

    const foreign = await call(isoKey, 'GET', `/api/v1/observations/${observationId}`);
    expect(foreign.status).toBe(404);
  });

  it('exposes evidence-backed knowledge + its evidence', async () => {
    const entry = await memory.recordKnowledgeEntry(ctx(tenantMain.id, ownerMain), {
      kind: 'fact',
      title: 'Enterprise churn driver',
      summary: 'Onboarding duration correlates with enterprise churn.',
      topics: ['churn', 'onboarding'],
      evidenceObservationIds: [observationId],
    });
    knowledgeId = entry.id;

    const list = await callExpectJson<{ items: memory.KnowledgeEntry[] }>(
      mainKey,
      'GET',
      '/api/v1/knowledge',
      { query: { topics: 'churn' } },
    );
    expect(list.status).toBe(200);
    expect(list.body.items.map((item) => item.id)).toContain(knowledgeId);

    const evidence = await callExpectJson<memory.KnowledgeEntryEvidence>(
      mainKey,
      'GET',
      `/api/v1/knowledge/${knowledgeId}/evidence`,
    );
    expect(evidence.status).toBe(200);
    expect(evidence.body.evidence.map((item) => item.id)).toContain(observationId);
  });

  it('exposes unknowns and beliefs', async () => {
    const unknown = await epistemics.recordUnknown(ctx(tenantMain.id, ownerMain), {
      question: 'Which onboarding step loses the most enterprise accounts?',
      consequence: 'Without it, churn-reduction spend is unfocused.',
    });
    unknownId = unknown.id;
    const belief = await epistemics.formBelief(ctx(tenantMain.id, ownerMain), {
      proposition: 'Long onboarding drives enterprise churn.',
      confidence: { value: 0.6, method: 'correlation' },
      supportingObservationIds: [observationId],
      validFrom: '2026-09-14T12:00:00.000Z',
    });
    beliefId = belief.id;

    const unknowns = await callExpectJson<{ items: epistemics.Unknown[] }>(
      mainKey,
      'GET',
      '/api/v1/unknowns',
    );
    expect(unknowns.status).toBe(200);
    expect(unknowns.body.items.map((item) => item.id)).toContain(unknownId);

    const beliefs = await callExpectJson<{ items: epistemics.Belief[] }>(
      mainKey,
      'GET',
      '/api/v1/beliefs',
    );
    expect(beliefs.status).toBe(200);
    expect(beliefs.body.items.map((item) => item.id)).toContain(beliefId);

    const one = await callExpectJson<epistemics.Belief>(
      mainKey,
      'GET',
      `/api/v1/beliefs/${beliefId}`,
    );
    expect(one.status).toBe(200);
  });
});

describe('W038 public api: capabilities and agents', () => {
  it('exposes the capability graph and its gap findings', async () => {
    const capability = await capabilities.registerCapability(ctx(tenantMain.id, ownerMain), {
      name: 'churn-analysis',
      description: 'Analyzing churn drivers from billing data.',
      actor: { kind: 'person', id: ownerMain },
    });
    capabilityId = capability.id;
    await capabilities.registerRequirement(ctx(tenantMain.id, ownerMain), {
      capabilityId,
      source: { kind: 'manual', label: 'Q4 objective' },
      level: 0.8,
      actor: { kind: 'person', id: ownerMain },
    });
    await capabilities.registerSupply(ctx(tenantMain.id, ownerMain), {
      capabilityId,
      supplier: { kind: 'employee', label: 'Data team' },
      level: 0.4,
      actor: { kind: 'person', id: ownerMain },
    });

    const list = await callExpectJson<{ items: capabilities.Capability[] }>(
      mainKey,
      'GET',
      '/api/v1/capabilities',
    );
    expect(list.status).toBe(200);
    expect(list.body.items.map((item) => item.id)).toContain(capabilityId);

    const gaps = await callExpectJson<{ items: capabilities.CapabilityGap[] }>(
      mainKey,
      'GET',
      '/api/v1/capabilities/gaps',
    );
    expect(gaps.status).toBe(200);
    const gap = gaps.body.items.find((item) => item.capability.id === capabilityId);
    expect(gap?.status).toBe('level_shortfall');

    const one = await callExpectJson<capabilities.Capability>(
      mainKey,
      'GET',
      `/api/v1/capabilities/${capabilityId}`,
    );
    expect(one.status).toBe(200);
  });

  it('exposes the agent workforce and its execution traces', async () => {
    const agent = await agents.registerAgent(
      ctx(tenantMain.id, ownerMain, ['agents:administer']),
      {
        slug: 'churn-analyst',
        role: 'Analyst',
        provider: 'openai-assistants',
        instructions: 'Analyze churn drivers from billing exports.',
        permissions: ['observe', 'analyze'],
      },
    );
    agentId = agent.agent.id;

    const list = await callExpectJson<{ items: agents.AgentDefinition[] }>(
      mainKey,
      'GET',
      '/api/v1/agents',
    );
    expect(list.status).toBe(200);
    expect(list.body.items.map((item) => item.id)).toContain(agentId);

    const executions = await callExpectJson<{ items: unknown[] }>(
      mainKey,
      'GET',
      `/api/v1/agents/${agentId}/executions`,
    );
    expect(executions.status).toBe(200);
    expect(executions.body.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// capability-oriented writes
// ---------------------------------------------------------------------------

describe('W038 public api: requesting investigations (missions)', () => {
  const missionBody = {
    title: 'Why is churn concentrated in enterprise?',
    knowledgeObjective: 'Identify the top drivers of enterprise churn this quarter.',
    informationValue: 0.8,
    urgency: 'high',
    targetConfidence: 0.9,
    investigationBudget: { amount: 50000, currency: 'USD' },
    rewardBudget: { amount: 0, currency: 'USD' },
    completionCriteria: 'A ranked driver list with supporting evidence.',
  };

  it('creates a mission through the missions contract, defaulting the actor to the key principal', async () => {
    const created = await callExpectJson<missions.Mission>(mainKey, 'POST', '/api/v1/missions', {
      body: missionBody,
    });
    expect(created.status).toBe(201);
    missionId = created.body.id;
    expect(created.body.content.title).toBe(missionBody.title);
    expect(created.body.content.status).toBe('active');
    // The API acts as the authenticated principal (audit trail).
    expect(created.body.lastChange.actor.id).toBe(ownerMain);
    expect(created.body.lastChange.actor.label).toMatch(/^api-key:/);
    expect(created.body.lastChange.changedByPrincipal).toBe(ownerMain);
  });

  it('reads the mission back through the api (list, get, versions)', async () => {
    const list = await callExpectJson<{ items: missions.Mission[] }>(mainKey, 'GET', '/api/v1/missions');
    expect(list.status).toBe(200);
    expect(list.body.items.map((item) => item.id)).toContain(missionId);

    const one = await callExpectJson<missions.Mission>(mainKey, 'GET', `/api/v1/missions/${missionId}`);
    expect(one.status).toBe(200);

    const versions = await callExpectJson<{ items: missions.MissionVersion[] }>(
      mainKey,
      'GET',
      `/api/v1/missions/${missionId}/versions`,
    );
    expect(versions.status).toBe(200);
    expect(versions.body.items).toHaveLength(1);
  });

  it('maps domain validation failures onto 400 without leaking internals', async () => {
    const response = await call(mainKey, 'POST', '/api/v1/missions', {
      body: { ...missionBody, targetConfidence: 0.2, currentConfidence: 0.8 },
    });
    expect(response.status).toBe(400);
    expect(errorOf(response).code).toBe('invalid_mission_input');
  });

  it('revises and completes the mission through the api', async () => {
    const revised = await callExpectJson<missions.Mission>(
      mainKey,
      'PATCH',
      `/api/v1/missions/${missionId}`,
      { body: { title: 'Why is churn concentrated in enterprise accounts?' } },
    );
    expect(revised.status).toBe(200);
    expect(revised.body.version).toBe(2);

    const completed = await callExpectJson<missions.Mission>(
      mainKey,
      'POST',
      `/api/v1/missions/${missionId}/completion`,
      { body: { achievedConfidence: 0.92, outcome: 'Onboarding duration is the top driver.' } },
    );
    expect(completed.status).toBe(200);
    expect(completed.body.content.status).toBe('completed');
    expect(completed.body.completion?.achievedConfidence).toBeCloseTo(0.92);
  });

  it('abandons another mission and hides cross-tenant missions', async () => {
    const created = await callExpectJson<missions.Mission>(mainKey, 'POST', '/api/v1/missions', {
      body: { ...missionBody, title: 'Supplier reliability signals' },
    });
    const abandoned = await callExpectJson<missions.Mission>(
      mainKey,
      'POST',
      `/api/v1/missions/${created.body.id}/abandonment`,
      { body: { reason: 'Deprioritized by management.' } },
    );
    expect(abandoned.status).toBe(200);
    expect(abandoned.body.content.status).toBe('abandoned');

    const foreign = await call(isoKey, 'GET', `/api/v1/missions/${missionId}`);
    expect(foreign.status).toBe(404);
    expect(errorOf(foreign).code).toBe('mission_not_found');
  });
});

// ---------------------------------------------------------------------------
// the W009 approval workflow over the api
// ---------------------------------------------------------------------------

describe('W038 public api: approval workflows', () => {
  it('proposes agent recruitment through the authority matrix (EXECUTE gates pending)', async () => {
    const created = await callExpectJson<actions.ActionRequest>(mainKey, 'POST', '/api/v1/approvals', {
      body: {
        actionKind: 'agent-recruitment',
        authorityLevel: 'EXECUTE',
        payload: { role: 'churn-analyst', provider: 'openai-assistants' },
        justification: 'Q4 churn goal needs dedicated analysis capacity.',
      },
    });
    expect(created.status).toBe(201);
    pendingRequestId = created.body.id;
    expect(created.body.status).toBe('pending');
    expect(created.body.evaluation.outcome).toBe('approval_required');
  });

  it('lists requests, reads one, and reads its (still empty) decisions', async () => {
    const list = await callExpectJson<{ items: actions.ActionRequest[] }>(
      mainKey,
      'GET',
      '/api/v1/approvals',
      { query: { status: 'pending' } },
    );
    expect(list.status).toBe(200);
    expect(list.body.items.map((item) => item.id)).toContain(pendingRequestId);

    const one = await callExpectJson<actions.ActionRequest>(
      mainKey,
      'GET',
      `/api/v1/approvals/${pendingRequestId}`,
    );
    expect(one.status).toBe(200);

    const decisions = await callExpectJson<{ items: actions.ApprovalDecision[] }>(
      mainKey,
      'GET',
      `/api/v1/approvals/${pendingRequestId}/decisions`,
    );
    expect(decisions.status).toBe(200);
    expect(decisions.body.items).toEqual([]);
  });

  it('keeps the domain claim gate: deciding without actions:approve is forbidden', async () => {
    const response = await call(mainKey, 'POST', `/api/v1/approvals/${pendingRequestId}/decisions`, {
      body: { decision: 'approve' },
    });
    expect(response.status).toBe(403);
    expect(errorOf(response).code).toBe('forbidden');
  });

  it('keeps separation of duties intact while an authorized different principal decides', async () => {
    // approverKey carries the 'actions:approve' claim and acts as
    // approverMain — a DIFFERENT principal than the requester — so the
    // human decision lands (the requester deciding its own request is
    // rejected by the actions module itself and covered by its tests).
    const decided = await callExpectJson<actions.ActionRequest>(
      approverKey,
      'POST',
      `/api/v1/approvals/${pendingRequestId}/decisions`,
      { body: { decision: 'approve', note: 'Budget available.' } },
    );
    expect(decided.status).toBe(201);
    expect(decided.body.status).toBe('approved');

    const decisions = await callExpectJson<{ items: actions.ApprovalDecision[] }>(
      mainKey,
      'GET',
      `/api/v1/approvals/${pendingRequestId}/decisions`,
    );
    expect(decisions.body.items).toHaveLength(1); // the human decision
    expect(decisions.body.items[0]!.decidedBy).toBe('principal');
    expect(decisions.body.items[0]!.principalId).toBe(approverMain);
  });

  it('proposing (PROPOSE) is auto-allowed by the built-in matrix', async () => {
    const created = await callExpectJson<actions.ActionRequest>(mainKey, 'POST', '/api/v1/approvals', {
      body: {
        actionKind: 'agent-recruitment',
        authorityLevel: 'PROPOSE',
        payload: { role: ' collections-agent' },
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('approved');
    expect(created.body.evaluation.outcome).toBe('allowed');
  });
});

// ---------------------------------------------------------------------------
// audit (lock 32)
// ---------------------------------------------------------------------------

describe('W038 public api: every operation is audited', () => {
  it('appends one immutable api.operation event per authenticated operation', async () => {
    const audited = await events.listEvents(ctx(tenantMain.id, ownerMain), {
      type: 'api.operation',
      limit: 500,
    });
    expect(audited.length).toBeGreaterThan(10);
    const goalsList = audited.find((event) => {
      const payload = event.payload as { operation?: string; status?: number };
      return payload.operation === 'goals.list' && payload.status === 200;
    });
    expect(goalsList).toBeDefined();
    expect(goalsList?.actor).toMatchObject({ kind: 'person', id: ownerMain });
    expect(goalsList?.actor.label).toMatch(/^api-key:/);
    expect(goalsList?.source).toMatchObject({ kind: 'api', label: 'public-api/v1' });
    expect(goalsList?.correlationId).toBeDefined();

    // Denied operations are audited too (the 403 missing_scope probe).
    const denied = audited.find((event) => {
      const payload = event.payload as { operation?: string; status?: number };
      return payload.operation === 'missions.create' && payload.status === 403;
    });
    expect(denied).toBeDefined();
  });

  it('appends nothing for unauthenticated attempts', async () => {
    const before = (
      await events.listEvents(ctx(tenantMain.id, ownerMain), { type: 'api.operation', limit: 500 })
    ).length;
    await call(null, 'GET', '/api/v1/goals');
    await call('aurum_' + 'b'.repeat(43), 'GET', '/api/v1/goals');
    const after = (
      await events.listEvents(ctx(tenantMain.id, ownerMain), { type: 'api.operation', limit: 500 })
    ).length;
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// api key management over http (the fail-closed double gate)
// ---------------------------------------------------------------------------

describe('W038 public api: key administration', () => {
  it('issues a key over http (raw key returned exactly once) and it works', async () => {
    const issued = await callExpectJson<api.ApiKeyIssuance>(
      keysAdminKey,
      'POST',
      '/api/v1/api-keys',
      {
        body: { label: 'integration-reader', scopes: ['goals:read'] },
      },
    );
    expect(issued.status).toBe(201);
    expect(issued.body.key).toMatch(/^aurum_[A-Za-z0-9_-]{43}$/);
    expect(issued.body.apiKey.scopes).toEqual(['goals:read']);
    expect((issued.body.apiKey as unknown as Record<string, unknown>).keyHash).toBeUndefined();
    expect(issued.body.apiKey.principalId).toBe(ownerKeys);

    const used = await call(issued.body.key, 'GET', '/api/v1/goals');
    expect(used.status).toBe(200);
  });

  it('requires the api:administer authority claim even with the scope (double gate)', async () => {
    const scopeOnly = await api.createApiKey(adminCtx(tenantKeys.id, ownerKeys), {
      label: 'scope-only',
      scopes: ['api:administer'],
    });
    const response = await call(scopeOnly.key, 'GET', '/api/v1/api-keys');
    expect(response.status).toBe(403);
    expect(errorOf(response).code).toBe('missing_scope');
  });

  it('lists keys without hashes and refuses keys for non-members', async () => {
    const list = await callExpectJson<{ items: api.ApiKey[] }>(
      keysAdminKey,
      'GET',
      '/api/v1/api-keys',
    );
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThanOrEqual(2);
    for (const key of list.body.items) {
      expect((key as unknown as Record<string, unknown>).keyHash).toBeUndefined();
    }

    const forNonMember = await call(keysAdminKey, 'POST', '/api/v1/api-keys', {
      body: { label: 'ghost', principalId: newId(), scopes: ['goals:read'] },
    });
    expect(forNonMember.status).toBe(403);
    expect(errorOf(forNonMember).code).toBe('principal_not_member');
  });

  it('revokes keys (idempotently) and they stop authenticating', async () => {
    const issued = await api.createApiKey(adminCtx(tenantKeys.id, ownerKeys), {
      label: 'to-revoke',
      scopes: ['goals:read'],
    });
    const revoke = await callExpectJson<api.ApiKey>(
      keysAdminKey,
      'DELETE',
      `/api/v1/api-keys/${issued.apiKey.id}`,
    );
    expect(revoke.status).toBe(200);
    expect(revoke.body.status).toBe('revoked');
    expect(revoke.body.revokedBy).toBe(ownerKeys);

    // Idempotent second revoke.
    const again = await call(keysAdminKey, 'DELETE', `/api/v1/api-keys/${issued.apiKey.id}`);
    expect(again.status).toBe(200);

    const dead = await call(issued.key, 'GET', '/api/v1/goals');
    expect(dead.status).toBe(401);

    // Another tenant's key id is indistinguishable from missing.
    const foreign = await call(keysAdminKey, 'DELETE', `/api/v1/api-keys/${newId()}`);
    expect(foreign.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// webhooks: subscriptions, fanout, delivery, retries, evidence
// ---------------------------------------------------------------------------

describe('W038 public api: webhooks', () => {
  let subscriptionId = '';

  it('creates a subscription and validates urls/patterns/conflicts', async () => {
    const created = await callExpectJson<api.WebhookSubscription>(
      webhookKey,
      'POST',
      '/api/v1/webhooks',
      {
        body: {
          label: 'integration-listener',
          url: 'https://hooks.example.com/aurum',
          eventTypes: ['api.operation'],
          secretRef: 'secret-store://webhooks/main',
          maxAttempts: 5,
        },
      },
    );
    expect(created.status).toBe(201);
    subscriptionId = created.body.id;
    expect(created.body.status).toBe('active');
    expect(created.body.eventTypes).toEqual(['api.operation']);

    const badUrl = await call(webhookKey, 'POST', '/api/v1/webhooks', {
      body: { label: 'x', url: 'http://hooks.example.com/x', eventTypes: ['*'] },
    });
    expect(badUrl.status).toBe(400);

    const badPattern = await call(webhookKey, 'POST', '/api/v1/webhooks', {
      body: { label: 'x', url: 'https://hooks.example.com/x', eventTypes: ['bad pattern'] },
    });
    expect(badPattern.status).toBe(400);

    const duplicate = await call(webhookKey, 'POST', '/api/v1/webhooks', {
      body: { label: 'dup', url: 'https://hooks.example.com/aurum', eventTypes: ['*'] },
    });
    expect(duplicate.status).toBe(409);
    expect(errorOf(duplicate).code).toBe('webhook_conflict');
  });

  it('auto-fans audited operations out to matching subscriptions', async () => {
    // One audited read in the webhook tenant.
    const read = await call(webhookKey, 'GET', '/api/v1/goals');
    expect(read.status).toBe(200);

    const deliveries = await callExpectJson<{ items: api.WebhookDelivery[] }>(
      webhookKey,
      'GET',
      `/api/v1/webhooks/${subscriptionId}/deliveries`,
    );
    expect(deliveries.status).toBe(200);
    expect(deliveries.body.items.length).toBeGreaterThanOrEqual(1);
    const target = deliveries.body.items[0]!;
    expect(target.status).toBe('pending');
    expect(target.kind).toBe('event');
    expect(target.eventType).toBe('api.operation');
    expect(target.eventId).not.toBeNull();
    const envelope = JSON.parse(target.body) as {
      id: string;
      version: number;
      eventType: string;
      eventId: string;
      subscriptionId: string;
      payload: { operation?: string };
    };
    expect(envelope.id).toBe(target.id);
    expect(envelope.version).toBe(1);
    expect(envelope.eventType).toBe('api.operation');
    expect(envelope.subscriptionId).toBe(subscriptionId);
    expect(envelope.payload.operation).toBe('goals.list');
  });

  it('refuses to dispatch without a wired transport', async () => {
    const response = await call(webhookKey, 'POST', '/api/v1/webhooks/dispatch', { body: {} });
    expect(response.status).toBe(503);
    expect(errorOf(response).code).toBe('provider_unavailable');
  });

  it('delivers through the transport with the frozen envelope and the documented signature', async () => {
    api.setApiWebhookTransport(fakeTransport);
    transportBehavior = () => ({ ok: true, statusCode: 200, latencyMs: 7 });

    const deliveries = await callExpectJson<{ items: api.WebhookDelivery[] }>(
      webhookKey,
      'GET',
      `/api/v1/webhooks/${subscriptionId}/deliveries`,
    );
    const target = deliveries.body.items[0]!;

    const dispatch = await callExpectJson<api.DispatchWebhookDeliveriesResult>(
      webhookKey,
      'POST',
      '/api/v1/webhooks/dispatch',
      { body: { limit: 10 } },
    );
    expect(dispatch.status).toBe(200);
    const outcome = dispatch.body.dispatched.find((item) => item.deliveryId === target.id);
    expect(outcome?.outcome).toBe('delivered');
    expect(outcome?.statusCode).toBe(200);

    // The delivery evidence: status delivered, one successful attempt.
    const detail = await callExpectJson<api.WebhookDeliveryDetail>(
      webhookKey,
      'GET',
      `/api/v1/webhooks/deliveries/${target.id}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.delivery.status).toBe('delivered');
    expect(detail.body.delivery.attempts).toBe(1);
    expect(detail.body.attempts).toHaveLength(1);
    expect(detail.body.attempts[0]!.outcome).toBe('succeeded');
    expect(detail.body.attempts[0]!.statusCode).toBe(200);

    // The transport received the exact frozen body + the opaque secret ref.
    const capturedDelivery = captured.find((item) => item.request.deliveryId === target.id);
    expect(capturedDelivery).toBeDefined();
    expect(capturedDelivery!.request.url).toBe('https://hooks.example.com/aurum');
    expect(capturedDelivery!.request.body).toBe(target.body);
    expect(capturedDelivery!.request.secretRef).toBe('secret-store://webhooks/main');
    // Subscriber-side verification: recompute the HMAC independently.
    const secret = SECRET_STORE['secret-store://webhooks/main']!;
    const expected = createHmac('sha256', secret)
      .update(`${capturedDelivery!.request.timestamp}.${capturedDelivery!.request.body}`)
      .digest('hex');
    expect(capturedDelivery!.signature).toBe(expected);
  });

  it('supports explicit redelivery of a delivered webhook', async () => {
    const deliveries = await callExpectJson<{ items: api.WebhookDelivery[] }>(
      webhookKey,
      'GET',
      `/api/v1/webhooks/${subscriptionId}/deliveries`,
      { query: { status: 'delivered' } },
    );
    const target = deliveries.body.items[0]!;

    const redelivered = await callExpectJson<api.WebhookDelivery>(
      webhookKey,
      'POST',
      `/api/v1/webhooks/deliveries/${target.id}/redeliver`,
      { body: {} },
    );
    expect(redelivered.status).toBe(201);
    expect(redelivered.body.status).toBe('pending');
    expect(redelivered.body.redeliveryOf).toBe(target.id);
    expect(redelivered.body.body).toBe(target.body); // byte-stable envelope

    await call(webhookKey, 'POST', '/api/v1/webhooks/dispatch', { body: { limit: 10 } });
    const detail = await callExpectJson<api.WebhookDeliveryDetail>(
      webhookKey,
      'GET',
      `/api/v1/webhooks/deliveries/${redelivered.body.id}`,
    );
    expect(detail.body.delivery.status).toBe('delivered');
    expect(detail.body.delivery.redeliveryOf).toBe(target.id);
  });

  it('sends a signed test ping and delivers it', async () => {
    const ping = await callExpectJson<api.WebhookDelivery>(
      webhookKey,
      'POST',
      `/api/v1/webhooks/${subscriptionId}/test`,
      { body: {} },
    );
    expect(ping.status).toBe(201);
    expect(ping.body.kind).toBe('test');
    expect(ping.body.eventType).toBe('webhook.test');
    expect(ping.body.eventId).toBeNull();
    expect(JSON.parse(ping.body.body)).toMatchObject({ test: true, eventType: 'webhook.test' });

    await call(webhookKey, 'POST', '/api/v1/webhooks/dispatch', { body: { limit: 10 } });
    const detail = await callExpectJson<api.WebhookDeliveryDetail>(
      webhookKey,
      'GET',
      `/api/v1/webhooks/deliveries/${ping.body.id}`,
    );
    expect(detail.body.delivery.status).toBe('delivered');
  });

  it('fans an explicitly-named event out to pattern-matching subscriptions only', async () => {
    const second = await callExpectJson<api.WebhookSubscription>(
      webhookKey,
      'POST',
      '/api/v1/webhooks',
      {
        body: { label: 'goal-listener', url: 'https://hooks.example.com/goals', eventTypes: ['goal.*'] },
      },
    );
    expect(second.status).toBe(201);

    const event = await events.appendEvent(ctx(tenantWebhook.id, ownerWebhook), {
      type: 'goal.revised',
      payload: { goalId: newId() },
      occurredAt: new Date(clockMs).toISOString(),
      actor: { kind: 'person', id: ownerWebhook },
      source: { kind: 'system', label: 'seed' },
    });

    const fanout = await callExpectJson<api.FanoutEventResult>(
      webhookKey,
      'POST',
      '/api/v1/webhooks/fanout',
      { body: { eventId: event.id } },
    );
    expect(fanout.status).toBe(200);
    expect(fanout.body.matched).toBe(1);
    expect(fanout.body.enqueued).toHaveLength(1);

    // Fanout is idempotent per (subscription, event).
    const again = await callExpectJson<api.FanoutEventResult>(
      webhookKey,
      'POST',
      '/api/v1/webhooks/fanout',
      { body: { eventId: event.id } },
    );
    expect(again.body.enqueued).toHaveLength(0);

    // A foreign event id is a 404, never a fanout.
    const foreign = await call(webhookKey, 'POST', '/api/v1/webhooks/fanout', {
      body: { eventId: newId() },
    });
    expect(foreign.status).toBe(404);
    expect(errorOf(foreign).code).toBe('event_not_found');
  });

  it('deactivates a subscription (idempotently) and stops matching it', async () => {
    // Counting through the CONTRACT avoids audit-fanout drift: every HTTP
    // call in this tenant appends an api.operation event, which would
    // itself enqueue a delivery for the still-active subscription.
    const countDeliveries = async (): Promise<number> =>
      (
        await api.listWebhookDeliveries(ctx(tenantWebhook.id, ownerWebhook), {
          subscriptionId,
        })
      ).length;

    const before = await countDeliveries();

    const deactivated = await callExpectJson<api.WebhookSubscription>(
      webhookKey,
      'DELETE',
      `/api/v1/webhooks/${subscriptionId}`,
    );
    expect(deactivated.status).toBe(200);
    expect(deactivated.body.status).toBe('deactivated');

    const again = await call(webhookKey, 'DELETE', `/api/v1/webhooks/${subscriptionId}`);
    expect(again.status).toBe(200);

    // Audited operations no longer enqueue for the deactivated sub.
    await call(webhookKey, 'GET', '/api/v1/goals');
    const after = await countDeliveries();
    expect(after).toBe(before);
  });

  it('hides another tenant\'s subscriptions and deliveries (404, no leak)', async () => {
    const foreignSub = await call(isoKey, 'GET', `/api/v1/webhooks/${subscriptionId}`);
    expect(foreignSub.status).toBe(404);

    const deliveries = await callExpectJson<{ items: api.WebhookDelivery[] }>(
      webhookKey,
      'GET',
      `/api/v1/webhooks/${subscriptionId}/deliveries`,
    );
    const someDelivery = deliveries.body.items[0]!;
    const foreignDelivery = await call(isoKey, 'GET', `/api/v1/webhooks/deliveries/${someDelivery.id}`);
    expect(foreignDelivery.status).toBe(404);

    const foreignRedeliver = await call(isoKey, 'POST', `/api/v1/webhooks/deliveries/${someDelivery.id}/redeliver`);
    expect(foreignRedeliver.status).toBe(404);
  });
});

describe('W038 public api: webhook retry policy', () => {
  it('retries transient failures with exponential backoff until the budget is spent', async () => {
    const created = await callExpectJson<api.WebhookSubscription>(
      retryKey,
      'POST',
      '/api/v1/webhooks',
      {
        body: {
          label: 'flaky-listener',
          url: 'https://hooks.example.com/flaky',
          eventTypes: ['api.operation'],
          maxAttempts: 3,
        },
      },
    );
    expect(created.status).toBe(201);
    const subscriptionId = created.body.id;

    // One audited read enqueues one delivery.
    await call(retryKey, 'GET', '/api/v1/goals');
    const deliveries = await callExpectJson<{ items: api.WebhookDelivery[] }>(
      retryKey,
      'GET',
      `/api/v1/webhooks/${subscriptionId}/deliveries`,
    );
    const target = deliveries.body.items[0]!;
    expect(target.maxAttempts).toBe(3);

    transportBehavior = () => ({ ok: false, statusCode: 500, error: 'boom', latencyMs: 3 });

    // Attempt 1: transient failure → retrying in ~30s.
    let dispatch = await callExpectJson<api.DispatchWebhookDeliveriesResult>(
      retryKey,
      'POST',
      '/api/v1/webhooks/dispatch',
      { body: { limit: 10 } },
    );
    let outcome = dispatch.body.dispatched.find((item) => item.deliveryId === target.id);
    expect(outcome?.outcome).toBe('retrying');
    expect(outcome?.nextAttemptAt).toBeDefined();

    // Not due yet: dispatching again before the backoff window does nothing.
    advanceClock(10);
    dispatch = await callExpectJson<api.DispatchWebhookDeliveriesResult>(
      retryKey,
      'POST',
      '/api/v1/webhooks/dispatch',
      { body: { limit: 10 } },
    );
    expect(dispatch.body.dispatched.find((item) => item.deliveryId === target.id)).toBeUndefined();

    // Attempt 2 after the 30s window (backoff 60s follows).
    advanceClock(25);
    dispatch = await callExpectJson<api.DispatchWebhookDeliveriesResult>(
      retryKey,
      'POST',
      '/api/v1/webhooks/dispatch',
      { body: { limit: 10 } },
    );
    outcome = dispatch.body.dispatched.find((item) => item.deliveryId === target.id);
    expect(outcome?.outcome).toBe('retrying');

    // Attempt 3 exhausts the budget → failed (terminal).
    advanceClock(61);
    dispatch = await callExpectJson<api.DispatchWebhookDeliveriesResult>(
      retryKey,
      'POST',
      '/api/v1/webhooks/dispatch',
      { body: { limit: 10 } },
    );
    outcome = dispatch.body.dispatched.find((item) => item.deliveryId === target.id);
    expect(outcome?.outcome).toBe('failed');

    const detail = await callExpectJson<api.WebhookDeliveryDetail>(
      retryKey,
      'GET',
      `/api/v1/webhooks/deliveries/${target.id}`,
    );
    expect(detail.body.delivery.status).toBe('failed');
    expect(detail.body.delivery.attempts).toBe(3);
    expect(detail.body.attempts).toHaveLength(3);
    for (const attempt of detail.body.attempts) {
      expect(attempt.outcome).toBe('transient_failure');
      expect(attempt.statusCode).toBe(500);
    }
    expect(detail.body.delivery.lastStatusCode).toBe(500);
  });

  it('fails terminally on subscriber rejection (non-transient 4xx)', async () => {
    const created = await callExpectJson<api.WebhookSubscription>(
      retryKey,
      'POST',
      '/api/v1/webhooks',
      {
        body: {
          label: 'rejecting-listener',
          url: 'https://hooks.example.com/rejecting',
          eventTypes: ['api.operation'],
        },
      },
    );
    await call(retryKey, 'GET', '/api/v1/goals');
    const deliveries = await callExpectJson<{ items: api.WebhookDelivery[] }>(
      retryKey,
      'GET',
      `/api/v1/webhooks/${created.body.id}/deliveries`,
    );
    const target = deliveries.body.items[0]!;

    transportBehavior = () => ({ ok: false, statusCode: 410, latencyMs: 2 });
    const dispatch = await callExpectJson<api.DispatchWebhookDeliveriesResult>(
      retryKey,
      'POST',
      '/api/v1/webhooks/dispatch',
      { body: { limit: 10 } },
    );
    const outcome = dispatch.body.dispatched.find((item) => item.deliveryId === target.id);
    expect(outcome?.outcome).toBe('failed');

    const detail = await callExpectJson<api.WebhookDeliveryDetail>(
      retryKey,
      'GET',
      `/api/v1/webhooks/deliveries/${target.id}`,
    );
    expect(detail.body.delivery.status).toBe('failed');
    expect(detail.body.attempts).toHaveLength(1);
    expect(detail.body.attempts[0]!.outcome).toBe('terminal_failure');
  });

  it('classifies a throwing transport as a transient (retryable) failure', async () => {
    const created = await callExpectJson<api.WebhookSubscription>(
      retryKey,
      'POST',
      '/api/v1/webhooks',
      {
        body: {
          label: 'throwing-listener',
          url: 'https://hooks.example.com/throwing',
          eventTypes: ['api.operation'],
          maxAttempts: 2,
        },
      },
    );
    await call(retryKey, 'GET', '/api/v1/goals');
    const deliveries = await callExpectJson<{ items: api.WebhookDelivery[] }>(
      retryKey,
      'GET',
      `/api/v1/webhooks/${created.body.id}/deliveries`,
    );
    const target = deliveries.body.items[0]!;

    const throwing: api.WebhookTransport = {
      deliver: async () => {
        throw new Error('socket hang up');
      },
    };
    api.setApiWebhookTransport(throwing);
    const dispatch = await callExpectJson<api.DispatchWebhookDeliveriesResult>(
      retryKey,
      'POST',
      '/api/v1/webhooks/dispatch',
      { body: { limit: 10 } },
    );
    const outcome = dispatch.body.dispatched.find((item) => item.deliveryId === target.id);
    expect(outcome?.outcome).toBe('retrying');

    const detail = await callExpectJson<api.WebhookDeliveryDetail>(
      retryKey,
      'GET',
      `/api/v1/webhooks/deliveries/${target.id}`,
    );
    expect(detail.body.attempts[0]!.outcome).toBe('transient_failure');
    expect(detail.body.attempts[0]!.statusCode).toBeNull();
    expect(detail.body.delivery.lastError).toContain('socket hang up');
    api.setApiWebhookTransport(fakeTransport);
  });

  it('keeps delivery attempts append-only at the storage level', async () => {
    // Bypassing the service must not allow rewriting attempt evidence.
    await expect(
      getDb().query(`UPDATE api_webhook_delivery_attempts SET outcome = 'succeeded'`),
    ).rejects.toThrow(/append-only/);
    await expect(getDb().query(`DELETE FROM api_webhook_delivery_attempts`)).rejects.toThrow(
      /append-only/,
    );
  });
});

// (mission types are imported at the top; this file has no trailing imports)
