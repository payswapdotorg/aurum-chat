// Unit tests for the api module's pure logic (no database): the v1 route
// table and matcher, the discovery manifest, the capability-scope and
// authority-claim vocabularies, the webhook pattern/backoff/signature
// logic, and the error → HTTP taxonomy. The kernel and the db-backed
// operations are covered by api-service.test.ts (embedded PostgreSQL).

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ApiError, httpStatusFor, mapDomainErrorCode, mapDomainError } from '../errors';
import { API_ROUTES, buildDiscoveryDocument, matchApiRoute, splitApiPath } from '../routes';
import { API_SCOPES, parseAuthorityGrant, parseScopeGrant, hasScope } from '../scopes';
import {
  backoffSecondsForAttempt,
  classifyWebhookReceipt,
  computeWebhookSignature,
  eventTypeMatches,
  isEventTypePattern,
  parseEventTypePatterns,
  validateWebhookUrl,
} from '../webhook';
import type { WebhookTransportReceipt } from '../types';

// ---------------------------------------------------------------------------
// routes: version prefix, matching, 405/404 discipline
// ---------------------------------------------------------------------------

describe('splitApiPath', () => {
  it('strips the versioned base path', () => {
    expect(splitApiPath('/api/v1')).toEqual([]);
    expect(splitApiPath('/api/v1/goals')).toEqual(['goals']);
    expect(splitApiPath('/api/v1/goals/abc-123/versions/2')).toEqual([
      'goals',
      'abc-123',
      'versions',
      '2',
    ]);
  });

  it('tolerates trailing slashes and a missing leading slash', () => {
    expect(splitApiPath('/api/v1/goals/')).toEqual(['goals']);
    expect(splitApiPath('api/v1/goals')).toEqual(['goals']);
  });

  it('rejects paths outside the v1 surface', () => {
    expect(splitApiPath('/api/v2/goals')).toBeNull();
    expect(splitApiPath('/api/goals')).toBeNull();
    expect(splitApiPath('/goals')).toBeNull();
    expect(splitApiPath('/api/v1x/goals')).toBeNull();
  });
});

describe('matchApiRoute', () => {
  it('matches static routes and captures params', () => {
    const list = matchApiRoute('GET', ['goals']);
    expect(list).toMatchObject({ kind: 'matched', spec: { operation: 'goals.list' } });
    const one = matchApiRoute('GET', ['goals', '11111111-1111-4111-8111-111111111111']);
    expect(one).toMatchObject({
      kind: 'matched',
      spec: { operation: 'goals.get' },
      params: { goalId: '11111111-1111-4111-8111-111111111111' },
    });
  });

  it('prefers static segments over captures', () => {
    // /webhooks/dispatch (static) wins over /webhooks/:subscriptionId.
    const dispatch = matchApiRoute('POST', ['webhooks', 'dispatch']);
    expect(dispatch).toMatchObject({
      kind: 'matched',
      spec: { operation: 'webhooks.dispatch' },
    });
    // /agents/executions/:id wins over /agents/:agentId.
    const execution = matchApiRoute('GET', [
      'agents',
      'executions',
      '22222222-2222-4222-8222-222222222222',
    ]);
    expect(execution).toMatchObject({
      kind: 'matched',
      spec: { operation: 'agents.execution' },
      params: { executionId: '22222222-2222-4222-8222-222222222222' },
    });
    // /capabilities/gaps wins over /capabilities/:capabilityId.
    expect(matchApiRoute('GET', ['capabilities', 'gaps'])).toMatchObject({
      kind: 'matched',
      spec: { operation: 'capabilities.gaps' },
    });
    // And a non-uuid third segment still reaches the capture route.
    expect(matchApiRoute('GET', ['capabilities', 'gaps', 'extra'])).toMatchObject({
      kind: 'not_found',
    });
  });

  it('reports method_not_allowed with the allowed methods for a known path', () => {
    const result = matchApiRoute('PUT', ['missions']);
    expect(result).toEqual({ kind: 'method_not_allowed', allowed: ['GET', 'POST'] });
    const delivery = matchApiRoute('PUT', ['webhooks', 'deliveries', 'abc', 'redeliver']);
    expect(delivery).toEqual({ kind: 'method_not_allowed', allowed: ['POST'] });
  });

  it('reports not_found for unknown paths', () => {
    expect(matchApiRoute('GET', ['nope'])).toEqual({ kind: 'not_found' });
    expect(matchApiRoute('GET', [])).toMatchObject({ kind: 'matched' }); // discovery
    expect(matchApiRoute('POST', [])).toEqual({ kind: 'method_not_allowed', allowed: ['GET'] });
  });

  it('wires a handler for every route and a route for every operation id', () => {
    // operations.ts owns the registry; importing it here would pull the
    // domain contracts into the "pure" test — instead assert the surface
    // itself: unique operations, unique (method, segments) rows, scoped
    // routes reference real scopes, and discovery mirrors the table.
    const operations = new Set(API_ROUTES.map((route) => route.operation));
    expect(operations.size).toBe(API_ROUTES.length);
    const rows = new Set(API_ROUTES.map((route) => `${route.method} ${route.segments.join('/')}`));
    expect(rows.size).toBe(API_ROUTES.length);
    for (const route of API_ROUTES) {
      if (route.scope !== null) expect(API_SCOPES).toContain(route.scope);
    }
    const discovery = buildDiscoveryDocument();
    expect(discovery.operations).toHaveLength(API_ROUTES.length);
    expect(discovery.operations.map((operation) => operation.operation).sort()).toEqual(
      [...operations].sort(),
    );
  });
});

