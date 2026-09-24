// W089 — the two-broker proof: the connection-broker gateway's nango and
// embedded adapters are conforming ProviderAdapterDefinitions. This suite
// runs the provider-sdk conformance kit against both REAL adapters,
// including hot-swap evidence built from an ACTUAL verifyBrokerHotSwap run
// through the module's canonical verification path (embedded PostgreSQL,
// scripted broker backend speaking both brokers' native dialects).
//
// What this proves (WORK-ITEM-CATALOG W082 acceptance: "broker replacement
// does not change domain contracts"; GOVERNANCE.md "Provider swap
// evidence"): two materially different brokers satisfy the SAME canonical
// lifecycle, capability-reporting, error-normalization and evidence
// contracts, produced by the ONE template (createProviderAdapterDefinition)
// — and the gateway's own verification flow feeds the canonical SDK
// evidence format without any domain-contract change.
//
// The conformance suite itself is 100% provider-sdk kit code; this file
// only supplies the subjects and the vitest glue (see the provider-sdk
// README — the llm module's precedent, reshaped onto this gateway).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { systemClock } from '@/infra/clock';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  defineAdapterConformanceSuite,
  type AdapterConformanceSubject,
  type HotSwapEvidenceRecord,
} from '@/modules/provider-sdk/contract';
import { runMigrations } from '../../../../scripts/migrate';
import { createEmbeddedBroker } from '../adapters/embedded';
import { createNangoBroker } from '../adapters/nango';
import { BrokerAdapterError } from '../adapters/shared';
import { verifyBrokerHotSwap, wireConnectionBrokers } from '../service';
import type {
  BrokerHttpClient,
  BrokerHttpRequest,
  BrokerHttpResponse,
  ConnectionBroker,
} from '../types';

// ---------------------------------------------------------------------------
// A scripted backend speaking both brokers' native dialects (the service
// suite's backend, reduced to what the swap verification needs)
// ---------------------------------------------------------------------------

const clockMs = Date.parse('2026-09-23T12:00:00Z');

class SwapBackend implements BrokerHttpClient {
  readonly requests: BrokerHttpRequest[] = [];
  readonly nangoConnections = new Map<string, { provider: string; accountId: string; scopes: string[]; expiresAt: string; revoked: boolean }>();
  readonly embAuthorizations = new Map<string, { state: string; provider: string }>();
  readonly embConnections = new Map<string, { provider: string; accountId: string; credentialRef: string; scopes: string[]; expiresAt: string; revoked: boolean }>();
  private counter = 0;

