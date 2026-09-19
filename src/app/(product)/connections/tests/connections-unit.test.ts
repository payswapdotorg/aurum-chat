// Unit tests for the Connection & Integration Hub (W059) — pure logic only,
// no database: context resolution, health/freshness derivations, action-body
// parsing, API error mapping and the provider catalog.

import { describe, expect, it } from 'vitest';
import {
  CONNECTIONS_OPERATOR_PRINCIPAL,
  resolveConnectionsContext,
  scopeQuery,
} from '../lib/context';
import {
  OAUTH_EXPIRING_WITHIN_SECONDS,
  ageSeconds,
  channelHealth,
  countByLevel,
  destinationHealth,
  humanAge,
  sourceHealth,
  worstLevel,
} from '../lib/health';
import { CONNECTIONS_ACTIONS, isConnectionsAction, parseActionBody } from '../lib/actions';
import type { ParsedActionInput } from '../lib/actions';
import { connectionsApiError } from '../lib/api';
import {
  catalogEntry,
  channelCatalog,
  destinationCatalog,
  destinationCategoryOf,
  providerLabel,
  sourceCatalog,
} from '../lib/catalog';
import { CHANNEL_PROVIDERS } from '@/modules/identity/contract';

const NOW = '2026-09-18T12:00:00.000Z';
const HOUR = 3600;

// ---------------------------------------------------------------------------
// Context resolution (the documented dev seam until W058)
// ---------------------------------------------------------------------------

