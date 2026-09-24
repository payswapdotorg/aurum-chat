// Unit tests for the connection-broker module's PURE logic (no database,
// no clock, no network): validation guards, broker-output re-validation,
// outage-health/cooldown logic, cursor-movement semantics and the two
// broker adapters' dialect behavior (scripted http clients only).
//
// Fake credential values in these tests are assembled from fragments at
// runtime (never a realistic full token literal in source — GitHub push
// protection discipline).

import { describe, expect, it } from 'vitest';
import { normalizeProviderError } from '@/modules/provider-sdk/contract';
import { BrokerAdapterError, categoryForHttpStatus } from '../adapters/shared';
import { createNangoBroker } from '../adapters/nango';
import { createEmbeddedBroker } from '../adapters/embedded';
import { ConnectionBrokerError } from '../errors';
import { cooldownExpiryFor, healthForFailure, isCoolingDown, OUTAGE_COOLDOWN_MS, resolveHealth } from '../health';
import type { BrokerHttpClient, BrokerHttpRequest, BrokerHttpResponse, InitiateConnectionInput } from '../types';
import {
  BROKER_PROVIDERS,
  assertBrokerTenantContext,
  isBrokerProvider,
  syncCursorAdvance,
  validateBrokerAuthorizationSession,
  validateBrokerConnectionGrant,
  validateBrokerSyncResult,
  validateBrokerWebhookParseResult,
  validateInitiateConnectionInput,
  validateSetProviderHealthInput,
  webhookCursorAdvance,
} from '../validation';

// ---------------------------------------------------------------------------
// Scripted http clients (per dialect)
// ---------------------------------------------------------------------------