  async request(request: BrokerHttpRequest): Promise<BrokerHttpResponse> {
    this.requests.push(request);
    const nowIso = new Date(clockMs).toISOString();

    const nangoConnection = /^\/connection\/([^/]+)$/.exec(request.path);
    if (request.method === 'GET' && nangoConnection !== null) {
      const entry = this.nangoConnections.get(decodeURIComponent(nangoConnection[1]!));
      if (entry === undefined || entry.revoked) return { status: 404, body: { error: 'connection not found' } };
      return {
        status: 200,
        body: {
          connection_id: nangoConnection[1],
          provider_config_key: entry.provider,
          connection_config: { account_id: entry.accountId },
          // Token values present in the dialect — discarded by the adapter.
          credentials: {
            type: 'OAUTH2',
            access_token: ['nango_at_', 'conf', '_plain'].join(''),
            refresh_token: ['nango_rt_', 'conf', '_plain'].join(''),
            expires_at: entry.expiresAt,
            scopes: entry.scopes,
          },
        },
      };
    }
    if (request.method === 'POST' && request.path === '/connection/refresh') {
      const body = request.body as { connection_id?: string };
      const entry = this.nangoConnections.get(body.connection_id ?? '');
      if (entry === undefined) return { status: 404, body: { error: 'connection not found' } };
      entry.expiresAt = nowIso;
      return { status: 200, body: {} };
    }
    if (request.method === 'DELETE' && nangoConnection !== null) {
      const entry = this.nangoConnections.get(decodeURIComponent(nangoConnection[1]!));
      if (entry === undefined) return { status: 404, body: { error: 'connection not found' } };
      entry.revoked = true;
      return { status: 200, body: {} };
    }
    const nangoSync = /^\/sync\/([^/]+)\/records$/.exec(request.path);
    if (request.method === 'GET' && nangoSync !== null) {
      return {
        status: 200,
        body: {
          records: [
            { id: 'conf-1', kind: 'crm.contact.updated', occurredAt: nowIso, data: { recordId: 'conf-1' } },
            { id: 'conf-2', kind: 'crm.contact.updated', occurredAt: nowIso, data: { recordId: 'conf-2' } },
          ],
          nextCursor: 'conf-cursor',
        },
      };
    }

    if (request.method === 'POST' && request.path === '/v1/authorizations') {
      const body = request.body as { connection_id?: string; provider?: string };
      this.counter += 1;
      const state = `st_${this.counter}`;
      this.embAuthorizations.set(body.connection_id ?? '', { state, provider: body.provider ?? '' });
      return {
        status: 201,
        body: {
          authorization_url: `https://broker.example/oauth/${state}`,
          state,
          expires_at: new Date(clockMs + 900_000).toISOString(),
        },
      };
    }
    const embCallback = /^\/v1\/authorizations\/([^/]+)\/callback$/.exec(request.path);
    if (request.method === 'POST' && embCallback !== null) {
      const authorization = this.embAuthorizations.get(decodeURIComponent(embCallback[1]!));
      const body = request.body as { state?: string };
      if (authorization === undefined || body.state !== authorization.state) {
        return { status: 401, body: { error: 'authorization session unknown or expired' } };
      }
      this.counter += 1;
      const embId = `emb_${this.counter}`;
      this.embConnections.set(embId, {
        provider: authorization.provider,
        accountId: `eacct-${embId}`,
        credentialRef: `embedded-connection:${embId}`,
        scopes: [],
        expiresAt: nowIso,
        revoked: false,
      });
      return {
        status: 200,
        body: {
          broker_connection_id: embId,
          provider_account_id: `eacct-${embId}`,
          credential_ref: `embedded-connection:${embId}`,
          scopes: [],
          expires_at: nowIso,
        },
      };
    }
    const embRefresh = /^\/v1\/connections\/([^/]+)\/refresh$/.exec(request.path);
    if (request.method === 'POST' && embRefresh !== null) {
      const entry = this.embConnections.get(decodeURIComponent(embRefresh[1]!));
      if (entry === undefined) return { status: 404, body: { error: 'connection not found' } };
      return {
        status: 200,
        body: { credential_ref: entry.credentialRef, provider_account_id: entry.accountId, scopes: entry.scopes, expires_at: nowIso },
      };
    }
    const embDelete = /^\/v1\/connections\/([^/]+)$/.exec(request.path);
    if (request.method === 'DELETE' && embDelete !== null) {
      const entry = this.embConnections.get(decodeURIComponent(embDelete[1]!));
      if (entry === undefined) return { status: 404, body: { error: 'connection not found' } };
      entry.revoked = true;
      return { status: 204, body: null };
    }
    const embRecords = /^\/v1\/connections\/([^/]+)\/records$/.exec(request.path);
    if (request.method === 'GET' && embRecords !== null) {
      return {
        status: 200,
        body: {
          records: [
            { id: 'conf-1', kind: 'crm.contact.updated', occurred_at: nowIso, data: { recordId: 'conf-1' } },
            { id: 'conf-2', kind: 'crm.contact.updated', occurred_at: nowIso, data: { recordId: 'conf-2' } },
          ],
          next_cursor: 'conf-cursor',
          has_more: true,
        },
      };
    }
    return { status: 404, body: { error: 'no route' } };
  }
}

const backend = new SwapBackend();
const nango: ConnectionBroker = createNangoBroker({
  baseUrl: 'https://nango.unit.example',
  // Fake instance secret — assembled from fragments at runtime.
  secretKey: ['nango_sk_live_', 'conf', '_fragment'].join(''),
  httpClient: backend,
});
const embedded: ConnectionBroker = createEmbeddedBroker({
  baseUrl: 'https://broker.unit.example',
  apiToken: ['embedded_tok_', 'conf', '_fragment'].join(''),
  httpClient: backend,
});
let hotSwapEvidence: HotSwapEvidenceRecord | null = null;
let swapVerificationId = '';