describe('connections context resolution', () => {
  it('rejects a missing tenant with actionable guidance', () => {
    const result = resolveConnectionsContext({ tenant: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe('missing_tenant');
      expect(result.detail).toContain('x-aurum-tenant');
    }
  });

  it('rejects a non-uuid tenant', () => {
    const result = resolveConnectionsContext({ tenant: 'acme' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('invalid_tenant');
  });

  it('defaults the principal to the connections operator and parses authority claims', () => {
    const result = resolveConnectionsContext({
      tenant: '9f0bdbaa-1d2f-4b6f-8f97-2c6ff6b64b6f',
      authority: 'identity:attest, identity:link,,identity:attest',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.principalExplicit).toBe(false);
      expect(result.context.principalId).toBe(CONNECTIONS_OPERATOR_PRINCIPAL);
      expect(result.context.tenantId).toBe('9f0bdbaa-1d2f-4b6f-8f97-2c6ff6b64b6f');
      expect(result.context.authority).toEqual(['identity:attest', 'identity:link']);
    }
  });

  it('rejects a non-uuid principal and lowercases explicit ids', () => {
    const bad = resolveConnectionsContext({
      tenant: '9f0bdbaa-1d2f-4b6f-8f97-2c6ff6b64b6f',
      principal: 'maya',
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.failure).toBe('invalid_principal');

    const good = resolveConnectionsContext({
      tenant: '9F0BDBAA-1D2F-4B6F-8F97-2C6FF6B64B6F',
      principal: '1C8E0CB6-7F8D-4C7D-9D1B-7D31C1C59A22',
    });
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.context.tenantId).toBe('9f0bdbaa-1d2f-4b6f-8f97-2c6ff6b64b6f');
      expect(good.context.principalId).toBe('1c8e0cb6-7f8d-4c7d-9d1b-7d31c1c59a22');
    }
  });

  it('serializes scope into a preserved query string', () => {
    const query = scopeQuery(
      { tenant: 't', principal: 'p', authority: 'a,b' },
      { identity_provider: 'whatsapp' },
    );
    expect(query).toBe('?tenant=t&principal=p&authority=a%2Cb&identity_provider=whatsapp');
    expect(scopeQuery({ tenant: null, principal: null, authority: null })).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Health derivations
// ---------------------------------------------------------------------------

describe('channel health', () => {
  it('treats an unconnected provider as a non-fault', () => {
    const health = channelHealth({ status: null, transportWired: false, lastActivityAt: null, now: NOW });
    expect(health.level).toBe('ok');
    expect(health.reasons).toEqual([]);
  });

  it('marks a disabled endpoint as disconnected', () => {
    const health = channelHealth({ status: 'disabled', transportWired: true, lastActivityAt: null, now: NOW });
    expect(health.level).toBe('disabled');
  });

  it('degrades an active endpoint without a wired delivery transport', () => {
    const health = channelHealth({
      status: 'active',
      transportWired: false,
      lastActivityAt: NOW,
      now: NOW,
    });
    expect(health.level).toBe('degraded');
    expect(health.reasons.some((reason) => reason.text.includes('provider_unavailable'))).toBe(true);
  });

  it('reports healthy when active, wired and recently active', () => {
    const health = channelHealth({
      status: 'active',
      transportWired: true,
      lastActivityAt: new Date(Date.parse(NOW) - HOUR * 1000).toISOString(),
      now: NOW,
    });
    expect(health.level).toBe('ok');
    expect(health.reasons).toEqual([]);
  });

  it('notes a quiet (but healthy) channel without degrading it', () => {
    const health = channelHealth({
      status: 'active',
      transportWired: true,
      lastActivityAt: new Date(Date.parse(NOW) - 30 * 24 * HOUR * 1000).toISOString(),
      now: NOW,
    });
    expect(health.level).toBe('attention');
    expect(health.reasons.some((reason) => reason.level === 'info')).toBe(true);
  });
});

describe('source health', () => {
  it('treats an unconnected source as a non-fault and a disabled one as disconnected', () => {
    expect(
      sourceHealth({
        status: null,
        oauthExpiresAt: null,
        checkpointUpdatedAt: null,
        freshness: 'unknown',
        now: NOW,
      }).level,
    ).toBe('ok');
    expect(
      sourceHealth({
        status: 'disabled',
        oauthExpiresAt: null,
        checkpointUpdatedAt: NOW,
        freshness: 'current',
        now: NOW,
      }).level,
    ).toBe('disabled');
  });

  it('degrades a lapsed OAuth grant (polls will fail)', () => {
    const health = sourceHealth({
      status: 'active',
      oauthExpiresAt: new Date(Date.parse(NOW) - HOUR * 1000).toISOString(),
      checkpointUpdatedAt: NOW,
      freshness: 'current',
      now: NOW,
    });
    expect(health.level).toBe('degraded');
    expect(health.reasons.some((reason) => reason.text.includes('lapsed'))).toBe(true);
  });

  it('flags a grant expiring within the threshold as attention', () => {
    const health = sourceHealth({
      status: 'active',
      oauthExpiresAt: new Date(Date.parse(NOW) + (OAUTH_EXPIRING_WITHIN_SECONDS - HOUR) * 1000).toISOString(),
      checkpointUpdatedAt: NOW,
      freshness: 'current',
      now: NOW,
    });
    expect(health.level).toBe('attention');
    expect(health.reasons.some((reason) => reason.text.includes('expires soon'))).toBe(true);
  });

  it('marks a never-polled source for attention', () => {
    const health = sourceHealth({
      status: 'active',
      oauthExpiresAt: null,
      checkpointUpdatedAt: null,
      freshness: 'unknown',
      now: NOW,
    });
    expect(health.level).toBe('attention');
    expect(health.reasons.some((reason) => reason.text.includes('Never polled'))).toBe(true);
  });

  it('degrades stale evidence, flags aging evidence, and notes unknown policy without faulting', () => {
    expect(
      sourceHealth({
        status: 'active',
        oauthExpiresAt: null,
        checkpointUpdatedAt: NOW,
        freshness: 'stale',
        now: NOW,
      }).level,
    ).toBe('degraded');
    expect(
      sourceHealth({
        status: 'active',
        oauthExpiresAt: null,
        checkpointUpdatedAt: NOW,
        freshness: 'aging',
        now: NOW,
      }).level,
    ).toBe('attention');
    const unknown = sourceHealth({
      status: 'active',
      oauthExpiresAt: null,
      checkpointUpdatedAt: NOW,
      freshness: 'unknown',
      now: NOW,
    });
    expect(unknown.level).toBe('ok');
    expect(unknown.reasons.some((reason) => reason.text.includes('freshness policy'))).toBe(true);
  });
});

describe('destination health', () => {
  it('degrades failed deliveries and rejected latest deliveries', () => {
    expect(
      destinationHealth({
        status: 'active',
        oauthExpiresAt: null,
        deliveries: { total: 3, pending: 0, delivered: 1, failed: 2, rejected: 0, lastStatus: 'failed', lastAt: NOW },
        now: NOW,
      }).level,
    ).toBe('degraded');
    expect(
      destinationHealth({
        status: 'active',
        oauthExpiresAt: null,
        deliveries: { total: 1, pending: 0, delivered: 0, failed: 0, rejected: 1, lastStatus: 'rejected', lastAt: NOW },
        now: NOW,
      }).level,
    ).toBe('degraded');
  });

  it('treats pending deliveries as informational (the default export gate holds them)', () => {
    const health = destinationHealth({
      status: 'active',
      oauthExpiresAt: null,
      deliveries: { total: 2, pending: 2, delivered: 0, failed: 0, rejected: 0, lastStatus: 'pending', lastAt: NOW },
      now: NOW,
    });
    expect(health.level).toBe('ok');
    expect(health.reasons.some((reason) => reason.text.includes('pending is the normal state'))).toBe(
      true,
    );
  });

  it('degrades a lapsed authorization grant', () => {
    const health = destinationHealth({
      status: 'active',
      oauthExpiresAt: new Date(Date.parse(NOW) - 60 * 1000).toISOString(),
      deliveries: { total: 0, pending: 0, delivered: 0, failed: 0, rejected: 0, lastStatus: null, lastAt: null },
      now: NOW,
    });
    expect(health.level).toBe('degraded');
  });
});

describe('health helpers', () => {
  it('orders health levels and counts them', () => {
    expect(worstLevel('ok', 'degraded')).toBe('degraded');
    expect(worstLevel('attention', 'ok')).toBe('attention');
    expect(worstLevel('disabled', 'degraded')).toBe('disabled');
    expect(countByLevel(['ok', 'ok', 'degraded', 'attention'])).toEqual({
      ok: 2,
      attention: 1,
      degraded: 1,
      disabled: 0,
    });
  });

  it('computes ages and human labels', () => {
    expect(ageSeconds(null, NOW)).toBeNull();
    expect(ageSeconds(NOW, NOW)).toBe(0);
    expect(ageSeconds(new Date(Date.parse(NOW) - 90 * 1000).toISOString(), NOW)).toBe(90);
    expect(ageSeconds('not-a-date', NOW)).toBeNull();
    expect(humanAge(null, NOW)).toBe('never');
    expect(humanAge(NOW, NOW)).toBe('0s');
    expect(humanAge(new Date(Date.parse(NOW) - 5 * 60 * 1000).toISOString(), NOW)).toBe('5m');
    expect(humanAge(new Date(Date.parse(NOW) - 3 * 24 * HOUR * 1000).toISOString(), NOW)).toBe('3d');
  });
});

// ---------------------------------------------------------------------------
// Action body parsing (the hub's write-path shape checks)
// ---------------------------------------------------------------------------

describe('action body parsing', () => {
  /** Assert-parse helper: returns the value or throws (keeps tests type-safe). */
  function parsed(body: unknown): ParsedActionInput {
    const result = parseActionBody(body);
    if (!result.ok) throw new Error(`expected parse success, got: ${result.error}`);
    return result.value;
  }

  /** Assert-fail helper: returns the error message or throws. */
  function parseFailure(body: unknown): string {
    const result = parseActionBody(body);
    if (result.ok) throw new Error('expected parse failure');
    return result.error;
  }

  it('rejects non-object bodies and unknown actions', () => {
    expect(parseActionBody(null).ok).toBe(false);
    expect(parseActionBody('channel.register').ok).toBe(false);
    expect(parseFailure({ action: 'nope' })).toContain('unknown action');
    expect(isConnectionsAction('channel.register')).toBe(true);
    expect(isConnectionsAction('nope')).toBe(false);
    expect(CONNECTIONS_ACTIONS).toContain('identity.challenge');
  });

  it('parses a channel registration and refuses missing fields', () => {
    const value = parsed({
      action: 'channel.register',
      provider: 'whatsapp',
      providerAccountId: '+15550100001',
      credentialRef: 'secret-store://tenant/wa',
      displayName: '  Acme line  ',
    });
    expect(value.action).toBe('channel.register');
    if (value.action === 'channel.register') {
      expect(value.provider).toBe('whatsapp');
      expect(value.displayName).toBe('Acme line');
      expect(value.credentialRef).toBe('secret-store://tenant/wa');
    }
    expect(parseFailure({ action: 'channel.register', provider: 'whatsapp' })).toContain('credentialRef');
    expect(
      parseActionBody({
        action: 'channel.register',
        provider: 'semaphore',
        providerAccountId: 'x',
        credentialRef: 'ref',
      }).ok,
    ).toBe(false);
  });

  it('parses status toggles with per-kind id fields', () => {
    const channel = parsed({ action: 'channel.setStatus', connectionId: 'c1', status: 'disabled' });
    if (channel.action === 'channel.setStatus') {
      expect(channel.connectionId).toBe('c1');
      expect(channel.status).toBe('disabled');
    }
    const source = parsed({ action: 'source.setStatus', sourceId: 's1', status: 'active' });
    if (source.action === 'source.setStatus') expect(source.status).toBe('active');
    const destination = parsed({ action: 'destination.setStatus', destinationId: 'd1', status: 'active' });
    if (destination.action === 'destination.setStatus') expect(destination.destinationId).toBe('d1');
    expect(parseActionBody({ action: 'source.setStatus', sourceId: 's1', status: 'paused' }).ok).toBe(false);
    expect(parseActionBody({ action: 'destination.setStatus', status: 'active' }).ok).toBe(false);
  });

  it('parses source/destination registrations incl. oauth metadata', () => {
    const value = parsed({
      action: 'source.register',
      provider: 'salesforce',
      providerAccountId: 'org-1',
      authKind: 'oauth',
      credentialRef: 'secret-store://tenant/sf',
      oauthScopes: [' read:records ', 'write:records', ''],
      oauthExpiresAt: '2026-12-01T00:00:00Z',
    });
    if (value.action === 'source.register') {
      expect(value.provider).toBe('salesforce');
      expect(value.oauthScopes).toEqual(['read:records', 'write:records']);
      expect(value.oauthExpiresAt).toBe('2026-12-01T00:00:00Z');
    }
    const credentials = parsed({
      action: 'destination.register',
      provider: 'webhook',
      providerAccountId: 'https://example.test/hook',
      authKind: 'credentials',
      credentialRef: 'secret-store://tenant/hook',
    });
    if (credentials.action === 'destination.register') {
      expect(credentials.oauthScopes).toEqual([]);
      expect(credentials.oauthExpiresAt).toBeNull();
    }

    expect(parseActionBody({ action: 'source.register', provider: 'whatsapp', providerAccountId: 'x', authKind: 'oauth', credentialRef: 'r' }).ok).toBe(false);
    expect(
      parseActionBody({ action: 'destination.register', provider: 'snowflake', providerAccountId: 'x', authKind: 'bad', credentialRef: 'r' }).ok,
    ).toBe(false);
    expect(
      parseActionBody({ action: 'source.register', provider: 'salesforce', providerAccountId: 'x', authKind: 'oauth', credentialRef: 'r', oauthScopes: 'read' }).ok,
    ).toBe(false);
    expect(
      parseActionBody({ action: 'source.register', provider: 'salesforce', providerAccountId: 'x', authKind: 'oauth', credentialRef: 'r', oauthExpiresAt: 'soon' }).ok,
    ).toBe(false);
  });

  it('parses poll/replay and bounds maxRecords', () => {
    const value = parsed({ action: 'source.poll', sourceId: 's1', maxRecords: 25 });
    if (value.action === 'source.poll') expect(value.maxRecords).toBe(25);
    const defaults = parsed({ action: 'source.poll', sourceId: 's1' });
    if (defaults.action === 'source.poll') expect(defaults.maxRecords).toBeNull();
    expect(parseActionBody({ action: 'source.poll', sourceId: 's1', maxRecords: 0 }).ok).toBe(false);
    expect(parseActionBody({ action: 'source.poll', sourceId: 's1', maxRecords: 2.5 }).ok).toBe(false);
    expect(parseActionBody({ action: 'source.replay' }).ok).toBe(false);
    expect(parseActionBody({ action: 'source.replay', sourceId: 's1' }).ok).toBe(true);
    expect(parseActionBody({ action: 'destination.retry', deliveryId: 'd1' }).ok).toBe(true);
    expect(parseActionBody({ action: 'destination.replay' }).ok).toBe(false);
  });

  it('parses the identity workflow bodies', () => {
    expect(parseActionBody({ action: 'identity.lookup', provider: 'slack', providerAccountId: 'U1' }).ok).toBe(true);
    expect(parseActionBody({ action: 'identity.lookup', provider: 'semaphore', providerAccountId: 'U1' }).ok).toBe(false);
    expect(parseActionBody({ action: 'identity.challenge', identityId: 'i1' }).ok).toBe(true);
    expect(parseActionBody({ action: 'identity.challenge' }).ok).toBe(false);
    expect(parseActionBody({ action: 'identity.complete', identityId: 'i1', code: ' 123456 ' }).ok).toBe(true);
    expect(parseActionBody({ action: 'identity.complete', identityId: 'i1' }).ok).toBe(false);
    expect(parseActionBody({ action: 'identity.attest', identityId: 'i1', evidence: 'checked HR record' }).ok).toBe(true);
    expect(parseActionBody({ action: 'identity.attest', identityId: 'i1', evidence: '   ' }).ok).toBe(false);
    expect(parseActionBody({ action: 'identity.link', identityId: 'i1', personId: 'p1' }).ok).toBe(true);
    expect(parseActionBody({ action: 'identity.link', identityId: 'i1' }).ok).toBe(false);
    expect(parseActionBody({ action: 'identity.detach', identityId: 'i1' }).ok).toBe(true);
    expect(parseActionBody({ action: 'identity.revoke', identityId: 'i1', reason: 'left company' }).ok).toBe(true);
    expect(parseActionBody({ action: 'identity.revoke', identityId: 'i1', reason: '' }).ok).toBe(false);
    expect(parseActionBody({ action: 'person.create', fullName: 'Maya Chen', email: null }).ok).toBe(true);
    expect(parseActionBody({ action: 'person.create', fullName: '' }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// API error mapping
// ---------------------------------------------------------------------------

describe('connections api error mapping', () => {
  class FakeError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }

  it('maps forbidden/authority failures to 403', () => {
    const result = connectionsApiError(new FakeError('forbidden', 'claim required'));
    expect(result.status).toBe(403);
    expect(result.body.error).toBe('forbidden');
  });

  it('maps not-found codes to 404 (uniform no-leak)', () => {
    for (const code of ['connection_not_found', 'source_not_found', 'delivery_not_found', 'identity_not_found']) {
      expect(connectionsApiError(new FakeError(code, 'x')).status).toBe(404);
    }
  });

  it('maps lifecycle conflicts to 409', () => {
    for (const code of ['delivery_not_retryable', 'identity_already_verified', 'challenge_expired', 'ingestion_busy']) {
      expect(connectionsApiError(new FakeError(code, 'x')).status).toBe(409);
    }
  });

  it('maps validation failures to 400 and unknown errors to 500', () => {
    expect(connectionsApiError(new FakeError('invalid_channel_input', 'x')).status).toBe(400);
    expect(connectionsApiError(new Error('boom')).status).toBe(500);
    expect(connectionsApiError(new Error('boom')).body.error).toBe('internal');
  });
});

// ---------------------------------------------------------------------------
// Catalog (provider vocabularies + display metadata)
// ---------------------------------------------------------------------------

describe('connector catalog', () => {
  it('covers every channel provider from the identity contract', () => {
    const catalog = channelCatalog();
    expect(catalog.map((entry) => entry.key)).toEqual([...CHANNEL_PROVIDERS]);
    for (const entry of catalog) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.accountIdHint.length).toBeGreaterThan(0);
    }
  });

  it('covers every source and destination provider', () => {
    expect(sourceCatalog()).toHaveLength(13);
    const all = destinationCatalog().flatMap((group) => group.entries);
    expect(all).toHaveLength(13);
    expect(new Set(all.map((entry) => entry.key)).size).toBe(13);
  });

  it('groups destinations into the six canonical categories', () => {
    const groups = destinationCatalog();
    expect(groups.map((group) => group.category)).toEqual([
      'bi',
      'warehouse',
      'crm-erp',
      'spreadsheet',
      'api',
      'webhook',
    ]);
    expect(destinationCategoryOf('looker')).toBe('bi');
    expect(destinationCategoryOf('snowflake')).toBe('warehouse');
    expect(destinationCategoryOf('netsuite')).toBe('crm-erp');
    expect(destinationCategoryOf('google-sheets')).toBe('spreadsheet');
    expect(destinationCategoryOf('http-api')).toBe('api');
    expect(destinationCategoryOf('webhook')).toBe('webhook');
  });

  it('looks entries up and falls back to the key for labels', () => {
    expect(catalogEntry('channel', 'whatsapp')?.label).toBe('WhatsApp');
    expect(catalogEntry('source', 'google-drive')?.label).toBe('Google Drive');
    expect(catalogEntry('destination', 'power-bi')?.label).toBe('Power BI');
    expect(catalogEntry('channel', 'semaphore')).toBeNull();
    expect(providerLabel('source', 'not-a-provider')).toBe('not-a-provider');
  });

  it('carries no credential fields anywhere (references only)', () => {
    const serialized = JSON.stringify({
      channels: channelCatalog(),
      sources: sourceCatalog(),
      destinations: destinationCatalog(),
    });
    expect(serialized).not.toContain('credentialValue');
    expect(serialized).not.toContain('"token"');
    expect(serialized).not.toContain('"password"');
    expect(serialized).not.toContain('"secret"');
  });
});
