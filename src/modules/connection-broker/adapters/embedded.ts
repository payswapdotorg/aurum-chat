// Embedded broker adapter (MODULE-INTERNAL — the self-managed equivalent
// alternative to the Nango managed broker; its native wire dialect never
// crosses this file).
//
// W082: "…and equivalent alternatives" + the acceptance "broker replacement
// does not change domain contracts". This adapter proves it: a materially
// DIFFERENT broker implementation (self-managed OAuth dance, broker-minted
// connection ids `emb_<hex>`, snake_case wire dialect, refresh endpoints
// with their own shapes) serving the SAME canonical broker port, so the
// domain above the port is unchanged whichever broker backs a connection.
//
// Dialect:
//   beginAuthorization   POST /v1/authorizations
//     { connection_id, provider, scopes, redirect_to? }
//       → { authorization_url, state, expires_at }
//   completeAuthorization POST /v1/authorizations/{connection_id}/callback
//     { state } → { broker_connection_id, provider_account_id,
//                   credential_ref, scopes, expires_at }
//     (the embedded broker never returns token values at all — they live
//      in its credential store behind the opaque credential_ref)
//   refreshGrant          POST /v1/connections/{broker_connection_id}/refresh
//                           → { credential_ref, scopes, expires_at }
//   revokeConnection      DELETE /v1/connections/{broker_connection_id}
//   pullSyncRecords       GET /v1/connections/{id}/records?cursor&limit
//                           → { records: [{ id, kind, occurred_at, data }],
//                               next_cursor, has_more }
//   parseWebhook          { connection_id, delivery_id?, occurred_at,
//                           records: [...] }
//
// Construction config { baseUrl, apiToken, httpClient }: the instance token
// is wiring-time configuration (never domain state). The adapter is a
// conforming W089 ProviderAdapterDefinition like every broker adapter.

