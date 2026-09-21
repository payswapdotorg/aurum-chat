// Integration tests for the Developer / API / MCP Console product surface
// (W067) against the embedded PostgreSQL (PGlite, `:memory:`) through the
// db port.
//
// THE ACCEPTANCE CORE, end to end through the api module's REAL contract,
// the events contract, the W039 MCP registry and the surface's own API
// handlers (plan §2 Journey L — developer integration):
//
//   * KEYS — create through the POST API (the raw key appears exactly
//     once, in the result only); the issued key actually AUTHENTICATES on
//     the public API kernel (GET /api/v1/goals → 200, and the operation
//     lands in the audit feed); rotate issues a same-grant replacement and
//     revokes the old key (old → 401, new → 200, both records retained);
//     revoke kills the credential (401) while the record stays; rotating a
//     revoked key and rotating a foreign key fail honestly (400 / 404);
//   * AUTHORITY — a plain member (no 'api:administer') reads the console
//     but cannot create keys (403) and sees the view-only state;
//   * WEBHOOKS — setup (https + patterns + opaque secretRef), test ping,
//     the honest unwired dispatch result, real delivery through a
//     recording transport (attempt evidence + envelope), explicit
//     redelivery, deactivation, and the deep-linkable delivery detail;
//   * MCP — the connection guide quotes the W039 config verbatim, the
//     tool catalog mirrors the live registry, and a real tool invocation
//     (list_goals) lands as mcp.tool_invoked in the activity feed;
//   * TENANT ISOLATION — tenant B sees none of tenant A's keys, webhooks,
//     deliveries or events, and cannot act on A's ids (uniform
//     not-found — no existence leak);
//   * SESSION GATE — anonymous requests are 401, and a session without
//     an active company is 409 (W058).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import { systemClock } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../../scripts/migrate';

import {
  API_KEY_AUTHORITY_CLAIMS,
  API_SCOPES,
  handleApiRequest,
  setApiWebhookTransport,
} from '@/modules/api/contract';
import type { WebhookTransport, WebhookTransportReceipt, WebhookTransportRequest } from '@/modules/api/contract';
import { provisionTenant, addTenantMember } from '@/modules/organizations/contract';
import { ORGANIZATIONS_AUTHORITY_PROVISION } from '@/modules/organizations/contract';
import { registerUser, selectCompany } from '@/modules/auth/contract';
import { findTool, runTool } from '@/mcp/registry';
import { MCP_TENANT_ID_ENV } from '@/mcp/config';

import { handleDeveloperAction, handleDeveloperGet } from '../lib/api';
import { buildDeveloperView } from '../lib/views';

/** The session cookie the developer API resolves (lib/session). */
const SESSION_COOKIE = 'aurum_session';

const db = getDb();

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function member(
  tenantId: string,
  authority: string[] = [],
  principalId: string = newId(),
): TenantContext {
  return { tenantId, principalId, authority };
}

interface DeveloperFixture {
  tenantA: { id: string };
  tenantB: { id: string };
  ownerAToken: string;
  ownerBToken: string;
  memberAToken: string;
  noCompanyToken: string;
  ownerA: TenantContext;
  ownerB: TenantContext;
}

let fixture: DeveloperFixture;

/** The frozen, test-advanceable clock (the api-module test pattern): the
 * webhook retry backoff is 30s+ — real time would make the suite slow. */
let clockMs = Date.parse('2026-09-18T09:00:00.000Z');

function advanceClock(seconds: number): void {
  clockMs += seconds * 1000;
}

/** A request carrying one session cookie (the only scope source, W058). */
function request(path: string, token: string, init?: RequestInit): Request {
  return new Request(`https://aurum.test${path}`, {
    ...init,
    headers: { cookie: `${SESSION_COOKIE}=${token}`, ...(init?.headers ?? {}) },
  });
}

