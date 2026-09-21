// Unit tests for the Developer / API / MCP Console product surface's PURE
// logic (W067): the label/tone/format vocabularies, the client-safe
// vocabulary copies (locked to the api contract), the API body parsers,
// the rotation-label helper, the error mapping, the query-parameter
// parsing, the view builders' pure halves (scope families, MCP connection
// guide, tool rows, the activity merge) and the command-registry
// destination. No database — the integration suite covers the contract
// compositions.

import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_NOTE,
  DEV_API_SCOPES,
  DEV_AUTHORITY_CLAIMS,
  EVENT_TYPE_EXAMPLES,
  KEY_MANAGEMENT_CLAIM_NOTE,
  KEY_SHOWN_ONCE_NOTE,
  ROTATION_NOTE,
  SECRET_REF_NOTE,
  ageLabel,
  activityFamilyLabel,
  attemptOutcomeLabel,
  attemptOutcomeTone,
  authorityClaimExplanation,
  authorityClaimLabel,
  deliveryStatusLabel,
  deliveryStatusTone,
  keyStatusLabel,
  keyStatusTone,
  maskKey,
  mcpPolicyLabel,
  mcpPolicyTone,
  scopeExplanation,
  scopeLabel,
  shortId,
  subscriptionStatusLabel,
  subscriptionStatusTone,
} from '../lib/labels';
import {
  DEVELOPER_ACTIONS,
  isDeveloperAction,
  parseActionBody,
  rotatedLabel,
  summarizeActionResult,
} from '../lib/actions';
import type { ParsedActionInput } from '../lib/actions';
import { developerApiError, deliveryIdFromRequest } from '../lib/api';
import {
  activityRowOf,
  buildMcpConnectionGuide,
  buildMcpToolRows,
  buildScopeFamilies,
  mergeActivityRows,
} from '../lib/views';
import type { Event } from '@/modules/events/contract';
import type { ApiKey } from '@/modules/api/contract';
import {
  API_KEY_AUTHORITY_CLAIMS,
  API_SCOPES,
  buildDiscoveryDocument,
} from '@/modules/api/contract';
import { MCP_AUDIT_EVENT_TYPE } from '@/mcp/audit';
import { MCP_AUTHORITY_ENV, MCP_PRINCIPAL_ID_ENV, MCP_TENANT_ID_ENV } from '@/mcp/config';
import { AURUM_MCP_TOOLS } from '@/mcp/registry';
import { DEVELOPER_DESTINATIONS, buildShellCommands } from '../../lib/command-registry';

// ---------------------------------------------------------------------------
// The vocabularies (totals: every domain value has human copy)
// ---------------------------------------------------------------------------