import {
  createProviderAdapterDefinition,
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

/** The canonical broker key of the embedded alternative adapter. */
export const EMBEDDED_BROKER_KEY = 'embedded';

export interface EmbeddedBrokerConfig {
  /** The embedded broker instance base URL — the client resolves request paths against it. */
  baseUrl: string;
  /** The instance API token — wiring-time config, never persisted. */
  apiToken: string;
  /** The injected network client (real fetch adapter or a test double). */
  httpClient: BrokerHttpClient;
}

function classifyEmbeddedError(error: unknown): CanonicalErrorCategory | null {
  if (error instanceof BrokerAdapterError) return error.failure.category;
  if (error instanceof Error) {
    if (/authorization session (expired|unknown)/i.test(error.message)) return 'auth_failure';
    if (/authorization (?:was )?declined/i.test(error.message)) return 'permission_denied';
  }
  return null;
}

/** Mint the embedded (self-managed) broker adapter. */
export function createEmbeddedBroker(config: EmbeddedBrokerConfig): ConnectionBroker {
  const helpers = createDialectHelpers(EMBEDDED_BROKER_KEY);
  // Request paths are broker-relative: the injected http client resolves
  // them against the instance base URL (client and adapter are constructed
  // together at wiring time); `baseUrl` documents the instance endpoint.
  const authHeaders: Record<string, string> = {
    Authorization: `Bearer ${config.apiToken}`,
  };

  const definition: ProviderAdapterDefinition = createProviderAdapterDefinition({
    gateway: BROKER_GATEWAY,
    provider: EMBEDDED_BROKER_KEY,
    capabilities: BROKER_CAPABILITIES,
    classifyError: classifyEmbeddedError,
  });

  return {
    key: EMBEDDED_BROKER_KEY,
    definition,

    async beginAuthorization(
      request: BrokerAuthorizationRequest,
    ): Promise<BrokerAuthorizationSession> {
      const body = await performRequest(config.httpClient, EMBEDDED_BROKER_KEY, {
        method: 'POST',
        path: '/v1/authorizations',
        headers: authHeaders,
        body: {
          connection_id: request.connectionId,
          provider: request.provider,
          scopes: request.scopes,
          redirect_to: request.redirectTo,
        },
      });
      const envelope = helpers.requireObject(body, 'the embedded authorization session');
      const authorizationUrl = helpers.requireString(
        envelope.authorization_url,
        'the embedded authorization_url',
      );
      const state = helpers.requireString(envelope.state, 'the embedded state');
      const expiresAt = helpers.requireIsoInstant(
        envelope.expires_at,
        'the embedded expires_at',
      );
      return { authorizationUrl, state, expiresAt };
    },

    async completeAuthorization(
      callback: BrokerAuthorizationCallback,
    ): Promise<BrokerConnectionGrant> {
      const body = await performRequest(config.httpClient, EMBEDDED_BROKER_KEY, {
        method: 'POST',
        path: `/v1/authorizations/${encodeURIComponent(callback.connectionId)}/callback`,
        headers: authHeaders,
        body: { state: callback.state },
      });
      const envelope = helpers.requireObject(body, 'the embedded connection grant');
      return {
        brokerConnectionId: helpers.requireString(
          envelope.broker_connection_id,
          'the embedded broker_connection_id',
        ),
        providerAccountId: helpers.requireString(
          envelope.provider_account_id,
          'the embedded provider_account_id',
        ),
        credentialRef: helpers.requireString(
          envelope.credential_ref,
          'the embedded credential_ref',
        ),
        scopes: helpers.requireStringArray(envelope.scopes, 'the embedded scopes'),
        expiresAt: helpers.optionalIsoInstant(
          envelope.expires_at,
          'the embedded expires_at',
        ),
      };
    },

    async refreshGrant(request: BrokerRefreshRequest): Promise<BrokerConnectionGrant> {
      const body = await performRequest(config.httpClient, EMBEDDED_BROKER_KEY, {
        method: 'POST',
        path: `/v1/connections/${encodeURIComponent(request.brokerConnectionId)}/refresh`,
        headers: authHeaders,
        body: {},
      });
      const envelope = helpers.requireObject(body, 'the embedded refresh grant');
      const credentialRef = helpers.requireString(
        envelope.credential_ref,
        'the embedded refresh credential_ref',
      );
      if (credentialRef !== request.credentialRef) {
        // The embedded broker rotates its opaque reference on refresh; both
        // sides must stay pinned to the same credential-store entry.
        throw helpers.malformed(
          'the embedded refresh grant',
          'changed the credential reference of the connection being refreshed',
        );
      }
      return {
        brokerConnectionId: request.brokerConnectionId,
        providerAccountId: helpers.requireString(
          envelope.provider_account_id,
          'the embedded refresh provider_account_id',
        ),
        credentialRef,
        scopes: helpers.requireStringArray(envelope.scopes, 'the embedded refresh scopes'),
        expiresAt: helpers.optionalIsoInstant(
          envelope.expires_at,
          'the embedded refresh expires_at',
        ),
      };
    },

    async revokeConnection(request: BrokerRevokeRequest): Promise<void> {
      await performRequest(config.httpClient, EMBEDDED_BROKER_KEY, {
        method: 'DELETE',
        path: `/v1/connections/${encodeURIComponent(request.brokerConnectionId)}`,
        headers: authHeaders,
      });
    },

    async pullSyncRecords(request: BrokerSyncRequest): Promise<BrokerSyncResult> {
      const body = await performRequest(config.httpClient, EMBEDDED_BROKER_KEY, {
        method: 'GET',
        path: `/v1/connections/${encodeURIComponent(request.brokerConnectionId)}/records`,
        query: {
          limit: request.maxRecords,
          ...(request.cursor === null ? {} : { cursor: request.cursor }),
        },
        headers: authHeaders,
      });
      const envelope = helpers.requireObject(body, 'the embedded sync result');
      const rawRecords = helpers.requireRecords(envelope.records, 'the embedded sync records');
      const records = rawRecords.map((entry) => parseEmbeddedRecord(helpers, entry));
      const nextCursor = helpers.optionalString(envelope.next_cursor, 'the embedded next_cursor');
      const hasMore = envelope.has_more === undefined ? nextCursor !== null : envelope.has_more === true;
      return { records, nextCursor, hasMore };
    },

    parseWebhook(payload: unknown): BrokerWebhookParseResult {
      const envelope = helpers.requireObject(payload, 'the embedded webhook envelope');
      const brokerConnectionId = helpers.requireString(
        envelope.connection_id,
        'the embedded connection_id',
      );
      const deliveryId = helpers.optionalString(envelope.delivery_id, 'the embedded delivery_id');
      const occurredAt = helpers.requireIsoInstant(envelope.occurred_at, 'the embedded occurred_at');
      const rawRecords = helpers.requireRecords(envelope.records, 'the embedded webhook records');
      return {
        brokerConnectionId,
        deliveryId,
        occurredAt,
        records: rawRecords.map((entry) => parseEmbeddedRecord(helpers, entry)),
      };
    },
  };
}

function parseEmbeddedRecord(
  helpers: ReturnType<typeof createDialectHelpers>,
  entry: Record<string, unknown>,
): { providerRecordId: string; kind: string; payload: unknown; occurredAt: string } {
  const providerRecordId = helpers.requireString(entry.id, 'the embedded record id');
  const kind = helpers.requireString(entry.kind, 'the embedded record kind');
  const occurredAt = helpers.requireIsoInstant(entry.occurred_at, 'the embedded record occurred_at');
  return { providerRecordId, kind, payload: entry.data ?? null, occurredAt };
}