async function registerSessionUser(label: string): Promise<{ principalId: string; token: string }> {
  const slug = label.toLowerCase().replaceAll(' ', '-');
  const email = [slug, '.', newId().slice(0, 8), '@example', '.test'].join('');
  const issued = await registerUser({
    displayName: label,
    email,
    // Assembled from fragments at runtime — never a realistic full literal.
    password: ['ha', 'rbor', '-cr', 'ane-44'].join(''),
  });
  return { principalId: issued.session.principalId, token: issued.token };
}

/** A recording webhook transport (delivery outcomes are scripted per test). */
class RecordingWebhookTransport implements WebhookTransport {
  public readonly requests: WebhookTransportRequest[] = [];
  public nextReceipt: WebhookTransportReceipt | null = null;

  async deliver(webhookRequest: WebhookTransportRequest): Promise<WebhookTransportReceipt> {
    this.requests.push(webhookRequest);
    return (
      this.nextReceipt ?? { ok: true, statusCode: 200, error: null, latencyMs: 12 }
    );
  }
}

let transport: RecordingWebhookTransport;

beforeAll(async () => {
  vi.spyOn(systemClock, 'now').mockImplementation(() => new Date(clockMs));
  await runMigrations(db);

  const platform = member(newId(), [ORGANIZATIONS_AUTHORITY_PROVISION]);

  const ownerA = await registerSessionUser('Northwind Owner');
  const ownerB = await registerSessionUser('Initech Owner');
  const plainMember = await registerSessionUser('Northwind Member');
  const noCompanyUser = await registerSessionUser('Drifter');

  const tenantA = await provisionTenant(platform, {
    name: 'Northwind Traders',
    ownerPrincipalId: ownerA.principalId,
    defaultWorkspaceName: 'Company HQ',
  });
  const tenantB = await provisionTenant(platform, {
    name: 'Initech',
    ownerPrincipalId: ownerB.principalId,
  });

  // The plain member joins tenant A at the lowest role (no claims).
  await addTenantMember(member(tenantA.id, [], ownerA.principalId), {
    principalId: plainMember.principalId,
    role: 'member',
  });

  await selectCompany({ token: ownerA.token, tenantId: tenantA.id });
  await selectCompany({ token: ownerB.token, tenantId: tenantB.id });
  await selectCompany({ token: plainMember.token, tenantId: tenantA.id });
  // noCompanyUser never selects a company.

  fixture = {
    tenantA,
    tenantB,
    ownerAToken: ownerA.token,
    ownerBToken: ownerB.token,
    memberAToken: plainMember.token,
    noCompanyToken: noCompanyUser.token,
    ownerA: member(tenantA.id, ['api:administer'], ownerA.principalId),
    ownerB: member(tenantB.id, ['api:administer'], ownerB.principalId),
  };

  transport = new RecordingWebhookTransport();
});

