// Connection & Integration Hub (W059) — the action surface.
//
// The hub's WRITE path is a thin, explicit dispatcher over the four domain
// contracts it composes (channels W030, sources W036, destinations W037,
// identity/people W002): connect/disconnect/reconnect, re-authorization
// ("configure"), polling/replay for sources, delivery retry/replay for
// destinations, and the full identity verification/linking workflow.
//
// Discipline (scope rules / GOVERNANCE):
//   * the hub implements NO domain logic of its own — every operation
//     delegates to a contract call and lets the module's own validation,
//     tenant scoping and authority checks decide;
//   * connect/configuration takes an OPAQUE `credentialRef` — the hub has no
//     field for a credential VALUE anywhere (acceptance: "tenant-owned
//     credential references only");
//   * body parsing/validation is pure and unit-testable; execution is a
//     separate step so tests can drive the exact same code the /api/connections
//     route drives without booting Next.js.

import type { TenantContext } from '@/infra/tenant';
import {
  completeIdentityChallenge,
  deliverIdentityChallenge,
  registerChannelConnection,
  setChannelConnectionStatus,
} from '@/modules/channels/contract';
import type { ChannelProvider } from '@/modules/channels/contract';
import {
  isSourceProvider,
  pollSource,
  registerSource,
  replaySource,
  setSourceStatus,
} from '@/modules/sources/contract';
import type { SourceProvider } from '@/modules/sources/contract';
import {
  isDestinationProvider,
  registerDestination,
  replayDelivery,
  retryDelivery,
  setDestinationStatus,
} from '@/modules/destinations/contract';
import type { DestinationProvider } from '@/modules/destinations/contract';
import {
  attestIdentity,
  detachSubject,
  isChannelProvider,
  revokeVerification,
  findExternalIdentityByProviderKey,
} from '@/modules/identity/contract';
import {
  linkExternalIdentity,
  createPerson,
} from '@/modules/people/contract';
import type { ExternalIdentity, ChannelProvider as IdentityChannelProvider } from '@/modules/identity/contract';
import type { Person } from '@/modules/people/contract';

// The channels contract re-exports the identity module's provider vocabulary;
// the identity contract exports the runtime guard. Keep the types unified.
type UnifiedChannelProvider = ChannelProvider & IdentityChannelProvider;

// ---------------------------------------------------------------------------
// Action vocabulary
// ---------------------------------------------------------------------------

export const CONNECTIONS_ACTIONS = [
  'channel.register',
  'channel.setStatus',
  'source.register',
  'source.setStatus',
  'source.poll',
  'source.replay',
  'destination.register',
  'destination.setStatus',
  'destination.retry',
  'destination.replay',
  'identity.lookup',
  'identity.challenge',
  'identity.complete',
  'identity.attest',
  'identity.link',
  'identity.detach',
  'identity.revoke',
  'person.create',
] as const;

export type ConnectionsAction = (typeof CONNECTIONS_ACTIONS)[number];