/** An http client that answers every request with a fixed response. */
class FixedClient implements BrokerHttpClient {
  readonly requests: BrokerHttpRequest[] = [];
  constructor(private readonly respond: (request: BrokerHttpRequest) => BrokerHttpResponse | Error) {}
  async request(request: BrokerHttpRequest): Promise<BrokerHttpResponse> {
    this.requests.push(request);
    const outcome = this.respond(request);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}

/** A fake Nango instance secret — assembled from fragments at runtime. */
const nangoSecret = ['nango_sk_live_', 'unit', '_fragment'].join('');
/** A fake embedded broker token — assembled from fragments at runtime. */
const embeddedToken = ['embedded_tok_', 'unit', '_fragment'].join('');

function nangoBroker(respond: (request: BrokerHttpRequest) => BrokerHttpResponse | Error) {
  return createNangoBroker({ baseUrl: 'https://nango.unit.example', secretKey: nangoSecret, httpClient: new FixedClient(respond) });
}

function embeddedBroker(respond: (request: BrokerHttpRequest) => BrokerHttpResponse | Error) {
  return createEmbeddedBroker({ baseUrl: 'https://broker.unit.example', apiToken: embeddedToken, httpClient: new FixedClient(respond) });
}

// ---------------------------------------------------------------------------
// Vocabularies + tenant context
// ---------------------------------------------------------------------------

describe('connection-broker unit — vocabularies', () => {
  it('derives the provider vocabulary from the two gateways (union, no drift)', () => {
    // inbound-only, outbound-only and shared keys all present
    for (const provider of ['stripe', 'jira', 'quickbooks', 'looker', 'snowflake', 'http-api', 'salesforce', 'hubspot']) {
      expect(isBrokerProvider(provider)).toBe(true);
    }
    expect(isBrokerProvider('not-a-provider')).toBe(false);
    expect(new Set(BROKER_PROVIDERS).size).toBe(BROKER_PROVIDERS.length);
  });

  it('rejects malformed tenant contexts', () => {
    expect(() => assertBrokerTenantContext({ tenantId: '', principalId: 'p', authority: [] })).toThrowError(ConnectionBrokerError);
    expect(() => assertBrokerTenantContext({ tenantId: 't', principalId: ' ', authority: [] })).toThrowError(ConnectionBrokerError);
    expect(() => assertBrokerTenantContext({ tenantId: 't', principalId: 'p', authority: 'none' as unknown as string[] })).toThrowError(ConnectionBrokerError);
    expect(() => assertBrokerTenantContext({ tenantId: 't', principalId: 'p', authority: [] })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('connection-broker unit — initiation input validation', () => {
  const base = { provider: 'hubspot', connectionKey: 'hubspot-main' } as const;

  it('accepts a minimal valid input and normalizes optionals to null', () => {
    const valid = validateInitiateConnectionInput(base);
    expect(valid).toEqual({
      provider: 'hubspot',
      connectionKey: 'hubspot-main',
      displayName: null,
      scopes: [],
      redirectTo: null,
      inventorySystemId: null,
      bindSourceId: null,
      bindDestinationId: null,
    });
  });

  it('rejects unknown fields (no smuggling of ids, tenancy or credentials)', () => {
    expect(() =>
      validateInitiateConnectionInput({ ...base, credentialRef: 'secret-value' } as unknown as InitiateConnectionInput),
    ).toThrowError(/unknown field 'credentialRef'/);
    expect(() =>
      validateInitiateConnectionInput({ ...base, tenantId: 't' } as unknown as InitiateConnectionInput),
    ).toThrowError(/unknown field 'tenantId'/);
  });

  it('rejects unsupported providers and malformed connection keys', () => {
    expect(() =>
      validateInitiateConnectionInput({ ...base, provider: 'sap' } as unknown as InitiateConnectionInput),
    ).toThrowError(/provider must be one of/);
    expect(() => validateInitiateConnectionInput({ ...base, connectionKey: 'Not Lower' })).toThrowError(
      /connectionKey/,
    );
    expect(() => validateInitiateConnectionInput({ ...base, connectionKey: '' })).toThrowError(/connectionKey/);
  });

  it('validates scopes (bounded, unique, non-empty) and redirect length', () => {
    expect(() => validateInitiateConnectionInput({ ...base, scopes: ['a', 'a'] })).toThrowError(/unique/);
    expect(() => validateInitiateConnectionInput({ ...base, scopes: [''] })).toThrowError(/non-empty/);
    expect(() =>
      validateInitiateConnectionInput({ ...base, scopes: new Array(33).fill(0).map((_, i) => `s${i}`) }),
    ).toThrowError(/at most 32/);
    expect(() => validateInitiateConnectionInput({ ...base, redirectTo: 'x'.repeat(2049) })).toThrowError(/redirectTo/);
  });
});

describe('connection-broker unit — provider-health override validation', () => {
  it('requires a canonical category for unhealthy states and forbids it for recovery', () => {
    expect(() =>
      validateSetProviderHealthInput({ provider: 'stripe', broker: 'nango', health: 'unavailable' }),
    ).toThrowError(/category is required/);
    expect(() =>
      validateSetProviderHealthInput({
        provider: 'stripe',
        broker: 'nango',
        health: 'unavailable',
        category: 'not-a-category' as unknown as 'auth_failure',
      }),
    ).toThrowError(/canonical error category/);
    expect(() =>
      validateSetProviderHealthInput({
        provider: 'stripe',
        broker: 'nango',
        health: 'available',
        category: 'auth_failure',
      }),
    ).toThrowError(/category must be null/);
    expect(() =>
      validateSetProviderHealthInput({ provider: 'stripe', broker: 'nango', health: 'available', expiresAt: '2026-01-01T00:00:00Z' }),
    ).toThrowError(/expiresAt must be null/);
    const valid = validateSetProviderHealthInput({
      provider: 'stripe',
      broker: 'nango',
      health: 'degraded',
      category: 'rate_limited',
      reason: 'operator pin',
    });
    expect(valid.category).toBe('rate_limited');
    expect(valid.expiresAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Broker-output re-validation (defense in depth)
// ---------------------------------------------------------------------------

describe('connection-broker unit — broker output re-validation', () => {
  it('accepts a well-formed authorization session', () => {
    const session = validateBrokerAuthorizationSession({
      authorizationUrl: 'https://broker.example/oauth/connect?x=1',
      state: 'st_abc',
      expiresAt: '2026-09-23T10:00:00Z',
    });
    expect(session.state).toBe('st_abc');
  });

  it('rejects non-http authorization urls and non-ISO expiries', () => {
    expect(() =>
      validateBrokerAuthorizationSession({ authorizationUrl: 'ftp://nope', state: 's', expiresAt: '2026-09-23T10:00:00Z' }),
    ).toThrowError(/authorizationUrl/);
    expect(() =>
      validateBrokerAuthorizationSession({ authorizationUrl: 'https://b.example/x', state: 's', expiresAt: '2026-09-23' }),
    ).toThrowError(/expiresAt/);
  });

  it('accepts a canonical grant and rejects credential-looking references', () => {
    const grant = validateBrokerConnectionGrant({
      brokerConnectionId: 'emb_123',
      providerAccountId: 'acct-9',
      credentialRef: 'embedded-connection:emb_123',
      scopes: ['read', 'write'],
      expiresAt: null,
    });
    expect(grant.credentialRef).toBe('embedded-connection:emb_123');
    expect(grant.expiresAt).toBeNull();
    // A raw token value is not a scheme-qualified opaque reference.
    expect(() =>
      validateBrokerConnectionGrant({
        brokerConnectionId: 'emb_123',
        providerAccountId: 'acct-9',
        credentialRef: 'sq3at-live-PLAINSECRETVALUE',
        scopes: [],
        expiresAt: null,
      }),
    ).toThrowError(/opaque scheme-qualified reference/);
  });

  it('validates sync results: shapes, duplicate record ids, bounded batches', () => {
    const ok = validateBrokerSyncResult({
      records: [{ providerRecordId: 'r1', kind: 'crm.contact.updated', payload: { x: 1 }, occurredAt: '2026-09-23T10:00:00Z' }],
      nextCursor: 'cur-2',
      hasMore: true,
    });
    expect(ok.records).toHaveLength(1);
    expect(() =>
      validateBrokerSyncResult({
        records: [
          { providerRecordId: 'r1', kind: 'k', payload: {}, occurredAt: '2026-09-23T10:00:00Z' },
          { providerRecordId: 'r1', kind: 'k', payload: {}, occurredAt: '2026-09-23T10:00:00Z' },
        ],
        nextCursor: null,
        hasMore: false,
      }),
    ).toThrowError(/duplicate providerRecordId/);
    expect(() => validateBrokerSyncResult({ records: 'nope', nextCursor: null, hasMore: false })).toThrowError(
      /records must be an array/,
    );
    expect(() =>
      validateBrokerSyncResult({
        records: new Array(201).fill(0).map((_, i) => ({
          providerRecordId: `r${i}`,
          kind: 'k',
          payload: {},
          occurredAt: '2026-09-23T10:00:00Z',
        })),
        nextCursor: null,
        hasMore: false,
      }),
    ).toThrowError(/at most 200/);
  });

  it('validates webhook parse results (occurredAt strictly ISO, ids opaque)', () => {
    expect(() =>
      validateBrokerWebhookParseResult({ brokerConnectionId: 'c', deliveryId: null, occurredAt: 'yesterday', records: [] }),
    ).toThrowError(/occurredAt/);
    const parsed = validateBrokerWebhookParseResult({
      brokerConnectionId: 'c1',
      deliveryId: 'del-7',
      occurredAt: '2026-09-23T11:00:00Z',
      records: [],
    });
    expect(parsed.deliveryId).toBe('del-7');
  });
});

// ---------------------------------------------------------------------------
// Health / cooldown logic
// ---------------------------------------------------------------------------

describe('connection-broker unit — outage localization logic', () => {
  const at = new Date('2026-09-23T12:00:00Z');

  it('maps canonical failures to health states per the W089 semantics table', () => {
    const outage = normalizeProviderError(new Error('connect ECONNREFUSED 10.0.0.5:443'), {
      gateway: 'connection-broker',
      provider: 'nango',
    });
    expect(healthForFailure(outage)).toBe('unavailable');
    const throttle = normalizeProviderError(Object.assign(new Error('slow down'), { status: 429 }), {
      gateway: 'connection-broker',
      provider: 'nango',
    });
    expect(healthForFailure(throttle)).toBe('degraded');
  });

  it('automatic failures cool down for a bounded window; operator failures indefinitely', () => {
    const automatic = normalizeProviderError(Object.assign(new Error('boom'), { status: 503 }), {
      gateway: 'connection-broker',
      provider: 'nango',
    });
    const cooldown = cooldownExpiryFor(automatic, at);
    expect(cooldown).not.toBeNull();
    expect(cooldown!.getTime() - at.getTime()).toBe(OUTAGE_COOLDOWN_MS);
    const operator = normalizeProviderError(Object.assign(new Error('bad key'), { status: 401 }), {
      gateway: 'connection-broker',
      provider: 'nango',
    });
    expect(cooldownExpiryFor(operator, at)).toBeNull();
  });

  it('cooling-down semantics: bounded windows expire, indefinite ones do not', () => {
    expect(isCoolingDown({ state: 'unavailable', category: 'provider_unavailable', reason: null, expiresAt: new Date(at.getTime() + 1000), observedAt: at }, at)).toBe(true);
    expect(
      isCoolingDown(
        { state: 'unavailable', category: 'provider_unavailable', reason: null, expiresAt: new Date(at.getTime() - 1000), observedAt: at },
        at,
      ),
    ).toBe(false);
    expect(isCoolingDown({ state: 'degraded', category: 'auth_failure', reason: null, expiresAt: null, observedAt: at }, at)).toBe(true);
    expect(isCoolingDown({ state: 'available', category: null, reason: null, expiresAt: null, observedAt: at }, at)).toBe(false);
  });

  it('resolves expired cooldowns back to available (the llm precedent)', () => {
    expect(
      resolveHealth(
        { state: 'unavailable', category: 'provider_unavailable', reason: null, expiresAt: new Date(at.getTime() - 1), observedAt: at },
        at,
      ),
    ).toBe('available');
    expect(
      resolveHealth({ state: 'unavailable', category: 'auth_failure', reason: null, expiresAt: null, observedAt: at }, at),
    ).toBe('unavailable');
    expect(resolveHealth({ state: 'available', category: null, reason: null, expiresAt: null, observedAt: at }, at)).toBe('available');
  });
});

// ---------------------------------------------------------------------------
// Cursor movement semantics
// ---------------------------------------------------------------------------

describe('connection-broker unit — cursor movement semantics', () => {
  it('sync cursors: null never advances, unchanged cursors do not move', () => {
    expect(syncCursorAdvance('cur-1', null)).toBe(false);
    expect(syncCursorAdvance('cur-1', 'cur-1')).toBe(false);
    expect(syncCursorAdvance('cur-1', 'cur-2')).toBe(true);
    expect(syncCursorAdvance(null, 'cur-1')).toBe(true);
  });

  it('webhook watermarks only move forward in time', () => {
    expect(webhookCursorAdvance(null, '2026-09-23T10:00:00Z')).toBe(true);
    expect(webhookCursorAdvance('2026-09-23T10:00:00Z', '2026-09-23T10:00:00Z')).toBe(false);
    expect(webhookCursorAdvance('2026-09-23T10:00:00Z', '2026-09-23T09:59:59Z')).toBe(false);
    expect(webhookCursorAdvance('2026-09-23T10:00:00Z', '2026-09-23T10:00:01Z')).toBe(true);
    // Offset-equivalent instants never rewind the watermark.
    expect(webhookCursorAdvance('2026-09-23T10:00:00Z', '2026-09-23T11:00:00+01:00')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HTTP status → canonical category mapping
// ---------------------------------------------------------------------------

describe('connection-broker unit — http status classification', () => {
  it('maps statuses onto the W089 taxonomy', () => {
    expect(categoryForHttpStatus(401)).toBe('auth_failure');
    expect(categoryForHttpStatus(403)).toBe('permission_denied');
    expect(categoryForHttpStatus(408)).toBe('timeout');
    expect(categoryForHttpStatus(429)).toBe('rate_limited');
    expect(categoryForHttpStatus(500)).toBe('provider_unavailable');
    expect(categoryForHttpStatus(503)).toBe('provider_unavailable');
    expect(categoryForHttpStatus(404)).toBe('auth_failure'); // connection-scoped: the grant is gone
    expect(categoryForHttpStatus(200)).toBeNull();
    expect(categoryForHttpStatus(302)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The nango adapter (scripted dialect)
// ---------------------------------------------------------------------------

describe('connection-broker unit — nango adapter dialect', () => {
  it('constructs only when the W089 technology registry carries the Nango entry', () => {
    // The registry is committed repository state (seeded from
    // spec/TECHNOLOGY-RESEARCH-2026-09-23.md) — Nango IS registered.
    expect(() => nangoBroker(() => ({ status: 200, body: {} }))).not.toThrow();
  });

  it('builds the OAuth hand-off URL without an API roundtrip (static connect link)', async () => {
    const client = new FixedClient(() => ({ status: 200, body: {} }));
    const broker = createNangoBroker({ baseUrl: 'https://nango.unit.example', secretKey: nangoSecret, httpClient: client });
    const session = await broker.beginAuthorization({
      provider: 'hubspot',
      tenantId: 't1',
      connectionId: '00000000-0000-0000-0000-000000000001',
      connectionKey: 'hubspot-main',
      scopes: ['crm.objects.read'],
      redirectTo: 'https://aurum.example/connected',
    });
    expect(client.requests).toHaveLength(0);
    expect(session.authorizationUrl).toContain('https://nango.unit.example/oauth/connect?');
    expect(session.authorizationUrl).toContain(encodeURIComponent('crm.objects.read'));
    expect(session.state).toBe('00000000-0000-0000-0000-000000000001');
  });

  it('discards token values from connection metadata — the grant carries only opaque references', async () => {
    // Fake token material, assembled from fragments at runtime.
    const accessToken = ['nango_at_', 'unit', '_plain'].join('');
    const refreshToken = ['nango_rt_', 'unit', '_plain'].join('');
    const broker = nangoBroker(() => ({
      status: 200,
      body: {
        connection_id: '00000000-0000-0000-0000-000000000002',
        provider_config_key: 'hubspot',
        connection_config: { account_id: 'acct-42' },
        credentials: { type: 'OAUTH2', access_token: accessToken, refresh_token: refreshToken, expires_at: '2026-09-23T13:00:00Z', scopes: ['crm.objects.read'] },
      },
    }));
    const grant = await broker.completeAuthorization({
      provider: 'hubspot',
      connectionId: '00000000-0000-0000-0000-000000000002',
      state: '00000000-0000-0000-0000-000000000002',
    });
    expect(grant).toEqual({
      brokerConnectionId: '00000000-0000-0000-0000-000000000002',
      providerAccountId: 'acct-42',
      credentialRef: 'nango-connection:00000000-0000-0000-0000-000000000002',
      scopes: ['crm.objects.read'],
      expiresAt: '2026-09-23T13:00:00Z',
    });
    expect(JSON.stringify(grant)).not.toContain('nango_at_');
    expect(JSON.stringify(grant)).not.toContain('nango_rt_');
  });

  it('normalizes a 404 into a canonical auth failure (the broker-side grant is gone)', async () => {
    const broker = nangoBroker(() => ({ status: 404, body: { error: 'connection not found: bc1' } }));
    await expect(
      broker.refreshGrant({ provider: 'hubspot', connectionId: 'c1', brokerConnectionId: 'bc1', credentialRef: 'nango-connection:bc1' }),
    ).rejects.toMatchObject({
      failure: { category: 'auth_failure', retryable: false, recovery: 'operator', healthImpact: 'unavailable' },
    });
  });

  it('normalizes a 429 into a canonical rate-limited BrokerAdapterError', async () => {
    const broker = nangoBroker(() => ({ status: 429, body: { error: 'too many requests' } }));
    await expect(
      broker.pullSyncRecords({
        provider: 'hubspot',
        tenantId: 't1',
        connectionId: 'c1',
        brokerConnectionId: 'bc1',
        credentialRef: 'nango-connection:bc1',
        cursor: null,
        maxRecords: 10,
      }),
    ).rejects.toMatchObject({
      name: 'BrokerAdapterError',
      failure: { category: 'rate_limited', retryable: true, healthImpact: 'degrade', gateway: 'connection-broker', provider: 'nango' },
    });
  });

  it('normalizes network transport errors into canonical unavailable failures', async () => {
    const broker = nangoBroker(() => new Error('connect ECONNREFUSED 10.1.2.3:443'));
    await expect(
      broker.refreshGrant({ provider: 'hubspot', connectionId: 'c1', brokerConnectionId: 'bc1', credentialRef: 'nango-connection:bc1' }),
    ).rejects.toMatchObject({
      failure: { category: 'provider_unavailable', healthImpact: 'unavailable' },
    });
  });

  it('parses the nango webhook envelope into canonical records (envelope stays behind)', () => {
    const broker = nangoBroker(() => ({ status: 200, body: {} }));
    const parsed = broker.parseWebhook({
      connectionId: 'bc-9',
      providerConfigKey: 'hubspot',
      deliveryId: 'del-1',
      occurredAt: '2026-09-23T12:30:00Z',
      records: [{ id: 'rec-1', kind: 'crm.contact.updated', occurredAt: '2026-09-23T12:29:00Z', data: { vid: 1 } }],
    });
    expect(parsed).toEqual({
      brokerConnectionId: 'bc-9',
      deliveryId: 'del-1',
      occurredAt: '2026-09-23T12:30:00Z',
      records: [{ providerRecordId: 'rec-1', kind: 'crm.contact.updated', payload: { vid: 1 }, occurredAt: '2026-09-23T12:29:00Z' }],
    });
    expect(() => broker.parseWebhook({ connectionId: 'bc-9' })).toThrowError(BrokerAdapterError);
  });

  it('rejects a state token that does not match the connection being completed', async () => {
    const broker = nangoBroker(() => ({ status: 200, body: {} }));
    await expect(
      broker.completeAuthorization({ provider: 'hubspot', connectionId: 'conn-1', state: 'forged-state' }),
    ).rejects.toMatchObject({ failure: { category: 'auth_failure' } });
  });
});

// ---------------------------------------------------------------------------
// The embedded adapter (scripted dialect)
// ---------------------------------------------------------------------------

describe('connection-broker unit — embedded adapter dialect', () => {
  it('performs the authorization roundtrip in its own dialect', async () => {
    const client = new FixedClient((request) => {
      if (request.method === 'POST' && request.path === '/v1/authorizations') {
        return { status: 201, body: { authorization_url: 'https://broker.unit.example/oauth/xyz', state: 'st_77', expires_at: '2026-09-23T12:15:00Z' } };
      }
      if (request.method === 'POST' && request.path.endsWith('/callback')) {
        return {
          status: 200,
          body: {
            broker_connection_id: 'emb_77',
            provider_account_id: 'acct-77',
            credential_ref: 'embedded-connection:emb_77',
            scopes: ['read'],
            expires_at: '2026-09-23T13:00:00Z',
          },
        };
      }
      return { status: 404, body: { error: 'no route' } };
    });
    const broker = createEmbeddedBroker({ baseUrl: 'https://broker.unit.example', apiToken: embeddedToken, httpClient: client });
    const session = await broker.beginAuthorization({
      provider: 'stripe',
      tenantId: 't1',
      connectionId: 'c-1',
      connectionKey: 'stripe-main',
      scopes: [],
      redirectTo: null,
    });
    expect(session.state).toBe('st_77');
    const grant = await broker.completeAuthorization({ provider: 'stripe', connectionId: 'c-1', state: 'st_77' });
    expect(grant).toEqual({
      brokerConnectionId: 'emb_77',
      providerAccountId: 'acct-77',
      credentialRef: 'embedded-connection:emb_77',
      scopes: ['read'],
      expiresAt: '2026-09-23T13:00:00Z',
    });
    // The instance token rides the Authorization header, never the results.
    expect(JSON.stringify(grant)).not.toContain('embedded_tok_');
    const authHeaders = client.requests.map((request) => request.headers?.['Authorization'] ?? '');
    for (const header of authHeaders) expect(header).toBe(`Bearer ${embeddedToken}`);
  });

  it('parses the embedded webhook envelope (snake_case dialect)', () => {
    const broker = embeddedBroker(() => ({ status: 200, body: {} }));
    const parsed = broker.parseWebhook({
      connection_id: 'emb_9',
      delivery_id: 'del-2',
      occurred_at: '2026-09-23T12:45:00Z',
      records: [{ id: 'rec-9', kind: 'payment.charge.succeeded', occurred_at: '2026-09-23T12:44:00Z', data: { amount: 4200 } }],
    });
    expect(parsed.brokerConnectionId).toBe('emb_9');
    expect(parsed.records[0]!.providerRecordId).toBe('rec-9');
    expect(parsed.records[0]!.payload).toEqual({ amount: 4200 });
  });

  it('both adapters carry conforming W089 definitions with identical capability sets', () => {
    const nango = nangoBroker(() => ({ status: 200, body: {} }));
    const embedded = embeddedBroker(() => ({ status: 200, body: {} }));
    for (const broker of [nango, embedded]) {
      expect(broker.definition.sdk).toBe('provider-adapter-definition');
      expect(broker.definition.gateway).toBe('connection-broker');
      expect(broker.definition.describeCapabilities().capabilities).toEqual([
        'oauth-authorization',
        'token-refresh',
        'record-sync',
        'webhook-ingestion',
      ]);
      // Unknown garbage normalizes conservatively.
      const failure = broker.definition.mapError({ weird: true });
      expect(failure.category).toBe('unknown_failure');
      expect(failure.healthImpact).toBe('unavailable');
    }
    expect(nango.definition.provider).toBe('nango');
    expect(embedded.definition.provider).toBe('embedded');
    // The embedded classifier recognizes its own session-expiry wording.
    const expired = embedded.definition.mapError(new Error('authorization session expired'));
    expect(expired.category).toBe('auth_failure');
    // The nango classifier recognizes broker-side unknown-connection wording.
    const unknown = nango.definition.mapError(new Error('connection not found: nope'));
    expect(unknown.category).toBe('auth_failure');
  });
});