describe('buildDiscoveryDocument', () => {
  it('describes the versioned surface without tenant data', () => {
    const document = buildDiscoveryDocument();
    expect(document.version).toBe('v1');
    expect(document.path).toBe('/api/v1');
    expect(document.scopes).toContain('goals:read');
    expect(document.authorityClaims).toContain('actions:approve');
    expect(document.webhooks.signature).toContain('HMAC-SHA256');
    const unauthenticated = document.operations.filter((operation) => operation.scope === null);
    expect(unauthenticated.map((operation) => operation.operation)).toEqual(['discovery']);
  });
});

// ---------------------------------------------------------------------------
// scopes and authority grants
// ---------------------------------------------------------------------------

describe('parseScopeGrant', () => {
  it('accepts known scopes', () => {
    expect(parseScopeGrant(['goals:read', 'missions:write'])).toEqual([
      'goals:read',
      'missions:write',
    ]);
  });

  it('rejects empty, non-array, duplicate and unknown grants', () => {
    expect(() => parseScopeGrant([])).toThrow(ApiError);
    expect(() => parseScopeGrant('goals:read')).toThrow(ApiError);
    expect(() => parseScopeGrant(['goals:read', 'goals:read'])).toThrow(ApiError);
    expect(() => parseScopeGrant(['goals:write'])).toThrow(/unknown api scope/);
    expect(() => parseScopeGrant(['organizations:provision'])).toThrow(/unknown api scope/);
  });
});

describe('parseAuthorityGrant', () => {
  it('defaults to an empty claim set and accepts known claims', () => {
    expect(parseAuthorityGrant(undefined)).toEqual([]);
    expect(parseAuthorityGrant(null)).toEqual([]);
    expect(parseAuthorityGrant(['actions:approve'])).toEqual(['actions:approve']);
  });

  it('rejects unknown or duplicate claims (platform claims never ride keys)', () => {
    expect(() => parseAuthorityGrant(['organizations:provision'])).toThrow(
      /not grantable to an api key/,
    );
    expect(() => parseAuthorityGrant(['actions:approve', 'actions:approve'])).toThrow(ApiError);
    expect(() => parseAuthorityGrant(['totally-made-up'])).toThrow(/not grantable/);
  });
});