export function isConnectionsAction(value: unknown): value is ConnectionsAction {
  return typeof value === 'string' && (CONNECTIONS_ACTIONS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Parsed inputs (validated shapes; the contracts re-validate authoritatively)
// ---------------------------------------------------------------------------

export type ParsedActionInput =
  | { action: 'channel.register'; provider: UnifiedChannelProvider; providerAccountId: string; displayName: string | null; credentialRef: string }
  | { action: 'channel.setStatus'; connectionId: string; status: 'active' | 'disabled' }
  | {
      action: 'source.register';
      provider: SourceProvider;
      providerAccountId: string;
      displayName: string | null;
      authKind: 'oauth' | 'credentials';
      credentialRef: string;
      oauthScopes: string[];
      oauthExpiresAt: string | null;
    }
  | { action: 'source.setStatus'; sourceId: string; status: 'active' | 'disabled' }
  | { action: 'source.poll'; sourceId: string; maxRecords: number | null }
  | { action: 'source.replay'; sourceId: string; fromStart: boolean }
  | {
      action: 'destination.register';
      provider: DestinationProvider;
      providerAccountId: string;
      displayName: string | null;
      authKind: 'oauth' | 'credentials';
      credentialRef: string;
      oauthScopes: string[];
      oauthExpiresAt: string | null;
    }
  | { action: 'destination.setStatus'; destinationId: string; status: 'active' | 'disabled' }
  | { action: 'destination.retry'; deliveryId: string }
  | { action: 'destination.replay'; deliveryId: string }
  | { action: 'identity.lookup'; provider: UnifiedChannelProvider; providerAccountId: string }
  | { action: 'identity.challenge'; identityId: string }
  | { action: 'identity.complete'; identityId: string; code: string }
  | { action: 'identity.attest'; identityId: string; evidence: string }
  | { action: 'identity.link'; identityId: string; personId: string }
  | { action: 'identity.detach'; identityId: string }
  | { action: 'identity.revoke'; identityId: string; reason: string }
  | { action: 'person.create'; fullName: string; email: string | null };

export type ParseResult =
  | { ok: true; value: ParsedActionInput }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Pure body parsing
// ---------------------------------------------------------------------------

function isObject(body: unknown): body is Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body);
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function requireText(record: Record<string, unknown>, field: string): string | null {
  return text(record[field]) ?? null;
}

function parseStatus(record: Record<string, unknown>): 'active' | 'disabled' | null {
  const status = record['status'];
  return status === 'active' || status === 'disabled' ? status : null;
}

function parseAuthKind(record: Record<string, unknown>): 'oauth' | 'credentials' | null {
  const authKind = record['authKind'];
  return authKind === 'oauth' || authKind === 'credentials' ? authKind : null;
}

function parseScopes(record: Record<string, unknown>): string[] | null {
  const scopes = record['oauthScopes'];
  if (scopes === undefined || scopes === null) return [];
  if (!Array.isArray(scopes)) return null;
  const out: string[] = [];
  for (const scope of scopes) {
    if (typeof scope !== 'string') return null;
    const trimmed = scope.trim();
    if (trimmed !== '') out.push(trimmed);
  }
  return out;
}

function parseExpiry(record: Record<string, unknown>): string | null | 'invalid' {
  const expiry = record['oauthExpiresAt'];
  if (expiry === undefined || expiry === null) return null;
  if (typeof expiry !== 'string' || expiry.trim() === '') return 'invalid';
  const trimmed = expiry.trim();
  return Number.isNaN(Date.parse(trimmed)) ? 'invalid' : trimmed;
}

/**
 * Parse and shape-check one action body. PURE. The domain contracts remain
 * the authoritative validators — this layer only guarantees the shape the
 * dispatcher needs and produces readable 400 messages.
 */
export function parseActionBody(body: unknown): ParseResult {
  if (!isObject(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const action = body['action'];
  if (!isConnectionsAction(action)) {
    return { ok: false, error: `unknown action '${String(action)}' (supported: ${CONNECTIONS_ACTIONS.join(', ')})` };
  }

  switch (action) {
    case 'channel.register': {
      const provider = requireText(body, 'provider');
      const providerAccountId = requireText(body, 'providerAccountId');
      const credentialRef = requireText(body, 'credentialRef');
      if (provider === null || providerAccountId === null || credentialRef === null) {
        return { ok: false, error: 'channel.register requires provider, providerAccountId and credentialRef (an opaque secret-store reference — never a credential value)' };
      }
      if (!isChannelProvider(provider)) {
        return { ok: false, error: `channel.register: '${provider}' is not a channel provider` };
      }
      return {
        ok: true,
        value: {
          action,
          provider,
          providerAccountId,
          displayName: text(body['displayName']),
          credentialRef,
        },
      };
    }
    case 'channel.setStatus':
    case 'source.setStatus':
    case 'destination.setStatus': {
      const idField =
        action === 'channel.setStatus'
          ? 'connectionId'
          : action === 'source.setStatus'
            ? 'sourceId'
            : 'destinationId';
      const id = requireText(body, idField);
      const status = parseStatus(body);
      if (id === null) return { ok: false, error: `${action} requires ${idField}` };
      if (status === null) return { ok: false, error: `${action} requires status 'active' or 'disabled'` };
      if (action === 'channel.setStatus') {
        return { ok: true, value: { action, connectionId: id, status } };
      }
      if (action === 'source.setStatus') {
        return { ok: true, value: { action, sourceId: id, status } };
      }
      return { ok: true, value: { action, destinationId: id, status } };
    }
    case 'source.register':
    case 'destination.register': {
      const provider = requireText(body, 'provider');
      const providerAccountId = requireText(body, 'providerAccountId');
      const credentialRef = requireText(body, 'credentialRef');
      const authKind = parseAuthKind(body);
      if (provider === null || providerAccountId === null || credentialRef === null) {
        return { ok: false, error: `${action} requires provider, providerAccountId and credentialRef (an opaque secret-store reference — never a credential value)` };
      }
      if (authKind === null) {
        return { ok: false, error: `${action} requires authKind 'oauth' or 'credentials'` };
      }
      const scopes = parseScopes(body);
      if (scopes === null) {
        return { ok: false, error: `${action}: oauthScopes must be an array of strings` };
      }
      const expiry = parseExpiry(body);
      if (expiry === 'invalid') {
        return { ok: false, error: `${action}: oauthExpiresAt must be an ISO 8601 timestamp or null` };
      }
      if (action === 'source.register') {
        if (!isSourceProvider(provider)) {
          return { ok: false, error: `source.register: '${provider}' is not a source provider` };
        }
        return {
          ok: true,
          value: {
            action,
            provider,
            providerAccountId,
            displayName: text(body['displayName']),
            authKind,
            credentialRef,
            oauthScopes: scopes,
            oauthExpiresAt: expiry,
          },
        };
      }
      if (!isDestinationProvider(provider)) {
        return { ok: false, error: `destination.register: '${provider}' is not a destination provider` };
      }
      return {
        ok: true,
        value: {
          action,
          provider,
          providerAccountId,
          displayName: text(body['displayName']),
          authKind,
          credentialRef,
          oauthScopes: scopes,
          oauthExpiresAt: expiry,
        },
      };
    }
    case 'source.poll': {
      const sourceId = requireText(body, 'sourceId');
      if (sourceId === null) return { ok: false, error: 'source.poll requires sourceId' };
      const maxRecords = body['maxRecords'];
      if (maxRecords === undefined || maxRecords === null) {
        return { ok: true, value: { action, sourceId, maxRecords: null } };
      }
      if (typeof maxRecords !== 'number' || !Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 200) {
        return { ok: false, error: 'source.poll: maxRecords must be an integer between 1 and 200' };
      }
      return { ok: true, value: { action, sourceId, maxRecords } };
    }
    case 'source.replay': {
      const sourceId = requireText(body, 'sourceId');
      if (sourceId === null) return { ok: false, error: 'source.replay requires sourceId' };
      return { ok: true, value: { action, sourceId, fromStart: true } };
    }
    case 'destination.retry':
    case 'destination.replay': {
      const deliveryId = requireText(body, 'deliveryId');
      if (deliveryId === null) return { ok: false, error: `${action} requires deliveryId` };
      return { ok: true, value: { action, deliveryId } };
    }
    case 'identity.lookup': {
      const provider = requireText(body, 'provider');
      const providerAccountId = requireText(body, 'providerAccountId');
      if (provider === null || providerAccountId === null) {
        return { ok: false, error: 'identity.lookup requires provider and providerAccountId' };
      }
      if (!isChannelProvider(provider)) {
        return { ok: false, error: `identity.lookup: '${provider}' is not a channel provider` };
      }
      return { ok: true, value: { action, provider, providerAccountId } };
    }
    case 'identity.challenge': {
      const identityId = requireText(body, 'identityId');
      if (identityId === null) return { ok: false, error: 'identity.challenge requires identityId' };
      return { ok: true, value: { action, identityId } };
    }
    case 'identity.complete': {
      const identityId = requireText(body, 'identityId');
      const code = requireText(body, 'code');
      if (identityId === null || code === null) {
        return { ok: false, error: 'identity.complete requires identityId and code' };
      }
      return { ok: true, value: { action, identityId, code } };
    }
    case 'identity.attest': {
      const identityId = requireText(body, 'identityId');
      const evidence = requireText(body, 'evidence');
      if (identityId === null || evidence === null) {
        return { ok: false, error: 'identity.attest requires identityId and evidence (requires the identity:attest claim)' };
      }
      return { ok: true, value: { action, identityId, evidence } };
    }
    case 'identity.link': {
      const identityId = requireText(body, 'identityId');
      const personId = requireText(body, 'personId');
      if (identityId === null || personId === null) {
        return { ok: false, error: 'identity.link requires identityId and personId (requires the identity:link claim)' };
      }
      return { ok: true, value: { action, identityId, personId } };
    }
    case 'identity.detach': {
      const identityId = requireText(body, 'identityId');
      if (identityId === null) return { ok: false, error: 'identity.detach requires identityId (requires the identity:link claim)' };
      return { ok: true, value: { action, identityId } };
    }
    case 'identity.revoke': {
      const identityId = requireText(body, 'identityId');
      const reason = requireText(body, 'reason');
      if (identityId === null || reason === null) {
        return { ok: false, error: 'identity.revoke requires identityId and reason (requires the identity:attest claim)' };
      }
      return { ok: true, value: { action, identityId, reason } };
    }
    case 'person.create': {
      const fullName = requireText(body, 'fullName');
      if (fullName === null) return { ok: false, error: 'person.create requires fullName' };
      return { ok: true, value: { action, fullName, email: text(body['email']) } };
    }
  }
}

// ---------------------------------------------------------------------------
// Execution (contract delegation only)
// ---------------------------------------------------------------------------

export interface ActionOutcome {
  action: ConnectionsAction;
  /** One human sentence describing what happened. */
  summary: string;
  /** The contract result (already provider-neutral and credential-free). */
  result: unknown;
}

/** Execute one parsed action against the domain contracts. */
export async function executeConnectionsAction(
  ctx: TenantContext,
  input: ParsedActionInput,
): Promise<ActionOutcome> {
  switch (input.action) {
    case 'channel.register': {
      const registration = await registerChannelConnection(ctx, {
        provider: input.provider,
        providerAccountId: input.providerAccountId,
        displayName: input.displayName,
        credentialRef: input.credentialRef,
      });
      return {
        action: input.action,
        summary: registration.created
          ? `Connected ${input.provider} endpoint ${input.providerAccountId}.`
          : `${input.provider} endpoint ${input.providerAccountId} was already connected (first registration wins — channels have no mutable configuration).`,
        result: registration,
      };
    }
    case 'channel.setStatus': {
      const connection = await setChannelConnectionStatus(ctx, {
        connectionId: input.connectionId,
        status: input.status,
      });
      return {
        action: input.action,
        summary: `Channel endpoint ${input.status === 'active' ? 'reconnected' : 'disconnected'} (${connection.provider}).`,
        result: connection,
      };
    }
    case 'source.register': {
      const registration = await registerSource(ctx, {
        provider: input.provider,
        providerAccountId: input.providerAccountId,
        displayName: input.displayName,
        authKind: input.authKind,
        credentialRef: input.credentialRef,
        oauthScopes: input.oauthScopes,
        oauthExpiresAt: input.oauthExpiresAt,
      });
      return {
        action: input.action,
        summary: registration.created
          ? `Connected source ${input.provider} (${input.providerAccountId}).`
          : `Re-authorized source ${input.provider} (${input.providerAccountId}) — authorization fields updated.`,
        result: registration,
      };
    }
    case 'source.setStatus': {
      const source = await setSourceStatus(ctx, {
        sourceId: input.sourceId,
        status: input.status,
      });
      return {
        action: input.action,
        summary: `Source ${source.provider} ${input.status === 'active' ? 'reconnected' : 'disconnected'}.`,
        result: source,
      };
    }
    case 'source.poll': {
      const poll = await pollSource(ctx, {
        sourceId: input.sourceId,
        ...(input.maxRecords === null ? {} : { maxRecords: input.maxRecords }),
      });
      return {
        action: input.action,
        summary: `Polled ${poll.source.provider}: ${poll.fetched} fetched, ${poll.ingested} new observations, ${poll.duplicates} deduped.`,
        result: poll,
      };
    }
    case 'source.replay': {
      const replay = await replaySource(ctx, {
        sourceId: input.sourceId,
        fromStart: true,
      });
      return {
        action: input.action,
        summary: 'Checkpoint rewound to the beginning — the next poll re-fetches from the start under dedupe.',
        result: replay,
      };
    }
    case 'destination.register': {
      const registration = await registerDestination(ctx, {
        provider: input.provider,
        providerAccountId: input.providerAccountId,
        displayName: input.displayName,
        authKind: input.authKind,
        credentialRef: input.credentialRef,
        oauthScopes: input.oauthScopes,
        oauthExpiresAt: input.oauthExpiresAt,
      });
      return {
        action: input.action,
        summary: registration.created
          ? `Connected destination ${input.provider} (${input.providerAccountId}).`
          : `Re-authorized destination ${input.provider} (${input.providerAccountId}) — authorization fields updated.`,
        result: registration,
      };
    }
    case 'destination.setStatus': {
      const destination = await setDestinationStatus(ctx, {
        destinationId: input.destinationId,
        status: input.status,
      });
      return {
        action: input.action,
        summary: `Destination ${destination.provider} ${input.status === 'active' ? 'reconnected' : 'disconnected'}.`,
        result: destination,
      };
    }
    case 'destination.retry': {
      const retry = await retryDelivery(ctx, { deliveryId: input.deliveryId });
      return {
        action: input.action,
        summary:
          retry.delivery.status === 'delivered'
            ? 'Delivery retried — the provider accepted the batch.'
            : retry.delivery.status === 'pending'
              ? 'Delivery is still gated — the authority gate has not released it yet (an approval may be needed).'
              : `Delivery retry ended '${retry.delivery.status}'.`,
        result: retry,
      };
    }
    case 'destination.replay': {
      const replay = await replayDelivery(ctx, { deliveryId: input.deliveryId });
      return {
        action: input.action,
        summary: 'Re-dispatched as a new delivery under a fresh full gate authorization.',
        result: replay,
      };
    }
    case 'identity.lookup': {
      const identity = await findExternalIdentityByProviderKey(ctx, {
        provider: input.provider,
        providerAccountId: input.providerAccountId,
      });
      return {
        action: input.action,
        summary: identity === null ? 'No identity found for that provider account.' : 'Identity found.',
        result: identity,
      };
    }
    case 'identity.challenge': {
      const delivery = await deliverIdentityChallenge(ctx, { identityId: input.identityId });
      return {
        action: input.action,
        summary: `Verification code delivered over the identity's own channel — expires ${delivery.expiresAt}.`,
        result: delivery,
      };
    }
    case 'identity.complete': {
      const identity = await completeIdentityChallenge(ctx, {
        identityId: input.identityId,
        code: input.code,
      });
      return {
        action: input.action,
        summary: 'Verification code accepted — the identity is now verified.',
        result: identity,
      };
    }
    case 'identity.attest': {
      const identity = await attestIdentity(ctx, {
        identityId: input.identityId,
        evidence: input.evidence,
      });
      return {
        action: input.action,
        summary: 'Admin attestation recorded — the identity is now verified.',
        result: identity,
      };
    }
    case 'identity.link': {
      const identity = await linkExternalIdentity(ctx, {
        identityId: input.identityId,
        personId: input.personId,
      });
      return {
        action: input.action,
        summary: 'Verified identity linked to its person record.',
        result: identity,
      };
    }
    case 'identity.detach': {
      const identity = await detachSubject(ctx, { identityId: input.identityId });
      return {
        action: input.action,
        summary: 'Identity detached from its subject.',
        result: identity,
      };
    }
    case 'identity.revoke': {
      const identity = await revokeVerification(ctx, {
        identityId: input.identityId,
        reason: input.reason,
      });
      return {
        action: input.action,
        summary: 'Verification revoked — the identity resolves to nothing until re-attested.',
        result: identity,
      };
    }
    case 'person.create': {
      const person = await createPerson(ctx, {
        fullName: input.fullName,
        email: input.email,
      });
      return {
        action: input.action,
        summary: `Person record created — link verified identities to ${person.id}.`,
        result: person,
      };
    }
  }
}

// Re-exported for the view builder / tests.
export type { ExternalIdentity, Person };
