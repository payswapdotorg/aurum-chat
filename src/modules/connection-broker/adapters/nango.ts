// Nango broker adapter (MODULE-INTERNAL — the managed broker's native wire
// dialect never crosses this file; lock 16 analog / IMPLEMENTATION-STACK
// §6 provider isolation).
//
// W082: "Support a pluggable managed connection broker with Nango as the
// first candidate" — this adapter speaks the Nango-shaped HTTP dialect:
//
//   beginAuthorization   (no API roundtrip) — the OAuth hand-off is a
//     static URL: {base}/oauth/connect?connection_id=<domain connection
//     id>&provider_config_key=<provider>[&scopes=<csv>][&redirect_uri=…]
//   completeAuthorization  GET /connection/{connectionId}?provider_config_key=…
//     with the instance secret on the Authorization header → the connection
//     metadata (credentials EXPIRY + scopes, connection_config.account_id).
//     The response carries raw token values — they are DISCARDED here; the
//     canonical grant carries only the OPAQUE credentialRef
//     `nango-connection:<connectionId>` (Nango holds the tokens).
//   refreshGrant          POST /connection/refresh { connection_id,
//     provider_config_key } then GET /connection/{id} for the new expiry.
//   revokeConnection      DELETE /connection/{id}?provider_config_key=…
//   pullSyncRecords       GET /sync/{id}/records?delta=*&limit=…&cursor=…
//     → { records: [{ id, kind, occurredAt, data }], nextCursor }
//   parseWebhook          the Nango-forwarded envelope: { connectionId,
//     providerConfigKey, deliveryId?, occurredAt, records: [...] }
//
// The adapter is constructed with { baseUrl, secretKey, httpClient } — the
// instance SECRET is wiring-time configuration (never domain state, never a
// contract result). Construction also consults the W089 OSS technology
// registry: the Nango entry must exist (the Tech Lead's evaluation record —
// provider-sdk registry, seeded from spec/TECHNOLOGY-RESEARCH-2026-09-23).
//
// Alongside its port duties this adapter is a conforming W089
// ProviderAdapterDefinition (canonical lifecycle, capabilities, error
// normalization — proven by the module's conformance suite).

import { now } from '@/infra/clock';
import {
  canonicalFailure,
  createProviderAdapterDefinition,
  findTechnologyEntry,
  type CanonicalErrorCategory,
  type ProviderAdapterDefinition,
} from '@/modules/provider-sdk/contract';
import type {
  BrokerAuthorizationCallback,
  BrokerAuthorizationRequest,
  BrokerAuthorizationSession,
  BrokerConnectionGrant,
  BrokerHttpClient,
  BrokerRefreshRequest,
  BrokerRevokeRequest,
  BrokerSyncRequest,
  BrokerSyncResult,
  BrokerWebhookParseResult,
  ConnectionBroker,
} from '../types';
import {
  BROKER_CAPABILITIES,
  BROKER_GATEWAY,
  BrokerAdapterError,
  createDialectHelpers,
  performRequest,
} from './shared';

/** The canonical broker key of the Nango adapter. */
export const NANGO_BROKER_KEY = 'nango';

export interface NangoBrokerConfig {
  /** The Nango instance base URL (no trailing slash). */
  baseUrl: string;
  /** The Nango instance secret key — wiring-time config, never persisted. */
  secretKey: string;
  /** The injected network client (real fetch adapter or a test double). */
  httpClient: BrokerHttpClient;
}

function classifyNangoError(error: unknown): CanonicalErrorCategory | null {
  if (error instanceof BrokerAdapterError) return error.failure.category;
  if (error instanceof Error) {
    if (/connection not found|unknown connection/i.test(error.message)) return 'auth_failure';
  }
  return null;
}