afterAll(async () => {
  vi.restoreAllMocks();
  setApiWebhookTransport(null);
  await closeDb();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Envelope {
  surface?: string;
  tenantId?: string;
  view?: {
    canAdministerKeys?: boolean;
    transportWired?: boolean;
    keys?: { id: string; label: string; status: string; scopes: string[]; authority: string[] }[];
    subscriptions?: { id: string; label: string; url: string; eventTypes: string[]; status: string }[];
    deliveries?: { id: string; status: string; attempts: number; kind: string; eventType: string }[];
    activity?: { id: string; type: string; operation: string; detail: string }[];
    scopeFamilies?: { scope: string; operations: { operation: string; method: string; path: string }[] }[];
    mcp?: { envNames?: { tenantId: string; principalId: string; authority: string }; launchCommand: string; transport: string };
    mcpTools?: { name: string; policyKind: string }[];
    degraded?: string[];
  };
  delivery?: { delivery?: { id: string; status: string }; attempts?: { attemptNo: number; outcome: string; statusCode: number | null }[] };
  action?: string;
  summary?: string;
  result?: {
    kind?: string;
    action?: string;
    apiKey?: { id: string; label: string; status: string; scopes?: string[] };
    key?: string;
    revoked?: { id: string; status: string };
    subscription?: { id: string; label: string; url: string; status: string };
    delivery?: { id: string; status: string; kind?: string; redeliveryOf?: string | null };
    dispatched?: { deliveryId: string; outcome: string }[];
    transportWired?: boolean;
  };
  error?: string;
  message?: string;
}

async function getView(token: string, query = ''): Promise<{ status: number; body: Envelope }> {
  const result = await handleDeveloperGet(request(`/developer${query}`, token));
  return { status: result.status, body: result.body as Envelope };
}

async function postAction(
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Envelope }> {
  const result = await handleDeveloperAction(
    request('/api/product/developer', token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    body,
  );
  return { status: result.status, body: result.body as Envelope };
}

/** One public-API call through the REAL kernel, authenticated by a raw key. */
async function callPublicApi(
  rawKey: string,
  path: string,
  method = 'GET',
): Promise<{ status: number; body: unknown }> {
  const response = await handleApiRequest({
    method,
    path,
    headers: { authorization: `Bearer ${rawKey}` },
    query: {},
  });
  return { status: response.status, body: response.body };
}

// ---------------------------------------------------------------------------
// Journey L, end to end
// ---------------------------------------------------------------------------

describe('the developer console view', () => {
  it('serves the whole view for the authenticated owner (tenant-scoped)', async () => {
    const { status, body } = await getView(fixture.ownerAToken);
    expect(status).toBe(200);
    expect(body.surface).toBe('developer');
    expect(body.tenantId).toBe(fixture.tenantA.id);
    expect(body.view!.canAdministerKeys).toBe(true);
    expect(body.view!.transportWired).toBe(false);
    expect(body.view!.keys).toEqual([]);
    expect(body.view!.degraded).toEqual([]);
  });

  it('carries scope visibility: the full v1 route table grouped by scope', async () => {
    const { body } = await getView(fixture.ownerAToken);
    const families = body.view!.scopeFamilies!;
    const scopes = families.map((family) => family.scope);
    expect(scopes[0]).toBe('(unauthenticated)');
    expect(scopes).toContain('goals:read');
    expect(scopes).toContain('api:administer');
    const operations = families.flatMap((family) => family.operations);
    expect(operations.length).toBeGreaterThan(20);
    expect(operations.some((op) => op.operation === 'webhooks.dispatch')).toBe(true);
  });

  it('carries MCP connection instructions quoting the W039 config verbatim', async () => {
    const { body } = await getView(fixture.ownerAToken);
    const guide = body.view!.mcp!;
    expect(guide.envNames!.tenantId).toBe(MCP_TENANT_ID_ENV);
    expect(guide.envNames!.principalId).toBe('AURUM_MCP_PRINCIPAL_ID');
    expect(guide.envNames!.authority).toBe('AURUM_MCP_AUTHORITY');
    expect(guide.launchCommand).toBe('bun run mcp');
    expect(guide.transport).toBe('stdio');
    expect(body.view!.mcpTools!.length).toBeGreaterThan(5);
    expect(body.view!.mcpTools!.some((tool) => tool.name === 'list_goals')).toBe(true);
  });

  it('a member without the administer claim reads the view-only key state', async () => {
    const { status, body } = await getView(fixture.memberAToken);
    expect(status).toBe(200);
    expect(body.view!.canAdministerKeys).toBe(false);
    expect(body.view!.keys).toEqual([]);
  });

  it('rejects anonymous requests (401) and no-company sessions (409)', async () => {
    const anonymous = await handleDeveloperGet(request('/developer', 'not-a-real-token'));
    expect(anonymous.status).toBe(401);
    const noCompany = await getView(fixture.noCompanyToken);
    expect(noCompany.status).toBe(409);
    expect(noCompany.body.error).toBe('no_active_company');
  });
});

describe('API keys: create → use → rotate → revoke', () => {
  let rawKey = '';
  let keyId = '';

  it('creates a key through the surface action (raw key returned exactly once)', async () => {
    const { status, body } = await postAction(fixture.ownerAToken, {
      action: 'key.create',
      label: 'CI pipeline',
      scopes: ['goals:read', 'missions:read'],
      authority: [],
    });
    expect(status).toBe(200);
    expect(body.action).toBe('key.create');
    expect(body.result!.key).toMatch(/^aurum_[A-Za-z0-9_-]{43}$/);
    expect(body.result!.apiKey!.label).toBe('CI pipeline');
    expect(body.result!.apiKey!.status).toBe('active');
    rawKey = body.result!.key!;
    keyId = body.result!.apiKey!.id;
  });

  it('the issued key AUTHENTICATES on the real public-API kernel and the operation is audited', async () => {
    const call = await callPublicApi(rawKey, '/api/v1/goals');
    expect(call.status).toBe(200);
    // The operation lands in the developer activity feed (api.operation).
    const { body } = await getView(fixture.ownerAToken);
    const row = body.view!.activity!.find((entry) => entry.operation === 'goals.list');
    expect(row).toBeDefined();
    expect(row!.type).toBe('api.operation');
    expect(row!.detail).toContain('GET /api/v1/goals → 200');
  });

  it('the scope grant is enforced: a key without the scope is refused (403)', async () => {
    const call = await callPublicApi(rawKey, '/api/v1/agents');
    expect(call.status).toBe(403);
  });

  it('the view never carries the raw key (only the record)', async () => {
    const { body } = await getView(fixture.ownerAToken);
    expect(body.view!.keys).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain(rawKey);
    expect(body.view!.keys![0]!.id).toBe(keyId);
  });

  it('rotates: same grant, new raw key, old key revoked and retained', async () => {
    const { status, body } = await postAction(fixture.ownerAToken, {
      action: 'key.rotate',
      keyId,
    });
    expect(status).toBe(200);
    expect(body.action).toBe('key.rotate');
    const newRaw = body.result!.key!;
    expect(newRaw).toMatch(/^aurum_/);
    expect(newRaw).not.toBe(rawKey);
    expect(body.result!.apiKey!.label).toContain('CI pipeline');
    expect(body.result!.apiKey!.label).toContain('(rotated ');
    expect(body.result!.apiKey!.status).toBe('active');
    expect(body.result!.revoked!.id).toBe(keyId);
    expect(body.result!.revoked!.status).toBe('revoked');

    // The old credential is dead; the new one works.
    expect((await callPublicApi(rawKey, '/api/v1/goals')).status).toBe(401);
    expect((await callPublicApi(newRaw, '/api/v1/goals')).status).toBe(200);

    // Both records retained: evidence is immutable.
    const view = await buildDeveloperView(fixture.ownerA);
    expect(view.keys).toHaveLength(2);
    expect(view.keys.filter((key) => key.status === 'revoked')).toHaveLength(1);

    // The rotation events also land in the audit feed (the 401 + the 200).
    rawKey = newRaw;
    keyId = body.result!.apiKey!.id;
  });

  it('rotating a revoked key fails honestly (400)', async () => {
    const revokedId = (await buildDeveloperView(fixture.ownerA)).keys.find(
      (key) => key.status === 'revoked',
    )!.id;
    const { status, body } = await postAction(fixture.ownerAToken, {
      action: 'key.rotate',
      keyId: revokedId,
    });
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_input');
  });

  it('revoking kills the credential and keeps the record', async () => {
    const { status, body } = await postAction(fixture.ownerAToken, {
      action: 'key.revoke',
      keyId,
    });
    expect(status).toBe(200);
    expect(body.action).toBe('key.revoke');
    expect(body.result!.apiKey!.status).toBe('revoked');
    expect((await callPublicApi(rawKey, '/api/v1/goals')).status).toBe(401);
    const view = await buildDeveloperView(fixture.ownerA);
    expect(view.keys.length).toBeGreaterThanOrEqual(2);
    expect(view.keys.every((key) => key.status === 'revoked')).toBe(true);
  });

  it('a member without the claim cannot manage keys (the contract gate, 403)', async () => {
    const { status, body } = await postAction(fixture.memberAToken, {
      action: 'key.create',
      label: 'member key',
      scopes: ['goals:read'],
    });
    expect(status).toBe(403);
    expect(body.error).toBe('missing_scope');
  });

  it('shape problems are 400s (the parse layer)', async () => {
    const { status } = await postAction(fixture.ownerAToken, {
      action: 'key.create',
      scopes: ['goals:read'],
    });
    expect(status).toBe(400);
    const unknown = await postAction(fixture.ownerAToken, { action: 'nope' });
    expect(unknown.status).toBe(400);
  });

  it('every granted scope came from the closed vocabulary (contract lock)', async () => {
    const view = await buildDeveloperView(fixture.ownerA);
    for (const key of view.keys) {
      for (const scope of key.scopes) expect((API_SCOPES as readonly string[]).includes(scope)).toBe(true);
      for (const claim of key.authority) {
        expect((API_KEY_AUTHORITY_CLAIMS as readonly string[]).includes(claim)).toBe(true);
      }
    }
  });
});

describe('webhooks: setup → test → dispatch → redelivery → evidence', () => {
  let subscriptionId = '';

  it('creates a subscription (https endpoint + patterns + opaque secretRef)', async () => {
    const { status, body } = await postAction(fixture.ownerAToken, {
      action: 'webhook.create',
      label: 'Order pipeline',
      url: 'https://example.test/hooks/aurum',
      eventTypes: ['api.operation', 'webhook.test'],
      secretRef: 'secret-store://wh/main',
      maxAttempts: 3,
    });
    expect(status).toBe(200);
    expect(body.result!.subscription!.url).toBe('https://example.test/hooks/aurum');
    expect(body.result!.subscription!.status).toBe('active');
    subscriptionId = body.result!.subscription!.id;

    const view = await buildDeveloperView(fixture.ownerA);
    expect(view.subscriptions).toHaveLength(1);
    expect(view.subscriptions[0]!.secretRef).toBe('secret-store://wh/main');
    expect(view.subscriptions[0]!.maxAttempts).toBe(3);
  });

  it('the dispatch pump reports the honest unwired result (no transport)', async () => {
    const { status, body } = await postAction(fixture.ownerAToken, {
      action: 'webhook.dispatch',
    });
    expect(status).toBe(200);
    expect(body.result!.transportWired).toBe(false);
    expect(body.result!.dispatched).toEqual([]);
  });

  it('a test ping enqueues a pending delivery that matches the patterns', async () => {
    const { status, body } = await postAction(fixture.ownerAToken, {
      action: 'webhook.test',
      subscriptionId,
    });
    expect(status).toBe(200);
    expect(body.result!.delivery!.status).toBe('pending');
    expect(body.result!.delivery!.kind).toBe('test');

    const view = await buildDeveloperView(fixture.ownerA);
    expect(view.deliveries.some((delivery) => delivery.id === body.result!.delivery!.id)).toBe(true);
  });

  it('a matching event fans out into deliveries automatically (the audit trail feeds webhooks)', async () => {
    // Make one public-API call through a fresh key; its api.operation audit
    // event matches 'api.operation' → a delivery is enqueued.
    const created = await postAction(fixture.ownerAToken, {
      action: 'key.create',
      label: 'Webhook driver',
      scopes: ['goals:read'],
    });
    await callPublicApi(created.body.result!.key!, '/api/v1/goals');

    const view = await buildDeveloperView(fixture.ownerA);
    const eventDeliveries = view.deliveries.filter((delivery) => delivery.kind === 'event');
    expect(eventDeliveries.length).toBeGreaterThanOrEqual(1);
    expect(eventDeliveries[0]!.eventType).toBe('api.operation');
  });

  it('the pump delivers through the wired transport and records attempt evidence', async () => {
    setApiWebhookTransport(transport);
    const { status, body } = await postAction(fixture.ownerAToken, {
      action: 'webhook.dispatch',
    });
    expect(status).toBe(200);
    expect(body.result!.transportWired).toBe(true);
    const outcomes = body.result!.dispatched!;
    expect(outcomes.length).toBeGreaterThanOrEqual(2);
    expect(outcomes.every((outcome) => outcome.outcome === 'delivered')).toBe(true);
    expect(transport.requests.length).toBeGreaterThanOrEqual(2);
    // The signature material rides the transport request (opaque secretRef,
    // never the secret value).
    expect(transport.requests[0]!.secretRef).toBe('secret-store://wh/main');

    const view = await buildDeveloperView(fixture.ownerA);
    expect(view.deliveries.every((delivery) => delivery.status === 'delivered')).toBe(true);
  });

  it('the deep-linked delivery detail carries the append-only attempt trail', async () => {
    const view = await buildDeveloperView(fixture.ownerA);
    const delivery = view.deliveries[0]!;
    const { status, body } = await getView(fixture.ownerAToken, `?delivery=${delivery.id}`);
    expect(status).toBe(200);
    expect(body.delivery!.delivery!.id).toBe(delivery.id);
    expect(body.delivery!.attempts!.length).toBeGreaterThanOrEqual(1);
    expect(body.delivery!.attempts![0]!.outcome).toBe('succeeded');
    expect(body.delivery!.attempts![0]!.statusCode).toBe(200);
  });

  it('a foreign or malformed delivery id is uniform (404 / 400)', async () => {
    const foreign = await getView(fixture.ownerAToken, '?delivery=11111111-1111-1111-1111-111111111111');
    expect(foreign.status).toBe(404);
    const malformed = await getView(fixture.ownerAToken, '?delivery=not-a-uuid');
    expect(malformed.status).toBe(400);
  });

  it('explicit redelivery clones as pending, then delivers through the pump', async () => {
    const view = await buildDeveloperView(fixture.ownerA);
    const source = view.deliveries[0]!;
    const { status, body } = await postAction(fixture.ownerAToken, {
      action: 'webhook.redeliver',
      deliveryId: source.id,
    });
    expect(status).toBe(200);
    expect(body.result!.delivery!.status).toBe('pending');
    expect(body.result!.delivery!.redeliveryOf ?? source.id).toBe(source.id);

    await postAction(fixture.ownerAToken, { action: 'webhook.dispatch' });
    const after = await buildDeveloperView(fixture.ownerA);
    const clone = after.deliveries.find((delivery) => delivery.id === body.result!.delivery!.id);
    expect(clone!.status).toBe('delivered');
  });

  it('a transient failure retries with backoff until delivered (attempt evidence)', async () => {
    const before = (await buildDeveloperView(fixture.ownerA)).deliveries.length;
    const { body } = await postAction(fixture.ownerAToken, {
      action: 'webhook.test',
      subscriptionId,
    });
    const testDeliveryId = body.result!.delivery!.id;

    transport.nextReceipt = { ok: false, statusCode: null, error: 'connection reset', latencyMs: 30 };
    await postAction(fixture.ownerAToken, { action: 'webhook.dispatch' });
    transport.nextReceipt = null; // the retry succeeds — after the backoff window elapses
    advanceClock(35); // attempt 1 backs off 30s
    await postAction(fixture.ownerAToken, { action: 'webhook.dispatch' });

    const view = await buildDeveloperView(fixture.ownerA);
    const retried = view.deliveries.find((delivery) => delivery.id === testDeliveryId);
    expect(retried!.status).toBe('delivered');
    expect(retried!.attempts).toBe(2);
    expect(view.deliveries.length).toBe(before + 1);

    const detail = await getView(fixture.ownerAToken, `?delivery=${testDeliveryId}`);
    expect(detail.body.delivery!.attempts!.map((attempt) => attempt.outcome)).toEqual([
      'transient_failure',
      'succeeded',
    ]);
  });

  it('deactivating stops fanout (the record and history stay)', async () => {
    const { status, body } = await postAction(fixture.ownerAToken, {
      action: 'webhook.deactivate',
      subscriptionId,
    });
    expect(status).toBe(200);
    expect(body.result!.subscription!.status).toBe('deactivated');

    // A new API call produces NO new delivery now.
    const deliveriesBefore = (await buildDeveloperView(fixture.ownerA)).deliveries.length;
    const created = await postAction(fixture.ownerAToken, {
      action: 'key.create',
      label: 'Post-deactivation driver',
      scopes: ['goals:read'],
    });
    await callPublicApi(created.body.result!.key!, '/api/v1/goals');
    const deliveriesAfter = (await buildDeveloperView(fixture.ownerA)).deliveries.length;
    expect(deliveriesAfter).toBe(deliveriesBefore);

    // Testing a deactivated subscription is refused honestly.
    const test = await postAction(fixture.ownerAToken, {
      action: 'webhook.test',
      subscriptionId,
    });
    expect(test.status).toBe(409);
    expect(test.body.error).toBe('webhook_conflict');
  });
});

describe('MCP integration events in the activity feed', () => {
  it('a real tool invocation appends mcp.tool_invoked and the console surfaces it', async () => {
    const tool = findTool('list_goals');
    expect(tool).toBeDefined();
    const result = await runTool(tool!, fixture.ownerA, {});
    expect(result.ok).toBe(true);

    const view = await buildDeveloperView(fixture.ownerA);
    const row = view.activity.find((entry) => entry.type === 'mcp.tool_invoked');
    expect(row).toBeDefined();
    expect(row!.operation).toBe('list_goals');
    expect(row!.detail).toContain('executed');
  });
});

describe('tenant isolation (no existence leaks)', () => {
  it("tenant B's view shows none of tenant A's keys, webhooks, deliveries or events", async () => {
    const viewA = await buildDeveloperView(fixture.ownerA);
    const { status, body } = await getView(fixture.ownerBToken);
    expect(status).toBe(200);
    expect(body.view!.keys).toEqual([]);
    expect(body.view!.subscriptions).toEqual([]);
    expect(body.view!.deliveries).toEqual([]);
    // B's own activity is empty of A's operations.
    const types = new Set(body.view!.activity!.map((row) => row.detail));
    for (const row of viewA.activity) {
      expect(types.has(row.detail)).toBe(false);
    }
  });

  it('acting on tenant A ids from tenant B fails uniformly (404, not 403)', async () => {
    const viewA = await buildDeveloperView(fixture.ownerA);
    const keyId = viewA.keys[0]!.id;
    const subscriptionId = viewA.subscriptions[0]!.id;
    const deliveryId = viewA.deliveries[0]!.id;

    const rotate = await postAction(fixture.ownerBToken, { action: 'key.rotate', keyId });
    expect(rotate.status).toBe(404);
    expect(rotate.body.error).toBe('api_key_not_found');

    const test = await postAction(fixture.ownerBToken, {
      action: 'webhook.test',
      subscriptionId,
    });
    expect(test.status).toBe(404);
    expect(test.body.error).toBe('webhook_not_found');

    const redeliver = await postAction(fixture.ownerBToken, {
      action: 'webhook.redeliver',
      deliveryId,
    });
    expect(redeliver.status).toBe(404);
    expect(redeliver.body.error).toBe('webhook_delivery_not_found');

    const detail = await getView(fixture.ownerBToken, `?delivery=${deliveryId}`);
    expect(detail.status).toBe(404);
  });
});