describe('scope and claim labels', () => {
  it('labels every api scope and explains it', () => {
    for (const scope of API_SCOPES) {
      expect(scopeLabel(scope).length).toBeGreaterThan(0);
      expect(scopeExplanation(scope).length).toBeGreaterThan(0);
    }
    expect(scopeLabel('goals:read')).toBe('Goals · read');
    expect(scopeLabel('api:administer')).toBe('API · administer');
  });

  it('labels every grantable authority claim and explains it', () => {
    for (const claim of API_KEY_AUTHORITY_CLAIMS) {
      expect(authorityClaimLabel(claim)).toBe(claim);
      expect(authorityClaimExplanation(claim).length).toBeGreaterThan(0);
    }
  });

  it('the client-safe vocabulary copies are locked to the api contract (no drift)', () => {
    expect([...DEV_API_SCOPES]).toEqual([...API_SCOPES]);
    expect([...DEV_AUTHORITY_CLAIMS]).toEqual([...API_KEY_AUTHORITY_CLAIMS]);
  });

  it('labels and tones for every key/subscription/delivery/attempt status', () => {
    expect(keyStatusLabel('active')).toBe('Active');
    expect(keyStatusLabel('revoked')).toBe('Revoked');
    expect(keyStatusTone('active')).toBe('positive');
    expect(keyStatusTone('revoked')).toBe('neutral');
    expect(subscriptionStatusLabel('active')).toBe('Receiving');
    expect(subscriptionStatusLabel('deactivated')).toBe('Deactivated');
    expect(subscriptionStatusTone('active')).toBe('positive');
    expect(deliveryStatusLabel('pending')).toBe('Pending');
    expect(deliveryStatusLabel('delivered')).toBe('Delivered');
    expect(deliveryStatusLabel('failed')).toBe('Failed');
    expect(deliveryStatusTone('failed')).toBe('error');
    expect(deliveryStatusTone('pending')).toBe('warning');
    expect(attemptOutcomeLabel('terminal_failure')).toBe('rejected (terminal)');
    expect(attemptOutcomeLabel('transient_failure')).toBe('retrying (transient)');
    expect(attemptOutcomeTone('succeeded')).toBe('positive');
  });

  it('labels MCP policy classes and activity families', () => {
    expect(mcpPolicyLabel('read')).toBe('Read · policy-matrix');
    expect(mcpPolicyLabel('gate')).toBe('Gated · approval flow');
    expect(mcpPolicyLabel('claim')).toBe('Claim-gated');
    expect(mcpPolicyTone('read')).toBe('info');
    expect(activityFamilyLabel('api.operation')).toBe('API');
    expect(activityFamilyLabel('mcp.tool_invoked')).toBe('MCP');
  });
});

describe('formats', () => {
  it('masks a raw key to prefix + tail (never usable)', () => {
    expect(maskKey('aurum_abcdefghijklmnop')).toBe('aurum_…mnop');
    expect(maskKey('short')).toBe('short');
    expect(maskKey('aurum_abcdefghijklmno')).not.toContain('bcdefghijk');
  });

  it('ages timestamps compactly', () => {
    const now = '2026-09-18T12:00:00.000Z';
    expect(ageLabel('2026-09-18T11:59:35.000Z', now)).toBe('25s ago');
    expect(ageLabel('2026-09-18T11:30:00.000Z', now)).toBe('30m ago');
    expect(ageLabel('2026-09-18T09:00:00.000Z', now)).toBe('3h ago');
    expect(ageLabel('2026-09-15T12:00:00.000Z', now)).toBe('3d ago');
  });

  it('shortens ids for evidence rows', () => {
    expect(shortId('12345678-90ab-cdef-1234-567890abcdef')).toBe('12345678');
    expect(shortId('short')).toBe('short');
  });
});