/** Mint the Nango managed-broker adapter (throws if Nango is not in the W089 registry). */
export function createNangoBroker(config: NangoBrokerConfig): ConnectionBroker {
  const registry = findTechnologyEntry(NANGO_BROKER_KEY);
  if (registry === null) {
    throw new Error(
      'the Nango managed broker cannot be wired: no W089 technology-registry entry exists for it (open-source reuse gate, IMPLEMENTATION-STACK post-S002 addendum)',
    );
  }
  const helpers = createDialectHelpers(NANGO_BROKER_KEY);
  const base = config.baseUrl.replace(/\/+$/, '');
  const authHeaders: Record<string, string> = {
    Authorization: `Bearer ${config.secretKey}`,
  };

  const definition: ProviderAdapterDefinition = createProviderAdapterDefinition({
    gateway: BROKER_GATEWAY,
    provider: NANGO_BROKER_KEY,
    capabilities: BROKER_CAPABILITIES,
    classifyError: classifyNangoError,
  });

  async function getConnectionMetadata(
    provider: string,
    connectionId: string,
  ): Promise<BrokerConnectionGrant> {
    const body = await performRequest(config.httpClient, NANGO_BROKER_KEY, {
      method: 'GET',
      path: `/connection/${encodeURIComponent(connectionId)}`,
      query: { provider_config_key: provider },
      headers: authHeaders,
    });
    const envelope = helpers.requireObject(body, 'the nango connection metadata');
    const connectionIdOut = helpers.requireString(envelope.connection_id, 'the nango connection_id');
    const configKey = helpers.requireString(
      envelope.provider_config_key,
      'the nango provider_config_key',
    );
    if (configKey !== provider || connectionIdOut !== connectionId) {
      throw helpers.malformed(
        'the nango connection metadata',
        `does not describe the requested connection (${connectionIdOut}/${configKey})`,
      );
    }
    const connectionConfig = helpers.requireObject(
      envelope.connection_config,
      'the nango connection_config',
    );
    const accountId = helpers.requireString(
      connectionConfig.account_id,
      'the nango connection_config.account_id',
    );
    const credentials = helpers.requireObject(
      envelope.credentials,
      'the nango credentials',
    );
    // NON-SECRET authorization state only. The credential values
    // (access_token / refresh_token / raw_api_key) inside `credentials`
    // are deliberately DISCARDED here — Nango keeps holding them; Aurum
    // never sees a token value (W082 credential isolation).
    const expiresAt = helpers.optionalIsoInstant(
      credentials.expires_at,
      'the nango credentials.expires_at',
    );
    const scopes = Array.isArray(credentials.scopes)
      ? helpers.requireStringArray(credentials.scopes, 'the nango credentials.scopes')
      : [];
    return {
      brokerConnectionId: connectionId,
      providerAccountId: accountId,
      credentialRef: `nango-connection:${connectionId}`,
      scopes,
      expiresAt,
    };
  }

  return {
    key: NANGO_BROKER_KEY,
    definition,

    async beginAuthorization(
      request: BrokerAuthorizationRequest,
    ): Promise<BrokerAuthorizationSession> {
      // The Nango OAuth hand-off is a static URL — no API roundtrip.
      const query: Record<string, string> = {
        connection_id: request.connectionId,
        provider_config_key: request.provider,
      };
      if (request.scopes.length > 0) query['scopes'] = request.scopes.join(',');
      if (request.redirectTo !== null) query['redirect_uri'] = request.redirectTo;
      const search = new URLSearchParams(query).toString();
      return {
        authorizationUrl: `${base}/oauth/connect?${search}`,
        // The domain connection id doubles as the state token (Nango echoes
        // it through the callback). Opaque, one-time, non-secret.
        state: request.connectionId,
        expiresAt: new Date(now().getTime() + 15 * 60_000).toISOString(),
      };
    },

    async completeAuthorization(
      callback: BrokerAuthorizationCallback,
    ): Promise<BrokerConnectionGrant> {
      // Nango completed the OAuth dance broker-side; Aurum only ever
      // fetches the non-secret grant metadata. The echoed state pins the
      // handshake to this exact connection (defense in depth — the service
      // validated it against the pending authorization first).
      if (callback.state !== callback.connectionId) {
        const failure = canonicalFailure('auth_failure', {
          gateway: BROKER_GATEWAY,
          provider: NANGO_BROKER_KEY,
          detail: 'the nango callback state does not match the connection being completed',
        });
        throw new BrokerAdapterError(
          failure,
          `the nango callback state does not match the connection (expected '${callback.connectionId}')`,
        );
      }
      return getConnectionMetadata(callback.provider, callback.connectionId);
    },

    async refreshGrant(request: BrokerRefreshRequest): Promise<BrokerConnectionGrant> {
      await performRequest(config.httpClient, NANGO_BROKER_KEY, {
        method: 'POST',
        path: '/connection/refresh',
        headers: authHeaders,
        body: {
          connection_id: request.brokerConnectionId,
          provider_config_key: request.provider,
        },
      });
      return getConnectionMetadata(request.provider, request.brokerConnectionId);
    },

    async revokeConnection(request: BrokerRevokeRequest): Promise<void> {
      await performRequest(config.httpClient, NANGO_BROKER_KEY, {
        method: 'DELETE',
        path: `/connection/${encodeURIComponent(request.brokerConnectionId)}`,
        query: { provider_config_key: request.provider },
        headers: authHeaders,
      });
    },

    async pullSyncRecords(request: BrokerSyncRequest): Promise<BrokerSyncResult> {
      const body = await performRequest(config.httpClient, NANGO_BROKER_KEY, {
        method: 'GET',
        path: `/sync/${encodeURIComponent(request.brokerConnectionId)}/records`,
        query: {
          delta: '*',
          limit: request.maxRecords,
          ...(request.cursor === null ? {} : { cursor: request.cursor }),
        },
        headers: authHeaders,
      });
      const envelope = helpers.requireObject(body, 'the nango sync result');
      const rawRecords = helpers.requireRecords(envelope.records, 'the nango sync records');
      const records = rawRecords.map((entry) => parseNangoRecord(helpers, entry));
      const nextCursor = helpers.optionalString(envelope.nextCursor, 'the nango nextCursor');
      return { records, nextCursor, hasMore: nextCursor !== null };
    },

    parseWebhook(payload: unknown): BrokerWebhookParseResult {
      const envelope = helpers.requireObject(payload, 'the nango webhook envelope');
      const connectionId = helpers.requireString(envelope.connectionId, 'the nango connectionId');
      const providerConfigKey = helpers.requireString(
        envelope.providerConfigKey,
        'the nango providerConfigKey',
      );
      // The envelope must self-declare its provider binding; the caller
      // resolves the connection tenant-side (opaque ids only).
      void providerConfigKey;
      const deliveryId = helpers.optionalString(envelope.deliveryId, 'the nango deliveryId');
      const occurredAt = helpers.requireIsoInstant(envelope.occurredAt, 'the nango occurredAt');
      const rawRecords = helpers.requireRecords(envelope.records, 'the nango webhook records');
      return {
        brokerConnectionId: connectionId,
        deliveryId,
        occurredAt,
        records: rawRecords.map((entry) => parseNangoRecord(helpers, entry)),
      };
    },
  };
}

function parseNangoRecord(
  helpers: ReturnType<typeof createDialectHelpers>,
  entry: Record<string, unknown>,
): { providerRecordId: string; kind: string; payload: unknown; occurredAt: string } {
  const providerRecordId = helpers.requireString(entry.id, 'the nango record id');
  const kind = helpers.requireString(entry.kind, 'the nango record kind');
  const occurredAt = helpers.requireIsoInstant(entry.occurredAt, 'the nango record occurredAt');
  return { providerRecordId, kind, payload: entry.data ?? null, occurredAt };
}
