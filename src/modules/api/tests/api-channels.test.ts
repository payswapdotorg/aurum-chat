// Integration + unit tests for the v1 public API's channel-family
// operations (W103 — the J16 unblock): the four connection-management
// routes surfaced from the channels module's contract (W030/W059).
//
// Mirrors the api-service.test.ts harness (embedded PostgreSQL via
// PGlite `:memory:`, the FULL kernel pipeline through handleApiRequest)
// and covers the work item's acceptance:
//
//   * ROUTE TABLE: the new rows match (method, segments) exactly, params
//     capture, wrong methods report 405 with the allowed list, unknown
//     neighbors 404 — and the matcher's static-beats-captures discipline
//     leaves headroom for future statics under /channels.
//   * DISCOVERY: the discovery document carries the four operations and
//     the channels scope family (the count grows WITH the table — locked
//     to API_ROUTES, never a magic number).
//   * HANDLERS (thin delegation, lock 31): HTTP shapes translate into
//     contract inputs; happy paths register (idempotently), list, read
//     and flip status through the channels contract; every domain rule
//     (validation, provider normalization, tenancy) stays in the module.
//   * ERROR MAPPING: ChannelsError kinds surface as proper HTTP statuses
//     (invalid_channel_input/query → 400, connection_not_found → 404,
//     invalid_body → 400) without leaking internals.
//   * SCOPE ENFORCEMENT: a key without 'channels:read'/'channels:write'
//     is rejected with missing_scope naming the required scope.
//   * TENANCY ISOLATION (ADR-0001): another tenant's connections are
//     indistinguishable from missing ones across list/get/status.
//   * AUDIT (lock 32): channel operations append api.operation events
//     attributed to the key's principal.
//   * STORAGE SYNC: the api_keys scopes CHECK constraint (extended by
//     migrations/003-api-channels-scopes.sql) accepts the channels
//     family — keys holding the new scopes issue and authenticate.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { systemClock } from '@/infra/clock';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../scripts/migrate';
import * as api from '../contract';
import * as events from '@/modules/events/contract';
import * as organizations from '@/modules/organizations/contract';
import type * as channels from '@/modules/channels/contract';
import { API_ROUTES, buildDiscoveryDocument, matchApiRoute } from '../routes';
import { API_SCOPES, parseScopeGrant } from '../scopes';

const { handleApiRequest } = api;

// --- tenants, principals, contexts, keys -----------------------------------

const platform: organizations.PlatformContext = { principalId: newId(), authority: ['organizations:provision'] };

let tenantMain: organizations.Tenant;
let tenantIso: organizations.Tenant;

const ownerMain = newId();
const ownerIso = newId();

let channelsKey = ''; // channels:read + channels:write (tenantMain)
let channelsReadKey = ''; // channels:read only (tenantMain)
let goalsKey = ''; // goals:read only (tenantMain) — no channels scopes
let isoChannelsKey = ''; // channels:read + channels:write (tenantIso)

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

const CONNECTION_UUID = '33333333-3333-4333-8333-333333333333';

beforeAll(async () => {
  vi.spyOn(systemClock, 'now').mockImplementation(() => new Date('2026-09-27T12:00:00.000Z'));
  await runMigrations(getDb());

  tenantMain = await organizations.provisionTenant(platform, {
    name: 'Channels Co',
    ownerPrincipalId: ownerMain,
  });
  tenantIso = await organizations.provisionTenant(platform, {
    name: 'Channels Iso Co',
    ownerPrincipalId: ownerIso,
  });

  channelsKey = (
    await api.createApiKey(adminCtx(tenantMain.id, ownerMain), {
      label: 'channels-manager',
      scopes: ['channels:read', 'channels:write'],
    })
  ).key;
  channelsReadKey = (
    await api.createApiKey(adminCtx(tenantMain.id, ownerMain), {
      label: 'channels-readonly',
      scopes: ['channels:read'],
    })
  ).key;
  goalsKey = (
    await api.createApiKey(adminCtx(tenantMain.id, ownerMain), {
      label: 'goals-only',
      scopes: ['goals:read'],
    })
  ).key;
  isoChannelsKey = (
    await api.createApiKey(adminCtx(tenantIso.id, ownerIso), {
      label: 'iso-channels',
      scopes: ['channels:read', 'channels:write'],
    })
  ).key;
});