const tenantConformance = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

beforeAll(async () => {
  vi.spyOn(systemClock, 'now').mockImplementation(() => new Date(clockMs));
  await runMigrations(getDb());
  wireConnectionBrokers([nango, embedded]);

  // The canonical swap: the SAME connection-sync capability through two
  // materially different brokers via the gateway's own verification flow,
  // with the same scripted provider window on both sides.
  const ctx = member(tenantConformance);
  const { initiateConnection, completeConnection } = await import('../service');
  const nangoInitiated = await initiateConnection(ctx, { provider: 'hubspot', connectionKey: 'conf-nango', scopes: ['read'] });
  backend.nangoConnections.set(nangoInitiated.connection.id, {
    provider: 'hubspot',
    accountId: 'acct-conf-nango',
    scopes: ['read'],
    expiresAt: new Date(clockMs + 3_600_000).toISOString(),
    revoked: false,
  });
  const nangoCompleted = await completeConnection(ctx, {
    connectionId: nangoInitiated.connection.id,
    state: nangoInitiated.authorization.state,
  });

  wireConnectionBrokers([embedded, nango]);
  const embeddedInitiated = await initiateConnection(ctx, { provider: 'hubspot', connectionKey: 'conf-embedded', scopes: [] });
  const embeddedCompleted = await completeConnection(ctx, {
    connectionId: embeddedInitiated.connection.id,
    state: embeddedInitiated.authorization.state,
  });

  const result = await verifyBrokerHotSwap(ctx, {
    connectionIdA: nangoCompleted.connection.id,
    connectionIdB: embeddedCompleted.connection.id,
    note: 'W089 two-broker proof: connection-broker gateway nango ↔ embedded via verifyBrokerHotSwap',
  });
  expect(result.verification.outcome).toBe('equivalent');
  expect(result.verification.brokerA).not.toBe(result.verification.brokerB);
  swapVerificationId = result.verification.id;

  // The canonical SDK evidence record — no domain change, no provider
  // objects crossing boundaries.
  hotSwapEvidence = result.evidence;
});

afterAll(async () => {
  wireConnectionBrokers(null);
  vi.restoreAllMocks();
  await closeDb();
});

// ---------------------------------------------------------------------------
// The conformance subjects (the only adapter-specific input the kit needs)
// ---------------------------------------------------------------------------

const nangoSubject: AdapterConformanceSubject = {
  definition: nango.definition,
  gateway: 'connection-broker',
  errorSpecimens: [
    {
      description: 'broker throttling response',
      error: Object.assign(new Error('nango rate limit'), { status: 429, retryAfterMs: 1_200 }),
      expectedCategory: 'rate_limited',
      expectedRetryable: true,
    },
    {
      description: 'broker outage response',
      error: Object.assign(new Error('nango upstream capacity'), { status: 503 }),
      expectedCategory: 'provider_unavailable',
      expectedRetryable: true,
    },
    {
      description: 'rejected instance secret',
      error: Object.assign(new Error('nango unauthorized'), { status: 401 }),
      expectedCategory: 'auth_failure',
    },
    {
      description: 'transport connection timeout',
      error: new Error('connect ETIMEDOUT nango.unit.example:443 after 30000ms'),
      expectedCategory: 'timeout',
      expectedRetryable: true,
    },
    {
      description: 'an adapter-normalized malformed response',
      error: new BrokerAdapterError(
        {
          category: 'malformed_response',
          retryable: false,
          recovery: 'operator',
          healthImpact: 'degrade',
          gateway: 'connection-broker',
          provider: 'nango',
          detail: 'the nango connection metadata must be an object',
          retryAfterMs: null,
        },
        'the nango connection metadata must be an object',
      ),
      expectedCategory: 'malformed_response',
    },
  ],
  expectedCapabilities: ['oauth-authorization', 'token-refresh', 'record-sync', 'webhook-ingestion'],
  hotSwapEvidence: () => hotSwapEvidence!,
};