describe('hasScope', () => {
  it('matches granted scopes exactly', () => {
    expect(hasScope(['goals:read'], 'goals:read')).toBe(true);
    expect(hasScope(['goals:read'], 'goals:write')).toBe(false);
    expect(hasScope([], 'goals:read')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// webhook logic: patterns, backoff, signature, receipts, urls
// ---------------------------------------------------------------------------

describe('event type patterns', () => {
  it('validates pattern shapes', () => {
    expect(isEventTypePattern('*')).toBe(true);
    expect(isEventTypePattern('api.operation')).toBe(true);
    expect(isEventTypePattern('goal.revised')).toBe(true);
    expect(isEventTypePattern('goal.*')).toBe(true);
    expect(isEventTypePattern('goal.**')).toBe(false);
    expect(isEventTypePattern('*goal')).toBe(false);
    expect(isEventTypePattern('go*al')).toBe(false);
    expect(isEventTypePattern('')).toBe(false);
    expect(isEventTypePattern('has space')).toBe(false);
    expect(isEventTypePattern(42)).toBe(false);
  });

  it('matches exact ids, prefix wildcards and the star', () => {
    expect(eventTypeMatches('api.operation', 'api.operation')).toBe(true);
    expect(eventTypeMatches('api.operation', 'api.operations')).toBe(false);
    expect(eventTypeMatches('goal.*', 'goal.revised')).toBe(true);
    expect(eventTypeMatches('goal.*', 'goal.created')).toBe(true);
    expect(eventTypeMatches('goal.*', 'goal')).toBe(false); // prefix needs the dot
    expect(eventTypeMatches('goal.*', 'goalsheet.created')).toBe(false);
    expect(eventTypeMatches('*', 'anything.at-all')).toBe(true);
    expect(eventTypeMatches('goal.*', 'api.operation')).toBe(false);
  });

  it('validates subscription pattern lists', () => {
    expect(parseEventTypePatterns(['api.operation', 'goal.*'])).toEqual([
      'api.operation',
      'goal.*',
    ]);
    expect(() => parseEventTypePatterns([])).toThrow(ApiError);
    expect(() => parseEventTypePatterns('api.operation')).toThrow(ApiError);
    expect(() => parseEventTypePatterns(['api.operation', 'api.operation'])).toThrow(/duplicate/);
    expect(() => parseEventTypePatterns(['bad pattern'])).toThrow(/invalid event type pattern/);
    expect(
      () => parseEventTypePatterns(Array.from({ length: 21 }, () => '*')),
    ).toThrow(ApiError);
  });
});

describe('backoffSecondsForAttempt', () => {
  it('doubles from the base and caps', () => {
    expect(backoffSecondsForAttempt(1)).toBe(30);
    expect(backoffSecondsForAttempt(2)).toBe(60);
    expect(backoffSecondsForAttempt(3)).toBe(120);
    expect(backoffSecondsForAttempt(4)).toBe(240);
    expect(backoffSecondsForAttempt(5)).toBe(480);
    expect(backoffSecondsForAttempt(6)).toBe(960);
    expect(backoffSecondsForAttempt(7)).toBe(1920);
    expect(backoffSecondsForAttempt(8)).toBe(3600); // 3840 capped
    expect(backoffSecondsForAttempt(50)).toBe(3600);
  });
});

describe('computeWebhookSignature', () => {
  it('is the documented HMAC-SHA256 over `${timestamp}.${body}`', () => {
    const secret = 'whsec_integration_signing_secret';
    const timestamp = '2026-09-14T12:00:00.000Z';
    const body = '{"id":"d1","version":1,"eventType":"api.operation"}';
    const expected = createHmac('sha256', secret)
      .update(`${timestamp}.${body}`)
      .digest('hex');
    expect(computeWebhookSignature(secret, timestamp, body)).toBe(expected);
    // byte-sensitivity: changing the body changes the signature
    expect(computeWebhookSignature(secret, timestamp, `${body} `)).not.toBe(expected);
  });
});

describe('classifyWebhookReceipt', () => {
  const receipt = (overrides: Partial<WebhookTransportReceipt>): WebhookTransportReceipt => ({
    ok: false,
    statusCode: null,
    latencyMs: 12,
    ...overrides,
  });

  it('succeeds only on 2xx', () => {
    expect(classifyWebhookReceipt(receipt({ ok: true, statusCode: 200 }))).toBe('succeeded');
    expect(classifyWebhookReceipt(receipt({ ok: true, statusCode: 204 }))).toBe('succeeded');
  });

  it('treats no-response, 408, 429 and 5xx as transient', () => {
    expect(classifyWebhookReceipt(receipt({ statusCode: null }))).toBe('transient_failure');
    expect(classifyWebhookReceipt(receipt({ statusCode: 408 }))).toBe('transient_failure');
    expect(classifyWebhookReceipt(receipt({ statusCode: 429 }))).toBe('transient_failure');
    expect(classifyWebhookReceipt(receipt({ statusCode: 500 }))).toBe('transient_failure');
    expect(classifyWebhookReceipt(receipt({ statusCode: 503 }))).toBe('transient_failure');
  });

  it('treats other 4xx as terminal', () => {
    expect(classifyWebhookReceipt(receipt({ statusCode: 400 }))).toBe('terminal_failure');
    expect(classifyWebhookReceipt(receipt({ statusCode: 403 }))).toBe('terminal_failure');
    expect(classifyWebhookReceipt(receipt({ statusCode: 404 }))).toBe('terminal_failure');
    expect(classifyWebhookReceipt(receipt({ statusCode: 410 }))).toBe('terminal_failure');
  });
});

describe('validateWebhookUrl', () => {
  it('accepts https and loopback http', () => {
    expect(validateWebhookUrl('https://hooks.example.com/aurum')).toBe(
      'https://hooks.example.com/aurum',
    );
    expect(validateWebhookUrl('http://localhost:9999/hook')).toBe('http://localhost:9999/hook');
    expect(validateWebhookUrl('http://127.0.0.1:3000/hook')).toBe('http://127.0.0.1:3000/hook');
  });

  it('rejects plain http off loopback, other schemes, credentials and junk', () => {
    expect(() => validateWebhookUrl('http://hooks.example.com/aurum')).toThrow(/loopback/);
    expect(() => validateWebhookUrl('ftp://hooks.example.com')).toThrow(/https/);
    expect(() => validateWebhookUrl('https://user:pass@hooks.example.com')).toThrow(/credentials/);
    expect(() => validateWebhookUrl('not a url')).toThrow(/valid absolute URL/);
    expect(() => validateWebhookUrl('')).toThrow(ApiError);
  });
});

// ---------------------------------------------------------------------------
// error → HTTP taxonomy
// ---------------------------------------------------------------------------

describe('error taxonomy', () => {
  it('carries a status per api error code', () => {
    expect(httpStatusFor('unauthenticated')).toBe(401);
    expect(httpStatusFor('missing_scope')).toBe(403);
    expect(httpStatusFor('route_not_found')).toBe(404);
    expect(httpStatusFor('method_not_allowed')).toBe(405);
    expect(httpStatusFor('webhook_conflict')).toBe(409);
    expect(httpStatusFor('provider_unavailable')).toBe(503);
    expect(httpStatusFor('audit_unavailable')).toBe(500);
    expect(new ApiError('invalid_input', 'x').status).toBe(400);
  });

  it('maps domain contract codes onto the public taxonomy', () => {
    expect(mapDomainErrorCode('goal_not_found')).toBe(404);
    expect(mapDomainErrorCode('mission_version_not_found')).toBe(404);
    expect(mapDomainErrorCode('invalid_input')).toBe(400);
    expect(mapDomainErrorCode('invalid_event_query')).toBe(400);
    expect(mapDomainErrorCode('goal_conflict')).toBe(409);
    expect(mapDomainErrorCode('permission_not_granted')).toBe(403);
    expect(mapDomainErrorCode('agent_disabled')).toBeNull(); // not domain-shaped for HTTP
    expect(mapDomainErrorCode('provider_unavailable')).toBe(503);
  });

  it('interprets thrown values without leaking internals', () => {
    const apiError = mapDomainError(new ApiError('missing_scope', 'nope'));
    expect(apiError).toMatchObject({ status: 403, code: 'missing_scope' });

    const domainError = mapDomainError(
      Object.assign(new Error('goal x does not exist in this tenant'), { code: 'goal_not_found' }),
    );
    expect(domainError).toMatchObject({ status: 404, code: 'goal_not_found' });

    // Codes that are not HTTP-shaped, and values without codes, fall back
    // to the sanitized internal error.
    expect(mapDomainError(Object.assign(new Error('x'), { code: 'weird code!' }))).toBeNull();
    expect(mapDomainError(new Error('plain'))).toBeNull();
    expect(mapDomainError('string error')).toBeNull();
  });
});