afterAll(async () => {
  vi.restoreAllMocks();
  await closeDb();
});

// ---------------------------------------------------------------------------
// The route table: matching discipline for the channel family
// ---------------------------------------------------------------------------

describe('W103 channel routes: table matching', () => {
  it('matches the four channel operations with param capture', () => {
    expect(matchApiRoute('GET', ['channels'])).toMatchObject({
      kind: 'matched',
      spec: { operation: 'channels.list', scope: 'channels:read' },
    });
    expect(matchApiRoute('GET', ['channels', CONNECTION_UUID])).toMatchObject({
      kind: 'matched',
      spec: { operation: 'channels.get', scope: 'channels:read' },
      params: { connectionId: CONNECTION_UUID },
    });
    expect(matchApiRoute('POST', ['channels'])).toMatchObject({
      kind: 'matched',
      spec: { operation: 'channels.register', scope: 'channels:write', successStatus: 201 },
    });
    expect(matchApiRoute('PATCH', ['channels', CONNECTION_UUID, 'status'])).toMatchObject({
      kind: 'matched',
      spec: { operation: 'channels.status', scope: 'channels:write' },
      params: { connectionId: CONNECTION_UUID },
    });
  });

  it('captures any single segment under /channels (headroom for future statics)', () => {
    // A capture swallows every non-static segment today; the matcher's
    // fewest-parameters rule (the /webhooks/dispatch precedent) will make
    // any FUTURE static sibling win automatically once it joins the table.
    const unknownDeep = matchApiRoute('GET', ['channels', 'x', 'extra']);
    expect(unknownDeep).toMatchObject({ kind: 'not_found' }); // 3 segments beyond status: no such path
    const statusPath = matchApiRoute('GET', ['channels', 'x', 'status']);
    expect(statusPath).toEqual({ kind: 'method_not_allowed', allowed: ['PATCH'] }); // PATCH owns it
    const one = matchApiRoute('GET', ['channels', 'not-a-uuid-either']);
    expect(one).toMatchObject({
      kind: 'matched',
      spec: { operation: 'channels.get' },
      params: { connectionId: 'not-a-uuid-either' },
    });
  });

  it('reports method_not_allowed with the allowed methods', () => {
    expect(matchApiRoute('PUT', ['channels'])).toEqual({
      kind: 'method_not_allowed',
      allowed: ['GET', 'POST'],
    });
    expect(matchApiRoute('DELETE', ['channels', CONNECTION_UUID, 'status'])).toEqual({
      kind: 'method_not_allowed',
      allowed: ['PATCH'],
    });
    expect(matchApiRoute('POST', ['channels', CONNECTION_UUID])).toEqual({
      kind: 'method_not_allowed',
      allowed: ['GET'],
    });
  });

  it('adds the four rows without touching any existing row (additive-only)', () => {
    // The pre-W103 surface is intact: every operation id that existed
    // before the channel family still maps to exactly one row, and the
    // four new ids are new (no renames, no removals, no duplicates).
    const rows = new Set(API_ROUTES.map((route) => `${route.method} ${route.segments.join('/')}`));
    expect(rows.size).toBe(API_ROUTES.length);
    const operations = new Set(API_ROUTES.map((route) => route.operation));
    expect(operations.size).toBe(API_ROUTES.length);
    for (const operation of [
      'discovery',
      'goals.list',
      'missions.create',
      'webhooks.fanout',
      'apiKeys.revoke',
    ]) {
      expect(operations.has(operation)).toBe(true);
    }
    for (const operation of ['channels.list', 'channels.get', 'channels.register', 'channels.status']) {
      expect(operations.has(operation)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Discovery: the document carries the channel family
// ---------------------------------------------------------------------------

describe('W103 channel routes: discovery document', () => {
  it('lists the four channel operations with their scopes', () => {
    const document = buildDiscoveryDocument();
    const byOperation = new Map(document.operations.map((operation) => [operation.operation, operation]));
    expect(byOperation.get('channels.list')).toMatchObject({
      method: 'GET',
      path: '/api/v1/channels',
      scope: 'channels:read',
    });
    expect(byOperation.get('channels.get')).toMatchObject({
      method: 'GET',
      path: '/api/v1/channels/:connectionId',
      scope: 'channels:read',
    });
    expect(byOperation.get('channels.register')).toMatchObject({
      method: 'POST',
      path: '/api/v1/channels',
      scope: 'channels:write',
    });
    expect(byOperation.get('channels.status')).toMatchObject({
      method: 'PATCH',
      path: '/api/v1/channels/:connectionId/status',
      scope: 'channels:write',
    });
    // The count grows WITH the table (49 → 53), never pinned to a number.
    expect(document.operations).toHaveLength(API_ROUTES.length);
  });

  it('carries the channels scope family in the closed vocabulary', () => {
    expect(API_SCOPES).toContain('channels:read');
    expect(API_SCOPES).toContain('channels:write');
    expect(buildDiscoveryDocument().scopes).toEqual([...API_SCOPES]);
    expect(parseScopeGrant(['channels:read', 'channels:write'])).toEqual([
      'channels:read',
      'channels:write',
    ]);
  });

  it('serves the channel operations in the unauthenticated discovery doc', async () => {
    const { status, body } = await callExpectJson<api.ApiDiscoveryDocument>(null, 'GET', '/api/v1');
    expect(status).toBe(200);
    expect(body.operations.map((operation) => operation.operation)).toContain('channels.register');
    expect(body.scopes).toContain('channels:read');
  });
});

// ---------------------------------------------------------------------------
// Handler happy paths + error mapping (through the full kernel)
// ---------------------------------------------------------------------------

describe('W103 channels api: register, list, get, status', () => {
  let connectionId = '';

  it('registers a channel connection (201, created=true, principal attribution)', async () => {
    const created = await callExpectJson<channels.RegisterChannelConnectionResult>(
      channelsKey,
      'POST',
      '/api/v1/channels',
      {
        body: {
          provider: 'email',
          providerAccountId: 'Ops@Example.COM',
          displayName: 'Main mailbox',
          credentialRef: 'secret-store://channels/email-main',
        },
      },
    );
    expect(created.status).toBe(201);
    expect(created.body.created).toBe(true);
    expect(created.body.connection.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(created.body.connection.provider).toBe('email');
    // The provider's adapter normalized the account id (lowercase email).
    expect(created.body.connection.providerAccountId).toBe('ops@example.com');
    expect(created.body.connection.displayName).toBe('Main mailbox');
    expect(created.body.connection.credentialRef).toBe('secret-store://channels/email-main');
    expect(created.body.connection.status).toBe('active');
    // The channels contract stamps the authenticated principal.
    expect(created.body.connection.createdBy).toBe(ownerMain);
    expect(created.body.connection.tenantId).toBe(tenantMain.id);
    connectionId = created.body.connection.id;
  });

  it('re-registering the same endpoint is idempotent (201, created=false, same id)', async () => {
    const again = await callExpectJson<channels.RegisterChannelConnectionResult>(
      channelsKey,
      'POST',
      '/api/v1/channels',
      {
        body: {
          provider: 'email',
          providerAccountId: 'ops@example.com',
          credentialRef: 'secret-store://channels/email-main',
        },
      },
    );
    expect(again.status).toBe(201);
    expect(again.body.created).toBe(false);
    expect(again.body.connection.id).toBe(connectionId);
  });

  it('lists connections and applies provider/status filters', async () => {
    // A second connection on another provider for filter coverage.
    const slack = await callExpectJson<channels.RegisterChannelConnectionResult>(
      channelsKey,
      'POST',
      '/api/v1/channels',
      {
        body: {
          provider: 'slack',
          providerAccountId: 'T024BE7LD',
          credentialRef: 'secret-store://channels/slack-main',
        },
      },
    );
    expect(slack.status).toBe(201);

    const list = await callExpectJson<{ items: channels.ChannelConnection[] }>(
      channelsKey,
      'GET',
      '/api/v1/channels',
    );
    expect(list.status).toBe(200);
    expect(list.body.items.map((item) => item.id)).toContain(connectionId);
    expect(list.body.items.map((item) => item.id)).toContain(slack.body.connection.id);

    const emailOnly = await callExpectJson<{ items: channels.ChannelConnection[] }>(
      channelsKey,
      'GET',
      '/api/v1/channels',
      { query: { provider: 'email' } },
    );
    expect(emailOnly.status).toBe(200);
    expect(emailOnly.body.items).toHaveLength(1);
    expect(emailOnly.body.items[0]!.id).toBe(connectionId);

    const active = await callExpectJson<{ items: channels.ChannelConnection[] }>(
      channelsKey,
      'GET',
      '/api/v1/channels',
      { query: { status: 'active', provider: 'slack' } },
    );
    expect(active.body.items.map((item) => item.id)).toContain(slack.body.connection.id);
  });

  it('reads one connection by id', async () => {
    const one = await callExpectJson<channels.ChannelConnection>(
      channelsKey,
      'GET',
      `/api/v1/channels/${connectionId}`,
    );
    expect(one.status).toBe(200);
    expect(one.body.id).toBe(connectionId);
    expect(one.body.provider).toBe('email');
  });

  it('disables and re-enables a connection through the status operation', async () => {
    const disabled = await callExpectJson<channels.ChannelConnection>(
      channelsKey,
      'PATCH',
      `/api/v1/channels/${connectionId}/status`,
      { body: { status: 'disabled' } },
    );
    expect(disabled.status).toBe(200);
    expect(disabled.body.status).toBe('disabled');
    expect(disabled.body.updatedAt >= disabled.body.createdAt).toBe(true);

    const enabled = await callExpectJson<channels.ChannelConnection>(
      channelsKey,
      'PATCH',
      `/api/v1/channels/${connectionId}/status`,
      { body: { status: 'active' } },
    );
    expect(enabled.status).toBe(200);
    expect(enabled.body.status).toBe('active');
  });

  it('maps domain validation failures onto 400 without leaking internals', async () => {
    const badProvider = await call(channelsKey, 'POST', '/api/v1/channels', {
      body: { provider: 'carrier-pigeon', providerAccountId: 'x', credentialRef: 'ref' },
    });
    expect(badProvider.status).toBe(400);
    expect(errorOf(badProvider).code).toBe('invalid_channel_input');

    const badEmail = await call(channelsKey, 'POST', '/api/v1/channels', {
      body: { provider: 'email', providerAccountId: 'not-an-email', credentialRef: 'ref' },
    });
    expect(badEmail.status).toBe(400);
    expect(errorOf(badEmail).code).toBe('invalid_channel_input');

    const missingCredential = await call(channelsKey, 'POST', '/api/v1/channels', {
      body: { provider: 'email', providerAccountId: 'ops@example.com' },
    });
    expect(missingCredential.status).toBe(400);

    const notAnObject = await call(channelsKey, 'POST', '/api/v1/channels', {
      body: ['not', 'an', 'object'],
    });
    expect(notAnObject.status).toBe(400);
    expect(errorOf(notAnObject).code).toBe('invalid_body');

    const noBody = await call(channelsKey, 'POST', '/api/v1/channels', { body: undefined });
    expect(noBody.status).toBe(400);
    expect(errorOf(noBody).code).toBe('invalid_body');

    const badStatus = await call(channelsKey, 'PATCH', `/api/v1/channels/${connectionId}/status`, {
      body: { status: 'paused' },
    });
    expect(badStatus.status).toBe(400);
    expect(errorOf(badStatus).code).toBe('invalid_channel_input');

    const statusNoBody = await call(channelsKey, 'PATCH', `/api/v1/channels/${connectionId}/status`, {
      body: undefined,
    });
    expect(statusNoBody.status).toBe(400);
    expect(errorOf(statusNoBody).code).toBe('invalid_body');
  });

  it('validates query parameters before delegating', async () => {
    const badLimit = await call(channelsKey, 'GET', '/api/v1/channels', {
      query: { limit: 'zero' },
    });
    expect(badLimit.status).toBe(400);
    expect(errorOf(badLimit).code).toBe('invalid_query');

    const badProvider = await call(channelsKey, 'GET', '/api/v1/channels', {
      query: { provider: 'carrier-pigeon' },
    });
    expect(badProvider.status).toBe(400);
    expect(errorOf(badProvider).code).toBe('invalid_channel_query');
  });

  it('reports missing and malformed ids uniformly as 404 (no leak)', async () => {
    const missing = await call(channelsKey, 'GET', `/api/v1/channels/${newId()}`);
    expect(missing.status).toBe(404);
    expect(errorOf(missing).code).toBe('connection_not_found');

    const malformed = await call(channelsKey, 'GET', '/api/v1/channels/not-a-uuid');
    expect(malformed.status).toBe(404);
    expect(errorOf(malformed).code).toBe('connection_not_found');

    const statusMissing = await call(channelsKey, 'PATCH', `/api/v1/channels/${newId()}/status`, {
      body: { status: 'disabled' },
    });
    expect(statusMissing.status).toBe(404);
    expect(errorOf(statusMissing).code).toBe('connection_not_found');
  });
});

// ---------------------------------------------------------------------------
// Scope enforcement (the capability gate in front of every route)
// ---------------------------------------------------------------------------

describe('W103 channels api: capability scopes', () => {
  it('rejects reads without channels:read', async () => {
    const response = await call(goalsKey, 'GET', '/api/v1/channels');
    expect(response.status).toBe(403);
    expect(errorOf(response).code).toBe('missing_scope');
    expect(errorOf(response).message).toContain('channels:read');

    const one = await call(goalsKey, 'GET', `/api/v1/channels/${newId()}`);
    expect(one.status).toBe(403);
    expect(errorOf(one).code).toBe('missing_scope');
  });

  it('rejects writes without channels:write even with channels:read', async () => {
    const register = await call(channelsReadKey, 'POST', '/api/v1/channels', {
      body: { provider: 'email', providerAccountId: 'ops@example.com', credentialRef: 'ref' },
    });
    expect(register.status).toBe(403);
    expect(errorOf(register).code).toBe('missing_scope');
    expect(errorOf(register).message).toContain('channels:write');

    const status = await call(channelsReadKey, 'PATCH', `/api/v1/channels/${newId()}/status`, {
      body: { status: 'disabled' },
    });
    expect(status.status).toBe(403);
    expect(errorOf(status).code).toBe('missing_scope');
    expect(errorOf(status).message).toContain('channels:write');
  });

  it('requires authentication like every scoped route', async () => {
    const anonymous = await call(null, 'GET', '/api/v1/channels');
    expect(anonymous.status).toBe(401);
    expect(errorOf(anonymous).code).toBe('unauthenticated');
  });
});

// ---------------------------------------------------------------------------
// Tenancy isolation (ADR-0001 — no existence leak)
// ---------------------------------------------------------------------------

describe('W103 channels api: tenancy isolation', () => {
  let mainConnectionId = '';

  beforeAll(async () => {
    const created = await callExpectJson<channels.RegisterChannelConnectionResult>(
      channelsKey,
      'POST',
      '/api/v1/channels',
      {
        body: {
          provider: 'telegram',
          providerAccountId: '123456789',
          credentialRef: 'secret-store://channels/telegram-main',
        },
      },
    );
    expect(created.status).toBe(201);
    mainConnectionId = created.body.connection.id;
  });

  it('hides another tenant\'s connection completely (get → 404)', async () => {
    const foreign = await call(isoChannelsKey, 'GET', `/api/v1/channels/${mainConnectionId}`);
    expect(foreign.status).toBe(404);
    expect(errorOf(foreign).code).toBe('connection_not_found');
  });

  it('never lists another tenant\'s connections', async () => {
    const list = await callExpectJson<{ items: channels.ChannelConnection[] }>(
      isoChannelsKey,
      'GET',
      '/api/v1/channels',
    );
    expect(list.status).toBe(200);
    expect(list.body.items.map((item) => item.id)).not.toContain(mainConnectionId);
    for (const item of list.body.items) {
      expect(item.tenantId).toBe(tenantIso.id);
    }
  });

  it('refuses status changes on another tenant\'s connection (404, no leak)', async () => {
    const foreign = await call(isoChannelsKey, 'PATCH', `/api/v1/channels/${mainConnectionId}/status`, {
      body: { status: 'disabled' },
    });
    expect(foreign.status).toBe(404);
    expect(errorOf(foreign).code).toBe('connection_not_found');

    // The connection is untouched.
    const intact = await callExpectJson<channels.ChannelConnection>(
      channelsKey,
      'GET',
      `/api/v1/channels/${mainConnectionId}`,
    );
    expect(intact.body.status).toBe('active');
  });

  it('lets the other tenant register and manage its OWN connections', async () => {
    const own = await callExpectJson<channels.RegisterChannelConnectionResult>(
      isoChannelsKey,
      'POST',
      '/api/v1/channels',
      {
        body: {
          provider: 'email',
          providerAccountId: 'iso@example.net',
          credentialRef: 'secret-store://channels/email-iso',
        },
      },
    );
    expect(own.status).toBe(201);
    expect(own.body.connection.tenantId).toBe(tenantIso.id);
    expect(own.body.connection.createdBy).toBe(ownerIso);

    const disabled = await callExpectJson<channels.ChannelConnection>(
      isoChannelsKey,
      'PATCH',
      `/api/v1/channels/${own.body.connection.id}/status`,
      { body: { status: 'disabled' } },
    );
    expect(disabled.status).toBe(200);
    expect(disabled.body.status).toBe('disabled');
  });
});

// ---------------------------------------------------------------------------
// Audit (lock 32 — every authenticated operation appends api.operation)
// ---------------------------------------------------------------------------

describe('W103 channels api: audit trail', () => {
  it('appends api.operation events for channel operations (success and denial)', async () => {
    const audited = await events.listEvents(ctx(tenantMain.id, ownerMain), {
      type: 'api.operation',
      limit: 500,
    });
    const operations = audited.map((event) => (event.payload as { operation?: string }).operation);
    expect(operations).toContain('channels.register');
    expect(operations).toContain('channels.list');
    expect(operations).toContain('channels.get');
    expect(operations).toContain('channels.status');

    const register = audited.find((event) => {
      const payload = event.payload as { operation?: string; status?: number };
      return payload.operation === 'channels.register' && payload.status === 201;
    });
    expect(register).toBeDefined();
    expect(register?.actor).toMatchObject({ kind: 'person', id: ownerMain });
    expect(register?.actor.label).toMatch(/^api-key:/);
    expect(register?.source).toMatchObject({ kind: 'api', label: 'public-api/v1' });

    // The 403 missing_scope probe is audited too.
    const denied = audited.find((event) => {
      const payload = event.payload as { operation?: string; status?: number };
      return payload.operation === 'channels.register' && payload.status === 403;
    });
    expect(denied).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Storage sync: the api_keys scopes CHECK constraint accepts the family
// (migrations/003-api-channels-scopes.sql)
// ---------------------------------------------------------------------------

describe('W103 channels api: key storage accepts the channels scopes', () => {
  it('issues keys carrying the channels scopes and they authenticate', async () => {
    // createApiKey INSERTs into api_keys — the extended CHECK constraint
    // from 003-api-channels-scopes.sql is what lets this row exist.
    const issuance = await api.createApiKey(adminCtx(tenantMain.id, ownerMain), {
      label: 'fresh-channels-key',
      scopes: ['channels:read', 'channels:write', 'goals:read'],
    });
    expect(issuance.apiKey.scopes).toEqual(['channels:read', 'channels:write', 'goals:read']);

    const used = await call(issuance.key, 'GET', '/api/v1/channels');
    expect(used.status).toBe(200);
  });

  it('still accepts the pre-existing vocabulary (the constraint only widened)', async () => {
    const issuance = await api.createApiKey(adminCtx(tenantMain.id, ownerMain), {
      label: 'legacy-vocabulary-key',
      scopes: ['goals:read', 'webhooks:manage'],
    });
    expect(issuance.apiKey.scopes).toEqual(['goals:read', 'webhooks:manage']);
  });
});