const embeddedSubject: AdapterConformanceSubject = {
  definition: embedded.definition,
  gateway: 'connection-broker',
  errorSpecimens: [
    {
      description: 'expired authorization session wording',
      error: new Error('authorization session expired'),
      expectedCategory: 'auth_failure',
    },
    {
      description: 'declined authorization wording',
      error: new Error('authorization declined by the provider'),
      expectedCategory: 'permission_denied',
    },
    {
      description: 'broker outage response',
      error: Object.assign(new Error('embedded broker 502'), { status: 502 }),
      expectedCategory: 'provider_unavailable',
      expectedRetryable: true,
    },
    {
      description: 'transport connection refused',
      error: new Error('connect ECONNREFUSED 10.0.0.9:443'),
      expectedCategory: 'provider_unavailable',
      expectedRetryable: true,
    },
  ],
  expectedCapabilities: ['oauth-authorization', 'token-refresh', 'record-sync', 'webhook-ingestion'],
  hotSwapEvidence: () => hotSwapEvidence!,
};

// ---------------------------------------------------------------------------
// The kit-driven suites (one describe per broker — all checks are kit code)
// ---------------------------------------------------------------------------

defineAdapterConformanceSuite(nangoSubject, { describe, it });
defineAdapterConformanceSuite(embeddedSubject, { describe, it });

// ---------------------------------------------------------------------------
// The swap evidence itself + behavior-unchanged regression
// ---------------------------------------------------------------------------

describe('connection-broker adapter SDK conformance — hot-swap evidence from the real verification flow', () => {
  it('carries the canonical record for the nango ↔ embedded swap', () => {
    expect(hotSwapEvidence).not.toBeNull();
    const record = hotSwapEvidence!;
    expect(record.sdk).toBe('provider-hot-swap-evidence');
    expect(record.gateway).toBe('connection-broker');
    expect(record.capability).toBe('connection-sync');
    expect(record.providerA.provider).toBe('nango');
    expect(record.providerA.target).toBe('hubspot');
    expect(record.providerA.resultKind).toBe('completed');
    expect(record.providerB.provider).toBe('embedded');
    expect(record.providerB.target).toBe('hubspot');
    expect(record.providerB.resultKind).toBe('completed');
    expect(record.outcome).toBe('equivalent');
    expect(record.comparison).toBe('deterministic-structural');
    expect(record.requestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(record.evidenceId).toBe(swapVerificationId);
    expect(record.evidenceId).not.toBe('');
  });

  it('proves the backend actually spoke both native dialects (adapter isolation, not an echo)', () => {
    const syncPaths = backend.requests
      .filter((request) => request.method === 'GET' && (/^\/sync\//.test(request.path) || /\/records$/.test(request.path)))
      .map((request) => request.path);
    expect(syncPaths.some((path) => path.startsWith('/sync/'))).toBe(true);
    expect(syncPaths.some((path) => path.startsWith('/v1/connections/') && path.endsWith('/records'))).toBe(true);
  });
});

describe('connection-broker adapter SDK conformance — behavior unchanged', () => {
  it('both adapters serve the identical canonical capability set (equivalent alternatives by definition)', () => {
    expect(nango.definition.describeCapabilities().capabilities).toEqual(
      embedded.definition.describeCapabilities().capabilities,
    );
    expect([...nango.definition.describeCapabilities().capabilities].sort()).toEqual([
      'oauth-authorization',
      'record-sync',
      'token-refresh',
      'webhook-ingestion',
    ]);
  });

  it('the definitions expose only the canonical SDK surface (no selection, no wire types)', () => {
    for (const definition of [nango.definition, embedded.definition]) {
      expect(definition.sdk).toBe('provider-adapter-definition');
      expect(definition.gateway).toBe('connection-broker');
      expect(Object.keys(definition).sort()).toEqual([
        'describeCapabilities',
        'gateway',
        'mapError',
        'provider',
        'sdk',
        'sdkVersion',
      ]);
    }
  });
});