describe('the honesty notes are the product (non-empty, on-topic)', () => {
  it('carries the shown-once, claim-gate, secret-ref and rotation notes', () => {
    expect(KEY_SHOWN_ONCE_NOTE).toContain('exactly once');
    expect(KEY_MANAGEMENT_CLAIM_NOTE).toContain('api:administer');
    expect(SECRET_REF_NOTE).toContain('opaque secret-store reference');
    expect(ROTATION_NOTE).toContain('same grant');
    expect(ACTIVITY_NOTE).toContain('immutable');
    expect(EVENT_TYPE_EXAMPLES.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

function parseOk(body: unknown): ParsedActionInput {
  const result = parseActionBody(body);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.value;
}

describe('parseActionBody', () => {
  it('rejects non-objects and unknown actions with the supported list', () => {
    expect(parseActionBody(null).ok).toBe(false);
    expect(parseActionBody('x').ok).toBe(false);
    const result = parseActionBody({ action: 'nope' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(DEVELOPER_ACTIONS.join(', '));
  });

  it('recognizes every action in the vocabulary', () => {
    for (const action of DEVELOPER_ACTIONS) {
      expect(isDeveloperAction(action)).toBe(true);
    }
    expect(isDeveloperAction('nope')).toBe(false);
  });

  it('parses key.create (full grant)', () => {
    const value = parseOk({
      action: 'key.create',
      label: '  CI pipeline  ',
      scopes: ['goals:read', 'missions:read'],
      authority: ['actions:approve'],
      principalId: '11111111-1111-1111-1111-111111111111',
    });
    expect(value).toEqual({
      action: 'key.create',
      label: 'CI pipeline',
      scopes: ['goals:read', 'missions:read'],
      authority: ['actions:approve'],
      principalId: '11111111-1111-1111-1111-111111111111',
    });
  });

  it('key.create: label and scopes shape problems are 400s; authority is optional', () => {
    expect(parseActionBody({ action: 'key.create' }).ok).toBe(false);
    expect(parseActionBody({ action: 'key.create', label: 'x' }).ok).toBe(false);
    expect(parseActionBody({ action: 'key.create', label: 'x', scopes: [] }).ok).toBe(false);
    expect(parseActionBody({ action: 'key.create', label: 'x', scopes: 'goals:read' }).ok).toBe(false);
    expect(
      parseActionBody({ action: 'key.create', label: 'x', scopes: ['goals:read'], authority: 'nope' })
        .ok,
    ).toBe(false);
    // missing authority defaults to the empty grant (the contract's semantics)
    expect(
      parseOk({ action: 'key.create', label: 'x', scopes: ['goals:read'] }),
    ).toEqual({
      action: 'key.create',
      label: 'x',
      scopes: ['goals:read'],
      authority: [],
      principalId: null,
    });
    expect(
      parseOk({ action: 'key.create', label: 'x', scopes: ['goals:read'], authority: null }),
    ).toMatchObject({ authority: [] });
  });

  it('key.revoke / key.rotate require a keyId', () => {
    expect(parseOk({ action: 'key.revoke', keyId: 'k' })).toEqual({
      action: 'key.revoke',
      keyId: 'k',
    });
    expect(parseOk({ action: 'key.rotate', keyId: 'k' })).toEqual({
      action: 'key.rotate',
      keyId: 'k',
    });
    expect(parseActionBody({ action: 'key.revoke' }).ok).toBe(false);
    expect(parseActionBody({ action: 'key.rotate', keyId: '  ' }).ok).toBe(false);
  });

  it('parses webhook.create (full input)', () => {
    const value = parseOk({
      action: 'webhook.create',
      label: 'Order pipeline',
      url: 'https://example.test/hooks/aurum',
      eventTypes: ['goal.*', 'api.operation'],
      secretRef: 'secret-store://wh/main',
      maxAttempts: 7,
    });
    expect(value).toEqual({
      action: 'webhook.create',
      label: 'Order pipeline',
      url: 'https://example.test/hooks/aurum',
      eventTypes: ['goal.*', 'api.operation'],
      secretRef: 'secret-store://wh/main',
      maxAttempts: 7,
    });
  });

  it('webhook.create accepts comma- and newline-separated event types', () => {
    const comma = parseOk({
      action: 'webhook.create',
      label: 'x',
      url: 'https://a.test/h',
      eventTypes: 'goal.*, api.operation , * ',
    });
    expect(comma).toMatchObject({ eventTypes: ['goal.*', 'api.operation', '*'] });
    const newline = parseOk({
      action: 'webhook.create',
      label: 'x',
      url: 'https://a.test/h',
      eventTypes: 'goal.*\napi.operation',
    });
    expect(newline).toMatchObject({ eventTypes: ['goal.*', 'api.operation'] });
  });

  it('webhook.create shape problems are 400s', () => {
    expect(parseActionBody({ action: 'webhook.create' }).ok).toBe(false);
    expect(parseActionBody({ action: 'webhook.create', label: 'x' }).ok).toBe(false);
    expect(
      parseActionBody({ action: 'webhook.create', label: 'x', url: 'https://a.test' }).ok,
    ).toBe(false);
    expect(
      parseActionBody({
        action: 'webhook.create',
        label: 'x',
        url: 'https://a.test',
        eventTypes: [],
      }).ok,
    ).toBe(false);
    expect(
      parseActionBody({
        action: 'webhook.create',
        label: 'x',
        url: 'https://a.test',
        eventTypes: ['goal.*'],
        maxAttempts: 0,
      }).ok,
    ).toBe(false);
    expect(
      parseActionBody({
        action: 'webhook.create',
        label: 'x',
        url: 'https://a.test',
        eventTypes: ['goal.*'],
        maxAttempts: 11,
      }).ok,
    ).toBe(false);
    expect(
      parseActionBody({
        action: 'webhook.create',
        label: 'x',
        url: 'https://a.test',
        eventTypes: ['goal.*'],
        maxAttempts: 1.5,
      }).ok,
    ).toBe(false);
  });

  it('webhook.deactivate/test/redeliver require their ids; dispatch takes none', () => {
    expect(parseOk({ action: 'webhook.deactivate', subscriptionId: 's' })).toMatchObject({
      action: 'webhook.deactivate',
      subscriptionId: 's',
    });
    expect(parseOk({ action: 'webhook.test', subscriptionId: 's' })).toMatchObject({
      action: 'webhook.test',
      subscriptionId: 's',
    });
    expect(parseOk({ action: 'webhook.redeliver', deliveryId: 'd' })).toMatchObject({
      action: 'webhook.redeliver',
      deliveryId: 'd',
    });
    expect(parseActionBody({ action: 'webhook.test' }).ok).toBe(false);
    expect(parseActionBody({ action: 'webhook.redeliver' }).ok).toBe(false);
    expect(parseOk({ action: 'webhook.dispatch' })).toEqual({ action: 'webhook.dispatch' });
  });
});

// ---------------------------------------------------------------------------
// Rotation labeling + result summaries
// ---------------------------------------------------------------------------

describe('rotatedLabel', () => {
  it('appends the rotation stamp', () => {
    expect(rotatedLabel('CI pipeline', '2026-09-18T10:00:00.000Z')).toBe(
      'CI pipeline (rotated 2026-09-18)',
    );
  });

  it('keeps the label inside the contract budget (120 chars)', () => {
    const long = 'x'.repeat(200);
    const stamped = rotatedLabel(long, '2026-09-18T10:00:00.000Z');
    expect(stamped.length).toBeLessThanOrEqual(120);
    expect(stamped.endsWith(' (rotated 2026-09-18)')).toBe(true);
  });
});

describe('summarizeActionResult', () => {
  const base: ApiKey = {
    id: 'id',
    tenantId: 't',
    principalId: 'p',
    label: 'CI pipeline',
    scopes: ['goals:read'],
    authority: [],
    status: 'active' as const,
    createdAt: '2026-09-18T00:00:00.000Z',
    createdBy: 'p',
    lastUsedAt: null,
    revokedAt: null,
    revokedBy: null,
  };

  it('summarizes issuance with the shown-once instruction', () => {
    expect(
      summarizeActionResult({ kind: 'key', action: 'key.create', apiKey: base, key: 'aurum_x' }),
    ).toContain('shown once');
  });

  it('summarizes rotation, revocation and the honest unwired dispatch', () => {
    expect(
      summarizeActionResult({ kind: 'key', action: 'key.rotate', apiKey: base, key: 'aurum_x' }),
    ).toContain('old key revoked');
    expect(summarizeActionResult({ kind: 'key', action: 'key.revoke', apiKey: base })).toContain(
      'revoked',
    );
    expect(
      summarizeActionResult({
        kind: 'webhook',
        action: 'webhook.dispatch',
        dispatched: [],
        transportWired: false,
      }),
    ).toContain('No webhook transport is wired');
  });
});

// ---------------------------------------------------------------------------
// Error mapping + query parsing
// ---------------------------------------------------------------------------

describe('developerApiError', () => {
  function coded(code: string, message = 'm'): { code: string; message: string } {
    return { code, message };
  }

  it('maps the authority gates to 403', () => {
    expect(developerApiError(coded('missing_scope')).status).toBe(403);
    expect(developerApiError(coded('forbidden')).status).toBe(403);
  });

  it('maps provider_unavailable to 503 and conflicts to 409', () => {
    expect(developerApiError(coded('provider_unavailable')).status).toBe(503);
    expect(developerApiError(coded('webhook_conflict')).status).toBe(409);
  });

  it('maps uniform not-founds to 404 and shape problems to 400', () => {
    expect(developerApiError(coded('api_key_not_found')).status).toBe(404);
    expect(developerApiError(coded('webhook_delivery_not_found')).status).toBe(404);
    expect(developerApiError(coded('invalid_input')).status).toBe(400);
  });

  it('collapses unknown failures to 500', () => {
    expect(developerApiError(new Error('boom')).status).toBe(500);
  });
});

describe('deliveryIdFromRequest', () => {
  const uuid = '12345678-90ab-cdef-1234-567890abcdef';

  function requestFor(query: string): Request {
    return new Request(`https://aurum.test/developer${query}`);
  }

  it('absent → null, valid → the uuid, malformed → invalid', () => {
    expect(deliveryIdFromRequest(requestFor(''))).toBeNull();
    expect(deliveryIdFromRequest(requestFor('?delivery='))).toBeNull();
    expect(deliveryIdFromRequest(requestFor(`?delivery=${uuid}`))).toBe(uuid);
    expect(deliveryIdFromRequest(requestFor('?delivery=not-a-uuid'))).toBe('invalid');
  });
});

// ---------------------------------------------------------------------------
// Pure view builders
// ---------------------------------------------------------------------------

describe('buildScopeFamilies (scope visibility)', () => {
  const document = buildDiscoveryDocument();
  const families = buildScopeFamilies(document.operations);

  it('covers every v1 operation exactly once', () => {
    const flat = families.flatMap((family) => family.operations.map((op) => op.operation));
    expect(flat.length).toBe(document.operations.length);
    expect(new Set(flat).size).toBe(flat.length);
  });

  it('renders the unauthenticated family first, then contract-vocabulary order', () => {
    expect(families[0]!.scope).toBe('(unauthenticated)');
    const scoped = families.slice(1).map((family) => family.scope);
    const expected = API_SCOPES.filter((scope) =>
      document.operations.some((op) => op.scope === scope),
    );
    expect(scoped).toEqual([...expected]);
  });

  it('keys management and webhook management are real scopes with routes', () => {
    const byScope = new Map(families.map((family) => [family.scope, family]));
    expect(byScope.get('api:administer')!.operations.map((op) => op.operation)).toEqual(
      expect.arrayContaining(['apiKeys.create', 'apiKeys.list', 'apiKeys.revoke']),
    );
    expect(byScope.get('webhooks:manage')!.operations.length).toBeGreaterThan(4);
  });
});

describe('MCP connection composition', () => {
  it('the guide quotes the W039 config env names verbatim (no drift)', () => {
    const guide = buildMcpConnectionGuide();
    expect(guide.envNames.tenantId).toBe(MCP_TENANT_ID_ENV);
    expect(guide.envNames.principalId).toBe(MCP_PRINCIPAL_ID_ENV);
    expect(guide.envNames.authority).toBe(MCP_AUTHORITY_ENV);
    expect(guide.launchCommand).toBe('bun run mcp');
    expect(guide.transport).toBe('stdio');
  });

  it('the tool catalog mirrors the live registry (order = tools/list)', () => {
    const rows = buildMcpToolRows();
    expect(rows.length).toBe(AURUM_MCP_TOOLS.length);
    for (const row of rows) {
      expect(['read', 'gate', 'claim']).toContain(row.policyKind);
      expect(row.title.length).toBeGreaterThan(0);
      expect(row.description.length).toBeGreaterThan(0);
    }
    expect(rows.map((row) => row.name)).toEqual(AURUM_MCP_TOOLS.map((tool) => tool.name));
  });
});

// ---------------------------------------------------------------------------
// The activity feed (audit-event → row mapping + merge)
// ---------------------------------------------------------------------------

function apiEvent(overrides: Partial<Event> & { id: string }): Event {
  const base: Event = {
    id: overrides.id,
    tenantId: 't',
    envelopeVersion: 1,
    type: 'api.operation',
    typeVersion: 1,
    payload: {
      operation: 'goals.list',
      method: 'GET',
      path: '/api/v1/goals',
      status: 200,
      keyId: 'key-1',
      requestId: 'req-1',
    },
    occurredAt: '2026-09-18T10:00:00.000Z',
    recordedAt: '2026-09-18T10:00:00.000Z',
    sequence: 1,
    actor: { kind: 'person', id: 'p' },
    source: { kind: 'api', label: 'public-api/v1' },
    correlationId: 'corr-1',
    causationId: null,
    idempotencyKey: null,
  };
  return { ...base, ...overrides };
}

describe('activity rows', () => {
  it('maps an api.operation event onto its console row', () => {
    const row = activityRowOf(apiEvent({ id: 'a1' }));
    expect(row).toMatchObject({
      id: 'a1',
      type: 'api.operation',
      operation: 'goals.list',
      detail: 'GET /api/v1/goals → 200',
      keyId: 'key-1',
      correlationId: 'corr-1',
    });
  });

  it('maps an mcp.tool_invoked event onto its console row', () => {
    const event = apiEvent({
      id: 'm1',
      type: MCP_AUDIT_EVENT_TYPE,
      payload: { tool: 'list_goals', outcome: 'executed', error: null, args: {} },
      sequence: 2,
    });
    const row = activityRowOf(event);
    expect(row).toMatchObject({
      id: 'm1',
      type: MCP_AUDIT_EVENT_TYPE,
      operation: 'list_goals',
      detail: 'executed',
      keyId: null,
    });
  });

  it('an MCP failure carries its error code into the detail line', () => {
    const event = apiEvent({
      id: 'm2',
      type: MCP_AUDIT_EVENT_TYPE,
      payload: { tool: 'propose_action', outcome: 'error', error: { code: 'not_found', message: 'x' } },
    });
    expect(activityRowOf(event).detail).toBe('error · not_found');
  });

  it('merges the two feeds newest-first, sequence-broken, limited', () => {
    const older = apiEvent({ id: 'old', occurredAt: '2026-09-18T09:00:00.000Z', sequence: 1 });
    const newerApi = apiEvent({
      id: 'new-api',
      occurredAt: '2026-09-18T11:00:00.000Z',
      sequence: 5,
      payload: {},
    });
    const newerMcp = apiEvent({
      id: 'new-mcp',
      occurredAt: '2026-09-18T11:00:00.000Z',
      sequence: 6,
      type: MCP_AUDIT_EVENT_TYPE,
      payload: { tool: 't' },
    });
    const merged = mergeActivityRows([older, newerApi], [newerMcp], 10);
    expect(merged.map((row) => row.id)).toEqual(['new-mcp', 'new-api', 'old']);
    expect(mergeActivityRows([older, newerApi], [newerMcp], 2)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Command-search discoverability (Journey L is keyboard-reachable)
// ---------------------------------------------------------------------------

describe('the developer console in the shell command registry', () => {
  const commands = buildShellCommands();

  it('registers the destination exactly once with the developer icon', () => {
    const developerCommands = commands.filter((command) => command.id.startsWith('developer:'));
    expect(developerCommands).toHaveLength(1);
    expect(developerCommands[0]!.icon).toBe('developer');
    expect(developerCommands[0]!.target).toEqual({ kind: 'navigate', href: '/developer' });
    expect(DEVELOPER_DESTINATIONS).toHaveLength(1);
  });

  it('is findable by its obvious keywords', () => {
    const ids = commands
      .filter((command) => command.title.toLowerCase().includes('developer'))
      .map((command) => command.id);
    expect(ids).toContain('developer:console');
  });

  it('keeps every command id unique after the registration', () => {
    const ids = new Set(commands.map((command) => command.id));
    expect(ids.size).toBe(commands.length);
  });
});
